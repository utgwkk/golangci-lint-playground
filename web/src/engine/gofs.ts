// In-memory filesystem implementing the subset of Node's callback-style `fs`
// API that Go's js/wasm port (syscall/fs_js.go) calls via `globalThis.fs`.
// Works in browsers (incl. Web Workers) and in Node.js.

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Values match Node.js on Linux; Go maps its own O_* flags to these.
export const constants = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  O_TRUNC: 0o1000,
  O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000,
} as const;

type Callback<T = unknown> = (err: FsError | null, result?: T) => void;

export interface FsError extends Error {
  code: string;
}

// code must be a key of errnoByCode in Go's syscall/tables_js.go, or Go panics.
function fsError(code: string, syscall: string, path?: string): FsError {
  const err = new Error(`${code}: ${syscall} ${path ?? ''}`) as FsError;
  err.code = code;
  return err;
}

interface BaseNode {
  mode: number;
  ino: number;
  mtimeMs: number;
}
interface DirNode extends BaseNode {
  kind: 'dir';
  children: Map<string, Node>;
}
interface FileNode extends BaseNode {
  kind: 'file';
  data: Uint8Array;
  size: number;
}
interface LinkNode extends BaseNode {
  kind: 'link';
  target: string;
}
type Node = DirNode | FileNode | LinkNode;

interface OpenFile {
  node: Node;
  flags: number;
  pos: number;
}

export class Stats {
  dev = 1;
  ino: number;
  mode: number;
  nlink = 1;
  uid = 0;
  gid = 0;
  rdev = 0;
  size: number;
  blksize = 4096;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;

  constructor(node: Node) {
    this.ino = node.ino;
    this.mode = node.mode;
    this.size = node.kind === 'file' ? node.size : node.kind === 'link' ? node.target.length : 4096;
    this.blocks = Math.ceil(this.size / 512);
    this.atimeMs = this.mtimeMs = this.ctimeMs = node.mtimeMs;
  }
  isDirectory(): boolean { return (this.mode & S_IFMT) === S_IFDIR; }
  isFile(): boolean { return (this.mode & S_IFMT) === S_IFREG; }
  isSymbolicLink(): boolean { return (this.mode & S_IFMT) === S_IFLNK; }
}

export class MemFS {
  readonly constants = constants;
  cwd = '/';
  /** Called for writes to fd 1 (stdout) and 2 (stderr). */
  onOutput: (fd: number, bytes: Uint8Array) => void = () => {};

  private ino = 1;
  private readonly root: DirNode = this.newDir(0o755);
  private readonly fds = new Map<number, OpenFile>();
  private nextFd = 3;
  /** /dev/null: writes are discarded, reads return EOF. */
  private readonly devNull: FileNode;

  constructor() {
    this.devNull = this.newFile(0o666);
    this.mkdirAll('/dev').children.set('null', this.devNull);
  }

  private newDir(perm: number): DirNode {
    return { kind: 'dir', mode: S_IFDIR | (perm & 0o7777), ino: this.ino++, mtimeMs: Date.now(), children: new Map() };
  }

  private newFile(perm: number, data = new Uint8Array(0)): FileNode {
    return { kind: 'file', mode: S_IFREG | (perm & 0o7777), ino: this.ino++, mtimeMs: Date.now(), data, size: data.length };
  }

  abs(path: string): string {
    return path.startsWith('/') ? path : this.cwd.replace(/\/$/, '') + '/' + path;
  }

  private split(path: string): string[] {
    const parts: string[] = [];
    for (const p of this.abs(path).split('/')) {
      if (p === '' || p === '.') continue;
      if (p === '..') parts.pop();
      else parts.push(p);
    }
    return parts;
  }

