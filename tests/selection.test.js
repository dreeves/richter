const { test, expect } = require('@playwright/test');
const path = require('path');

const url = `file://${path.resolve(__dirname, '../index.html')}`;

test.describe('Selection Box Interaction', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(url);
    });

    test('should NOT start a selection box when dragging from empty space below the table', async ({ page }) => {
        // Drag in the white space at the bottom
        await page.mouse.move(400, 800);
        await page.mouse.down();
        await page.mouse.move(600, 900);

        const selectionBox = page.locator('#selection-box');
        await expect(selectionBox).not.toBeVisible();
        await page.mouse.up();
    });

    test('should NOT start a selection box when dragging from the table header', async ({ page }) => {
        // Drag in the table header
        await page.mouse.move(400, 80);
        await page.mouse.down();
        await page.mouse.move(600, 150);

        const selectionBox = page.locator('#selection-box');
        await expect(selectionBox).not.toBeVisible();
        await page.mouse.up();
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

        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2 + 50, handleBox.y + handleBox.height / 2 + 50);
        await page.mouse.up();

        const finalBox = await selectionBox.boundingBox();
        expect(finalBox.width).toBeGreaterThan(initialBox.width);
        expect(finalBox.height).toBeGreaterThan(initialBox.height);
    });

    test('should MOVE pips when dragging them, even if inside selection box', async ({ page }) => {
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
});
