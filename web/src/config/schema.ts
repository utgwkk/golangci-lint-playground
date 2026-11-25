// A small JSON Schema (draft-07) interpreter for golangci-lint's configuration
// schema: navigation by path (for completion and hover) and validation.
//
// It does not generate code (unlike ajv), so it works under the page's CSP,
// and it only supports the keywords that golangci-lint's schema uses.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Schema {
  $ref?: string;
  type?: string | string[];
  description?: string;
  default?: JsonValue;
  examples?: JsonValue[];
  enum?: JsonValue[];
  const?: JsonValue;
  properties?: Record<string, Schema>;
  patternProperties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  required?: string[];
  items?: Schema | Schema[];
  uniqueItems?: boolean;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  definitions?: Record<string, Schema>;
}

export type Path = (string | number)[];

export interface SchemaIssue {
  path: Path;
  /** The problem is the key itself (e.g. an unknown property), not its value. */
  atKey?: boolean;
  message: string;
}

export interface KeyInfo {
  name: string;
  description?: string;
}

export interface ValueInfo {
  value: JsonValue;
  description?: string;
}

function typeOf(v: JsonValue): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: JsonValue, type: string | string[]): boolean {
  const actual = typeOf(v);
  return [type].flat().some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

function equal(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function regexp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return null;
  }
}

