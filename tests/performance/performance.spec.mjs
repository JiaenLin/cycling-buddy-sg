import { expect, test } from '@playwright/test';
import budgets from '../../release/performance-budgets.json' with { type: 'json' };
import { openArtifact } from '../helpers/app-fixture.mjs';

test('Pixel 7 Fast 4G profile stays within startup, interaction, routing and Core Web Vitals budgets', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP throttling is a Chromium measurement contract');
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: budgets.referenceProfile.network.latencyMs,
    downloadThroughput: budgets.referenceProfile.network.downloadBitsPerSecond / 8,
    uploadThroughput: budgets.referenceProfile.network.uploadBitsPerSecond / 8
  });
  await session.send('Emulation.setCPUThrottlingRate', { rate: budgets.referenceProfile.cpuSlowdownMultiplier });
  await page.addInitScript(() => {
    window.__performanceEvidence = { lcp: 0, cls: 0 };
    new PerformanceObserver(list => {
      const entries = list.getEntries();
      if (entries.length) window.__performanceEvidence.lcp = entries.at(-1).startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__performanceEvidence.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });

  const startup = performance.now();
  await openArtifact(page);
  const appReady = performance.now() - startup;
  await page.waitForTimeout(250);
  const webVitals = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      fcp: fcp?.startTime || 0,
      lcp: window.__performanceEvidence.lcp || fcp?.startTime || 0,
      cls: window.__performanceEvidence.cls,
      domContentLoaded: navigation?.domContentLoadedEventEnd || 0
    };
  });

  const themeInteraction = await page.evaluate(async () => {
    const start = performance.now();
    document.getElementById('themeBtn').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Plan a route' }).click();
  const coldRoute = await page.evaluate(async () => {
    const start = performance.now();
    handleRouteClick([103.7859, 1.4370]);
    handleRouteClick([103.9040, 1.4043]);
    while (!routeResult) await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  await expect(page.locator('#rtDirs')).toBeVisible({ timeout: budgets.timingsMs.coldRouteMax });

  const warmRoute = await page.evaluate(async () => {
    const previousResult = routeResult;
    const start = performance.now();
    document.getElementById('rtSwapBtn').click();
    while (routeResult === previousResult) await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  await expect.poll(() => page.locator('#rtDirs .rt-step').count()).toBeGreaterThan(0);

  const evidence = { appReady, ...webVitals, themeInteraction, coldRoute, warmRoute };
  console.log(`PERFORMANCE_EVIDENCE ${JSON.stringify(evidence)}`);
  expect(appReady).toBeLessThanOrEqual(budgets.timingsMs.appReadyMax);
  expect(webVitals.fcp).toBeLessThanOrEqual(budgets.timingsMs.firstContentfulPaintMax);
  expect(webVitals.lcp).toBeLessThanOrEqual(budgets.timingsMs.largestContentfulPaintMax);
  expect(webVitals.cls).toBeLessThanOrEqual(budgets.coreWebVitals.cumulativeLayoutShiftMax);
  expect(themeInteraction).toBeLessThanOrEqual(budgets.timingsMs.themeInteractionMax);
  expect(coldRoute).toBeLessThanOrEqual(budgets.timingsMs.coldRouteMax);
  expect(warmRoute).toBeLessThanOrEqual(budgets.timingsMs.warmRouteMax);
});
