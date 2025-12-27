document.addEventListener('DOMContentLoaded', () => {
    // Config
    const PIP_SIZE = 20; // Visual size
    const PIP_RADIUS = PIP_SIZE / 2;
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
    selectionBox.id = 'selection-box'; // Debugging aid
    document.body.appendChild(selectionBox);

    const hexagonContainer = document.getElementById('hexagon-container');
    // undo container
    const undoContainer = document.getElementById('undo-container');

    // Add Undo Button to UI
    const undoButton = document.createElement('button');
    undoButton.className = 'icon-btn';
    undoButton.innerText = '↩';
    undoButton.title = 'Undo';
    undoButton.disabled = true; // Initially disabled
    undoButton.addEventListener('click', undo);

    // Position Undo button in the dedicated container
    undoContainer.appendChild(undoButton);

    // Action Buttons
    const btnSquish = document.getElementById('btn-squish');
    const btnSpread = document.getElementById('btn-spread');

    // State for Box Selection
    let isBoxSelecting = false;
    let preventClearSelection = false; // Flag to stop click from clearing immediately
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

                while (!valid && attempts < 500) {
                    // Random pos in rect (padding PIP_RADIUS effectively for diameter=PIP_SIZE)
                    x = Math.random() * (width - PIP_SIZE) + left;
                    y = Math.random() * (height - PIP_SIZE) + top;

                    let collision = false;
                    // Check against valid placed pips
                    for (let j = 0; j < pipCursor; j++) {
                        const other = pips[j];
                        const ox = other.x;
                        const oy = other.y;

                        const dist = Math.sqrt((x - ox) ** 2 + (y - oy) ** 2);
                        if (dist < PIP_SIZE) { // PIP_SIZE threshold
                            collision = true;
                            break;
                        }
                    }
                    if (!collision) valid = true;
                    attempts++;
                }

                // If still invalid (crowded), fallback?
                // We just accept the last tried position (overlap).
                // Or maybe spiral? For now, 500 attempts is robust enough for typical usage.

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
                // Find index in BUCKET_ORDER
                idx = BUCKET_ORDER.findIndex(b => b.r === rKey && b.c === cKey);
            }

            if (idx !== -1) {
                bucketCounts[idx]++;
            } else {
                // Pip off grid?
                // Logic says we encode "Distribution".
                // We map off-grid pips to the NEAREST bucket to preserve the 100-pip invariant.
                // This is better than dumping them all in bucket 0.

                let minDist = Infinity;
                let bestIdx = 0;

                // Find nearest bucket center
                // We need the Rects of all 25 buckets?
                // We can iterate BUCKET_ORDER and check cached bounds.
                // It's a bit heavy but N=100 pips * 25 buckets = 2500 ops. Fast.

                BUCKET_ORDER.forEach((b, bIdx) => {
                    // Reconstruct rect from cachedRowBounds / cachedColBounds
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
    let initialSelection = new Set();
    let boxSelectionFrame = null;
    let allPipsInitialPositions = new Map();

    function handleBoxStart(e) {
        let validStart = false;
        if (e.type === 'mousedown') {
            if (e.target.closest('.hexagon')) return;
            if (e.target.closest('button')) return;
            if (e.button !== 0) return;
            validStart = true;
        } else if (e.type === 'touchstart') {
            if (e.target.closest('.hexagon')) return;
            if (e.target.closest('button')) return;
            if (e.target.closest('#undo-container')) return; // Don't start box on button area
            if (e.target.closest('.prob-cell') || e.target.closest('.annual-merged-cell')) {
                validStart = true;
            } else {
                return;
            }
        }

        if (!validStart) return;

        // Clear any previous selection (and hide box)
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

            // Check intersection against INITIAL position (since we don't move them during drag)
            // Or current? In passive mode, they don't move, so they are the same.
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
            isBoxSelecting = false;
            if (boxSelectionFrame) cancelAnimationFrame(boxSelectionFrame);
            boxSelectionFrame = null;

            // Persistent Selection State
            if (selectedPips.size > 0) {
                // Capture box bounds for usage in Spread
                // selectionBox is DOM relative.
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
                }, 300); // Longer timeout for mobile touch events
            } else {
                clearSelection();
            }
        }
    }

    function clearSelection() {
        selectedPips.forEach(pip => pip.classList.remove('selected'));
        selectedPips.clear();
        selectionBox.style.display = 'none';
        lastSelectionBounds = null;
        updateCounters();
        updateSelectionUI(); // button state
    }

    function applySquish() {
        if (selectedPips.size === 0) return;
        saveHistory();
        packSelection();
        updateUrlState();
        // Box stays visible - user can click Squish/Spread again
    }

    function applySpread() {
        if (selectedPips.size === 0 || !lastSelectionBounds) return;
        saveHistory();

        const pipsInBox = Array.from(selectedPips);
        const { left, top, width, height } = lastSelectionBounds;
        const aspect = width / height;

        let cols = Math.ceil(Math.sqrt(pipsInBox.length * aspect));
        if (cols < 1) cols = 1;
        let rows = Math.ceil(pipsInBox.length / cols);
        while (rows * cols < pipsInBox.length) cols++;

        const cellW = width / cols;
        const cellH = height / rows;

        // Sort by CURRENT position roughly to keep stability
        pipsInBox.sort((a, b) => {
            const rtA = parseFloat(a.style.top);
            const rtB = parseFloat(b.style.top);
            if (Math.abs(rtA - rtB) > PIP_RADIUS) return rtA - rtB;
            return parseFloat(a.style.left) - parseFloat(b.style.left);
        });

        pipsInBox.forEach((pip, i) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            const x = left + c * cellW + cellW / 2 - PIP_RADIUS;
            const y = top + r * cellH + cellH / 2 - PIP_RADIUS;
            pip.style.left = x + 'px';
            pip.style.top = y + 'px';
        });

        updateUrlState();
        // Box stays visible - user can click Squish/Spread again
    }

    document.addEventListener('mouseup', handleBoxEnd);
    document.addEventListener('touchend', handleBoxEnd);

    function snapSelectedToGrid() {
        const occupied = getOccupiedSlots(selectedPips);

        selectedPips.forEach(pip => {
            const currentLeft = parseFloat(pip.style.left);
            const currentTop = parseFloat(pip.style.top);

            // Simply find the nearest free slot to where the box placed it
            const target = findNearestFreeSlot(currentLeft, currentTop, occupied);
            const pos = getScreenPos(target.row, target.col);

            pip.style.left = pos.x + 'px';
            pip.style.top = pos.y + 'px';

            occupied[`${target.row}_${target.col}`] = true;
        });
        updateCounters();
    }


    // Helper functions for Smart Placement
    function getOccupiedSlots(excludePipsSet = new Set()) {
        const occupied = {};
        const allPips = document.querySelectorAll('.hexagon');
        allPips.forEach(p => {
            if (!excludePipsSet.has(p)) {
                // We map raw coordinates to grid slots to "reserve" them.
                // Note: Pips might not be perfectly aligned, but we reserve the *nearest* slot.
                const pos = getGridPos(parseFloat(p.style.left), parseFloat(p.style.top));
                occupied[`${pos.row}_${pos.col}`] = true;
            }
        });
        return occupied;
    }

    function findNearestFreeSlot(targetX, targetY, occupiedSlotsMap) {
        const startGrid = getGridPos(targetX, targetY);

        // If the exact slot is free, prefer exact position? 
        // Logic: if we are resolving a collision, we likely want the NEAREST free slot.
        // If the current position is valid (not in occupiedSlots), we technically don't need to move?
        // But this function is usually called when we *know* there's a problem or we want to pack.
        // Actually, for "Smart Drop", if there's no collision, we don't call this.
        // If there IS a collision, we call this.

        const queue = [{ row: startGrid.row, col: startGrid.col }];
        const visited = new Set([`${startGrid.row}_${startGrid.col}`]);

        // Spiral directions
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
        while (qIndex < 3000 && qIndex < queue.length) {
            const curr = queue[qIndex++];
            const key = `${curr.row}_${curr.col}`;

            if (!occupiedSlotsMap[key]) {
                // Found one!
                return curr;
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
        return startGrid; // Fallback
    }

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

            // Smart Placement on Drop
            const allPips = document.querySelectorAll('.hexagon');

            // 1. Build map of currently occupied slots by UNSELECTED pips
            //    (These are static walls we must respect)
            const occupiedSlots = getOccupiedSlots(selectedPips);

            let placedCount = 0;

            // 2. Iterate selected pips and resolve collisions
            selectedPips.forEach(pip => {
                const currentLeft = parseFloat(pip.style.left);
                const currentTop = parseFloat(pip.style.top);
                // Center
                const cx = currentLeft + 10;
                const cy = currentTop + 10;

                let collision = false;

                // Check collision against UNSELECTED pips
                // (We do a simple distance check first to see if we even NEED to snap)
                // If user dropped it in empty space, we leave it (loose placement).
                // Unless we want to force grid snap? 
                // "be smarter about placement... where they don't fit" implies only fixing bad ones.

                // Efficiency: Check distance against all other pips?
                // Or just check if the grid slot is taken?
                // Visual overlap matters more than grid slot logic for the trigger.

                // Let's stick to the visual collision check dist < 20.
                for (let other of allPips) {
                    if (pip === other) continue;
                    if (selectedPips.has(other)) {
                        // If checking against other SELECTED pips:
                        // Since we move them as a group, they maintain relative spacing.
                        // However, if we process them sequentially and one moves (snaps), 
                        // it might collide with a subsequent one?
                        // "occupiedSlots" will handle the sequential exclusion.
                        // So we don't strictly need to check distance against other selected pips 
                        // IF we trust the grid system. 
                        // But wait, if we are in "loose mode", we haven't snapped yet.
                        // Let's ignore other selected pips for the *trigger*, 
                        // but strictly respect them for the *resolution* (via occupiedSlots).
                        continue;
                    }

                    const r2 = other.getBoundingClientRect();
                    const cx2 = r2.left + r2.width / 2;
                    const cy2 = r2.top + r2.height / 2;

                    const dist = Math.sqrt((cx - cx2) ** 2 + (cy - cy2) ** 2);
                    if (dist < 20) {
                        collision = true;
                        break;
                    }
                }

                // If visual collision detected, OR if the grid slot itself is logically occupied 
                // (which handles the case where we land "perfectly" on top of someone but didn't scan them yet? No, collision handles that).

                // ALSO: Check collision against previously processed selected pips from this batch?
                // If I drop 2 pips, and Pip A snaps to Slot X. Pip B was hovering over Slot X.
                // Pip B needs to know Slot X is taken.
                // `occupiedSlots` is our source of truth.

                // If NO visual collision with static items, we might still overlap with *newly placed* items?
                // Let's check `occupiedSlots` for the current position's grid slot too.
                const myGrid = getGridPos(currentLeft, currentTop);
                if (occupiedSlots[`${myGrid.row}_${myGrid.col}`]) {
                    collision = true; // Grid conflict
                }

                if (collision) {
                    // RESOLVE CONFLICT
                    // Find nearest free slot
                    const target = findNearestFreeSlot(currentLeft, currentTop, occupiedSlots);
                    const pos = getScreenPos(target.row, target.col);

                    pip.style.left = pos.x + 'px';
                    pip.style.top = pos.y + 'px';

                    // Mark this slot as taken for the next pip in loop
                    occupiedSlots[`${target.row}_${target.col}`] = true;
                } else {
                    // No collision. Leave it where it is.
                    // BUT register it in occupiedSlots so others don't land on it.
                    // We map its current loose position to the nearest grid slot for reservation purposes.
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

        // Calculate centroid
        let sumX = 0, sumY = 0;
        selectedPips.forEach(pip => {
            sumX += parseFloat(pip.style.left);
            sumY += parseFloat(pip.style.top);
        });
        const centerX = sumX / selectedPips.size;
        const centerY = sumY / selectedPips.size;

        // Map occupied slots by UNSELECTED pips
        const occupiedGrid = getOccupiedSlots(selectedPips);

        // Find slots
        const targetSlots = [];

        // We'll simulate finding N slots by running the search N times? 
        // Or one search that gathers N slots?
        // `findNearestFreeSlot` returns ONE.
        // But we want a cluster around the centroid.
        // It's efficient to just run a single BFS/Spiral that yields N slots.

        // Let's reimplement a "Find K Nearest Slots" here, or just loop `findNearestFreeSlot`?
        // If we loop `findNearestFreeSlot`, we must update `occupiedGrid` each time.
        // The centroid stays roughly the same (or we start search from same center).

        const centerGrid = getGridPos(centerX, centerY);
        const searchStart = { x: centerX, y: centerY }; // Reuse logic if possible?

        // Actually, the previous spiral implementation was efficient for finding K slots.
        // Let's stick to the Spiral logic here but using the new `occupiedGrid` init.

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
            cells: {}, // New: Per-cell counts
            rowsSel: {},
            colsSel: {},
            cellsSel: {}, // New
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
        // We need to preserve the cell-count div if we append it? 
        // Or cleaner: Re-render the cell-count div every time.
        // The Annual cell has "threshold-label" which is static.
        // The Prob cells are usually empty.
        // Let's clear TEXT inside prob cells but we might strip our new div?
        // Actually, existing code did: `el.innerText = ''`.
        // This WIPES everything.
        // We will re-append the count div.
        document.querySelectorAll('.prob-cell').forEach(el => !el.classList.contains('annual-merged-cell') && (el.innerText = ''));

        // Ensure Annual cell count is cleared? 
        // We'll update it specifically or find the .cell-count inside it.
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

            // Update Metrics
            if (rowKey && colKey) {
                // Update Row
                counts.rows[rowKey] = (counts.rows[rowKey] || 0) + 1;
                isSel && (counts.rowsSel[rowKey] = (counts.rowsSel[rowKey] || 0) + 1);

                // Update Col
                counts.cols[colKey] = (counts.cols[colKey] || 0) + 1;
                isSel && (counts.colsSel[colKey] = (counts.colsSel[colKey] || 0) + 1);

                // Update Cell
                const cellKey = `${rowKey}_${colKey}`;
                counts.cells[cellKey] = (counts.cells[cellKey] || 0) + 1;
                isSel && (counts.cellsSel[cellKey] = (counts.cellsSel[cellKey] || 0) + 1);

                // Update Total
                counts.total++;
                isSel && counts.totalSel++;
            }
        });

        // Render helper
        const render = (val, selVal) => {
            return `${val || 0}%${(selVal > 0) ? ` <span style="color:#ff4444">(${selVal}%)</span>` : ''}`;
        };

        // Render helper for Cell Counts (Subtle)
        const renderCell = (val, selVal) => {
            // If 0, show nothing? Or 0%?
            // "very subtly... show the percentage".
            // If 0, maybe hide it to reduce clutter? Default to showing nothing if 0.
            if (!val && !selVal) return '';

            const mainNum = val || 0;
            const selNum = selVal || 0;

            // Format: "5%" or "5% (1%)"
            // Color handled by CSS for main, span for selected.

            let html = `${mainNum}%`;
            if (selNum > 0) {
                html += ` <span style="color:#ff4444">(${selNum}%)</span>`;
            }
            return html;
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

        // Render per-cell counts
        // 1. Regular cells
        document.querySelectorAll('.prob-cell').forEach(cell => {
            // Skip Annual Merged Cell loop here, handled manually
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

    if (helpBtn && modal) {
        helpBtn.addEventListener('click', () => {
            modal.style.display = 'block';
        });
    }

    // Action Button Listeners
    if (btnSquish && btnSpread) {
        btnSquish.addEventListener('click', (e) => {
            e.stopPropagation();
            applySquish();
        });
        btnSpread.addEventListener('click', (e) => {
            e.stopPropagation();
            applySpread();
        });
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

        // Also clear selection if clicking outside of pip/box?
        // Drag starts handle this. Click on background?
        // Simple click on background should clear selection.
        if (!isBoxSelecting && !e.target.closest('.hexagon') && !e.target.closest('button')) {
            if (e.target !== selectionBox) {
                // If we click the selection box, we might want to keep it?
                // But selection box creates a layer.
                // Usually clicking empty space clears.
                clearSelection();
            }
        }
    });

    // Helper to update button state
    function updateSelectionUI() {
        const hasSelection = selectedPips.size > 0;
        if (btnSquish) btnSquish.disabled = !hasSelection;
        if (btnSpread) btnSpread.disabled = !hasSelection;
        if (undoButton) undoButton.disabled = historyStack.length === 0;
        // Visual style for disabled? CSS specific :disabled pseudo-class works.
        if (hasSelection) {
            selectionBox.style.borderColor = '#007bff';
            selectionBox.style.backgroundColor = 'rgba(0, 123, 255, 0.2)';
        }
    }
});
