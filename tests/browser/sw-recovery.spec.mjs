import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.geojson', 'application/geo+json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8']
]);

test.describe('forward-versioned service-worker recovery drill', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Service-worker cache drill is pinned to Chromium');
  test.use({ serviceWorkers: 'allow' });

  let server;
  let origin;
  const state = { version: 'cbsg-drill-old', failAsset: null };

  test.beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (state.failAsset && url.pathname === state.failAsset) {
        response.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('synthetic failure');
        return;
      }
      if (url.pathname === '/sw.js') {
        const worker = sourceWorker.replace(/const VERSION\s*=\s*'[^']+';/, `const VERSION = '${state.version}';`);
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Service-Worker-Allowed': '/'
        }).end(worker);
        return;
      }
      if (url.pathname === '/') {
        const html = `<!doctype html><meta charset="utf-8"><title>Recovery drill</title><script>
          localStorage.setItem('syntheticRideDraft','preserve-me');
          window.idbReady = new Promise((resolve, reject) => {
            const open = indexedDB.open('cbsg-recovery-drill', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('drafts');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const tx = open.result.transaction('drafts', 'readwrite');
              tx.objectStore('drafts').put('preserve-me', 'synthetic');
              tx.oncomplete = resolve;
            };
          });
          window.registrationReady = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
        <\/script>`;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
        return;
      }
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const target = path.resolve(root, relative);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end('Forbidden'); return;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        response.writeHead(404).end('Not found'); return;
      }
      response.writeHead(200, {
        'Content-Type': mime.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Service-Worker-Allowed': '/'
      });
      fs.createReadStream(target).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  test('rejects a broken candidate and activates a clean forward recovery without data loss or loop', async ({ page }) => {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => Promise.all([window.idbReady, window.registrationReady]));
    await page.reload();
    await page.evaluate(() => navigator.serviceWorker.ready);
    const oldCaches = await page.evaluate(() => caches.keys());
    expect(oldCaches).toContain('cbsg-drill-old-shell');

    const requestUpdate = () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return new Promise(async resolve => {
        const timeout = setTimeout(() => resolve('timeout'), 15000);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker.addEventListener('statechange', () => {
            if (['installed', 'redundant'].includes(worker.state)) {
              clearTimeout(timeout); resolve(worker.state);
            }
          });
        }, { once: true });
        await registration.update();
      });
    });

    state.version = 'cbsg-drill-bad';
    state.failAsset = '/router.js';
    expect(await requestUpdate()).toBe('redundant');
    const afterBad = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { active: Boolean(registration.active), waiting: Boolean(registration.waiting), caches: await caches.keys() };
    });
    expect(afterBad.active).toBe(true);
    expect(afterBad.waiting).toBe(false);
    expect(afterBad.caches).toContain('cbsg-drill-old-shell');

    state.version = 'cbsg-drill-recovery';
    state.failAsset = null;
    expect(await requestUpdate()).toBe('installed');
    const controllerChanges = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      let changes = 0;
      navigator.serviceWorker.addEventListener('controllerchange', () => { changes += 1; });
      registration.waiting.postMessage('SKIP_WAITING');
      await new Promise(resolve => {
        if (registration.active?.scriptURL && !registration.waiting) resolve();
        else navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      await registration.update();
      await new Promise(resolve => setTimeout(resolve, 1000));
      return changes;
    });
    expect(controllerChanges).toBe(1);

    const finalState = await page.evaluate(async () => {
      const dbValue = await new Promise((resolve, reject) => {
        const open = indexedDB.open('cbsg-recovery-drill');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction('drafts').objectStore('drafts').get('synthetic');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        };
      });
      return { local: localStorage.getItem('syntheticRideDraft'), dbValue, caches: await caches.keys() };
    });
    expect(finalState.local).toBe('preserve-me');
    expect(finalState.dbValue).toBe('preserve-me');
    expect(finalState.caches).toContain('cbsg-drill-recovery-shell');
    expect(finalState.caches).not.toContain('cbsg-drill-old-shell');
    expect(finalState.caches).not.toContain('cbsg-drill-bad-shell');
  });
});
