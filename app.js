document.addEventListener('DOMContentLoaded', () => {
    // Config
    const PIP_SIZE = 20; // Visual size
    // Using a slightly smaller effective size for collision to allow tight packing? 
    // Or strictly PIP_SIZE. Let's start with strict.
    const COLLISION_RADIUS = PIP_SIZE;
    const SNAP_TO_GRID = false;

    // URL State Config
    const CELL_ORDER = [
        // Prioritize "likely empty" cells to keep BigInt small (Combinadics optimization)
        // Annual Row (Row 5 - usually empty)
        'annual_positive', 'annual_neutral', 'annual_negative',
        // We merged annual row in UI, but logically it might be treated as one bucket?
        // Wait, UI has "colspan=5". It's one big bucket visually.
        // But our `cachedRowBounds` treats it as `row: annual`.
        // Let's treat the entire Annual Row as ONE bucket in the encoding if it holds pips.
        // Actually, let's check how `updateCounters` works. It has keys like 'annual'.
        // Rows: epochal, millenary, centennial, decennial, annual.
        // Cols: positive, neutral, negative, off_charts...
        // The intersection defines the bucket.
        // For Annual, we just have 'annual'. It's one row. 
        // Does it have columns? The pips have x-coordinates.
        // `updateCounters` tracks `counts.rows['annual']`.
        // It DOES NOT track `counts.cols` for annual row specifically in a unique way?
        // In `updateCounters`, we do: if (rowKey && colKey).
        // If I drop in Annual (merged), `rowKey`='annual'. `colKey` depends on X.
        // So Annual row effectively has 5 columns too?
        // Yes, `colKey` is calculated by X position.
        // So we have 5 rows * 5 cols = 25 buckets.

        // Custom Order:
        // 1. Annual Row (5 buckets) - Most likely empty
        // 2. Outer Edges of other rows (likely empty)
        // 3. Center (likely full)
        // Actually, simple row-major or specific ordering is fine.
        // Let's just list the keys.
    ];

    // We need a stable mapping of 0-24 index to (rowKey, colKey).
    // Let's define the 25 keys explicitly.
    const ROWS = ['epochal', 'millenary', 'centennial', 'decennial', 'annual'];
    const COLS = ['positive', 'neutral', 'negative', 'off_charts_pos', 'off_charts_neg'];
    // Wait, the col keys in HTML are:
    // positive, neutral, negative... wait, let's verify HTML.
    // HTML headers: Positive, Neutral, Negative, Off Charts (+), Off Charts (-)
    // data-col attributes?

    // Let's Verify HTML data attributes first before hardcoding.

    // State
    // We strictly track positions via the DOM left/top for truth, but we can cache if needed.
    // State
    // We strictly track positions via the DOM left/top for truth, but we can cache if needed.
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

    // Define 25 Buckets Order
    // Ordered to prioritize empty buckets first (smaller combinatorial index).
    // Let's look at index.html values.
    // Rows: epochal, millenary, centennial, decennial, annual
    // Cols: off-pos, positive, neutral, negative, off-neg (Standard order?)
    // Let's assume standard reading order for simplicity unless user insists on specific op.
    // User asked for "custom-ordering... like middle 3 cells...".
    // Let's define the exact array of (Row, Col) pairs.
    const BUCKETS = [];
    const ROW_KEYS = ['epochal', 'millenary', 'centennial', 'decennial', 'annual'];
    // Col keys need verification from HTML.
    // Let's assume: 'positive', 'neutral', 'negative', 'off-pos', 'off-neg' based on text.
    // Actually, I'll read them from the DOM in init to be safe.

    // Placeholder to be filled in DOMContentLoaded
    let BUCKET_ORDER = [];

    // Undo stack: Array of Map<id, {left, top}>
    const historyStack = [];
    let isUndoing = false;

    // Helper: Normalize Pointer Events
    // Defined early for usage
    function getPointerPos(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

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

    // State for Box Selection
    let isBoxSelecting = false;
    let boxStartX, boxStartY;


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
    // Verify Col Keys from DOM
    const colHeaderCells = document.querySelectorAll('thead th[data-col]');
    const COL_KEYS = Array.from(colHeaderCells).map(th => th.dataset.col);
    // Note: If data-col is missing, we have a problem. 
    // Based on previous reads, we used `data-col` in `updateGridBounds`.

    // Construct BUCKET_ORDER (25 items)
    // Preference: Annual Row First (5 items).
    // Then Decennial (5 items).
    // Then Centennial...
    // This puts the "bottom" rows (often empty or specific) at the start (Least Significant in Combinadics?).
    // Combinadic Encoding: 
    // We map distribution (c1, c2, ... c25) to a single index.
    // Sum nCr(yi, i+1).
    // Where yi are the positions of the "stars" (items) + "bars" (separators).
    // Or we can use the "Bars" positions.
    // We have 100 items + 24 bars. Positions 0..123.
    // We choose 24 positions for the bars.
    // The "index" is determining where the 24 bars are.
    // If we order bins such that "most full" bins are last, the bars are pushed to higher indices?
    // Actually, if we put "likely empty" bins FIRST, the first few bars appear early (small indices).
    // `nCr(small, k)` is small.
    // So YES, likely-empty bins should be FIRST in the list.

    // Order: Annual -> Decennial -> Centennial -> Millenary -> Epochal
    // Within Row: Off-Charts -> Neg/Pos -> Neutral (Assuming Neutral is fullest).

    // Let's just do Bottom-Up Row-Major for now.
    ['annual', 'decennial', 'centennial', 'millenary', 'epochal'].forEach(r => {
        // For columns, we just take them in order, or maybe "Off" first?
        // Let's just use the DOM order of COL_KEYS for consistency.
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

    // Initialization logic...
    const cells = document.querySelectorAll('.prob-cell'); // These are only the 20 main cells?
    // Wait, Annual row has a merged cell but we treat it as 5 virtual columns in logic?
    // The HTML has `tr.annual-row td.annual-merged-cell`.
    // It does NOT have individual `.prob-cell`s for columns.
    // So `updateCounters` works by geometry (X pos).
    // But for **Placement** (dealing pips), we need valid target rectangles.
    // If we want to place a pip in "Annual / Col Positive", we need that rect.
    // We can compute it: AnnualRow.Top/Bottom + ColHeader[Positive].Left/Right.

    let pipIndex = 0;
    const allPips = []; // {left, top, id}

    // Create 100 pips
    // If URL loaded, we place them according to distribution.
    // Else random in default cells.

    for (let i = 0; i < 100; i++) {
        const pip = document.createElement('div');
        pip.classList.add('hexagon');
        pip.setAttribute('draggable', 'false');
        pip.id = `pip-${i}`;
        pip.innerHTML = `<svg viewBox="0 0 100 100" width="20" height="20"><polygon points="50,0 93,25 93,75 50,100 7,75 7,25" fill="#000000"/></svg>`;

        // Position will be set later
        // Just append for now
        pip.style.position = 'absolute';
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
        // Original logic: Top 4 rows (20 cells), 5 pips each.
        // We simulate this by creating a distribution? 
        // Or just run the old logic.
        // Let's use old logic for "Random Init".
        // The old logic iterated `cells` (prob-cells).
        // `cells` includes the 20 cells.

        // Distribution: 5 pips in each of the first 20 buckets (Epochal..Decennial). 0 in Annual.
        // We can just use our `placePipsFromDistribution` if we construct the counts!
        // This unifies the logic.

        const counts = Array(25).fill(0);
        // Map 20 cells to our BUCKET_ORDER indices.
        // BUCKET_ORDER is Annual(5)..Decinnial(5)..Centennial(5)..Millenary(5)..Epochal(5).
        // Indices 0-4 are Annual (Empty).
        // Indices 5-24 are the rest.
        for (let i = 5; i < 25; i++) {
            counts[i] = 5;
        }
        placePipsFromDistribution(counts, pips);
    }

    function placePipsFromDistribution(counts, pips) {
        // counts is array of 25 numbers summing to 100.
        let pipCursor = 0;

        // Iterate buckets
        counts.forEach((count, idx) => {
            if (count === 0) return;

            const bucket = BUCKET_ORDER[idx]; // {r, c}

            // Find bounds for this bucket
            // Row bounds
            const rowTr = document.querySelector(`tr[data-row="${bucket.r}"]`) || document.querySelector(`tr.annual-row`);
            const rowRect = rowTr.getBoundingClientRect();
            const top = rowRect.top + window.scrollY;
            const height = rowRect.height;

            // Col bounds
            // We need the TH with data-col
            const colTh = document.querySelector(`th[data-col="${bucket.c}"]`);
            const colRect = colTh.getBoundingClientRect();
            const left = colRect.left + window.scrollX;
            const width = colRect.width;

            // Place `count` pips in this rect
            for (let k = 0; k < count; k++) {
                if (pipCursor >= pips.length) break;
                const pip = pips[pipCursor]; // Don't increment yet

                let x, y, attempts = 0;
                let valid = false;

                // We need to check against ALL pips that have been placed so far.
                // pips[0]...pips[pipCursor-1] are already active.

                while (!valid && attempts < 50) {
                    // Random pos in rect (padding 10px effectively for diameter=20)
                    x = Math.random() * (width - 20) + left;
                    y = Math.random() * (height - 20) + top;

                    let collision = false;
                    // Check against valid placed pips
                    for (let j = 0; j < pipCursor; j++) {
                        const other = pips[j];
                        // We maintain x/y property on the pip object for easier math? 
                        // Or read from style? Reading style is fine if we cache it or just store it.
                        // Let's assume we store it on the object for this pass.
                        const ox = other.x;
                        const oy = other.y;

                        const dist = Math.sqrt((x - ox) ** 2 + (y - oy) ** 2);
                        if (dist < 20) { // 20px threshold
                            collision = true;
                            break;
                        }
                    }
                    if (!collision) valid = true;
                    attempts++;
                }

                pip.el.style.left = x + 'px';
                pip.el.style.top = y + 'px';
                // Store for next iteration
                pip.x = x;
                pip.y = y;

                pipCursor++;
            }
        });
    }

    function encodeDistribution() {
        // Count pips in BUCKET_ORDER
        // Re-calculate counts from current DOM positions
        updateGridBounds();
        // We can rely on `updateCounters` logic but we need specific bucket array.

        const bucketCounts = Array(25).fill(0);
        const pips = document.querySelectorAll('.hexagon');

        pips.forEach(pip => {
            const l = parseFloat(pip.style.left);
            const t = parseFloat(pip.style.top);
            const cx = l + 10;
            const cy = t + 10;

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

            if (rKey && cKey) {
                // Find index in BUCKET_ORDER
                const idx = BUCKET_ORDER.findIndex(b => b.r === rKey && b.c === cKey);
                if (idx !== -1) bucketCounts[idx]++;
            } else {
                // Pip off grid?
                // Logic says we encode "Distribution".
                // If off grid, we can't encode it in a bucket.
                // But we must sum to 100 for Stars & Bars.
                // We could have an "Overflow" bucket? Or just dump into "Annual/Neutral"?
                // Let's assume user wants to save VALID distributions.
                // Or: Add a 26th bucket "Void"?
                // 125 choose 25 is bigger.
                // Simpler: Force off-grid pips into nearest bucket?
                // Or just first bucket (Annual)?
                if (idx === -1) bucketCounts[0]++; // Dump into first bucket if lost
            }
        });

        // Check sum
        const sum = bucketCounts.reduce((a, b) => a + b, 0);
        if (sum !== 100) {
            // Should not happen if we catch all pips
            bucketCounts[0] += (100 - sum);
        }

        // Encode (Stars & Bars / Combinadics)
        // We are choosing positions for 24 bars among (100+24) slots.
        // We map counts [c0, c1, ... c24] to Bar positions.
        // Bar 1 is at c0.
        // Bar 2 is at c0 + c1 + 1.
        // Bar k is at (Sum_{i=0}^{k-1} ci) + (k-1). 
        // Wait, Combinadic definition:
        // Position of bars in the sequence of 124 items.
        // Sequence: * * * | * * | * ...
        // Item indices 0..123.
        // We strictly increase bar positions.

        const bars = [];
        let currentPos = 0;
        for (let i = 0; i < 24; i++) {
            currentPos += bucketCounts[i];
            bars.push(BigInt(currentPos + i));
            // Position is (pips so far) + (bars so far)
            // Bar 0 is after c0 pips. Pos = c0. (0-indexed? No, it occupies a slot).
            // Sequence indices: 0..(100+24-1) = 123.
            // If c0=5, we have *****|. Bar is at index 5.
            // Next starts at 6.
        }

        // Combinadics Index = Sum( nCr(BarPos_i, i+1) )
        // Using "Combinatorial Number System" variant
        // N = C(b24, 24) + ... + C(b1, 1).
        // Since our bars are strictly increasing b0 < b1 < ... < b23.
        // We use the positions as the "chosen" numbers.
        // N = Sum_{k=0}^{23} nCr(bars[k], k+1).

        let index = 0n;
        for (let k = 0; k < 24; k++) {
            index += nCr(bars[k], BigInt(k + 1));
        }

        return toBase62(index);
    }

    function decodeDistribution(str) {
        let index = fromBase62(str);

        // Decode Combinadics
        // We need to find purely strictly increasing bars [b0...b23] such that Sum nCr matches.
        // We do this greedily from largest k (23) down to 0.
        // Find largest b23 such that nCr(b23, 24) <= index.

        const bars = new Array(24);

        // We act from k=23 down to 0
        for (let k = 23; k >= 0; k--) {
            const r = BigInt(k + 1);
            // Search for v such that nCr(v, r) <= index
            // Check upper bound? 124.
            // Linear scan downwards from previous bar (or 124) is fast enough.
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

        // Reconstruct counts from bars
        // bars[i] is position of i-th bar.
        // c0 = bars[0] - 0
        // c1 = bars[1] - bars[0] - 1
        // ...

        const counts = [];
        let prev = -1n;
        for (let i = 0; i < 24; i++) {
            counts.push(Number(bars[i] - prev - 1n));
            prev = bars[i];
        }
        // Last bucket is remainder
        // Total slots 124 (0..123). Total pips 100.
        // Last count?
        // simple: 100 - sum(counts)
        const currentSum = counts.reduce((a, b) => a + b, 0);
        counts.push(100 - currentSum);

        return counts;
    }

    function updateUrlState() {
        const code = encodeDistribution();
        const newUrl = `${window.location.pathname}?d=${code}`;
        window.history.replaceState({ path: newUrl }, '', newUrl);
    }




    // Unified Box Selection Start (Mouse & Touch)
    function handleBoxStart(e) {
        // Condition:
        // Mouse: Always allowed if button 0 and not on pip/button.
        // Touch: Only allowed if isMultiSelectMode is true.

        let validStart = false;
        if (e.type === 'mousedown') {
            if (e.target.closest('.hexagon')) return;
            if (e.target.closest('button')) return; // buttons
            if (e.button !== 0) return;
            validStart = true;
        } else if (e.type === 'touchstart') {
            if (e.target.closest('.hexagon')) return;
            if (e.target.closest('button')) return;

            // Restrict box-drag to the grid cells only (prob-cell or annual-merged-cell)
            // This leaves the headers and row labels available for scrolling.
            if (!e.target.closest('.prob-cell') && !e.target.closest('.annual-merged-cell')) return;

            validStart = true;
            // Prevent scroll if we are box selecting
            if (e.cancelable) e.preventDefault();
        }

        if (!validStart) return;

        isBoxSelecting = true;
        const pos = getPointerPos(e);
        boxStartX = pos.x;
        boxStartY = pos.y;

        selectionBox.style.left = boxStartX + 'px';
        selectionBox.style.top = boxStartY + 'px';
        selectionBox.style.width = '0px';
        selectionBox.style.height = '0px';
        selectionBox.style.display = 'block';

        if (!e.shiftKey) {
            clearSelection();
        }
        // In MultiSelectMode, we usually ADD to selection (Shift behavior).
        // Or should we clear? User expects "Toggle" behavior usually implies adding.
        // Let's assume MultiMode implies accumulation.
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
    }

    document.addEventListener('mousemove', handleBoxMove);
    document.addEventListener('touchmove', handleBoxMove, { passive: false });

    function handleBoxEnd(e) {
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
            if (newlySelected && selectedPips.size > 0) {
                saveHistory();
                packSelection();
            }
        }
    }

    document.addEventListener('mouseup', handleBoxEnd);
    document.addEventListener('touchend', handleBoxEnd);

    // Helper functions

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
        // Allow left click or touch
        if (e.type === 'mousedown' && e.button !== 0) return;
        if (e.type === 'touchstart') e.preventDefault(); // Stop mouse emulation


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

            // Real-time counter update
            // Throttle? Or is geometric fast enough? 100 pips * 20 cells = 2000 checks. 
            // It should be fine on modern CPU.
            updateCounters(true); // pass true to indicate "use cached bounds"?
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
                updateUrlState(); // Save to URL on success
            }
        }

        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', stop);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', stop);
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
        updateUrlState(); // Save to URL on pack
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
        updateUrlState(); // Save to URL on undo
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

    // Help Modal Logic
    const helpBtn = document.getElementById('help-btn');
    const modal = document.getElementById('help-modal');
    const closeBtn = document.querySelector('.close-btn');

    if (helpBtn && modal && closeBtn) {
        helpBtn.addEventListener('click', () => {
            modal.style.display = 'block';
        });

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });

        // Close on click outside
        window.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });
    }
});
