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