/** Levenshtein distance, for "did you mean" suggestions. */
export function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function suggest(word: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase());
    if (d < bestScore) {
      best = c;
      bestScore = d;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

const fmt = (v: JsonValue) => JSON.stringify(v);

export class SchemaTree {
  constructor(readonly root: Schema) {}

  /** Follows $ref (JSON pointers into the root schema). */
  resolve(schema: Schema, depth = 0): Schema {
    if (!schema.$ref || depth > 32) return schema;
    const ref = schema.$ref;
    if (!ref.startsWith('#/')) return schema;
    let target: unknown = this.root;
    for (const part of ref.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      target = (target as Record<string, unknown> | undefined)?.[key];
    }
    if (!target || typeof target !== 'object') return schema;
    const { $ref: _ref, ...rest } = schema;
    return this.resolve({ ...(target as Schema), ...rest }, depth + 1);
  }

  /** The alternatives a value may match: anyOf/oneOf are expanded, allOf is merged. */
  variants(schema: Schema): Schema[] {
    const s = this.resolve(schema);
    let base: Schema = s;
    if (s.allOf) {
      base = { ...s, allOf: undefined };
      for (const part of s.allOf) {
        const r = this.resolve(part);
        base = {
          ...base,
          ...r,
          properties: { ...base.properties, ...r.properties },
          required: [...(base.required ?? []), ...(r.required ?? [])],
        };
      }
    }
    const alternatives = base.anyOf ?? base.oneOf;
    if (!alternatives) return [base];
    const { anyOf: _a, oneOf: _o, ...common } = base;
    return alternatives.flatMap((alt) => this.variants({ ...common, ...this.resolve(alt) }));
  }

  private childrenOf(schema: Schema, key: string | number): Schema[] {
    const out: Schema[] = [];
    for (const s of this.variants(schema)) {
      if (typeof key === 'number') {
        if (Array.isArray(s.items)) {
          if (s.items[key]) out.push(s.items[key]);
        } else if (s.items) {
          out.push(s.items);
        }
        continue;
      }
      if (s.properties?.[key]) {
        out.push(s.properties[key]);
        continue;
      }
      let matched = false;
      for (const [pattern, sub] of Object.entries(s.patternProperties ?? {})) {
        if (regexp(pattern)?.test(key)) {
          out.push(sub);
          matched = true;
        }
      }
      if (!matched && typeof s.additionalProperties === 'object') out.push(s.additionalProperties);
    }
    return out;
  }

  /** Schemas that apply at a path (empty if the path is not allowed by the schema). */
  at(path: Path): Schema[] {
    let current: Schema[] = [this.root];
    for (const key of path) current = current.flatMap((s) => this.childrenOf(s, key));
    return current;
  }

  description(path: Path): string | undefined {
    for (const s of this.at(path)) {
      for (const v of this.variants(s)) if (v.description) return v.description;
    }
    return undefined;
  }

  /** Property names that may appear in the object at path. */
  keys(path: Path): KeyInfo[] {
    const seen = new Map<string, KeyInfo>();
    for (const s of this.at(path)) {
      for (const v of this.variants(s)) {
        for (const [name, sub] of Object.entries(v.properties ?? {})) {
          if (!seen.has(name)) seen.set(name, { name, description: this.variants(sub).find((x) => x.description)?.description });
        }
      }
    }
    return [...seen.values()];
  }

  /** Suggested values at path: enum and const values, booleans, examples and defaults. */
  values(path: Path): ValueInfo[] {
    const seen = new Map<string, ValueInfo>();
    const add = (value: JsonValue) => {
      if (value !== null && typeof value === 'object') return;
      if (!seen.has(fmt(value))) seen.set(fmt(value), { value });
    };
    for (const s of this.at(path)) {
      for (const v of this.variants(s)) {
        for (const e of v.enum ?? []) add(e);
        if (v.const !== undefined) add(v.const);
        if (v.type && [v.type].flat().includes('boolean')) {
          add(true);
          add(false);
        }
        for (const e of v.examples ?? []) add(e);
        if (v.default !== undefined) add(v.default);
      }
    }
    return [...seen.values()];
  }

  /** Whether the value at path is an object (i.e. a mapping is expected). */
  expectsObject(path: Path): boolean {
    return this.at(path).some((s) => this.variants(s).some((v) => !!v.properties || v.type === 'object'));
  }

  /** Whether the value at path is an array (and only an array). */
  expectsArray(path: Path): boolean {
    const variants = this.at(path).flatMap((s) => this.variants(s));
    return variants.length > 0 && variants.every((v) => v.type === 'array' || (!v.type && !!v.items));
  }

  validate(value: JsonValue): SchemaIssue[] {
    return this.check(value, this.root, []);
  }

  private check(value: JsonValue, schema: Schema, path: Path): SchemaIssue[] {
    const variants = this.variants(schema);
    if (variants.length > 1) {
      // Valid if any alternative matches; otherwise report the closest one.
      let best: SchemaIssue[] | null = null;
      for (const v of variants) {
        const issues = this.checkOne(value, v, path);
        if (!issues.length) return [];
        if (!best || issues.length < best.length) best = issues;
      }
      return best ?? [];
    }
    return this.checkOne(value, variants[0], path);
  }

  private checkOne(value: JsonValue, s: Schema, path: Path): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    if (s.type && !matchesType(value, s.type)) {
      return [{ path, message: `Wrong type: expected ${[s.type].flat().join(' or ')}, got ${typeOf(value)}` }];
    }
    if (s.enum && !s.enum.some((e) => equal(e, value))) {
      const hint = typeof value === 'string' ? suggest(value, s.enum.filter((e): e is string => typeof e === 'string')) : null;
      const choices = s.enum.length <= 8 ? ` (allowed: ${s.enum.map(fmt).join(', ')})` : '';
      return [{ path, message: `Invalid value: ${fmt(value)}${hint ? `. Did you mean ${hint}?` : choices}` }];
    }
    if (s.const !== undefined && !equal(s.const, value)) return [{ path, message: `Must be ${fmt(s.const)}` }];

    if (typeof value === 'string' && s.pattern && !regexp(s.pattern)?.test(value)) {
      issues.push({ path, message: `Does not match the pattern ${s.pattern}` });
    }
    if (typeof value === 'number') {
      if (s.minimum !== undefined && value < s.minimum) issues.push({ path, message: `Must be at least ${s.minimum}` });
      if (s.maximum !== undefined && value > s.maximum) issues.push({ path, message: `Must be at most ${s.maximum}` });
    }
    if (Array.isArray(value)) {
      if (s.uniqueItems) {
        const seen = new Set<string>();
        value.forEach((item, i) => {
          if (seen.has(fmt(item))) issues.push({ path: [...path, i], message: `Duplicate item: ${fmt(item)}` });
          seen.add(fmt(item));
        });
      }
      value.forEach((item, i) => {
        for (const sub of this.childrenOf(s, i)) issues.push(...this.check(item, sub, [...path, i]));
      });
    } else if (value !== null && typeof value === 'object') {
      for (const req of s.required ?? []) {
        if (!(req in value)) issues.push({ path, message: `Missing required key: ${req}` });
      }
      for (const [key, item] of Object.entries(value)) {
        const subs = this.childrenOf(s, key);
        if (!subs.length && s.additionalProperties === false) {
          const hint = suggest(key, Object.keys(s.properties ?? {}));
          issues.push({ path: [...path, key], atKey: true, message: `Unknown key: ${key}${hint ? `. Did you mean ${hint}?` : ''}` });
          continue;
        }
        for (const sub of subs) issues.push(...this.check(item, sub, [...path, key]));
      }
    }
    return issues;
  }
}
