import {
  ApiError, RECORD_TYPES,
  type DnsRecord, type RecordData, type RecordType, type Soa, type ZoneDoc,
} from './types.js';

export const MAX_TTL = 604800;
export const MAX_RECORDS_PER_ZONE = 5000;
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_COMMENT_LEN = 200;

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Characters that would let a value break out of its zone-file line. */
const DANGEROUS_RE = /[\s;"()\\]/;
/** Anything outside printable ASCII, including newlines and control codes. */
const NON_PRINTABLE_RE = /[^ -~]/g;

function fail(field: string, message: string): never {
  throw new ApiError(400, 'invalid_field', `${field}: ${message}`, { field });
}

/* ------------------------------------------------------------------ names */

/**
 * Validate a single DNS label. Underscore-prefixed labels are permitted because
 * SRV/TXT service names (_sip._tcp, _acme-challenge) legitimately use them.
 */
function validLabel(label: string, allowUnderscore: boolean): boolean {
  if (label.length === 0 || label.length > 63) return false;
  const body = allowUnderscore && label.startsWith('_') ? label.slice(1) : label;
  return LABEL_RE.test(body);
}

/**
 * Owner name relative to the zone origin. Accepts "@" for the apex and a
 * leading "*" wildcard label. Returns the lowercased canonical form.
 */
export function validateOwnerName(input: unknown, field = 'name'): string {
  if (typeof input !== 'string') fail(field, 'must be a string');
  const raw = input.trim();
  if (raw.length === 0) fail(field, 'must not be empty');
  if (DANGEROUS_RE.test(raw)) fail(field, 'contains forbidden characters');
  if (raw === '@') return '@';

  const name = raw.toLowerCase().replace(/\.$/, '');
  if (name.length > 253) fail(field, 'exceeds 253 bytes');

  const labels = name.split('.');
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i]!;
    if (i === 0 && label === '*') continue; // wildcard, leftmost only
    if (!validLabel(label, true)) fail(field, `invalid label "${label}"`);
  }
  return name;
}

/** True if the string is a bare IP literal rather than a hostname. */
function looksLikeIpLiteral(value: string): boolean {
  const bare = value.replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true;      // dotted quad
  return bare.includes(':') && /^[0-9a-f:.]+$/i.test(bare);     // IPv6
}

/** A target name (CNAME, NS, PTR, MX exchange, SRV target). */
export function validateFqdn(input: unknown, field: string): string {
  if (typeof input !== 'string') fail(field, 'must be a string');
  const raw = input.trim();
  if (raw.length === 0) fail(field, 'must not be empty');
  if (DANGEROUS_RE.test(raw)) fail(field, 'contains forbidden characters');
  // Numeric labels are legal in DNS, so an IP address passes the syntax rules
  // below - but a CNAME or MX pointing at an address never resolves. Catch it
  // here rather than letting it into the zone.
  if (looksLikeIpLiteral(raw)) {
    fail(field, 'must be a hostname, not an IP address (use an A/AAAA record instead)');
  }

  const absolute = raw.endsWith('.');
  const name = raw.toLowerCase().replace(/\.$/, '');
  if (name.length === 0 || name.length > 253) fail(field, 'invalid length');
  for (const label of name.split('.')) {
    if (!validLabel(label, true)) fail(field, `invalid label "${label}"`);
  }
  // Preserve the author's intent: absolute stays absolute, relative stays
  // relative and is resolved against $ORIGIN by the renderer.
  return absolute ? `${name}.` : name;
}

/** Zone origin. Always canonicalised to an absolute name with a trailing dot. */
export function validateOrigin(input: unknown, field = 'origin'): string {
  if (typeof input !== 'string') fail(field, 'must be a string');
  const raw = input.trim().toLowerCase();
  if (raw.length === 0) fail(field, 'must not be empty');
  if (DANGEROUS_RE.test(raw)) fail(field, 'contains forbidden characters');
  if (raw.includes('..')) fail(field, 'contains an empty label');

  const name = raw.replace(/\.$/, '');
  if (name.length > 253) fail(field, 'exceeds 253 bytes');
  const labels = name.split('.');
  if (labels.length < 2) fail(field, 'must have at least two labels');
  for (const label of labels) {
    // Reverse zones use purely numeric labels (10.in-addr.arpa).
    if (!validLabel(label, false)) fail(field, `invalid label "${label}"`);
  }
  return `${name}.`;
}

export function isReverseZone(origin: string): boolean {
  const o = origin.toLowerCase();
  return o.endsWith('in-addr.arpa.') || o.endsWith('ip6.arpa.');
}

/* -------------------------------------------------------------- addresses */

/**
 * Strict dotted-quad. Rejects leading zeros, which some resolvers read as
 * octal. Private ranges are intentionally allowed: this is internal DNS, so
 * RFC1918/CGNAT addresses are the normal case, not an error.
 */
