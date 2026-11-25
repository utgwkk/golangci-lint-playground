// Sample programs and configurations (web/examples/*.txtar).
//
// Format: the first line of the txtar comment is the title, the following
// lines the description; .golangci.yml is the configuration, every other file
// is code. The samples are also part of the parity test (web/scripts/parity.ts).

import { archiveComment, formatTxtar, parseTxtar } from './txtar';

export interface Sample {
  id: string;
  title: string;
  description: string;
  /** Editor text: plain Go for a lone main.go, txtar otherwise. */
  code: string;
  config: string;
}

const raw = import.meta.glob('../examples/*.txtar', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function parseSample(id: string, text: string): Sample {
  const [title = id, ...rest] = archiveComment(text).split('\n');
  const files = parseTxtar(text);
  const config = files.find((f) => f.name === '.golangci.yml')?.content ?? '';
  return {
    id,
    title: title.trim(),
    description: rest.join('\n').trim(),
    code: formatTxtar(files.filter((f) => f.name !== '.golangci.yml')),
    config,
  };
}

export const SAMPLES: Sample[] = Object.entries(raw)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, text]) => parseSample(path.replace(/^.*\/|\.txtar$/g, ''), text));

export const DEFAULT_SAMPLE = SAMPLES[0];
export const DEFAULT_CODE = DEFAULT_SAMPLE.code;
export const DEFAULT_CONFIG = DEFAULT_SAMPLE.config;
