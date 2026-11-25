// Conformance tests: every scenario runs against MemFS and against Node's real
// `fs` (in a temporary directory), and both must behave the same way.
import * as nodefs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { constants as C, MemFS } from '../src/engine/gofs';

type Cb = (err: NodeJS.ErrnoException | null, res?: unknown) => void;
interface FsLike {
  [name: string]: unknown;
}

// Calls a callback-style fs function and returns its result or error code.
function call(fs: FsLike, name: string, ...args: unknown[]): Promise<{ code?: string; res?: unknown }> {
  return new Promise((resolve) => {
    (fs[name] as (...a: unknown[]) => void)(...args, ((err, res) => resolve(err ? { code: err.code } : { res })) as Cb);
  });
}

const root = mkdtempSync(join(tmpdir(), 'gofs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function both(): { name: string; fs: FsLike; dir: string }[] {
  const dir = `/t${n++}`;
  const mem = new MemFS();
  mem.mkdirAll(dir);
  const real = join(root, dir);
  nodefs.mkdirSync(real);
  return [
    { name: 'memfs', fs: mem as unknown as FsLike, dir },
    { name: 'node', fs: nodefs as unknown as FsLike, dir: real },
  ];
}

const O = {
  create: C.O_WRONLY | C.O_CREAT | C.O_TRUNC,
  excl: C.O_WRONLY | C.O_CREAT | C.O_EXCL,
  append: C.O_WRONLY | C.O_APPEND,
  rw: C.O_RDWR,
};
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array, n: number) => new TextDecoder().decode(b.subarray(0, n));

// Runs scenario on both implementations and expects identical observations.
async function conform(scenario: (fs: FsLike, dir: string) => Promise<unknown[]>): Promise<void> {
  const [mem, real] = both();
  const a = await scenario(mem.fs, mem.dir);
  const b = await scenario(real.fs, real.dir);
  expect(a).toEqual(b);
}

