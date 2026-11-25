import { describe, expect, it } from 'vitest';
import { decodeSnapshot, encodeSnapshot, type Snapshot } from '../src/share';

describe('share', () => {
  it('round-trips snapshots through the URL fragment', async () => {
    const s: Snapshot = { schema: 1, version: 'v2.5.0', code: 'package main\n\n// Non-ASCII text survives the round trip: 日本語 ✓\n', config: 'version: "2"\n# comment\n' };
    const hash = await encodeSnapshot(s);
    expect(hash).toMatch(/^s=[A-Za-z0-9_-]+$/);
    expect(await decodeSnapshot('#' + hash)).toEqual(s);
  });

  it('ignores other fragments and rejects unknown formats', async () => {
    expect(await decodeSnapshot('#section')).toBeNull();
    expect(await decodeSnapshot('')).toBeNull();
    await expect(decodeSnapshot('#s=!!!')).rejects.toThrow();
  });
});
