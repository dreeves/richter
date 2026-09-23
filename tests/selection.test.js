const { test, expect } = require('@playwright/test');
const path = require('path');

const url = `file://${path.resolve(__dirname, '../index.html')}`;

// Pips render above the selection box (by design, so they stay draggable
// inside it), so a randomly placed pip can cover the exact point we want
// to grab on the box and steal the drag, flaking the test. Nudge any such
// pips away before grabbing.
async function movePipsAwayFrom(page, x, y) {
    await page.evaluate(([px, py]) => {
        document.querySelectorAll('.hexagon').forEach(pip => {
            const r = pip.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (Math.abs(cx - px) < 25 && Math.abs(cy - py) < 25) {
                pip.style.left = (parseFloat(pip.style.left) - 60) + 'px';
            }
        });
    }, [x, y]);
}

test.describe('Selection Box Interaction', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(url);
    });

    test('starts a selection box off the grid and selects an off-grid pip', async ({ page }) => {
        // Replicata: drag a pip off the grid, then drag a box around it
        // starting from the empty space there. Expectata: the box appears
        // and the pip is selected. Resultata before the change: no box,
        // because a box could only start on a grid cell, so pips parked
        // off-grid could never be box-selected.
        // Two synthetic drags in a row are beyond what the mobile
        // emulations hit-test reliably; the desktop projects cover this
        test.skip(['Mobile Chrome', 'Mobile Safari'].includes(test.info().project.name), 'Unreliable synthetic mouse in mobile emulation');
        // The Historical Examples cell of a middle row is off-grid, inside
        // every viewport (Firefox drops synthetic mouse events outside it)
        // and away from the top rows the mobile emulation can't hit-test
        const spot = await page.locator('tr[data-row="millenary"] td:nth-of-type(2)').boundingBox();
        const pip = page.locator('.hexagon').first();
        const b = await pip.boundingBox();
        const tx = spot.x + spot.width / 2, ty = spot.y + spot.height / 2;
        await page.mouse.move(b.x + 10, b.y + 10);
        await page.mouse.down();
        await page.mouse.move(tx, ty, { steps: 5 });
        await page.mouse.up();

        await page.mouse.move(tx - 40, ty - 40);
        await page.mouse.down();
        await page.mouse.move(tx + 40, ty + 40, { steps: 5 });

        const selectionBox = page.locator('#selection-box');
        await expect(selectionBox).toBeVisible();
        await page.mouse.up();
        await expect(pip).toHaveClass(/selected/);
    });

    test('starts a selection box from the table header', async ({ page }) => {
        test.skip(test.info().project.name === 'Mobile Safari', 'Box selection does not register in Mobile Safari emulation');
        const th = await page.locator('thead th', { hasText: 'Historical Examples' }).boundingBox();
        await page.mouse.move(th.x + th.width / 2, th.y + th.height / 2);
        await page.mouse.down();
        await page.mouse.move(th.x + th.width / 2 + 200, th.y + th.height / 2 + 150, { steps: 5 });

        const selectionBox = page.locator('#selection-box');
        await expect(selectionBox).toBeVisible();
        await page.mouse.up();
    });

    test('does not start a selection box from the toolbar controls', async ({ page }) => {
        // Replicata: press on the help button and drag. Expectata: no box
        // (controls keep their own behavior). Resultata: same as before.
        const btn = await page.locator('#help-btn').boundingBox();
        await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
        await page.mouse.down();
        await page.mouse.move(btn.x + 150, btn.y + 150, { steps: 5 });

        const selectionBox = page.locator('#selection-box');
        await expect(selectionBox).not.toBeVisible();
        await page.mouse.up();
    });

    test('clicking empty space clears the selection', async ({ page }) => {
        test.skip(test.info().project.name === 'Mobile Safari', 'Box selection does not register in Mobile Safari emulation');
        const cell = page.locator('.prob-cell').first();
        const box = await cell.boundingBox();
        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 200);
        await page.mouse.up();
        await expect(page.locator('.hexagon.selected').first()).toBeVisible();

        // The blank top-left corner of the table is empty space inside
        // every desktop viewport (Firefox drops synthetic mouse events
        // outside it)
        const corner = await page.locator('thead th.blank').first().boundingBox();
        await page.mouse.click(corner.x + corner.width / 2, corner.y + corner.height / 2);
        await expect(page.locator('.hexagon.selected')).toHaveCount(0);
        await expect(page.locator('#selection-box')).not.toBeVisible();
    });

    test('box selection alone adds nothing to the undo stack', async ({ page }) => {
        // Replicata: fresh page, drag a selection box. Expectata: Undo stays
        // disabled, since nothing moved. Resultata before the change: Undo
        // lit up after every box drag and undoing it changed nothing.
        test.skip(test.info().project.name === 'Mobile Safari', 'Box selection does not register in Mobile Safari emulation');
        const undo = page.locator('button[title="Undo"]');
        await expect(undo).toBeDisabled();
        const cell = page.locator('.prob-cell').first();
        const box = await cell.boundingBox();
        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 200);
        await page.mouse.up();
        await expect(page.locator('#selection-box')).toBeVisible();
        await expect(undo).toBeDisabled();
    });

    test('should START a selection box when dragging from a pip cell (prob-cell)', async ({ page }) => {
        // Find a prob-cell
        const cell = page.locator('.prob-cell').first();
        const box = await cell.boundingBox();

        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(box.x + 100, box.y + 100);

        const selectionBox = page.locator('#selection-box');
        await expect(selectionBox).toBeVisible();
        await page.mouse.up();
    });

    test('should MOVE the selection box when dragging inside its empty area', async ({ page }) => {
        // Synthetic mouse events are unreliable for box manipulation in
        // webkit, desktop and mobile (this fails identically against the
        // pre-change deployed app). Chromium and Firefox still cover it.
        test.skip(['webkit', 'Mobile Safari'].includes(test.info().project.name), 'Unreliable synthetic mouse in webkit emulation');
        // Create a selection
        const cell = page.locator('.prob-cell').first();
        const box = await cell.boundingBox();
        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 200);
        await page.mouse.up();

        const selectionBox = page.locator('#selection-box');
        const initialBox = await selectionBox.boundingBox();

        // Drag from inside the box (avoid pips if possible, but pips are above box)
        await movePipsAwayFrom(page, initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
        // Click at center
        await page.mouse.move(initialBox.x + initialBox.width / 2, initialBox.y + initialBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(initialBox.x + initialBox.width / 2 + 50, initialBox.y + initialBox.height / 2 + 50);
        await page.mouse.up();

        const finalBox = await selectionBox.boundingBox();
        expect(finalBox.x).toBeGreaterThan(initialBox.x);
        expect(finalBox.y).toBeGreaterThan(initialBox.y);
        expect(finalBox.width).toBeCloseTo(initialBox.width);
        expect(finalBox.height).toBeCloseTo(initialBox.height);
    });

    test('should RESIZE the selection box using handles', async ({ page }) => {
        // See the MOVE test above, but for RESIZE it's desktop webkit too:
        // grabbing the 10px handle with synthetic mouse events flakes in
        // webkit (pre-existing; fails on the deployed app as well).
        test.skip(['webkit', 'Mobile Safari'].includes(test.info().project.name), 'Unreliable synthetic mouse in webkit emulation');
        // Create a selection
        const cell = page.locator('.prob-cell').first();
        const box = await cell.boundingBox();
        await page.mouse.move(box.x + 5, box.y + 5);
        await page.mouse.down();
        await page.mouse.move(box.x + 200, box.y + 200);
        await page.mouse.up();

        const selectionBox = page.locator('#selection-box');
        const initialBox = await selectionBox.boundingBox();

        // Drag SE handle
        const handle = page.locator('.resize-handle.se');
        const handleBox = await handle.boundingBox();

        await movePipsAwayFrom(page, handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2 + 50, handleBox.y + handleBox.height / 2 + 50);
        await page.mouse.up();

        const finalBox = await selectionBox.boundingBox();
        expect(finalBox.width).toBeGreaterThan(initialBox.width);
        expect(finalBox.height).toBeGreaterThan(initialBox.height);
    });

    test('should MOVE pips when dragging them, even if inside selection box', async ({ page }) => {
        // Mobile Safari emulation hit-tests pips below its 664px fold as
        // the html element, so neither the box nor the pip drag registers
        // there (verified against the committed code too)
        test.skip(test.info().project.name === 'Mobile Safari', 'Unreliable synthetic mouse in webkit emulation');
        // Select pips
        const pip = page.locator('.hexagon').first();
        const pipInitialBox = await pip.boundingBox();

        // Drag a box around it
        await page.mouse.move(pipInitialBox.x - 20, pipInitialBox.y - 20);
        await page.mouse.down();
        await page.mouse.move(pipInitialBox.x + 40, pipInitialBox.y + 40);
        await page.mouse.up();

        // Drag the pip itself
        await page.mouse.move(pipInitialBox.x + 5, pipInitialBox.y + 5);
        await page.mouse.down();
        await page.mouse.move(pipInitialBox.x + 55, pipInitialBox.y + 55);
        await page.mouse.up();

        const pipFinalBox = await pip.boundingBox();
        expect(pipFinalBox.x).toBeGreaterThan(pipInitialBox.x);
        expect(pipFinalBox.y).toBeGreaterThan(pipInitialBox.y);
    });
    test('paints selected pips highlighter yellow and marks the selected-share counts, never the red of the Bad arm', async ({ page }) => {
        // Replicata: box-select one pip. Expectata: its hexagon turns
        // highlighter yellow (--select-yellow, #ffd21f) with a black outline,
        // and the grand total's "(1%)" selected share sits on a yellow mark
        // (--wash-select, #fff2a8) in ink, not colored text. Resultata before
        // the fix: pip and text were both #d03b3b, the same red as the
        // Catastrophic column's accent.
        //
        // Mobile Safari emulation never registers a box selection here (the
        // 820px layout overflows its 390px viewport, so synthetic mouse
        // events miss); desktop webkit and Mobile Chrome cover it.
        test.skip(test.info().project.name === 'Mobile Safari', 'Box selection does not register in Mobile Safari emulation');
        //
        // Pick a pip with a 20px margin inside its own cell, so the drag
        // starts on a cell where box selection is allowed, not on the pip
        const pipId = await page.evaluate(() => {
            const cells = [...document.querySelectorAll('.prob-cell, .annual-merged-cell')].map(c => c.getBoundingClientRect());
            const inside = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            const pip = [...document.querySelectorAll('.hexagon')].find(p => {
                const r = p.getBoundingClientRect();
                const cell = cells.find(c => inside(c, r.left + r.width / 2, r.top + r.height / 2));
                return cell && inside(cell, r.left - 20, r.top - 20);
            });
            return pip.id;
        });
        const pip = page.locator(`#${pipId}`);
        const b = await pip.boundingBox();
        await movePipsAwayFrom(page, b.x - 20, b.y - 20);
        await page.mouse.move(b.x - 20, b.y - 20);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width + 20, b.y + b.height + 20);
        await page.mouse.up();

        await expect(pip).toHaveClass(/selected/);
        await expect(pip.locator('polygon')).toHaveCSS('fill', 'rgb(255, 210, 31)');
        await expect(pip.locator('polygon')).toHaveCSS('stroke', 'rgb(0, 0, 0)');
        const share = page.locator('#grand-total span');
        await expect(share).toHaveCSS('background-color', 'rgb(255, 242, 168)');
        await expect(share).toHaveCSS('color', 'rgb(11, 11, 11)');
    });
});

