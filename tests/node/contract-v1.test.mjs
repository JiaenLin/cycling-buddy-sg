import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Conformance tests for the versioned platform contract (contracts/v1). These pin the
// route-request/route-result semantics the PWA already ships so that a future native or
// outdoor-platform adapter cannot silently drift from them. No external validator is used
// (runtime/dev dependencies are locked); a minimal JSON-Schema-subset checker covers the
// exact keywords the schemas use.

const load = rel => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
const requestSchema = load('contracts/v1/route-request.schema.json');
const resultSchema = load('contracts/v1/route-result.schema.json');
const capabilities = load('contracts/v1/platform-capabilities.json');

function validate(schema, value, root = schema, at = '$') {
  const errors = [];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node?.[key], root);
    return validate(target, value, root, at);
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${at}: expected object`); break; }
      for (const key of schema.required || []) if (!(key in value)) errors.push(`${at}: missing required "${key}"`);
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) if (!(schema.properties && key in schema.properties)) errors.push(`${at}: unexpected property "${key}"`);
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (key in value) errors.push(...validate(sub, value[key], root, `${at}.${key}`));
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${at}: expected array`); break; }
      if (schema.minItems != null && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
      if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
      const prefix = schema.prefixItems || [];
      value.forEach((item, index) => {
        if (index < prefix.length) errors.push(...validate(prefix[index], item, root, `${at}[${index}]`));
        else if (schema.items === false) errors.push(`${at}[${index}]: additional items not allowed`);
        else if (schema.items && typeof schema.items === 'object') errors.push(...validate(schema.items, item, root, `${at}[${index}]`));
      });
      break;
    }
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) { errors.push(`${at}: expected number`); break; }
      if (schema.minimum != null && value < schema.minimum) errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum) errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
      break;
    case 'string':
      if (typeof value !== 'string') errors.push(`${at}: expected string`);
      break;
    default:
      break;
  }
  return errors;
}

test('golden fixtures conform to the v1 schemas', () => {
  assert.deepEqual(validate(requestSchema, load('contracts/v1/fixtures/route-request.valid.json')), []);
  assert.deepEqual(validate(resultSchema, load('contracts/v1/fixtures/route-result.valid.json')), []);
});

test('route request rejects out-of-Singapore coordinates', () => {
  const bad = { contractVersion: 1, start: [104.9, 1.30], end: [103.86, 1.32], profile: 'balanced' };
  assert.ok(validate(requestSchema, bad).some(error => error.includes('maximum')));
});

test('route request enforces the two supported profiles', () => {
  const bad = { contractVersion: 1, start: [103.80, 1.30], end: [103.86, 1.32], profile: 'car' };
  assert.ok(validate(requestSchema, bad).some(error => error.includes('not in enum')));
  assert.deepEqual(requestSchema.properties.profile.enum, ['max-cycling', 'balanced']);
});

test('contracts are closed to unreviewed fields', () => {
  const extra = { contractVersion: 1, start: [103.80, 1.30], end: [103.86, 1.32], profile: 'balanced', avoidHills: true };
  assert.ok(validate(requestSchema, extra).some(error => error.includes('unexpected property')));
  assert.equal(requestSchema.additionalProperties, false);
  assert.equal(resultSchema.additionalProperties, false);
});

test('route result keeps cycling share a 0..1 fraction and warnings text', () => {
  const overShare = { contractVersion: 1, distanceMetres: 100, cyclingShare: 1.5, geometry: [[103.8, 1.3], [103.86, 1.32]], warnings: [] };
  assert.ok(validate(resultSchema, overShare).some(error => error.includes('maximum')));
  const shortGeometry = { contractVersion: 1, distanceMetres: 100, cyclingShare: 0.5, geometry: [[103.8, 1.3]], warnings: [] };
  assert.ok(validate(resultSchema, shortGeometry).some(error => error.includes('fewer than 2 items')));
});

test('the helmet/road warning travels as a result warning string', () => {
  const result = load('contracts/v1/fixtures/route-result.valid.json');
  assert.equal(validate(resultSchema, result).length, 0);
  assert.ok(result.warnings.some(warning => /helmet/i.test(warning)));
});

test('all v1 documents agree on contractVersion 1', () => {
  assert.equal(requestSchema.properties.contractVersion.const, 1);
  assert.equal(resultSchema.properties.contractVersion.const, 1);
  assert.equal(capabilities.contractVersion, 1);
});

test('platform capabilities keep routing semantics portable and versioned', () => {
  assert.ok(capabilities.portableCore.includes('routing cost model'));
  assert.ok(capabilities.portableCore.includes('closure validation'));
  assert.match(capabilities.compatibilityRule, /new contract version/i);
  assert.match(capabilities.privacyBoundary, /on-device/i);
});
