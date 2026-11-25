// Per-version metadata built by wasm/build.sh: the configuration schema and
// the lists of linters and formatters.

import { assetUrl, type VersionInfo } from '../engine/client';
import type { Schema } from './schema';

export interface ToolInfo {
  name: string;
  description: string;
  /** Linters only: "standard", "fast", "all". */
  groups?: string[];
  fast?: boolean;
  autoFix?: boolean;
  deprecated?: boolean;
  since?: string;
  originalURL?: string;
}

export interface Catalog {
  schema: Schema;
  linters: ToolInfo[];
  formatters: ToolInfo[];
}

export async function fetchCatalog(base: URL, info: VersionInfo): Promise<Catalog> {
  const get = async <T>(name: string): Promise<T> => {
    const res = await fetch(assetUrl(base, info, name));
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.json() as Promise<T>;
  };
  const [schema, linters, formatters] = await Promise.all([
    get<Schema>('schema.json'),
    get<ToolInfo[]>('linters.json'),
    get<ToolInfo[]>('formatters.json'),
  ]);
  return { schema, linters, formatters };
}

/** Description of a linter or formatter name, if it is one. */
export function toolDescription(catalog: Catalog, name: string): ToolInfo | undefined {
  return catalog.linters.find((l) => l.name === name) ?? catalog.formatters.find((f) => f.name === name);
}
