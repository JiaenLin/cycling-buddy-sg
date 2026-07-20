import { expect, test } from '@playwright/test';
import { openArtifact, TEST_STYLE } from '../helpers/app-fixture.mjs';

// The feedback page is a separate document; set up the same deterministic basemap and open it.
async function openFeedback(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('https://tiles.openfreemap.org/styles/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TEST_STYLE) }));
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
  await page.goto('/feedback.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { try { return Boolean(map.getSource('draw')); } catch { return false; } });
  return errors;
}

test('loads all critical layers, supports visibility controls, and restores them after a theme change', async ({ page }) => {
  const errors = await openArtifact(page);
  const requiredLayers = [
    'parks-fill', 'cpn-line', 'rail-open', 'pcn-line', 'risk-glow', 'closed-marker',
    'route-line', 'track-line', 'wx-zone-fill', 'racks-pt'
  ];
  await expect.poll(() => page.evaluate(ids => ids.every(id => Boolean(map.getLayer(id))), requiredLayers)).toBe(true);

  const cyclingToggle = page.getByRole('button', { name: 'Toggle Cycling paths' });
  if (await page.locator('#legend').evaluate(element => element.classList.contains('collapsed'))) {
    await page.locator('#lgHead').click();
  }
  await expect(cyclingToggle).toBeVisible();
  await cyclingToggle.click();
  await expect.poll(() => page.evaluate(() => map.getLayoutProperty('cpn-line', 'visibility'))).toBe('none');

  await page.getByRole('button', { name: 'Switch light or dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => page.evaluate(ids => ids.every(id => Boolean(map.getLayer(id))), requiredLayers)).toBe(true);
  await expect.poll(() => page.evaluate(() => map.getLayoutProperty('cpn-line', 'visibility'))).toBe('none');
  expect(errors).toEqual([]);
});

test('shows deterministic weather and fails closed when the live API is unavailable', async ({ page, browser }) => {
  const errors = await openArtifact(page);
  await page.evaluate(() => loadWeather(true));
  await expect(page.locator('#wxRow')).toBeVisible();
  await expect(page.locator('#wxMain')).toHaveText('Thundery Showers');
  await expect(page.locator('#wxAdv')).toContainText('lightning risk');
  expect(errors).toEqual([]);

  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme: 'light' });
  const failurePage = await context.newPage();
  const failureResponses = [];
  failurePage.on('response', response => {
    if (response.url().startsWith('https://api-open.data.gov.sg/')) {
      failureResponses.push(response.status());
    }
  });
  await openArtifact(failurePage, { weatherFailure: true });
  await failurePage.evaluate(() => loadWeather(true));
  await expect(failurePage.locator('#wxRow')).toBeHidden();
  await expect(failurePage.locator('#wxAdv')).toHaveAttribute('hidden', '');
  await expect(failurePage.locator('#wxAdv')).toHaveText('');
  expect(failureResponses).toContain(503);
  await context.close();
});

test('plans a fixed route, exposes the road warning, and reports missing routing data', async ({ page, browser }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => {
    handleRouteClick([103.7859, 1.4370]);
    handleRouteClick([103.9040, 1.4043]);
  });
  await expect(page.locator('#rtOptions')).toBeVisible();
  await expect(page.locator('#rtOptions .rt-rec')).toHaveCount(1);
  await expect(page.locator('#rtOptions .rt-rec-eyebrow')).toContainText('Recommended');
  await expect(page.locator('#rtDirs')).toBeVisible();
  await expect(page.locator('#rtDirs .rt-step').last()).toContainText('Arrive at destination');
  await expect(page.locator('#rtNotice')).toBeVisible();
  await expect(page.locator('#rtNotice')).toContainText('Uses roads');
  expect(errors).toEqual([]);

  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme: 'light' });
  const failurePage = await context.newPage();
  const failureResponses = [];
  failurePage.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('/data/graph.json')) {
      failureResponses.push(response.status());
    }
  });
  await openArtifact(failurePage, { graphFailure: true });
  await failurePage.getByRole('button', { name: 'Plan a route' }).click();
  await expect(failurePage.locator('#toast')).toContainText('Routing data isn’t available yet');
  expect(failureResponses).toContain(503);
  await context.close();
});

