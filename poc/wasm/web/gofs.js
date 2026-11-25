// In-memory filesystem implementing the subset of Node's callback-style `fs`
// API that Go's js/wasm port (syscall/fs_js.go) calls via `globalThis.fs`.
// Works in browsers (incl. Web Workers) and in Node.js.

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Values match Node.js on Linux; Go maps its own O_* flags to these.
const constants = {
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 0o100,
  O_EXCL: 0o200,
  O_TRUNC: 0o1000,
  O_APPEND: 0o2000,
  O_DIRECTORY: 0o200000,
};

function fsError(code, syscall, path) {
  const err = new Error(`${code}: ${syscall} ${path ?? ''}`);
  err.code = code; // must be a key of errnoByCode in syscall/tables_js.go
  return err;
}

class Stats {
  constructor(node) {
    this.dev = 1;
    this.ino = node.ino;
    this.mode = node.mode;
    this.nlink = 1;
    this.uid = 0;
    this.gid = 0;
    this.rdev = 0;
    this.size = node.kind === 'file' ? node.size : node.kind === 'link' ? node.target.length : 4096;
    this.blksize = 4096;
    this.blocks = Math.ceil(this.size / 512);
    this.atimeMs = node.mtimeMs;
    this.mtimeMs = node.mtimeMs;
    this.ctimeMs = node.mtimeMs;
  }
  isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
  isFile() { return (this.mode & S_IFMT) === S_IFREG; }
  isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
}

export class MemFS {
  constructor() {
    this.constants = constants;
    this._ino = 1;
    this.root = this._newNode('dir', 0o755);
    this.fds = new Map();
    this.nextFd = 3;
    this.cwd = '/';
    // Called for writes to fd 1 and 2: (fd, Uint8Array) => void
    this.onOutput = (fd, bytes) => {};
  }

  _newNode(kind, perm) {
    const typeBits = kind === 'dir' ? S_IFDIR : kind === 'link' ? S_IFLNK : S_IFREG;
    const node = { kind, mode: typeBits | (perm & 0o7777), ino: this._ino++, mtimeMs: Date.now() };
    if (kind === 'dir') node.children = new Map();
    if (kind === 'file') { node.data = new Uint8Array(0); node.size = 0; }
    return node;
  }

  _abs(path) {
    if (!path.startsWith('/')) path = this.cwd.replace(/\/$/, '') + '/' + path;
    return path;
  }

  _split(path) {
    const parts = [];
    for (const p of this._abs(path).split('/')) {
      if (p === '' || p === '.') continue;
      if (p === '..') parts.pop(); else parts.push(p);
    }
    return parts;
  }

