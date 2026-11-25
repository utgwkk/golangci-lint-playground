import { describe, expect, it } from 'vitest';
import { packageDir } from '../scripts/licenses-plugin';

describe('packageDir', () => {
  it('finds the package of a bundled module', () => {
    expect(packageDir('/w/web/node_modules/yaml/dist/index.js')).toBe('/w/web/node_modules/yaml');
    expect(packageDir('/w/web/node_modules/@codemirror/view/dist/index.js')).toBe('/w/web/node_modules/@codemirror/view');
    expect(packageDir('C:\\w\\web\\node_modules\\@lezer\\lr\\dist\\index.js')).toBe('C:/w/web/node_modules/@lezer/lr');
  });

  it('uses the innermost node_modules and ignores queries', () => {
    expect(packageDir('/w/node_modules/a/node_modules/b/index.js?commonjs-proxy')).toBe('/w/node_modules/a/node_modules/b');
    expect(packageDir('\0/w/node_modules/c/index.js')).toBe('/w/node_modules/c');
  });

  it('ignores modules of the app itself', () => {
    expect(packageDir('/w/web/src/main.ts')).toBeNull();
    expect(packageDir('\0vite/preload-helper.js')).toBeNull();
  });
});