export function validateIPv4(input: unknown, field = 'data.ip'): string {
  if (typeof input !== 'string') fail(field, 'must be a string');
  const parts = input.trim().split('.');
  if (parts.length !== 4) fail(field, 'must have four octets');
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) fail(field, `invalid octet "${part}"`);
    if (part.length > 1 && part.startsWith('0')) {
      fail(field, `octet "${part}" has a leading zero`);
    }
    const n = Number(part);
    if (n > 255) fail(field, `octet ${n} exceeds 255`);
    out.push(n);
  }
  return out.join('.');
}

/** Strict IPv6 parse, re-serialised canonically (lowercase, compressed). */
export function validateIPv6(input: unknown, field = 'data.ip'): string {
  if (typeof input !== 'string') fail(field, 'must be a string');
  const raw = input.trim().toLowerCase();
  if (raw.length === 0 || raw.length > 45) fail(field, 'invalid length');
  if (!/^[0-9a-f:.]+$/.test(raw)) fail(field, 'contains invalid characters');

  const doubleColons = raw.split('::').length - 1;
  if (doubleColons > 1) fail(field, 'has more than one "::"');
  if (doubleColons === 0 && (raw.startsWith(':') || raw.endsWith(':'))) {
    fail(field, 'has a dangling colon');
  }

  const expand = (chunks: string[]): number[] => {
    const into: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      // A trailing IPv4 literal (::ffff:10.0.0.1) expands to two hextets.
      if (chunk.includes('.')) {
        if (i !== chunks.length - 1) fail(field, 'misplaced IPv4 suffix');
        const v4 = validateIPv4(chunk, field).split('.').map(Number);
        into.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) fail(field, `invalid group "${chunk}"`);
      into.push(parseInt(chunk, 16));
    }
    return into;
  };

  let groups: number[];
  if (doubleColons === 1) {
    const [before = '', after = ''] = raw.split('::');
    const head = expand(before === '' ? [] : before.split(':'));
    const tail = expand(after === '' ? [] : after.split(':'));
    const missing = 8 - head.length - tail.length;
    if (missing < 1) fail(field, '"::" must elide at least one group');
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    groups = expand(raw.split(':'));
  }
  if (groups.length !== 8) fail(field, 'must expand to 8 groups');

  return compressIPv6(groups);
}

function compressIPv6(groups: number[]): string {
  // Elide the longest run of two or more zero groups.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) { curStart = i; curLen = 1; } else { curLen++; }
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/* ------------------------------------------------------------ scalar bits */

export function validateTtl(input: unknown, fallback: number): number {
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    fail('ttl', 'must be an integer');
  }
  if (input < 0 || input > MAX_TTL) fail('ttl', `must be between 0 and ${MAX_TTL}`);
  return input;
}

function validateUint16(input: unknown, field: string): number {
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    fail(field, 'must be an integer');
  }
  if (input < 0 || input > 65535) fail(field, 'must be between 0 and 65535');
  return input;
}

/**
 * Comments are the one free-text field that reaches the zone file, so they get
 * the strictest scrub: anything not printable ASCII becomes a space, and ";"
 * is removed so a comment can never open a second comment or end a line.
 */
