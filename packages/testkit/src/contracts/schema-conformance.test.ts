import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

function readJson(relativePath: string): unknown {
  const base = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
  const fullPath = path.join(base, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
}

function assertSchemaConformance(schemaPath: string, validFixturePath: string, invalidFixturePath: string): void {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  });
  addFormats(ajv);
  const schema = readJson(schemaPath);
  const validate = ajv.compile(schema);
  const validFixture = readJson(validFixturePath);
  const invalidFixture = readJson(invalidFixturePath);

  expect(validate(validFixture), `Expected valid fixture ${validFixturePath} to pass ${schemaPath}`).toBe(true);
  expect(validate(invalidFixture), `Expected invalid fixture ${invalidFixturePath} to fail ${schemaPath}`).toBe(false);
}

describe('schema conformance', () => {
  it('validates primitive contract fixtures', () => {
    assertSchemaConformance(
      'schemas/primitive.schema.json',
      'packages/testkit/src/fixtures/primitive.valid.json',
      'packages/testkit/src/fixtures/primitive.invalid.json',
    );
  });

  it('validates query contract fixtures', () => {
    assertSchemaConformance(
      'schemas/query.schema.json',
      'packages/testkit/src/fixtures/query.valid.json',
      'packages/testkit/src/fixtures/query.invalid.json',
    );
  });

  it('validates run contract fixtures', () => {
    assertSchemaConformance(
      'schemas/run.schema.json',
      'packages/testkit/src/fixtures/run.valid.json',
      'packages/testkit/src/fixtures/run.invalid.json',
    );
  });

  it('validates policy contract fixtures', () => {
    assertSchemaConformance(
      'schemas/policy.schema.json',
      'packages/testkit/src/fixtures/policy.valid.json',
      'packages/testkit/src/fixtures/policy.invalid.json',
    );
  });

  it('validates dispatch contract fixtures', () => {
    assertSchemaConformance(
      'schemas/dispatch.schema.json',
      'packages/testkit/src/fixtures/dispatch.valid.json',
      'packages/testkit/src/fixtures/dispatch.invalid.json',
    );
  });
});
