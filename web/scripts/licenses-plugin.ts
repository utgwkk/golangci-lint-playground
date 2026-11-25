// Vite plugin that writes licenses.txt next to the built web app: the license
// of the playground itself, followed by the license files of every npm package
// bundled into the app or its worker.
//
// The build fails if a bundled package has no license file or a license that
// has not been reviewed, so that a new dependency cannot silently ship
// without its notice. (golangci-lint and the other files under v/<version>/
// have their own licenses.txt, written by wasm/build.sh.)

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

interface Package {
  name: string;
  version: string;
  license: string;
  files: { name: string; text: string }[];
}

/** The directory of the npm package that a bundled module belongs to, if any. */
export function packageDir(moduleId: string): string | null {
  const id = moduleId.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const marker = '/node_modules/';
  const i = id.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = id.slice(i + marker.length).split('/');
  const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  return id.slice(0, i + marker.length) + name;
}

function readPackage(dir: string): Package {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string | { type: string };
  };
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? '');
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
  return { name: pkg.name, version: pkg.version, license, files };
}

export interface LicensesOptions {
  /** Text at the top of the file (the playground's own license). */
  header: string;
  fileName?: string;
}

/**
 * Returns the plugin for the main build and a factory for the worker build
 * (workers are bundled separately; they share the list of packages).
 */
export function licenses(options: LicensesOptions): { main: Plugin; worker: () => Plugin } {
  const dirs = new Set<string>();
  const collect = (bundle: Record<string, { type: string; moduleIds?: string[] }>) => {
    for (const chunk of Object.values(bundle)) {
      for (const id of chunk.type === 'chunk' ? (chunk.moduleIds ?? []) : []) {
        const dir = packageDir(id);
        if (dir) dirs.add(dir);
      }
    }
  };

  const main: Plugin = {
    name: 'licenses',
    apply: 'build',
    generateBundle(_opts, bundle) {
      collect(bundle);
      const packages = [...dirs].map(readPackage).sort((a, b) => a.name.localeCompare(b.name));
      const problems: string[] = [];
      for (const p of packages) {
        if (!p.files.length) problems.push(`${p.name}@${p.version}: no license file`);
        const ids = p.license.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/);
        if (!ids.every((id) => ALLOWED.has(id))) problems.push(`${p.name}@${p.version}: license "${p.license}" has not been reviewed`);
      }
      if (problems.length) {
        this.error(`Review the licenses of these bundled packages, then update web/scripts/licenses-plugin.ts:\n  ${problems.join('\n  ')}`);
      }

      const rule = '-'.repeat(78);
      let out = options.header.trimEnd() + '\n\n\nTHIRD-PARTY PACKAGES BUNDLED IN THE WEB APP\n===========================================\n\n';
      for (const p of packages) out += `${p.name.padEnd(40)} ${p.version.padEnd(12)} ${p.license}\n`;
      for (const p of packages) {
        for (const f of p.files) out += `\n${rule}\n${p.name} ${p.version} (${f.name})\n\n${f.text.trimEnd()}\n`;
      }
      this.emitFile({ type: 'asset', fileName: options.fileName ?? 'licenses.txt', source: out });
    },
  };
  const worker = (): Plugin => ({
    name: 'licenses-worker',
    apply: 'build',
    generateBundle: (_opts, bundle) => collect(bundle),
  });
  return { main, worker };
}
