const { test, expect } = require('@playwright/test');
const path = require('path');

const url = `file://${path.resolve(__dirname, '../index.html')}`;

test.describe('Phone-width layout', () => {
    // Any viewport at most 768px wide gets the mobile stylesheet
    test.use({ viewport: { width: 700, height: 600 } });

    test('the page scrolls vertically at phone widths', async ({ page }) => {
        test.skip(test.info().project.name === 'Mobile Safari', 'Playwright cannot send wheel events to mobile WebKit');
        // Replicata: open the page 700px wide and spin the wheel.
        // Expectata: the page scrolls down. Resultata before the fix: the
        // mobile stylesheet's overflow-y: hidden on body propagated to the
        // viewport and blocked vertical scrolling entirely.
        await page.goto(url);
        await page.mouse.move(350, 300);
        await page.mouse.wheel(0, 400);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    });
});

test.describe('Rows AI has already passed', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(url);
    });

    test('Decennial and Annual are grayed out, labeled, and still count and step like any row', async ({ page }) => {
        // Replicata: fresh page (Uniform). Expectata: two passed rows, each
        // with its threshold label; their cells wear the neutral wash with
        // faint lines between them; their counts and steppers work.
        // Resultata before the change: only Annual was grayed and labeled.
        await expect(page.locator('tr.passed')).toHaveCount(2);
        await expect(page.locator('tr[data-row="decennial"] .threshold-label')).toHaveText('⬆ AI passed this threshold circa 2026 ⬆');
        await expect(page.locator('tr[data-row="annual"] .threshold-label')).toHaveText('⬆ AI passed this threshold by 2024 ⬆');

        const first = page.locator('tr[data-row="decennial"] td[data-col="positive"]');
        const last = page.locator('tr[data-row="decennial"] td[data-col="catastrophic"]');
        await expect(first).toHaveCSS('background-color', 'rgb(246, 246, 243)');
        await expect(first).toHaveCSS('border-right-color', 'rgb(238, 237, 231)');
        await expect(last).toHaveCSS('border-right-color', 'rgb(225, 224, 217)');

        await expect(first.locator('.cell-count')).toContainText('5%');
        await first.locator('.stepper-btn[data-delta="1"]').dispatchEvent('click');
        await expect(first.locator('.cell-count')).toContainText('6%');
        await expect(page.locator('#total-decennial')).toContainText('26%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });
});