export function sanitizeComment(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string') fail('comment', 'must be a string');
  const cleaned = input
    .replace(NON_PRINTABLE_RE, ' ')
    .replace(/;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_COMMENT_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** TXT payloads: printable ASCII only; escaping happens at render time. */
export function validateTxt(input: unknown, field = 'data.text'): string {
  if (typeof input !== 'string') fail(field, 'must be a string');
  if (input.length === 0) fail(field, 'must not be empty');
  if (input.length > 4096) fail(field, 'exceeds 4096 characters');
  if (NON_PRINTABLE_RE.test(input)) fail(field, 'must be printable ASCII');
  return input;
}

/* ------------------------------------------------------------ the records */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateData(type: RecordType, raw: unknown): RecordData {
  if (!isPlainObject(raw)) fail('data', 'must be an object');
  const d = raw;
  switch (type) {
    case 'A':
      return { ip: validateIPv4(d.ip) };
    case 'AAAA':
      return { ip: validateIPv6(d.ip) };
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return { target: validateFqdn(d.target, 'data.target') };
    case 'TXT':
      return { text: validateTxt(d.text) };
    case 'MX':
      return {
        preference: validateUint16(d.preference, 'data.preference'),
        exchange: validateFqdn(d.exchange, 'data.exchange'),
      };
    case 'SRV':
      return {
        priority: validateUint16(d.priority, 'data.priority'),
        weight: validateUint16(d.weight, 'data.weight'),
        port: validateUint16(d.port, 'data.port'),
        target: validateFqdn(d.target, 'data.target'),
      };
  }
}

/** Strip a trailing zone origin from an owner name, if present. */
export function relativize(name: string, origin?: string): string {
  if (!origin || name === '@') return name;
  const zone = origin.replace(/\.$/, '').toLowerCase();
  const lower = name.toLowerCase();
  if (lower === zone) return '@';
  if (lower.endsWith(`.${zone}`)) {
    const stripped = name.slice(0, -(zone.length + 1));
    return stripped.length > 0 ? stripped : '@';
  }
  return name;
}

export function newRecordId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `r_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Validate one untrusted record payload into a canonical DnsRecord. */
export function validateRecord(
  raw: unknown,
  defaultTtl: number,
  existingId?: string,
  origin?: string,
): DnsRecord {
  if (!isPlainObject(raw)) {
    throw new ApiError(400, 'invalid_body', 'record must be an object');
  }

  const type = raw.type;
  if (typeof type !== 'string' || !(RECORD_TYPES as readonly string[]).includes(type)) {
    fail('type', `must be one of ${RECORD_TYPES.join(', ')}`);
  }
  const recordType = type as RecordType;

  return {
    id: existingId ?? newRecordId(),
    // Names are stored relative to the origin. Someone typing the full FQDN in
    // the UI is expressing the same intent, so strip the suffix rather than
    // storing a name that renders as "host.example.com.example.com".
    name: relativize(validateOwnerName(raw.name), origin),
    type: recordType,
    ttl: validateTtl(raw.ttl, defaultTtl),
    data: validateData(recordType, raw.data),
    comment: sanitizeComment(raw.comment),
  };
}

/* -------------------------------------------------------------- zone-wide */

/** Stable key for duplicate detection: same name, type and value. */
export function recordKey(r: DnsRecord): string {
  return `${r.name} ${r.type} ${JSON.stringify(r.data)}`;
}

/**
 * Whole-zone rules a single record cannot check on its own. Runs after every
 * mutation so a stored zone is never left inconsistent.
 */
export function validateZoneSemantics(records: DnsRecord[]): void {
  if (records.length > MAX_RECORDS_PER_ZONE) {
    throw new ApiError(400, 'too_many_records',
      `zone exceeds ${MAX_RECORDS_PER_ZONE} records`);
  }

  const seen = new Set<string>();
  const byName = new Map<string, RecordType[]>();

  for (const r of records) {
    const key = recordKey(r);
    if (seen.has(key)) {
      throw new ApiError(409, 'duplicate_record',
        `duplicate ${r.type} record for "${r.name}" with the same value`,
        { name: r.name, type: r.type });
    }
    seen.add(key);
    const types = byName.get(r.name);
    if (types) types.push(r.type); else byName.set(r.name, [r.type]);
  }

  for (const [name, types] of byName) {
    const cnames = types.filter((t) => t === 'CNAME').length;
    if (cnames === 0) continue;
    if (name === '@') {
      throw new ApiError(400, 'apex_cname',
        'a CNAME is not allowed at the zone apex', { name });
    }
    if (cnames > 1) {
      throw new ApiError(409, 'cname_conflict',
        `"${name}" has ${cnames} CNAME records; only one is allowed`, { name });
    }
    const others = [...new Set(types.filter((t) => t !== 'CNAME'))];
    if (others.length > 0) {
      throw new ApiError(409, 'cname_conflict',
        `"${name}" has a CNAME alongside ${others.join(', ')}`,
        { name, conflictsWith: others });
    }
  }
}

export function validateSoa(raw: unknown, origin: string): Soa {
  const d = isPlainObject(raw) ? raw : {};
  const num = (v: unknown, field: string, dflt: number): number => {
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2147483647) {
      fail(field, 'must be a non-negative integer');
    }
    return v;
  };
  return {
    mname: d.mname ? validateFqdn(d.mname, 'soa.mname') : `ns1.${origin}`,
    rname: d.rname ? validateFqdn(d.rname, 'soa.rname') : `hostmaster.${origin}`,
    refresh: num(d.refresh, 'soa.refresh', 7200),
    retry: num(d.retry, 'soa.retry', 3600),
    expire: num(d.expire, 'soa.expire', 1209600),
    minimum: num(d.minimum, 'soa.minimum', 300),
  };
}

/**
 * Serial in YYYYMMDDnn form. Never moves backwards: if today's base is not
 * ahead of the stored serial we increment instead, which covers both more than
 * 99 edits in a day and a clock that has slipped.
 */
export function nextSerial(current: number, now = new Date()): number {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const base = Number(`${y}${m}${d}00`);
  return base > current ? base : current + 1;
}

export function assertValidZoneDoc(doc: ZoneDoc): void {
  validateZoneSemantics(doc.records);
}
