/* ==========================================================================
   NUMMAT game engine - JavaScript edition (for the Android / offline app).

   A line-by-line port of the Python engine in ../../engine/:
     rules.py · solver.py · generator.py · modes.py · difficulty.py ·
     hints.py · achievements.py · session.py
   Same rules, same scoring, same generator pipeline - so the phone app plays
   exactly like the desktop game, but runs entirely on the device (no server).

   Differences from the Python version:
     * random numbers come from a small seeded PRNG (mulberry32) instead of
       Python's Mersenne Twister, so a given seed makes a different (but equally
       valid and reproducible) board than on desktop.
   ========================================================================== */
(function (root) {
  'use strict';

  // =========================================================== rules =====
  const EMPTY = 0, BLOCKED = -1, WILD = 11, BOMB = 1, ROW_CLEAR = 2;
  const POWER_ICONS = { 1: '💣', 2: '➖' };
  // Power-up tiles store their number in value % 100: 1xx = bomb, 2xx = row-clear.
  const base = (v) => v > 0 ? v % 100 : v;
  const power = (v) => v > 0 ? Math.floor(v / 100) : 0;
  const FORWARD = [[[0, 1], 'row'], [[1, 0], 'column'], [[1, 1], 'diagonal'], [[1, -1], 'diagonal']];
  const ALL_DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

  const key = (p) => p[0] + ',' + p[1];
  const copyGrid = (g) => g.map(r => r.slice());
  const label = (v) => { v = base(v); return v === WILD ? '★' : v === BLOCKED ? '■' : v ? String(v) : '·'; };

  function canMatch(a, b) {
    if (a <= 0 || b <= 0) return false;
    a = base(a); b = base(b);
    if (a === WILD || b === WILD) return true;
    return a === b || a + b === 10;
  }

  function matchReason(a, b) {
    a = base(a); b = base(b);
    if (a === WILD || b === WILD) return `★ is a wildcard and matches ${label(a === WILD ? b : a)}`;
    if (a === b && a + b === 10) return `${a} = ${b} and ${a} + ${b} = 10`;
    if (a === b) return `${a} = ${b} (equal numbers)`;
    if (a + b === 10) return `${a} + ${b} = 10`;
    return `${a} and ${b} do not match`;
  }

  const isCleared = (g) => g.every(r => r.every(v => v <= 0));
  const tilesLeft = (g) => g.reduce((n, r) => n + r.filter(v => v > 0).length, 0);

  function forwardNeighbours(g, r, c) {
    const rows = g.length, cols = g[0].length, out = [];
    for (const [[dr, dc], kind] of FORWARD) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
        const v = g[rr][cc];
        if (v !== EMPTY) { if (v > 0) out.push([rr, cc, kind]); break; }
        rr += dr; cc += dc;
      }
    }
    for (let i = r * cols + c + 1; i < rows * cols; i++) {        // row wrap
      const rr = Math.floor(i / cols), cc = i % cols, v = g[rr][cc];
      if (v !== EMPTY) { if (v > 0 && rr !== r) out.push([rr, cc, 'wrap']); break; }
    }
    return out;
  }

  function connection(g, p1, p2) {
    if (p1[0] === p2[0] && p1[1] === p2[1]) return null;
    const cols = g[0].length;
    const [a, b] = (p1[0] * cols + p1[1] < p2[0] * cols + p2[1]) ? [p1, p2] : [p2, p1];
    for (const [rr, cc, kind] of forwardNeighbours(g, a[0], a[1])) if (rr === b[0] && cc === b[1]) return kind;
    return null;
  }

  function findPairs(g, frozen) {
    const fz = new Set((frozen || []).map(key));
    const out = [], seen = new Set();
    for (let r = 0; r < g.length; r++) for (let c = 0; c < g[0].length; c++) {
      const v = g[r][c];
      if (v <= 0 || fz.has(r + ',' + c)) continue;
      for (const [rr, cc, kind] of forwardNeighbours(g, r, c)) {
        if (fz.has(rr + ',' + cc) || !canMatch(v, g[rr][cc])) continue;
        const k = `${r},${c}|${rr},${cc}`;
        if (!seen.has(k)) { seen.add(k); out.push([[r, c], [rr, cc], kind]); }
      }
    }
    return out;
  }

  function pairKey(p1, p2) {
    const a = key(p1), b = key(p2);
    const lt = p1[0] < p2[0] || (p1[0] === p2[0] && p1[1] <= p2[1]);
    return lt ? a + '|' + b : b + '|' + a;
  }

  function thaw(frozen, cleared) {
    const drop = new Set();
    for (const [r, c] of cleared) for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) drop.add((r + dr) + ',' + (c + dc));
    return (frozen || []).filter(p => !drop.has(key(p))).map(p => [p[0], p[1]])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }

  /** Remove completely empty rows (never all of them). Returns [grid, frozen, removedRows]. */
  function collapseRows(g, frozen) {
    const removed = [];
    g.forEach((row, r) => { if (row.every(v => v === EMPTY)) removed.push(r); });
    if (!removed.length || removed.length === g.length) return [g, frozen, []];
    const rm = new Set(removed);
    const shift = (r) => r - removed.filter(x => x < r).length;
    return [g.filter((_, r) => !rm.has(r)), frozen.filter(p => !rm.has(p[0])).map(p => [shift(p[0]), p[1]]), removed];
  }
  const remapRow = (r, removed) => r - removed.filter(x => x < r).length;

  /** Clear p1/p2, fire power-ups (with chain reactions), thaw neighbours, optionally collapse empty rows. */
  function applyMoveDetailed(g0, frozen, p1, p2, collapse = false) {
    let g = copyGrid(g0);
    const rows = g.length, cols = g[0].length, cleared = [], fired = [];
    const queue = [[p1[0], p1[1]], [p2[0], p2[1]]];
    while (queue.length) {
      const [r, c] = queue.shift(), v = g[r][c];
      if (v <= 0) continue;
      g[r][c] = EMPTY; cleared.push([r, c]);
      const pw = power(v);
      if (pw === BOMB) {
        fired.push(['bomb', [r, c]]);
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr || dc) && rr >= 0 && rr < rows && cc >= 0 && cc < cols && g[rr][cc] > 0) queue.push([rr, cc]);
        }
      } else if (pw === ROW_CLEAR) {
        fired.push(['row', [r, c]]);
        for (let cc = 0; cc < cols; cc++) if (g[r][cc] > 0) queue.push([r, cc]);
      }
    }
    const clearedSet = new Set(cleared.map(key));
    let f = thaw((frozen || []).filter(p => !clearedSet.has(key(p))), cleared), removed = [];
    if (collapse) [g, f, removed] = collapseRows(g, f);
    return { grid: g, frozen: f, cleared, powers: fired, rows_removed: removed };
  }
  function applyMove(g, frozen, p1, p2, collapse = false) {
    const d = applyMoveDetailed(g, frozen, p1, p2, collapse);
    return [d.grid, d.frozen];
  }

  /** Classic "+": copy every remaining number (reading order, power-ups stripped) after the last tile. */
  function addRows(grid, maxRows = 40) {
    const cols = grid[0].length, values = [];
    grid.forEach(row => row.forEach(v => { if (v > 0) values.push(base(v)); }));
    if (!values.length) return null;
    const g = copyGrid(grid);
    let last = -1;
    g.forEach((row, r) => row.forEach((v, c) => { if (v !== EMPTY) last = Math.max(last, r * cols + c); }));
    let idx = last + 1;
    const added = [];
    for (const v of values) {
      for (;;) {
        const r = Math.floor(idx / cols), c = idx % cols;
        if (r >= g.length) { if (g.length >= maxRows) return null; g.push(new Array(cols).fill(EMPTY)); }
        if (g[r][c] === EMPTY) break;
        idx++;
      }
      const r = Math.floor(idx / cols), c = idx % cols;
      g[r][c] = v; added.push([r, c]); idx++;
    }
    return [g, added];
  }

  function validateMove(g, frozen, p1, p2) {
    const rows = g.length, cols = rows ? g[0].length : 0;
    for (const [r, c] of [p1, p2]) if (!(r >= 0 && r < rows && c >= 0 && c < cols)) return [false, 'Move out of bounds.', null];
    if (p1[0] === p2[0] && p1[1] === p2[1]) return [false, 'Pick two different tiles.', null];
    const a = g[p1[0]][p1[1]], b = g[p2[0]][p2[1]];
    if (a <= 0 || b <= 0) return [false, 'Selected an empty or blocked cell.', null];
    const fz = new Set((frozen || []).map(key));
    if (fz.has(key(p1)) || fz.has(key(p2))) return [false, 'That tile is frozen - clear a neighbour to thaw it.', null];
    if (!canMatch(a, b)) return [false, `${label(a)} and ${label(b)} are neither equal nor sum to 10.`, null];
    const conn = connection(g, p1, p2);
    if (!conn) return [false, 'Those tiles are not connected by a clear line.', null];
    return [true, 'ok', conn];
  }

  function parseGridText(text) {
    const map = { '.': 0, '_': 0, '0': 0, '#': -1, 'X': -1, 'x': -1, '■': -1, '*': 11, '★': 11, 'W': 11, 'w': 11 };
    const rows = [];
    for (let line of String(text || '').trim().split(/\r?\n/)) {
      line = line.trim(); if (!line) continue;
      let tokens = line.replace(/,/g, ' ').split(/\s+/);
      if (tokens.length === 1 && tokens[0].length > 1) tokens = Array.from(tokens[0]);
      rows.push(tokens.map(t => {
        if (t in map) return map[t];
        if (/^[1-9]$/.test(t)) return +t;
        throw new Error(`Unrecognised cell '${t}'`);
      }));
    }
    if (!rows.length) throw new Error('Board is empty');
    if (rows.some(r => r.length !== rows[0].length)) throw new Error('All rows must have the same number of cells');
    if (rows.length > 12 || rows[0].length > 12) throw new Error('Boards are limited to 12 x 12');
    return rows;
  }

  // ========================================================= random ======
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  /** Stable integer seed from any parts (like generator.seed_from). */
  const seedFrom = (...parts) => cyrb53(parts.map(String).join('|'));

  class Rng {
    constructor(seed) { this.s = (cyrb53(String(seed)) >>> 0) || 1; }
    random() {                                   // mulberry32
      let t = (this.s += 0x6D2B79F5) >>> 0;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    randrange(n) { return Math.floor(this.random() * n); }
    randint(a, b) { return a + this.randrange(b - a + 1); }
    uniform(a, b) { return a + (b - a) * this.random(); }
    choice(arr) { return arr[this.randrange(arr.length)]; }
    shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = this.randrange(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
    sample(arr, k) { return this.shuffle(arr.slice()).slice(0, Math.max(0, Math.min(k, arr.length))); }
  }

  // ========================================================= solver ======
  function valuesPairable(g) {
    const counts = new Array(12).fill(0);
    for (const row of g) for (const v of row) if (v > 0) counts[base(v)]++;
    let odd = counts[5] % 2;
    for (let n = 1; n <= 4; n++) odd += (counts[n] + counts[10 - n]) % 2;
    const wild = counts[WILD];
    return odd <= wild && (wild - odd) % 2 === 0;
  }

  const stateKey = (g, f) => g.map(r => r.join(',')).join(';') + '|' + f.map(key).sort().join(';');
  const hasPowers = (g) => g.some(r => r.some(v => power(v) > 0));

  function orderedMoves(g, f, collapse = false) {
    const pairs = findPairs(g, f);
    const scored = pairs.map(([p1, p2]) => {
      const [g2, f2] = applyMove(g, f, p1, p2, collapse);
      const mobility = findPairs(g2, f2).length;
      const usesWild = (base(g[p1[0]][p1[1]]) === WILD) + (base(g[p2[0]][p2[1]]) === WILD);
      return { s: -(mobility + (isCleared(g2) ? 1000 : 0)), w: usesWild, p1, p2, g2, f2 };
    });
    scored.sort((a, b) => a.s - b.s || a.w - b.w);
    return [pairs, scored];
  }

  function solve(grid, frozen = [], budget = 25000, collapse = false) {
    frozen = (frozen || []).map(p => [p[0], p[1]]);
    const res = { solvable: null, path: [], nodes: 0, moves_to_clear: Math.floor(tilesLeft(grid) / 2), branching: [], best_path: [], reason: '' };
    if (isCleared(grid)) { res.solvable = true; res.reason = 'The board is already clear.'; return finishSolve(res); }
    const n = tilesLeft(grid), powered = hasPowers(grid), rootPairable = valuesPairable(grid) && !powered;
    if (powered) { /* power-ups remove extra tiles - parity rules don't apply */ }
    else if (n % 2) res.reason = `Odd number of tiles (${n}) - one tile can never be matched.`;
    else if (!rootPairable) res.reason = 'The numbers cannot all be paired (equal or sum-to-10), whatever the layout.';
    const dead = new Set();
    let nodes = 0, exhausted = false;
    const path = [], branching = [];
    function dfs(g, f) {
      if (path.length > res.best_path.length) res.best_path = path.slice();
      if (isCleared(g)) { res.path = path.slice(); res.branching = branching.slice(); return true; }
      const k = stateKey(g, f);
      if (dead.has(k)) return false;
      if (rootPairable && !valuesPairable(g)) { dead.add(k); return false; }
      if (++nodes > budget) { exhausted = true; return false; }
      const [pairs, ordered] = orderedMoves(g, f, collapse);
      for (const m of ordered) {
        path.push([m.p1, m.p2]); branching.push(pairs.length);
        if (dfs(m.g2, m.f2)) return true;
        path.pop(); branching.pop();
        if (exhausted) return false;
      }
      dead.add(k);
      return false;
    }
    const found = dfs(copyGrid(grid), frozen);
    res.nodes = nodes;
    if (found) { res.solvable = true; res.reason = `Full clear in ${res.path.length} moves.`; }
    else if (exhausted) { res.solvable = null; res.reason = res.reason || 'Search budget exhausted before a full clear was found.'; }
    else { res.solvable = false; res.reason = res.reason || 'Every line of play ends in a deadlock.'; }
    return finishSolve(res);
  }
  function finishSolve(res) {
    res.status = res.solvable === true ? 'solvable' : res.solvable === false ? 'unsolvable' : 'unknown';
    res.nodes_searched = res.nodes;
    res.max_pairs_cleared = res.solvable ? res.path.length : res.best_path.length;
    return res;
  }

  function bestMove(grid, frozen = [], budget = 8000, collapse = false) {
    const res = solve(grid, frozen, budget, collapse);
    if (res.solvable && res.path.length) return [res.path[0], 'keeps_solvable', res];
    const [, ordered] = orderedMoves(grid, frozen || [], collapse);
    if (!ordered.length) return [null, 'no_moves', res];
    return [[ordered[0].p1, ordered[0].p2], 'max_mobility', res];
  }

  function randomPlayout(grid, frozen, rng, maxSteps = 500, collapse = false) {
    let g = copyGrid(grid), f = (frozen || []).map(p => [p[0], p[1]]), depth = 0;
    while (depth < maxSteps) {
      if (isCleared(g)) return [true, depth];
      const pairs = findPairs(g, f);
      if (!pairs.length) return [false, depth];
      const [p1, p2] = rng.choice(pairs);
      [g, f] = applyMove(g, f, p1, p2, collapse);
      depth++;
    }
    return [isCleared(g), depth];
  }

  // ====================================================== generator ======
  const TIERS = ['EASY', 'MEDIUM', 'HARD', 'EXPERT'];
  const TIER_THRESHOLDS = [[24, 'EASY'], [40, 'MEDIUM'], [55, 'HARD']];

  function levelSpec(o = {}) {
    return Object.assign({ rows: 5, cols: 5, fill: 1.0, blocked: 0, frozen: 0, wild: 0, powers: 0, target: null,
      low_first_moves: false, max_attempts: 10, rollouts: 16, solve_budget: 400 }, o);
  }

  function reachableEmpties(g, a) {
    const rows = g.length, cols = g[0].length, out = [];
    for (const [dr, dc] of ALL_DIRS) {
      let r = a[0] + dr, c = a[1] + dc;
      const kind = dr === 0 ? 'row' : dc === 0 ? 'column' : 'diagonal';
      while (r >= 0 && r < rows && c >= 0 && c < cols && g[r][c] === EMPTY) { out.push([[r, c], kind]); r += dr; c += dc; }
    }
    const total = rows * cols, ia = a[0] * cols + a[1];
    for (const step of [1, -1]) {
      for (let i = ia + step; i >= 0 && i < total; i += step) {
        const r = Math.floor(i / cols), c = i % cols;
        if (g[r][c] !== EMPTY) break;
        if (r !== a[0]) out.push([[r, c], 'wrap']);
      }
    }
    return out;
  }

  function pairValues(rng, wild) {
    if (wild) return [WILD, rng.randint(1, 9)];
    if (rng.random() < 0.5) { const n = rng.randint(1, 9); return [n, n]; }
    const a = rng.randint(1, 9); return [a, 10 - a];
  }

  function reverseBuild(spec, rng, spread) {
    const rows = spec.rows, cols = spec.cols, cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
    let blockedCount = Math.min(spec.blocked, cells.length - 4);
    if ((cells.length - blockedCount) % 2) blockedCount += (blockedCount || spec.fill >= 1.0) ? 1 : 0;
    const blocked = rng.sample(cells, blockedCount);
    const free = cells.length - blockedCount;
    const nPairs = Math.max(2, Math.floor(Math.floor(free * spec.fill + 1e-9) / 2));
    const idx = []; for (let i = 0; i < nPairs; i++) idx.push(i);
    const wildPairs = new Set(rng.sample(idx, Math.min(spec.wild, nPairs)));
    let best = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const g = []; for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(EMPTY));
      for (const [r, c] of blocked) g[r][c] = BLOCKED;
      const order = [];
      for (let k = 0; k < nPairs; k++) {
        const empties = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (g[r][c] === EMPTY) empties.push([r, c]);
        if (empties.length < 2) break;
        const options = new Map(empties.map(e => [key(e), reachableEmpties(g, e)]));
        if (spec.fill >= 1.0 && empties.some(e => !options.get(key(e)).length)) break;   // stranded cell - restart
        const live = empties.filter(e => options.get(key(e)).length);
        if (!live.length) break;
        const fewest = Math.min(...live.map(e => options.get(key(e)).length));
        const pool = live.filter(e => options.get(key(e)).length <= fewest + (spec.fill >= 1.0 ? 0 : 3));
        const a = rng.choice(pool);
        const dist = ([[r, c], kind]) => Math.max(Math.abs(r - a[0]), Math.abs(c - a[1])) + (kind === 'wrap' ? 2 : 0) + (kind === 'diagonal' ? 0.5 : 0);
        const rev = rng.random() < spread;
        const cands = options.get(key(a)).slice().sort((x, y) => rev ? dist(y) - dist(x) : dist(x) - dist(y));
        const b = cands[rng.randrange(Math.max(1, Math.floor(cands.length / 3)))][0];
        let [v1, v2] = pairValues(rng, wildPairs.has(k));
        if (rng.random() < 0.5) [v1, v2] = [v2, v1];
        g[a[0]][a[1]] = v1; g[b[0]][b[1]] = v2;
        order.push([a, b]);
      }
      if (!best || order.length > best[1].length) best = [g, order];
      if (order.length === nPairs) break;
    }
    if (!best || best[1].length < 2) return null;
    return [best[0], best[1].slice().reverse()];         // removing in reverse order always works
  }

  function replay(grid, frozen, path) {
    let g = copyGrid(grid), f = frozen.map(p => [p[0], p[1]]);
    const branching = [];
    for (const [p1, p2] of path) {
      if (!validateMove(g, f, p1, p2)[0]) return null;
      branching.push(findPairs(g, f).length);
      [g, f] = applyMove(g, f, p1, p2);
    }
    return tilesLeft(g) === 0 ? branching : null;
  }

  function knownSolution(grid, frozen, path, budget) {
    const branching = replay(grid, frozen, path);
    const probe = solve(grid, frozen, budget);
    if (branching) return finishSolve({ solvable: true, path, nodes: probe.nodes, moves_to_clear: path.length, branching, best_path: path, reason: '' });
    return probe.solvable ? probe : null;
  }

  /** Turn `count` plain tiles into power-ups (alternating bomb / row-clear). In place. */
  function addPowers(g, frozen, count, rng) {
    if (count <= 0) return;
    const fz = new Set((frozen || []).map(key)), tiles = [];
    g.forEach((row, r) => row.forEach((v, c) => { if (v > 0 && v < 100 && v !== WILD && !fz.has(r + ',' + c)) tiles.push([r, c]); }));
    rng.sample(tiles, Math.min(count, tiles.length)).forEach(([r, c], i) => { g[r][c] += 100 * [BOMB, ROW_CLEAR][(i + rng.randrange(2)) % 2]; });
  }

  function addFrozen(g, count, rng) {
    const tiles = [];
    g.forEach((row, r) => row.forEach((v, c) => { if (v > 0 && v !== WILD) tiles.push([r, c]); }));
    return rng.sample(tiles, Math.min(count, Math.max(0, Math.floor(tiles.length / 3)))).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  }

  function validate(grid, frozen, spec) {
    const values = grid.flat().map(base), tiles = values.filter(v => v > 0);
    if (values.some(v => v !== EMPTY && v !== BLOCKED && v !== WILD && !(v >= 1 && v <= 9))) return [false, 'illegal cell value'];
    if (tiles.length % 2) return [false, 'odd number of tiles'];
    if (tiles.length < 4) return [false, 'too few tiles'];
    if (!valuesPairable(grid)) return [false, 'values cannot be perfectly paired'];
    if (!findPairs(grid, frozen).length) return [false, 'no opening move'];
    if (spec && spec.frozen && frozen.length > Math.floor(tiles.length / 3)) return [false, 'too many frozen tiles'];
    return [true, 'ok'];
  }

  const r2 = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  function measure(grid, frozen = [], rng = null, rollouts = 16, solveResult = null, budget = 12000) {
    rng = rng || new Rng(0);
    const tiles = tilesLeft(grid), first = findPairs(grid, frozen);
    const res = solveResult || solve(grid, frozen, budget);
    const outcomes = [];
    for (let i = 0; i < Math.max(1, rollouts); i++) outcomes.push(randomPlayout(grid, frozen, rng));
    const deadlock = outcomes.filter(o => !o[0]).length / outcomes.length;
    const minMoves = Math.floor(tiles / 2);
    const avgDepth = outcomes.reduce((s, o) => s + o[1], 0) / outcomes.length;
    const branching = res.branching && res.branching.length ? res.branching.reduce((a, b) => a + b, 0) / res.branching.length : first.length;
    const m = {
      rows: grid.length, cols: grid[0].length, tiles, valid_pairs: first.length, first_moves: first.length,
      min_moves: minMoves, avg_solution_depth: r2(avgDepth, 2), depth_ratio: minMoves ? r2(avgDepth / minMoves, 3) : 1,
      deadlock_probability: r2(deadlock, 3), branching_factor: r2(branching, 2), solver_nodes: res.nodes,
      solvable: res.solvable, frozen: frozen.length,
      blocked: grid.flat().filter(v => v === BLOCKED).length, wild: grid.flat().filter(v => v === WILD).length,
    };
    m.difficulty_score = difficultyScore(m);
    m.difficulty = classify(m.difficulty_score);
    return m;
  }

  function difficultyScore(m) {
    const tiles = Math.max(1, m.tiles);
    const size = Math.min(1, Math.max(0, (tiles - 8) / 40));
    const trap = m.deadlock_probability;
    const scarcity = Math.max(0, 1 - m.first_moves / 8);
    const narrow = Math.max(0, 1 - m.branching_factor / Math.max(2, tiles / 3));
    const search = Math.min(1, Math.log10(Math.max(1, m.solver_nodes)) / 3.2);
    const specials = Math.min(1, (m.frozen * 1.5 + m.blocked * 0.8 - m.wild * 1.5) / 10);
    const s = 30 * trap + 22 * size + 14 * scarcity + 12 * narrow + 8 * search + 14 * Math.max(0, specials);
    return r2(Math.max(0, Math.min(100, s)), 1);
  }

  function classify(score) {
    for (const [limit, name] of TIER_THRESHOLDS) if (score < limit) return name;
    return 'EXPERT';
  }
  const starsFor = (t) => ({ EASY: 2, MEDIUM: 3, HARD: 4, EXPERT: 5 }[t] || 3);

  function generateLevel(specIn, seed) {
    const spec = levelSpec(specIn);
    const rng = new Rng(seed);
    const targetIdx = TIERS.includes(spec.target) ? TIERS.indexOf(spec.target) : null;
    let best = null, attempts = 0;
    for (let attempt = 0; attempt < spec.max_attempts; attempt++) {
      attempts++;
      let spread = targetIdx === null ? rng.uniform(0.2, 0.8) : Math.min(1, Math.max(0, 0.15 + 0.25 * targetIdx + rng.uniform(-0.15, 0.15)));
      if (spec.low_first_moves) spread = Math.max(spread, 0.75);
      const built = reverseBuild(spec, rng, spread);
      if (!built) continue;
      const [grid, path] = built;
      const frozen = spec.frozen ? addFrozen(grid, spec.frozen, rng) : [];
      if (!validate(grid, frozen, spec)[0]) continue;
      const res = knownSolution(grid, frozen, path, spec.solve_budget);
      if (!res) continue;
      const metrics = measure(grid, frozen, rng, spec.rollouts, res);
      const level = { grid, frozen, seed, metrics, difficulty: metrics.difficulty, difficulty_score: metrics.difficulty_score, attempts, solution: res.path };
      let dist = 0;
      if (targetIdx !== null) {
        dist = Math.abs(TIERS.indexOf(level.difficulty) - targetIdx) * 100;
        dist += Math.abs(level.difficulty_score - [12, 32, 47, 62][targetIdx]) / 10;
      }
      if (spec.low_first_moves) dist += Math.max(0, metrics.first_moves - metrics.tiles * 0.4) * 5;
      if (!best || dist < best[0]) best = [dist, level];
      if (dist < 3) break;
    }
    if (!best) {
      const plain = levelSpec({ rows: spec.rows, cols: spec.cols, fill: spec.fill });
      const [grid, path] = reverseBuild(plain, rng, 0.3);
      const res = knownSolution(grid, [], path, 500);
      const metrics = measure(grid, [], rng, spec.rollouts, res);
      addPowers(grid, [], spec.powers, rng);
      return { grid, frozen: [], seed, metrics, difficulty: metrics.difficulty, difficulty_score: metrics.difficulty_score, attempts, solution: res.path };
    }
    best[1].attempts = attempts;
    addPowers(best[1].grid, best[1].frozen, spec.powers, rng);   // verified solvable first; power-ups only remove extra tiles
    return best[1];
  }

  function injectSolvablePair(grid, rng) {
    const empties = [];
    grid.forEach((row, r) => row.forEach((v, c) => { if (v === EMPTY) empties.push([r, c]); }));
    rng.shuffle(empties);
    for (const a of empties) {
      const cands = reachableEmpties(grid, a);
      if (cands.length) {
        const b = rng.choice(cands)[0];
        const [v1, v2] = pairValues(rng, false);
        grid[a[0]][a[1]] = v1; grid[b[0]][b[1]] = v2;
        return [a, b];
      }
    }
    return null;
  }

  // ========================================================== modes ======
  const mode = (id, name, icon, tagline, description, hints, undos, extra = {}) => Object.assign({
    id, name, icon, tagline, description, hints, undos, time_limit: null, move_limit: null, inject_on_deadlock: true,
    endless: false, chain: false, show_score: true, items_allowed: true, solver_allowed: true, ranked: true,
    adds_free: 2, auto_add: false, collapse: true }, extra);

  const MODES = {
    classic: mode('classic', 'Classic', '🎯', 'The original.', 'Match equal numbers (5 ↔ 5) or numbers that add to 10 (3 + 7). Stuck? Tap ➕ to add numbers.', 3, 3),
    chain: mode('chain', 'Chain', '🔗', 'Think several moves ahead.', 'Every match can open new lines. Play a pair your last match unlocked to grow the chain and multiply your score.', 2, 2, { chain: true }),
    time_attack: mode('time_attack', 'Time Attack', '⏱️', '02:00 on the clock.', 'Find as many matches as possible in two minutes. Cleared boards are replaced instantly.', 1, 0, { time_limit: 120, endless: true, solver_allowed: false, adds_free: null, auto_add: true }),
    daily: mode('daily', 'Daily Challenge', '📅', 'Same puzzle for everyone.', 'One seeded board per day. 20 moves - every attempt counts. No hints, no items, daily scoreboard.', 0, 0, { move_limit: 20, inject_on_deadlock: false, items_allowed: false, solver_allowed: false, adds_free: 0, collapse: false }),
    zen: mode('zen', 'Zen', '🧘', 'No timer. No pressure.', 'No timer, no score, unlimited undo and hints. Just solve.', null, null, { show_score: false, ranked: false, adds_free: null, auto_add: true }),
    expert: mode('expert', 'Expert', '💀', 'Walls, ice and wildcards.', 'Blocked cells, frozen tiles, wildcards and power-ups. One undo, one hint, one free ➕.', 1, 1, { inject_on_deadlock: false, adds_free: 1, collapse: false }),
  };

  const PACKS = [
    { id: 'default', title: 'Classic', theme: 'classic', total_levels: 30, special: null, blurb: 'Pure number matching.' },
    { id: 'winter_event', title: 'Winter', theme: 'winter', total_levels: 15, special: 'frozen', blurb: 'Frozen tiles thaw when a neighbour is cleared.' },
    { id: 'autumn', title: 'Autumn', theme: 'autumn', total_levels: 12, special: 'blocked', blurb: 'Fallen leaves block paths.' },
    { id: 'spring', title: 'Spring', theme: 'spring', total_levels: 12, special: 'wild', blurb: 'Blossom wildcards match anything.' },
    { id: 'summer', title: 'Summer', theme: 'summer', total_levels: 15, special: 'par', blurb: 'Bigger, brighter boards - beat the par time.' },
    { id: 'challenge', title: 'Challenge', theme: 'classic', total_levels: 20, special: 'mixed', blurb: 'Everything at once.' },
  ];
  const PACK_BY_ID = Object.fromEntries(PACKS.map(p => [p.id, p]));
  const PACK_UNLOCK_REQUIREMENT = 10;

  const packLevelSize = (i) => Math.min(4 + Math.floor((i - 1) / 4), 8);
  const boardDims = (s) => s % 2 === 0 ? [s, s] : [s, s + 1];
  function packLevelTier(index, total, skill) {
    const base = Math.min(3, Math.trunc(3 * (index - 1) / Math.max(1, total - 1) + 0.25));
    const nudge = Math.max(-1, Math.min(1, Math.round((skill - 5) / 3)));
    return TIERS[Math.max(0, Math.min(3, base + nudge))];
  }

  function specFor(m, skill, pack = null, levelIndex = null, rec = null) {
    if (m === 'classic' && pack && levelIndex) {
      const p = PACK_BY_ID[pack] || PACKS[0], size = packLevelSize(levelIndex), [rows, cols] = boardDims(size);
      const spec = levelSpec({ rows, cols, fill: 1.0, target: packLevelTier(levelIndex, p.total_levels, skill) });
      const sp = p.special;
      if (sp === 'frozen' || (sp === 'mixed' && levelIndex % 3 === 1)) spec.frozen = Math.max(2, Math.floor(size / 2));
      if (sp === 'blocked' || (sp === 'mixed' && levelIndex % 3 === 2)) spec.blocked = Math.max(2, Math.floor(size / 2));
      if (sp === 'wild' || (sp === 'mixed' && levelIndex % 3 === 0)) spec.wild = 1 + (size >= 6 ? 1 : 0);
      spec.powers = size < 6 ? 0 : size < 8 ? 1 : 2;
      return spec;
    }
    if (m === 'classic') {
      rec = rec || {};
      const [rows, cols] = boardDims(rec.grid || 5);
      return levelSpec({ rows, cols, fill: 1.0, target: rec.tier || 'MEDIUM', frozen: rec.frozen || 0, blocked: rec.blocked || 0, powers: rec.powers || 0 });
    }
    if (m === 'chain') { const [rows, cols] = boardDims(skill < 4 ? 5 : skill < 7 ? 6 : 7); return levelSpec({ rows, cols, low_first_moves: true, target: skill < 6 ? 'MEDIUM' : 'HARD', powers: 1 }); }
    if (m === 'time_attack') return levelSpec({ rows: 4, cols: 5, target: skill < 5 ? 'EASY' : 'MEDIUM', max_attempts: 4, rollouts: 8 });
    if (m === 'daily') return levelSpec({ rows: 6, cols: 7, blocked: 2, target: 'HARD' });
    if (m === 'zen') return levelSpec({ rows: 6, cols: 6, target: skill < 4 ? 'EASY' : 'MEDIUM', powers: 1 });
    if (m === 'expert') return levelSpec({ rows: 7, cols: 7, blocked: 5, frozen: 5, wild: 1, target: 'EXPERT', powers: 2 });
    throw new Error('unknown mode ' + m);
  }

  function parTime(pairs, skill) {
    const per = Math.max(2.5, 6.3 - 0.35 * skill);
    return (Math.round(pairs * per / 5) * 5) || 5;
  }

  // ===================================================== difficulty ======
  const PRIOR_SKILL = 3.0, EMA_ALPHA = 0.3, WINDOW = 15;
  const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
  const WEIGHTS = { accuracy: 0.28, speed: 0.20, independence: 0.14, streak: 0.12, stability: 0.10, completion: 0.16 };

  function gameComponents(g) {
    const attempts = Math.max(1, g.attempts || 0), valid = attempts - (g.mistakes || 0);
    const pairs = Math.max(1, g.pairs || 1), matches = Math.max(1, valid);
    const spp = (g.duration || 0) / matches;
    return {
      accuracy: clamp(valid / attempts), speed: clamp((10 - spp) / 8),
      independence: clamp(1 - 0.35 * (g.hints_used || 0) - 0.2 * (g.undos_used || 0)),
      streak: clamp((g.max_streak || 0) / Math.max(4, pairs * 0.6)),
      stability: clamp(1 - 0.35 * (g.deadlocks || 0)), completion: g.won ? 1 : 0.3,
    };
  }
  function gameSkill(g) {
    const c = gameComponents(g);
    const perf = Object.keys(WEIGHTS).reduce((s, k) => s + WEIGHTS[k] * c[k], 0);
    const challenge = clamp((g.difficulty_score ?? 30) / 60);
    return r2(10 * perf * (0.6 + 0.4 * challenge), 2);
  }
  function skillFromHistory(games, prior = PRIOR_SKILL) {
    let s = prior;
    for (const g of games.slice(-WINDOW)) s = (1 - EMA_ALPHA) * s + EMA_ALPHA * gameSkill(g);
    return r2(clamp(s, 0, 10), 1);
  }
  function performanceReport(games) {
    const recent = games.slice(-WINDOW);
    if (!recent.length) return { games: 0, accuracy: null, avg_solve: null, hints: 0, undos: 0, best_streak: 0, deadlocks: 0 };
    const attempts = recent.reduce((s, g) => s + (g.attempts || 0), 0) || 1;
    const mistakes = recent.reduce((s, g) => s + (g.mistakes || 0), 0);
    const won = recent.filter(g => g.won);
    return {
      games: recent.length, accuracy: Math.round(100 * (attempts - mistakes) / attempts),
      avg_solve: won.length ? r2(won.reduce((s, g) => s + (g.duration || 0), 0) / won.length, 1) : null,
      hints: recent.reduce((s, g) => s + (g.hints_used || 0), 0), undos: recent.reduce((s, g) => s + (g.undos_used || 0), 0),
      best_streak: Math.max(...recent.map(g => g.max_streak || 0)), deadlocks: recent.reduce((s, g) => s + (g.deadlocks || 0), 0),
      win_rate: Math.round(100 * won.length / recent.length),
    };
  }
  function trend(games) {
    if (games.length < 4) return 'steady';
    const last = games.slice(-3).reduce((s, g) => s + gameSkill(g), 0) / 3;
    const prevG = games.slice(-6, -3);
    const prev = prevG.reduce((s, g) => s + gameSkill(g), 0) / Math.max(1, prevG.length);
    return last - prev > 0.6 ? 'up' : prev - last > 0.6 ? 'down' : 'steady';
  }
  function recommend(skill) {
    const size = Math.trunc(Math.max(4, Math.min(8, 4 + Math.round(skill * 0.42))));
    const [rows, cols] = boardDims(size);
    const blocked = skill >= 8 ? 2 : 0, pairs = Math.floor((rows * cols - blocked) / 2);
    const tier = skill < 3 ? 'EASY' : skill < 5.5 ? 'MEDIUM' : skill < 8 ? 'HARD' : 'EXPERT';
    const per = Math.max(2.5, 6.3 - 0.35 * skill);
    return { skill: r2(skill, 1), grid: size, rows, cols, fill: 1.0, pairs, tier,
      complexity: { EASY: 'LOW', MEDIUM: 'MEDIUM', HARD: 'HIGH', EXPERT: 'EXTREME' }[tier],
      time: Math.round(pairs * per / 5) * 5, hints: skill < 4 ? 3 : skill < 7 ? 2 : 1,
      frozen: skill >= 6 ? Math.floor(size / 3) : 0, blocked, powers: size < 6 ? 0 : size < 8 ? 1 : 2 };
  }
  function explainAdjustment(games) {
    const rep = performanceReport(games);
    if (!rep.games) return ['No games yet - starting you on a gentle board.'];
    const out = [];
    if (rep.accuracy !== null) out.push(`Accuracy ${rep.accuracy}% ` + (rep.accuracy >= 85 ? '✓ strong' : '- room to improve'));
    if (rep.hints === 0) out.push('No hints used - more complexity unlocked');
    else if (rep.hints > rep.games) out.push('Frequent hints - keeping boards approachable');
    if (rep.deadlocks) out.push(`${rep.deadlocks} deadlock(s) recently - fewer traps next`);
    out.push({ up: 'Trend ↑ - difficulty increases', down: 'Trend ↓ - difficulty eases off', steady: 'Trend → - holding steady' }[trend(games)]);
    return out;
  }

  // ========================================================== hints ======
  const CONNECTION_TEXT = {
    row: 'they sit in the same row with nothing in between',
    column: 'they sit in the same column with nothing in between',
    diagonal: 'they share a clear diagonal',
    wrap: 'the row wraps - the end of one row connects to the start of the next',
  };
  /** Pairs before/after a move; rows may collapse, so 'before' pairs are mapped to the new coordinates. */
  function newOptions(g, f, p1, p2, collapse = false) {
    const beforePairs = findPairs(g, f);
    const before = new Set(beforePairs.map(([a, b]) => pairKey(a, b)));
    const d = applyMoveDetailed(g, f, p1, p2, collapse);
    const cleared = new Set(d.cleared.map(key)), rm = d.rows_removed, mapped = new Set();
    for (const [a, b] of beforePairs) {
      if (cleared.has(key(a)) || cleared.has(key(b))) continue;
      mapped.add(pairKey([remapRow(a[0], rm), a[1]], [remapRow(b[0], rm), b[1]]));
    }
    const afterPairs = findPairs(d.grid, d.frozen);
    const after = new Set(afterPairs.map(([a, b]) => pairKey(a, b)));
    const unlocked = afterPairs.filter(([a, b]) => !mapped.has(pairKey(a, b))).map(([a, b]) => [a, b]);
    return [before, after, unlocked, d];
  }
  function easiestPair(g, f) {
    const pairs = findPairs(g, f);
    if (!pairs.length) return null;
    const rank = ([[r1, c1], [r2, c2], kind]) => [kind === 'wrap' ? 1 : 0, Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)), (base(g[r1][c1]) === WILD || base(g[r2][c2]) === WILD) ? 1 : 0];
    return pairs.slice().sort((x, y) => { const a = rank(x), b = rank(y); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; })[0];
  }
  const POWER_TEXT = { 1: "💣 It's a bomb - it also clears the tiles around it.", 2: "➖ It's a row-clear - it also clears its whole row." };
  function explainPair(g, f, p1, p2, collapse = false) {
    const a = g[p1[0]][p1[1]], b = g[p2[0]][p2[1]], conn = connection(g, p1, p2);
    const [before, after, unlocked] = newOptions(g, f, p1, p2, collapse);
    const lines = [`Tiles ${label(a)} and ${label(b)} can be matched because ${matchReason(a, b)}.`];
    if (conn) lines.push(`They are connected: ${CONNECTION_TEXT[conn]}.`);
    for (const pw of new Set([power(a), power(b)])) if (pw) lines.push(POWER_TEXT[pw]);
    if (unlocked.length) lines.push(`This move also opens ${unlocked.length} additional matching possibilit${unlocked.length === 1 ? 'y' : 'ies'}.`);
    else if (after.size < before.size - 1) lines.push('Careful - this move removes other options too.');
    return { text: lines, connection: conn, unlocks: unlocked.length, options_before: before.size, options_after: after.size };
  }
  function hint(g, f, level, reuse = null, budget = 6000, collapse = false) {
    level = Math.max(1, Math.min(3, parseInt(level, 10) || 1));
    if (level === 3) {
      const [move, reason, res] = bestMove(g, f, budget, collapse);
      if (!move) return null;
      const info = explainPair(g, f, move[0], move[1], collapse);
      info.text.push(reason === 'keeps_solvable' ? `Solver: this is the first step of a full clear (${res.moves_to_clear} moves).`
        : 'Solver: no guaranteed full clear found - this move keeps the most options open.');
      return Object.assign({ level: 3, pair: [move[0], move[1]], title: 'Optimal move' }, info);
    }
    let p1, p2;
    if (reuse) [p1, p2] = reuse;
    else { const found = easiestPair(g, f); if (!found) return null; [p1, p2] = found; }
    if (level === 1) return { level: 1, pair: [p1, p2], title: 'Try these two tiles.', text: ['Try these two tiles.'], unlocks: null };
    return Object.assign({ level: 2, pair: [p1, p2], title: 'Why this works' }, explainPair(g, f, p1, p2, collapse));
  }
  function explainMove(g, f, p1, p2, conn, s0, s1, chain, collapse = false) {
    const a = g[p1[0]][p1[1]], b = g[p2[0]][p2[1]];
    const [before, after, unlocked, d] = newOptions(g, f, p1, p2, collapse);
    const ba = base(a), bb = base(b);
    return {
      outcome: d, powers: d.powers.map(([t, p]) => ({ type: t, pos: p, icon: POWER_ICONS[t === 'bomb' ? 1 : 2] })),
      extra_cleared: d.cleared.length - 2, rows_removed: d.rows_removed.length,
      values: [label(a), label(b)], rule: matchReason(a, b), sum_to_10: ba + bb === 10 && ba !== WILD && bb !== WILD, equal: ba === bb,
      connection: conn, same_row: p1[0] === p2[0], same_column: p1[1] === p2[1], diagonal: conn === 'diagonal', wrap: conn === 'wrap',
      distance: Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1])),
      options_before: before.size, options_after: after.size, unlocked,
      difficulty_impact: after.size - before.size, streak: [s0, s1], chain,
    };
  }

  // ==================================================== achievements =====
  const CATEGORIES = ['Skill', 'Speed', 'Strategy', 'Exploration', 'Extreme'];
  const won = (c) => c.event === 'finish' && !!(c.game && c.game.won);
  const G = (c) => c.game || {};
  const A = (id, name, icon, category, reward, desc, check) => ({ id, name, icon, category, reward, desc, check });
  const ACHIEVEMENTS = [
    A('first_match', 'First Match', '🏅', 'Skill', 10, 'Make your first match', c => (c.stats.total_matches || 0) >= 1 || (c.streak || 0) >= 1),
    A('streak_5', 'Hot Streak', '🏅', 'Skill', 25, 'Reach a 5 streak', c => (c.streak || 0) >= 5),
    A('streak_10', 'On Fire', '🏅', 'Skill', 50, 'Reach a 10 streak', c => (c.streak || 0) >= 10),
    A('perfect_10', '10 Perfect Matches', '🏅', 'Skill', 100, 'Finish 10 games with 100% accuracy', c => (c.stats.perfect_games || 0) >= 10),
    A('perfectionist', 'No-Mistake Run', '🏅', 'Skill', 75, 'Clear a board with no mistakes, hints or undos', c => won(c) && !G(c).mistakes && !G(c).hints_used && !G(c).undos_used && !G(c).assisted),
    A('speed_demon', 'Speed Demon', '⚡', 'Speed', 50, 'Clear a board in under 2 minutes', c => won(c) && (G(c).duration ?? 999) < 120),
    A('lightning', 'Lightning', '⚡', 'Speed', 100, 'Clear a 6×6 or larger board in under 60 seconds', c => won(c) && (G(c).rows || 0) * (G(c).cols || 0) >= 36 && (G(c).duration ?? 999) < 60),
    A('under_30', 'Under 30 Seconds', '⚡', 'Speed', 60, 'Clear any board in under 30 seconds', c => won(c) && (G(c).duration ?? 999) < 30),
    A('rapid_fire', 'Rapid Fire', '⚡', 'Speed', 80, 'Make 30 matches in one Time Attack run', c => c.event === 'finish' && G(c).mode === 'time_attack' && (G(c).matches || 0) >= 30),
    A('master_planner', 'Master Planner', '🧠', 'Strategy', 100, 'Build a chain of 5 in Chain mode', c => (c.chain || 0) >= 5 || (G(c).max_chain || 0) >= 5),
    A('optimal_solver', 'Optimal Solver', '🧠', 'Strategy', 120, 'Clear a HARD or EXPERT board with no hints, undos or deadlocks', c => won(c) && ['HARD', 'EXPERT'].includes(G(c).difficulty) && !G(c).hints_used && !G(c).undos_used && !G(c).deadlocks && !G(c).assisted),
    A('deadlock_escape', 'Deadlock Escape', '🧠', 'Strategy', 60, 'Hit a deadlock and still clear the board', c => won(c) && (G(c).deadlocks || 0) >= 1),
    A('explorer_autumn', 'Autumn Explorer', '🍂', 'Exploration', 40, 'Clear a level in the Autumn pack', c => (c.packs_won || []).includes('autumn')),
    A('explorer_spring', 'Spring Explorer', '🌸', 'Exploration', 40, 'Clear a level in the Spring pack', c => (c.packs_won || []).includes('spring')),
    A('explorer_summer', 'Summer Explorer', '☀️', 'Exploration', 40, 'Clear a level in the Summer pack', c => (c.packs_won || []).includes('summer')),
    A('explorer_winter', 'Winter Explorer', '❄️', 'Exploration', 40, 'Clear a level in the Winter pack', c => (c.packs_won || []).includes('winter_event')),
    A('daily_player', 'Daily Player', '📅', 'Exploration', 50, 'Finish a Daily Challenge', c => c.event === 'finish' && G(c).mode === 'daily'),
    A('zen_garden', 'Zen Garden', '🧘', 'Exploration', 50, 'Clear 5 Zen boards', c => (c.stats.zen_clears || 0) >= 5),
    A('collector', 'Collector', '📦', 'Exploration', 200, 'Complete every level in a pack', c => (c.packs_complete || []).length >= 1),
    A('impossible_survived', 'Impossible Survived', '💀', 'Extreme', 150, 'Clear an Expert-mode board', c => won(c) && G(c).mode === 'expert'),
    A('streak_20', 'Unstoppable', '🔥', 'Extreme', 100, 'Reach a 20 streak', c => (c.streak || 0) >= 20),
    A('streak_50', '50 Streak', '🔥', 'Extreme', 300, 'Reach a 50 streak', c => (c.streak || 0) >= 50),
    A('master', 'Master of NUMMAT', '👑', 'Extreme', 500, 'Reach skill 9.0 or complete every pack', c => (c.skill || 0) >= 9 || (c.packs_complete || []).length >= 6),
  ];
  const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
  const achPublic = (a) => { const { check, ...rest } = a; return rest; };
  function evaluateAchievements(ctx) {
    ctx.stats = ctx.stats || {};
    const have = new Set(ctx.unlocked || []);
    return ACHIEVEMENTS.filter(a => { if (have.has(a.id)) return false; try { return !!a.check(ctx); } catch (e) { return false; } }).map(a => a.id);
  }

  // ======================================================== session ======
  const MAX_HISTORY = 40, ADD_COST = 50, MAX_ROWS = 40;
  const now = () => Date.now() / 1000;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function newState(m, level, o = {}) {
    const cfg = MODES[m], t = o.now || now();
    const hints = (o.hints_override == null || cfg.hints === 0) ? cfg.hints : o.hints_override;
    return {
      mode: m, pack: o.pack || null, level_index: o.level_index || null, level_key: o.level_key || null, seed: level.seed,
      spec: o.spec || {}, grid: copyGrid(level.grid), frozen: level.frozen.map(p => [p[0], p[1]]),
      rows: level.grid.length, cols: level.grid[0].length, pairs_total: Math.floor(tilesLeft(level.grid) / 2),
      difficulty: level.difficulty, difficulty_score: level.difficulty_score, metrics: level.metrics,
      score: 0, streak: 0, max_streak: 0, matches: 0, moves: 0, attempts: 0, mistakes: 0,
      hints_left: hints, hints_used: 0, undos_left: cfg.undos, undos_used: 0, hint_pair: null,
      chain: 0, max_chain: 0, last_unlocked: [], deadlocks: 0, injections: 0, stuck: false, boards_cleared: 0,
      started_at: t, deadline: cfg.time_limit ? t + cfg.time_limit : null, par_time: o.par || null, move_limit: cfg.move_limit,
      shield: false, double_coins: false, assisted: false, items_used: [], status: 'active', end_reason: null,
      ended_at: null, history: [], last_explain: null,
      adds_used: 0, adds_free: cfg.adds_free, collapse: cfg.collapse, needs_add: false, rows_cleared: 0, powers_fired: 0,
    };
  }
  const cfgOf = (s) => MODES[s.mode];
  const elapsed = (s, t) => Math.max(0, (s.ended_at || t || now()) - s.started_at);
  const timeLeft = (s, t) => s.deadline ? Math.max(0, s.deadline - (t || now())) : null;

  function publicView(s, t) {
    const cfg = cfgOf(s), v = {};
    for (const k of Object.keys(s)) if (!['history', 'hint_pair', 'spec'].includes(k)) v[k] = s[k];
    v.time_left = timeLeft(s, t);
    v.elapsed = r2(elapsed(s, t), 1);
    v.moves_used = s.attempts;
    v.moves_remaining = s.move_limit ? s.move_limit - s.attempts : null;
    v.can_undo = s.history.length > 0 && (s.undos_left === null || s.undos_left > 0);
    v.available_pairs = findPairs(s.grid, s.frozen).length;
    v.mode_config = cfg;
    v.add = addInfo(s);
    if (!cfg.show_score) v.score = null;
    return clone(v);
  }

  function completionBonus(s, t) {
    if (s.mode === 'time_attack') return 25 * s.boards_cleared;
    let bonus = 100;
    if (s.par_time) { const spent = elapsed(s, t); if (spent < s.par_time) bonus += Math.trunc((s.par_time - spent) * 2); }
    if (s.mode === 'daily' && s.move_limit) bonus += 15 * Math.max(0, s.move_limit - s.attempts);
    if (s.mode === 'expert') bonus += 150;
    return bonus;
  }
  function finish(s, status, reason, t) {
    if (s.status !== 'active') return;
    t = t || now();
    s.status = status; s.end_reason = reason; s.ended_at = t;
    if (status === 'won' || s.mode === 'time_attack') s.score += completionBonus(s, t);
  }
  function checkTimeout(s, t) {
    if (s.status !== 'active' || !s.deadline) return false;
    t = t || now();
    if (t >= s.deadline) { finish(s, 'finished', 'time_up', s.deadline); return true; }
    return false;
  }
  const snapshot = (s) => clone({ grid: s.grid, frozen: s.frozen, score: s.score, chain: s.chain, last_unlocked: s.last_unlocked, moves: s.moves, boards_cleared: s.boards_cleared, rows_cleared: s.rows_cleared || 0 });

  function points(s, a, b, conn, dist, chained) {
    a = base(a); b = base(b);
    let p = 10;
    if (s.streak >= 3) p += Math.min(50, 5 * (s.streak - 2));
    if (a + b === 10 && a !== WILD && b !== WILD) p += 5;
    if (conn === 'wrap') p += 4; else if (dist > 1) p += Math.min(6, 2 * (dist - 1));
    if (chained) p += 15 * Math.min(s.chain, 10);
    return p;
  }
  function newBoard(s) {
    const spec = Object.keys(s.spec || {}).length ? s.spec : levelSpec({ rows: 5, cols: 5, max_attempts: 3, rollouts: 6 });
    const lvl = generateLevel(spec, seedFrom(s.seed, 'board', s.boards_cleared));
    s.grid = copyGrid(lvl.grid); s.frozen = lvl.frozen.map(p => [p[0], p[1]]);
    s.rows = lvl.grid.length; s.cols = lvl.grid[0].length; s.history = []; s.last_unlocked = [];
  }

  function playMove(s, p1, p2, t) {
    t = t || now();
    const cfg = cfgOf(s);
    if (checkTimeout(s, t)) return { success: false, message: "Time's up!", game_over: true };
    if (s.status !== 'active') return { success: false, message: 'This game is over.', game_over: true };
    if (s.stuck) return { success: false, message: 'Deadlock! Undo your last move or end the game.', stuck: true };
    if (s.needs_add) return { success: false, message: 'No moves left - tap ➕ to add numbers.', needs_add: true };
    p1 = [p1[0], p1[1]]; p2 = [p2[0], p2[1]];
    const g = s.grid, f = s.frozen;
    s.attempts++;
    const [ok, message, conn] = validateMove(g, f, p1, p2);
    if (!ok) {
      s.mistakes++;
      let shielded = false;
      if (s.shield && s.streak > 0) { s.shield = false; shielded = true; } else s.streak = 0;
      s.chain = 0;
      const ev = { success: false, valid: false, message, shielded };
      if (s.move_limit && s.attempts >= s.move_limit) { finish(s, 'finished', 'out_of_moves', t); ev.game_over = true; }
      return ev;
    }
    const a = g[p1[0]][p1[1]], b = g[p2[0]][p2[1]], s0 = s.streak;
    const chained = cfg.chain && new Set(s.last_unlocked.map(([x, y]) => pairKey(x, y))).has(pairKey(p1, p2));
    s.history.push(snapshot(s)); s.history = s.history.slice(-MAX_HISTORY);
    s.streak++; s.max_streak = Math.max(s.max_streak, s.streak); s.matches++; s.moves++;
    s.chain = chained ? s.chain + 1 : (cfg.chain ? 1 : 0); s.max_chain = Math.max(s.max_chain, s.chain);
    const dist = Math.max(Math.abs(p1[0] - p2[0]), Math.abs(p1[1] - p2[1]));
    let pts = points(s, a, b, conn, dist, chained);
    const collapse = !!s.collapse;
    const ex = explainMove(g, f, p1, p2, conn, s0, s.streak, s.chain, collapse);
    const out = ex.outcome; delete ex.outcome;
    if (ex.extra_cleared > 0) pts += 20 * ex.extra_cleared;       // power-ups: bonus per extra tile
    if (ex.rows_removed) pts += 25 * ex.rows_removed;              // cleared rows
    s.score += pts;
    const frozenBefore = f.map(p => [p[0], p[1]]);
    s.grid = out.grid; s.frozen = out.frozen; s.rows = out.grid.length;
    s.rows_cleared = (s.rows_cleared || 0) + ex.rows_removed; s.powers_fired = (s.powers_fired || 0) + ex.powers.length;
    s.last_unlocked = ex.unlocked; s.hint_pair = null; s.needs_add = false; ex.points = pts; s.last_explain = ex;
    const clearedSet = new Set(out.cleared.map(key)), nfKeys = new Set(s.frozen.map(key));
    const ev = { success: true, valid: true, points: pts, explain: ex, cleared: out.cleared, rows_removed: out.rows_removed,
      powers: ex.powers,
      thawed: frozenBefore.filter(p => !clearedSet.has(key(p)) && !nfKeys.has(key([remapRow(p[0], out.rows_removed), p[1]]))) };
    if (tilesLeft(s.grid) === 1) {                                 // a single tile can never be matched
      s.grid.forEach((row, r) => row.forEach((v, c) => { if (v > 0) { s.grid[r][c] = 0; ev.last_tile = [r, c]; } }));
      s.score += 30;
    }
    if (isCleared(s.grid)) {
      if (cfg.endless) { s.boards_cleared++; s.score += 50; newBoard(s); ev.new_board = true; }
      else { finish(s, 'won', 'cleared', t); ev.game_over = true; ev.won = true; return ev; }
    } else if (!findPairs(s.grid, s.frozen).length) {
      handleDeadlock(s, ev, t);
      if (ev.game_over) return ev;
    }
    if (s.move_limit && s.attempts >= s.move_limit && s.status === 'active') { finish(s, 'finished', 'out_of_moves', t); ev.game_over = true; }
    return ev;
  }

  // ------------------------------------------------------- "+" add numbers --
  function addInfo(s) {
    const free = s.adds_free === undefined ? 0 : s.adds_free, used = s.adds_used || 0, cfg = cfgOf(s);
    const freeLeft = free === null ? null : Math.max(0, free - used);
    const cost = (free === null || freeLeft > 0) ? 0 : (cfg.items_allowed ? ADD_COST : null);
    return { free_left: freeLeft, cost, used, available: s.status === 'active' && cost !== null && tilesLeft(s.grid) > 0, needed: !!s.needs_add };
  }

  function addNumbers(s, paid = false) {
    if (s.status !== 'active') return { success: false, message: 'This game is over.' };
    const info = addInfo(s);
    if (info.cost === null) return { success: false, message: "Adding numbers isn't allowed in this mode." };
    if (info.cost && !paid) return { success: false, message: `No free adds left - it costs ${ADD_COST} coins.`, cost: info.cost };
    const result = addRows(s.grid, MAX_ROWS);
    if (!result) return { success: false, message: 'The board is full - match some tiles first.' };
    const [grid, added] = result;
    s.grid = grid; s.rows = grid.length; s.adds_used = (s.adds_used || 0) + 1;
    s.pairs_total += Math.floor(added.length / 2);
    s.history = []; s.hint_pair = null; s.stuck = false; s.needs_add = false; s.last_unlocked = [];
    const ev = { success: true, added, paid: !!info.cost, message: `➕ ${added.length} numbers added` };
    if (!findPairs(s.grid, s.frozen).length) handleDeadlock(s, ev, now());
    return ev;
  }

  function handleDeadlock(s, ev, t) {
    const cfg = cfgOf(s);
    s.deadlocks++; s.chain = 0;
    const info = addInfo(s);
    if (cfg.auto_add && info.cost === 0 && addRows(s.grid, MAX_ROWS)) {
      const auto = addNumbers(s);
      ev.deadlock = 'auto_added'; ev.added = auto.added || [];
      return;
    }
    if (info.cost !== null && addRows(s.grid, MAX_ROWS)) { s.needs_add = true; ev.deadlock = 'add_needed'; return; }
    if (cfg.inject_on_deadlock && !cfg.move_limit) {
      const placed = injectSolvablePair(s.grid, new Rng(seedFrom(s.seed, 'inject', s.matches)));
      if (!placed) s.frozen = [];
      s.injections++; ev.deadlock = 'injected'; ev.injected = placed ? placed : [];
      return;
    }
    if (s.undos_left === null || s.undos_left > 0) { s.stuck = true; ev.deadlock = 'stuck'; }
    else { finish(s, s.mode === 'expert' ? 'lost' : 'finished', 'deadlock', t); ev.deadlock = 'final'; ev.game_over = true; }
  }

  function undo(s) {
    if (s.status !== 'active') return { success: false, message: 'This game is over.' };
    if (!s.history.length) return { success: false, message: 'No moves to undo.' };
    if (s.undos_left !== null && s.undos_left <= 0) return { success: false, message: 'No undos left.' };
    Object.assign(s, s.history.pop());
    if (s.undos_left !== null) s.undos_left--;
    s.undos_used++; s.streak = 0; s.stuck = false; s.needs_add = false; s.hint_pair = null; s.rows = s.grid.length;
    return { success: true };
  }

  function useHint(s, level = 1, free = false) {
    if (s.status !== 'active') return { success: false, message: 'This game is over.' };
    level = Math.max(1, Math.min(3, parseInt(level, 10) || 1));
    const reuse = level === 2 ? s.hint_pair : null;
    const cost = (free || (level === 2 && reuse)) ? 0 : 1;
    if (cost && s.hints_left !== null && s.hints_left <= 0)
      return { success: false, message: cfgOf(s).hints === 0 ? 'Hints are disabled in this mode.' : 'No hints remaining!' };
    const h = hint(s.grid, s.frozen, level, reuse, 6000, !!s.collapse);
    if (!h) return { success: false, message: 'No moves available right now.' };
    if (cost) { if (s.hints_left !== null) s.hints_left--; s.hints_used++; }
    s.hint_pair = h.pair;
    return Object.assign(h, { success: true, hints_left: s.hints_left, cost });
  }

  function analyse(s, reveal = false, budget = 20000) {
    const res = solve(s.grid, s.frozen, budget, !!s.collapse);
    if (reveal && res.solvable) s.assisted = true;
    const out = clone(res);
    if (!reveal) out.path = [];
    return out;
  }

  function useItem(s, item) {
    if (s.status !== 'active') return { success: false, message: 'This game is over.' };
    if (!cfgOf(s).items_allowed) return { success: false, message: 'Items are disabled in this mode.' };
    let result;
    if (item === 'shuffle') {
      const rng = new Rng(seedFrom(s.seed, 'shuffle', s.attempts, s.items_used.length));
      const cells = []; s.grid.forEach((row, r) => row.forEach((v, c) => { if (v > 0) cells.push([r, c]); }));
      const values = cells.map(([r, c]) => s.grid[r][c]);
      for (let i = 0; i < 30; i++) {
        rng.shuffle(values);
        cells.forEach(([r, c], k) => { s.grid[r][c] = values[k]; });
        if (findPairs(s.grid, s.frozen).length) break;
      }
      s.assisted = true; s.stuck = false;
      s.needs_add = !!s.needs_add && !findPairs(s.grid, s.frozen).length;
      result = { success: true, message: 'Board shuffled! 🔀' };
    } else if (item === 'smart_hint') {
      result = useHint(s, 3, true);
      if (!result.success) return result;
      result.message = 'Smart hint 💡';
    } else if (item === 'time_freeze') {
      if (!s.deadline) return { success: false, message: 'No clock to freeze in this mode.' };
      s.deadline += 15; result = { success: true, message: 'Time frozen: +15 s ⏱' };
    } else if (item === 'streak_shield') {
      s.shield = true; result = { success: true, message: "Streak shield active 🔥 - your next mistake won't break the streak" };
    } else if (item === 'double_coins') {
      s.double_coins = true; result = { success: true, message: 'Double coins for this game ✨' };
    } else return { success: false, message: 'Unknown item.' };
    s.items_used.push(item);
    return result;
  }

  function abandon(s, t) {
    if (s.status === 'active') {
      if (s.mode === 'time_attack' && s.matches) finish(s, 'finished', 'ended', t);
      else finish(s, 'abandoned', 'abandoned', t);
    }
  }

  function summary(s) {
    return {
      mode: s.mode, pack: s.pack, won: s.status === 'won' || (s.mode === 'time_attack' && s.boards_cleared > 0),
      status: s.status, score: s.score || 0, matches: s.matches, attempts: s.attempts, mistakes: s.mistakes,
      hints_used: s.hints_used, undos_used: s.undos_used, max_streak: s.max_streak, max_chain: s.max_chain,
      deadlocks: s.deadlocks, duration: r2(elapsed(s), 2), pairs: s.pairs_total, rows: s.rows, cols: s.cols,
      difficulty: s.difficulty, difficulty_score: s.difficulty_score, assisted: s.assisted,
      adds_used: s.adds_used || 0, rows_cleared: s.rows_cleared || 0, powers_fired: s.powers_fired || 0,
    };
  }

  const Engine = {
    EMPTY, BLOCKED, WILD, BOMB, ROW_CLEAR, base, power, collapseRows, applyMoveDetailed, addRows, addPowers,
    ADD_COST, addInfo, addNumbers, label, canMatch, matchReason, isCleared, tilesLeft, connection, findPairs, pairKey, applyMove,
    validateMove, parseGridText, Rng, seedFrom, solve, bestMove, randomPlayout, valuesPairable,
    TIERS, levelSpec, generateLevel, measure, classify, starsFor, validate, injectSolvablePair,
    MODES, PACKS, PACK_BY_ID, PACK_UNLOCK_REQUIREMENT, packLevelSize, boardDims, specFor, parTime,
    PRIOR_SKILL, WINDOW, gameSkill, skillFromHistory, performanceReport, trend, recommend, explainAdjustment,
    hint, explainMove, CATEGORIES, ACHIEVEMENTS, ACH_BY_ID, achPublic, evaluateAchievements,
    newState, publicView, checkTimeout, playMove, undo, useHint, analyse, useItem, abandon, summary, elapsed,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.NummatEngine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
