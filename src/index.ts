import { assertAllowedHost, authenticate, isDevNoAuth } from './auth.js';
import { renderHosts, renderUnbound } from './render.js';
import { notifyZoneUpdated } from './notify.js';
import { DASHBOARD_HTML } from './ui.js';
import { ApiError, type Env, type Identity, type ZoneDoc } from './types.js';
import {
  createZone, findRecordIndex, findZoneEntry, loadRenderedZone, loadZone,
  readIndex, saveZone,
} from './zones.js';
import { MAX_BODY_BYTES, validateOrigin, validateRecord } from './validate.js';

/* ---------------------------------------------------------------- helpers */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (allowed.length === 0) return {}; // same-origin UI: no CORS at all
  const origin = request.headers.get('Origin');
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin, // never "*", we send credentials
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Match',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify({ ok: true, data }, null, 2), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...init.headers,
    },
  });
}

function errorResponse(
  err: ApiError,
  requestId: string,
  extra: Record<string, string> = {},
): Response {
  const body = {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      requestId,
    },
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  };
  if (err.status === 401) headers['WWW-Authenticate'] = 'Bearer';
  return new Response(JSON.stringify(body, null, 2), { status: err.status, headers });
}

/**
 * Reduce an ETag to its bare value for comparison.
 *
 * Cloudflare rewrites a strong ETag to a weak one (W/"...") whenever it
 * compresses the response, which it does for any client sending
 * Accept-Encoding: gzip - i.e. every browser. Comparing the raw header would
 * therefore reject every edit made from the dashboard while curl worked fine.
 */
export function normalizeEtag(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/^W\//i, '').replace(/"/g, '').trim() || null;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('Content-Length');
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError(413, 'body_too_large', 'request body exceeds 1 MB');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, 'body_too_large', 'request body exceeds 1 MB');
  }
  if (text.trim().length === 0) {
    throw new ApiError(400, 'invalid_body', 'a JSON body is required');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_body', 'body is not valid JSON');
  }
}

/**
 * Apply a mutation to a zone under optimistic concurrency, then fan out the
 * change notification without holding the response open for it.
 */
async function mutateZone(
  env: Env,
  ctx: ExecutionContext,
  origin: string,
  identity: Identity,
  ifMatch: string | null,
  mutate: (doc: ZoneDoc) => ZoneDoc,
): Promise<ZoneDoc> {
  const entry = await findZoneEntry(env, origin);
  const { doc, etag } = await loadZone(env, origin);

  // A caller that sent If-Match is asserting which version it edited; honour
  // it over the etag we just read so a stale editor is rejected.
  const presented = normalizeEtag(ifMatch);
  if (presented && ifMatch !== '*' && presented !== normalizeEtag(etag)) {
    throw new ApiError(409, 'conflict',
      'the zone changed since you loaded it; reload and re-apply your edit');
  }

  const saved = await saveZone(env, mutate(doc), identity, etag);
  ctx.waitUntil(notifyZoneUpdated(env, entry, saved));
  return saved;
}

