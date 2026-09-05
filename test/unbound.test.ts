import { describe, expect, it } from 'vitest';
import { renderUnbound } from '../src/render.js';
import type { ZoneDoc } from '../src/types.js';
import { validateRecord, validateSoa } from '../src/validate.js';

const zone = (records: unknown[]): ZoneDoc => ({
  origin: 'example.net.',
  serial: 2026090412,
  soa: validateSoa({}, 'example.net.'),
  defaultTtl: 300,
  records: records.map((r) => validateRecord(r, 300)),
  updatedAt: '2026-09-04T21:00:00.000Z',
  updatedBy: 'test',
});

describe('renderUnbound', () => {
  it('emits a transparent local-zone, not an authoritative one', () => {
    const out = renderUnbound(zone([]));
    // This single line is what keeps public names in the same zone resolving.
    expect(out).toContain('local-zone: "example.net." transparent');
    expect(out).toContain('server:');
  });

  it('renders A records with a reverse mapping', () => {
    const out = renderUnbound(zone([
      { name: 'nas', type: 'A', data: { ip: '10.10.0.20' }, comment: 'Synology' },
    ]));
    expect(out).toContain('local-data: "nas.example.net. 300 IN A 10.10.0.20"  # Synology');
    expect(out).toContain('local-data-ptr: "10.10.0.20 nas.example.net."');
  });

  it('makes relative targets absolute', () => {
    const out = renderUnbound(zone([
      { name: 'www', type: 'CNAME', data: { target: 'nas' } },
      { name: 'mail', type: 'MX', data: { preference: 10, exchange: 'mx' } },
      { name: '_sip._tcp', type: 'SRV',
        data: { priority: 10, weight: 5, port: 5060, target: 'pbx' } },
    ]));
    expect(out).toContain('IN CNAME nas.example.net.');
    expect(out).toContain('IN MX 10 mx.example.net.');
    expect(out).toContain('IN SRV 10 5 5060 pbx.example.net.');
  });

  it('keeps absolute targets absolute', () => {
    const out = renderUnbound(zone([
      { name: 'ext', type: 'CNAME', data: { target: 'host.example.com.' } },
    ]));
    expect(out).toContain('IN CNAME host.example.com.');
  });

  it('skips the placeholder apex NS', () => {
    const out = renderUnbound(zone([
      { name: '@', type: 'NS', data: { target: 'ns1.example.net.' } },
      { name: 'nas', type: 'A', data: { ip: '10.10.0.20' } },
    ]));
    expect(out).not.toContain('IN NS');
    expect(out).toContain('IN A 10.10.0.20');
  });

  it('does not emit a PTR for a wildcard', () => {
    const out = renderUnbound(zone([
      { name: '*.lab', type: 'A', data: { ip: '10.10.9.9' } },
    ]));
    expect(out).toContain('local-data: "*.lab.example.net. 300 IN A 10.10.9.9"');
    expect(out).not.toContain('local-data-ptr');
  });

  // A nested double quote would terminate Unbound's own string and make the
  // include unparseable - which stops Unbound starting and takes DNS down.
  it('switches the delimiter so TXT quoting cannot break the statement', () => {
    const out = renderUnbound(zone([
      { name: '@', type: 'TXT', data: { text: 'v=spf1 -all' } },
    ]));
    const line = out.split('\n').find((l) => l.includes('IN TXT'))!;
    expect(line.trim()).toBe(`local-data: 'example.net. 300 IN TXT "v=spf1 -all"'`);
  });

  it('skips a record it cannot quote safely rather than emit broken config', () => {
    const out = renderUnbound(zone([
      { name: 'ok', type: 'A', data: { ip: '10.0.0.1' } },
      { name: 'bad', type: 'TXT', data: { text: `it's "quoted"` } },
    ]));
    expect(out).toContain('# SKIPPED bad.example.net. TXT');
    expect(out).toContain('IN A 10.0.0.1');   // the rest still renders
  });

  it('emits only printable ASCII', () => {
    const out = renderUnbound(zone([
      { name: 'nas', type: 'A', data: { ip: '10.0.0.1' }, comment: 'rack' },
    ]));
    for (const line of out.split('\n')) expect(line).not.toMatch(/[^\t -~]/);
  });
});
