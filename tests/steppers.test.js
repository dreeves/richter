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
        const minus = page.locator('tr[data-row="annual"] td[data-col="positive"] .stepper-btn[data-delta="-1"]');
        await expect(minus).toBeDisabled();
    });

    test('plus on an annual cell adds 1% to that cell and to the annual row', async ({ page }) => {
        // Replicata: press + in the Annual/Positive cell. Expectata: that
        // cell shows 1%, the annual row total shows 1%, grand total 100%.
        // Resultata before the change: the annual row was one merged cell
        // with a single row-wide stepper and no per-cell count.
        // dispatchEvent instead of click: the annual row sits below the
        // mobile-emulation fold, which the emulator can't reliably scroll to
        const cell = page.locator('tr[data-row="annual"] td[data-col="positive"]');
        await cell.locator('.stepper-btn[data-delta="1"]').dispatchEvent('click');

        await expect(cell.locator('.cell-count')).toContainText('1%');
        await expect(page.locator('#total-annual')).toContainText('1%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('the threshold label survives every re-render of the annual row', async ({ page }) => {
        const label = page.locator('tr[data-row="annual"] .threshold-label');
        await expect(label).toHaveText('⬆ AI passed this threshold by 2024 ⬆');
        await page.locator('tr[data-row="annual"] td[data-col="ambiguous"] .stepper-btn[data-delta="1"]').dispatchEvent('click');
        await expect(page.locator('#total-annual')).toContainText('1%');
        await expect(label).toHaveText('⬆ AI passed this threshold by 2024 ⬆');
    });

    test('annual-row pips round-trip through the URL', async ({ page }) => {
        const cell = page.locator('tr[data-row="annual"] td[data-col="catastrophic"]');
        await cell.locator('.stepper-btn[data-delta="1"]').dispatchEvent('click');
        await expect(cell.locator('.cell-count')).toContainText('1%');
        const shared = page.url();
        expect(shared).toContain('?d=');

        await page.goto(shared);
        await expect(page.locator('tr[data-row="annual"] td[data-col="catastrophic"] .cell-count')).toContainText('1%');
        await expect(page.locator('#total-annual')).toContainText('1%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('a malformed URL state fails loudly instead of silently randomizing', async ({ page }) => {
        // Replicata: open the page with garbage in ?d=. Expectata: a page
        // error, not a quietly random distribution presented as the shared
        // one. Resultata before the change: the error was swallowed and a
        // random layout shown.
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(url + '?d=@@@');
        await page.waitForTimeout(300);
        expect(errors.length).toBeGreaterThan(0);
    });

    test('row-total stepper moves 1% into the row', async ({ page }) => {
        // dispatchEvent: the totals column sits right of the mobile
        // emulator's visual viewport, which it can't reliably scroll to
        await page.locator('#total-epochal .stepper-btn[data-delta="1"]').dispatchEvent('click');

        await expect(page.locator('#total-epochal')).toContainText('26%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('plus on an empty column total fills its top cell first', async ({ page }) => {
        // Replicata: empty the Catastrophic column (Skeptic has 1% there,
        // in the epochal row; remove it), then press + on the column total.
        // Expectata: the pip lands in the top (Epochal) cell of the column,
        // the first in reading order. Resultata before the change: a random
        // spot anywhere in the column.
        await page.selectOption('#preset-select', 'skeptic');
        await page.locator('#total-catastrophic .stepper-btn[data-delta="-1"]').dispatchEvent('click');
        await expect(page.locator('#total-catastrophic')).toContainText('0%');
        await page.locator('#total-catastrophic .stepper-btn[data-delta="1"]').dispatchEvent('click');
        await expect(page.locator('tr[data-row="epochal"] td[data-col="catastrophic"] .cell-count')).toContainText('1%');
        await expect(page.locator('#total-catastrophic')).toContainText('1%');
    });

    test('column-total stepper moves 1% out of the column', async ({ page }) => {
        // dispatchEvent: the totals row sits below the mobile emulator's
        // fold (see the annual-cell test above)
        await page.locator('#total-catastrophic .stepper-btn[data-delta="-1"]').dispatchEvent('click');

        await expect(page.locator('#total-catastrophic')).toContainText('19%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('pack and spread tidy a cell without changing any probabilities', async ({ page }) => {
        const cell = page.locator('tr[data-row="epochal"] td[data-col="positive"]');

        await cell.locator('.stepper-btn[data-act="pack"]').click();
        await expect(cell.locator('.cell-count')).toContainText('5%');
        await expect(page.locator('#grand-total')).toContainText('100%');

        await cell.locator('.stepper-btn[data-act="spread"]').click();
        await expect(cell.locator('.cell-count')).toContainText('5%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('row-total pack tidies the whole row, probabilities unchanged', async ({ page }) => {
        // dispatchEvent: totals column sits right of the mobile emulator fold
        await page.locator('#total-epochal .stepper-btn[data-act="pack"]').dispatchEvent('click');

        await expect(page.locator('#total-epochal')).toContainText('25%');
        await expect(page.locator('#grand-total')).toContainText('100%');
    });

    test('pack and spread are disabled on an empty cell', async ({ page }) => {
        const stepper = page.locator('tr[data-row="annual"] td[data-col="good"]');
        await expect(stepper.locator('.stepper-btn[data-act="pack"]')).toBeDisabled();
        await expect(stepper.locator('.stepper-btn[data-act="spread"]')).toBeDisabled();
    });

    test('redo reapplies an undone stepper move', async ({ page }) => {
        const cell = page.locator('tr[data-row="epochal"] td[data-col="positive"]');
        await cell.locator('.stepper-btn[data-delta="1"]').click();
        await expect(cell.locator('.cell-count')).toContainText('6%');

        await page.locator('button[title="Undo"]').dispatchEvent('click');
        await expect(cell.locator('.cell-count')).toContainText('5%');

        await page.locator('button[title="Redo"]').dispatchEvent('click');
        await expect(cell.locator('.cell-count')).toContainText('6%');

        // A fresh action kills the redo branch
        await cell.locator('.stepper-btn[data-delta="-1"]').click();
        await expect(page.locator('button[title="Redo"]')).toBeDisabled();
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
