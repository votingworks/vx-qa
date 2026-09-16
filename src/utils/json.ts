/**
 * JSON parsing helpers
 */

import { z } from 'zod/v4';

const JsonObject = z.record(z.string(), z.unknown());

/** Parses JSON that must be an object, without assuming anything about its fields. */
export function parseJsonObject(text: string): Record<string, unknown> {
  return JsonObject.parse(JSON.parse(text) as unknown);
}

/** Returns the string members of `value` when it is an array, else an empty array. */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * Parses JSON as `T` without checking it. Only for data this tool wrote itself
 * or that a schema validates later; prefer `parseJsonObject` or a zod schema.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `T` is the caller's asserted shape
export function parseJsonAs<T>(
  text: string,
  reviver?: (key: string, value: unknown) => unknown,
): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return JSON.parse(text, reviver) as T;
}
