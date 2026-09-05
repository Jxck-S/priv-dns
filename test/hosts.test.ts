import { describe, expect, it } from 'vitest';
import { renderHosts } from '../src/render.js';
import type { ZoneDoc } from '../src/types.js';
import { validateRecord, validateSoa } from '../src/validate.js';

const zone = (records: unknown[]): ZoneDoc => ({
  origin: 'example.net.',
  serial: 2026090512,
  soa: validateSoa({}, 'example.net.'),
  defaultTtl: 300,
  records: records.map((r) => validateRecord(r, 300)),
  updatedAt: '2026-09-05T00:00:00.000Z',
  updatedBy: 'test',
});

describe('renderHosts', () => {
  it('emits address records in hosts-file form', () => {
    const out = renderHosts(zone([
      { name: 'nas', type: 'A', data: { ip: '10.10.0.20' }, comment: 'Synology' },
    ]));
    expect(out).toMatch(/^10\.10\.0\.20\s+nas\.example\.net\s+# Synology$/m);
  });

  // A hosts file has no CNAME concept, so the chain is followed to an address.
  it('flattens a CNAME to its target address', () => {
    const out = renderHosts(zone([
      { name: 'proxy', type: 'A', data: { ip: '10.10.0.9' } },
      { name: 'git', type: 'CNAME', data: { target: 'proxy' } },
    ]));
    expect(out).toMatch(/^10\.10\.0\.9\s+git\.example\.net\s+# flattened from proxy\.example\.net$/m);
  });

  it('follows a multi-hop CNAME chain', () => {
    const out = renderHosts(zone([
      { name: 'proxy', type: 'A', data: { ip: '10.10.0.9' } },
      { name: 'mid', type: 'CNAME', data: { target: 'proxy' } },
      { name: 'git', type: 'CNAME', data: { target: 'mid' } },
    ]));
    expect(out).toMatch(/^10\.10\.0\.9\s+git\.example\.net/m);
  });

  it('does not hang on a CNAME loop', () => {
    const out = renderHosts(zone([
      { name: 'a', type: 'CNAME', data: { target: 'b' } },
      { name: 'b', type: 'CNAME', data: { target: 'a' } },
    ]));
    expect(out).toContain('Not representable');
    expect(out).not.toMatch(/^\d.*\sa\.example\.net/m);
  });

  it('keeps round-robin addresses as separate lines', () => {
    const out = renderHosts(zone([
      { name: 'web', type: 'A', data: { ip: '10.0.0.1' } },
      { name: 'web', type: 'A', data: { ip: '10.0.0.2' } },
    ]));
    expect(out).toMatch(/^10\.0\.0\.1\s+web\.example\.net/m);
    expect(out).toMatch(/^10\.0\.0\.2\s+web\.example\.net/m);
  });

  // Silently dropping these would make the file quietly wrong, so they are
  // listed instead.
  it('reports records a hosts file cannot express', () => {
    const out = renderHosts(zone([
      { name: 'nas', type: 'A', data: { ip: '10.0.0.1' } },
      { name: 'mail', type: 'MX', data: { preference: 10, exchange: 'nas' } },
      { name: '@', type: 'TXT', data: { text: 'v=spf1 -all' } },
      { name: '*.lab', type: 'A', data: { ip: '10.0.9.9' } },
    ]));
    expect(out).toContain('# Not representable in a hosts file:');
    expect(out).toContain('mail.example.net MX');
    expect(out).toContain('example.net TXT');
    expect(out).toContain('(wildcard)');
    // The wildcard must not appear as a live entry.
    expect(out).not.toMatch(/^10\.0\.9\.9\s+\*/m);
  });

  it('omits the placeholder apex NS', () => {
    const out = renderHosts(zone([
      { name: '@', type: 'NS', data: { target: 'ns1.example.net.' } },
      { name: 'nas', type: 'A', data: { ip: '10.0.0.1' } },
    ]));
    expect(out).not.toContain('NS');
  });

  it('emits only printable ASCII', () => {
    const out = renderHosts(zone([
      { name: 'nas', type: 'A', data: { ip: '10.0.0.1' }, comment: 'rack' },
    ]));
    for (const line of out.split('\n')) expect(line).not.toMatch(/[^\t -~]/);
  });
});
