// Writes <distDir>/versions.json from the built version directories
// (<distDir>/v/<version>/), including the size and SHA-256 of every file.
// The web app puts the hash in the files' URLs, so that rebuilt files are
// never served from a stale cache (see assetUrl in src/engine/client.ts).
//
// usage: tsx scripts/write-versions.ts <distDir>

import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { VersionInfo, VersionsManifest } from '../src/engine/client';

const distDir = resolve(process.argv[2] ?? '');

function semver(v: string): number[] {
  return v.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
}

const versions: VersionInfo[] = [];
for (const name of await readdir(join(distDir, 'v'))) {
  const dir = join(distDir, 'v', name);
  const build = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8')) as { version: string; goVersion: string };
  const files: VersionInfo['files'] = {};
  for (const file of (await readdir(dir)).sort()) {
    const data = await readFile(join(dir, file));
    files[file] = { size: (await stat(join(dir, file))).size, sha256: createHash('sha256').update(data).digest('hex') };
  }
  versions.push({ version: build.version, goVersion: build.goVersion, path: `v/${name}/`, files });
}
versions.sort((a, b) => {
  const [x, y] = [semver(a.version), semver(b.version)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
});
if (!versions.length) throw new Error(`no versions in ${distDir}/v`);

const manifest: VersionsManifest = { default: versions[0].version, versions };
await writeFile(join(distDir, 'versions.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`versions.json: ${versions.map((v) => v.version).join(', ')} (default ${manifest.default})`);