test('keeps a planned route through stray taps and drag-edits, clears on Clear and on exit', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => {
    handleRouteClick([103.7859, 1.4370]);
    handleRouteClick([103.9040, 1.4043]);
  });
  await expect(page.locator('#rtOptions')).toBeVisible();
  const planned = await page.evaluate(() => routeResult && routeResult.meters);
  expect(planned).toBeGreaterThan(0);

  // 1. A stray tap on the map must not wipe the planned route.
  await page.evaluate(() => onMapClick({ lngLat: { lng: 103.8500, lat: 1.4200 }, point: map.project([103.8500, 1.4200]) }));
  await expect(page.locator('#rtOptions')).toBeVisible();
  expect(await page.evaluate(() => routeResult && routeResult.meters)).toBe(planned);

  // 2. Dragging the destination marker recomputes in place; the route never disappears.
  await page.evaluate(() => { mkEnd.setLngLat([103.8730, 1.4180]); mkEnd.fire('dragend'); });
  await expect.poll(() => page.evaluate(() => routeEnd && Math.abs(routeEnd[0] - 103.8730) < 1e-6)).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(routeResult) && routeResult.meters > 0)).toBe(true);
  await expect(page.locator('#rtOptions')).toBeVisible();

  // 3. Clear route resets the plan while the planner stays open.
  await page.getByRole('button', { name: 'Clear route' }).click();
  expect(await page.evaluate(() => routeResult)).toBeNull();
  await expect.poll(() => page.evaluate(() => map.querySourceFeatures('route').length)).toBe(0);

  // 4. Toggling the planner off wipes the route and returns to the map (v26: "off" = clean map).
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
  await page.getByRole('button', { name: 'Exit route planning' }).click();
  expect(await page.evaluate(() => routeResult)).toBeNull();
  await expect.poll(() => page.evaluate(() => map.querySourceFeatures('route').length)).toBe(0);
  expect(errors).toEqual([]);
});

test('hides route controls until a route exists and reports no nearby path for far taps', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  // The action bar, Clear, GPX, the road notice and the route options must not leak before a route exists.
  for (const id of ['#rtActionBar', '#rtClrBtn', '#rtGpxBtn', '#rtNotice', '#rtOptions'])
    await expect(page.locator(id)).toBeHidden();
  // A tap far from any routable path reports no nearby path, not a misleading route.
  await page.evaluate(() => { handleRouteClick([103.8000, 1.3000]); handleRouteClick([104.6000, 1.2000]); });
  await expect(page.locator('#toast')).toContainText('No cycling path near there', { timeout: 40000 });
  expect(errors).toEqual([]);
});

test('navigation overview reveals route direction arrows on demand', async ({ page }) => {
  const errors = await openArtifact(page);
  await expect.poll(() => page.evaluate(() => Boolean(map.getLayer('route-arrows')))).toBe(true);
  await expect.poll(() => page.evaluate(() => map.getLayoutProperty('route-arrows', 'visibility'))).toBe('none');
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
  await page.evaluate(() => setNavArrows(true));
  await expect.poll(() => page.evaluate(() => map.getLayoutProperty('route-arrows', 'visibility'))).toBe('visible');
  await page.evaluate(() => setNavArrows(false));
  await expect.poll(() => page.evaluate(() => map.getLayoutProperty('route-arrows', 'visibility'))).toBe('none');
  expect(errors).toEqual([]);
});

