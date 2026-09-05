import { describe, expect, it } from 'vitest';
import { normalizeEtag } from '../src/index.js';

describe('normalizeEtag', () => {
  it('strips quotes', () => {
    expect(normalizeEtag('"abc123"')).toBe('abc123');
  });

  // The bug this exists to prevent: Cloudflare rewrites a strong ETag to a
  // weak one when it compresses, so a browser sends back W/"..." and every
  // edit was rejected with a spurious 409.
  it('strips the weak-validator prefix the edge adds when compressing', () => {
    expect(normalizeEtag('W/"abc123"')).toBe('abc123');
    expect(normalizeEtag('w/"abc123"')).toBe('abc123');
  });

  it('treats weak and strong forms of the same tag as equal', () => {
    expect(normalizeEtag('W/"abc123"')).toBe(normalizeEtag('"abc123"'));
    expect(normalizeEtag('abc123')).toBe(normalizeEtag('W/"abc123"'));
  });

  it('still distinguishes genuinely different tags', () => {
    expect(normalizeEtag('W/"abc123"')).not.toBe(normalizeEtag('"def456"'));
  });

  it('returns null for absent or empty values', () => {
    expect(normalizeEtag(null)).toBeNull();
    expect(normalizeEtag('')).toBeNull();
    expect(normalizeEtag('  ')).toBeNull();
    expect(normalizeEtag('""')).toBeNull();
  });
});