  // Resolves path to { node, parent, name }. node is undefined if the last
  // component does not exist. Throws ENOENT/ENOTDIR for missing parents.
  _lookup(path, followLast = true, depth = 0) {
    if (depth > 40) throw fsError('ELOOP', 'lookup', path);
    const parts = this._split(path);
    let node = this.root;
    let parent = null;
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== 'dir') throw fsError('ENOTDIR', 'lookup', path);
      parent = node;
      const child = node.children.get(parts[i]);
      const isLast = i === parts.length - 1;
      if (!child) {
        if (isLast) return { node: undefined, parent, name: parts[i] };
        throw fsError('ENOENT', 'lookup', path);
      }
      if (child.kind === 'link' && (!isLast || followLast)) {
        const base = '/' + parts.slice(0, i).join('/');
        const target = child.target.startsWith('/') ? child.target : base + '/' + child.target;
        const rest = parts.slice(i + 1).join('/');
        return this._lookup(rest ? target + '/' + rest : target, followLast, depth + 1);
      }
      node = child;
    }
    return { node, parent, name: parts[parts.length - 1] ?? '' };
  }

  _fd(fd) {
    const f = this.fds.get(fd);
    if (!f) throw fsError('EBADF', 'fd', String(fd));
    return f;
  }

  // Wraps a synchronous implementation into Node's callback convention.
  _cb(callback, fn) {
    let result;
    try {
      result = fn();
    } catch (e) {
      if (!e.code) throw e;
      callback(e);
      return;
    }
    callback(null, result);
  }

  // ---- helpers for JS callers (not used by Go) ----

  mkdirAll(path) {
    let node = this.root;
    for (const p of this._split(path)) {
      let child = node.children.get(p);
      if (!child) {
        child = this._newNode('dir', 0o755);
        node.children.set(p, child);
      }
      node = child;
    }
    return node;
  }

  writeFile(path, data) {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    const parts = this._split(path);
    const dir = this.mkdirAll('/' + parts.slice(0, -1).join('/'));
    const node = this._newNode('file', 0o644);
    node.data = data;
    node.size = data.length;
    dir.children.set(parts[parts.length - 1], node);
  }

  readFile(path) {
    const { node } = this._lookup(path);
    if (!node) throw fsError('ENOENT', 'readFile', path);
    return node.data.subarray(0, node.size);
  }

  removeAll(path) {
    const { node, parent, name } = this._lookup(path, false);
    if (node && parent) parent.children.delete(name);
  }

  // Yields [path, Uint8Array] for every regular file under dir.
  *walkFiles(dir) {
    const { node } = this._lookup(dir);
    if (!node) return;
    const stack = [[dir.replace(/\/$/, ''), node]];
    while (stack.length) {
      const [p, n] = stack.pop();
      if (n.kind === 'file') yield [p, n.data.subarray(0, n.size)];
      else if (n.kind === 'dir') for (const [name, c] of n.children) stack.push([p + '/' + name, c]);
    }
  }

  // ---- Node fs API used by syscall/fs_js.go ----

  open(path, flags, mode, callback) {
    this._cb(callback, () => {
      let { node, parent, name } = this._lookup(path);
      if (!node) {
        if (!(flags & constants.O_CREAT)) throw fsError('ENOENT', 'open', path);
        node = this._newNode('file', mode ?? 0o666);
        parent.children.set(name, node);
      } else if ((flags & constants.O_CREAT) && (flags & constants.O_EXCL)) {
        throw fsError('EEXIST', 'open', path);
      }
      const accmode = flags & 3;
      if (node.kind === 'dir' && accmode !== constants.O_RDONLY) throw fsError('EISDIR', 'open', path);
      if ((flags & constants.O_DIRECTORY) && node.kind !== 'dir') throw fsError('ENOTDIR', 'open', path);
      if ((flags & constants.O_TRUNC) && node.kind === 'file') { node.size = 0; node.mtimeMs = Date.now(); }
      const fd = this.nextFd++;
      this.fds.set(fd, { node, flags, pos: 0 });
      return fd;
    });
  }

  close(fd, callback) {
    this._cb(callback, () => { this._fd(fd); this.fds.delete(fd); });
  }

  read(fd, buffer, offset, length, position, callback) {
    this._cb(callback, () => {
      const f = this._fd(fd);
      if (f.node.kind === 'dir') throw fsError('EISDIR', 'read');
      const pos = position ?? f.pos;
      const n = Math.max(0, Math.min(length, f.node.size - pos));
      buffer.set(f.node.data.subarray(pos, pos + n), offset);
      if (position == null) f.pos += n;
      return n;
    });
  }

  writeSync(fd, buffer) {
    if (fd === 1 || fd === 2) {
      this.onOutput(fd, buffer.slice());
      return buffer.length;
    }
    let n;
    this.write(fd, buffer, 0, buffer.length, null, (err, written) => {
      if (err) throw err;
      n = written;
    });
    return n;
  }

  write(fd, buffer, offset, length, position, callback) {
    if (fd === 1 || fd === 2) {
      this.onOutput(fd, buffer.slice(offset, offset + length));
      callback(null, length);
      return;
    }
    this._cb(callback, () => {
      const f = this._fd(fd);
      if ((f.flags & 3) === constants.O_RDONLY) throw fsError('EBADF', 'write');
      const node = f.node;
      let pos = position ?? ((f.flags & constants.O_APPEND) ? node.size : f.pos);
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

  fstat(fd, callback) { this._cb(callback, () => new Stats(this._fd(fd).node)); }

  stat(path, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path);
      if (!node) throw fsError('ENOENT', 'stat', path);
      return new Stats(node);
    });
  }

  lstat(path, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path, false);
      if (!node) throw fsError('ENOENT', 'lstat', path);
      return new Stats(node);
    });
  }

  readdir(path, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path);
      if (!node) throw fsError('ENOENT', 'readdir', path);
      if (node.kind !== 'dir') throw fsError('ENOTDIR', 'readdir', path);
      return [...node.children.keys()];
    });
  }

  mkdir(path, perm, callback) {
    this._cb(callback, () => {
      const { node, parent, name } = this._lookup(path);
      if (node) throw fsError('EEXIST', 'mkdir', path);
      parent.children.set(name, this._newNode('dir', perm ?? 0o777));
    });
  }

  rmdir(path, callback) {
    this._cb(callback, () => {
      const { node, parent, name } = this._lookup(path, false);
      if (!node) throw fsError('ENOENT', 'rmdir', path);
      if (node.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', path);
      if (node.children.size) throw fsError('ENOTEMPTY', 'rmdir', path);
      parent.children.delete(name);
    });
  }

  unlink(path, callback) {
    this._cb(callback, () => {
      const { node, parent, name } = this._lookup(path, false);
      if (!node) throw fsError('ENOENT', 'unlink', path);
      if (node.kind === 'dir') throw fsError('EISDIR', 'unlink', path);
      parent.children.delete(name);
    });
  }

  rename(from, to, callback) {
    this._cb(callback, () => {
      const src = this._lookup(from, false);
      if (!src.node) throw fsError('ENOENT', 'rename', from);
      const dst = this._lookup(to, false);
      if (dst.node && dst.node.kind === 'dir') {
        if (src.node.kind !== 'dir') throw fsError('EISDIR', 'rename', to);
        if (dst.node.children.size) throw fsError('ENOTEMPTY', 'rename', to);
      }
      src.parent.children.delete(src.name);
      dst.parent.children.set(dst.name, src.node);
    });
  }

  ftruncate(fd, length, callback) {
    this._cb(callback, () => this._truncate(this._fd(fd).node, length));
  }

  truncate(path, length, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path);
      if (!node) throw fsError('ENOENT', 'truncate', path);
      this._truncate(node, length);
    });
  }

  _truncate(node, length) {
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

  fsync(fd, callback) { this._cb(callback, () => { this._fd(fd); }); }

  chmod(path, mode, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path);
      if (!node) throw fsError('ENOENT', 'chmod', path);
      node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
    });
  }

  fchmod(fd, mode, callback) {
    this._cb(callback, () => {
      const node = this._fd(fd).node;
      node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
    });
  }

  chown(path, uid, gid, callback) { this._cb(callback, () => {}); }
  fchown(fd, uid, gid, callback) { this._cb(callback, () => {}); }
  lchown(path, uid, gid, callback) { this._cb(callback, () => {}); }

  utimes(path, atime, mtime, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path);
      if (!node) throw fsError('ENOENT', 'utimes', path);
      node.mtimeMs = mtime * 1000;
    });
  }

  symlink(target, path, callback) {
    this._cb(callback, () => {
      const { node, parent, name } = this._lookup(path, false);
      if (node) throw fsError('EEXIST', 'symlink', path);
      const link = this._newNode('link', 0o777);
      link.target = target;
      parent.children.set(name, link);
    });
  }

  readlink(path, callback) {
    this._cb(callback, () => {
      const { node } = this._lookup(path, false);
      if (!node) throw fsError('ENOENT', 'readlink', path);
      if (node.kind !== 'link') throw fsError('EINVAL', 'readlink', path);
      return node.target;
    });
  }

  link(path, newPath, callback) { callback(fsError('ENOSYS', 'link', path)); }
}