test('records location updates and generates a local GPX file', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.waitForFunction(() => document.querySelectorAll('#lgBody .lrow').length >= 7);
  const gpx = await page.evaluate(() => {
    setLocActive(true);
    startRec();
    onPos({ coords: { latitude: 1.3000, longitude: 103.8000, accuracy: 5, heading: 90, speed: 4 }, timestamp: 1_000 });
    onPos({ coords: { latitude: 1.3001, longitude: 103.8001, accuracy: 5, heading: 90, speed: 4 }, timestamp: 2_000 });
    stopRec();
    return buildGPX();
  });
  await expect(page.locator('#viewSum')).toBeVisible();
  await expect(page.locator('#sumDist')).not.toHaveText('0.00');
  expect(gpx).toContain('<gpx version="1.1"');
  expect(gpx.match(/<trkpt /g)).toHaveLength(2);
  expect(gpx).toContain('lat="1.300100" lon="103.800100"');
  expect(errors).toEqual([]);
});

test('live navigation guides along a route and reroutes when off it', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
  // start nav and feed a position on the route -> the guidance banner appears
  await page.evaluate(() => {
    setLocActive(true); startNav();
    const c = routeResult.coords[Math.floor(routeResult.coords.length / 3)];
    onPos({ coords: { latitude: c[1], longitude: c[0], accuracy: 5, speed: 4 }, timestamp: 1_000 });
  });
  await expect(page.locator('#navBanner')).toBeVisible();
  // feed positions well off the route -> after a few, it reroutes from the current position
  await page.evaluate(async () => {
    await ensureGraph();
    for (let k = 0; k < 4; k++) onPos({ coords: { latitude: 1.3200, longitude: 103.8300, accuracy: 5, speed: 4 }, timestamp: 2_000 + k });
  });
  await expect.poll(() => page.evaluate(() => Math.abs(routeStart[0] - 103.83) < 0.02)).toBe(true);
  await page.evaluate(() => stopNav());
  await expect(page.locator('#navBanner')).toBeHidden();
  expect(errors).toEqual([]);
});

test('offline POI search sets a route destination by name', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.waitForFunction(() => Array.isArray(POI) && POI.length > 50);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  const q = await page.evaluate(() => POI[0].name.slice(0, 4).toLowerCase());
  await page.fill('#rtSearch', q);
  await expect(page.locator('#rtResults .rt-result').first()).toBeVisible();
  await page.evaluate(() => handleRouteClick([103.8000, 1.3000]));  // set start by tap
  await page.locator('#rtResults .rt-result').first().click();       // pick a park as destination
  await expect.poll(() => page.evaluate(() => Boolean(routeEnd))).toBe(true);
  expect(errors).toEqual([]);
});

test('offline postcode search resolves a Singapore postcode to a destination', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  // the postcode index lazy-loads when the planner opens
  await page.waitForFunction(() => typeof POSTCODES !== 'undefined' && POSTCODES && POSTCODES.size > 1000);
  const pc = await page.evaluate(() => [...POSTCODES.keys()][0]);
  await page.fill('#rtSearch', pc);
  await expect(page.locator('#rtResults .rt-result').first()).toContainText(pc);
  await page.evaluate(() => handleRouteClick([103.8000, 1.3000]));  // set start by tap
  await page.locator('#rtResults .rt-result').first().click();       // postcode as destination
  await expect.poll(() => page.evaluate(() => Boolean(routeEnd))).toBe(true);
  // an unknown 6-digit code fails gracefully, it does not invent a destination
  await page.fill('#rtSearch', '000000');
  await expect(page.locator('#rtResults .rt-noresult')).toBeVisible();
  expect(errors).toEqual([]);
});

test('offers a recommended route plus labelled, expandable alternatives, and swaps endpoints', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect(page.locator('#rtOptions .rt-rec-eyebrow')).toContainText('Best coverage');
  // alternatives start collapsed (the #rtAltList carries the hidden attribute) and expand on tap
  const toggle = page.getByRole('button', { name: /View \d+ alternative/ });
  await expect(toggle).toBeVisible();
  await expect(page.locator('#rtAltList')).toBeHidden();
  await toggle.click();
  await expect(page.locator('#rtAltList .rt-alt').first()).toBeVisible();
  // and fold back away on a second tap (regression: CSS [hidden] must beat display:flex)
  await toggle.click();
  await expect(page.locator('#rtAltList')).toBeHidden();
  await toggle.click();
  // choosing an alternative changes the active route
  const before = await page.evaluate(() => routeSel);
  await page.locator('#rtAltList .rt-alt').first().click();
  await expect.poll(() => page.evaluate(() => routeSel)).not.toBe(before);
  // swap flips start and destination and re-routes in place
  const startLng = await page.evaluate(() => routeStart[0]);
  await page.getByRole('button', { name: 'Swap start and destination' }).click();
  await expect.poll(() => page.evaluate((s) => Math.abs(routeStart[0] - s) > 1e-9, startLng)).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(routeResult) && routeResult.meters > 0)).toBe(true);
  expect(errors).toEqual([]);
});

