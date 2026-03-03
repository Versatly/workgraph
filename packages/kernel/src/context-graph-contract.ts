import type {
  PrimitiveTypeDefinition,
  Registry,
  WorkgraphLensDescriptor,
} from './types.js';
import {
  CORE_CONTEXT_GRAPH_CONTRACT,
  CORE_CONTEXT_QUERY_FILTER_KEYS,
} from './context-graph-contract-definitions.js';

export * from './context-graph-contract-definitions.js';

export type CoreContextInvariantCode =
  | 'missing-core-primitive'
  | 'core-primitive-not-built-in'
  | 'core-primitive-directory-drift'
  | 'core-required-field-missing'
  | 'core-required-field-not-required'
  | 'relationship-field-missing'
  | 'relationship-field-type-drift'
  | 'relationship-ref-type-drift'
  | 'query-filter-contract-drift'
  | 'lens-contract-drift'
  | 'lens-primitive-missing';

export interface CoreContextInvariantViolation {
  code: CoreContextInvariantCode;
  message: string;
  primitive?: string;
  field?: string;
  relationshipId?: string;
}

export interface CoreContextInvariantReport {
  version: string;
  ok: boolean;
  violations: CoreContextInvariantViolation[];
}

export function evaluateCoreContextGraphInvariants(input: {
  registry: Registry;
  queryFilterKeys?: ReadonlyArray<string>;
  lenses?: ReadonlyArray<WorkgraphLensDescriptor>;
}): CoreContextInvariantReport {
  const violations: CoreContextInvariantViolation[] = [];

  for (const primitiveContract of CORE_CONTEXT_GRAPH_CONTRACT.primitives) {
    const primitive = input.registry.types[primitiveContract.name];
    if (!primitive) {
      violations.push({
        code: 'missing-core-primitive',
        primitive: primitiveContract.name,
        message: `Missing core primitive "${primitiveContract.name}" in registry.`,
      });
      continue;
    }

    if (!primitive.builtIn) {
      violations.push({
        code: 'core-primitive-not-built-in',
        primitive: primitiveContract.name,
        message: `Core primitive "${primitiveContract.name}" must remain built-in.`,
      });
    }

    if (primitive.directory !== primitiveContract.directory) {
      violations.push({
        code: 'core-primitive-directory-drift',
        primitive: primitiveContract.name,
        message: `Core primitive "${primitiveContract.name}" directory drifted. Expected "${primitiveContract.directory}" but got "${primitive.directory}".`,
      });
    }

    verifyRequiredFields(primitive, primitiveContract.requiredFields, violations);
  }

  for (const relationship of CORE_CONTEXT_GRAPH_CONTRACT.relationships) {
    const source = input.registry.types[relationship.from];
    if (!source) continue;
    const field = source.fields[relationship.field];
    if (!field) {
      violations.push({
        code: 'relationship-field-missing',
        primitive: relationship.from,
        field: relationship.field,
        relationshipId: relationship.id,
        message: `Relationship "${relationship.id}" expects field "${relationship.field}" on primitive "${relationship.from}".`,
      });
      continue;
    }
    if (!relationship.expectedFieldTypes.includes(field.type)) {
      violations.push({
        code: 'relationship-field-type-drift',
        primitive: relationship.from,
        field: relationship.field,
        relationshipId: relationship.id,
        message: `Relationship "${relationship.id}" field "${relationship.field}" has type "${field.type}" but expected one of [${relationship.expectedFieldTypes.join(', ')}].`,
      });
      continue;
    }
    if (relationship.expectedRefTypes && field.type === 'ref') {
      const actualRefTypes = normalizeStringList(field.refTypes ?? []);
      const expectedRefTypes = normalizeStringList(relationship.expectedRefTypes);
      const missingRefTypes = expectedRefTypes.filter((typeName) => !actualRefTypes.includes(typeName));
      if (missingRefTypes.length > 0) {
        violations.push({
          code: 'relationship-ref-type-drift',
          primitive: relationship.from,
          field: relationship.field,
          relationshipId: relationship.id,
          message: `Relationship "${relationship.id}" missing refTypes [${missingRefTypes.join(', ')}] on field "${relationship.field}".`,
        });
      }
    }
  }

  if (input.queryFilterKeys) {
    const expected = [...CORE_CONTEXT_QUERY_FILTER_KEYS];
    const actual = [...input.queryFilterKeys];
    if (!isSameStringArray(expected, actual)) {
      violations.push({
        code: 'query-filter-contract-drift',
        message: `Query filter contract drifted. Expected [${expected.join(', ')}] but got [${actual.join(', ')}].`,
      });
    }
  }

  if (input.lenses) {
    const expectedLensIds = CORE_CONTEXT_GRAPH_CONTRACT.lenses.map((lens) => lens.id);
    const actualLensIds = input.lenses.map((lens) => lens.id);
    if (!isSameStringArray(expectedLensIds, actualLensIds)) {
      violations.push({
        code: 'lens-contract-drift',
        message: `Lens contract drifted. Expected [${expectedLensIds.join(', ')}] but got [${actualLensIds.join(', ')}].`,
      });
    }
    for (const lensContract of CORE_CONTEXT_GRAPH_CONTRACT.lenses) {
      for (const primitive of lensContract.primitives) {
        if (input.registry.types[primitive]) continue;
        violations.push({
          code: 'lens-primitive-missing',
          primitive,
          message: `Lens "${lensContract.id}" requires primitive "${primitive}" but it is missing from registry.`,
        });
      }
    }
  }

  return {
    version: CORE_CONTEXT_GRAPH_CONTRACT.version,
    ok: violations.length === 0,
    violations,
  };
}

export function assertCoreContextGraphInvariants(input: {
  registry: Registry;
  queryFilterKeys?: ReadonlyArray<string>;
  lenses?: ReadonlyArray<WorkgraphLensDescriptor>;
}): void {
  const report = evaluateCoreContextGraphInvariants(input);
  if (report.ok) return;
  const summary = report.violations
    .map((violation) => `${violation.code}: ${violation.message}`)
    .join('\n');
  throw new Error(
    [
      `Core context graph contract ${report.version} invariant violations (${report.violations.length}):`,
      summary,
    ].join('\n'),
  );
}

function verifyRequiredFields(
  primitive: PrimitiveTypeDefinition,
  requiredFields: string[],
  violations: CoreContextInvariantViolation[],
): void {
  for (const fieldName of requiredFields) {
    const field = primitive.fields[fieldName];
    if (!field) {
      violations.push({
        code: 'core-required-field-missing',
        primitive: primitive.name,
        field: fieldName,
        message: `Core primitive "${primitive.name}" is missing required field "${fieldName}".`,
      });
      continue;
    }
    if (field.required !== true) {
      violations.push({
        code: 'core-required-field-not-required',
        primitive: primitive.name,
        field: fieldName,
        message: `Core primitive "${primitive.name}" field "${fieldName}" must be required.`,
      });
    }
  }
}

function normalizeStringList(values: ReadonlyArray<string>): string[] {
  return values
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

function isSameStringArray(expected: ReadonlyArray<string>, actual: ReadonlyArray<string>): boolean {
  if (expected.length !== actual.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) return false;
  }
  return true;
}
