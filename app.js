document.addEventListener('DOMContentLoaded', () => {
    // Config
    const PIP_SIZE = 20; // Visual size
    // Using a slightly smaller effective size for collision to allow tight packing? 
    // Or strictly PIP_SIZE. Let's start with strict.
    const COLLISION_RADIUS = PIP_SIZE;
    const SNAP_TO_GRID = false;

    // State
    // We strictly track positions via the DOM left/top for truth, but we can cache if needed.
    // State
    // We strictly track positions via the DOM left/top for truth, but we can cache if needed.
    // Undo stack: Array of Map<id, {left, top}>
    const historyStack = [];
    let isUndoing = false;

    // StateCache for high-perf counter updates
    let cachedRowBounds = [];
    let cachedColBounds = [];

    // Selection
    const selectedPips = new Set();
    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    document.body.appendChild(selectionBox);

    const hexagonContainer = document.getElementById('hexagon-container');
    // undo container
    const undoContainer = document.getElementById('undo-container');

    // Add Undo Button to UI
    const undoButton = document.createElement('button'); // Actual button
    undoButton.className = 'undo-btn';
    undoButton.innerText = 'Undo';
    undoButton.disabled = true; // Initially disabled
    undoButton.addEventListener('click', undo);

    // Position Undo button in the dedicated container
    undoContainer.appendChild(undoButton);

    // Helpers for Grid Calculation
    // Pointy-topped hexes (which we seem to be changing to or using) usually pack with:
    // Vertical spacing = 3/4 * Height.
    // Horizontal spacing = Width (or sqrt(3)/2 * Height for equilateral).
    // Our SVG is 20x20 squashed hexagon?
    // Let's settle on a nice tight packing config.
    const hexSize = 20;
    // Tighter spacing to encourage "honeycomb" feel
    const horizontalSpacing = hexSize * 1.0;
    const verticalSpacing = hexSize * 0.8;

    function getGridPos(x, y) {
        // We use Math.floor/round logic to find nearest "cell"
        const row = Math.round(y / verticalSpacing);
        const isEven = row % 2 === 0;
        const xOffset = isEven ? 0 : horizontalSpacing / 2;
        const col = Math.round((x - xOffset) / horizontalSpacing);
        return { row, col };
    }

    function getScreenPos(row, col) {
        const isEven = row % 2 === 0;
        const xOffset = isEven ? 0 : horizontalSpacing / 2;
        const x = col * horizontalSpacing + xOffset;
        const y = row * verticalSpacing;
        return { x, y };
    }

    function updateGridBounds() {
        cachedRowBounds = [];
        cachedColBounds = [];

        // Cache Row Bounds from TRs
        // We target the data-rows and the annual row
        const rows = document.querySelectorAll('tr.data-row, tr.annual-row');
        rows.forEach(tr => {
            const rect = tr.getBoundingClientRect();
            // dataset.row for normal rows, 'annual' for the annual row
            const key = tr.dataset.row || (tr.classList.contains('annual-row') ? 'annual' : null);
            if (key) {
                cachedRowBounds.push({
                    top: rect.top + window.scrollY,
                    bottom: rect.bottom + window.scrollY,
                    key: key
                });
            }
        });

        // Cache Col Bounds from the first row of prob-cells (e.g. Epochal)
        // This assumes columns are vertically aligned (standard table)
        const firstRowCells = document.querySelectorAll('tr[data-row="epochal"] .prob-cell');
        firstRowCells.forEach(cell => {
            const rect = cell.getBoundingClientRect();
            const key = cell.dataset.col;
            if (key) {
                cachedColBounds.push({
                    left: rect.left + window.scrollX,
                    right: rect.right + window.scrollX,
                    key: key
                });
            }
        });
    }

    // Initialization
    // Initialization
    // We only want to place pips in the top 4 rows (Epochal, Millenary, Centennial, Decennial)
    // The "Annual" row is excluded from initialization.
    // We select cells that are strictly prob-cells (which we removed from Annual row)
    const cells = document.querySelectorAll('.prob-cell');
    let pipIndex = 0;

    // 5 pips per cell * 20 active cells = 100 pips.
    // Note: The HTML has 25 cells (5 rows * 5 cols).
    // wait, logic check: 
    // Row 1 (Epochal): 5 cols
    // Row 2 (Millenary): 5 cols
    // Row 3 (Centennial): 5 cols
    // Row 4 (Decennial): 5 cols
    // Row 5 (Annual): colspan=6 (highlight). 
    // Ah, the top 4 rows have 5 columns each. That's 20 cells.
    // If we want 100 pips, 5 per cell is correct.

    // Collect all placed pips to check initialization collisions
    const allPips = []; // {left, top, id}

    cells.forEach(cell => {
        const rect = cell.getBoundingClientRect();
        const cellLeft = rect.left + window.scrollX;
        const cellTop = rect.top + window.scrollY;
        const cellWidth = rect.width;
        const cellHeight = rect.height;

        for (let i = 0; i < 5; i++) {
            const pip = document.createElement('div');
            pip.classList.add('hexagon'); // Staying with class 'hexagon' for CSS but calling them pips
            pip.setAttribute('draggable', 'false');
            pip.id = `pip-${pipIndex++}`;

            pip.innerHTML = `
                <svg viewBox="0 0 100 100" width="20" height="20">
                    <polygon points="50,0 93,25 93,75 50,100 7,75 7,25" fill="#000000"/>
                </svg>
            `;

            // Random placement with collision retry
            let x, y, attempts = 0;
            let valid = false;

            while (!valid && attempts < 50) {
                // Random within cell padding
                const randX = Math.random() * (cellWidth - PIP_SIZE);
                const randY = Math.random() * (cellHeight - PIP_SIZE);
                x = cellLeft + randX;
                y = cellTop + randY;

                // Check against all existing pips
                let collision = false;
                for (const p of allPips) {
                    const dx = x - p.left;
                    const dy = y - p.top;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < PIP_SIZE) { // Using PIP_SIZE as diameter/spacing? 20px is width.
                        collision = true;
                        break;
                    }
                }

                if (!collision) valid = true;
                attempts++;
            }

            // Fallback: Just place it even if collision (unlikely in large cell)

            pip.style.position = 'absolute';
            pip.style.left = x + 'px';
            pip.style.top = y + 'px';

            pip.addEventListener('mousedown', (e) => handlePipMouseDown(e, pip));
            hexagonContainer.appendChild(pip);

            allPips.push({ left: x, top: y, id: pip.id, el: pip });
        }
    });

    updateCounters();
    // Manual initial UI update for button state
    updateSelectionUI();

    // Box Selection Logic
    let isBoxSelecting = false;
    let boxStartX, boxStartY;

    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.hexagon')) return;
        if (e.target === undoButton) return;
        if (e.button !== 0) return;

        isBoxSelecting = true;
        boxStartX = e.pageX;
        boxStartY = e.pageY;

        selectionBox.style.left = boxStartX + 'px';
        selectionBox.style.top = boxStartY + 'px';
        selectionBox.style.width = '0px';
        selectionBox.style.height = '0px';
        selectionBox.style.display = 'block';

        if (!e.shiftKey) {
            clearSelection();
        }

        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isBoxSelecting) return;
        const currentX = e.pageX;
        const currentY = e.pageY;
        const minX = Math.min(boxStartX, currentX);
        const minY = Math.min(boxStartY, currentY);
        const width = Math.abs(currentX - boxStartX);
        const height = Math.abs(currentY - boxStartY);

        selectionBox.style.left = minX + 'px';
        selectionBox.style.top = minY + 'px';
        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';
    });

    document.addEventListener('mouseup', (e) => {
        if (isBoxSelecting) {
            isBoxSelecting = false;

            const rect = selectionBox.getBoundingClientRect();
            const boxLeft = rect.left + window.scrollX;
            const boxTop = rect.top + window.scrollY;
            const boxRight = rect.right + window.scrollX;
            const boxBottom = rect.bottom + window.scrollY;

            const pips = document.querySelectorAll('.hexagon');
            let newlySelected = false;

            pips.forEach(pip => {
                const left = parseFloat(pip.style.left);
                const top = parseFloat(pip.style.top);
                // Center approx
                const cx = left + 10;
                const cy = top + 10;

                if (cx >= boxLeft && cx <= boxRight && cy >= boxTop && cy <= boxBottom) {
                    if (!selectedPips.has(pip)) {
                        selectPip(pip);
                        newlySelected = true;
                    }
                }
            });

            selectionBox.style.display = 'none';

            // Auto Pack on box select completion
            if (selectedPips.size > 0) {
                // Always save history before a potential move (packing)
                // We check if it actually moves later? No, packSelection moves immediately.
                saveHistory();
                packSelection();
            }
        }
    });

    // Helper functions
    function selectPip(pip) {
        selectedPips.add(pip);
        pip.classList.add('selected');
        updateCounters(); // metrics change on selection
        updateSelectionUI(); // button state
    }

    function deselectPip(pip) {
        selectedPips.delete(pip);
        pip.classList.remove('selected');
        updateCounters();
        updateSelectionUI();
    }

    function clearSelection() {
        selectedPips.forEach(pip => pip.classList.remove('selected'));
        selectedPips.clear();
        updateCounters();
        updateSelectionUI();
    }

    function updateSelectionUI() {
        // Only handles button state now
        undoButton.disabled = historyStack.length === 0;
    }

    // Drag Logic
    function handlePipMouseDown(e, pip) {
        if (e.button !== 0) return;

        // Save history before interaction starts? 
        // We only want to save if we actually MOVE.
        // We'll capture start positions.

        if (e.shiftKey) {
            if (selectedPips.has(pip)) {
                deselectPip(pip);
            } else {
                selectPip(pip);
                // Auto pack on single add?
                saveHistory(); // Snapshot before pack
                packSelection();
            }
            e.stopPropagation();
            return;
        }

        if (!selectedPips.has(pip)) {
            clearSelection();
            selectPip(pip);
            // Don't auto-pack here yet, because we are likely about to DRAG.
            // If we pack now, it might jump away from cursor.
            // But if user just CLICKS, maybe they expect pack?
            // "auto-pack as soon as pips are selected". 
            // If dragging, we control position.
        }

        e.stopPropagation();
        startDrag(e);
    }

    function startDrag(e) {
        const startX = e.clientX;
        const startY = e.clientY;

        // Cache bounds for real-time updates
        updateGridBounds();

        const initialPositions = new Map();
        selectedPips.forEach(pip => {
            initialPositions.set(pip, {
                left: parseFloat(pip.style.left),
                top: parseFloat(pip.style.top)
            });
        });

        // Save history state BEFORE dragged motion (snapshot of "before drag")
        // But we only push to stack if the drag actually completes and changes things.
        // We'll push `initialPositions` or full state? 
        // Our history system saves FULL state of all 100 pips. 
        // We push to stack only on drop?
        // Let's implement `saveHistory()` which pushes current DOM state.
        // We call it right before applying a permanent change.
        saveHistory(); // Pushing the state BEFORE the move.

        document.body.style.userSelect = 'none';

        // Add dragging class for performance
        selectedPips.forEach(pip => pip.classList.add('dragging'));

        let hasMoved = false;

        function move(e) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved = true;

            selectedPips.forEach(pip => {
                const init = initialPositions.get(pip);
                pip.style.left = (init.left + dx) + 'px';
                pip.style.top = (init.top + dy) + 'px';
            });

            // Real-time counter update
            // Throttle? Or is geometric fast enough? 100 pips * 20 cells = 2000 checks. 
            // It should be fine on modern CPU.
            updateCounters(true); // pass true to indicate "use cached bounds"?
        }

        function stop(e) {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', stop);
            document.body.style.userSelect = '';

            // Remove dragging class
            selectedPips.forEach(pip => pip.classList.remove('dragging'));

            if (!hasMoved) {
                // If it was just a click (no drag), maybe we should auto-pack?
                // "auto-pack... as soon as pips are selected"
                packSelection();
                return;
            }

            // Verify collision on drop
            // For each moved pip, check collision with unselected pips OR other selected pips?
            // "can you keep them from overlapping?"

            let collision = false;
            const allPips = document.querySelectorAll('.hexagon');

            // Naive collision check O(N^2) effectively but N=100 is small.
            for (let pip of selectedPips) {
                const r1 = pip.getBoundingClientRect();
                const cx1 = r1.left + r1.width / 2;
                const cy1 = r1.top + r1.height / 2;

                for (let other of allPips) {
                    if (pip === other) continue; // Skip self
                    // If other is also selected, we skip? 
                    // No, dragged group usually maintains separation, but if we dragged 
                    // and somehow squished them (not possible with rigid drag)
                    // The main issue is dropping ONTO existing static pips.
                    if (selectedPips.has(other)) continue;

                    const r2 = other.getBoundingClientRect();
                    const cx2 = r2.left + r2.width / 2;
                    const cy2 = r2.top + r2.height / 2;

                    const dist = Math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2);
                    if (dist < 20) { // 20px threshold
                        collision = true;
                        break;
                    }
                }
                if (collision) break;
            }

            if (collision) {
                // Revert
                selectedPips.forEach(pip => {
                    const init = initialPositions.get(pip);
                    pip.style.left = init.left + 'px';
                    pip.style.top = init.top + 'px';
                });
                // Pop the history we just saved, because no change occurred?
                historyStack.pop();
            } else {
                // Success
                updateCounters();
            }
        }

        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', stop);
    }

    function packSelection() {
        if (selectedPips.size === 0) return;

        // Calculate centroid
        let sumX = 0, sumY = 0;
        selectedPips.forEach(pip => {
            sumX += parseFloat(pip.style.left);
            sumY += parseFloat(pip.style.top);
        });
        const centerX = sumX / selectedPips.size;
        const centerY = sumY / selectedPips.size;

        const centerGrid = getGridPos(centerX, centerY);

        // Map occupied slots by UNSELECTED pips
        const occupiedGrid = {};
        const allPips = document.querySelectorAll('.hexagon');
        allPips.forEach(p => {
            if (!selectedPips.has(p)) {
                const pos = getGridPos(parseFloat(p.style.left), parseFloat(p.style.top));
                occupiedGrid[`${pos.row}_${pos.col}`] = true;
            }
        });

        // Spiral search for target slots
        // Use row/col consistently
        const targetSlots = [];
        const queue = [{ row: centerGrid.row, col: centerGrid.col }];
        const visited = new Set([`${centerGrid.row}_${centerGrid.col}`]);

        const directionsEven = [
            { dRow: -1, dCol: -1 }, { dRow: -1, dCol: 0 },
            { dRow: 0, dCol: -1 }, { dRow: 0, dCol: 1 },
            { dRow: 1, dCol: -1 }, { dRow: 1, dCol: 0 }
        ];
        const directionsOdd = [
            { dRow: -1, dCol: 0 }, { dRow: -1, dCol: 1 },
            { dRow: 0, dCol: -1 }, { dRow: 0, dCol: 1 },
            { dRow: 1, dCol: 0 }, { dRow: 1, dCol: 1 }
        ];

        let qIndex = 0;
        // Increase limit to ensure we find slots even in dense areas
        while (targetSlots.length < selectedPips.size && qIndex < 3000) {
            if (qIndex >= queue.length) break;
            const curr = queue[qIndex++];
            const key = `${curr.row}_${curr.col}`;

            if (!occupiedGrid[key]) {
                targetSlots.push(curr);
                occupiedGrid[key] = true;
            }

            const dirs = (Math.abs(curr.row) % 2 === 0) ? directionsEven : directionsOdd;
            for (let d of dirs) {
                const nRow = curr.row + d.dRow;
                const nCol = curr.col + d.dCol;
                const nKey = `${nRow}_${nCol}`;
                if (!visited.has(nKey)) {
                    visited.add(nKey);
                    queue.push({ row: nRow, col: nCol });
                }
            }
        }

        // Apply new positions
        let idx = 0;
        selectedPips.forEach(pip => {
            if (idx < targetSlots.length) {
                const s = targetSlots[idx++];
                const pos = getScreenPos(s.row, s.col);
                pip.style.left = pos.x + 'px';
                pip.style.top = pos.y + 'px';
            }
        });

        updateCounters();
    }

    function saveHistory() {
        if (isUndoing) return;
        const snapshot = [];
        const allPips = document.querySelectorAll('.hexagon');
        allPips.forEach(pip => {
            snapshot.push({
                id: pip.id,
                left: pip.style.left,
                top: pip.style.top
            });
        });
        historyStack.push(snapshot);
        // Limit stack size? 
        if (historyStack.length > 50) historyStack.shift();
        updateSelectionUI(); // Update button state
    }

    function undo() {
        if (historyStack.length === 0) return;
        isUndoing = true;

        const prevState = historyStack.pop();
        // If we just saved current state before a move, popping gives us "Before Move".
        // If we are at "Before Move", popping gives "Before Previous Move".

        // Logic check:
        // 1. Init -> Save[0]
        // 2. Drag Start -> Save[1] (copy of [0] effectively? No, strictly current state)
        // 3. Drop -> modifies DOM.
        // Undo -> Pop [1]. Apply [1]. 
        // Result: DOM is back to before drag.

        // If stack matches current DOM exactly (e.g. redundant save), pop again?
        // Let's just apply it.

        prevState.forEach(item => {
            const pip = document.getElementById(item.id);
            if (pip) {
                pip.style.left = item.left;
                pip.style.top = item.top;
            }
        });

        updateCounters();
        updateSelectionUI(); // Update button state
        isUndoing = false;
    }

    function updateCounters(useCache = false) {
        !useCache && updateGridBounds();

        const counts = {
            rows: {},
            cols: {},
            rowsSel: {},
            colsSel: {},
            total: 0,
            totalSel: 0
        };

        // Initialize (functional approach preferred over loop? simple loops are usually cleaner for init)
        // But we handle initialization dynamically.

        // Reset display
        // We use innerHTML now because of the span
        const resetEl = el => el.innerHTML = '0%';
        document.querySelectorAll('.row-total').forEach(resetEl);
        document.querySelectorAll('.col-total').forEach(resetEl);
        document.getElementById('grand-total').innerHTML = '0%';

        // Clear prob cells (except annual label)
        document.querySelectorAll('.prob-cell').forEach(el => !el.classList.contains('annual-merged-cell') && (el.innerText = ''));

        const allPips = document.querySelectorAll('.hexagon');

        allPips.forEach(pip => {
            const l = parseFloat(pip.style.left);
            const t = parseFloat(pip.style.top);
            const cx = l + 10;
            const cy = t + 10;
            const isSel = selectedPips.has(pip);

            let rowKey = null;
            let colKey = null;

            // Find Row
            for (const r of cachedRowBounds) {
                if (cy >= r.top && cy <= r.bottom) {
                    rowKey = r.key;
                    break;
                }
            }

            // Find Col
            for (const c of cachedColBounds) {
                if (cx >= c.left && cx <= c.right) {
                    colKey = c.key;
                    break;
                }
            }

            // Update Metrics
            // Must have a valid row to count? Or valid col?
            // "Grand Total" counts everything on the board? 
            // Or only things in valid zones?
            // Previously `updateCellBounds` only included specific cells.
            // If dragging outside grid, it ignored it.
            // Let's enforce: Must be in a Row AND in a Col?
            // Wait, Annual row has NO col cells in DOM, but it has X-coordinates that match cols.
            // If I drop in Annual row, `rowKey` = 'annual'. `colKey` = 'positive' (if on left).
            // So we count it!

            // Only count if inside valid bounds (Row is mandatory, Col is mandatory?)
            // If pip is in margin, we ignore?
            if (rowKey && colKey) {
                // Update Row
                counts.rows[rowKey] = (counts.rows[rowKey] || 0) + 1;
                isSel && (counts.rowsSel[rowKey] = (counts.rowsSel[rowKey] || 0) + 1);

                // Update Col
                counts.cols[colKey] = (counts.cols[colKey] || 0) + 1;
                isSel && (counts.colsSel[colKey] = (counts.colsSel[colKey] || 0) + 1);

                // Update Total
                counts.total++;
                isSel && counts.totalSel++;
            }
        });

        // Render helper
        const render = (val, selVal) => {
            return `${val || 0}%${(selVal > 0) ? ` <span style="color:#ff4444">(${selVal}%)</span>` : ''}`;
        };

        // Render helper for Grand Total (Overloaded logic)
        const renderGrand = (val, selVal) => {
            const outside = 100 - val;
            const showSelected = selVal > 0;
            // If selected > 0, show that. Else show outside count (which is 0 if full grid).
            const num = showSelected ? selVal : outside;
            // Red if selected, Gray if showing outside/empty
            const color = showSelected ? '#ff4444' : '#888';
            return `${val || 0}% <span style="color:${color}">(${num}%)</span>`;
        };

        Object.keys(counts.rows).forEach(key => {
            const el = document.getElementById(`total-${key}`);
            el && (el.innerHTML = render(counts.rows[key], counts.rowsSel[key]));
        });
        Object.keys(counts.cols).forEach(key => {
            const el = document.getElementById(`total-${key}`);
            el && (el.innerHTML = render(counts.cols[key], counts.colsSel[key]));
        });

        document.getElementById('grand-total').innerHTML = renderGrand(counts.total, selectedPips.size);
    }

    // Snapshot Logic
    const snapshotBtn = document.getElementById('snapshot-btn');
    if (snapshotBtn) {
        snapshotBtn.addEventListener('click', async () => {
            snapshotBtn.disabled = true;
            snapshotBtn.innerText = 'Capturing...';

            try {
                // Capture the grid area only.
                // The pips are in an overlay (#hexagon-container), but capturing document.body includes them.
                // We just need to define the crop area using the table's dimensions.
                const table = document.querySelector('table');
                const rect = table.getBoundingClientRect();

                const canvas = await html2canvas(document.body, {
                    backgroundColor: '#f4f4f4', // Match body bg
                    // Crop to table area
                    x: rect.left + window.scrollX,
                    y: rect.top + window.scrollY,
                    width: rect.width,
                    height: rect.height,
                    ignoreElements: (element) => {
                        // Still ignore the undo container inside the body render just in case
                        if (element.id === 'undo-container') return true;
                        if (element.classList.contains('selection-box')) return true;
                        return false;
                    }
                });

                canvas.toBlob(async (blob) => {
                    try {
                        const item = new ClipboardItem({ 'image/png': blob });
                        await navigator.clipboard.write([item]);
                        snapshotBtn.innerText = 'Copied!';
                    } catch (err) {
                        console.error('Clipboard write failed', err);
                        snapshotBtn.innerText = 'Error';
                    }
                    setTimeout(() => {
                        snapshotBtn.innerText = 'Snapshot';
                        snapshotBtn.disabled = false;
                    }, 2000);
                });
            } catch (err) {
                console.error('Snapshot failed', err);
                snapshotBtn.innerText = 'Error';
                setTimeout(() => {
                    snapshotBtn.innerText = 'Snapshot';
                    snapshotBtn.disabled = false;
                }, 2000);
            }
        });
    }
});