describe('MemFS conforms to node:fs', () => {
  it('writes, reads sequentially and at positions', () =>
    conform(async (fs, dir) => {
      const { res: fd } = await call(fs, 'open', `${dir}/a.txt`, O.create, 0o644);
      const w = await call(fs, 'write', fd, bytes('hello world'), 0, 11, null);
      await call(fs, 'close', fd);
      const { res: rfd } = await call(fs, 'open', `${dir}/a.txt`, C.O_RDONLY, 0);
      const buf = new Uint8Array(5);
      const r1 = await call(fs, 'read', rfd, buf, 0, 5, null);
      const s1 = text(buf, r1.res as number);
      const r2 = await call(fs, 'read', rfd, buf, 0, 5, null);
      const s2 = text(buf, r2.res as number);
      const r3 = await call(fs, 'read', rfd, buf, 0, 5, 6);
      const s3 = text(buf, r3.res as number);
      const r4 = await call(fs, 'read', rfd, buf, 0, 5, 100);
      await call(fs, 'close', rfd);
      return [w.res, s1, s2, s3, r4.res];
    }));

  it('appends, truncates and extends files', () =>
    conform(async (fs, dir) => {
      const p = `${dir}/b.txt`;
      let { res: fd } = await call(fs, 'open', p, O.create, 0o644);
      await call(fs, 'write', fd, bytes('abc'), 0, 3, null);
      await call(fs, 'close', fd);
      ({ res: fd } = await call(fs, 'open', p, O.append, 0));
      await call(fs, 'write', fd, bytes('def'), 0, 3, null);
      await call(fs, 'close', fd);
      const size1 = ((await call(fs, 'stat', p)).res as { size: number }).size;
      ({ res: fd } = await call(fs, 'open', p, O.rw, 0));
      await call(fs, 'ftruncate', fd, 8);
      const buf = new Uint8Array(16);
      const r = await call(fs, 'read', fd, buf, 0, 16, 0);
      await call(fs, 'ftruncate', fd, 2);
      const size2 = ((await call(fs, 'fstat', fd)).res as { size: number }).size;
      await call(fs, 'close', fd);
      return [size1, [...buf.subarray(0, r.res as number)], size2];
    }));

  it('reports the same errors', () =>
    conform(async (fs, dir) => {
      const { res: fd } = await call(fs, 'open', `${dir}/f`, O.create, 0o644);
      await call(fs, 'close', fd);
      await call(fs, 'mkdir', `${dir}/d`, 0o755);
      await call(fs, 'open', `${dir}/d/x`, O.create, 0o644).then((r) => call(fs, 'close', r.res));
      return [
        (await call(fs, 'open', `${dir}/missing`, C.O_RDONLY, 0)).code,
        (await call(fs, 'open', `${dir}/f`, O.excl, 0o644)).code,
        (await call(fs, 'open', `${dir}/d`, C.O_WRONLY, 0)).code,
        (await call(fs, 'open', `${dir}/f`, C.O_RDONLY | C.O_DIRECTORY, 0)).code,
        (await call(fs, 'open', `${dir}/missing/x`, O.create, 0o644)).code,
        (await call(fs, 'mkdir', `${dir}/d`, 0o755)).code,
        (await call(fs, 'rmdir', `${dir}/d`)).code,
        (await call(fs, 'rmdir', `${dir}/f`)).code,
        (await call(fs, 'readdir', `${dir}/f`)).code,
        (await call(fs, 'stat', `${dir}/missing`)).code,
        (await call(fs, 'unlink', `${dir}/missing`)).code,
        (await call(fs, 'readlink', `${dir}/f`)).code,
        (await call(fs, 'close', 9999)).code,
      ];
    }));

  it('lists, renames and removes entries', () =>
    conform(async (fs, dir) => {
      for (const name of ['c', 'a', 'b']) await call(fs, 'open', `${dir}/${name}`, O.create, 0o644).then((r) => call(fs, 'close', r.res));
      await call(fs, 'mkdir', `${dir}/sub`, 0o755);
      const list1 = ((await call(fs, 'readdir', dir)).res as string[]).sort();
      await call(fs, 'rename', `${dir}/a`, `${dir}/b`); // replaces b
      await call(fs, 'rename', `${dir}/c`, `${dir}/sub/c`);
      await call(fs, 'unlink', `${dir}/b`);
      const list2 = ((await call(fs, 'readdir', dir)).res as string[]).sort();
      const list3 = ((await call(fs, 'readdir', `${dir}/sub`)).res as string[]).sort();
      const st = (await call(fs, 'stat', `${dir}/sub`)).res as { isDirectory(): boolean; isFile(): boolean };
      return [list1, list2, list3, st.isDirectory(), st.isFile()];
    }));

  it('follows symlinks', () =>
    conform(async (fs, dir) => {
      const { res: fd } = await call(fs, 'open', `${dir}/target`, O.create, 0o644);
      await call(fs, 'write', fd, bytes('xyz'), 0, 3, null);
      await call(fs, 'close', fd);
      await call(fs, 'symlink', 'target', `${dir}/link`);
      const link = (await call(fs, 'readlink', `${dir}/link`)).res;
      const l = (await call(fs, 'lstat', `${dir}/link`)).res as { isSymbolicLink(): boolean };
      const s = (await call(fs, 'stat', `${dir}/link`)).res as { size: number; isFile(): boolean };
      return [link, l.isSymbolicLink(), s.size, s.isFile()];
    }));
});

describe('MemFS', () => {
  it('discards writes to /dev/null', async () => {
    const fs = new MemFS() as unknown as FsLike;
    const { res: fd } = await call(fs, 'open', '/dev/null', C.O_WRONLY, 0);
    expect((await call(fs, 'write', fd, bytes('abc'), 0, 3, null)).res).toBe(3);
    expect(((await call(fs, 'fstat', fd)).res as { size: number }).size).toBe(0);
  });

  it('sends stdout and stderr to onOutput', () => {
    const fs = new MemFS();
    const out: [number, string][] = [];
    fs.onOutput = (fd, b) => out.push([fd, new TextDecoder().decode(b)]);
    fs.writeSync(1, bytes('out'));
    fs.write(2, bytes('xerr'), 1, 3, null, () => {});
    expect(out).toEqual([[1, 'out'], [2, 'err']]);
  });

  it('resolves relative paths against cwd and supports helpers', () => {
    const fs = new MemFS();
    fs.writeFile('/work/a/b.txt', 'hi');
    fs.cwd = '/work';
    expect(new TextDecoder().decode(fs.readFile('a/b.txt'))).toBe('hi');
    expect(fs.exists('/work/a')).toBe(true);
    expect([...fs.walkFiles('/work')].map(([p]) => p)).toEqual(['/work/a/b.txt']);
    fs.removeAll('/work/a');
    fs.removeAll('/nope/x'); // missing parents are fine
    expect(fs.exists('/work/a')).toBe(false);
  });
});
