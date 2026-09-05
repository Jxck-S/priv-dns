import type { Env, ZoneDoc, ZoneIndexEntry } from './types.js';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${toHex(mac)}`;
}

/**
 * Tell each site's hook that a new serial exists so it can pull immediately.
 *
 * This is a latency optimisation only. Correctness never depends on it: the
 * sync loop on each host polls anyway, so a failed or dropped notify just
 * means the change lands on the next poll instead of within a second. Failures
 * are logged and dropped rather than retried, so a dead site cannot generate a
 * retry storm against the Worker.
 */
export async function notifyZoneUpdated(
  env: Env,
  entry: ZoneIndexEntry,
  doc: ZoneDoc,
): Promise<void> {
  const targets = entry.notify ?? [];
  if (targets.length === 0 || !env.NOTIFY_SECRET) return;

  const body = JSON.stringify({ origin: doc.origin, serial: doc.serial });
  const signature = await sign(env.NOTIFY_SECRET, body);

  await Promise.allSettled(targets.map(async (url) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'User-Agent': 'priv-dns-notify/1',
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.warn(`notify ${url} returned ${res.status}`);
    } catch (err) {
      console.warn(`notify ${url} failed: ${String(err)}`);
    }
  }));
}
