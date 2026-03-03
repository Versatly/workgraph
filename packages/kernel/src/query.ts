/**
 * Cross-primitive query and keyword search helpers.
 */

import { listTypes } from './registry.js';
import * as store from './store.js';
import type { PrimitiveInstance, PrimitiveQueryFilters } from './types.js';

export const PRIMITIVE_QUERY_FILTER_KEYS = [
  'type',
  'status',
  'owner',
  'tag',
  'text',
  'pathIncludes',
  'updatedAfter',
  'updatedBefore',
  'createdAfter',
  'createdBefore',
  'limit',
  'offset',
] as const satisfies ReadonlyArray<keyof PrimitiveQueryFilters>;

export function queryPrimitives(
  workspacePath: string,
  filters: PrimitiveQueryFilters = {},
): PrimitiveInstance[] {
  const typeNames = filters.type ? [filters.type] : listTypes(workspacePath).map((type) => type.name);
  const all = typeNames.flatMap((typeName) => store.list(workspacePath, typeName));
  const matched = all.filter((instance) => matchesFilters(instance, filters));
  const offset = Math.max(0, filters.offset ?? 0);
  const limited = filters.limit && filters.limit >= 0
    ? matched.slice(offset, offset + filters.limit)
    : matched.slice(offset);
  return limited;
}

export function keywordSearch(
  workspacePath: string,
  text: string,
  filters: Omit<PrimitiveQueryFilters, 'text'> = {},
): PrimitiveInstance[] {
  return queryPrimitives(workspacePath, {
    ...filters,
    text,
  });
}

function matchesFilters(instance: PrimitiveInstance, filters: PrimitiveQueryFilters): boolean {
  if (filters.status && String(instance.fields.status ?? '') !== filters.status) return false;
  if (filters.owner && String(instance.fields.owner ?? '') !== filters.owner) return false;
  if (filters.tag && !hasTag(instance, filters.tag)) return false;
  if (filters.pathIncludes && !instance.path.includes(filters.pathIncludes)) return false;
  if (filters.updatedAfter && !isDateOnOrAfter(instance.fields.updated, filters.updatedAfter)) return false;
  if (filters.updatedBefore && !isDateOnOrBefore(instance.fields.updated, filters.updatedBefore)) return false;
  if (filters.createdAfter && !isDateOnOrAfter(instance.fields.created, filters.createdAfter)) return false;
  if (filters.createdBefore && !isDateOnOrBefore(instance.fields.created, filters.createdBefore)) return false;
  if (filters.text && !containsText(instance, filters.text)) return false;
  return true;
}

function hasTag(instance: PrimitiveInstance, tag: string): boolean {
  const tags = instance.fields.tags;
  if (!Array.isArray(tags)) return false;
  return tags.map((value) => String(value)).includes(tag);
}

function containsText(instance: PrimitiveInstance, text: string): boolean {
  const haystack = [
    instance.path,
    instance.type,
    stringifyFields(instance.fields),
    instance.body,
  ].join('\n').toLowerCase();
  return haystack.includes(text.toLowerCase());
}

function stringifyFields(fields: Record<string, unknown>): string {
  try {
    return JSON.stringify(fields);
  } catch {
    return '';
  }
}

function isDateOnOrAfter(value: unknown, thresholdIso: string): boolean {
  const ts = Date.parse(String(value ?? ''));
  const threshold = Date.parse(thresholdIso);
  if (!Number.isFinite(ts) || !Number.isFinite(threshold)) return false;
  return ts >= threshold;
}

function isDateOnOrBefore(value: unknown, thresholdIso: string): boolean {
  const ts = Date.parse(String(value ?? ''));
  const threshold = Date.parse(thresholdIso);
  if (!Number.isFinite(ts) || !Number.isFinite(threshold)) return false;
  return ts <= threshold;
}
