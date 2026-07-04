const { test, expect } = require('@playwright/test');
const path = require('path');

const url = `file://${path.resolve(__dirname, '../index.html')}`;

test.describe('Cell Steppers', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(url);
    });

    test('plus button moves 1% into the cell, conserving 100% total', async ({ page }) => {
        // Default init puts 5% in every non-annual cell
        const cell = page.locator('tr[data-row="epochal"] td[data-col="positive"]');
        await cell.locator('.stepper-btn[data-delta="1"]').click();

        await expect(cell.locator('.cell-count')).toContainText('6%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('minus button moves 1% out of the cell, conserving 100% total', async ({ page }) => {
        const cell = page.locator('tr[data-row="epochal"] td[data-col="positive"]');
        await cell.locator('.stepper-btn[data-delta="-1"]').click();

        await expect(cell.locator('.cell-count')).toContainText('4%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('minus button is disabled on an empty cell', async ({ page }) => {
        // The annual row starts empty
        const minus = page.locator('.annual-merged-cell .stepper-btn[data-delta="-1"]');
        await expect(minus).toBeDisabled();
    });

    test('plus on the annual merged cell adds 1% to the annual row', async ({ page }) => {
        // dispatchEvent instead of click: the annual row sits below the
        // mobile-emulation fold, and the mobile CSS's overflow-y:hidden
        // blocks the emulator from scrolling to it (real mobile browsers
        // ignore body overflow locks for user scrolling)
        await page.locator('.annual-merged-cell .stepper-btn[data-delta="1"]').dispatchEvent('click');

        await expect(page.locator('#total-annual')).toContainText('1%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('row-total stepper moves 1% into the row', async ({ page }) => {
        // dispatchEvent: the totals column sits right of the mobile
        // emulator's visual viewport, which it can't reliably scroll to
        await page.locator('#total-epochal .stepper-btn[data-delta="1"]').dispatchEvent('click');

        await expect(page.locator('#total-epochal')).toContainText('26%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('column-total stepper moves 1% out of the column', async ({ page }) => {
        // dispatchEvent: the totals row sits below the mobile emulator's
        // fold (see the annual-cell test above)
        await page.locator('#total-catastrophic .stepper-btn[data-delta="-1"]').dispatchEvent('click');

        await expect(page.locator('#total-catastrophic')).toContainText('19%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('undo reverses a stepper move', async ({ page }) => {
        const cell = page.locator('tr[data-row="epochal"] td[data-col="positive"]');
        await cell.locator('.stepper-btn[data-delta="1"]').click();
        await expect(cell.locator('.cell-count')).toContainText('6%');

        // dispatchEvent instead of click: mobile emulation can't hit-test the
        // top button row on this horizontally scrollable page (pre-existing;
        // affects all top-row buttons, not just undo)
        await page.locator('button[title="Undo"]').dispatchEvent('click');
        await expect(cell.locator('.cell-count')).toContainText('5%');
    });
});

test.describe('Presets', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(url);
    });

    test('selecting a preset redistributes pips and updates totals', async ({ page }) => {
        await page.selectOption('#preset-select', 'doomer');

        // Doomer puts 50% in the epochal row
        await expect(page.locator('#total-epochal')).toContainText('50%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('Nate Silver preset matches his On the Edge distribution', async ({ page }) => {
        await page.selectOption('#preset-select', 'silver');

        await expect(page.locator('#total-epochal')).toContainText('10%');
        await expect(page.locator('#total-millenary')).toContainText('30%');
        await expect(page.locator('#total-centennial')).toContainText('35%');
        await expect(page.locator('#total-decennial')).toContainText('25%');
        await expect(page.locator('#total-catastrophic')).toContainText('10%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('every preset applies cleanly and sums to 100%', async ({ page }) => {
        // Catches presets that don't sum to 100 (the app throws on those)
        // without hardcoding the preset list here.
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));

        const values = await page.locator('#preset-select option:not([disabled])')
            .evaluateAll(opts => opts.map(o => o.value));
        expect(values.length).toBeGreaterThan(0);

        for (const v of values) {
            await page.selectOption('#preset-select', v);
            await expect(page.locator('#grand-total')).toContainText('100%');
            // The truthful-sync leaves the dropdown on v iff the applied
            // distribution actually matches preset v
            await expect(page.locator('#preset-select')).toHaveValue(v);
        }

        expect(errors).toEqual([]);
    });

    test('select shows the applied preset', async ({ page }) => {
        await page.selectOption('#preset-select', 'optimist');
        await expect(page.locator('#preset-select')).toHaveValue('optimist');
    });

    test('select reverts to the placeholder when edited away from a preset', async ({ page }) => {
        await page.selectOption('#preset-select', 'optimist');
        await expect(page.locator('#preset-select')).toHaveValue('optimist');

        const cell = page.locator('tr[data-row="epochal"] td[data-col="positive"]');
        await cell.locator('.stepper-btn[data-delta="1"]').click();
        await expect(page.locator('#preset-select')).toHaveValue('');
    });

    test('fresh load shows Uniform, which is the default distribution', async ({ page }) => {
        await expect(page.locator('#preset-select')).toHaveValue('uniform');
    });

    test('undo reverses a preset', async ({ page }) => {
        await page.selectOption('#preset-select', 'doomer');
        await expect(page.locator('#total-epochal')).toContainText('50%');

        await page.locator('button[title="Undo"]').dispatchEvent('click');
        await expect(page.locator('#total-epochal')).toContainText('25%');
    });
});