test('saved chips re-resolve a name reference to a destination and render stored names as text, never HTML', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.waitForFunction(() => Array.isArray(POI) && POI.length > 50);
  // Saved entries store a re-resolvable reference (name + kind + key), never coordinates.
  const rv = await page.evaluate(() => POI[0].name);
  await page.evaluate((rv) => localStorage.setItem('cbsg.saved',
    JSON.stringify([{ name: '<img src=x onerror=alert(1)>' + rv, rk: 'poi', rv }])), rv);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  const chip = page.locator('#rtChips .rt-chip').first();
  await expect(chip).toBeVisible();
  // the stored name is inserted as text (textContent), so no element is parsed out of it
  await expect(page.locator('#rtChips img')).toHaveCount(0);
  await expect(chip.locator('.t')).toContainText(rv);
  await chip.click();   // re-resolves the reference to coordinates and sets the destination
  await expect.poll(() => page.evaluate(() => Boolean(routeEnd))).toBe(true);
  expect(errors).toEqual([]);
});

test('the heading arrow mirrors the location dot: stays in background, hides when the dot is removed', async ({ page }) => {
  const errors = await openArtifact(page);
  // Stand in for the GeolocateControl dot marker; the arrow follows its DOM presence.
  await page.evaluate(() => {
    const dot = document.createElement('div');
    dot.className = 'maplibregl-user-location-dot';
    document.getElementById('map').appendChild(dot);
    dotEl = dot;                                   // prime the cached lookup
    user = { lat: 1.30, lng: 103.80, acc: 8, speed: 0, heading: null };
    deviceHeading = 90; deviceHeadingTs = performance.now();
    updateUserArrow();
  });
  await expect.poll(() => page.evaluate(() => userArrowEl && userArrowEl.style.display !== 'none')).toBe(true);
  // Background transition keeps the dot on the map (only active-lock ends) → the arrow must stay (item 1).
  await page.evaluate(() => { setLocActive(false); updateUserArrow(); });
  await expect.poll(() => page.evaluate(() => userArrowEl && userArrowEl.style.display !== 'none')).toBe(true);
  // Turning location off removes the dot marker → the arrow hides with it (item 4).
  await page.evaluate(() => { document.querySelector('.maplibregl-user-location-dot').remove(); updateUserArrow(); });
  await expect.poll(() => page.evaluate(() => userArrowEl && userArrowEl.style.display === 'none')).toBe(true);
  expect(errors).toEqual([]);
});

test('opening the planner does not auto-focus a field (no keyboard pop over the UI)', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await expect(page.locator('#rtFromRow')).toHaveClass(/glow/);   // glow guides instead of auto-focus
  const focusedId = await page.evaluate(() => document.activeElement && document.activeElement.id);
  expect(focusedId).not.toBe('rtFromSearch');
  expect(focusedId).not.toBe('rtSearch');
  expect(errors).toEqual([]);
});

test('the first ⌖ tap sets the start as soon as the location fix lands (no second tap)', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { user = null; geo.trigger = () => true; });   // no fix yet; stub the real geolocation request
  await page.getByRole('button', { name: 'Use my current location as the start' }).click();
  await expect.poll(() => page.evaluate(() => pendingStartLoc)).toBe(true);
  expect(await page.evaluate(() => Boolean(routeStart))).toBe(false);       // armed, not yet set
  await page.evaluate(() => onPos({ coords: { latitude: 1.305, longitude: 103.82, accuracy: 8, speed: 0, heading: null }, timestamp: Date.now() }));
  await expect.poll(() => page.evaluate(() => Boolean(routeStart))).toBe(true);   // set automatically on the fix
  await expect.poll(() => page.evaluate(() => pendingStartLoc)).toBe(false);
  expect(errors).toEqual([]);
});

