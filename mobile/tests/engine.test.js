// Tests for the JavaScript engine + on-device API.   Run:  node --test mobile/tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');
globalThis.NummatEngine = E;
const store = {};
globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: k => delete store[k] };
const API = require('../src/localapi.js');

test('matching rules', () => {
  assert.ok(E.canMatch(3, 7) && E.canMatch(5, 5) && E.canMatch(11, 4));
  assert.ok(!E.canMatch(3, 6));
  assert.strictEqual(E.connection([[1, 2, 4], [6, 8, 9]], [0, 2], [1, 0]), 'wrap');
  assert.strictEqual(E.findPairs([[5, -1, 5]]).length, 0);
});

test('solver', () => {
  assert.strictEqual(E.solve([[1, 9, 5, 5], [3, 3, 2, 8]]).solvable, true);
  assert.strictEqual(E.solve([[2, 7, 4, 4, 9], [8, 3, 7, 1, 6], [5, 5, 2, 8, 3]]).solvable, false);
  assert.strictEqual(E.solve([[1, 3, 9, 7]]).solvable, false);
});

test('every mode generates a full, solvable board', () => {
  for (const m of Object.keys(E.MODES)) for (const skill of [2, 5, 8]) {
    const L = E.generateLevel(E.specFor(m, skill, null, null, E.recommend(skill)), E.seedFrom(m, skill));
    assert.ok(L.grid.flat().every(v => v !== 0), `${m} has empty cells`);
    assert.strictEqual(L.metrics.solvable, true, `${m} not solvable`);
  }
  for (const p of E.PACKS) for (const i of [1, 9, p.total_levels]) {
    const L = E.generateLevel(E.specFor('classic', 5, p.id, i), E.seedFrom(p.id, i));
    assert.ok(L.grid.flat().every(v => v !== 0) && L.metrics.solvable);
  }
});

test('same seed, same board', () => {
  const s = E.specFor('daily', 5);
  assert.deepStrictEqual(E.generateLevel(s, 20260928).grid, E.generateLevel(s, 20260928).grid);
});

test('daily move limit and time attack clock', () => {
  const d = E.newState('daily', E.generateLevel(E.specFor('daily', 5), 1), {});
  for (let i = 0; i < 20; i++) E.playMove(d, [0, 0], [0, 0]);
  assert.strictEqual(d.end_reason, 'out_of_moves');
  const ta = E.newState('time_attack', E.generateLevel(E.specFor('time_attack', 5), 1), { now: 1000 });
  assert.ok(E.checkTimeout(ta, 1121));
});

test('on-device API: players, games, progress', async () => {
  let r = await API.request('/api/me');
  assert.ok(r.needs_login);
  r = await API.request('/api/auth/register', { username: 'Tester', password: '1234' });
  assert.ok(r.success && r.profile.has_pin);
  r = await API.request('/api/games', { mode: 'classic', pack: 'default', level: 1 });
  let g = r.game;
  for (let i = 0; i < 100 && g.status === 'active'; i++) {
    const [mv] = E.bestMove(g.grid, g.frozen, 3000);
    r = await API.request(`/api/games/${r.game_id}/move`, { a: mv[0], b: mv[1] });
    g = r.game;
  }
  assert.strictEqual(g.status, 'won');
  assert.ok(r.result.first_clear && r.result.coins_earned > 0);
  const levels = (await API.request('/api/packs/default/levels')).levels;
  assert.ok(levels[0].completed && !levels[1].locked);
  await API.request('/api/auth/logout', {});
  assert.ok((await API.request('/api/auth/login', { username: 'tester', password: '0000' })).needs_pin);
  assert.ok((await API.request('/api/auth/login', { username: 'tester', password: '1234' })).success);
});

test('power-ups, collapsing rows and the + button', () => {
  assert.ok(E.canMatch(105, 5) && E.base(207) === 7 && E.power(207) === 2);
  let d = E.applyMoveDetailed([[1, 2, 3], [4, 105, 6], [7, 8, 209]], [], [1, 1], [0, 1]);
  assert.strictEqual(E.tilesLeft(d.grid), 0);                        // bomb chains into the row-clear
  d = E.applyMoveDetailed([[3, 7, 0], [0, 0, 0], [4, 6, 1]], [[2, 2]], [0, 0], [0, 1], true);
  assert.deepStrictEqual(d.grid, [[4, 6, 1]]);
  assert.deepStrictEqual(E.addRows([[1, 0, 3], [0, 205, 0]])[0], [[1, 0, 3], [0, 205, 1], [3, 5, 0]]);
  const lvl = (grid) => ({ grid, frozen: [], seed: 1, metrics: {}, difficulty: 'EASY', difficulty_score: 10 });
  const st = E.newState('classic', lvl([[3, 7], [4, 5]]), {});
  const ev = E.playMove(st, [0, 0], [0, 1]);
  assert.strictEqual(ev.deadlock, 'add_needed');
  assert.ok(E.addNumbers(st).success && !st.needs_add);
  assert.strictEqual(E.addInfo(st).free_left, 1);
  const zen = E.newState('zen', lvl([[3, 7, 1, 2]]), {});
  assert.strictEqual(E.playMove(zen, [0, 0], [0, 1]).deadlock, 'auto_added');
});

test('+ costs coins after the free ones (on-device API)', async () => {
  await API.request('/api/auth/register', { username: 'Adder' });
  let r = await API.request('/api/games', { mode: 'classic' });
  const gid = r.game_id;
  for (let i = 0; i < 2; i++) { r = await API.request(`/api/games/${gid}/add`, {}); assert.ok(r.event.success && !r.event.coins_spent); }
  const coins = r.profile.coins;
  r = await API.request(`/api/games/${gid}/add`, {});
  assert.strictEqual(r.event.coins_spent, 50);
  assert.strictEqual(r.profile.coins, coins - 50);
});
