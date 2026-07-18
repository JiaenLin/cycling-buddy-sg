import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCpn, normalizePcn, simplifyLine } from '../../build/network-normalizer.mjs';

test('network simplification is deterministic and retains endpoints', () => {
  const line = [[103.8, 1.3], [103.800005, 1.300001], [103.8001, 1.3001]];
  assert.deepEqual(simplifyLine(line), [line[0], line[2]]);
  assert.deepEqual(simplifyLine(line), simplifyLine(structuredClone(line)));
});

test('PCN normalization flattens lines and uses the stable loop contract', () => {
  const source = { features: [{
    properties: { PCN_LOOP: 'Southern Ridges Loop', PARK: 'Example Park' },
    geometry: { type: 'MultiLineString', coordinates: [
      [[103.800001, 1.300001], [103.800099, 1.300099]],
      [[103.81, 1.31], [103.82, 1.32]]
    ] }
  }] };
  const result = normalizePcn(source);
  assert.equal(result.features.length, 2);
  assert.deepEqual(result.features[0].properties,
    { loop: 3, name: 'Southern Ridges Loop', park: 'Example Park' });
  assert.deepEqual(result.features[0].geometry.coordinates, [[103.8, 1.3], [103.8001, 1.3001]]);
});

test('CPN normalization makes a missing upstream area explicit for review', () => {
  const result = normalizeCpn({ features: [{
    properties: {}, geometry: { type: 'LineString', coordinates: [[103.8, 1.3], [103.9, 1.4]] }
  }] });
  assert.equal(result.features[0].properties.area, 'Unspecified');
});