test('planner search inputs are ≥16px so iOS Safari does not zoom on focus', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  for (const id of ['#rtFromSearch', '#rtSearch']) {
    const size = await page.locator(id).evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  }
  expect(errors).toEqual([]);
});

test('GO folds the planner and turns the heading arrow on', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.evaluate(() => {
    window.__oriStarted = false;
    startOrientation = () => { window.__oriStarted = true; };
    requestOrientation = () => Promise.resolve(true);
    geo.trigger = () => {};
  });
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
  await page.getByRole('button', { name: 'GO', exact: true }).click();
  await expect(page.locator('#dock')).toHaveClass(/collapsed/);            // planner folds to a peek
  await expect.poll(() => page.evaluate(() => navActive)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__oriStarted)).toBe(true);   // heading arrow armed on GO
  expect(errors).toEqual([]);
});

test('the planner guides start→destination: the active field glows and From accepts search', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.waitForFunction(() => Array.isArray(POI) && POI.length > 50);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  // start is unset → From glows, destination waits (dimmed)
  await expect(page.locator('#rtFromRow')).toHaveClass(/glow/);
  await expect(page.locator('#rtToRow')).toHaveClass(/await/);
  // set the start by searching in the From field (search + tap + ⌖ all set the start)
  const park = await page.evaluate(() => POI.find(p => p.kind === 'park').name);
  await page.fill('#rtFromSearch', park.slice(0, 5).toLowerCase());
  await page.locator('#rtFromResults .rt-result').first().click();
  await expect.poll(() => page.evaluate(() => Boolean(routeStart))).toBe(true);
  // the glow moves to the now-active destination field
  await expect(page.locator('#rtFromRow')).not.toHaveClass(/glow/);
  await expect(page.locator('#rtToRow')).toHaveClass(/glow/);
  await expect(page.locator('#rtToRow')).not.toHaveClass(/await/);
  expect(errors).toEqual([]);
});

test('search includes MRT/LRT stations and labels the result scope', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.waitForFunction(() => Array.isArray(POI) && POI.some(p => p.kind === 'mrt'));
  await page.getByRole('button', { name: 'Plan a route' }).click();
  const station = await page.evaluate(() => POI.find(p => p.kind === 'mrt').name); // e.g. "Admiralty MRT"
  await page.fill('#rtSearch', station.replace(/ MRT$/, '').slice(0, 6).toLowerCase());
  const row = page.locator('#rtResults .rt-result', { hasText: 'MRT' }).first();
  await expect(row).toBeVisible();
  await expect(row.locator('.rk')).toContainText('MRT');
  await row.click();
  await expect.poll(() => page.evaluate(() => Boolean(routeEnd) && /MRT$/.test(routeEndName))).toBe(true);
  expect(errors).toEqual([]);
});

test('saving a searched destination persists a coordinate-free reference (fixes silent no-op save)', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.waitForFunction(() => Array.isArray(POI) && POI.length > 50);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => handleRouteClick([103.8000, 1.3000]));  // set start by tap
  const name = await page.evaluate(() => POI.find(p => p.kind === 'park').name);
  await page.fill('#rtSearch', name.slice(0, 5).toLowerCase());
  await page.locator('#rtResults .rt-result').first().click();
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
  await page.getByRole('button', { name: 'More route actions' }).click();
  await page.getByRole('menuitem', { name: 'Save destination' }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cbsg.saved') || '[]'));
  expect(saved.length).toBeGreaterThan(0);         // before the fix, savePlace bailed on the nameless ref and saved nothing
  expect(typeof saved[0].name).toBe('string');
  expect(saved[0].name.length).toBeGreaterThan(0);
  expect(saved[0].rk).toBeTruthy();
  expect('lat' in saved[0] || 'lng' in saved[0]).toBe(false);   // never persist coordinates (CodeQL clear-text-storage)
  expect(errors).toEqual([]);
});

