import { isNumberOrBoolean, isString } from "@app/types/shared/utils/general";

/**
 * JSON with object keys sorted at every depth, so equal values serialize identically whatever
 * their key order. Returns null when the value has no JSON form (undefined, functions, symbols).
 */
export function stableStringify(value: unknown): string | null {
  const normalizedValue = normalizeForStableStringify(value);
  if (normalizedValue === undefined) {
    return null;
  }

  return JSON.stringify(normalizedValue);
}

function normalizeForStableStringify(value: unknown): unknown {
  if (value === null || isString(value) || isNumberOrBoolean(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForStableStringify(entry));
  }

  if (isPlainObject(value)) {
    const sortedKeys = Object.keys(value).sort();
    const normalizedObject: Record<string, unknown> = {};

    for (const key of sortedKeys) {
      const normalizedProperty = normalizeForStableStringify(value[key]);
      if (normalizedProperty !== undefined) {
        normalizedObject[key] = normalizedProperty;
      }
    }

    return normalizedObject;
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
