// Dialog with the licenses of the playground and of golangci-lint, and links
// to the complete source code of the WebAssembly build of golangci-lint
// (golangci-lint is licensed under the GPL-3.0; see wasm/build.sh).

import { assetUrl, type VersionInfo } from '../engine/client';

export const REPO_URL = 'https://github.com/utgwkk/golangci-lint-playground';
export const SOURCE_ARCHIVE = 'golangci-lint-source.tar.gz';
export const VERSION_LICENSES = 'licenses.txt';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function link(href: string | URL, text: string): HTMLAnchorElement {
  return el('a', { href: String(href), target: '_blank', rel: 'noopener noreferrer', textContent: text });
}

export class LicensesDialog {
  private readonly body: HTMLElement;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly base: URL,
  ) {
    dialog.replaceChildren();
    const close = el('button', { type: 'button', className: 'dialog-close', textContent: '×' });
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => dialog.close());
    this.body = el('div', { className: 'tools-body licenses-body' });
    dialog.append(el('div', { className: 'dialog-header' }, el('h2', { textContent: 'Licenses and source code' }), close), this.body);
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // click on the backdrop
    });
  }

  /** Opens the dialog for a golangci-lint version (null while versions.json is loading). */
  open(info: VersionInfo | null): void {
    const b = this.body;
    b.replaceChildren(
      el('h3', { textContent: 'golangci-lint playground' }),
      el('p', {}, 'This web app is open source under the MIT license. Source code: ', link(REPO_URL, REPO_URL)),
      el('p', {}, link(new URL('licenses.txt', this.base), 'Licenses of the web app and the npm packages it bundles')),
    );
    if (info) {
      const archive = info.files[SOURCE_ARCHIVE];
      const items: HTMLElement[] = [];
      if (archive) {
        const mb = (archive.size / 1e6).toFixed(1);
        items.push(el('li', {}, link(assetUrl(this.base, info, SOURCE_ARCHIVE), `Complete source code of this build (tar.gz, ${mb} MB)`)));
      }
      if (info.files[VERSION_LICENSES]) {
        items.push(el('li', {}, link(assetUrl(this.base, info, VERSION_LICENSES), 'Licenses and notices of golangci-lint and its dependencies')));
      }
      b.append(
        el('h3', { textContent: `golangci-lint ${info.version}` }),
        el(
          'p',
          {},
          'golangci-lint is free software licensed under the GNU General Public License version 3. ',
          `The playground runs a WebAssembly build of golangci-lint ${info.version} (built with ${info.goVersion}) `,
          'in your browser. golangci-lint itself is not modified; golang.org/x/tools, one of its dependencies, is patched so that it works without the go command.',
        ),
        el('ul', {}, ...items),
      );
    }
    this.dialog.showModal();
  }
}