test('adds the OSM rideable gap-fill layer, matching and toggling with the cycling paths', async ({ page }) => {
  const errors = await openArtifact(page);
  await expect.poll(() => page.evaluate(() => Boolean(map.getLayer('rideable-line') && map.getLayer('rideable-casing')))).toBe(true);
  // the supplemental data file ships the missing rideable paths
  const n = await page.evaluate(async () => (await (await fetch('data/rideable.lines.geojson')).json()).features.length);
  expect(n).toBeGreaterThan(500);
  // rendered in the same colour as the LTA cycling paths, and visible by default
  const [rideCol, cpnCol] = await page.evaluate(() => [map.getPaintProperty('rideable-line', 'line-color'), map.getPaintProperty('cpn-line', 'line-color')]);
  expect(rideCol).toEqual(cpnCol);
  expect(await page.evaluate(() => map.getLayoutProperty('rideable-line', 'visibility') ?? 'visible')).not.toBe('none');
  // the single "Cycling paths" toggle controls it together with the LTA layer
  await page.evaluate(() => { cpnVisible = false; setCpnVis(); });
  await expect.poll(() => page.evaluate(() => map.getLayoutProperty('rideable-line', 'visibility'))).toBe('none');
  expect(errors).toEqual([]);
});

test('renders a shareable route image (PNG)', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
  // Share/GPX/Save live in the ⋯ overflow menu now.
  await page.getByRole('button', { name: 'More route actions' }).click();
  await expect(page.locator('#rtImgBtn')).toBeVisible();
  const head = await page.evaluate(() => drawRideCard(routeResult.coords, { subtitle: 't', big: '21 km', line: 'test' }).toDataURL('image/png').slice(0, 22));
  expect(head).toContain('data:image/png');
  expect(errors).toEqual([]);
});

test('an in-progress ride survives a reload (crash recovery)', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.evaluate(() => {
    setLocActive(true); startRec();
    onPos({ coords: { latitude: 1.3000, longitude: 103.8000, accuracy: 5, speed: 4 }, timestamp: 1_000 });
    onPos({ coords: { latitude: 1.3005, longitude: 103.8005, accuracy: 5, speed: 4 }, timestamp: 2_000 });
  });
  // the live track was persisted...
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('rec') || 'null')?.track.length)).toBeGreaterThanOrEqual(2);
  // ...so after losing in-memory state (a reload), resumeRec restores the ride instead of dropping it.
  await page.evaluate(() => { clearInterval(recTimer); recording = false; track = []; recDist = 0; resumeRec(); });
  await expect(page.locator('#viewRec')).toBeVisible();
  expect(await page.evaluate(() => recording)).toBe(true);
  expect(await page.evaluate(() => track.length)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => stopRec());
  expect(await page.evaluate(() => localStorage.getItem('rec'))).toBeNull();
  expect(errors).toEqual([]);
});

test('offers a waiting update only to an existing installation and never activates it automatically', async ({ page, browser }) => {
  const errors = await openArtifact(page, { serviceWorkerMode: 'waiting-update' });
  const pill = page.locator('#updatePill');
  await expect(pill).toBeVisible();
  expect(await page.evaluate(() => window.__swTest.messages)).toEqual([]);
  await pill.click();
  expect(await page.evaluate(() => window.__swTest.messages)).toEqual(['SKIP_WAITING']);
  expect(errors).toEqual([]);

  const context = await browser.newContext({ serviceWorkers: 'block', colorScheme: 'light' });
  const firstInstallPage = await context.newPage();
  const firstInstallErrors = await openArtifact(firstInstallPage, { serviceWorkerMode: 'first-install' });
  await expect(firstInstallPage.locator('#updatePill')).toBeHidden();
  expect(await firstInstallPage.evaluate(() => window.__swTest.messages)).toEqual([]);
  expect(firstInstallErrors).toEqual([]);
  await context.close();
});