  // Resolves path to { node, parent, name }. node is undefined if the last
  // component does not exist. Throws ENOENT/ENOTDIR for missing parents.
  private lookup(path: string, followLast = true, depth = 0): { node?: Node; parent: DirNode | null; name: string } {
    if (depth > 40) throw fsError('ELOOP', 'lookup', path);
    const parts = this.split(path);
    let node: Node = this.root;
    let parent: DirNode | null = null;
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== 'dir') throw fsError('ENOTDIR', 'lookup', path);
      parent = node;
      const child: Node | undefined = node.children.get(parts[i]);
      const isLast = i === parts.length - 1;
      if (!child) {
        if (isLast) return { node: undefined, parent, name: parts[i] };
        throw fsError('ENOENT', 'lookup', path);
      }
      if (child.kind === 'link' && (!isLast || followLast)) {
        const base = '/' + parts.slice(0, i).join('/');
        const target = child.target.startsWith('/') ? child.target : base + '/' + child.target;
        const rest = parts.slice(i + 1).join('/');
        return this.lookup(rest ? target + '/' + rest : target, followLast, depth + 1);
      }
      node = child;
    }
    return { node, parent, name: parts[parts.length - 1] ?? '' };
  }

  private existing(path: string, syscall: string, followLast = true) {
    const r = this.lookup(path, followLast);
    if (!r.node) throw fsError('ENOENT', syscall, path);
    return r as { node: Node; parent: DirNode; name: string };
  }

  private fd(fd: number): OpenFile {
    const f = this.fds.get(fd);
    if (!f) throw fsError('EBADF', 'fd', String(fd));
    return f;
  }

  // Runs a synchronous implementation and reports through Node's callback convention.
  private cb<T>(callback: Callback<T>, fn: () => T): void {
    let result: T;
    try {
      result = fn();
    } catch (e) {
      if (!(e as FsError).code) throw e;
      callback(e as FsError);
      return;
    }
    callback(null, result);
  }

  // ---- helpers for JS callers (not used by Go) ----

  mkdirAll(path: string): DirNode {
    let node: DirNode = this.root;
    for (const p of this.split(path)) {
      let child = node.children.get(p);
      if (!child) {
        child = this.newDir(0o755);
        node.children.set(p, child);
      }
      if (child.kind !== 'dir') throw fsError('ENOTDIR', 'mkdirAll', path);
      node = child;
    }
    return node;
  }

  writeFile(path: string, data: Uint8Array | string): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const parts = this.split(path);
    const dir = this.mkdirAll('/' + parts.slice(0, -1).join('/'));
    dir.children.set(parts[parts.length - 1], this.newFile(0o644, bytes));
  }

  readFile(path: string): Uint8Array {
    const { node } = this.existing(path, 'readFile');
    if (node.kind !== 'file') throw fsError('EISDIR', 'readFile', path);
    return node.data.subarray(0, node.size);
  }

  exists(path: string): boolean {
    try {
      return !!this.lookup(path).node;
    } catch {
      return false;
    }
  }

  removeAll(path: string): void {
    let found;
    try {
      found = this.lookup(path, false);
    } catch (e) {
      const code = (e as FsError).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw e;
    }
    if (found.node && found.parent) found.parent.children.delete(found.name);
  }

  /** Yields [path, data] for every regular file under dir. */
  *walkFiles(dir: string): Generator<[string, Uint8Array]> {
    let start: Node | undefined;
    try {
      start = this.lookup(dir).node;
    } catch {
      return;
    }
    if (!start) return;
    const stack: [string, Node][] = [[dir.replace(/\/$/, ''), start]];
    while (stack.length) {
      const [p, n] = stack.pop()!;
      if (n.kind === 'file') yield [p, n.data.subarray(0, n.size)];
      else if (n.kind === 'dir') for (const [name, c] of n.children) stack.push([p + '/' + name, c]);
    }
  }

  // ---- Node fs API used by syscall/fs_js.go ----

  open(path: string, flags: number, mode: number | undefined, callback: Callback<number>): void {
    this.cb(callback, () => {
      const r = this.lookup(path);
      let node = r.node;
      if (!node) {
        if (!(flags & constants.O_CREAT)) throw fsError('ENOENT', 'open', path);
        node = this.newFile(mode ?? 0o666);
        r.parent!.children.set(r.name, node);
      } else if (flags & constants.O_CREAT && flags & constants.O_EXCL) {
        throw fsError('EEXIST', 'open', path);
      }
      if (node.kind === 'dir' && (flags & 3) !== constants.O_RDONLY) throw fsError('EISDIR', 'open', path);
      if (flags & constants.O_DIRECTORY && node.kind !== 'dir') throw fsError('ENOTDIR', 'open', path);
      if (flags & constants.O_TRUNC && node.kind === 'file') {
        node.size = 0;
        node.mtimeMs = Date.now();
      }
      const fd = this.nextFd++;
      this.fds.set(fd, { node, flags, pos: 0 });
      return fd;
    });
  }

  close(fd: number, callback: Callback): void {
    this.cb(callback, () => {
      this.fd(fd);
      this.fds.delete(fd);
    });
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback<number>): void {
    this.cb(callback, () => {
      const f = this.fd(fd);
      if (f.node.kind !== 'file') throw fsError('EISDIR', 'read');
      const pos = position ?? f.pos;
      const n = Math.max(0, Math.min(length, f.node.size - pos));
      buffer.set(f.node.data.subarray(pos, pos + n), offset);
      if (position == null) f.pos += n;
      return n;
    });
  }

  writeSync(fd: number, buffer: Uint8Array): number {
    let n = 0;
    this.write(fd, buffer, 0, buffer.length, null, (err, written) => {
      if (err) throw err;
      n = written!;
    });
    return n;
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback<number>): void {
    if (fd === 1 || fd === 2) {
      this.onOutput(fd, buffer.slice(offset, offset + length));
      callback(null, length);
      return;
    }
    this.cb(callback, () => {
      const f = this.fd(fd);
      if ((f.flags & 3) === constants.O_RDONLY) throw fsError('EBADF', 'write');
      const node = f.node;
      if (node === this.devNull) return length;
      if (node.kind !== 'file') throw fsError('EISDIR', 'write');
      const pos = position ?? (f.flags & constants.O_APPEND ? node.size : f.pos);
      const end = pos + length;
      if (end > node.data.length) {
        const grown = new Uint8Array(Math.max(end, node.data.length * 2, 1024));
        grown.set(node.data.subarray(0, node.size));
        node.data = grown;
      }
      if (pos > node.size) node.data.fill(0, node.size, pos);
      node.data.set(buffer.subarray(offset, offset + length), pos);
      node.size = Math.max(node.size, end);
      node.mtimeMs = Date.now();
      if (position == null) f.pos = end;
      return length;
    });
  }

  fstat(fd: number, callback: Callback<Stats>): void {
    this.cb(callback, () => new Stats(this.fd(fd).node));
  }

  stat(path: string, callback: Callback<Stats>): void {
    this.cb(callback, () => new Stats(this.existing(path, 'stat').node));
  }

  lstat(path: string, callback: Callback<Stats>): void {
    this.cb(callback, () => new Stats(this.existing(path, 'lstat', false).node));
  }

  readdir(path: string, callback: Callback<string[]>): void {
    this.cb(callback, () => {
      const { node } = this.existing(path, 'readdir');
      if (node.kind !== 'dir') throw fsError('ENOTDIR', 'readdir', path);
      return [...node.children.keys()];
    });
  }

  mkdir(path: string, perm: number | undefined, callback: Callback): void {
    this.cb(callback, () => {
      const r = this.lookup(path);
      if (r.node) throw fsError('EEXIST', 'mkdir', path);
      r.parent!.children.set(r.name, this.newDir(perm ?? 0o777));
    });
  }

  rmdir(path: string, callback: Callback): void {
    this.cb(callback, () => {
      const { node, parent, name } = this.existing(path, 'rmdir', false);
      if (node.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', path);
      if (node.children.size) throw fsError('ENOTEMPTY', 'rmdir', path);
      parent.children.delete(name);
    });
  }

  unlink(path: string, callback: Callback): void {
    this.cb(callback, () => {
      const { node, parent, name } = this.existing(path, 'unlink', false);
      if (node.kind === 'dir') throw fsError('EISDIR', 'unlink', path);
      parent.children.delete(name);
    });
  }

  rename(from: string, to: string, callback: Callback): void {
    this.cb(callback, () => {
      const src = this.existing(from, 'rename', false);
      const dst = this.lookup(to, false);
      if (dst.node?.kind === 'dir') {
        if (src.node.kind !== 'dir') throw fsError('EISDIR', 'rename', to);
        if (dst.node.children.size) throw fsError('ENOTEMPTY', 'rename', to);
      } else if (dst.node && src.node.kind === 'dir') {
        throw fsError('ENOTDIR', 'rename', to);
      }
      src.parent.children.delete(src.name);
      dst.parent!.children.set(dst.name, src.node);
    });
  }

  ftruncate(fd: number, length: number, callback: Callback): void {
    this.cb(callback, () => this.truncateNode(this.fd(fd).node, length));
  }

  truncate(path: string, length: number, callback: Callback): void {
    this.cb(callback, () => this.truncateNode(this.existing(path, 'truncate').node, length));
  }

  private truncateNode(node: Node, length: number): void {
    if (node.kind !== 'file') throw fsError('EINVAL', 'truncate');
    if (length > node.data.length) {
      const grown = new Uint8Array(length);
      grown.set(node.data.subarray(0, node.size));
      node.data = grown;
    } else if (length > node.size) {
      node.data.fill(0, node.size, length);
    }
    node.size = length;
    node.mtimeMs = Date.now();
  }

  fsync(fd: number, callback: Callback): void {
    this.cb(callback, () => void this.fd(fd));
  }

  chmod(path: string, mode: number, callback: Callback): void {
    this.cb(callback, () => {
      const { node } = this.existing(path, 'chmod');
      node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
    });
  }

  fchmod(fd: number, mode: number, callback: Callback): void {
    this.cb(callback, () => {
      const node = this.fd(fd).node;
      node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
    });
  }

  chown(_path: string, _uid: number, _gid: number, callback: Callback): void { callback(null); }
  fchown(_fd: number, _uid: number, _gid: number, callback: Callback): void { callback(null); }
  lchown(_path: string, _uid: number, _gid: number, callback: Callback): void { callback(null); }

  utimes(path: string, _atime: number, mtime: number, callback: Callback): void {
    this.cb(callback, () => {
      this.existing(path, 'utimes').node.mtimeMs = mtime * 1000;
    });
  }

  symlink(target: string, path: string, callback: Callback): void {
    this.cb(callback, () => {
      const r = this.lookup(path, false);
      if (r.node) throw fsError('EEXIST', 'symlink', path);
      r.parent!.children.set(r.name, { kind: 'link', mode: S_IFLNK | 0o777, ino: this.ino++, mtimeMs: Date.now(), target });
    });
  }

  readlink(path: string, callback: Callback<string>): void {
    this.cb(callback, () => {
      const { node } = this.existing(path, 'readlink', false);
      if (node.kind !== 'link') throw fsError('EINVAL', 'readlink', path);
      return node.target;
    });
  }

  link(path: string, _newPath: string, callback: Callback): void {
    callback(fsError('ENOSYS', 'link', path));
  }
}
