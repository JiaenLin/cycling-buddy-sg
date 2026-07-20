import { expect, test } from '@playwright/test';
import { openArtifact } from '../helpers/app-fixture.mjs';

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
  await expect(page.locator('#rtOptions .rt-opt')).toHaveCount(2);
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

test('keeps a planned route through stray taps, drag-edits endpoints, and only clears on demand', async ({ page }) => {
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

  // 3. Closing the planner keeps the route drawn on the map.
  await page.getByRole('button', { name: 'Exit route planning' }).click();
  expect(await page.evaluate(() => Boolean(routeResult))).toBe(true);
  await expect.poll(() => page.evaluate(() => map.querySourceFeatures('route').length)).toBeGreaterThan(0);

  // 4. Clear is the only reset.
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.getByRole('button', { name: 'Clear' }).click();
  expect(await page.evaluate(() => routeResult)).toBeNull();
  await expect.poll(() => page.evaluate(() => map.querySourceFeatures('route').length)).toBe(0);
  expect(errors).toEqual([]);
});

test('hides route controls until a route exists and reports no nearby path for far taps', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  // Reverse/Clear/GPX, the road notice, the key and the options must not leak before a route exists.
  for (const id of ['#rtRevBtn', '#rtClrBtn', '#rtGpxBtn', '#rtKey', '#rtNotice', '#rtOptions'])
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

test('renders a shareable route image (PNG)', async ({ page }) => {
  const errors = await openArtifact(page);
  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => { handleRouteClick([103.7859, 1.4370]); handleRouteClick([103.9040, 1.4043]); });
  await expect.poll(() => page.evaluate(() => Boolean(routeResult))).toBe(true);
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