test('defers an available update until an active ride recording has stopped', async ({ page }) => {
  await openArtifact(page, { serviceWorkerMode: 'waiting-update' });
  const pill = page.locator('#updatePill');
  await expect(pill).toBeVisible();
  await page.evaluate(() => startRec());
  await expect(pill).toBeHidden();
  expect(await page.evaluate(() => window.__swTest.messages)).toEqual([]);
  await page.evaluate(() => stopRec());
  await expect(pill).toBeVisible();
  expect(await page.evaluate(() => window.__swTest.messages)).toEqual([]);
});

test('keeps the responsive shell inside the viewport and keyboard-closes modal content', async ({ page }) => {
  const errors = await openArtifact(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'About this map' }).click();
  await expect(page.locator('#sheet')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet')).not.toHaveClass(/open/);
  expect(errors).toEqual([]);
});

test('feedback page draws a path and submits it live for review, showing a contribution card', async ({ page }) => {
  const errors = await openFeedback(page);
  await expect(page.locator('h1')).toHaveText('Feedback');
  await page.route('**/api/feedback', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"srv1","ok":true,"status":"pending"}' })
    : route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.evaluate(() => { map.fire('click', { lngLat: { lng: 103.85, lat: 1.30 } }); map.fire('click', { lngLat: { lng: 103.86, lat: 1.31 } }); });
  await expect.poll(() => page.evaluate(() => pts.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => map.getSource('draw')._data.features.length)).toBeGreaterThan(0);
  await page.fill('#fbNote', 'New canal connector, not on the map yet');
  await page.fill('#fbName', 'TestRider');
  await page.click('#fbSubmit');
  await expect(page.locator('#fbCard')).toBeVisible();
  await expect(page.locator('#fbStatus')).toContainText('Sent for review');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cbsg.fbqueue') || '[]'))).toHaveLength(0); // sent, not queued
  await page.click('#fbCardDone');
  await expect(page.locator('#fbCard')).toBeHidden();
  expect(errors).toEqual([]);
});

test('feedback page queues a comment on the device when the service is unreachable', async ({ page }) => {
  const errors = await openFeedback(page);
  await page.route('**/api/feedback', route => route.request().method() === 'POST' ? route.abort()
    : route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.click('.fb-mode[data-mode="comment"]');
  await expect(page.locator('#fbMapWrap')).toHaveClass(/comment/);
  await page.fill('#fbNote', 'Love this map, thank you');
  await page.click('#fbSubmit');
  await expect(page.locator('#fbStatus')).toContainText('saved on your device');
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('cbsg.fbqueue') || '[]'));
  expect(queued[0].kind).toBe('comment');
  expect(queued[0].geometry).toBeNull();
  expect('device' in queued[0]).toBe(false);
  // the only console error allowed is the deliberately-aborted submit request
  expect(errors.filter(e => !/ERR_FAILED|Failed to load resource/.test(e))).toEqual([]);
});

test('community feed renders approved items as text (never HTML) and records a per-device vote', async ({ page }) => {
  const errors = await openFeedback(page);
  const item = { id: 'f1', createdAt: Date.now() - 3600000, kind: 'path', geometry: null, note: 'Nice <img src=x onerror=alert(1)> canal path', rating: null, contributor: '<b>Rider</b>' };
  await page.route('**/api/feedback', route => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [item] }) })
    : route.fulfill({ status: 201, contentType: 'application/json', body: '{"ok":true}' }));
  let voteBody = null;
  await page.route('**/api/feedback/*/vote', route => { voteBody = route.request().postData(); route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await page.click('#tabFeed');
  const card = page.locator('#fbList .fb-fcard').first();
  await expect(card).toBeVisible();
  await expect(page.locator('#fbList img')).toHaveCount(0);         // stored text inserted via textContent → no element parsed out
  await expect(card.locator('.note')).toContainText('Nice');
  await expect(card.locator('.who')).toHaveText('<b>Rider</b>');    // handle shown literally, not as bold
  await card.locator('.fb-vote').click();
  await expect(card.locator('.fb-vote')).toContainText('Thanks');
  expect(voteBody).toContain('device');
  expect(errors).toEqual([]);
});
