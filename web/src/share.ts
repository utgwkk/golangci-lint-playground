// Sharing via the URL fragment: the snapshot is compressed into "#s=...".
// The fragment is never sent to the server.

export interface Snapshot {
  schema: 1;
  /** golangci-lint version, e.g. "v2.5.0". */
  version: string;
  /** Editor text (Go source or txtar). */
  code: string;
  /** .golangci.yml as written by the user. */
  config: string;
}

const PREFIX = 's=';

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encodeSnapshot(s: Snapshot): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  return PREFIX + toBase64Url(await transform(json, new CompressionStream('deflate-raw')));
}

/** Decodes a URL fragment (with or without "#"). Returns null if it is not a snapshot. */
export async function decodeSnapshot(hash: string): Promise<Snapshot | null> {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith(PREFIX)) return null;
  const json = await transform(fromBase64Url(h.slice(PREFIX.length)), new DecompressionStream('deflate-raw'));
  const s = JSON.parse(new TextDecoder().decode(json)) as Partial<Snapshot>;
  if (s.schema !== 1 || typeof s.code !== 'string' || typeof s.config !== 'string' || typeof s.version !== 'string') {
    throw new Error('unsupported snapshot format');
  }
  return s as Snapshot;
}
