import { ApiError, type Env, type Identity } from './types.js';

/**
 * Constant-time string comparison. Compares the encoded bytes with a fixed
 * accumulator so the time taken does not depend on where the first difference
 * is. Length is folded into the result rather than short-circuiting on it.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/* ------------------------------------------------------- Access JWT verify */

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

const KEY_TTL_MS = 60 * 60 * 1000;
let keyCache: CachedKeys | null = null;

function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  const text = new TextDecoder().decode(base64UrlToBytes(segment));
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(401, 'unauthorized', 'authentication failed');
  }
  return parsed as Record<string, unknown>;
}

async function getAccessKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (keyCache && now - keyCache.fetchedAt < KEY_TTL_MS) return keyCache.keys;

  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!res.ok) {
    // Serve stale keys rather than locking everyone out on a transient blip.
    if (keyCache) return keyCache.keys;
    throw new ApiError(503, 'access_keys_unavailable',
      'could not fetch Cloudflare Access signing keys');
  }

  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'RSA') continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  if (keys.size === 0) {
    if (keyCache) return keyCache.keys;
    throw new ApiError(503, 'access_keys_unavailable', 'no usable Access signing keys');
  }

  keyCache = { keys, fetchedAt: now };
  return keys;
}

/**
 * Verify a Cloudflare Access JWT: RS256 signature against the team's published
 * keys, then issuer, audience and expiry.
 *
 * The signature check is the point. Trusting the plaintext
 * Cf-Access-Authenticated-User-Email header instead would be forgeable by
 * anyone who can reach the Worker on a hostname that Access does not front.
 */
export async function verifyAccessJwt(token: string, env: Env): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(headerB64);
    payload = decodeJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256') return null; // never accept "none" or an HMAC alg
  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (!kid) return null;

  const keys = await getAccessKeys(env.ACCESS_TEAM_DOMAIN);
  const key = keys.get(kid);
  if (!key) return null;

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!verified) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  const iat = typeof payload.iat === 'number' ? payload.iat : 0;
  if (exp <= nowSec) return null;
  if (iat > nowSec + 60) return null; // small skew allowance

  const expectedIss = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (payload.iss !== expectedIss) return null;

  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.some((a) => typeof a === 'string' && timingSafeEqual(a, env.ACCESS_AUD))) {
    return null;
  }

  // Human logins carry "email". Service tokens carry "common_name" instead,
  // which names the specific token - so the audit trail says which CoreDNS
  // host made a change rather than a generic "access-user".
  const email = payload.email;
  if (typeof email === 'string' && email.length > 0) return email;
  const commonName = payload.common_name;
  if (typeof commonName === 'string' && commonName.length > 0) {
    return `service-token:${commonName}`;
  }
  return 'access-user';
}

/* ----------------------------------------------------------- entry points */

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether this request may skip authentication entirely.
 *
 * Deliberately gated twice, because the cost of this leaking into a deployment
 * is an unauthenticated DNS control plane:
 *
 *  1. DEV_NO_AUTH must be set. It belongs in .dev.vars, which is gitignored and
 *     which `wrangler deploy` never uploads, so a deployed Worker cannot see it
 *     unless someone deliberately adds it as a secret or a [vars] entry.
 *  2. The request must have arrived on a loopback hostname. Even if the flag
 *     somehow reaches production, a request from the internet cannot satisfy
 *     this.
 */
export function isDevNoAuth(request: Request, env: Env): boolean {
  if (env.DEV_NO_AUTH !== 'true') return false;
  const host = new URL(request.url).hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    console.warn(
      `DEV_NO_AUTH is set but the request arrived on "${host}", not loopback; ` +
      'authentication is being enforced normally.',
    );
    return false;
  }
  return true;
}

/**
 * Reject requests arriving on a hostname that is not in the allowlist. Without
 * this, the default *.workers.dev URL would reach the Worker without passing
 * through the Access policy bound to the real hostname.
 */
export function assertAllowedHost(request: Request, env: Env): void {
  const allowed = env.ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean);
  if (allowed.length === 0) return; // unset: dev mode
  const host = new URL(request.url).hostname.toLowerCase();
  if (!allowed.some((h) => h.toLowerCase() === host)) {
    throw new ApiError(404, 'not_found', 'not found');
  }
}

/**
 * Authenticate a request by either path. Both failures return the same flat
 * 401 so a caller cannot learn which mechanism it got wrong.
 */
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  const unauthorized = new ApiError(401, 'unauthorized', 'authentication required');

  if (isDevNoAuth(request, env)) return { subject: 'dev-local', via: 'dev' };

  // 1. Cloudflare Access (UI, and service tokens issued to CoreDNS hosts).
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion') ??
                readCookie(request, 'CF_Authorization');
    if (jwt) {
      const subject = await verifyAccessJwt(jwt, env);
      if (subject) return { subject, via: 'access' };
      throw unauthorized;
    }
  }

  // 2. Bearer token (scripts, the CoreDNS pull loop).
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) {
    const presented = header.slice(7).trim();
    const accepted = [env.API_TOKEN, env.API_TOKEN_NEXT].filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    );
    // Compare against every configured token so rotation does not cause a
    // window where one of the two is rejected, and so the work done is the
    // same whichever token matched.
    let ok = false;
    for (const candidate of accepted) {
      if (timingSafeEqual(presented, candidate)) ok = true;
    }
    if (ok) return { subject: 'api-token', via: 'token' };
  }

  throw unauthorized;
}
