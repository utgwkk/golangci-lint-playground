// Reader/writer for the bundle format produced by tools/mkbundle:
// gzip( "GLPB1\n" { u32le len(path) | path | u32le len(data) | data }* )

const MAGIC = 'GLPB1\n';

async function gunzip(bytes) {
  // Some servers transparently decompress .gz files; accept both.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export { gunzip };

// Extracts all files of a bundle into memfs. Returns the number of files.
export async function loadBundle(memfs, compressed) {
  const bytes = await gunzip(compressed);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error('not a GLPB1 bundle');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = MAGIC.length;
  let n = 0;
  while (off < bytes.length) {
    const plen = view.getUint32(off, true); off += 4;
    const path = dec.decode(bytes.subarray(off, off + plen)); off += plen;
    const dlen = view.getUint32(off, true); off += 4;
    memfs.writeFile(path, bytes.slice(off, off + dlen)); off += dlen;
    n++;
  }
  return n;
}

// Serializes every file under the given directories into an uncompressed bundle.
export function makeBundle(memfs, dirs) {
  const enc = new TextEncoder();
  const chunks = [enc.encode(MAGIC)];
  for (const dir of dirs) {
    for (const [path, data] of memfs.walkFiles(dir)) {
      const p = enc.encode(path);
      const hdr = new DataView(new ArrayBuffer(4));
      hdr.setUint32(0, p.length, true);
      chunks.push(new Uint8Array(hdr.buffer), p);
      const dh = new DataView(new ArrayBuffer(4));
      dh.setUint32(0, data.length, true);
      chunks.push(new Uint8Array(dh.buffer), data.slice());
    }
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
