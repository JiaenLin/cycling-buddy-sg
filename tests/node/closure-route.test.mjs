import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const closures = JSON.parse(fs.readFileSync(new URL('../../data/closures.geojson', import.meta.url), 'utf8'));
const route = closures.features.find(feature => feature.properties.kind === 'risk').geometry.coordinates;
const marker = closures.features.find(feature => feature.properties.kind === 'marker').geometry.coordinates;

function distanceToSegment(point, start, end) {
  const longitudeMetres = 111_320 * Math.cos(1.284 * Math.PI / 180);
  const latitudeMetres = 110_540;
  const ax = start[0] * longitudeMetres;
  const ay = start[1] * latitudeMetres;
  const dx = (end[0] - start[0]) * longitudeMetres;
  const dy = (end[1] - start[1]) * latitudeMetres;
  const px = point[0] * longitudeMetres;
  const py = point[1] * latitudeMetres;
  const fraction = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + fraction * dx), py - (ay + fraction * dy));
}

test('closure glow stays between the reviewed shoreline endpoints', () => {
  assert.deepEqual(route[0], [103.87133, 1.28062]);
  assert.deepEqual(route.at(-1), [103.86283, 1.28569]);
  assert.equal(route.length, 12);
});

test('accepted warning marker remains on the shoreline route', () => {
  assert.deepEqual(marker, [103.86549, 1.28473]);
  const nearest = Math.min(...route.slice(1).map((point, index) => distanceToSegment(marker, route[index], point)));
  assert.ok(nearest <= 1.5, `marker is ${nearest.toFixed(2)} metres from route`);
});