// Touch: a finger on a pip cell drags a selection box; a finger anywhere
// else scrolls the page (CSS touch-action), and a scroll must not disturb
// the selection. Chromium only: the other engines have no scriptable
// touch input here.
test.describe('Touch', () => {
    test.use({ hasTouch: true });

    async function touchDrag(page, from, to) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
        for (let i = 1; i <= 6; i++) {
            const x = from.x + (to.x - from.x) * i / 6, y = from.y + (to.y - from.y) * i / 6;
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
    }

    test.beforeEach(async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'Touch input is scripted through the Chrome DevTools Protocol');
        await page.goto(url);
    });

    test('a touch drag on a pip cell draws a selection box', async ({ page }) => {
        const cell = await page.locator('.prob-cell').first().boundingBox();
        await touchDrag(page, { x: cell.x + 5, y: cell.y + 5 }, { x: cell.x + 140, y: cell.y + 80 });
        await expect(page.locator('#selection-box')).toBeVisible();
        await expect(page.locator('.hexagon.selected').first()).toBeVisible();
    });

    test('a touch scroll that starts off the pip cells leaves the selection alone', async ({ page }) => {
        // Replicata: select pips with a touch drag on a cell, then swipe on
        // the title (the page scrolls). Expectata: the selection and its box
        // survive. Resultata before the fix: the swipe's touchstart cleared
        // the selection before the browser took the gesture for scrolling.
        const cell = await page.locator('.prob-cell').first().boundingBox();
        await touchDrag(page, { x: cell.x + 5, y: cell.y + 5 }, { x: cell.x + 140, y: cell.y + 80 });
        const before = await page.locator('.hexagon.selected').count();
        expect(before).toBeGreaterThan(0);

        const title = await page.locator('body > h2').boundingBox();
        await touchDrag(page, { x: title.x + 40, y: title.y + 10 }, { x: title.x + 40, y: title.y + 130 });
        await expect(page.locator('.hexagon.selected')).toHaveCount(before);
        await expect(page.locator('#selection-box')).toBeVisible();
    });
});
