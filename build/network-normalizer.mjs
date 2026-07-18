const LOOP_NAMES = [
  'Northern Explorer Loop',
  'Central Urban Loop',
  'Western Adventure Loop',
  'Southern Ridges Loop',
  'Eastern Coastal Loop',
  'North Eastern Riverine Loop',
  'Urban Central Loop'
];

export const TRANSFORM = Object.freeze({ coordinateDecimals: 5, simplifyToleranceDegrees: 0.00002 });

const round = value => Number(value.toFixed(TRANSFORM.coordinateDecimals));

function perpendicularDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  const dx = end[0] - x;
  const dy = end[1] - y;
  if (dx || dy) {
    const position = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (position > 1) {
      x = end[0];
      y = end[1];
    } else if (position > 0) {
      x += dx * position;
      y += dy * position;
    }
  }
  return Math.hypot(point[0] - x, point[1] - y);
}

export function simplifyLine(points, tolerance = TRANSFORM.simplifyToleranceDegrees) {
  if (points.length < 3) return points;
  let largestDistance = 0;
  let splitAt = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = perpendicularDistance(points[index], points[0], points.at(-1));
    if (distance > largestDistance) {
      largestDistance = distance;
      splitAt = index;
    }
  }
  if (largestDistance <= tolerance) return [points[0], points.at(-1)];
  const left = simplifyLine(points.slice(0, splitAt + 1), tolerance);
  const right = simplifyLine(points.slice(splitAt), tolerance);
  return left.slice(0, -1).concat(right);
}

function sourceLines(feature) {
  if (feature.geometry?.type === 'LineString') return [feature.geometry.coordinates];
  if (feature.geometry?.type === 'MultiLineString') return feature.geometry.coordinates;
  throw new Error(`Unsupported source geometry: ${feature.geometry?.type}`);
}

function normalizedCoordinates(line) {
  if (!Array.isArray(line) || line.length < 2) throw new Error('Source line has fewer than two points');
  return simplifyLine(line).map(point => [round(point[0]), round(point[1])]);
}

function featureCollection(features) {
  return { type: 'FeatureCollection', features };
}

export function normalizePcn(source) {
  const features = [];
  for (const feature of source.features || []) {
    const name = feature.properties?.PCN_LOOP;
    const loop = LOOP_NAMES.indexOf(name);
    if (loop < 0) throw new Error(`Unknown PCN loop: ${name}`);
    for (const line of sourceLines(feature)) {
      features.push({
        type: 'Feature',
        properties: { loop, name, park: feature.properties?.PARK || '' },
        geometry: { type: 'LineString', coordinates: normalizedCoordinates(line) }
      });
    }
  }
  return featureCollection(features);
}

export function normalizeCpn(source) {
  const features = [];
  for (const feature of source.features || []) {
    const candidateArea = feature.properties?.CYL_PATH;
    const area = typeof candidateArea === 'string' && candidateArea.trim()
      ? candidateArea.trim() : 'Unspecified';
    for (const line of sourceLines(feature)) {
      features.push({
        type: 'Feature',
        properties: { area },
        geometry: { type: 'LineString', coordinates: normalizedCoordinates(line) }
      });
    }
  }
  return featureCollection(features);
}

export function normalizeRail(overpass) {
  const relation = (overpass.elements || []).find(element => element.type === 'relation' && element.id === 3871697);
  const memberOrder = new Map((relation?.members || [])
    .filter(member => member.type === 'way')
    .map((member, index) => [member.ref, index]));
  const ways = (overpass.elements || [])
    .filter(element => element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
    .sort((a, b) => (memberOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (memberOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  return featureCollection(ways.map(way => {
    const restricted = ['no', 'private'].includes(way.tags?.access)
      || way.tags?.highway === 'construction'
      || Boolean(way.tags?.construction);
    return {
      type: 'Feature',
      properties: { status: restricted ? 'closed' : 'open' },
      geometry: {
        type: 'LineString',
        coordinates: simplifyLine(way.geometry.map(point => [point.lon, point.lat]), 0.00001)
          .map(point => [Number(point[0].toFixed(6)), Number(point[1].toFixed(6))])
      }
    };
  }));
}

export { LOOP_NAMES };
