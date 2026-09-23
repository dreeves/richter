document.addEventListener('DOMContentLoaded', () => {
    // Config
    const PIP_SIZE = 20; // Pip diameter in px, also the collision distance
    const PIP_RADIUS = PIP_SIZE / 2;

    // Pip positions live in the DOM (style.left/top); everything else --
    // counts, totals, the URL -- is derived from them. The selection lives
    // there too: a pip is selected iff it has the .selected class.

    // The one sanctioned if-statement for things that must not happen:
    // fail loudly instead of quietly patching state
    function assert(cond, msg) {
        if (!cond) throw new Error(msg);
    }

    // URL Encoding Helpers
    const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    function toBase62(n) {
        let str = "";
        do {
            str = BASE62[Number(n % 62n)] + str;
            n /= 62n;
        } while (n > 0n);
        return str;
    }

    function fromBase62(s) {
        assert(s.length > 0, 'Empty state string');
        let n = 0n;
        for (const ch of s) {
            const digit = BASE62.indexOf(ch);
            assert(digit >= 0, `Not a base-62 digit: ${JSON.stringify(ch)}`);
            n = n * 62n + BigInt(digit);
        }
        return n;
    }

    // nCr for BigInt. The running product is exact at every step (it is
    // nCr(n, i) after step i), and a factor of zero at i = n + 1 makes
    // r > n come out as 0 without a special case.
    function nCr(n, r) {
        let res = 1n;
        for (let i = 1n; i <= r; i++) {
            res = res * (n - i + 1n) / i;
        }
        return res;
    }

    // Grid vocabulary. Column keys come from the DOM so the HTML stays the
    // source of truth, and so do row keys. BUCKET_ORDER is bottom-up
    // row-major: the annual and decennial rows are usually the emptiest,
    // and empty buckets early in the order give small bar positions in the
    // combinadic encoding (see encodeDistribution), hence shorter URLs
    const COL_KEYS = [...document.querySelectorAll('thead th[data-col]')].map(th => th.dataset.col);
    const ROW_KEYS = [...document.querySelectorAll('tr[data-row]')].map(tr => tr.dataset.row).reverse();
    // The 25 buckets (5 rows x 5 columns) as {r, c} pairs in a canonical
    // order
    const BUCKET_ORDER = ROW_KEYS.flatMap(r => COL_KEYS.map(c => ({ r, c })));
    const cellOf = ({ r, c }) => document.querySelector(`tr[data-row="${r}"] td.prob-cell[data-col="${c}"]`);
    // A target is a bucket, a whole row (colKey '*'), or a whole column
    // (rowKey '*'); this is the membership test
    const inTarget = (rowKey, colKey) => b =>
        (rowKey === '*' || b.r === rowKey) && (colKey === '*' || b.c === colKey);

    const allPips = []; // the 100 pip divs, created during initialization

    // Cached bucket rects (page coordinates), one per BUCKET_ORDER entry.
    // updateCounters refreshes them after every mutation and on resize;
    // per-frame counting during drags (renderCounts) reads the cache
    // instead of the layout
    let bucketRects = [];

    function updateGridBounds() {
        bucketRects = BUCKET_ORDER.map(b => {
            const rect = cellOf(b).getBoundingClientRect();
            return {
                left: rect.left + window.scrollX,
                top: rect.top + window.scrollY,
                width: rect.width,
                height: rect.height,
            };
        });
    }

    // Assumes updateGridBounds has run
    const rectOf = ({ r, c }) => bucketRects[BUCKET_ORDER.findIndex(b => b.r === r && b.c === c)];

    // Distance from a point to a rect: zero inside it
    function rectDistance(rect, x, y) {
        const dx = Math.max(rect.left - x, 0, x - (rect.left + rect.width));
        const dy = Math.max(rect.top - y, 0, y - (rect.top + rect.height));
        return Math.sqrt(dx * dx + dy * dy);
    }

    function argmin(items, score) {
        return items.reduce((best, item) => score(item) < score(best) ? item : best);
    }

    const pipLeft = pip => parseFloat(pip.style.left);
    const pipTop = pip => parseFloat(pip.style.top);

    // Every pip with its nearest bucket; dist is 0 for pips on the grid and
    // positive for pips parked outside it. Counts and totals use only the
    // on-grid pips; the URL (which must account for all 100) uses the
    // nearest bucket regardless.
    function placements() {
        return allPips.map(pip => {
            const cx = pipLeft(pip) + PIP_RADIUS;
            const cy = pipTop(pip) + PIP_RADIUS;
            const bucket = argmin(BUCKET_ORDER, b => rectDistance(rectOf(b), cx, cy));
            return { pip, bucket, dist: rectDistance(rectOf(bucket), cx, cy) };
        });
    }

    // Buckets in BUCKET_ORDER order, each with its on-grid pips
    function getPipsByBucket() {
        const placed = placements();
        return BUCKET_ORDER.map(b => ({
            r: b.r, c: b.c,
            pips: placed.filter(p => p.bucket === b && p.dist === 0).map(p => p.pip),
        }));
    }

    // Serialize the current distribution as a base-62 string for the URL.
    // Stars and bars: a distribution of 100 pips over 25 buckets is a
    // choice of 24 bar positions among 124 slots, and the combinatorial
    // number system maps that choice to a single integer.
    function encodeDistribution() {
        // Recount pips into buckets from their current DOM positions.
        // Off-grid pips map to the nearest bucket so the 100-pip invariant
        // survives encoding
        const placed = placements();
        const bucketCounts = BUCKET_ORDER.map(b => placed.filter(p => p.bucket === b).length);
        assert(bucketCounts.reduce((a, b) => a + b, 0) === allPips.length, 'encodeDistribution lost a pip');

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
        let v = 123n;
        for (let k = 23; k >= 0; k--) {
            const r = BigInt(k + 1);
            while (nCr(v, r) > index) v--;
            index -= nCr(v, r);
            bars[k] = v;
            v--;
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

        assert(index === 0n && counts.every(c => c >= 0), `Invalid state string: ${str}`);
        return counts;
    }

    function updateUrlState() {
        const code = encodeDistribution();
        const newUrl = `${window.location.pathname}?d=${code}`;
        window.history.replaceState({ path: newUrl }, '', newUrl);
        syncPresetSelect();
    }

    // Undo/redo stacks: snapshots of every pip's position
    const historyStack = [];
    const redoStack = [];

    // Selection: a pip is selected iff it has the .selected class
    const selectedPips = () => allPips.filter(pip => pip.classList.contains('selected'));
    const isSelected = pip => pip.classList.contains('selected');
    const setSelected = (pip, on) => pip.classList.toggle('selected', on);

    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.id = 'selection-box';
    selectionBox.dataset.handle = 'move'; // Pressing the box itself moves it

    // Add resize handles
    ['nw', 'ne', 'sw', 'se'].forEach(pos => {
        const handle = document.createElement('div');
        handle.className = `resize-handle ${pos}`;
        handle.dataset.handle = pos;
        selectionBox.appendChild(handle);
    });

    document.body.appendChild(selectionBox);

    // The box is shown iff a selection exists; CSS keys its display off
    // body.box-active. Hide cell steppers while the box is up: they sit
    // above the box in z-order and would steal clicks meant for its
    // handles
    function showBox(visible) {
        document.body.classList.toggle('box-active', visible);
    }

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

    // Hex grid for snap targets: offset rows, packed tighter vertically
    // than the pip size for a honeycomb feel
    const hexSize = 20;
    const horizontalSpacing = hexSize * 1.0;
    const verticalSpacing = hexSize * 0.8;
    // Odd rows are shifted half a slot to the right
    const hexOffset = row => Math.abs(row % 2) * horizontalSpacing / 2;

    // Neighbor offsets for the spiral searches; offset rows alternate
    // between these two sets (index 0 for even rows, 1 for odd)
    const HEX_DIRS = [
        [
            { dRow: -1, dCol: -1 }, { dRow: -1, dCol: 0 },
            { dRow: 0, dCol: -1 }, { dRow: 0, dCol: 1 },
            { dRow: 1, dCol: -1 }, { dRow: 1, dCol: 0 }
        ],
        [
            { dRow: -1, dCol: 0 }, { dRow: -1, dCol: 1 },
            { dRow: 0, dCol: -1 }, { dRow: 0, dCol: 1 },
            { dRow: 1, dCol: 0 }, { dRow: 1, dCol: 1 }
        ],
    ];

    function getGridPos(x, y) {
        const row = Math.round(y / verticalSpacing);
        const col = Math.round((x - hexOffset(row)) / horizontalSpacing);
        return { row, col };
    }

    function getScreenPos(row, col) {
        return { x: col * horizontalSpacing + hexOffset(row), y: row * verticalSpacing };
    }

    const slotKey = s => `${s.row}_${s.col}`;

    // Breadth-first spiral outward from a hex-grid slot; `allowed` fences
    // the walk (packBucket keeps it inside the bucket's rect, ANYWHERE
    // doesn't). A fenced region is finite, and an unfenced walk stops as
    // soon as its caller has the slots it needs.
    const ANYWHERE = () => true;

    function* spiral(row, col, allowed) {
        const queue = [{ row, col }];
        const visited = new Set([slotKey(queue[0])]);
        for (let i = 0; i < queue.length; i++) {
            const curr = queue[i];
            yield curr;
            HEX_DIRS[Math.abs(curr.row) % 2].forEach(d => {
                const next = { row: curr.row + d.dRow, col: curr.col + d.dCol };
                if (!visited.has(slotKey(next)) && allowed(next)) {
                    visited.add(slotKey(next));
                    queue.push(next);
                }
            });
        }
    }

    // The first `n` unoccupied slots spiralling out from (row, col); marks
    // them occupied as it goes. Returns fewer than n only if the fenced
    // region runs out.
    function freeSlots(row, col, n, occupied, allowed) {
        const slots = [];
        for (const s of spiral(row, col, allowed)) {
            if (slots.length === n) break;
            if (!occupied[slotKey(s)]) {
                slots.push(s);
                occupied[slotKey(s)] = true;
            }
        }
        return slots;
    }

    // Reserve the nearest grid slot of every pip not in the excluded set
    function getOccupiedSlots(excludePipsSet) {
        const occupied = {};
        allPips.filter(p => !excludePipsSet.has(p)).forEach(p => {
            occupied[slotKey(getGridPos(pipLeft(p), pipTop(p)))] = true;
        });
        return occupied;
    }

    function placeAtSlot(pip, slot) {
        const pos = getScreenPos(slot.row, slot.col);
        pip.style.left = pos.x + 'px';
        pip.style.top = pos.y + 'px';
    }

    // Random collision-free spot in a rect, checked against the given
    // obstacle positions ({x, y} top-left corners); after max attempts we
    // accept overlap rather than loop forever.
    function findFreeSpotInRect(rect, obstacles) {
        let x, y;
        for (let attempts = 0; attempts < 500; attempts++) {
            x = Math.random() * (rect.width - PIP_SIZE) + rect.left;
            y = Math.random() * (rect.height - PIP_SIZE) + rect.top;
            const collides = obstacles.some(o => (o.x - x) ** 2 + (o.y - y) ** 2 < PIP_SIZE * PIP_SIZE);
            if (!collides) break;
        }
        return { x, y };
    }

    const pipPositions = pips => pips.map(p => ({ x: pipLeft(p), y: pipTop(p) }));

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
        // Default layout: 5% in each of the 20 main cells, annual row empty
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

    // counts: 25 numbers in BUCKET_ORDER order, summing to 100. Pips get
    // random non-overlapping positions within their bucket's rect.
    function placePipsFromDistribution(counts) {
        assert(counts.length === BUCKET_ORDER.length, `Expected ${BUCKET_ORDER.length} bucket counts, got ${counts.length}`);
        assert(counts.reduce((a, b) => a + b, 0) === allPips.length, `Bucket counts sum to ${counts.reduce((a, b) => a + b, 0)}, not ${allPips.length}`);
        updateGridBounds();

        // Collision-checked against the pips placed earlier in this pass
        const placed = [];
        let pipCursor = 0;
        counts.forEach((count, idx) => {
            const rect = rectOf(BUCKET_ORDER[idx]);
            for (let k = 0; k < count; k++) {
                const spot = findFreeSpotInRect(rect, placed);
                const pip = allPips[pipCursor++];
                pip.style.left = spot.x + 'px';
                pip.style.top = spot.y + 'px';
                placed.push(spot);
            }
        });
    }

    // --- Pointer gestures ---
    // Pointer events cover mouse, touch and pen with one code path. Whether
    // a touch scrolls the page or drives a gesture is decided by the CSS
    // touch-action on the element under the finger (the pip cells and the
    // pips opt out of panning), never here. Left button / primary contact
    // only.
    const isPrimaryPress = e => e.isPrimary && e.button === 0;

    // While a gesture runs, its move/end handlers are on the document and
    // follow the pointer that started it (a second finger is ignored).
    // pointercancel, the browser taking the gesture for itself (a scroll
    // or a pinch), gets its own callback.
    function trackPointer(start, move, end, cancel) {
        const mine = e => e.pointerId === start.pointerId;
        const onMove = e => mine(e) && move(e);
        const finish = then => e => {
            if (!mine(e)) return;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onCancel);
            then(e);
        };
        const onUp = finish(end);
        const onCancel = finish(cancel);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
    }

    const pipCenter = pip => ({ x: pipLeft(pip) + PIP_RADIUS, y: pipTop(pip) + PIP_RADIUS });
    const inBox = (box, { x, y }) =>
        x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height;

    function boxRect() {
        return {
            left: parseFloat(selectionBox.style.left),
            top: parseFloat(selectionBox.style.top),
            width: parseFloat(selectionBox.style.width),
            height: parseFloat(selectionBox.style.height),
        };
    }

    function setBoxRect({ left, top, width, height }) {
        selectionBox.style.left = left + 'px';
        selectionBox.style.top = top + 'px';
        selectionBox.style.width = width + 'px';
        selectionBox.style.height = height + 'px';
    }

    // Select exactly the pips whose centers are inside the box
    function selectPipsInBox() {
        const box = boxRect();
        allPips.forEach(pip => setSelected(pip, inBox(box, pipCenter(pip))));
        renderCounts();
        updateSelectionUI(); // Enable/Disable buttons based on selection
    }

    // Box selection starts on any press that isn't on a control; pips and
    // the box itself stop propagation before it gets here
    const CONTROLS = 'button, select, a, .modal';

    function handleBoxStart(e) {
        if (!isPrimaryPress(e) || e.target.closest(CONTROLS)) return;

        // The box spans from the press to the pointer and the selection is
        // exactly the pips inside it. Nothing changes until the pointer
        // moves.
        const startX = e.pageX, startY = e.pageY;
        const stretchTo = e => {
            setBoxRect({
                left: Math.min(startX, e.pageX),
                top: Math.min(startY, e.pageY),
                width: Math.abs(e.pageX - startX),
                height: Math.abs(e.pageY - startY),
            });
            showBox(true);
            selectPipsInBox();
        };
        // The browser may claim a touch for scrolling only after a few
        // moves have already redrawn the selection (pointercancel), so
        // cancelling puts the previous selection and box back
        const wasSelected = new Set(selectedPips());
        const wasBox = boxRect();
        const revert = () => {
            allPips.forEach(pip => setSelected(pip, wasSelected.has(pip)));
            setBoxRect(wasBox);
            showBox(wasSelected.size > 0);
            renderCounts();
            updateSelectionUI();
        };
        // The box persists after release so it can be moved and resized;
        // a box with nothing in it (a plain click on empty space) goes
        // away, and with it the previous selection
        trackPointer(e, stretchTo, e => {
            stretchTo(e);
            showBox(selectedPips().length > 0);
        }, revert);
    }

    document.addEventListener('pointerdown', handleBoxStart);

    function clearSelection() {
        allPips.forEach(pip => setSelected(pip, false));
        showBox(false);
        updateCounters();
        updateSelectionUI(); // button state
    }

    // --- Box Move/Resize Handlers ---
    // How a drag by (dx, dy) changes the box, per handle: l/t scale the
    // left/top shift, w/h the width/height change, min is the smallest
    // size a resize may reach (a move keeps whatever size the box has)
    const BOX_DRAG = {
        move: { l: 1, t: 1, w: 0, h: 0, min: 0 },
        nw: { l: 1, t: 1, w: -1, h: -1, min: 20 },
        ne: { l: 0, t: 1, w: 1, h: -1, min: 20 },
        sw: { l: 1, t: 0, w: -1, h: 1, min: 20 },
        se: { l: 0, t: 0, w: 1, h: 1, min: 20 },
    };

    selectionBox.addEventListener('pointerdown', (e) => {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();
        const k = BOX_DRAG[e.target.dataset.handle];
        assert(k, 'Press on the selection box without a handle');
        const start = boxRect();
        const startX = e.pageX, startY = e.pageY;

        // Reselect pips that are now inside the box
        trackPointer(e, e => {
            const dx = e.pageX - startX;
            const dy = e.pageY - startY;
            setBoxRect({
                left: start.left + k.l * dx,
                top: start.top + k.t * dy,
                width: Math.max(k.min, start.width + k.w * dx),
                height: Math.max(k.min, start.height + k.h * dy),
            });
        }, selectPipsInBox, selectPipsInBox);
    });

    // Drag Logic
    function handlePipPointerDown(e, pip) {
        if (!isPrimaryPress(e)) return;
        e.stopPropagation();

        // Shift-click toggles membership in the selection; adding also
        // packs the selection
        if (e.shiftKey) {
            const adding = !isSelected(pip);
            setSelected(pip, adding);
            updateCounters(); // metrics change on selection
            updateSelectionUI(); // button state
            adding && (saveHistory(), packSelection()); // Snapshot before pack
            return;
        }

        // Pressing an unselected pip selects just that pip. No auto-pack
        // here: a drag is probably starting and packing now would yank the
        // pip away from the cursor
        if (!isSelected(pip)) {
            clearSelection();
            setSelected(pip, true);
            updateCounters();
            updateSelectionUI();
        }

        startDrag(e);
    }

    function startDrag(e) {
        const startX = e.pageX;
        const startY = e.pageY;
        const dragged = selectedPips();
        const initialPositions = new Map(dragged.map(pip => [pip, { left: pipLeft(pip), top: pipTop(pip) }]));

        saveHistory(); // Snapshot the pre-drag state for undo

        // Add dragging class for performance
        dragged.forEach(pip => pip.classList.add('dragging'));

        let hasMoved = false;

        const move = e => {
            const dx = e.pageX - startX;
            const dy = e.pageY - startY;

            hasMoved ||= Math.abs(dx) > 2 || Math.abs(dy) > 2;

            dragged.forEach(pip => {
                const init = initialPositions.get(pip);
                pip.style.left = (init.left + dx) + 'px';
                pip.style.top = (init.top + dy) + 'px';
            });

            renderCounts(); // Cached bounds; cheap enough per pointermove
        };

        const drop = () => {
            // Remove dragging class
            dragged.forEach(pip => pip.classList.remove('dragging'));

            if (!hasMoved) {
                // A plain click (no drag) packs the selection in place
                packSelection();
                return;
            }

            // Smart placement on drop: a clean drop stays exactly where the
            // user put it; only pips that collide get snapped to the
            // nearest free hex-grid slot.

            // Slots taken by unselected pips are static walls; slots taken
            // by pips placed earlier in this loop accumulate on top
            const walls = allPips.filter(p => !dragged.includes(p));
            const occupiedSlots = getOccupiedSlots(new Set(dragged));

            dragged.forEach(pip => {
                const me = pipCenter(pip);
                // Trigger on visual overlap with unselected pips only:
                // selected pips kept their relative spacing during the
                // group drag, and occupiedSlots resolves any pile-ups.
                // Even without visual overlap, the landing slot may already
                // be reserved by a pip placed earlier in this loop
                const myGrid = getGridPos(pipLeft(pip), pipTop(pip));
                const collision = walls.some(other => {
                    const o = pipCenter(other);
                    return (me.x - o.x) ** 2 + (me.y - o.y) ** 2 < PIP_SIZE * PIP_SIZE;
                }) || occupiedSlots[slotKey(myGrid)];

                if (collision) {
                    const slot = freeSlots(myGrid.row, myGrid.col, 1, occupiedSlots, ANYWHERE)[0];
                    assert(slot, 'No free hex-grid slot within range');
                    placeAtSlot(pip, slot);
                }
                // Leave it loose but reserve its nearest slot so later
                // pips in this loop don't land on it
                occupiedSlots[slotKey(getGridPos(pipLeft(pip), pipTop(pip)))] = true;
            });

            updateCounters();
            updateUrlState();
        };

        // A pointercancel mid-drag (the browser claimed a pinch) drops the
        // pips where they are
        trackPointer(e, move, drop, drop);
    }

    // Honeycomb the selection around its centroid, using only hex-grid
    // slots not held by unselected pips. Callers save history first.
    function packSelection() {
        const pips = selectedPips();
        assert(pips.length > 0, 'packSelection with nothing selected');

        const centerX = pips.reduce((sum, pip) => sum + pipLeft(pip), 0) / pips.length;
        const centerY = pips.reduce((sum, pip) => sum + pipTop(pip), 0) / pips.length;
        const centerGrid = getGridPos(centerX, centerY);
        const slots = freeSlots(centerGrid.row, centerGrid.col, pips.length, getOccupiedSlots(new Set(pips)), ANYWHERE);
        assert(slots.length === pips.length, 'Not enough free hex-grid slots within range');

        pips.forEach((pip, i) => placeAtSlot(pip, slots[i]));

        updateCounters();
        updateUrlState(); // Save to URL on pack
    }

    function snapshotPips() {
        return allPips.map(pip => ({ id: pip.id, left: pip.style.left, top: pip.style.top }));
    }

    function applyPipState(state) {
        state.forEach(item => {
            const pip = document.getElementById(item.id);
            pip.style.left = item.left;
            pip.style.top = item.top;
        });
        updateCounters();
        updateUrlState();
        updateSelectionUI();
    }

    function saveHistory() {
        historyStack.push(snapshotPips());
        historyStack.splice(0, Math.max(0, historyStack.length - 50));
        redoStack.length = 0; // A new action forks history; redo dies
        updateSelectionUI(); // Update button state
    }

    // Every interaction pushes the pre-change state right before changing
    // anything, so undo pops it back and stashes the current state for redo
    function undo() {
        assert(historyStack.length > 0, 'Nothing to undo');
        redoStack.push(snapshotPips());
        applyPipState(historyStack.pop());
    }

    function redo() {
        assert(redoStack.length > 0, 'Nothing to redo');
        historyStack.push(snapshotPips());
        applyPipState(redoStack.pop());
    }

    // A count and its selected share, as text: "20%" plus a highlighted
    // "(5%)" when any of it is selected
    const renderShare = ({ count, sel }) =>
        `${count}%${sel > 0 ? ` <span class="selected-share">(${sel}%)</span>` : ''}`;

    // Stepper buttons (−/+/⊕/⊞ controls) for a target. Re-rendered on
    // every update so the disabled states stay correct.
    function renderStepper(rowKey, colKey, count, total) {
        const div = document.createElement('div');
        div.className = 'cell-stepper';
        const button = (label, title, attrs, disabled, action) => {
            const btn = document.createElement('button');
            btn.className = 'stepper-btn';
            btn.dataset.r = rowKey;
            btn.dataset.c = colKey;
            Object.assign(btn.dataset, attrs);
            btn.title = title;
            btn.innerHTML = label;
            btn.disabled = disabled;
            btn.addEventListener('click', action);
            div.appendChild(btn);
        };
        const inside = inTarget(rowKey, colKey);
        const outside = b => !inside(b);
        // No pips anywhere else to pull from
        const nothingElsewhere = total - count === 0;
        button('&minus;', 'Move 1% to the biggest pile', { delta: '-1' }, count === 0, () => movePip(inside, outside));
        button('+', 'Move 1% here from the biggest pile', { delta: '1' }, nothingElsewhere, () => movePip(outside, inside));
        button('⊕', 'Gather these pips', { act: 'pack' }, count === 0, () => tidyCell(rowKey, colKey, 'pack'));
        button('⊞', 'Spread these pips out', { act: 'spread' }, count === 0, () => tidyCell(rowKey, colKey, 'spread'));
        return div;
    }

    // Re-read the grid and redraw every count and stepper. Gestures call
    // renderCounts per move instead: the grid can't have moved mid-gesture.
    function updateCounters() {
        updateGridBounds();
        renderCounts();
    }

    function renderCounts() {
        const placed = placements().filter(p => p.dist === 0);
        const tally = pred => {
            const hits = placed.filter(p => pred(p.bucket));
            return { count: hits.length, sel: hits.filter(p => isSelected(p.pip)).length };
        };
        const total = placed.length;

        // Wipe the per-cell overlays (counts + steppers); they're
        // re-rendered below
        document.querySelectorAll('.cell-count, .cell-stepper').forEach(el => el.remove());

        // Per-cell counts and steppers. Empty cells show no count, to
        // reduce clutter
        BUCKET_ORDER.forEach(b => {
            const cell = cellOf(b);
            const t = tally(inTarget(b.r, b.c));
            const div = document.createElement('div');
            div.className = 'cell-count';
            div.innerHTML = t.count > 0 ? renderShare(t) : '';
            cell.appendChild(div);
            cell.appendChild(renderStepper(b.r, b.c, t.count, total));
        });

        // Row and column totals get steppers too, targeting the whole row
        // or column. (Not the grand total: it's pinned at 100%.)
        const totals = [
            ...ROW_KEYS.map(r => ({ key: r, rowKey: r, colKey: '*' })),
            ...COL_KEYS.map(c => ({ key: c, rowKey: '*', colKey: c })),
        ];
        totals.forEach(({ key, rowKey, colKey }) => {
            const el = document.getElementById(`total-${key}`);
            const t = tally(inTarget(rowKey, colKey));
            el.innerHTML = renderShare(t);
            el.appendChild(renderStepper(rowKey, colKey, t.count, total));
        });

        // Grand total: the parenthetical shows the selected share highlighted,
        // or, when nothing is selected, the off-grid share in gray
        const sel = selectedPips().length;
        const [num, cls] = sel > 0 ? [sel, 'selected-share'] : [allPips.length - total, 'outside-share'];
        document.getElementById('grand-total').innerHTML = `${total}% <span class="${cls}">(${num}%)</span>`;
    }

    // --- Steppers ---
    // Move one pip (1%) into or out of a target without dragging. The
    // counterpart is always the fullest bucket outside the target, so
    // + takes from the biggest outside pile and − sends back to it; within
    // the target, + grows its fullest bucket and − shrinks its fullest.
    // Ties go to the first in reading order, so an empty column fills
    // from its top cell and an empty row from its leftmost.
    function nearestPip(pips, x, y) {
        return argmin(pips, p => (pipLeft(p) - x) ** 2 + (pipTop(p) - y) ** 2);
    }

    // Move one pip from the fullest bucket matching `from` to the fullest
    // matching `to`
    function movePip(from, to) {
        const buckets = getPipsByBucket();
        const byReadingOrder = (a, b) => rectOf(a).top - rectOf(b).top || rectOf(a).left - rectOf(b).left;
        const fullest = pred => argmin(buckets.filter(pred).sort(byReadingOrder), b => -b.pips.length);
        const source = fullest(from);
        assert(source.pips.length > 0, 'Stepper pressed with nothing to move');

        const spot = findFreeSpotInRect(rectOf(fullest(to)), pipPositions(allPips));
        const pip = nearestPip(source.pips, spot.x, spot.y);
        saveHistory();
        // Pips have a CSS left/top transition, so this animates the flight
        pip.style.left = spot.x + 'px';
        pip.style.top = spot.y + 'px';

        updateCounters();
        updateUrlState();
    }

    // Gather (pack) or spread out a target's pips, bucket by bucket, so no
    // pip ever changes buckets: probabilities are invariant under tidying.
    const TIDY = { pack: packBucket, spread: spreadBucket };

    function tidyCell(rowKey, colKey, act) {
        const buckets = getPipsByBucket().filter(b => inTarget(rowKey, colKey)(b) && b.pips.length > 0);
        assert(buckets.length > 0, 'Tidy pressed on an empty target');

        saveHistory();
        buckets.forEach(b => TIDY[act](b, rectOf(b)));
        updateCounters();
        updateUrlState();
    }

    // Honeycomb the bucket's pips around its rect's center, using only
    // hex-grid slots that keep a pip fully inside the rect
    function packBucket(bucket, rect) {
        const inRect = slot => {
            const pos = getScreenPos(slot.row, slot.col);
            return pos.x >= rect.left && pos.x + PIP_SIZE <= rect.left + rect.width &&
                pos.y >= rect.top && pos.y + PIP_SIZE <= rect.top + rect.height;
        };
        const centerGrid = getGridPos(rect.left + rect.width / 2 - PIP_RADIUS,
            rect.top + rect.height / 2 - PIP_RADIUS);
        const occupied = getOccupiedSlots(new Set(bucket.pips));
        const slots = freeSlots(centerGrid.row, centerGrid.col, bucket.pips.length, occupied, inRect);

        // Cell too crowded for a clean honeycomb; accept overlap
        bucket.pips.forEach((pip, i) => {
            const spot = slots[i] ? getScreenPos(slots[i].row, slots[i].col) : findFreeSpotInRect(rect, pipPositions(allPips));
            pip.style.left = spot.x + 'px';
            pip.style.top = spot.y + 'px';
        });
    }

    // Spread the bucket's pips in an even grid across its rect
    function spreadBucket(bucket, rect) {
        const pips = bucket.pips.slice();
        const n = pips.length;
        const aspect = rect.width / rect.height;

        const cols = Math.ceil(Math.sqrt(n * aspect));
        const rows = Math.ceil(n / cols);

        const cellW = rect.width / cols;
        const cellH = rect.height / rows;

        // Sort by current position so the motion reads as an untangling
        pips.sort((a, b) => {
            const ta = pipTop(a);
            const tb = pipTop(b);
            return Math.abs(ta - tb) > PIP_RADIUS ? ta - tb : pipLeft(a) - pipLeft(b);
        });

        pips.forEach((pip, i) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            pip.style.left = (rect.left + c * cellW + cellW / 2 - PIP_RADIUS) + 'px';
            pip.style.top = (rect.top + r * cellH + cellH / 2 - PIP_RADIUS) + 'px';
        });
    }

    const presetSelect = document.getElementById('preset-select');
    presetSelect.addEventListener('change', () => {
        const counts = PRESETS[presetSelect.value];
        assert(counts, `Unknown preset: ${presetSelect.value}`);

        saveHistory();
        clearSelection();
        placePipsFromDistribution(counts);
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

    // Snapshot Logic
    const snapshotBtn = document.getElementById('snapshot-btn');
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
                // Only absolutely positioned overlays may be ignored:
                // removing an in-flow element (like the toolbar)
                // collapses layout in html2canvas's clone and shifts
                // everything relative to the crop coordinates
                ignoreElements: (element) => element.matches('.selection-box, .cell-stepper'),
            });

            const blob = await new Promise(resolve => canvas.toBlob(resolve));
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            snapshotBtn.innerText = '✓';
        } catch (err) {
            console.error('Snapshot failed', err);
            snapshotBtn.innerText = '✗';
        }
        setTimeout(() => {
            snapshotBtn.innerText = '📷';
            snapshotBtn.disabled = false;
        }, 2000);
    });

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

        const vv = window.visualViewport;
        const content = modal.querySelector('.modal-content');
        const width = Math.min(500, vv.width * 0.9);
        content.style.width = width + 'px';
        content.style.left = (vv.pageLeft + (vv.width - width) / 2) + 'px';
        content.style.top = (vv.pageTop + vv.height * 0.15) + 'px';

        modal.style.display = 'block';
    }

    helpBtn.addEventListener('click', openHelpModal);

    // Help Modal & Close Logic: the × button and the backdrop close it;
    // clicks inside the dialog stop before reaching the backdrop
    const closeHelpModal = () => modal.style.display = 'none';
    document.querySelector('.close-btn').addEventListener('click', closeHelpModal);
    modal.querySelector('.modal-content').addEventListener('click', e => e.stopPropagation());
    modal.addEventListener('click', closeHelpModal);

    // Helper to update button state
    function updateSelectionUI() {
        undoButton.disabled = historyStack.length === 0;
        redoButton.disabled = redoStack.length === 0;
    }

    // Initialization, last so every const above is defined

    // Create the 100 pips, 1% each
    for (let i = 0; i < 100; i++) {
        const pip = document.createElement('div');
        pip.classList.add('hexagon');
        pip.setAttribute('draggable', 'false');
        pip.id = `pip-${i}`;
        pip.innerHTML = `<svg viewBox="0 0 100 100" width="20" height="20"><polygon points="50,0 93,25 93,75 50,100 7,75 7,25" fill="#000000"/></svg>`;

        pip.style.position = 'absolute'; // Positioned below, once all exist
        pip.addEventListener('pointerdown', (e) => handlePipPointerDown(e, pip));
        hexagonContainer.appendChild(pip);
        allPips.push(pip);
    }

    // Check URL for state; a fresh load is the Uniform preset
    const stateStr = new URLSearchParams(window.location.search).get('d');
    placePipsFromDistribution(stateStr === null ? PRESETS.uniform : decodeDistribution(stateStr));

    updateCounters();
    updateSelectionUI();
    window.addEventListener('resize', updateCounters);
    // Reflect the initial state (a fresh load matches the Uniform preset)
    syncPresetSelect();
});
