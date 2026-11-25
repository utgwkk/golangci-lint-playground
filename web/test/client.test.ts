import { describe, expect, it } from 'vitest';
import { assetUrl, type VersionInfo } from '../src/engine/client';

describe('assetUrl', () => {
  const info: VersionInfo = {
    version: 'v2.15.0',
    goVersion: 'go1.27.4',
    path: 'v/v2.15.0/',
    files: { 'cache.bundle.bin': { size: 1, sha256: '0123456789abcdef0123456789abcdef' } },
  };
  const base = new URL('https://example.com/playground/');

  it('puts the content hash in the URL, so that rebuilt files get a new URL', () => {
    expect(assetUrl(base, info, 'cache.bundle.bin').href).toBe('https://example.com/playground/v/v2.15.0/cache.bundle.bin?v=0123456789abcdef');
  });

  it('leaves files without a known hash unversioned', () => {
    expect(assetUrl(base, info, 'other.json').href).toBe('https://example.com/playground/v/v2.15.0/other.json');
  });
});
