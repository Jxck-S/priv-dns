import { describe, expect, it } from 'vitest';
import { authenticate, isDevNoAuth, timingSafeEqual } from '../src/auth.js';
import { ApiError, type Env } from '../src/types.js';

const env = (over: Partial<Env> = {}): Env => ({
  DNS_ZONES: {} as R2Bucket,
  ACCESS_TEAM_DOMAIN: '',
  ACCESS_AUD: '',
  ALLOWED_HOSTS: '',
  CORS_ORIGINS: '',
  API_TOKEN: 'real-token',
  ...over,
});

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

describe('timingSafeEqual', () => {
  it('matches only identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual('abc', '')).toBe(false);
  });
});

describe('dev no-auth gate', () => {
  it('is off unless DEV_NO_AUTH is exactly "true"', () => {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'yes']) {
      expect(isDevNoAuth(
        req('http://localhost:8787/api/zones'),
        env({ DEV_NO_AUTH: value }),
      )).toBe(false);
    }
  });

  it('is on for loopback hostnames when the flag is set', () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
      expect(isDevNoAuth(
        req(`http://${host}/api/zones`),
        env({ DEV_NO_AUTH: 'true' }),
      )).toBe(true);
    }
  });

  // The second gate: even if the flag somehow reaches a deployed Worker, a
  // request from the internet must not be able to satisfy it.
  it('stays off for any non-loopback host even when the flag is set', () => {
    for (const host of [
      'dns-cp.example.net',
      'priv-dns.workers.dev',
      'localhost.evil.com',
      '127.0.0.1.evil.com',
      'notlocalhost',
    ]) {
      expect(isDevNoAuth(
        req(`https://${host}/api/zones`),
        env({ DEV_NO_AUTH: 'true' }),
      )).toBe(false);
    }
  });
});

describe('authenticate', () => {
  it('accepts any request in dev mode', async () => {
    const identity = await authenticate(
      req('http://localhost:8787/api/zones'),
      env({ DEV_NO_AUTH: 'true' }),
    );
    expect(identity).toEqual({ subject: 'dev-local', via: 'dev' });
  });

  it('still enforces auth on a real host with the flag set', async () => {
    await expect(authenticate(
      req('https://dns-cp.example.net/api/zones'),
      env({ DEV_NO_AUTH: 'true' }),
    )).rejects.toThrow(ApiError);
  });

  it('rejects a missing or wrong bearer token', async () => {
    await expect(authenticate(req('https://dns-cp.example.net/api/zones'), env()))
      .rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    await expect(authenticate(
      req('https://dns-cp.example.net/api/zones', { Authorization: 'Bearer nope' }),
      env(),
    )).rejects.toMatchObject({ status: 401 });
  });

  it('accepts the configured token', async () => {
    const identity = await authenticate(
      req('https://dns-cp.example.net/api/zones', { Authorization: 'Bearer real-token' }),
      env(),
    );
    expect(identity).toEqual({ subject: 'api-token', via: 'token' });
  });

  it('accepts both tokens during a rotation', async () => {
    const rotating = env({ API_TOKEN: 'old-token', API_TOKEN_NEXT: 'new-token' });
    for (const token of ['old-token', 'new-token']) {
      const identity = await authenticate(
        req('https://dns-cp.example.net/api/zones', { Authorization: `Bearer ${token}` }),
        rotating,
      );
      expect(identity.via).toBe('token');
    }
    await expect(authenticate(
      req('https://dns-cp.example.net/api/zones', { Authorization: 'Bearer third' }),
      rotating,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('does not treat an empty configured token as a match', async () => {
    await expect(authenticate(
      req('https://dns-cp.example.net/api/zones', { Authorization: 'Bearer ' }),
      env({ API_TOKEN: '' }),
    )).rejects.toMatchObject({ status: 401 });
  });
});
