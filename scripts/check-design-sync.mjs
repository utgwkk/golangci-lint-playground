#!/usr/bin/env node
// Checks that the English and Japanese design documents stay in sync:
//   - both have the same heading structure (heading levels, and the section
//     numbers of numbered headings such as "4.2", "A.5", "Phase 3", "Appendix B"),
//   - every in-document link (#anchor) points to an existing heading.
// A section added, removed or renumbered in only one of them fails the check.
//
// Usage: node scripts/check-design-sync.mjs [english.md japanese.md]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [en = `${root}docs/design.md`, ja = `${root}docs/design.ja.md`] = process.argv.slice(2);

/** Headings outside fenced code blocks. */
function headings(text) {
  const out = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}

/** The language-independent key of a heading: its section number, if any. */
function key(text) {
  let m;
  if ((m = /^(\d+(?:\.\d+)*)\.?\s/.exec(text))) return m[1];
  if ((m = /^([A-Z]\.\d+)\s/.exec(text))) return m[1];
  if ((m = /^Phase (\d+)\b/.exec(text))) return `Phase ${m[1]}`;
  if ((m = /^(?:Appendix|付録)\s*([A-Z])\b/.exec(text))) return `Appendix ${m[1]}`;
  return null;
}

/** GitHub's anchor for a heading. */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

function describe(h) {
  return h ? `line ${h.line}: ${'#'.repeat(h.level)} ${h.text}` : '(none)';
}

const errors = [];
const docs = [en, ja].map((path) => {
  const text = readFileSync(path, 'utf8');
  return { path, text, headings: headings(text) };
});

const [a, b] = docs;
const n = Math.max(a.headings.length, b.headings.length);
for (let i = 0; i < n; i++) {
  const x = a.headings[i];
  const y = b.headings[i];
  if (!x || !y || x.level !== y.level || key(x.text) !== key(y.text)) {
    errors.push(`Heading #${i + 1} differs:\n  ${a.path} ${describe(x)}\n  ${b.path} ${describe(y)}`);
    break; // later headings are shifted, so only the first difference is useful
  }
}

for (const doc of docs) {
  const anchors = new Set(doc.headings.map((h) => slug(h.text)));
  for (const m of doc.text.matchAll(/\]\(#([^)\s]+)\)/g)) {
    const anchor = decodeURIComponent(m[1]);
    if (!anchors.has(anchor)) errors.push(`${doc.path}: link to a missing heading: #${anchor}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  console.error('\ndocs/design.md (English) and docs/design.ja.md (Japanese) must be updated together.');
  process.exit(1);
}
console.log(`design.md and design.ja.md are in sync (${a.headings.length} headings)`);
