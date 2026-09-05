import { describe, expect, it } from 'vitest';
import { renderTxt, renderZone } from '../src/render.js';
import type { ZoneDoc } from '../src/types.js';
import { validateRecord } from '../src/validate.js';

function zone(records: unknown[]): ZoneDoc {
  return {
    origin: 'example.net.',
    serial: 2026090401,
    soa: {
      mname: 'ns1.example.net.',
      rname: 'hostmaster.example.net.',
      refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
    },
    defaultTtl: 300,
    records: records.map((r) => validateRecord(r, 300)),
    updatedAt: '2026-09-04T16:07:00.000Z',
    updatedBy: 'admin@example.net',
  };
}

describe('renderZone', () => {
  it('emits a parseable header, SOA and records', () => {
    const text = renderZone(zone([
      { name: '@', type: 'NS', data: { target: 'ns1.example.net.' } },
      { name: 'nas', type: 'A', data: { ip: '10.10.0.20' },
        comment: 'Synology in the rack' },
      { name: 'vpn', type: 'A', data: { ip: '10.10.0.1' } },
    ]));

    expect(text).toContain('$ORIGIN example.net.');
    expect(text).toContain('$TTL 300');
    expect(text).toContain('IN  SOA ns1.example.net. hostmaster.example.net. (');
    expect(text).toContain('2026090401 ; serial'.replace(' ;', '  ;').slice(0, 10));
    expect(text).toMatch(/nas\s+300\s+IN\s+A\s+10\.10\.0\.20 ; Synology in the rack/);
    expect(text).toMatch(/vpn\s+300\s+IN\s+A\s+10\.10\.0\.1$/m);
  });

  it('is deterministic, so two sites produce byte-identical files', () => {
    const a = zone([
      { name: 'vpn', type: 'A', data: { ip: '10.10.0.1' } },
      { name: 'nas', type: 'A', data: { ip: '10.10.0.20' } },
    ]);
    const b = zone([
      { name: 'nas', type: 'A', data: { ip: '10.10.0.20' } },
      { name: 'vpn', type: 'A', data: { ip: '10.10.0.1' } },
    ]);
    // Ids are random per record, but they are not rendered, so the files match.
    expect(renderZone(a)).toBe(renderZone(b));
  });

  it('never emits an unescaped newline or a stray record-bearing line', () => {
    const text = renderZone(zone([
      { name: 'nas', type: 'A', data: { ip: '10.0.0.1' }, comment: 'a; b\tc' },
      { name: 'spf', type: 'TXT', data: { text: 'v=spf1 "quoted" and \\ slash' } },
    ]));

    for (const line of text.split('\n')) {
      expect(line).not.toMatch(/[^\t -~]/); // printable ASCII only
    }
    // The scrubbed comment must not have introduced a second comment marker.
    const nasLine = text.split('\n').find((l) => l.startsWith('nas'))!;
    expect(nasLine.match(/;/g)).toHaveLength(1);
  });

  it('renders each record type in its wire format', () => {
    const text = renderZone(zone([
      { name: 'mail', type: 'MX', data: { preference: 10, exchange: 'mx1' } },
      { name: '_sip._tcp', type: 'SRV',
        data: { priority: 10, weight: 5, port: 5060, target: 'pbx' } },
      { name: 'www', type: 'CNAME', data: { target: 'nas' } },
      { name: 'v6', type: 'AAAA', data: { ip: 'fd00::20' } },
    ]));

    expect(text).toMatch(/mail\s+300\s+IN\s+MX\s+10 mx1/);
    expect(text).toMatch(/_sip\._tcp\s+300\s+IN\s+SRV\s+10 5 5060 pbx/);
    expect(text).toMatch(/www\s+300\s+IN\s+CNAME\s+nas/);
    expect(text).toMatch(/v6\s+300\s+IN\s+AAAA\s+fd00::20/);
  });
});

describe('renderTxt', () => {
  it('quotes and escapes', () => {
    expect(renderTxt('v=spf1 -all')).toBe('"v=spf1 -all"');
    expect(renderTxt('say "hi"')).toBe('"say \\"hi\\""');
    expect(renderTxt('back\\slash')).toBe('"back\\\\slash"');
  });

  it('splits payloads longer than 255 bytes into multiple strings', () => {
    const out = renderTxt('x'.repeat(600));
    const chunks = out.match(/"[^"]*"/g)!;
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length - 2).toBeLessThanOrEqual(255);
    expect(chunks.join('').replace(/"/g, '')).toHaveLength(600);
  });

  it('does not split in the middle of an escape sequence', () => {
    // 200 backslashes escape to 400 characters, so this must be chunked.
    const out = renderTxt('\\'.repeat(200));
    for (const chunk of out.match(/"[^"]*"/g)!) {
      const body = chunk.slice(1, -1);
      const trailing = body.match(/\\+$/)?.[0].length ?? 0;
      expect(trailing % 2).toBe(0); // never ends on a lone backslash
    }
  });
});
