/* ==========================================================================
   NUMMAT LocalAPI - the Flask server, re-implemented to run on the phone.

   The game UI (static/js/app.js) talks to "/api/..." endpoints. In the Android
   app there is no server, so app.js hands every request to LocalAPI.request(),
   which answers with exactly the same JSON the Python API (api.py +
   services.py) would, using the JavaScript engine and saving everything in the
   device's local storage.

   Behaves like the desktop app: local players ("Who's playing?"), optional
   PIN, remembers the last player, leaderboards list the players on this device.
   ========================================================================== */
(function (root) {
  'use strict';
  const E = root.NummatEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const STORE_KEY = 'nummat-save-v1';
  const LEVEL_VERSION = 'm1';
  const MAX_GAMES = 400;                 // finished-game history kept per device
  const GUEST = 'guest';

  const SHOP_ITEMS = [
    { id: 'shuffle', name: 'Shuffle', icon: '🔀', price: 100, desc: 'Reshuffle the remaining tiles.' },
    { id: 'smart_hint', name: 'Smart Hint', icon: '💡', price: 150, desc: "The solver's optimal move, free of your hint allowance." },
    { id: 'time_freeze', name: 'Time Freeze', icon: '⏱', price: 200, desc: '+15 seconds on the clock.' },
    { id: 'streak_shield', name: 'Streak Shield', icon: '🔥', price: 250, desc: "Your next mistake won't break your streak." },
    { id: 'double_coins', name: 'Double Coins', icon: '✨', price: 300, desc: 'Double the coins earned by one game.' },
  ];
  const SHOP_BY_ID = Object.fromEntries(SHOP_ITEMS.map(i => [i.id, i]));
  const STAT_KEYS = ['total_matches', 'highest_streak', 'total_time_played', 'levels_completed', 'total_moves', 'total_attempts',
    'total_mistakes', 'hints_used', 'undos_used', 'deadlocks', 'games_played', 'games_won', 'perfect_games', 'zen_clears', 'total_score'];

  // ------------------------------------------------------------- storage --
  let memoryStore = null;
  const storage = {
    get() {
      try { return root.localStorage ? root.localStorage.getItem(STORE_KEY) : memoryStore; } catch (e) { return memoryStore; }
    },
    set(v) {
      memoryStore = v;
      try { if (root.localStorage) root.localStorage.setItem(STORE_KEY, v); } catch (e) { /* storage full / unavailable */ }
    },
  };
  let DB = null;
  function load() {
    if (DB) return DB;
    try { DB = JSON.parse(storage.get() || 'null'); } catch (e) { DB = null; }
    if (!DB || !DB.users) DB = { version: 1, next_id: 1, users: {}, games: [], active: {}, session: null, last_player: null, daily: {} };
    return DB;
  }
  function save() {
    if (DB.games.length > MAX_GAMES) DB.games = DB.games.slice(-MAX_GAMES);
    const days = Object.keys(DB.daily).sort();
    while (days.length > 3) delete DB.daily[days.shift()];
    storage.set(JSON.stringify(DB));
  }
  const nextId = () => DB.next_id++;
  const nowIso = () => new Date().toISOString();

  // --------------------------------------------------------------- utils --
  async function hashPin(pin, salt) {
    const text = salt + ':' + pin;
    try {
      if (root.crypto && root.crypto.subtle && root.TextEncoder) {
        const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return 'sha256$' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* fall through */ }
    return 'c53$' + E.seedFrom(text, 'nummat-pin').toString(16);
  }
  const randomSalt = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const ok = (data) => Object.assign({ success: true }, data || {});
  const fail = (message, status = 400, extra) => Object.assign({ success: false, message, status }, extra || {});
  const needLogin = () => ({ success: false, needs_login: true, status: 401, message: 'Choose a player first.' });
  const todayUtc = () => new Date().toISOString().slice(0, 10);

  // ------------------------------------------------------------- players --
  function createUser(username, pinHash, isGuest) {
    const u = {
      id: nextId(), username, pin: pinHash || null, is_guest: !!isGuest, created_at: nowIso(), last_seen: nowIso(),
      coins: 100, xp: 0, skill: E.PRIOR_SKILL, theme: 'classic', inventory: { shuffle: 1 }, tutorial_done: false,
      stats: Object.fromEntries(STAT_KEYS.map(k => [k, 0])), achievements: {},
    };
    DB.users[u.id] = u;
    return u;
  }
  const displayName = (u) => u.is_guest ? 'Guest' : u.username;
  function playerLevel(xp) {
    const lvl = Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1;
    const floor = 50 * (lvl - 1) ** 2, next = 50 * lvl ** 2;
    return [lvl, xp - floor, next - floor];
  }
  const userGames = (u) => DB.games.filter(g => g.user_id === u.id);

  function dailyStreak(u) {
    const dates = new Set(userGames(u).filter(g => g.mode === 'daily').map(g => g.daily_date));
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    const iso = (x) => x.toISOString().slice(0, 10);
    if (!dates.has(iso(d))) d.setUTCDate(d.getUTCDate() - 1);
    let n = 0;
    while (dates.has(iso(d))) { n++; d.setUTCDate(d.getUTCDate() - 1); }
    return n;
  }

  function profile(u) {
    const [lvl, into, need] = playerLevel(u.xp);
    return {
      id: u.id, username: displayName(u), is_guest: u.is_guest, level: lvl, xp: u.xp, xp_into_level: into, xp_for_next: need,
      coins: u.coins, skill: Math.round(u.skill * 10) / 10, best_streak: u.stats.highest_streak,
      achievements_unlocked: Object.keys(u.achievements).length, achievements_total: E.ACHIEVEMENTS.length,
      inventory: u.inventory || {}, theme: u.theme || 'classic', daily_streak: dailyStreak(u),
      tutorial_done: !!u.tutorial_done, has_pin: !!u.pin,
    };
  }

  function listPlayers() {
    return Object.values(DB.users).filter(u => !u.is_guest).sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''))
      .slice(0, 24).map(u => ({ id: u.id, name: u.username, level: playerLevel(u.xp)[0], coins: u.coins, has_pin: !!u.pin, last_seen: u.last_seen }));
  }

  function currentUser() {
    let u = DB.session != null ? DB.users[DB.session] : null;
    if (!u && DB.last_player != null) { u = DB.users[DB.last_player] || null; if (u) DB.session = u.id; }
    return u || null;
  }
  function signIn(u) { DB.session = u.id; DB.last_player = u.id; u.last_seen = nowIso(); save(); }
  const findByName = (name) => Object.values(DB.users).find(u => u.username.toLowerCase() === name.toLowerCase());
  const cleanName = (s) => String(s || '').split(/\s+/).filter(Boolean).join(' ');
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _\-]{1,19}$/;
  function pinProblem(pin) {
    if (pin && pin.length < 4) return 'A PIN or password needs at least 4 characters (or leave it empty).';
    if (pin.length > 64) return 'That PIN is too long.';
    return null;
  }
  async function makePin(pin) { if (!pin) return null; const salt = randomSalt(); return { salt, hash: await hashPin(pin, salt) }; }
  async function checkPin(u, pin) { return !u.pin || (await hashPin(pin || '', u.pin.salt)) === u.pin.hash; }

  // --------------------------------------------------------- history ------
  function recentSummaries(u, n = 30) {
    return userGames(u).filter(g => g.status !== 'abandoned').slice(-n);
  }
  function computeSkill(u) {
    return E.skillFromHistory(recentSummaries(u, E.WINDOW).filter(g => g.mode !== 'zen'));
  }
  function adaptiveReport(u) {
    const history = recentSummaries(u, E.WINDOW).filter(g => g.mode !== 'zen');
    return { performance: E.performanceReport(history), skill: Math.round(u.skill * 10) / 10, trend: E.trend(history),
      next: E.recommend(u.skill), reasons: E.explainAdjustment(history) };
  }

  // ----------------------------------------------------- packs & levels --
  function completedLevels(u) {
    const out = {};
    for (const g of userGames(u)) {
      if (!g.won || !g.pack) continue;
      const p = out[g.pack] = out[g.pack] || {};
      const cur = p[g.level_index];
      if (!cur) p[g.level_index] = { best_time: g.duration, best_moves: g.attempts, best_score: g.score };
      else { cur.best_time = Math.min(cur.best_time, g.duration); cur.best_moves = Math.min(cur.best_moves, g.attempts); cur.best_score = Math.max(cur.best_score, g.score); }
    }
    return out;
  }
  function packUnlocked(done, packId) {
    const i = E.PACKS.findIndex(p => p.id === packId);
    if (i <= 0) return true;
    const prev = E.PACKS[i - 1];
    return Object.keys(done[prev.id] || {}).length >= Math.min(E.PACK_UNLOCK_REQUIREMENT, prev.total_levels);
  }
  function listPacks(u) {
    const done = completedLevels(u);
    return E.PACKS.map((p, i) => {
      const available = packUnlocked(done, p.id);
      return Object.assign({}, p, { completed_count: Object.keys(done[p.id] || {}).length, available,
        unlock_hint: available ? null : `Clear ${Math.min(E.PACK_UNLOCK_REQUIREMENT, E.PACKS[i - 1].total_levels)} levels of ${E.PACKS[i - 1].title}` });
    });
  }
  function listLevels(u, packId) {
    const p = E.PACK_BY_ID[packId], done = completedLevels(u)[packId] || {}, out = [];
    for (let i = 1; i <= p.total_levels; i++) {
      const [rows, cols] = E.boardDims(E.packLevelSize(i)), rec = done[i];
      out.push({ index: i, rows, cols, completed: !!rec, locked: !(i === 1 || done[i - 1]),
        best_time: rec ? rec.best_time : null, best_moves: rec ? rec.best_moves : null, best_score: rec ? rec.best_score : null,
        rewards: { coins: 10 + i * 2 } });
    }
    return out;
  }

  // ---------------------------------------------------------------- daily --
  function dailyChallenge(date) {
    date = date || todayUtc();
    if (!DB.daily[date]) {
      const seed = parseInt(date.replace(/-/g, ''), 10);
      const level = E.generateLevel(E.specFor('daily', 5), seed);
      DB.daily[date] = { date, seed, level, difficulty: level.difficulty, stars: E.starsFor(level.difficulty) };
    }
    return DB.daily[date];
  }
  function dailyLeaderboard(date, limit = 10) {
    const best = {};
    for (const g of DB.games) if (g.mode === 'daily' && g.daily_date === date) best[g.user_id] = Math.max(best[g.user_id] ?? -1, g.score);
    return Object.entries(best).sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([uid, score], i) => ({ rank: i + 1, player: DB.users[uid] ? displayName(DB.users[uid]) : '?', score, user_id: +uid }));
  }
  function dailyInfo(u) {
    const d = dailyChallenge();
    const mine = userGames(u).filter(g => g.mode === 'daily' && g.daily_date === d.date);
    return { date: d.date, seed: d.seed, difficulty: d.difficulty, stars: d.stars, move_limit: E.MODES.daily.move_limit,
      your_best: mine.length ? Math.max(...mine.map(g => g.score)) : null, attempts: mine.length,
      rows: d.level.grid.length, cols: d.level.grid[0].length, leaderboard: dailyLeaderboard(d.date), scope: 'device' };
  }

  // ---------------------------------------------------------------- games --
  function startGame(u, m, pack, levelIndex) {
    if (!E.MODES[m]) return fail('Unknown mode');
    for (const [gid, g] of Object.entries(DB.active)) {
      if (g.user_id === u.id) { E.abandon(g.state); finalize(u, g); }
    }
    const skill = u.skill, rec = E.recommend(skill);
    let level, spec, par = null, hintsOverride = null, dailyDate = null, levelKey;
    if (m === 'classic' && pack) {
      if (!E.PACK_BY_ID[pack]) return fail('Unknown pack');
      const total = E.PACK_BY_ID[pack].total_levels;
      levelIndex = Math.max(1, Math.min(total, parseInt(levelIndex || 1, 10)));
      const done = completedLevels(u);
      if (!packUnlocked(done, pack)) return fail('This pack is locked.', 403);
      if (levelIndex > 1 && !(done[pack] || {})[levelIndex - 1]) return fail('Complete the previous level first.', 403);
      spec = E.specFor('classic', skill, pack, levelIndex);
      levelKey = `${pack}_${String(levelIndex).padStart(3, '0')}:${spec.target}:${LEVEL_VERSION}`;
      level = E.generateLevel(spec, E.seedFrom(pack, levelIndex, spec.target));
      par = E.parTime(Math.floor(E.tilesLeft(level.grid) / 2), skill);
    } else if (m === 'daily') {
      const d = dailyChallenge();
      level = d.level; spec = E.specFor('daily', 5); dailyDate = d.date; levelKey = `daily:${d.date}`;
    } else {
      spec = E.specFor(m, skill, null, null, rec);
      const seed = E.seedFrom(m, u.id, Date.now(), Math.random());
      level = E.generateLevel(spec, seed); levelKey = `${m}:${seed}`;
      if (m === 'classic') { hintsOverride = rec.hints; par = rec.time; }
    }
    const state = E.newState(m, level, { pack: pack || null, level_index: levelIndex || null, level_key: levelKey, par, spec, hints_override: hintsOverride });
    const g = { id: nextId(), user_id: u.id, mode: m, pack: pack || null, level_index: levelIndex || null, daily_date: dailyDate,
      difficulty: level.difficulty, difficulty_score: level.difficulty_score, skill_before: skill, state, finalized: false };
    DB.active[g.id] = g;
    u.last_seen = nowIso();
    return g;
  }

  function award(u, ids) {
    return ids.map(id => { const a = E.ACH_BY_ID[id]; u.achievements[id] = nowIso(); u.coins += a.reward; return E.achPublic(a); });
  }
  function moveAchievements(u, state) {
    const stats = Object.assign({}, u.stats); stats.total_matches += state.matches;
    return award(u, E.evaluateAchievements({ event: 'move', streak: state.streak, chain: state.chain, stats,
      unlocked: Object.keys(u.achievements), skill: u.skill }));
  }

  function finalize(u, g) {
    const state = g.state;
    if (g.finalized || state.status === 'active') return null;
    g.finalized = true;
    delete DB.active[g.id];
    const summ = E.summary(state);
    if (state.status === 'abandoned') return null;
    const rec = Object.assign({ id: g.id, user_id: u.id, pack: g.pack, level_index: g.level_index, daily_date: g.daily_date,
      skill_before: g.skill_before, ended_at: Date.now() }, summ);
    const st = u.stats;
    const firstClear = !!(summ.won && g.pack && !userGames(u).some(x => x.won && x.pack === g.pack && x.level_index === g.level_index));
    const earlierDaily = g.mode === 'daily' && userGames(u).some(x => x.mode === 'daily' && x.daily_date === g.daily_date);
    DB.games.push(rec);

    st.games_played++; st.games_won += summ.won ? 1 : 0; st.total_matches += summ.matches; st.total_moves += summ.matches;
    st.total_attempts += summ.attempts; st.total_mistakes += summ.mistakes; st.hints_used += summ.hints_used;
    st.undos_used += summ.undos_used; st.deadlocks += summ.deadlocks; st.total_time_played += summ.duration;
    st.total_score += summ.score; st.highest_streak = Math.max(st.highest_streak, summ.max_streak);
    if (summ.won && g.mode !== 'time_attack') st.levels_completed++;
    if (summ.won && summ.mistakes === 0 && summ.attempts > 0) st.perfect_games++;
    if (summ.won && g.mode === 'zen') st.zen_clears++;

    let coins = g.mode !== 'zen' ? Math.floor(summ.score / 40) : (summ.won ? 10 : 0);
    if (firstClear) coins += 10 + 2 * (g.level_index || 1);
    if (g.mode === 'daily' && !earlierDaily) coins += summ.won ? 100 : 40;
    if (state.double_coins) coins *= 2;
    u.coins += coins;
    const xp = Math.max(5, Math.floor(summ.score / 10));
    const levelBefore = playerLevel(u.xp)[0];
    u.xp += xp;
    if (g.mode !== 'zen') u.skill = computeSkill(u);
    rec.skill_after = u.skill; rec.coins_earned = coins;

    const done = completedLevels(u);
    const newAch = award(u, E.evaluateAchievements({ event: 'finish', game: summ, streak: summ.max_streak, chain: summ.max_chain,
      stats: Object.assign({}, st), skill: u.skill, unlocked: Object.keys(u.achievements), packs_won: Object.keys(done),
      packs_complete: E.PACKS.filter(p => Object.keys(done[p.id] || {}).length >= p.total_levels).map(p => p.id) }));
    return { summary: summ, coins_earned: coins, achievement_coins: newAch.reduce((s, a) => s + a.reward, 0), xp_earned: xp,
      level_up: playerLevel(u.xp)[0] > levelBefore, new_achievements: newAch, skill_before: g.skill_before,
      skill_after: u.skill, first_clear: firstClear, next: E.recommend(u.skill) };
  }

  function gamePayload(u, g, extra) {
    const state = g.state;
    E.checkTimeout(state);
    let result = null;
    if (state.status !== 'active' && !g.finalized) result = finalize(u, g);
    save();
    return ok(Object.assign({ game_id: g.id, game: E.publicView(state), result, profile: profile(u) }, extra || {}));
  }

  // ---------------------------------------------------------- analytics --
  function leaderboard(period, limit = 20) {
    const now = Date.now(), dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const since = period === 'daily' ? dayStart.getTime() : period === 'weekly' ? now - 7 * 86400000 : 0;
    const agg = {};
    for (const g of DB.games) {
      if (g.mode === 'zen' || g.ended_at < since) continue;
      const a = agg[g.user_id] = agg[g.user_id] || { total: 0, n: 0, best: 0 };
      a.total += g.score; a.n++; a.best = Math.max(a.best, g.score);
    }
    return Object.entries(agg).filter(([uid]) => DB.users[uid]).sort((a, b) => b[1].total - a[1].total).slice(0, limit)
      .map(([uid, a], i) => ({ rank: i + 1, player: displayName(DB.users[uid]), user_id: +uid, score: a.total, games: a.n,
        best: a.best, level: playerLevel(DB.users[uid].xp)[0] }));
  }

  function analytics(u) {
    const st = u.stats, games = recentSummaries(u, 40);
    const won = games.filter(g => g.won && g.mode !== 'time_attack');
    const byMode = {};
    for (const g of games) { const m = byMode[g.mode] = byMode[g.mode] || { games: 0, won: 0, best: 0 }; m.games++; m.won += g.won ? 1 : 0; m.best = Math.max(m.best, g.score); }
    const tiers = { EASY: 0, MEDIUM: 0, HARD: 0, EXPERT: 0 };
    for (const g of won) if (g.difficulty in tiers) tiers[g.difficulty]++;
    const times = won.map(g => g.duration), attempts = st.total_attempts || 0;
    return {
      profile: profile(u),
      table: {
        levels_completed: st.levels_completed, total_matches: st.total_matches, best_streak: st.highest_streak,
        avg_solve_time: times.length ? Math.round(10 * times.reduce((a, b) => a + b, 0) / times.length) / 10 : null,
        accuracy: attempts ? Math.round(100 * (attempts - st.total_mistakes) / attempts) : null,
        games_played: st.games_played, win_rate: st.games_played ? Math.round(100 * st.games_won / st.games_played) : null,
        time_played: Math.round(st.total_time_played), hints_used: st.hints_used, undos_used: st.undos_used,
        deadlocks: st.deadlocks, total_score: st.total_score,
      },
      series: {
        labels: games.map((_, i) => '#' + (i + 1)), score: games.map(g => g.score),
        solve_time: games.map(g => g.won ? g.duration : null),
        accuracy: games.map(g => g.attempts ? Math.round(100 * (g.attempts - g.mistakes) / g.attempts) : null),
        skill: games.map(g => g.skill_after), streak: games.map(g => g.max_streak), hints: games.map(g => g.hints_used),
        difficulty: games.map(g => g.difficulty_score),
      },
      by_mode: byMode, tiers, adaptive: adaptiveReport(u),
    };
  }

  function achievementsFor(u) {
    const cats = Object.fromEntries(E.CATEGORIES.map(c => [c, []]));
    for (const a of E.ACHIEVEMENTS) cats[a.category].push(Object.assign(E.achPublic(a), { unlocked: !!u.achievements[a.id], unlocked_at: u.achievements[a.id] || null }));
    return { categories: cats, unlocked: Object.keys(u.achievements).length, total: E.ACHIEVEMENTS.length };
  }

  // -------------------------------------------------------------- router --
  async function route(method, path, body) {
    load();
    const url = new URL(path, 'http://nummat.local');
    const p = url.pathname.replace(/\/+$/, '');
    const seg = p.split('/').filter(Boolean);           // ['api', ...]
    body = body || {};

    // ---- players ----
    if (p === '/api/me') {
      const u = currentUser();
      if (!u) return ok({ profile: null, needs_login: true, players: listPlayers(), desktop: true });
      const act = Object.values(DB.active).filter(g => g.user_id === u.id).pop();
      return ok({ profile: profile(u), active_game: act ? act.id : null, desktop: true });
    }
    if (p === '/api/players') return ok({ players: listPlayers() });
    if (p === '/api/auth/register') {
      const name = cleanName(body.username), pin = String(body.password || body.pin || '');
      if (!NAME_RE.test(name)) return fail('Names are 2-20 characters: letters, numbers, spaces, _ or -.');
      if (name.toLowerCase().startsWith('guest')) return fail('That name is reserved - please pick another.');
      const prob = pinProblem(pin); if (prob) return fail(prob);
      const existing = findByName(name);
      if (existing && !existing.is_guest) return fail('That name is taken - log in instead, or pick another name.');
      const me = currentUser();
      let u;
      if (me && me.is_guest) { me.username = name; me.pin = await makePin(pin); me.is_guest = false; u = me; }
      else u = createUser(name, await makePin(pin), false);
      signIn(u);
      return ok({ profile: profile(u) });
    }
    if (p === '/api/auth/login') {
      let u = null;
      if (body.user_id) { u = DB.users[body.user_id] || null; if (u && u.is_guest) u = null; }
      if (!u && body.username) { u = findByName(cleanName(body.username)); if (u && u.is_guest) u = null; }
      if (!u) return fail('No player with that name on this device.', 404);
      if (!(await checkPin(u, String(body.password || body.pin || '')))) return fail('Wrong PIN - try again.', 401, { needs_pin: true });
      signIn(u);
      return ok({ profile: profile(u) });
    }
    if (p === '/api/auth/guest') {
      let u = Object.values(DB.users).find(x => x.is_guest && x.username === GUEST);
      if (!u) u = createUser(GUEST, null, true);
      signIn(u);
      return ok({ profile: profile(u) });
    }
    if (p === '/api/auth/logout') { DB.session = null; DB.last_player = null; save(); return ok({ needs_login: true, players: listPlayers() }); }

    // ---- everything below needs a player ----
    if (p === '/api/modes') return ok({ modes: Object.values(E.MODES) });
    const u = currentUser();
    if (!u) return needLogin();

    if (p === '/api/auth/pin') {
      if (u.is_guest) return fail('Create a player first.');
      if (u.pin && !(await checkPin(u, String(body.current || '')))) return fail('Your current PIN is not right.', 401);
      const pin = String(body.pin || ''), prob = pinProblem(pin); if (prob) return fail(prob);
      u.pin = await makePin(pin); save();
      return ok({ profile: profile(u) });
    }
    if (p === '/api/tutorial/done') { u.tutorial_done = true; save(); return ok({ profile: profile(u) }); }
    if (p === '/api/settings') {
      if (['classic', 'winter', 'autumn', 'spring', 'summer'].includes(body.theme)) { u.theme = body.theme; save(); }
      return ok({ profile: profile(u) });
    }
    if (p === '/api/packs') return ok({ packs: listPacks(u) });
    if (seg[1] === 'packs' && seg[3] === 'levels') {
      if (!E.PACK_BY_ID[seg[2]]) return fail('Unknown pack.', 404);
      return ok({ pack: E.PACK_BY_ID[seg[2]], levels: listLevels(u, seg[2]) });
    }
    if (p === '/api/daily') { const d = dailyInfo(u); save(); return ok({ daily: d }); }

    if (p === '/api/games' && method === 'POST') {
      const g = startGame(u, body.mode || 'classic', body.pack, body.level);
      if (g.success === false) return g;
      return gamePayload(u, g, { adaptive: adaptiveReport(u).next });
    }
    if (seg[1] === 'games' && seg[2]) {
      const g = DB.active[seg[2]];
      if (!g || g.user_id !== u.id) return fail('Game not found.', 404);
      const s = g.state, action = seg[3] || '';
      if (!action) return gamePayload(u, g);
      if (action === 'move') {
        const pos = (v) => Array.isArray(v) && v.length === 2 ? [parseInt(v[0], 10), parseInt(v[1], 10)] : null;
        const a = pos(body.a), b = pos(body.b);
        if (!a || !b) return fail('Invalid move positions.');
        const ev = E.playMove(s, a, b);
        const newAch = ev.valid ? moveAchievements(u, s) : [];
        return gamePayload(u, g, { event: ev, new_achievements: newAch });
      }
      if (action === 'undo') return gamePayload(u, g, { event: E.undo(s) });
      if (action === 'hint') return gamePayload(u, g, { event: E.useHint(s, body.level || 1) });
      if (action === 'solve') {
        if (!E.MODES[s.mode].solver_allowed) return fail('The solver is disabled in this mode.', 403);
        const analysis = E.analyse(s, !!body.reveal);
        const m = E.measure(s.grid, s.frozen, null, 12, null, 4000);
        analysis.estimated_difficulty = m.difficulty[0] + m.difficulty.slice(1).toLowerCase();
        analysis.metrics = m;
        return gamePayload(u, g, { analysis });
      }
      if (action === 'item') {
        const item = body.item;
        if (!((u.inventory || {})[item] > 0)) return fail("You don't own that item - visit the store.");
        const ev = E.useItem(s, item);
        if (ev.success) u.inventory[item]--;
        return gamePayload(u, g, { event: ev });
      }
      if (action === 'end') { E.abandon(s); return gamePayload(u, g); }
      return fail('Unknown action.', 404);
    }

    if (p === '/api/solver') {
      let grid;
      try { grid = E.parseGridText(body.board || ''); } catch (e) { return fail(e.message); }
      const frozen = (body.frozen || []).map(x => [x[0], x[1]]);
      const res = E.solve(grid, frozen, 40000);
      const m = E.measure(grid, frozen, null, 16, res);
      return ok({ grid, frozen, result: res, metrics: m, estimated_difficulty: m.difficulty[0] + m.difficulty.slice(1).toLowerCase() });
    }
    if (p === '/api/stats') return ok(analytics(u));
    if (p === '/api/achievements') return ok(achievementsFor(u));
    if (p === '/api/skill') return ok(adaptiveReport(u));
    if (p === '/api/leaderboard') {
      let period = url.searchParams.get('period') || 'all';
      if (!['daily', 'weekly', 'all'].includes(period)) period = 'all';
      return ok({ period, rows: leaderboard(period), you: u.id, daily: dailyLeaderboard(todayUtc()), scope: 'device' });
    }
    if (p === '/api/shop') return ok({ items: SHOP_ITEMS, coins: u.coins, inventory: u.inventory || {} });
    if (p === '/api/shop/buy') {
      const item = SHOP_BY_ID[body.item];
      if (!item) return fail('Unknown item.', 400, { coins: u.coins });
      if (u.coins < item.price) return fail(`Not enough coins - ${item.price - u.coins} more needed.`, 400, { coins: u.coins });
      u.coins -= item.price; u.inventory[item.id] = (u.inventory[item.id] || 0) + 1; save();
      return ok({ message: `Purchased ${item.name}!`, coins: u.coins, inventory: u.inventory, profile: profile(u) });
    }
    return fail('Not found', 404);
  }

  let queue = Promise.resolve();
  /** Same contract as fetch('/api/...').then(r => r.json()). Calls run one at a time. */
  function request(path, body, method) {
    const m = method || (body ? 'POST' : 'GET');
    const run = () => route(m, path, body).catch(e => ({ success: false, message: 'Something went wrong: ' + (e && e.message || e) }));
    const p = queue.then(run, run);
    queue = p.then(() => undefined, () => undefined);
    return p;
  }

  const LocalAPI = { request, _reset() { DB = null; memoryStore = null; try { root.localStorage && root.localStorage.removeItem(STORE_KEY); } catch (e) { /* */ } } };
  if (typeof module !== 'undefined' && module.exports) module.exports = LocalAPI;
  else root.LocalAPI = LocalAPI;
})(typeof window !== 'undefined' ? window : globalThis);