/* ----------------------------------------------------------------- router */

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  assertAllowedHost(request, env);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  // The dashboard. Access sits in front of it; the CSP forbids any external
  // resource, matching the fully self-contained page we serve.
  if (path === '/' && method === 'GET') {
    await authenticate(request, env);
    return new Response(DASHBOARD_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "connect-src 'self'; form-action 'none'; base-uri 'none'",
        ...SECURITY_HEADERS,
      },
    });
  }

  if (path === '/health' && method === 'GET') {
    return json({ status: 'ok', devNoAuth: isDevNoAuth(request, env) });
  }

  const identity = await authenticate(request, env);

  // Rendered zone file for the CoreDNS pull loop.
  const zoneMatch = /^\/zone\/([^/]+)$/.exec(path);
  if (zoneMatch && method === 'GET') {
    const origin = validateOrigin(decodeURIComponent(zoneMatch[1]!));
    await findZoneEntry(env, origin);

    // The zone is served in whichever shape the downstream resolver reads.
    // "bind" is authoritative (absent name -> NXDOMAIN); "unbound" and "hosts"
    // are additive overlays, so names not present fall through to normal
    // recursion and public names in the same zone keep working.
    const format = url.searchParams.get('format');
    if (format === 'unbound' || format === 'hosts') {
      const { doc, etag } = await loadZone(env, origin);
      const body = format === 'hosts' ? renderHosts(doc) : renderUnbound(doc);
      const tag = `${etag}-${format}`;
      if (normalizeEtag(request.headers.get('If-None-Match')) === tag) {
        return new Response(null, { status: 304, headers: { ETag: `"${tag}"` } });
      }
      return new Response(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          ETag: `"${tag}"`,
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
        },
      });
    }

    const rendered = await loadRenderedZone(env, origin);
    if (!rendered) throw new ApiError(404, 'zone_not_found', 'no rendered zone file');

    // Let the sync loop skip the download when nothing has changed.
    if (normalizeEtag(request.headers.get('If-None-Match')) === normalizeEtag(rendered.etag)) {
      return new Response(null, { status: 304, headers: { ETag: `"${rendered.etag}"` } });
    }
    return new Response(rendered.text, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        ETag: `"${rendered.etag}"`,
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      },
    });
  }

  const cors = corsHeaders(request, env);

  if (path === '/api/zones') {
    if (method === 'GET') {
      const index = await readIndex(env);
      return json({ zones: index.zones }, { headers: cors });
    }
    if (method === 'POST') {
      const doc = await createZone(env, await readJsonBody(request), identity);
      return json({ zone: doc }, { status: 201, headers: cors });
    }
    throw new ApiError(405, 'method_not_allowed', `${method} not allowed here`);
  }

  const zoneApi = /^\/api\/zones\/([^/]+)(?:\/records(?:\/([^/]+))?)?$/.exec(path);
  if (zoneApi) {
    const origin = validateOrigin(decodeURIComponent(zoneApi[1]!));
    const recordId = zoneApi[2] ? decodeURIComponent(zoneApi[2]) : null;
    const hasRecordsSegment = path.includes('/records');
    const ifMatch = request.headers.get('If-Match');

    // /api/zones/:origin
    if (!hasRecordsSegment) {
      if (method === 'GET') {
        await findZoneEntry(env, origin);
        const { doc, etag } = await loadZone(env, origin);
        // Also in the body: the edge rewrites ETag headers when it compresses,
        // so the body value is the one a client can rely on verbatim.
        return json({ zone: doc, etag }, { headers: { ETag: `"${etag}"`, ...cors } });
      }
      if (method === 'PUT') {
        if (!ifMatch) {
          throw new ApiError(428, 'precondition_required',
            'a bulk replace requires an If-Match header from a prior GET');
        }
        const body = await readJsonBody(request) as { records?: unknown };
        if (!Array.isArray(body.records)) {
          throw new ApiError(400, 'invalid_body', 'records must be an array');
        }
        const saved = await mutateZone(env, ctx, origin, identity, ifMatch, (doc) => ({
          ...doc,
          records: (body.records as unknown[]).map((r) => validateRecord(r, doc.defaultTtl, undefined, doc.origin)),
        }));
        return json({ zone: saved }, { headers: cors });
      }
      throw new ApiError(405, 'method_not_allowed', `${method} not allowed here`);
    }

    // /api/zones/:origin/records
    if (!recordId) {
      if (method === 'GET') {
        await findZoneEntry(env, origin);
        const { doc } = await loadZone(env, origin);
        return json({ records: doc.records, serial: doc.serial }, { headers: cors });
      }
      if (method === 'POST') {
        const body = await readJsonBody(request);
        let created = '';
        const saved = await mutateZone(env, ctx, origin, identity, ifMatch, (doc) => {
          const record = validateRecord(body, doc.defaultTtl, undefined, doc.origin);
          created = record.id;
          return { ...doc, records: [...doc.records, record] };
        });
        const record = saved.records.find((r) => r.id === created);
        return json({ record, serial: saved.serial }, { status: 201, headers: cors });
      }
      throw new ApiError(405, 'method_not_allowed', `${method} not allowed here`);
    }

    // /api/zones/:origin/records/:id
    if (method === 'PATCH') {
      const body = await readJsonBody(request);
      const saved = await mutateZone(env, ctx, origin, identity, ifMatch, (doc) => {
        const idx = findRecordIndex(doc, recordId);
        const existing = doc.records[idx]!;
        // Merge onto the existing record so a PATCH may send only what changed,
        // then re-validate the whole thing rather than trusting the untouched
        // half.
        const merged = { ...existing, ...(body as object) };
        const records = [...doc.records];
        records[idx] = validateRecord(merged, doc.defaultTtl, existing.id, doc.origin);
        return { ...doc, records };
      });
      return json({
        record: saved.records.find((r) => r.id === recordId),
        serial: saved.serial,
      }, { headers: cors });
    }
    if (method === 'DELETE') {
      const saved = await mutateZone(env, ctx, origin, identity, ifMatch, (doc) => {
        const idx = findRecordIndex(doc, recordId);
        const records = [...doc.records];
        records.splice(idx, 1);
        return { ...doc, records };
      });
      return json({ deleted: recordId, serial: saved.serial }, { headers: cors });
    }
    throw new ApiError(405, 'method_not_allowed', `${method} not allowed here`);
  }

  throw new ApiError(404, 'not_found', 'no such endpoint');
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      const response = await route(request, env, ctx);
      // Make an unauthenticated instance impossible to miss, in the browser
      // devtools and in curl -i alike.
      if (isDevNoAuth(request, env)) {
        const stamped = new Response(response.body, response);
        stamped.headers.set('X-Priv-Dns-Dev-No-Auth', 'true');
        return stamped;
      }
      return response;
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err, requestId, corsHeaders(request, env));
      }
      // Unexpected: log the detail server-side, return nothing useful to the
      // caller beyond an id they can quote.
      console.error(`[${requestId}] unhandled`, err);
      return errorResponse(
        new ApiError(500, 'internal_error', 'an internal error occurred'),
        requestId,
        corsHeaders(request, env),
      );
    }
  },
} satisfies ExportedHandler<Env>;
