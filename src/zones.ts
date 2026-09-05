import { renderZone } from './render.js';
import {
  ApiError,
  type DnsRecord, type Env, type Identity,
  type ZoneDoc, type ZoneIndex, type ZoneIndexEntry,
} from './types.js';
import { nextSerial, validateOrigin, validateSoa, validateZoneSemantics } from './validate.js';

const INDEX_KEY = 'zones/index.json';

const jsonKey = (origin: string) => `zones/${origin.replace(/\.$/, '')}.json`;
const zoneKey = (origin: string) => `zones/${origin.replace(/\.$/, '')}.zone`;

/* ------------------------------------------------------------------ index */

export async function readIndex(env: Env): Promise<ZoneIndex> {
  const object = await env.DNS_ZONES.get(INDEX_KEY);
  if (!object) return { zones: [] };
  const parsed = (await object.json()) as Partial<ZoneIndex>;
  return { zones: Array.isArray(parsed.zones) ? parsed.zones : [] };
}

async function writeIndex(env: Env, index: ZoneIndex): Promise<void> {
  await env.DNS_ZONES.put(INDEX_KEY, JSON.stringify(index, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function findZoneEntry(env: Env, origin: string): Promise<ZoneIndexEntry> {
  const index = await readIndex(env);
  const entry = index.zones.find((z) => z.origin === origin);
  if (!entry) throw new ApiError(404, 'zone_not_found', `zone "${origin}" is not configured`);
  return entry;
}

/* ------------------------------------------------------------------ zones */

export interface LoadedZone {
  doc: ZoneDoc;
  etag: string;
}

export async function loadZone(env: Env, origin: string): Promise<LoadedZone> {
  const object = await env.DNS_ZONES.get(jsonKey(origin));
  if (!object) throw new ApiError(404, 'zone_not_found', `zone "${origin}" has no stored data`);
  const doc = (await object.json()) as ZoneDoc;
  return { doc, etag: object.etag };
}

/**
 * Persist a zone: bump the serial, re-render the BIND file, and write both
 * objects.
 *
 * The JSON write is guarded by the etag the caller read, so a concurrent edit
 * loses with a 409 instead of silently overwriting. The rendered .zone is
 * written second and unguarded — it is derived data, and if this request wins
 * the JSON write it is by definition the newest state.
 */
export async function saveZone(
  env: Env,
  doc: ZoneDoc,
  identity: Identity,
  expectedEtag: string | null,
): Promise<ZoneDoc> {
  validateZoneSemantics(doc.records);

  const updated: ZoneDoc = {
    ...doc,
    serial: nextSerial(doc.serial),
    updatedAt: new Date().toISOString(),
    updatedBy: identity.subject,
  };

  const body = JSON.stringify(updated, null, 2);
  const put = await env.DNS_ZONES.put(jsonKey(updated.origin), body, {
    httpMetadata: { contentType: 'application/json' },
    ...(expectedEtag ? { onlyIf: { etagMatches: expectedEtag } } : {}),
  });

  // R2 returns null when the onlyIf precondition fails.
  if (!put) {
    throw new ApiError(409, 'conflict',
      'the zone changed since you loaded it; reload and re-apply your edit');
  }

  await env.DNS_ZONES.put(zoneKey(updated.origin), renderZone(updated), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });

  return updated;
}

export async function loadRenderedZone(
  env: Env,
  origin: string,
): Promise<{ text: string; etag: string } | null> {
  const object = await env.DNS_ZONES.get(zoneKey(origin));
  if (!object) return null;
  return { text: await object.text(), etag: object.etag };
}

/* --------------------------------------------------------------- creation */

export async function createZone(
  env: Env,
  raw: unknown,
  identity: Identity,
): Promise<ZoneDoc> {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const origin = validateOrigin(input.origin);

  const index = await readIndex(env);
  if (index.zones.some((z) => z.origin === origin)) {
    throw new ApiError(409, 'zone_exists', `zone "${origin}" already exists`);
  }

  const defaultTtl = typeof input.defaultTtl === 'number' ? input.defaultTtl : 300;
  const soa = validateSoa(input.soa, origin);

  const doc: ZoneDoc = {
    origin,
    serial: 0,
    soa,
    defaultTtl,
    // Seed the apex NS so the file parses as a valid zone from the first pull.
    // These zones are never delegated, so this is boilerplate CoreDNS needs
    // rather than anything a registrar will look at.
    records: [{
      id: 'r_apex_ns',
      name: '@',
      type: 'NS',
      ttl: defaultTtl,
      data: { target: soa.mname },
      comment: 'placeholder apex NS (internal zone, not delegated)',
    }],
    updatedAt: new Date().toISOString(),
    updatedBy: identity.subject,
  };

  const saved = await saveZone(env, doc, identity, null);

  index.zones.push({
    origin,
    enabled: true,
    notify: Array.isArray(input.notify) ? (input.notify as string[]).filter(
      (u) => typeof u === 'string' && u.startsWith('https://'),
    ) : [],
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
  });
  await writeIndex(env, index);

  return saved;
}

/* ---------------------------------------------------------- record lookup */

export function findRecordIndex(doc: ZoneDoc, id: string): number {
  const idx = doc.records.findIndex((r: DnsRecord) => r.id === id);
  if (idx < 0) throw new ApiError(404, 'record_not_found', `no record with id "${id}"`);
  return idx;
}
