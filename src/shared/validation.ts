import { z } from 'zod';
import { ValidationError, type FieldErrors } from './errors.js';

type Path = readonly PropertyKey[];

/** Last named segment of the path: ["payments", 0, "amount"] -> "amount" */
function fieldName(path: Path, root: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const segment = path[i];
    if (typeof segment === 'string') return segment;
  }
  return root;
}

function listValues(values: readonly unknown[]): string {
  const quoted = values.map((v) => `'${String(v)}'`);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(', ')} or ${quoted.at(-1) ?? ''}`
    : (quoted[0] ?? '');
}

/**
 * Default messages in the format used by Pagar.me (.NET DataAnnotations), e.g.
 * "The name field is required.", "The field cycles must be greater than or equal to 1".
 * A message set on the schema itself takes precedence over these.
 */
function pagarmeMessage(issue: z.core.$ZodRawIssue, root: string): string {
  const field = fieldName(issue.path ?? [], root);
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined || issue.input === null
        ? `The ${field} field is required.`
        : `The ${field} field is invalid.`;
    case 'invalid_value':
      return `The ${field} field is invalid. Possible values are ${listValues(issue.values)}.`;
    case 'too_small':
      if (issue.origin === 'string') {
        return `The field ${field} must be a string with a minimum length of ${String(issue.minimum)}.`;
      }
      if (issue.origin === 'array') return `The ${field} field is required.`;
      return `The field ${field} must be greater than or equal to ${String(issue.minimum)}`;
    case 'too_big':
      if (issue.origin === 'string') {
        return `The field ${field} must be a string with a maximum length of ${String(issue.maximum)}.`;
      }
      return `The field ${field} must be less than or equal to ${String(issue.maximum)}`;
    default:
      return `The ${field} field is invalid.`;
  }
}

/** ("order", ["payments", 0, "credit_card"]) -> "order.payments[0].credit_card" */
export function formatErrorKey(root: string, path: Path): string {
  let key = root;
  for (const segment of path) {
    if (typeof segment === 'number') key += `[${segment}]`;
    else key += key ? `.${String(segment)}` : String(segment);
  }
  return key;
}

export function toFieldErrors(error: z.ZodError, root: string): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = formatErrorKey(root, issue.path);
    const messages = (errors[key] ??= []);
    if (!messages.includes(issue.message)) messages.push(issue.message);
  }
  return errors;
}

/**
 * Validates a request payload. On failure throws a 422 in the Pagar.me format,
 * with error keys prefixed by `root` (e.g. "customer.name") and the payload echoed in "request".
 */
export function parseRequest<T extends z.ZodType>(schema: T, input: unknown, root: string): z.output<T> {
  const result = schema.safeParse(input ?? {}, { error: (issue) => pagarmeMessage(issue, root) });
  if (!result.success) throw new ValidationError(toFieldErrors(result.error, root), input);
  return result.data;
}
