document.addEventListener('DOMContentLoaded', () => {
    // Config
    const PIP_SIZE = 20; // Pip diameter in px, also the collision distance
    const PIP_RADIUS = PIP_SIZE / 2;

    // Pip positions live in the DOM (style.left/top); everything else --
    // counts, totals, the URL -- is derived from them.

    // URL Encoding Helpers
    const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    function toBase62(n) {
        if (n === 0n) return "0";
        let str = "";
        while (n > 0n) {
            str = BASE62[Number(n % 62n)] + str;
            n /= 62n;
        }
        return str;
    }

    function fromBase62(s) {
        let n = 0n;
        for (let i = 0; i < s.length; i++) {
            n = n * 62n + BigInt(BASE62.indexOf(s[i]));
        }
        return n;
    }

    // nCr for BigInt
    function nCr(n, r) {
        if (r < 0n || r > n) return 0n;
        if (r === 0n || r === n) return 1n;
        if (r > n / 2n) r = n - r;

        let res = 1n;
        for (let i = 1n; i <= r; i++) {
            res = res * (n - i + 1n) / i;
        }
        return res;
    }

    // The 25 buckets (5 rows x 5 columns) as {r, c} pairs in a canonical
    // order, built during init below
    let BUCKET_ORDER = [];

    // Undo/redo stacks: snapshots of every pip's position
    const historyStack = [];
    const redoStack = [];
    let isUndoing = false;

    // Helper: Normalize Pointer Events (returns page coordinates)
    function getPointerPos(e) {
        if (e.touches && e.touches.length > 0) {
            return {
                x: e.touches[0].clientX + window.scrollX,
                y: e.touches[0].clientY + window.scrollY
            };
        }
        return {
            x: e.clientX + window.scrollX,
            y: e.clientY + window.scrollY
        };
    }

    // Cached row/column pixel bounds (page coordinates) so per-frame
    // counting during drags avoids layout queries
    let cachedRowBounds = [];
    let cachedColBounds = [];

    // Selection
    const selectedPips = new Set();
    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.id = 'selection-box';

    // Add resize handles
    ['nw', 'ne', 'sw', 'se'].forEach(pos => {
        const handle = document.createElement('div');
        handle.className = `resize-handle ${pos}`;
        handle.dataset.handle = pos;
        selectionBox.appendChild(handle);
    });

    document.body.appendChild(selectionBox);

    // Box manipulation state
    let isMovingBox = false;
    let isResizingBox = false;
    let resizeHandle = null;
    let boxMoveStartX, boxMoveStartY;
    let boxInitialLeft, boxInitialTop, boxInitialWidth, boxInitialHeight;

    const hexagonContainer = document.getElementById('hexagon-container');
    const undoContainer = document.getElementById('undo-container');

    // Undo button (created here rather than in HTML so `undo` is in scope)
    const undoButton = document.createElement('button');
    undoButton.className = 'icon-btn';
    undoButton.innerText = '↩';
    undoButton.title = 'Undo';
    undoButton.disabled = true;
    undoButton.addEventListener('click', undo);
    undoContainer.appendChild(undoButton);

    const redoButton = document.createElement('button');
    redoButton.className = 'icon-btn';
    redoButton.innerText = '↪';
    redoButton.title = 'Redo';
    redoButton.disabled = true;
    redoButton.addEventListener('click', redo);
    undoContainer.appendChild(redoButton);

    // State for Box Selection
    let isBoxSelecting = false;
    let preventClearSelection = false; // Stops the click after a box drag from clearing the selection
    let boxStartX, boxStartY;

    // Hex grid for snap targets: offset rows, packed tighter vertically
    // than the pip size for a honeycomb feel
    const hexSize = 20;
    const horizontalSpacing = hexSize * 1.0;
    const verticalSpacing = hexSize * 0.8;

    // Neighbor offsets for the spiral searches; offset rows alternate
    // between these two sets
    const HEX_DIRS_EVEN = [
        { dRow: -1, dCol: -1 }, { dRow: -1, dCol: 0 },
        { dRow: 0, dCol: -1 }, { dRow: 0, dCol: 1 },
        { dRow: 1, dCol: -1 }, { dRow: 1, dCol: 0 }
    ];
    const HEX_DIRS_ODD = [
        { dRow: -1, dCol: 0 }, { dRow: -1, dCol: 1 },
        { dRow: 0, dCol: -1 }, { dRow: 0, dCol: 1 },
        { dRow: 1, dCol: 0 }, { dRow: 1, dCol: 1 }
    ];

    function getGridPos(x, y) {
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
    // Column keys come from the DOM so the HTML stays the source of truth
    const colHeaderCells = document.querySelectorAll('thead th[data-col]');
    const COL_KEYS = Array.from(colHeaderCells).map(th => th.dataset.col);

    // BUCKET_ORDER is bottom-up row-major: the annual and decennial rows
    // are usually the emptiest, and empty buckets early in the order give
    // small bar positions in the combinadic encoding (see
    // encodeDistribution), hence shorter URLs
    ['annual', 'decennial', 'centennial', 'millenary', 'epochal'].forEach(r => {
        COL_KEYS.forEach(c => {
            BUCKET_ORDER.push({ r, c });
        });
    });

    // Check URL for state
    const urlParams = new URLSearchParams(window.location.search);
    const stateStr = urlParams.get('d');

    let initialDistribution = null;
    if (stateStr) {
        try {
            initialDistribution = decodeDistribution(stateStr);
        } catch (e) {
            console.error("Invalid state string", e);
        }
    }

    // Note on the annual row: it has one merged cell rather than per-column
    // prob-cells, so bucket membership there is decided by x-position, and
    // placement rects come from crossing the row with the column headers.

    const allPips = []; // {el, id}; placePipsFromDistribution adds .x/.y

    // Create the 100 pips, 1% each
    for (let i = 0; i < 100; i++) {
        const pip = document.createElement('div');
        pip.classList.add('hexagon');
        pip.setAttribute('draggable', 'false');
        pip.id = `pip-${i}`;
        pip.innerHTML = `<svg viewBox="0 0 100 100" width="20" height="20"><polygon points="50,0 93,25 93,75 50,100 7,75 7,25" fill="#000000"/></svg>`;

        pip.style.position = 'absolute'; // Positioned below, once all exist
        pip.addEventListener('mousedown', (e) => handlePipMouseDown(e, pip));
        pip.addEventListener('touchstart', (e) => handlePipMouseDown(e, pip), { passive: false });
        hexagonContainer.appendChild(pip);
        allPips.push({ el: pip, id: pip.id });
    }

    if (initialDistribution) {
        placePipsFromDistribution(initialDistribution, allPips);
    } else {
        placePipsRandomly(allPips);
    }

    updateCounters();
    updateSelectionUI();

    function placePipsRandomly(pips) {
        // Default layout: 5% in each of the 20 main cells, annual row
        // empty. BUCKET_ORDER is bottom-up, so indices 0-4 are annual.
        const counts = Array(25).fill(0);
        for (let i = 5; i < 25; i++) {
            counts[i] = 5;
        }
        placePipsFromDistribution(counts, pips);
    }

    // counts: 25 numbers in BUCKET_ORDER order, summing to 100. Pips get
    // random non-overlapping positions within their bucket's rect.
    function placePipsFromDistribution(counts, pips) {
        let pipCursor = 0;

        counts.forEach((count, idx) => {
            if (count === 0) return;

            const bucket = BUCKET_ORDER[idx]; // {r, c}

            // Bucket rect = row bounds x column-header bounds (the annual
            // row falls back to its merged-row tr)
            const rowTr = document.querySelector(`tr[data-row="${bucket.r}"]`) || document.querySelector(`tr.annual-row`);
            const rowRect = rowTr.getBoundingClientRect();
            const top = rowRect.top + window.scrollY;
            const height = rowRect.height;

            const colTh = document.querySelector(`th[data-col="${bucket.c}"]`);
            const colRect = colTh.getBoundingClientRect();
            const left = colRect.left + window.scrollX;
            const width = colRect.width;

            for (let k = 0; k < count; k++) {
                if (pipCursor >= pips.length) break;
                const pip = pips[pipCursor];

                let x, y, attempts = 0;
                let valid = false;

                // Random spot in the rect, collision-checked against the
                // pips placed earlier in this pass; after max attempts we
                // accept overlap rather than loop forever
                while (!valid && attempts < 500) {
                    x = Math.random() * (width - PIP_SIZE) + left;
                    y = Math.random() * (height - PIP_SIZE) + top;

                    let collision = false;
                    for (let j = 0; j < pipCursor; j++) {
                        const other = pips[j];
                        const ox = other.x;
                        const oy = other.y;

                        const dist = Math.sqrt((x - ox) ** 2 + (y - oy) ** 2);
                        if (dist < PIP_SIZE) {
                            collision = true;
                            break;
                        }
                    }
                    if (!collision) valid = true;
                    attempts++;
                }

                pip.el.style.left = x + 'px';
                pip.el.style.top = y + 'px';
                // Cached for the collision checks above
                pip.x = x;
                pip.y = y;

                pipCursor++;
            }
        });
    }

    // Serialize the current distribution as a base-62 string for the URL.
    // Stars and bars: a distribution of 100 pips over 25 buckets is a
    // choice of 24 bar positions among 124 slots, and the combinatorial
    // number system maps that choice to a single integer.
    function encodeDistribution() {
        // Recount pips into buckets from their current DOM positions
        updateGridBounds();

        const bucketCounts = Array(25).fill(0);
        const pips = document.querySelectorAll('.hexagon');

        pips.forEach(pip => {
            const l = parseFloat(pip.style.left);
            const t = parseFloat(pip.style.top);
            const cx = l + PIP_RADIUS;
            const cy = t + PIP_RADIUS;

            let rKey = null, cKey = null;

            // Find Row
            for (const r of cachedRowBounds) {
                if (cy >= r.top && cy <= r.bottom) {
                    rKey = r.key;
                    break;
                }
            }
            // Find Col
            for (const c of cachedColBounds) {
                if (cx >= c.left && cx <= c.right) {
                    cKey = c.key;
                    break;
                }
            }

            let idx = -1;

            if (rKey && cKey) {
                idx = BUCKET_ORDER.findIndex(b => b.r === rKey && b.c === cKey);
            }

            if (idx !== -1) {
                bucketCounts[idx]++;
            } else {
                // Off-grid pips map to the nearest bucket center so the
                // 100-pip invariant survives encoding
                let minDist = Infinity;
                let bestIdx = 0;

                BUCKET_ORDER.forEach((b, bIdx) => {
                    const r = cachedRowBounds.find(rb => rb.key === b.r);
                    const c = cachedColBounds.find(cb => cb.key === b.c);

                    if (r && c) {
                        const centerX = (c.left + c.right) / 2;
                        const centerY = (r.top + r.bottom) / 2;

                        const dist = Math.sqrt((cx - centerX) ** 2 + (cy - centerY) ** 2);
                        if (dist < minDist) {
                            minDist = dist;
                            bestIdx = bIdx;
                        }
                    }
                });

                bucketCounts[bestIdx]++;
            }
        });

        const sum = bucketCounts.reduce((a, b) => a + b, 0);
        if (sum !== 100) {
            // Should not happen; the nearest-bucket fallback catches all pips
            bucketCounts[0] += (100 - sum);
        }

        // Lay the buckets out as pips and bars: * * * | * * | ... over slot
        // indices 0..123. Bar i sits at (pips so far) + (bars so far), so
        // the bar positions are strictly increasing.
        const bars = [];
        let currentPos = 0;
        for (let i = 0; i < 24; i++) {
            currentPos += bucketCounts[i];
            bars.push(BigInt(currentPos + i));
        }

        // Combinatorial number system: a strictly increasing sequence
        // b0 < b1 < ... < b23 maps to the unique index
        // Sum_k nCr(b_k, k+1)
        let index = 0n;
        for (let k = 0; k < 24; k++) {
            index += nCr(bars[k], BigInt(k + 1));
        }

        return toBase62(index);
    }

    // Inverse of encodeDistribution: base-62 string back to bucket counts
    function decodeDistribution(str) {
        let index = fromBase62(str);

        // Recover the bar positions greedily from the largest k down:
        // b_k is the largest v with nCr(v, k+1) <= the remaining index.
        // A linear scan down from the previous bar is fast enough.
        const bars = new Array(24);

        for (let k = 23; k >= 0; k--) {
            const r = BigInt(k + 1);
            let v = (k === 23) ? 123n : bars[k + 1] - 1n;

            while (true) {
                const val = nCr(v, r);
                if (val <= index) {
                    index -= val;
                    bars[k] = v;
                    break;
                }
                v--;
            }
        }

        // Bucket counts are the gaps between consecutive bars; the last
        // bucket is whatever remains of the 100
        const counts = [];
        let prev = -1n;
        for (let i = 0; i < 24; i++) {
            counts.push(Number(bars[i] - prev - 1n));
            prev = bars[i];
        }
        const currentSum = counts.reduce((a, b) => a + b, 0);
        counts.push(100 - currentSum);

        return counts;
    }

    function updateUrlState() {
        const code = encodeDistribution();
        const newUrl = `${window.location.pathname}?d=${code}`;
        window.history.replaceState({ path: newUrl }, '', newUrl);
        syncPresetSelect();
    }




    // Unified Box Selection Start (Mouse & Touch)
    let boxSelectionFrame = null;
    let allPipsInitialPositions = new Map();

    function handleBoxStart(e) {
        let validStart = false;
        const target = e.target;

        // Restriction: Only start box selection on cells where pips can live
        const isPipCell = target.closest('.prob-cell') || target.closest('.annual-merged-cell');

        if (e.type === 'mousedown') {
            if (e.target.closest('.hexagon')) return;
            if (e.target.closest('button')) return;
            if (e.button !== 0) return;
            if (isPipCell) validStart = true;
        } else if (e.type === 'touchstart') {
            if (e.target.closest('.hexagon')) return;
            if (e.target.closest('button')) return;
            if (e.target.closest('#undo-container')) return;

            if (isPipCell) {
                validStart = true;
            }
        }

        if (!validStart) return;

        // Start a new box selection
        e.preventDefault(); // Stop scroll etc
        clearSelection();

        isBoxSelecting = true;
        const pos = getPointerPos(e);
        boxStartX = pos.x;
        boxStartY = pos.y;

        selectionBox.style.left = boxStartX + 'px';
        selectionBox.style.top = boxStartY + 'px';
        selectionBox.style.width = '0px';
        selectionBox.style.height = '0px';
        selectionBox.style.display = 'block';
        // Hide cell steppers while the box is up: they sit above the box in
        // z-order and would steal clicks meant for its handles
        document.body.classList.add('box-active');

        // Snapshot ALL pips for layouts and restoration
        allPipsInitialPositions.clear();
        document.querySelectorAll('.hexagon').forEach(pip => {
            allPipsInitialPositions.set(pip, {
                left: parseFloat(pip.style.left),
                top: parseFloat(pip.style.top)
            });
        });

        saveHistory();
    }

    document.addEventListener('mousedown', handleBoxStart);
    document.addEventListener('touchstart', handleBoxStart, { passive: false });

    function handleBoxMove(e) {
        if (!isBoxSelecting) return;
        if (e.type === 'touchmove') e.preventDefault(); // Stop scroll

        const pos = getPointerPos(e);
        const currentX = pos.x;
        const currentY = pos.y;

        const minX = Math.min(boxStartX, currentX);
        const minY = Math.min(boxStartY, currentY);
        const width = Math.abs(currentX - boxStartX);
        const height = Math.abs(currentY - boxStartY);

        selectionBox.style.left = minX + 'px';
        selectionBox.style.top = minY + 'px';
        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';


        if (boxSelectionFrame) return;
        boxSelectionFrame = requestAnimationFrame(() => {
            updateSelectionVisuals(minX, minY, minX + width, minY + height);
            boxSelectionFrame = null;
        });
    }

    function updateSelectionVisuals(boxLeft, boxTop, boxRight, boxBottom) {
        const allPips = document.querySelectorAll('.hexagon');

        allPips.forEach(pip => {
            const init = allPipsInitialPositions.get(pip);
            if (!init) return; // Should not happen

            const cx = parseFloat(pip.style.left) + PIP_RADIUS;
            const cy = parseFloat(pip.style.top) + PIP_RADIUS;

            if (cx >= boxLeft && cx <= boxRight && cy >= boxTop && cy <= boxBottom) {
                if (!selectedPips.has(pip)) {
                    selectedPips.add(pip);
                    pip.classList.add('selected');
                }
            } else {
                if (selectedPips.has(pip)) {
                    selectedPips.delete(pip);
                    pip.classList.remove('selected');
                }
            }
        });

        updateCounters();
        updateSelectionUI(); // Enable/Disable buttons based on selection
    }


    document.addEventListener('mousemove', handleBoxMove);
    document.addEventListener('touchmove', handleBoxMove, { passive: false });

    function handleBoxEnd(e) {
        if (isBoxSelecting) {
            if (e.type === 'touchend') e.preventDefault(); // Prevent synthetic click
            isBoxSelecting = false;
            if (boxSelectionFrame) cancelAnimationFrame(boxSelectionFrame);
            boxSelectionFrame = null;

            // The box persists after mouseup so Squish/Spread can use it
            if (selectedPips.size > 0) {
                lastSelectionBounds = {
                    left: parseFloat(selectionBox.style.left),
                    top: parseFloat(selectionBox.style.top),
                    width: parseFloat(selectionBox.style.width),
                    height: parseFloat(selectionBox.style.height)
                };

                // Prevent the subsequent 'click' event from clearing this selection
                preventClearSelection = true;
                setTimeout(() => {
                    preventClearSelection = false;
                }, 500); // Long enough for mobile synthetic click events
            } else {
                clearSelection();
            }
        }
    }

    function clearSelection() {
        selectedPips.forEach(pip => pip.classList.remove('selected'));
        selectedPips.clear();
        selectionBox.style.display = 'none';
        document.body.classList.remove('box-active');
        lastSelectionBounds = null;
        updateCounters();
        updateSelectionUI(); // button state
    }

    document.addEventListener('mouseup', handleBoxEnd);
    document.addEventListener('touchend', handleBoxEnd);

    // --- Box Move/Resize Handlers ---
    selectionBox.addEventListener('mousedown', handleBoxManipStart);
    selectionBox.addEventListener('touchstart', handleBoxManipStart, { passive: false });

    function handleBoxManipStart(e) {
        if (isBoxSelecting) return; // Don't interfere with new box creation

        const pos = getPointerPos(e);
        boxMoveStartX = pos.x;
        boxMoveStartY = pos.y;
        boxInitialLeft = parseFloat(selectionBox.style.left);
        boxInitialTop = parseFloat(selectionBox.style.top);
        boxInitialWidth = parseFloat(selectionBox.style.width);
        boxInitialHeight = parseFloat(selectionBox.style.height);

        // Check if clicking a resize handle
        const handle = e.target.closest('.resize-handle');
        if (handle) {
            isResizingBox = true;
            resizeHandle = handle.dataset.handle;
            e.preventDefault();
            e.stopPropagation();
        } else if (e.target === selectionBox) {
            // Clicking box itself = move
            isMovingBox = true;
            e.preventDefault();
            e.stopPropagation();
        }

        if (isMovingBox || isResizingBox) {
            document.addEventListener('mousemove', handleBoxManipMove);
            document.addEventListener('mouseup', handleBoxManipEnd);
            document.addEventListener('touchmove', handleBoxManipMove, { passive: false });
            document.addEventListener('touchend', handleBoxManipEnd);
        }
    }

    function handleBoxManipMove(e) {
        if (!isMovingBox && !isResizingBox) return;
        e.preventDefault();

        const pos = getPointerPos(e);
        const dx = pos.x - boxMoveStartX;
        const dy = pos.y - boxMoveStartY;

        if (isMovingBox) {
            selectionBox.style.left = (boxInitialLeft + dx) + 'px';
            selectionBox.style.top = (boxInitialTop + dy) + 'px';
        } else if (isResizingBox) {
            let newLeft = boxInitialLeft;
            let newTop = boxInitialTop;
            let newWidth = boxInitialWidth;
            let newHeight = boxInitialHeight;

            if (resizeHandle.includes('e')) {
                newWidth = Math.max(20, boxInitialWidth + dx);
            }
            if (resizeHandle.includes('w')) {
                newWidth = Math.max(20, boxInitialWidth - dx);
                newLeft = boxInitialLeft + dx;
            }
            if (resizeHandle.includes('s')) {
                newHeight = Math.max(20, boxInitialHeight + dy);
            }
            if (resizeHandle.includes('n')) {
                newHeight = Math.max(20, boxInitialHeight - dy);
                newTop = boxInitialTop + dy;
            }

            selectionBox.style.left = newLeft + 'px';
            selectionBox.style.top = newTop + 'px';
            selectionBox.style.width = newWidth + 'px';
            selectionBox.style.height = newHeight + 'px';
        }

        // Update lastSelectionBounds for Spread to use
        lastSelectionBounds = {
            left: parseFloat(selectionBox.style.left),
            top: parseFloat(selectionBox.style.top),
            width: parseFloat(selectionBox.style.width),
            height: parseFloat(selectionBox.style.height)
        };
    }

    function handleBoxManipEnd(e) {
        if (isMovingBox || isResizingBox) {
            // Reselect pips that are now inside the box
            updatePipsInBox();
            preventClearSelection = true;
            setTimeout(() => preventClearSelection = false, 300);
        }
        isMovingBox = false;
        isResizingBox = false;
        resizeHandle = null;
        document.removeEventListener('mousemove', handleBoxManipMove);
        document.removeEventListener('mouseup', handleBoxManipEnd);
        document.removeEventListener('touchmove', handleBoxManipMove);
        document.removeEventListener('touchend', handleBoxManipEnd);
    }

    function updatePipsInBox() {
        if (!lastSelectionBounds) return;
        const { left, top, width, height } = lastSelectionBounds;
        const boxRight = left + width;
        const boxBottom = top + height;

        // Clear and reselect
        selectedPips.forEach(pip => pip.classList.remove('selected'));
        selectedPips.clear();

        document.querySelectorAll('.hexagon').forEach(pip => {
            const cx = parseFloat(pip.style.left) + PIP_RADIUS;
            const cy = parseFloat(pip.style.top) + PIP_RADIUS;
            if (cx >= left && cx <= boxRight && cy >= top && cy <= boxBottom) {
                selectedPips.add(pip);
                pip.classList.add('selected');
            }
        });

        updateCounters();
        updateSelectionUI();
    }

    // Helper functions for Smart Placement
    // Reserve the nearest grid slot of every pip not in the excluded set
    function getOccupiedSlots(excludePipsSet = new Set()) {
        const occupied = {};
        const allPips = document.querySelectorAll('.hexagon');
        allPips.forEach(p => {
            if (!excludePipsSet.has(p)) {
                const pos = getGridPos(parseFloat(p.style.left), parseFloat(p.style.top));
                occupied[`${pos.row}_${pos.col}`] = true;
            }
        });
        return occupied;
    }

    // Breadth-first spiral outward from the target point to the first
    // unoccupied hex-grid slot
    function findNearestFreeSlot(targetX, targetY, occupiedSlotsMap) {
        const startGrid = getGridPos(targetX, targetY);

        const queue = [{ row: startGrid.row, col: startGrid.col }];
        const visited = new Set([`${startGrid.row}_${startGrid.col}`]);

        let qIndex = 0;
        while (qIndex < 3000 && qIndex < queue.length) {
            const curr = queue[qIndex++];
            const key = `${curr.row}_${curr.col}`;

            if (!occupiedSlotsMap[key]) {
                return curr;
            }

            const dirs = (Math.abs(curr.row) % 2 === 0) ? HEX_DIRS_EVEN : HEX_DIRS_ODD;
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
        return startGrid; // Fallback
    }

    // Selection helpers
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


    // Drag Logic
    function handlePipMouseDown(e, pip) {
        // Allow left click or touch
        if (e.type === 'mousedown' && e.button !== 0) return;
        if (e.type === 'touchstart') e.preventDefault(); // Stop mouse emulation

        // Shift-click toggles membership in the selection
        if (e.shiftKey) {
            if (selectedPips.has(pip)) {
                deselectPip(pip);
            } else {
                selectPip(pip);
                saveHistory(); // Snapshot before pack
                packSelection();
            }
            e.stopPropagation();
            return;
        }

        if (!selectedPips.has(pip)) {
            clearSelection();
            selectPip(pip);
            // No auto-pack here: a drag is probably starting and packing
            // now would yank the pip away from the cursor
        }

        e.stopPropagation();
        startDrag(e);
    }

    function startDrag(e) {
        const pos = getPointerPos(e);
        const startX = pos.x;
        const startY = pos.y;

        // Cache bounds for real-time updates
        updateGridBounds();

        const initialPositions = new Map();
        selectedPips.forEach(pip => {
            initialPositions.set(pip, {
                left: parseFloat(pip.style.left),
                top: parseFloat(pip.style.top)
            });
        });

        saveHistory(); // Snapshot the pre-drag state for undo

        document.body.style.userSelect = 'none';

        // Add dragging class for performance
        selectedPips.forEach(pip => pip.classList.add('dragging'));

        let hasMoved = false;



        function move(e) {
            if (e.type === 'touchmove') e.preventDefault(); // Prevent scrolling
            const p = getPointerPos(e);
            const dx = p.x - startX;
            const dy = p.y - startY;

            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved = true;

            selectedPips.forEach(pip => {
                const init = initialPositions.get(pip);
                pip.style.left = (init.left + dx) + 'px';
                pip.style.top = (init.top + dy) + 'px';
            });

            updateCounters(true); // Cached bounds; cheap enough per mousemove
        }

        function stop(e) {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', stop);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', stop);
            document.body.style.userSelect = '';

            // Remove dragging class
            selectedPips.forEach(pip => pip.classList.remove('dragging'));

            if (!hasMoved) {
                // A plain click (no drag) packs the selection in place
                packSelection();
                return;
            }

            // Smart placement on drop: a clean drop stays exactly where the
            // user put it; only pips that collide get snapped to the
            // nearest free hex-grid slot.
            const allPips = document.querySelectorAll('.hexagon');

            // Slots taken by unselected pips are static walls; slots taken
            // by pips placed earlier in this loop accumulate on top
            const occupiedSlots = getOccupiedSlots(selectedPips);

            selectedPips.forEach(pip => {
                const currentLeft = parseFloat(pip.style.left);
                const currentTop = parseFloat(pip.style.top);
                const cx = currentLeft + 10;
                const cy = currentTop + 10;

                let collision = false;

                // Trigger on visual overlap with unselected pips only:
                // selected pips kept their relative spacing during the
                // group drag, and occupiedSlots resolves any pile-ups
                for (let other of allPips) {
                    if (pip === other) continue;
                    if (selectedPips.has(other)) continue;

                    const r2 = other.getBoundingClientRect();
                    const cx2 = r2.left + r2.width / 2;
                    const cy2 = r2.top + r2.height / 2;

                    const dist = Math.sqrt((cx - cx2) ** 2 + (cy - cy2) ** 2);
                    if (dist < 20) {
                        collision = true;
                        break;
                    }
                }

                // Even without visual overlap, the landing slot may already
                // be reserved by a pip placed earlier in this loop
                const myGrid = getGridPos(currentLeft, currentTop);
                if (occupiedSlots[`${myGrid.row}_${myGrid.col}`]) {
                    collision = true;
                }

                if (collision) {
                    const target = findNearestFreeSlot(currentLeft, currentTop, occupiedSlots);
                    const pos = getScreenPos(target.row, target.col);

                    pip.style.left = pos.x + 'px';
                    pip.style.top = pos.y + 'px';

                    occupiedSlots[`${target.row}_${target.col}`] = true;
                } else {
                    // Leave it loose but reserve its nearest slot so later
                    // pips in this loop don't land on it
                    occupiedSlots[`${myGrid.row}_${myGrid.col}`] = true;
                }
            });

            updateCounters();
            updateUrlState();
        }

        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', stop);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', stop);
    }

    function packSelection() {
        if (selectedPips.size === 0) return;

        // Use center of selection box if available, otherwise fall back to centroid
        let centerX, centerY;
        if (lastSelectionBounds) {
            centerX = lastSelectionBounds.left + lastSelectionBounds.width / 2;
            centerY = lastSelectionBounds.top + lastSelectionBounds.height / 2;
        } else {
            // Fallback: calculate centroid of selected pips
            let sumX = 0, sumY = 0;
            selectedPips.forEach(pip => {
                sumX += parseFloat(pip.style.left);
                sumY += parseFloat(pip.style.top);
            });
            centerX = sumX / selectedPips.size;
            centerY = sumY / selectedPips.size;
        }

        // One spiral search out from the center gathers as many free slots
        // as the selection needs, skipping slots held by unselected pips
        const occupiedGrid = getOccupiedSlots(selectedPips);
        const targetSlots = [];
        const centerGrid = getGridPos(centerX, centerY);

        const queue = [{ row: centerGrid.row, col: centerGrid.col }];
        const visited = new Set([`${centerGrid.row}_${centerGrid.col}`]);

        let qIndex = 0;
        while (targetSlots.length < selectedPips.size && qIndex < 3000) {
            if (qIndex >= queue.length) break;
            const curr = queue[qIndex++];
            const key = `${curr.row}_${curr.col}`;

            if (!occupiedGrid[key]) {
                targetSlots.push(curr);
                occupiedGrid[key] = true;
            }

            const dirs = (Math.abs(curr.row) % 2 === 0) ? HEX_DIRS_EVEN : HEX_DIRS_ODD;
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
        updateUrlState(); // Save to URL on pack
    }

    function snapshotPips() {
        const snapshot = [];
        document.querySelectorAll('.hexagon').forEach(pip => {
            snapshot.push({
                id: pip.id,
                left: pip.style.left,
                top: pip.style.top
            });
        });
        return snapshot;
    }

    function applyPipState(state) {
        state.forEach(item => {
            const pip = document.getElementById(item.id);
            if (pip) {
                pip.style.left = item.left;
                pip.style.top = item.top;
            }
        });
        updateCounters();
        updateUrlState();
        updateSelectionUI();
    }

    function saveHistory() {
        if (isUndoing) return;
        historyStack.push(snapshotPips());
        if (historyStack.length > 50) historyStack.shift();
        redoStack.length = 0; // A new action forks history; redo dies
        updateSelectionUI(); // Update button state
    }

    // Every interaction pushes the pre-change state right before changing
    // anything, so undo pops it back and stashes the current state for redo
    function undo() {
        if (historyStack.length === 0) return;
        isUndoing = true;
        redoStack.push(snapshotPips());
        applyPipState(historyStack.pop());
        isUndoing = false;
    }

    function redo() {
        if (redoStack.length === 0) return;
        isUndoing = true;
        historyStack.push(snapshotPips());
        applyPipState(redoStack.pop());
        isUndoing = false;
    }

    function updateCounters(useCache = false) {
        !useCache && updateGridBounds();

        const counts = {
            rows: {},
            cols: {},
            cells: {},
            rowsSel: {},
            colsSel: {},
            cellsSel: {},
            total: 0,
            totalSel: 0
        };

        // Reset displayed totals (innerHTML because of the selection spans)
        const resetEl = el => el.innerHTML = '0%';
        document.querySelectorAll('.row-total').forEach(resetEl);
        document.querySelectorAll('.col-total').forEach(resetEl);
        document.getElementById('grand-total').innerHTML = '0%';

        // Wipe the per-cell overlays (counts + steppers); they're
        // re-rendered below. Setting innerText clears all children, which
        // would eat the annual cell's static threshold-label, so that cell
        // gets its overlays removed individually instead.
        document.querySelectorAll('.prob-cell').forEach(el => !el.classList.contains('annual-merged-cell') && (el.innerText = ''));

        const annualCell = document.querySelector('.annual-merged-cell');
        const existingAnnualCount = annualCell.querySelector('.cell-count');
        if (existingAnnualCount) existingAnnualCount.remove();

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

            if (rowKey && colKey) {
                counts.rows[rowKey] = (counts.rows[rowKey] || 0) + 1;
                isSel && (counts.rowsSel[rowKey] = (counts.rowsSel[rowKey] || 0) + 1);

                counts.cols[colKey] = (counts.cols[colKey] || 0) + 1;
                isSel && (counts.colsSel[colKey] = (counts.colsSel[colKey] || 0) + 1);

                const cellKey = `${rowKey}_${colKey}`;
                counts.cells[cellKey] = (counts.cells[cellKey] || 0) + 1;
                isSel && (counts.cellsSel[cellKey] = (counts.cellsSel[cellKey] || 0) + 1);

                counts.total++;
                isSel && counts.totalSel++;
            }
        });

        // Row/column totals: "20%" plus a red "(5%)" for the selected share
        const render = (val, selVal) => {
            return `${val || 0}%${(selVal > 0) ? ` <span style="color:#d03b3b">(${selVal}%)</span>` : ''}`;
        };

        // Per-cell counts: same format, but empty cells show nothing to
        // reduce clutter
        const renderCell = (val, selVal) => {
            if (!val && !selVal) return '';

            const mainNum = val || 0;
            const selNum = selVal || 0;

            let html = `${mainNum}%`;
            if (selNum > 0) {
                html += ` <span style="color:#d03b3b">(${selNum}%)</span>`;
            }
            return html;
        };

        // Grand total: the parenthetical shows the selected share in red,
        // or, when nothing is selected, the off-grid share in gray
        const renderGrand = (val, selVal) => {
            const outside = 100 - val;
            const showSelected = selVal > 0;
            const num = showSelected ? selVal : outside;
            const color = showSelected ? '#d03b3b' : '#898781';
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

        // Per-cell counts for the 20 regular cells
        document.querySelectorAll('.prob-cell').forEach(cell => {
            if (cell.classList.contains('annual-merged-cell')) return;

            const parentRow = cell.closest('tr');
            const rKey = parentRow ? parentRow.dataset.row : null;
            const cKey = cell.dataset.col;

            if (rKey && cKey) {
                const key = `${rKey}_${cKey}`;
                const val = counts.cells[key];
                const selVal = counts.cellsSel[key];

                const html = renderCell(val, selVal);
                if (html) {
                    const div = document.createElement('div');
                    div.className = 'cell-count';
                    div.innerHTML = html;
                    cell.appendChild(div);
                }
            }
        });

        // 2. Annual Merged Cell
        // It represents the entire 'annual' row.
        const annualVal = counts.rows['annual'];
        const annualSel = counts.rowsSel['annual'];
        const annualHtml = renderCell(annualVal, annualSel);

        if (annualHtml) {
            const div = document.createElement('div');
            div.className = 'cell-count';
            div.innerHTML = annualHtml;
            // Ensure we don't clobber the threshold-label
            annualCell.appendChild(div);
        }

        // 3. Cell Steppers (+/− controls)
        // Re-rendered on every update so the disabled states stay correct.
        // (The prob cells were wiped above; the annual cell needs explicit removal.)
        const renderStepper = (rKey, cKey, count) => {
            const emptyDisabled = count === 0 ? ' disabled' : '';
            // No pips anywhere else to pull from
            const plusDisabled = counts.total - count === 0 ? ' disabled' : '';
            const at = `data-r="${rKey}" data-c="${cKey}"`;
            const div = document.createElement('div');
            div.className = 'cell-stepper';
            div.innerHTML =
                `<button class="stepper-btn" ${at} data-delta="-1"` +
                ` title="Move 1% to the biggest pile"${emptyDisabled}>&minus;</button>` +
                `<button class="stepper-btn" ${at} data-delta="1"` +
                ` title="Move 1% here from the biggest pile"${plusDisabled}>+</button>` +
                `<button class="stepper-btn" ${at} data-act="pack"` +
                ` title="Gather these pips"${emptyDisabled}>⊕</button>` +
                `<button class="stepper-btn" ${at} data-act="spread"` +
                ` title="Spread these pips out"${emptyDisabled}>⊞</button>`;
            return div;
        };

        document.querySelectorAll('.prob-cell').forEach(cell => {
            if (cell.classList.contains('annual-merged-cell')) return;

            const parentRow = cell.closest('tr');
            const rKey = parentRow ? parentRow.dataset.row : null;
            const cKey = cell.dataset.col;

            if (rKey && cKey) {
                cell.appendChild(renderStepper(rKey, cKey, counts.cells[`${rKey}_${cKey}`] || 0));
            }
        });

        const existingAnnualStepper = annualCell.querySelector('.cell-stepper');
        if (existingAnnualStepper) existingAnnualStepper.remove();
        // The annual cell spans all 5 columns; '*' means the whole row.
        annualCell.appendChild(renderStepper('annual', '*', counts.rows['annual'] || 0));

        // Row and column totals get steppers too, targeting the whole row
        // or column. (Not the grand total: it's pinned at 100%.)
        cachedRowBounds.forEach(r => {
            const el = document.getElementById(`total-${r.key}`);
            el && el.appendChild(renderStepper(r.key, '*', counts.rows[r.key] || 0));
        });
        cachedColBounds.forEach(c => {
            const el = document.getElementById(`total-${c.key}`);
            el && el.appendChild(renderStepper('*', c.key, counts.cols[c.key] || 0));
        });
    }

    // --- Steppers ---
    // Move one pip (1%) into or out of a target without dragging. A target
    // is a cell, a whole row (colKey '*'), or a whole column (rowKey '*').
    // The counterpart is always the fullest bucket outside the target, so
    // + takes from the biggest outside pile and − sends back to it; within
    // the target, + grows its fullest bucket and − shrinks its fullest.

    function getPipsByBucket() {
        updateGridBounds();
        const buckets = BUCKET_ORDER.map(b => ({ r: b.r, c: b.c, pips: [] }));

        document.querySelectorAll('.hexagon').forEach(pip => {
            const cx = parseFloat(pip.style.left) + PIP_RADIUS;
            const cy = parseFloat(pip.style.top) + PIP_RADIUS;

            let rKey = null, cKey = null;
            for (const r of cachedRowBounds) {
                if (cy >= r.top && cy <= r.bottom) {
                    rKey = r.key;
                    break;
                }
            }
            for (const c of cachedColBounds) {
                if (cx >= c.left && cx <= c.right) {
                    cKey = c.key;
                    break;
                }
            }

            const bucket = buckets.find(b => b.r === rKey && b.c === cKey);
            if (bucket) bucket.pips.push(pip);
        });

        return buckets;
    }

    // Page-coordinate rect of a target, as the union of its row and column
    // bands ('*' spans them all). Assumes updateGridBounds has run, which
    // getPipsByBucket guarantees.
    function getTargetRect(rowKey, colKey) {
        const rows = cachedRowBounds.filter(r => rowKey === '*' || r.key === rowKey);
        const cols = cachedColBounds.filter(c => colKey === '*' || c.key === colKey);
        const top = Math.min(...rows.map(r => r.top));
        const bottom = Math.max(...rows.map(r => r.bottom));
        const left = Math.min(...cols.map(c => c.left));
        const right = Math.max(...cols.map(c => c.right));
        return { left, top, width: right - left, height: bottom - top };
    }

    // Random collision-free spot in a rect; after max attempts we accept
    // overlap, same fallback as placePipsFromDistribution.
    function findFreeSpotInRect(rect) {
        const pips = document.querySelectorAll('.hexagon');
        let x, y;
        for (let attempts = 0; attempts < 500; attempts++) {
            x = Math.random() * (rect.width - PIP_SIZE) + rect.left;
            y = Math.random() * (rect.height - PIP_SIZE) + rect.top;

            let collision = false;
            for (const p of pips) {
                const dx = parseFloat(p.style.left) - x;
                const dy = parseFloat(p.style.top) - y;
                if (dx * dx + dy * dy < PIP_SIZE * PIP_SIZE) {
                    collision = true;
                    break;
                }
            }
            if (!collision) break;
        }
        return { x, y };
    }

    function nearestPip(pips, x, y) {
        let best = null, bestDist = Infinity;
        pips.forEach(p => {
            const dx = parseFloat(p.style.left) - x;
            const dy = parseFloat(p.style.top) - y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) {
                bestDist = d;
                best = p;
            }
        });
        return best;
    }

    function stepCell(rowKey, colKey, delta) {
        const buckets = getPipsByBucket();
        const inTarget = b => (rowKey === '*' || b.r === rowKey) &&
                              (colKey === '*' || b.c === colKey);

        // Fullest bucket satisfying pred; ties go to the first in
        // BUCKET_ORDER. Returns null if all candidates are empty.
        const fullest = pred => {
            let best = null;
            buckets.forEach(b => {
                if (!pred(b)) return;
                if (b.pips.length === 0) return;
                if (!best || b.pips.length > best.pips.length) best = b;
            });
            return best;
        };

        // The pile we trade with
        const pile = fullest(b => !inTarget(b));

        if (delta > 0) {
            if (!pile) return; // Every on-grid pip is already in the target
            // Land in the target's fullest bucket, or anywhere in the
            // target if it's empty
            const destBucket = fullest(inTarget);
            const rect = destBucket
                ? getTargetRect(destBucket.r, destBucket.c)
                : getTargetRect(rowKey, colKey);
            const dest = findFreeSpotInRect(rect);
            const pip = nearestPip(pile.pips, dest.x, dest.y);
            saveHistory();
            // Pips have a CSS left/top transition, so this animates the flight
            pip.style.left = dest.x + 'px';
            pip.style.top = dest.y + 'px';
        } else {
            const sourceBucket = fullest(inTarget);
            if (!sourceBucket) return; // Nothing to remove
            if (!pile) return; // Nowhere to send it (all mass is here)
            const dest = findFreeSpotInRect(getTargetRect(pile.r, pile.c));
            const pip = nearestPip(sourceBucket.pips, dest.x, dest.y);
            saveHistory();
            pip.style.left = dest.x + 'px';
            pip.style.top = dest.y + 'px';
        }

        updateCounters();
        updateUrlState();
    }

    // Gather (pack) or spread out a target's pips, bucket by bucket, so no
    // pip ever changes buckets: probabilities are invariant under tidying.
    function tidyCell(rowKey, colKey, act) {
        const buckets = getPipsByBucket().filter(b =>
            (rowKey === '*' || b.r === rowKey) &&
            (colKey === '*' || b.c === colKey) &&
            b.pips.length > 0);
        if (buckets.length === 0) return;

        saveHistory();
        buckets.forEach(b => {
            const rect = getTargetRect(b.r, b.c);
            if (act === 'pack') packBucket(b, rect);
            else spreadBucket(b, rect);
        });
        updateCounters();
        updateUrlState();
    }

    // Honeycomb the bucket's pips around its rect's center, using only
    // hex-grid slots that keep a pip fully inside the rect
    function packBucket(bucket, rect) {
        const occupied = getOccupiedSlots(new Set(bucket.pips));
        const centerGrid = getGridPos(rect.left + rect.width / 2 - PIP_RADIUS,
            rect.top + rect.height / 2 - PIP_RADIUS);

        const inRect = (row, col) => {
            const pos = getScreenPos(row, col);
            return pos.x >= rect.left && pos.x + PIP_SIZE <= rect.left + rect.width &&
                pos.y >= rect.top && pos.y + PIP_SIZE <= rect.top + rect.height;
        };

        const slots = [];
        const queue = [{ row: centerGrid.row, col: centerGrid.col }];
        const visited = new Set([`${centerGrid.row}_${centerGrid.col}`]);
        let qIndex = 0;
        while (slots.length < bucket.pips.length && qIndex < 3000 && qIndex < queue.length) {
            const curr = queue[qIndex++];
            const key = `${curr.row}_${curr.col}`;
            if (inRect(curr.row, curr.col) && !occupied[key]) {
                slots.push(curr);
                occupied[key] = true;
            }
            const dirs = (Math.abs(curr.row) % 2 === 0) ? HEX_DIRS_EVEN : HEX_DIRS_ODD;
            for (let d of dirs) {
                const nRow = curr.row + d.dRow;
                const nCol = curr.col + d.dCol;
                const nKey = `${nRow}_${nCol}`;
                // Only walk within the rect so the spiral can't escape it
                if (!visited.has(nKey) && inRect(nRow, nCol)) {
                    visited.add(nKey);
                    queue.push({ row: nRow, col: nCol });
                }
            }
        }

        bucket.pips.forEach((pip, i) => {
            if (i < slots.length) {
                const pos = getScreenPos(slots[i].row, slots[i].col);
                pip.style.left = pos.x + 'px';
                pip.style.top = pos.y + 'px';
            } else {
                // Cell too crowded for a clean honeycomb; accept overlap
                const spot = findFreeSpotInRect(rect);
                pip.style.left = spot.x + 'px';
                pip.style.top = spot.y + 'px';
            }
        });
    }

    // Spread the bucket's pips in an even grid across its rect
    function spreadBucket(bucket, rect) {
        const pips = bucket.pips.slice();
        const n = pips.length;
        const aspect = rect.width / rect.height;

        let cols = Math.ceil(Math.sqrt(n * aspect));
        if (cols < 1) cols = 1;
        let rows = Math.ceil(n / cols);
        while (rows * cols < n) cols++;

        const cellW = rect.width / cols;
        const cellH = rect.height / rows;

        // Sort by current position so the motion reads as an untangling
        pips.sort((a, b) => {
            const ta = parseFloat(a.style.top);
            const tb = parseFloat(b.style.top);
            if (Math.abs(ta - tb) > PIP_RADIUS) return ta - tb;
            return parseFloat(a.style.left) - parseFloat(b.style.left);
        });

        pips.forEach((pip, i) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            pip.style.left = (rect.left + c * cellW + cellW / 2 - PIP_RADIUS) + 'px';
            pip.style.top = (rect.top + r * cellH + cellH / 2 - PIP_RADIUS) + 'px';
        });
    }

    // Event delegation because the stepper buttons are re-created on every
    // updateCounters call.
    document.querySelector('table').addEventListener('click', (e) => {
        const btn = e.target.closest('.stepper-btn');
        if (!btn) return;
        if (btn.dataset.delta) {
            stepCell(btn.dataset.r, btn.dataset.c, parseInt(btn.dataset.delta, 10));
        } else {
            tidyCell(btn.dataset.r, btn.dataset.c, btn.dataset.act);
        }
    });

    // --- Presets ---
    // Counts in BUCKET_ORDER order: rows bottom-up (annual, decennial,
    // centennial, millenary, epochal), columns in DOM order (positive,
    // good, ambiguous, bad, catastrophic). Each must sum to 100.
    // These are archetypes, not attributed forecasts, except silver and dreev. NB: the counts are reversed top/bottom from what you see visually in the chart.
    const PRESETS = {
        // Nate Silver's distribution from On the Edge (Aug 2024)
        silver: [
            0,  0, 0, 0, 0,
            0, 13, 9, 3, 0,
            8, 13, 8, 5, 1,
            9,  9, 4, 4, 4,
            5,  0, 0, 0, 5,
        ],
        // Daniel Reeves (Feb 2025), the chart in
        // https://agifriday.substack.com/p/ai-risk-and-the-technological-richter
        dreev1: [
             0,  0, 0, 0, 0,
             0, 31, 4, 7, 0,
            16,  8, 2, 3, 4,
             2,  2, 1, 2, 1,
             6,  0, 0, 0, 11,
        ],
        // dreev Feb 2026: 
        // https://agifriday.substack.com/p/crashla
        dreev2: [
             0, 0, 0, 0, 0,
             0, 7, 5, 4, 0,
             14, 23, 10, 8, 4,
             3, 6, 2, 3, 4,
             3, 0, 0, 0, 4,
        ],
        uniform: [
            0, 0, 0, 0, 0,
            5, 5, 5, 5, 5,
            5, 5, 5, 5, 5,
            5, 5, 5, 5, 5,
            5, 5, 5, 5, 5,
        ],
        skeptic: [
            0, 0, 0, 0, 0,
            10, 20, 15, 10, 0,
            5, 15, 10, 5, 0,
            2, 3, 2, 1, 0,
            1, 0, 0, 0, 1,
        ],
        optimist: [
            0, 0, 0, 0, 0,
            2, 3, 0, 0, 0,
            10, 10, 3, 2, 0,
            20, 15, 3, 2, 0,
            20, 5, 2, 1, 2,
        ],
        doomer: [
            0, 0, 0, 0, 0,
            0, 2, 3, 0, 0,
            2, 3, 5, 5, 0,
            3, 5, 5, 10, 7,
            5, 5, 5, 10, 25,
        ],
        bimodal: [
            0, 0, 0, 0, 0,
            0, 0, 0, 0, 0,
            5, 5, 5, 5, 0,
            10, 5, 3, 2, 5,
            25, 5, 0, 0, 25,
        ],
    };

    const presetSelect = document.getElementById('preset-select');
    presetSelect.addEventListener('change', () => {
        const counts = PRESETS[presetSelect.value];
        if (!counts) throw new Error(`Unknown preset: ${presetSelect.value}`);
        const sum = counts.reduce((a, b) => a + b, 0);
        if (sum !== 100) throw new Error(`Preset "${presetSelect.value}" sums to ${sum}, not 100`);

        saveHistory();
        clearSelection();
        placePipsFromDistribution(counts, allPips);
        updateCounters();
        updateUrlState();
    });

    // Keep the dropdown truthful: show a preset's name iff the current
    // distribution exactly matches it, otherwise the "Presets" placeholder.
    // Called from updateUrlState so it tracks every mutation, including undo.
    function syncPresetSelect() {
        const counts = getPipsByBucket().map(b => b.pips.length);
        const match = Object.keys(PRESETS).find(name =>
            PRESETS[name].every((c, i) => c === counts[i]));
        presetSelect.value = match || '';
    }

    // Reflect the initial state (a fresh load matches the Uniform preset)
    syncPresetSelect();

    // Snapshot Logic
    const snapshotBtn = document.getElementById('snapshot-btn');
    if (snapshotBtn) {
        snapshotBtn.addEventListener('click', async () => {
            snapshotBtn.disabled = true;
            snapshotBtn.innerText = '⏳';

            try {
                // Capture the grid area only.
                // The pips are in an overlay (#hexagon-container), but capturing document.body includes them.
                // We just need to define the crop area using the table's dimensions.
                const table = document.querySelector('table');
                const rect = table.getBoundingClientRect();

                const canvas = await html2canvas(document.body, {
                    backgroundColor: '#f9f9f7', // Match body bg
                    // Crop to table area
                    x: rect.left + window.scrollX,
                    y: rect.top + window.scrollY,
                    width: rect.width,
                    height: rect.height,
                    ignoreElements: (element) => {
                        // Only absolutely positioned overlays may be ignored:
                        // removing an in-flow element (like the toolbar)
                        // collapses layout in html2canvas's clone and shifts
                        // everything relative to the crop coordinates
                        if (element.classList.contains('selection-box')) return true;
                        if (element.classList.contains('cell-stepper')) return true;
                        return false;
                    }
                });

                canvas.toBlob(async (blob) => {
                    try {
                        const item = new ClipboardItem({ 'image/png': blob });
                        await navigator.clipboard.write([item]);
                        snapshotBtn.innerText = '✓';
                    } catch (err) {
                        console.error('Clipboard write failed', err);
                        snapshotBtn.innerText = '✗';
                    }
                    setTimeout(() => {
                        snapshotBtn.innerText = '📷';
                        snapshotBtn.disabled = false;
                    }, 2000);
                });
            } catch (err) {
                console.error('Snapshot failed', err);
                snapshotBtn.innerText = '✗';
                setTimeout(() => {
                    snapshotBtn.innerText = '📷';
                    snapshotBtn.disabled = false;
                }, 2000);
            }
        });
    }

    // Help Modal Logic
    const helpBtn = document.getElementById('help-btn');
    const modal = document.getElementById('help-modal');

    // Size the backdrop to the whole document and center the dialog in the
    // visual viewport. Static CSS centering breaks on mobile: the page is
    // wider than the screen and usually pinch-zoomed, where fixed
    // positioning anchors to the layout viewport, not what's on screen.
    function openHelpModal() {
        const doc = document.documentElement;
        modal.style.width = Math.max(doc.scrollWidth, window.innerWidth) + 'px';
        modal.style.height = Math.max(doc.scrollHeight, window.innerHeight) + 'px';

        const vv = window.visualViewport ||
            { width: window.innerWidth, height: window.innerHeight, pageLeft: window.scrollX, pageTop: window.scrollY };
        const content = modal.querySelector('.modal-content');
        const width = Math.min(500, vv.width * 0.9);
        content.style.width = width + 'px';
        content.style.left = (vv.pageLeft + (vv.width - width) / 2) + 'px';
        content.style.top = (vv.pageTop + vv.height * 0.15) + 'px';

        modal.style.display = 'block';
    }

    if (helpBtn && modal) {
        helpBtn.addEventListener('click', openHelpModal);
    }

    // Help Modal & Close Logic
    const closeBtn = document.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
    }

    // Close on click outside
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }

        if (preventClearSelection) return;

        // Don't clear selection if clicking on the grid, buttons, or pips
        // Only clear on truly empty space (body background)
        if (!isBoxSelecting &&
            !e.target.closest('.hexagon') &&
            !e.target.closest('button') &&
            !e.target.closest('table') &&
            !e.target.closest('#undo-container') &&
            e.target !== selectionBox) {
            clearSelection();
        }
    });

    // Helper to update button state
    function updateSelectionUI() {
        const hasSelection = selectedPips.size > 0;
        if (undoButton) undoButton.disabled = historyStack.length === 0;
        if (redoButton) redoButton.disabled = redoStack.length === 0;
        if (hasSelection) {
            selectionBox.style.borderColor = '#2a78d6';
            selectionBox.style.backgroundColor = 'rgba(42, 120, 214, 0.2)';
        }
    }
});
