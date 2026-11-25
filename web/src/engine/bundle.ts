// Reader/writer for the bundle format produced by wasm/tools/mkbundle:
// gzip( "GLPB1\n" { u32le len(path) | path | u32le len(data) | data }* )

import type { MemFS } from './gofs';

const MAGIC = 'GLPB1\n';

async function pipe(bytes: Uint8Array, transform: ReadableWritablePair<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompresses gzip data. Data that is not gzip (e.g. already decompressed by the server) is returned as is. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return pipe(bytes, new DecompressionStream('gzip'));
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('gzip'));
}

/** Extracts all files of a (possibly gzip-compressed) bundle into memfs. Returns the number of files. */
export async function loadBundle(memfs: MemFS, compressed: Uint8Array): Promise<number> {
  const bytes = await gunzip(compressed);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('not a GLPB1 bundle');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = MAGIC.length;
  let n = 0;
  while (off < bytes.length) {
    const plen = view.getUint32(off, true);
    off += 4;
    const path = dec.decode(bytes.subarray(off, off + plen));
    off += plen;
    const dlen = view.getUint32(off, true);
    off += 4;
    memfs.writeFile(path, bytes.slice(off, off + dlen));
    off += dlen;
    n++;
  }
  return n;
}

/** Serializes every file under the given directories into an uncompressed bundle. */
export function makeBundle(memfs: MemFS, dirs: string[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [enc.encode(MAGIC)];
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  for (const dir of dirs) {
    const files = [...memfs.walkFiles(dir)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [path, data] of files) {
      const p = enc.encode(path);
      chunks.push(u32(p.length), p, u32(data.length), data.slice());
    }
  }
  return concat(chunks);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
