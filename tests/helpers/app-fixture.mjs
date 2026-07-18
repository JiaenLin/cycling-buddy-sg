export const TEST_STYLE = {
  version: 8,
  name: 'Deterministic test style',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ede7' } }]
};

export const WEATHER = {
  code: 0,
  data: {
    area_metadata: [
      { name: 'Marina South', label_location: { latitude: 1.28, longitude: 103.86 } },
      { name: 'Bedok', label_location: { latitude: 1.32, longitude: 103.93 } }
    ],
    items: [{
      valid_period: { text: '6:00 PM to 8:00 PM' },
      forecasts: [
        { area: 'Marina South', forecast: 'Thundery Showers' },
        { area: 'Bedok', forecast: 'Fair' }
      ]
    }]
  }
};

export async function openArtifact(page, options = {}) {
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const fixedNow = Date.parse('2026-07-18T10:00:00.000Z');
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...values) { super(...(values.length ? values : [fixedNow])); }
      static now() { return fixedNow; }
    }
    Object.defineProperty(window, 'Date', { configurable: true, value: FixedDate });
    const position = {
      coords: { latitude: 1.30, longitude: 103.85, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: 90, speed: 4 },
      timestamp: fixedNow
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: success => queueMicrotask(() => success(position)),
      watchPosition: success => { queueMicrotask(() => success(position)); return 1; },
      clearWatch() {}
    } });
    class MockDeviceOrientationEvent extends Event {
      constructor(type, init = {}) { super(type); Object.assign(this, { alpha: 90, beta: 0, gamma: 0, absolute: true }, init); }
      static async requestPermission() { return 'granted'; }
    }
    Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: MockDeviceOrientationEvent });
  });
  await page.route('https://tiles.openfreemap.org/styles/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(TEST_STYLE)
  }));
  await page.route('**/*goatcounter*', route => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: 'window.goatcounter = window.goatcounter || { count() {} };'
  }));
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
  await page.route('https://api-open.data.gov.sg/**', route => route.fulfill(options.weatherFailure ? {
    status: 503,
    contentType: 'application/json',
    body: '{"code":503}'
  } : {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(WEATHER)
  }));
  if (options.graphFailure) {
    await page.route('**/data/graph.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  }
  await page.addInitScript(mode => {
    const messages = [];
    const worker = { postMessage: message => messages.push(message) };
    const registration = {
      waiting: ['waiting-update', 'first-install'].includes(mode) ? worker : null,
      installing: null,
      addEventListener() {},
      update: async () => {}
    };
    const listeners = new Map();
    const serviceWorker = {
      controller: mode === 'waiting-update' ? {} : null,
      register: async () => registration,
      addEventListener: (name, listener) => listeners.set(name, listener)
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    window.__swTest = { messages, worker, registration, listeners };
  }, options.serviceWorkerMode || 'current');
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    try {
      return Boolean(map.getLayer('closed-marker'));
    } catch {
      return false;
    }
  });
  return runtimeErrors;
}
