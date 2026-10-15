import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OPENAPI_PATH = fileURLToPath(new URL('../../docs/pagarme/openapi.json', import.meta.url));

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation | undefined> | undefined>;
}
interface OpenApiOperation {
  responses?: Record<string, { content?: Record<string, { examples?: Record<string, { value: unknown }> }> }>;
}

let spec: OpenApiSpec | undefined;

function loadSpec(): OpenApiSpec {
  if (!spec) {
    if (!existsSync(OPENAPI_PATH)) {
      throw new Error(`${OPENAPI_PATH} not found. Run "bash scripts/download_docs.sh" to download the docs.`);
    }
    spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiSpec;
  }
  return spec;
}

/** Response example from the official docs, e.g. officialExample('GET', '/customers/{customer_id}', '404'). */
export function officialExample(method: string, path: string, status: string, name?: string): unknown {
  const operation = loadSpec().paths[path]?.[method.toLowerCase()];
  if (!operation) throw new Error(`No operation ${method} ${path} in openapi.json`);
  const examples = operation.responses?.[status]?.content?.['application/json']?.examples ?? {};
  const example = name ? examples[name] : Object.values(examples)[0];
  if (!example) {
    throw new Error(
      `No example ${name ?? '(first)'} for ${method} ${path} ${status}: ${Object.keys(examples).join(', ')}`,
    );
  }
  return example.value;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface CompareOptions {
  /** Also report keys present in `actual` but absent from `expected`. */
  reportExtra?: boolean;
}

/** Objects whose keys are chosen by the merchant: only their type is compared. */
const FREE_FORM_KEYS = new Set(['metadata']);

/**
 * Structural comparison: every key of `expected` must exist in `actual` with the same JSON type.
 * Values are not compared. `null` in the example accepts any type; arrays are checked via their first element;
 * `metadata` objects are free-form.
 * Returns the list of differences (empty = same shape).
 */
export function compareShape(
  expected: unknown,
  actual: unknown,
  options: CompareOptions = {},
  path = '$',
): string[] {
  if (expected === null) return [];
  if (actual === undefined) return [`missing ${path}`];
  const expectedType = typeOf(expected);
  const actualType = typeOf(actual);
  if (expectedType !== actualType) return [`${path}: expected ${expectedType}, got ${actualType}`];

  if (expectedType === 'array') {
    const [expectedItem] = expected as unknown[];
    const [actualItem] = actual as unknown[];
    return expectedItem === undefined || actualItem === undefined
      ? []
      : compareShape(expectedItem, actualItem, options, `${path}[0]`);
  }

  if (expectedType === 'object') {
    if (FREE_FORM_KEYS.has(path.split('.').at(-1) ?? '')) return [];
    const exp = expected as Record<string, unknown>;
    const act = actual as Record<string, unknown>;
    const diffs = Object.keys(exp).flatMap((key) =>
      compareShape(exp[key], act[key], options, `${path}.${key}`),
    );
    if (options.reportExtra) {
      for (const key of Object.keys(act)) if (!(key in exp)) diffs.push(`extra ${path}.${key}`);
    }
    return diffs;
  }
  return [];
}
