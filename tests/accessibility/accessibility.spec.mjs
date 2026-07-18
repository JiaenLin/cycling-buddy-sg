import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openArtifact } from '../helpers/app-fixture.mjs';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page, context) {
  const result = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(result.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map(node => node.target)
  })), context).toEqual([]);
}

test('initial responsive application and route state meet automated WCAG 2.2 AA checks', async ({ page }) => {
  await openArtifact(page);
  await expectNoViolations(page, 'initial application');

  await page.getByRole('button', { name: 'Plan a route' }).click();
  await page.evaluate(() => {
    handleRouteClick([103.7859, 1.4370]);
    handleRouteClick([103.9040, 1.4043]);
  });
  await expect(page.locator('#rtDirs')).toBeVisible();
  await expectNoViolations(page, 'route directions');
});

test('modal focus is contained, closed dialogs are inert, and focus returns to the opener', async ({ page }) => {
  await openArtifact(page);
  const opener = page.getByRole('button', { name: 'About this map' });
  const dialog = page.getByRole('dialog', { name: 'About Cycling Buddy SG' });
  await expect(page.locator('#sheet')).toHaveAttribute('aria-hidden', 'true');
  await opener.click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('#sheet')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.getByRole('button', { name: 'Close' }).first()).toBeFocused();
  await expectNoViolations(page, 'open About dialog');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#sheet').getByRole('link', { name: 'Lin Jiaen' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet')).toHaveAttribute('aria-hidden', 'true');
  await expect(opener).toBeFocused();
});

test('visible first-party controls meet WCAG 2.2 minimum target size', async ({ page }) => {
  await openArtifact(page);
  const controls = page.locator('#app button:visible, #app [role="button"]:visible');
  const count = await controls.count();
  expect(count).toBeGreaterThan(10);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    const label = await control.evaluate(element => element.id
      ? `#${element.id}`
      : `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
    expect(box, `${label} has a box`).not.toBeNull();
    expect(box.width, `${label} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `${label} height`).toBeGreaterThanOrEqual(24);
  }
});

test('reduced-motion preference removes first-party animation and transition duration', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openArtifact(page);
  const durations = await page.evaluate(() => {
    const selectors = ['#sheet', '#toast', '.live-dot', '.fab', '.lg-body'];
    return selectors.map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      const seconds = value => Math.max(...value.split(',').map(part => Number.parseFloat(part) || 0));
      return { selector, transition: seconds(style.transitionDuration), animation: seconds(style.animationDuration) };
    });
  });
  for (const item of durations) {
    expect(item.transition, `${item.selector} transition`).toBeLessThanOrEqual(0.001);
    expect(item.animation, `${item.selector} animation`).toBeLessThanOrEqual(0.001);
  }
});
