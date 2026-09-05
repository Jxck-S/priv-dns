import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/types.js';
import {
  isReverseZone, nextSerial, sanitizeComment, validateIPv4, validateIPv6,
  relativize, validateOrigin, validateOwnerName, validateRecord, validateTtl,
  validateZoneSemantics,
} from '../src/validate.js';

const rec = (over: Record<string, unknown> = {}) =>
  validateRecord({ name: 'nas', type: 'A', data: { ip: '10.0.0.1' }, ...over }, 300);

/** Assert the call throws an ApiError carrying the expected code. */
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} error, but nothing was thrown`);
}

describe('owner names', () => {
  it('accepts ordinary names, the apex and wildcards', () => {
    expect(validateOwnerName('nas')).toBe('nas');
    expect(validateOwnerName('@')).toBe('@');
    expect(validateOwnerName('*.vpn')).toBe('*.vpn');
    expect(validateOwnerName('_sip._tcp')).toBe('_sip._tcp');
  });

  it('lowercases and strips a trailing dot', () => {
    expect(validateOwnerName('NAS.Home')).toBe('nas.home');
    expect(validateOwnerName('nas.')).toBe('nas');
  });

  it('rejects zone-file escape characters', () => {
    for (const bad of ['a\nb', 'a b', 'a;b', 'a"b', 'a(b', 'a\\b']) {
      expectCode(() => validateOwnerName(bad), 'invalid_field');
    }
  });

  it('rejects empty labels and over-long input', () => {
    expectCode(() => validateOwnerName('a..b'), 'invalid_field');
    expectCode(() => validateOwnerName('-lead'), 'invalid_field');
    expectCode(() => validateOwnerName('x'.repeat(64)), 'invalid_field');
  });
});

describe('origins', () => {
  it('canonicalises to an absolute name', () => {
    expect(validateOrigin('example.net')).toBe('example.net.');
    expect(validateOrigin('EXAMPLE.NET.')).toBe('example.net.');
  });

  it('accepts reverse zones', () => {
    expect(validateOrigin('10.in-addr.arpa')).toBe('10.in-addr.arpa.');
    expect(isReverseZone('10.in-addr.arpa.')).toBe(true);
    expect(isReverseZone('example.net.')).toBe(false);
  });

  it('rejects single-label and malformed origins', () => {
    expectCode(() => validateOrigin('localhost'), 'invalid_field');
    expectCode(() => validateOrigin('a..b.net'), 'invalid_field');
  });
});

describe('IPv4', () => {
  it('accepts private ranges, which are the normal case here', () => {
    expect(validateIPv4('10.10.0.20')).toBe('10.10.0.20');
    expect(validateIPv4('192.168.1.1')).toBe('192.168.1.1');
    expect(validateIPv4('100.64.0.1')).toBe('100.64.0.1');
  });

  it('rejects out-of-range octets and octal-looking leading zeros', () => {
    expectCode(() => validateIPv4('10.0.0.256'), 'invalid_field');
    expectCode(() => validateIPv4('010.0.0.1'), 'invalid_field');
    expectCode(() => validateIPv4('10.0.0'), 'invalid_field');
    expectCode(() => validateIPv4('10.0.0.1.5'), 'invalid_field');
  });
});

describe('IPv6', () => {
  it('canonicalises to lowercase compressed form', () => {
    expect(validateIPv6('FD00:0000:0000:0000:0000:0000:0000:0020')).toBe('fd00::20');
    expect(validateIPv6('fd00::20')).toBe('fd00::20');
    expect(validateIPv6('::1')).toBe('::1');
  });

  it('expands an embedded IPv4 suffix', () => {
    expect(validateIPv6('::ffff:10.0.0.1')).toBe('::ffff:a00:1');
  });

  it('rejects malformed addresses', () => {
    expectCode(() => validateIPv6('fd00::20::1'), 'invalid_field');
    expectCode(() => validateIPv6('fd00:1'), 'invalid_field');
    expectCode(() => validateIPv6('gggg::1'), 'invalid_field');
  });
});

describe('ttl', () => {
  it('falls back to the zone default when absent', () => {
    expect(validateTtl(undefined, 300)).toBe(300);
    expect(validateTtl(60, 300)).toBe(60);
  });

  it('rejects out-of-range and non-integer values', () => {
    expectCode(() => validateTtl(-1, 300), 'invalid_field');
    expectCode(() => validateTtl(604801, 300), 'invalid_field');
    expectCode(() => validateTtl(1.5, 300), 'invalid_field');
  });
});

describe('comments', () => {
  it('keeps ordinary text', () => {
    expect(sanitizeComment('Synology in the rack')).toBe('Synology in the rack');
  });

  it('strips semicolons and newlines that would break the zone line', () => {
    expect(sanitizeComment('rack; 10.0.0.9 A evil')).toBe('rack 10.0.0.9 A evil');
    expect(sanitizeComment('line one\nevil A 1.2.3.4')).toBe('line one evil A 1.2.3.4');
    expect(sanitizeComment('tab\there')).toBe('tab here');
  });

  it('truncates and normalises to undefined when empty', () => {
    expect(sanitizeComment('x'.repeat(300))?.length).toBe(200);
    expect(sanitizeComment('   ')).toBeUndefined();
    expect(sanitizeComment('')).toBeUndefined();
  });
});

describe('records', () => {
  it('builds a canonical record with a generated id', () => {
    const record = rec();
    expect(record.id).toMatch(/^r_[0-9a-f]{12}$/);
    expect(record).toMatchObject({ name: 'nas', type: 'A', ttl: 300 });
  });

  it('preserves an id on edit', () => {
    const record = validateRecord(
      { name: 'nas', type: 'A', data: { ip: '10.0.0.2' } }, 300, 'r_keepme');
    expect(record.id).toBe('r_keepme');
  });

  it('rejects unknown types', () => {
    expectCode(() => rec({ type: 'ANY' }), 'invalid_field');
    expectCode(() => rec({ type: 'CAA' }), 'invalid_field');
  });

  it('validates per-type payloads', () => {
    expect(rec({ type: 'MX', data: { preference: 10, exchange: 'mail' } }).data)
      .toEqual({ preference: 10, exchange: 'mail' });
    expectCode(() => rec({ type: 'MX', data: { preference: 70000, exchange: 'm' } }),
      'invalid_field');
    expectCode(() => rec({ type: 'SRV', data: { priority: 1, weight: 1, port: -1, target: 'h' } }),
      'invalid_field');
  });

  it('rejects a TXT payload containing a newline', () => {
    expectCode(() => rec({ type: 'TXT', data: { text: 'good\nevil A 1.2.3.4' } }),
      'invalid_field');
  });

  it('accepts a PTR record for a reverse zone', () => {
    const record = validateRecord(
      { name: '20', type: 'PTR', data: { target: 'nas.example.net.' } }, 300);
    expect(record.data).toEqual({ target: 'nas.example.net.' });
  });
});

describe('zone semantics', () => {
  it('rejects an exact duplicate', () => {
    expectCode(() => validateZoneSemantics([rec(), rec()]), 'duplicate_record');
  });

  it('allows round-robin: same name and type, different values', () => {
    expect(() => validateZoneSemantics([
      rec({ data: { ip: '10.0.0.1' } }),
      rec({ data: { ip: '10.0.0.2' } }),
    ])).not.toThrow();
  });

  it('rejects a CNAME alongside another type at the same name', () => {
    expectCode(() => validateZoneSemantics([
      rec(),
      rec({ type: 'CNAME', data: { target: 'other' } }),
    ]), 'cname_conflict');
  });

  it('rejects two CNAMEs at one name', () => {
    expectCode(() => validateZoneSemantics([
      rec({ type: 'CNAME', data: { target: 'a' } }),
      rec({ type: 'CNAME', data: { target: 'b' } }),
    ]), 'cname_conflict');
  });

  it('rejects a CNAME at the apex', () => {
    expectCode(() => validateZoneSemantics([
      rec({ name: '@', type: 'CNAME', data: { target: 'elsewhere' } }),
    ]), 'apex_cname');
  });
});

describe('serial', () => {
  const day = new Date('2026-09-04T12:00:00Z');

  it('uses the YYYYMMDDnn date base on the first edit of the day', () => {
    expect(nextSerial(2026090301, day)).toBe(2026090400);
  });

  it('increments within the same day', () => {
    expect(nextSerial(2026090400, day)).toBe(2026090401);
    expect(nextSerial(2026090499, day)).toBe(2026090500);
  });

  it('never moves backwards when the clock has slipped', () => {
    expect(nextSerial(2027010100, day)).toBe(2027010101);
  });
});

describe('relativize', () => {
  it('strips a trailing origin so names do not double up', () => {
    expect(relativize('proxy.example.net', 'example.net.')).toBe('proxy');
    expect(relativize('nas.home.example.net', 'example.net.')).toBe('nas.home');
  });

  it('maps the bare origin to the apex', () => {
    expect(relativize('example.net', 'example.net.')).toBe('@');
    expect(relativize('@', 'example.net.')).toBe('@');
  });

  it('leaves unrelated names alone', () => {
    expect(relativize('nas', 'example.net.')).toBe('nas');
    expect(relativize('nas.example.com', 'example.net.')).toBe('nas.example.com');
    expect(relativize('nas', undefined)).toBe('nas');
  });
});

describe('targets that are IP addresses', () => {
  // Numeric labels are legal DNS names, so these pass syntax checks - but a
  // CNAME or MX pointing at an address never resolves.
  it('rejects an IPv4 CNAME target', () => {
    expectCode(() => validateRecord(
      { name: 'files', type: 'CNAME', data: { target: '10.20.0.5' } }, 300),
      'invalid_field');
  });

  it('rejects an IPv6 target and an IP MX exchange', () => {
    expectCode(() => validateRecord(
      { name: 'x', type: 'CNAME', data: { target: 'fd00::1' } }, 300), 'invalid_field');
    expectCode(() => validateRecord(
      { name: 'x', type: 'MX', data: { preference: 10, exchange: '10.0.0.1' } }, 300),
      'invalid_field');
  });

  it('still accepts hostnames with numeric labels', () => {
    const r = validateRecord(
      { name: 'x', type: 'CNAME', data: { target: '10.hosts.example.com' } }, 300);
    expect(r.data).toEqual({ target: '10.hosts.example.com' });
  });

  it('relativizes an FQDN name at record level', () => {
    const r = validateRecord(
      { name: 'proxy.example.net', type: 'A', data: { ip: '10.20.0.5' } },
      300, undefined, 'example.net.');
    expect(r.name).toBe('proxy');
  });
});
