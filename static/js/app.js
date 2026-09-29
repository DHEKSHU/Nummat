/* ==========================================================================
   NUMMAT front-end
   Plain JS, no build step. Talks to the Flask REST API in api.py.
   Sections: helpers · theme · navigation · home · packs · game · board input ·
             hints/explain · solver · items · results · daily · lab · stats ·
             leaderboard · store · auth · boot
   ========================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------ helpers --
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const label = (v) => { if (v <= 0) return ''; const b = v % 100; return b === 11 ? '★' : String(b); };
  const POWER_ICON = { 1: '💣', 2: '➖' };
  const POWER_CLASS = { 1: 'pw-bomb', 2: 'pw-row' };
  const COMBO_AT = [3, 5, 8, 10, 15, 20, 25, 30, 40, 50];
  const THEME_ICON = { classic: 'default_icon.png', winter: 'winter_icon.png', autumn: 'autumn_icon.png', spring: 'spring_icon.png', summer: 'summer_icon.png' };
  const THEMES = ['classic', 'winter', 'autumn', 'spring', 'summer'];
  const ENCOURAGE = ['Brilliant! 💡', 'Smooth match! 🎯', 'On fire! 🔥', 'Perfect combo! 🌟', 'Amazing! ⭐', 'Keep going! 🚀', 'Excellent! 🎊', 'Spectacular! ✨', 'Unstoppable! 💪', 'Legendary! 👑'];
  const LAB_EXAMPLES = [
    '5 5 8 .\n2 8 8 3\n8 2 8 3\n2 8 . 8',
    '9 9 7 7 # .\n8 2 4 8 2 .\n# 4 5 2 2 9\n1 8 * 6 4 8\n9 9 2 . 5 .',
    '7 1 5 . 2 4\n5 7 1 5 4 4\n6 5 8 . 7 .\n6 3 4 5 5 2\n9 2 7 8 1 5\n4 7 4 2 . 5',
    '2 7 4 4 9\n8 3 7 1 6\n5 5 2 8 3',
  ];

  async function api(path, body, method) {
    const opts = { method: method || (body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    try {
      let data;
      if (window.LocalAPI) {
        data = await window.LocalAPI.request(path, body, opts.method);   // Android app: the engine runs on the phone
      } else {
        const r = await fetch(path, opts);
        data = await r.json();
      }
      if (data && data.needs_login && !path.startsWith('/api/auth') && !path.startsWith('/api/me')) showGate();
      return data;
    } catch (e) {
      return { success: false, message: 'Network error - is the server running?' };
    }
  }

  function toast(title, body = '', kind = 'gold') {
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'info' ? ' info' : '');
    t.innerHTML = `<b>${esc(title)}</b>${body ? `<span class="muted small">${esc(body)}</span>` : ''}`;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function say(msg, bad = false) {
    const el = $('#toast-line');
    el.textContent = msg;
    el.classList.toggle('bad', bad);
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }

  // --------------------------------------------------------------- state --
  const S = {
    profile: null,
    gameId: null,
    game: null,
    receivedAt: 0,
    selected: null,         // [r, c]
    busy: false,
    hintPair: null,
    solution: null,         // {path, i, base, frozen, timer, target}
    lastStart: null,        // {mode, pack, level}
    timer: null,
    view: 'play',
    rankPeriod: 'all',
    labIdx: 0,
    modes: {},
  };

  // --------------------------------------------------------------- theme --
  function applyTheme(theme) {
    const t = THEMES.includes(theme) ? theme : 'classic';
    document.documentElement.dataset.theme = t;
    if (window.FX) FX.setTheme(t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) setTimeout(() => meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()), 50);
    $$('.theme-opt').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
  }

  function applyMode(mode) {
    document.documentElement.dataset.mode = mode;
    try { localStorage.setItem('nummat-mode', mode); } catch (e) { /* storage unavailable */ }
  }

  function initTheme() {
    let mode = null;
    try { mode = localStorage.getItem('nummat-mode'); } catch (e) { /* ignore */ }
    if (!mode) mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyMode(mode);
    const box = $('.theme-options');
    box.innerHTML = THEMES.map(t => `<button class="theme-opt" data-theme="${t}"><img src="/static/${THEME_ICON[t]}" alt="">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')
      + `<button class="theme-opt" data-dark="1" style="grid-column: span 5; flex-direction: row; justify-content: center; padding: 8px">🌗 Toggle dark mode</button>`;
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('.theme-opt'); if (!b) return;
      if (b.dataset.dark) { applyMode(document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark'); return; }
      applyTheme(b.dataset.theme);
      const r = await api('/api/settings', { theme: b.dataset.theme });
      if (r.success) S.profile = r.profile;
    });
    $('#theme-btn').addEventListener('click', (e) => {
      const pop = $('#theme-pop'); pop.hidden = !pop.hidden;
      e.currentTarget.setAttribute('aria-expanded', String(!pop.hidden));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#theme-pop') && !e.target.closest('#theme-btn')) $('#theme-pop').hidden = true;
    });
    $('#mode-btn').addEventListener('click', () => applyMode(document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark'));
  }

  // ---------------------------------------------------------- navigation --
  const LOADERS = {};
  function go(view) {
    if (S.solution) stopSolution();
    S.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    $$('[data-go]').forEach(b => b.classList.toggle('active', b.dataset.go === view && (b.classList.contains('nav-btn') || b.closest('#bottomnav'))));
    document.body.classList.toggle('in-game', view === 'game');
    if (view !== 'game' && S.profile) applyTheme(S.profile.theme);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (LOADERS[view]) LOADERS[view]();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (b) { e.preventDefault(); go(b.dataset.go); }
  });

  // --------------------------------------------------------------- modal --
  function openModal(title, html, wide = false) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('.modal-sheet').classList.toggle('wide', wide);
    $('#modal').hidden = false;
    return $('#modal-body');
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  // swipe the bottom sheet down to close it (mobile)
  (() => {
    let y0 = null;
    const sheet = $('.modal-sheet');
    sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchend', (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 90) closeModal(); y0 = null; });
  })();

  // ------------------------------------------------------------- profile --
  function setProfile(p) {
    if (!p) return;
    S.profile = p;
    $('#coin-count').textContent = p.coins;
    $('#avatar-initial').textContent = (p.username || 'G')[0].toUpperCase();
    const sc = $('#store-coins'); if (sc) sc.textContent = p.coins;
  }

  function renderProfileCard(p, active, daily) {
    const pct = Math.round(100 * p.xp_into_level / Math.max(1, p.xp_for_next));
    $('#profile-card').innerHTML = `
      ${active ? `<div class="banner" style="background:var(--surface-2);margin:0"><span>▶ You have a game in progress</span>
        <div class="banner-actions"><button class="btn small" id="resume-btn">Resume</button><button class="btn small ghost" id="drop-btn">End it</button></div></div>` : ''}
      <div class="profile-top">
        <div class="big-avatar">${esc((p.username || 'G')[0].toUpperCase())}</div>
        <div>
          <div class="profile-name">${esc(p.username)}</div>
          <div class="profile-level">Level ${p.level} · ${p.xp_into_level}/${p.xp_for_next} XP</div>
        </div>
      </div>
      <div class="xp-bar"><div class="xp-fill" style="width:${pct}%"></div></div>
      <div class="profile-stats">
        <div><b>🔥 ${p.best_streak}</b><span>Best streak</span></div>
        <div><b>🪙 ${p.coins}</b><span>Coins</span></div>
        <div><b>🏅 ${p.achievements_unlocked}/${p.achievements_total}</b><span>Achievements</span></div>
      </div>
      ${p.is_guest
        ? `<div class="row gap"><button class="btn small" id="reg-btn">Save as a player</button><button class="btn small ghost" id="login-btn">Switch player</button>
           <span class="muted small">Playing as Guest - save as a player to keep your name on the leaderboard.</span></div>`
        : `<div class="row gap"><span class="muted small">📅 Daily streak: <b>${p.daily_streak}</b> day${p.daily_streak === 1 ? '' : 's'}</span>
           <button class="link-btn" id="howto-btn">How to play</button><button class="link-btn" id="switch-btn">Switch player</button></div>`}
      ${daily ? `<div class="daily-teaser">
          <div><div class="eyebrow">Today's daily challenge</div>
          <div><span class="stars small-stars">${'★'.repeat(daily.stars)}${'☆'.repeat(5 - daily.stars)}</span> <span class="muted small">Seed ${daily.seed} · ${daily.move_limit} moves</span></div>
          <div class="small">Your best: <b>${daily.your_best ?? '-'}</b></div></div>
          <button class="btn small" data-go="daily">Play daily</button></div>` : ''}`;
    $('#reg-btn')?.addEventListener('click', openSaveGuest);
    $('#login-btn')?.addEventListener('click', switchPlayer);
    $('#howto-btn')?.addEventListener('click', () => startTour(false));
    $('#switch-btn')?.addEventListener('click', switchPlayer);
    $('#resume-btn')?.addEventListener('click', async () => { const r = await api('/api/games/' + active); if (r.success) enterGame(r); });
    $('#drop-btn')?.addEventListener('click', async () => { await api(`/api/games/${active}/end`, {}); loadHome(); });
  }

  function perfRow(k, v) { return `<div>${k}</div><div>${v}</div>`; }

  function renderAdaptive(rep) {
    const p = rep.performance, n = rep.next;
    const trend = { up: '↑ rising', down: '↓ easing', steady: '→ steady' }[rep.trend];
    $('#adaptive-card').innerHTML = `
      <div class="adaptive-head">
        <div>
          <div class="eyebrow">Adaptive Difficulty Engine</div>
          <h3 style="margin:4px 0 0">Your next level is tuned to you</h3>
        </div>
        <div style="text-align:right">
          <div class="skill-gauge"><b>${rep.skill.toFixed(1)}</b><span>/ 10</span></div>
          <span class="trend ${rep.trend}">${trend}</span>
        </div>
      </div>
      <div class="adaptive-cols">
        <div>
          <div class="mini-title">Player performance</div>
          <div class="kv">
            ${perfRow('Accuracy', p.accuracy == null ? '-' : p.accuracy + '%')}
            ${perfRow('Avg. solve', p.avg_solve == null ? '-' : p.avg_solve + ' sec')}
            ${perfRow('Hint usage', p.hints)}
            ${perfRow('Undo usage', p.undos)}
            ${perfRow('Streak', p.best_streak)}
            ${perfRow('Deadlocks', p.deadlocks)}
          </div>
        </div>
        <div>
          <div class="mini-title">Next level</div>
          <div class="kv">
            ${perfRow('Grid', `${n.rows} × ${n.cols}`)}
            ${perfRow('Pairs', n.pairs)}
            ${perfRow('Complexity', `<span class="badge ${n.tier}">${n.complexity}</span>`)}
            ${perfRow('Par time', n.time + ' sec')}
            ${perfRow('Hints', n.hints)}
            ${perfRow('Special', n.frozen || n.blocked ? [n.frozen ? n.frozen + ' ❄' : '', n.blocked ? n.blocked + ' ■' : ''].join(' ') : '-')}
          </div>
        </div>
      </div>
      <ul class="adaptive-reasons">${rep.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
      <button class="btn big block" id="adaptive-play">Play next level →</button>`;
    $('#adaptive-play').addEventListener('click', () => startGame('classic'));
  }

  function renderModes(modes) {
    $('#modes-grid').innerHTML = modes.map(m => `
      <button class="mode-card" data-mode="${m.id}">
        <span class="mode-icon">${m.icon}</span>
        <span class="mode-name">${esc(m.name)}</span>
        <span class="mode-tag">${esc(m.tagline)}</span>
        <span class="mode-desc">${esc(m.description)}</span>
      </button>`).join('');
    $$('.mode-card').forEach(b => b.addEventListener('click', () => {
      const m = b.dataset.mode;
      if (m === 'daily') go('daily'); else startGame(m);
    }));
  }

  function renderPacks(packs) {
    $('#packs-grid').innerHTML = packs.map(p => {
      const pct = Math.round(100 * p.completed_count / p.total_levels);
      return `<button class="pack-card ${p.available ? '' : 'locked'}" data-pack="${p.id}" title="${esc(p.available ? p.blurb : p.unlock_hint)}"
          style="background-image:url('/static/img/${p.theme}_card.jpg')">
        <img class="pack-icon" src="/static/${THEME_ICON[p.theme]}" alt="">
        <div class="pack-info">
          <div class="pack-title">${esc(p.title)}</div>
          <div class="pack-blurb">${esc(p.available ? p.blurb : p.unlock_hint)}</div>
          <div class="small">${p.completed_count} / ${p.total_levels} ⭐</div>
          <div class="pack-progress"><i style="width:${pct}%"></i></div>
        </div>
      </button>`;
    }).join('');
    $$('.pack-card').forEach(b => b.addEventListener('click', () => {
      const p = packs.find(x => x.id === b.dataset.pack);
      if (!p.available) { toast('🔒 Locked', p.unlock_hint, 'info'); return; }
      openPack(p);
    }));
  }

  async function loadHome() {
    if (!S.profile && !$('#gate').hidden) return;
    const [me, skill, modes, packs, daily] = await Promise.all([api('/api/me'), api('/api/skill'), api('/api/modes'), api('/api/packs'), api('/api/daily')]);
    if (me.success && me.profile) { setProfile(me.profile); applyTheme(me.profile.theme); renderProfileCard(me.profile, me.active_game, daily.success ? daily.daily : null); }
    if (skill.success) renderAdaptive(skill);
    if (modes.success) { renderModes(modes.modes); modes.modes.forEach(m => { S.modes[m.id] = m; }); }
    if (packs.success) renderPacks(packs.packs);
  }
  LOADERS.play = loadHome;

  async function openPack(pack) {
    const r = await api(`/api/packs/${pack.id}/levels`);
    if (!r.success) return;
    const body = openModal(pack.title, `
      <p class="muted" style="margin-top:0">${esc(pack.blurb)} Complete levels in order. Boards grow from 4×4 to 8×8, completely filled and adapt to your skill.</p>
      <div class="level-grid">${r.levels.map(l => `
        <button class="level-btn ${l.completed ? 'done' : ''} ${l.locked ? 'locked' : ''}" data-i="${l.index}" ${l.locked ? 'aria-disabled="true"' : ''}>
          <b>${l.index}</b><small>${l.rows}×${l.cols}</small>
          ${l.best_time ? `<small style="display:block">⏱ ${Math.round(l.best_time)}s</small>` : ''}
        </button>`).join('')}</div>`, true);
    body.querySelectorAll('.level-btn').forEach(b => b.addEventListener('click', () => {
      if (b.classList.contains('locked')) { toast('🔒 Locked', 'Complete the previous level first.', 'info'); return; }
      closeModal();
      startGame('classic', pack.id, +b.dataset.i);
    }));
  }

  // ---------------------------------------------------------------- game --
  async function startGame(mode, pack = null, level = null) {
    say('Generating board…');
    const r = await api('/api/games', { mode, pack, level });
    if (!r.success) { toast('Could not start', r.message, 'info'); return; }
    S.lastStart = { mode, pack, level };
    enterGame(r);
  }

  function enterGame(r) {
    S.gameId = r.game_id;
    S.selected = null; S.hintPair = null;
    $('#hint-card').hidden = true;
    $('#explain-body').innerHTML = 'Make a match and NUMMAT explains it here: the rule, the connection, how many new options it opened and what it did to your streak.';
    if (!S.lastStart || S.lastStart.mode !== r.game.mode) S.lastStart = { mode: r.game.mode, pack: r.game.pack, level: r.game.level_index };
    setProfile(r.profile);
    go('game');
    $('#board-scroll').scrollTop = 0;
    const pack = r.game.pack && packTheme(r.game.pack);
    if (pack) applyTheme(pack);
    update(r);
    say(r.game.mode === 'zen' ? 'Breathe. Just solve. 🧘' : 'Good luck! 🎯');
    startTimer();
    if (r.result) setTimeout(() => showResult(r.result, r.game), 300);
  }

  function packTheme(packId) {
    return { default: 'classic', winter_event: 'winter', autumn: 'autumn', spring: 'spring', summer: 'summer', challenge: null }[packId] || null;
  }

  function update(r) {
    S.game = r.game;
    S.receivedAt = performance.now();
    if (r.profile) setProfile(r.profile);
    renderGame();
  }

  function renderGame() {
    const g = S.game, cfg = g.mode_config;
    const packName = g.pack ? ({ default: 'Classic', winter_event: 'Winter', autumn: 'Autumn', spring: 'Spring', summer: 'Summer', challenge: 'Challenge' }[g.pack] || g.pack) : null;
    $('#game-title').textContent = packName ? `${packName} · Level ${g.level_index}` : `${cfg.icon} ${cfg.name}`;
    const sub = [];
    sub.push(`${g.rows}×${g.cols}`);
    if (g.mode === 'daily') sub.push(`Seed ${g.seed}`);
    if (g.par_time) sub.push(`Par ${g.par_time}s`);
    if (g.mode === 'time_attack') sub.push(`Boards cleared: ${g.boards_cleared}`);
    if (g.assisted) sub.push('assisted');
    $('#game-sub').textContent = sub.join(' · ');
    const badge = $('#diff-badge'); badge.textContent = g.difficulty; badge.className = 'badge ' + g.difficulty;

    // HUD
    $('#hud-score').hidden = !cfg.show_score;
    $('#h-score').textContent = g.score ?? '-';
    $('#h-streak').textContent = g.streak;
    if (g.moves_remaining != null) { $('#h-moves-label').textContent = 'Moves left'; $('#h-moves').textContent = g.moves_remaining; }
    else if (g.mode === 'zen') { $('#h-moves-label').textContent = 'Tiles left'; $('#h-moves').textContent = g.grid.flat().filter(v => v > 0).length; }
    else { $('#h-moves-label').textContent = 'Moves'; $('#h-moves').textContent = g.moves; }
    $('#hud-moves').classList.toggle('warn', g.moves_remaining != null && g.moves_remaining <= 3);
    $('#hud-time').hidden = g.mode === 'zen';
    $('#h-time-label').textContent = g.time_left != null ? 'Time left' : 'Time';
    $('#hud').style.gridTemplateColumns = `repeat(${$$('.hud-item', $('#hud')).filter(x => !x.hidden).length}, 1fr)`;
    $('#streak-fill').style.width = Math.min(100, g.streak * 6) + '%';
    $('#chain-meter').hidden = !cfg.chain;
    $('#chain-count').textContent = g.chain;
    $('#shield-pill').hidden = !g.shield;
    const add = g.add || { available: false };
    const addLabel = add.cost === 0 ? `${add.free_left == null ? 'free' : add.free_left + ' free'}` : add.cost ? `🪙${add.cost}` : '';
    $('#add-cost').textContent = addLabel ? `(${addLabel})` : '';
    $('#stuck-add-cost').textContent = addLabel ? `(${addLabel})` : '';
    $('#a-add').hidden = add.cost == null && add.free_left === 0 && !add.used;   // modes without adds (Daily)
    $('#a-add').disabled = !add.available || g.status !== 'active';
    $('#a-add').classList.toggle('need', !!g.needs_add && g.status === 'active');
    const needAdd = !!g.needs_add && g.status === 'active';
    $('#stuck-banner').hidden = !(g.stuck || needAdd);
    $('#stuck-banner').classList.toggle('add', needAdd && !g.stuck);
    $('#stuck-add').hidden = !needAdd || !add.available;
    $('#stuck-undo').classList.toggle('ghost', needAdd && add.available);
    $('#stuck-text').textContent = needAdd && add.available ? '🔒 No pairs left - add more numbers!'
      : '🔒 Deadlock - no moves left.';

    // action availability
    const hintsLeft = g.hints_left;
    $('#hint-count').textContent = hintsLeft == null ? '∞' : `(${hintsLeft})`;
    $('#undo-count').textContent = g.undos_left == null ? '∞' : `(${g.undos_left})`;
    const noHints = cfg.hints === 0;
    $('#a-hint').disabled = noHints || hintsLeft === 0;
    $('#a-why').disabled = noHints;
    $('#a-best').disabled = noHints || hintsLeft === 0;
    $('#a-undo').disabled = !g.can_undo;
    $('#a-solve').disabled = !cfg.solver_allowed;
    $('#a-items').disabled = !cfg.items_allowed;
    const active = g.status === 'active';
    ['#a-hint', '#a-why', '#a-best', '#a-undo', '#a-solve', '#a-items'].forEach(id => { if (!active) $(id).disabled = true; });

    renderBoard($('#board'), g.grid, g.frozen, { unlocked: g.last_unlocked });
  }

  function renderBoard(boardEl, grid, frozen, opts = {}) {
    const rows = grid.length, cols = grid[0].length;
    const scroller = boardEl.parentElement && boardEl.parentElement.classList.contains('board-scroll') ? boardEl.parentElement : null;
    const fit = scroller ? Math.min(rows, Math.max(9, cols + 2)) : rows;
    [boardEl, scroller].forEach(el => { if (!el) return; el.style.setProperty('--cols', cols); el.style.setProperty('--rows', rows); el.style.setProperty('--fitrows', fit); });
    boardEl.classList.toggle('scrollable', rows > fit);
    let spawnI = 0;
    const fz = new Set((frozen || []).map(p => p[0] + ',' + p[1]));
    const un = new Set();
    (opts.unlocked || []).forEach(([a, b]) => { un.add(a[0] + ',' + a[1]); un.add(b[0] + ',' + b[1]); });
    const html = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = grid[r][c], k = r + ',' + c;
        const cls = ['tile'];
        const b = v > 0 ? v % 100 : v, pw = v > 0 ? Math.floor(v / 100) : 0;
        if (v === 0) cls.push('empty');
        else if (v < 0) cls.push('blocked');
        else {
          if (b === 11) cls.push('wild');
          if (pw) cls.push('power', POWER_CLASS[pw]);
          if (fz.has(k)) cls.push('frozen');
          if (un.has(k)) cls.push('unlocked');
        }
        if (opts.spawn && opts.spawn.has(k)) cls.push('spawn');
        if (opts.thaw && opts.thaw.has(k)) cls.push('thaw');
        const aria = v > 0 ? `${label(v)}${pw === 1 ? ' bomb' : pw === 2 ? ' row clear' : ''}${fz.has(k) ? ' frozen' : ''}` : (v < 0 ? 'wall' : 'empty');
        const extra = (v > 0 && b >= 1 && b <= 9 ? ` data-d="${b}"` : '') + (opts.spawn && opts.spawn.has(k) ? ` style="--i:${Math.min(spawnI++, 18)}"` : '');
        html.push(`<div class="${cls.join(' ')}" role="gridcell" data-r="${r}" data-c="${c}"${extra} ${v > 0 ? 'tabindex="0"' : ''} aria-label="row ${r + 1} column ${c + 1}: ${aria}">${label(v)}${pw ? `<i class="pw">${POWER_ICON[pw]}</i>` : ''}</div>`);
      }
    }
    boardEl.innerHTML = html.join('');
    if (scroller) updateScrollHint();
    if (boardEl.id === 'board' && !opts.plain) {
      if (S.selected) tileAt(S.selected)?.classList.add('selected');
      if (S.hintPair) S.hintPair.forEach(p => tileAt(p)?.classList.add('hint'));
    }
  }

  function updateScrollHint() {
    const sc = $('#board-scroll');
    $('#scroll-more').hidden = sc.scrollHeight - sc.clientHeight - sc.scrollTop < 8;
  }
  $('#board-scroll').addEventListener('scroll', updateScrollHint, { passive: true });
  window.addEventListener('resize', () => { if (S.view === 'game') updateScrollHint(); });

  const tileAt = (p, board = $('#board')) => board.querySelector(`.tile[data-r="${p[0]}"][data-c="${p[1]}"]`);
  const isPlayable = (el) => el && el.classList.contains('tile') && !el.classList.contains('empty') && !el.classList.contains('blocked');

  // timer
  function startTimer() {
    clearInterval(S.timer);
    S.timer = setInterval(tick, 250);
    tick();
  }
  let syncing = false;
  async function tick() {
    const g = S.game;
    if (!g || S.view !== 'game') return;
    const dt = (performance.now() - S.receivedAt) / 1000;
    if (g.time_left != null) {
      const left = g.status === 'active' ? Math.max(0, g.time_left - dt) : g.time_left;
      $('#h-time').textContent = fmtTime(left);
      $('#hud-time').classList.toggle('warn', left <= 15 && g.status === 'active');
      if (left <= 0 && g.status === 'active' && !syncing) {
        syncing = true;
        const r = await api('/api/games/' + S.gameId);
        syncing = false;
        if (r.success) { update(r); if (r.result) showResult(r.result, r.game); }
      }
    } else {
      $('#h-time').textContent = fmtTime(g.status === 'active' ? g.elapsed + dt : g.elapsed);
    }
  }

  // ------------------------------------------------------- board input --
  // Tap-tap or drag from one tile to another (touch-friendly "swipe to match").
  (() => {
    const board = $('#board');
    let drag = null;   // {from:[r,c], x, y, moved}
    board.addEventListener('pointerdown', (e) => {
      if (S.solution || S.busy || !S.game || S.game.status !== 'active') return;
      const t = e.target.closest('.tile');
      if (!isPlayable(t)) return;
      const p = [+t.dataset.r, +t.dataset.c];
      if (t.classList.contains('frozen')) { t.classList.add('shake'); setTimeout(() => t.classList.remove('shake'), 350); say('❄ Frozen - clear a neighbour to thaw it.', true); return; }
      FX.haptic(8);
      if (S.selected && S.selected[0] === p[0] && S.selected[1] === p[1]) { clearSelection(); return; }
      if (S.selected) { const a = S.selected; clearSelection(); attemptMove(a, p); return; }
      S.selected = p; t.classList.add('selected');
      drag = { from: p, x: e.clientX, y: e.clientY, moved: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 10) drag.moved = true;
      if (!drag.moved) return;
      $$('.tile.drag-target', board).forEach(x => x.classList.remove('drag-target'));
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#board .tile');
      if (isPlayable(over) && !(+over.dataset.r === drag.from[0] && +over.dataset.c === drag.from[1])) over.classList.add('drag-target');
    });
    window.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      $$('.tile.drag-target', board).forEach(x => x.classList.remove('drag-target'));
      if (!d.moved) return;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#board .tile');
      if (isPlayable(over)) {
        const p = [+over.dataset.r, +over.dataset.c];
        if (p[0] !== d.from[0] || p[1] !== d.from[1]) { clearSelection(); attemptMove(d.from, p); }
      }
    });
    window.addEventListener('pointercancel', () => { drag = null; });
    board.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target.closest('.tile'); if (!isPlayable(t)) return;
      e.preventDefault();
      const ev = new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 });
      t.dispatchEvent(ev); drag = null;
    });
  })();

  function clearSelection() {
    S.selected = null;
    $$('#board .tile.selected').forEach(t => t.classList.remove('selected'));
  }

  const COMBO_WORDS = { 3: 'NICE', 5: 'GREAT', 8: 'SUPER', 10: 'AWESOME', 15: 'INCREDIBLE', 20: 'UNSTOPPABLE', 25: 'LEGENDARY', 30: 'GODLIKE', 40: 'MYTHIC', 50: 'NUMMAT MASTER' };
  function showCombo(n) {
    const el = $('#combo-pop');
    el.innerHTML = `Combo ×${n}<small>${COMBO_WORDS[n] || 'WOW'}</small>`;
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    FX.haptic([10, 30, 10]);
  }

  function scrollToTiles(keys) {
    const sc = $('#board-scroll');
    const lastRow = Math.max(...keys.map(k => +k.split(',')[0]));
    const t = $(`#board .tile[data-r="${lastRow}"]`);
    if (t && sc.scrollHeight > sc.clientHeight) sc.scrollTop = t.offsetTop + t.offsetHeight - sc.clientHeight + 12;
  }

  function celebrateClear(big = true) {
    const w = $('.board-wrap');
    w.classList.remove('cleared-glow'); void w.offsetWidth; w.classList.add('cleared-glow');
    FX.confetti(big ? 110 : 45);
    FX.haptic([30, 50, 30, 50, 60]);
  }

  async function attemptMove(a, b) {
    if (S.busy) return;
    S.busy = true;
    const ta = tileAt(a), tb = tileAt(b);
    const r = await api(`/api/games/${S.gameId}/move`, { a, b });
    S.busy = false;
    if (!r.success) { say(r.message || 'Error', true); return; }
    const ev = r.event || {};
    if (ev.valid) {
      FX.haptic(15);
      FX.line(ta, tb);
      [ta, tb].forEach(t => t && t.classList.add('matched'));
      FX.burst(tb);
      const x = ev.explain || {};
      const powers = ev.powers || [];
      let delay = 320;
      if (powers.length) {
        // 💣 / ➖ go off one after another, then the tiles they caught burst
        powers.forEach((pw, i) => setTimeout(() => {
          if (pw.type === 'bomb') FX.shock(tileAt(pw.pos));
          else { const row = $$(`#board .tile[data-r="${pw.pos[0]}"]`); FX.beam(row[0], row[row.length - 1]); }
        }, 90 + i * 170));
        const pair = new Set([a.join(','), b.join(',')]);
        let n = 0;
        (ev.cleared || []).forEach(p => {
          if (pair.has(p.join(','))) return;
          const t = tileAt(p);
          if (t && !t.classList.contains('empty')) { t.style.setProperty('--i', n++); setTimeout(() => t.classList.add('blasted'), 120 + Math.floor(n / 4) * 60); }
        });
        delay = 460 + powers.length * 170 + n * 35;
        FX.haptic([20, 30, 45]);
      }
      const rowsGone = (ev.rows_removed || []).length;
      if (rowsGone) delay = Math.max(delay, 520);
      S.busy = delay > 330;          // board coordinates change after a blast/collapse - wait for the redraw
      const chainTxt = x.chain > 1 ? ` · Chain ×${x.chain}` : '';
      let msg;
      if (powers.length) {
        const boom = powers.some(p => p.type === 'bomb') ? 'Boom!' : 'Row blast!';
        say(msg = `${powers.map(p => p.icon).join('')} ${boom} +${ev.points}${x.extra_cleared ? ` · ${x.extra_cleared} extra tiles` : ''}`);
      } else say(msg = `${ENCOURAGE[Math.floor(Math.random() * ENCOURAGE.length)]} +${ev.points}${chainTxt}`);
      const st = r.game.streak, before = (x.streak || [0])[0];
      if (COMBO_AT.includes(st) && st > before) setTimeout(() => showCombo(st), 150);
      S.hintPair = null; $('#hint-card').hidden = true;
      renderExplain(x);
      const spawnList = [...(ev.injected || []), ...(ev.added || [])].map(p => p.join(','));
      const spawn = new Set(spawnList);
      const thaw = new Set((ev.thawed || []).map(p => p.join(',')));
      setTimeout(() => {
        S.game = r.game; S.receivedAt = performance.now(); setProfile(r.profile);
        renderGame();
        if (spawn.size || thaw.size) renderBoard($('#board'), r.game.grid, r.game.frozen, { unlocked: r.game.last_unlocked, spawn, thaw });
        if (rowsGone) {
          const bd = $('#board'); bd.classList.remove('settle'); void bd.offsetWidth; bd.classList.add('settle');
          say(powers.length ? `${msg} · 🧹 ${rowsGone > 1 ? rowsGone + ' rows' : 'row'} gone` : `🧹 ${rowsGone > 1 ? rowsGone + ' rows' : 'Row'} cleared! +${25 * rowsGone}`);
        }
        if (ev.added && ev.added.length) scrollToTiles(spawnList);
        S.busy = false;
      }, delay);
      if (ev.last_tile) setTimeout(() => say('✨ Last tile cleared for you! +30'), delay + 200);
      if (ev.deadlock === 'add_needed') setTimeout(() => say('🔒 No moves left - tap ➕ Add to get more numbers.', true), delay + 150);
      if (ev.deadlock === 'auto_added') setTimeout(() => say('➕ Out of pairs - the numbers were added again below.'), delay + 150);
      if (ev.deadlock === 'injected') setTimeout(() => say('🔒 Deadlock! A fresh pair was added.', true), delay + 150);
      if (ev.deadlock === 'stuck') setTimeout(() => say('🔒 Deadlock - undo or end the run.', true), delay + 150);
      if (ev.new_board) setTimeout(() => { celebrateClear(false); say('🧹 Board cleared! +50 · new board'); }, delay);
      if (ev.won) setTimeout(() => celebrateClear(true), delay - 100);
    } else if (ev.valid === false) {
      FX.haptic([30, 40, 30]);
      [ta, tb].forEach(t => { if (t) { t.classList.add('shake'); setTimeout(() => t.classList.remove('shake'), 350); } });
      say(ev.shielded ? '🔥 Shield saved your streak! ' + ev.message : ev.message, true);
      update(r);
    } else {
      say(ev.message || r.message || 'Not allowed', true);
      update(r);
    }
    (r.new_achievements || []).forEach(a => toast(`${a.icon} ${a.name}`, `Achievement unlocked · +${a.reward} coins`));
    if (r.result) setTimeout(() => showResult(r.result, r.game), ev.won ? 1500 : 800);
  }

  // ➕ copy the remaining numbers onto the end of the board
  async function addNumbers() {
    if (S.busy || !S.game || S.game.status !== 'active') return;
    S.busy = true;
    const r = await api(`/api/games/${S.gameId}/add`, {});
    S.busy = false;
    if (!r.success) { say(r.message || 'Error', true); return; }
    const ev = r.event || {};
    if (!ev.success) {
      say(ev.message, true);
      if (ev.needs_coins) toast('🪙 Not enough coins', 'Win levels, do the Daily Challenge or unlock achievements to earn coins.', 'info');
      return;
    }
    clearSelection(); S.hintPair = null; $('#hint-card').hidden = true;
    S.game = r.game; S.receivedAt = performance.now(); if (r.profile) setProfile(r.profile);
    renderGame();
    const keys = (ev.added || []).map(p => p.join(','));
    renderBoard($('#board'), r.game.grid, r.game.frozen, { unlocked: r.game.last_unlocked, spawn: new Set(keys) });
    if (keys.length) setTimeout(() => scrollToTiles(keys), 60);
    FX.haptic(12);
    say(ev.coins_spent ? `➕ ${keys.length} numbers added · -${ev.coins_spent} 🪙` : `➕ ${keys.length} numbers added`);
    if (ev.deadlock === 'add_needed') setTimeout(() => say('Still no pairs - add again!', true), 900);
    if (r.result) setTimeout(() => showResult(r.result, r.game), 800);
  }
  $('#a-add').addEventListener('click', addNumbers);
  $('#stuck-add').addEventListener('click', addNumbers);

  // --------------------------------------------------- hints & explain --
  async function askHint(level) {
    const r = await api(`/api/games/${S.gameId}/hint`, { level });
    if (!r.success) return;
    const ev = r.event;
    update(r);
    if (!ev.success) {
      say(ev.message, true);
      if (level === 3 && (S.profile.inventory?.smart_hint || 0) > 0) toast('Tip', 'You own a Smart Hint - use it from Items.', 'info');
      return;
    }
    clearSelection();
    S.hintPair = ev.pair;
    renderBoard($('#board'), S.game.grid, S.game.frozen, { unlocked: S.game.last_unlocked });
    showHintCard(ev);
  }

  function showHintCard(ev) {
    const titles = { 1: '💡 Hint · level 1', 2: '💡 Hint · level 2 - why', 3: '🎯 Hint · level 3 - optimal move' };
    $('#hint-title').textContent = titles[ev.level];
    $('#hint-body').innerHTML = `<ul>${ev.text.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
      ${ev.level === 1 ? '<p class="muted small">Tap <b>Why?</b> for a free explanation of this pair.</p>' : ''}
      ${ev.cost ? '' : '<p class="muted small">This explanation was free.</p>'}`;
    $('#hint-card').hidden = false;
    if (window.innerWidth < 1100) $('#hint-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function yn(b) { return b ? '<span class="yes">YES</span>' : '<span class="no">NO</span>'; }

  function renderExplain(x) {
    if (!x) return;
    const [s0, s1] = x.streak;
    const d = x.difficulty_impact;
    const rule = x.sum_to_10 ? `${x.values[0]} + ${x.values[1]} = 10` : x.equal ? `${x.values[0]} = ${x.values[1]}` : `${x.values[0]} ↔ ${x.values[1]}`;
    $('#explain-body').innerHTML = `
      <div class="explain-rule">${esc(rule)} <span class="ok">✓</span></div>
      <p class="muted small" style="margin-top:-6px">${esc(x.rule)}</p>
      <div class="mini-title">Connection</div>
      <div class="explain-list">
        <span>Same row</span>${yn(x.same_row && !x.wrap)}
        <span>Same column</span>${yn(x.same_column)}
        <span>Diagonal</span>${yn(x.diagonal)}
        <span>Row wrap</span>${yn(x.wrap)}
        <span>Distance</span><b>${x.distance}</b>
      </div>
      <div class="mini-title">Difficulty impact</div>
      <div class="explain-list">
        <span>Options on board</span><b>${x.options_before} → ${x.options_after} <span class="delta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">(${d > 0 ? '+' : ''}${d})</span></b>
        <span>New pairs opened</span><b>${x.unlocked.length}</b>
        <span>Streak</span><b>${s0} → ${s1} ${s1 >= 5 ? '🔥' : ''}</b>
        ${x.chain > 1 ? `<span>Chain</span><b>×${x.chain} 🔗</b>` : ''}
        <span>Points</span><b>+${x.points ?? 0}</b>
      </div>
      ${x.unlocked.length ? '<p class="muted small">Dots on tiles mark the pairs this move just opened.</p>' : ''}`;
  }

  $('#a-hint').addEventListener('click', () => askHint(1));
  $('#a-why').addEventListener('click', () => askHint(2));
  $('#a-best').addEventListener('click', () => askHint(3));
  $('#a-undo').addEventListener('click', doUndo);
  $('#stuck-undo').addEventListener('click', doUndo);
  $('#stuck-end').addEventListener('click', endGame);

  async function doUndo() {
    const r = await api(`/api/games/${S.gameId}/undo`, {});
    if (!r.success) return;
    clearSelection(); S.hintPair = null;
    update(r);
    say(r.event.success ? 'Undone ↩' : r.event.message, !r.event.success);
  }

  // -------------------------------------------------------------- solver --
  function textBoard(grid) {
    return grid.map(row => row.map(v => v < 0 ? '■' : v ? label(v) : '·').join('  ')).join('\n');
  }

  function metricsHtml(m) {
    const rows = [['Tiles', m.tiles], ['Valid pairs now', m.valid_pairs], ['Minimum moves', m.min_moves],
      ['Branching factor', m.branching_factor], ['Deadlock probability', Math.round(m.deadlock_probability * 100) + '%'],
      ['Avg. random depth', `${m.avg_solution_depth} / ${m.min_moves}`], ['Solver nodes', m.solver_nodes], ['Difficulty score', m.difficulty_score]];
    return `<div class="metrics">${rows.map(([k, v]) => `<div><span class="muted">${k}</span><b>${v}</b></div>`).join('')}</div>`;
  }

  function verdictHtml(res) {
    if (res.solvable === true) return `<div class="verdict ok">Solution exists ✓</div>`;
    if (res.solvable === false) return `<div class="verdict bad">No full clear ✗</div>`;
    return `<div class="verdict unk">Undecided (search budget reached)</div>`;
  }

  $('#a-solve').addEventListener('click', async () => {
    const r = await api(`/api/games/${S.gameId}/solve`, { reveal: false });
    if (!r.success) { say(r.message, true); return; }
    const a = r.analysis;
    const body = openModal('🧠 Solve level', `
      <div class="mini-title">Current board</div>
      <pre class="steps-list" style="max-height:none">${esc(textBoard(S.game.grid))}</pre>
      <div style="text-align:center;font-weight:700;color:var(--text-muted)">↓ SOLVER</div>
      ${verdictHtml(a)}
      <div class="kv">
        <div>Minimum moves</div><div>${a.solvable ? a.moves_to_clear : '-'}</div>
        ${a.solvable ? '' : `<div>Best line clears</div><div>${a.max_pairs_cleared} of ${a.moves_to_clear} pairs</div>`}
        <div>Estimated difficulty</div><div><span class="badge ${a.estimated_difficulty.toUpperCase()}">${a.estimated_difficulty}</span></div>
        <div>Nodes searched</div><div>${a.nodes_searched}</div>
      </div>
      <p class="muted small">${esc(a.reason)}${a.solvable === false && S.game.can_undo ? ' Try undoing a move or two - an earlier position may still be solvable.' : ''}</p>
      ${metricsHtml(a.metrics)}
      <div class="modal-actions">
        ${a.solvable ? '<button class="btn" id="show-sol">Show solution</button>' : ''}
        <button class="btn ghost" id="close-sol">Keep playing</button>
      </div>
      ${a.solvable ? '<p class="muted small" style="text-align:center">Showing the solution marks this game as <b>assisted</b> (no perfection achievements).</p>' : ''}`);
    body.querySelector('#close-sol').addEventListener('click', closeModal);
    body.querySelector('#show-sol')?.addEventListener('click', async () => {
      const r2 = await api(`/api/games/${S.gameId}/solve`, { reveal: true });
      closeModal();
      if (r2.success && r2.analysis.path.length) { update(r2); startSolution(r2.analysis.path, S.game.grid, S.game.frozen, $('#board'), $('#solution-bar'), $('#solution-step')); }
    });
  });

  // Solution playback (used by the game board and the lab board)
  function applyLocal(grid, frozen, [a, b]) {
    const g = grid.map(r => r.slice());
    g[a[0]][a[1]] = 0; g[b[0]][b[1]] = 0;
    const f = frozen.filter(([r, c]) => ![a, b].some(([x, y]) => Math.abs(x - r) + Math.abs(y - c) === 1));
    return [g, f];
  }

  function startSolution(path, grid, frozen, boardEl, barEl, stepEl, listEl) {
    stopSolution();
    if (boardEl.id === 'board') { S.hintPair = null; S.selected = null; $('#hint-card').hidden = true; }
    S.solution = { path, i: 0, base: grid.map(r => r.slice()), frozen: frozen.slice(), boardEl, barEl, stepEl, listEl, timer: null };
    barEl.hidden = false;
    drawSolution();
  }

  function drawSolution() {
    const s = S.solution; if (!s) return;
    let g = s.base, f = s.frozen;
    for (let k = 0; k < s.i; k++) [g, f] = applyLocal(g, f, s.path[k]);
    renderBoard(s.boardEl, g, f, { plain: true });
    if (s.i < s.path.length) {
      const [a, b] = s.path[s.i];
      [a, b].forEach(p => { const t = tileAt(p, s.boardEl); if (t) { t.classList.add('sol'); t.insertAdjacentHTML('beforeend', `<span class="step">${s.i + 1}</span>`); } });
      s.stepEl.textContent = `Move ${s.i + 1} / ${s.path.length}`;
    } else {
      s.stepEl.textContent = `Cleared in ${s.path.length} moves ✓`;
    }
    if (s.listEl) $$('div', s.listEl).forEach((d, k) => d.classList.toggle('on', k === s.i));
  }

  function stopSolution() {
    const s = S.solution; if (!s) return;
    clearInterval(s.timer);
    s.barEl.hidden = true;
    S.solution = null;
    if (s.boardEl.id === 'board' && S.game) renderGame();
  }

  function solStep(d) {
    const s = S.solution; if (!s) return;
    s.i = Math.max(0, Math.min(s.path.length, s.i + d));
    drawSolution();
  }
  function solPlay(btn) {
    const s = S.solution; if (!s) return;
    if (s.timer) { clearInterval(s.timer); s.timer = null; btn.textContent = '▶ Play'; return; }
    if (s.i >= s.path.length) s.i = 0;
    btn.textContent = '⏸ Pause';
    s.timer = setInterval(() => { if (s.i >= s.path.length) { clearInterval(s.timer); s.timer = null; btn.textContent = '▶ Play'; return; } solStep(1); }, 850);
  }
  $('#sol-prev').addEventListener('click', () => solStep(-1));
  $('#sol-next').addEventListener('click', () => solStep(1));
  $('#sol-play').addEventListener('click', (e) => solPlay(e.currentTarget));
  $('#sol-close').addEventListener('click', stopSolution);

  // --------------------------------------------------------------- items --
  $('#a-items').addEventListener('click', async () => {
    const shop = await api('/api/shop');
    if (!shop.success) return;
    const inv = shop.inventory || {};
    const body = openModal('🎒 Items', `
      <div class="items-list">${shop.items.map(it => `
        <div class="item-row">
          <span class="ir-icon">${it.icon}</span>
          <div class="ir-text"><b>${esc(it.name)} ×${inv[it.id] || 0}</b>${esc(it.desc)}</div>
          <button class="btn small" data-use="${it.id}" ${(inv[it.id] || 0) > 0 ? '' : 'disabled'}>Use</button>
        </div>`).join('')}</div>
      <div class="modal-actions"><button class="btn ghost" data-go="store" id="to-store">Get more in the store</button></div>`);
    body.querySelector('#to-store').addEventListener('click', closeModal);
    body.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', async () => {
      const r = await api(`/api/games/${S.gameId}/item`, { item: b.dataset.use });
      closeModal();
      if (!r.success) { say(r.message, true); return; }
      update(r);
      if (!r.event.success) { say(r.event.message, true); return; }
      say(r.event.message);
      if (b.dataset.use === 'smart_hint' && r.event.pair) { S.hintPair = r.event.pair; renderBoard($('#board'), S.game.grid, S.game.frozen); showHintCard(r.event); }
    }));
  });

  $('#a-restart').addEventListener('click', () => {
    if (!S.lastStart) return;
    if (S.game.status === 'active' && !confirm('Restart? The current board is abandoned.')) return;
    startGame(S.lastStart.mode, S.lastStart.pack, S.lastStart.level);
  });
  $('#a-exit').addEventListener('click', async () => {
    if (S.game && S.game.status === 'active') {
      if (!confirm('Leave this game? It will be ended.')) return;
      await endGame();
      return;
    }
    go('play');
  });

  async function endGame() {
    const r = await api(`/api/games/${S.gameId}/end`, {});
    if (r.success) { update(r); if (r.result) { showResult(r.result, r.game); return; } }
    go('play');
  }

  // ------------------------------------------------------------- results --
  function showResult(res, g) {
    clearInterval(S.timer);
    const s = res.summary;
    const reasons = { cleared: 'Level complete!', time_up: "Time's up!", out_of_moves: 'Out of moves', deadlock: 'Deadlock', ended: 'Run ended', abandoned: 'Game ended' };
    const title = g.mode === 'time_attack' ? "Time's up!" : (reasons[g.end_reason] || 'Game over');
    const acc = s.attempts ? Math.round(100 * (s.attempts - s.mistakes) / s.attempts) : 100;
    const dSkill = (res.skill_after - (res.skill_before ?? res.skill_after)).toFixed(1);
    const arrow = dSkill > 0 ? '↑' : dSkill < 0 ? '↓' : '→';
    const n = res.next;
    const canNext = g.pack && s.won;
    const body = openModal(s.won ? '🎉 ' + title : title, `
      <div class="result-hero">
        ${g.mode_config.show_score ? `<div class="big">${s.score}</div><div class="muted">points</div>` : '<div class="big">🧘</div><div class="muted">Board cleared</div>'}
      </div>
      <div class="result-grid">
        <div><b>${fmtTime(s.duration)}</b><span>Time</span></div>
        <div><b>${acc}%</b><span>Accuracy</span></div>
        <div><b>${s.max_streak}</b><span>Best streak</span></div>
        <div><b>${s.matches}</b><span>Matches</span></div>
        <div><b>+${res.coins_earned + res.achievement_coins} 🪙</b><span>Coins</span></div>
        <div><b>+${res.xp_earned}</b><span>XP${res.level_up ? ' · LEVEL UP!' : ''}</span></div>
      </div>
      ${g.mode !== 'zen' ? `<div class="skill-change">Skill ${Number(res.skill_before ?? res.skill_after).toFixed(1)} → ${Number(res.skill_after).toFixed(1)} <span class="${arrow === '↑' ? 'yes' : arrow === '↓' ? 'delta neg' : 'no'}">${arrow}</span></div>` : ''}
      ${res.first_clear ? '<p style="text-align:center" class="yes">First clear bonus!</p>' : ''}
      ${res.new_achievements.map(a => `<div class="ach-mini"><span style="font-size:1.4rem">${a.icon}</span><div><b>${esc(a.name)}</b><div class="small muted">${esc(a.desc)} · +${a.reward} 🪙</div></div></div>`).join('')}
      <p class="muted small" style="text-align:center">Next adaptive level: ${n.rows}×${n.cols} · ${n.pairs} pairs · <span class="badge ${n.tier}">${n.complexity}</span></p>
      <div class="modal-actions">
        ${canNext ? '<button class="btn" id="r-next">Next level →</button>' : ''}
        <button class="btn ${canNext ? 'ghost' : ''}" id="r-again">${g.mode === 'daily' ? 'Try again' : 'Play again'}</button>
        <button class="btn ghost" id="r-stats">Stats</button>
        <button class="btn ghost" id="r-menu">Menu</button>
      </div>`);
    body.querySelector('#r-next')?.addEventListener('click', () => { closeModal(); startGame('classic', g.pack, g.level_index + 1); });
    body.querySelector('#r-again').addEventListener('click', () => { closeModal(); startGame(g.mode, g.pack, g.level_index); });
    body.querySelector('#r-stats').addEventListener('click', () => { closeModal(); go('stats'); });
    body.querySelector('#r-menu').addEventListener('click', () => { closeModal(); go('play'); });
  }

  // --------------------------------------------------------------- daily --
  LOADERS.daily = async () => {
    const r = await api('/api/daily');
    if (!r.success) return;
    const d = r.daily;
    const date = new Date(d.date + 'T00:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    $('#daily-card').innerHTML = `
      <div class="eyebrow">Daily NUMMAT</div>
      <div class="daily-date">${esc(date)}</div>
      <div class="muted">Seed: <b>${d.seed}</b> · ${d.rows}×${d.cols} board</div>
      <div class="stars" aria-label="${d.stars} of 5 stars">${'★'.repeat(d.stars)}${'☆'.repeat(5 - d.stars)}</div>
      <div class="daily-rules"><span>${d.move_limit} moves</span><span>No hints</span><span>No items</span><span>Fixed seed</span><span>${d.scope === 'device' ? 'Daily scoreboard' : 'Global score'}</span></div>
      <p class="muted small">Everyone gets the same board today - it's generated from the date seed. Every attempt, valid or not, uses one of your ${d.move_limit} moves.</p>
      <div class="daily-best">Best score · You: <b>${d.your_best ?? '-'}</b> ${d.attempts ? `<span class="muted small">(${d.attempts} run${d.attempts > 1 ? 's' : ''})</span>` : ''}</div>
      <button class="btn big" id="daily-play">▶ PLAY</button>`;
    $('#daily-play').addEventListener('click', () => startGame('daily'));
    $('#daily-board').innerHTML = rankTable(d.leaderboard, 'score', S.profile?.id);
  };

  function rankTable(rows, key, me) {
    if (!rows.length) return '<p class="muted">No scores yet - be the first!</p>';
    return `<table class="data"><thead><tr><th>#</th><th>Player</th>${rows[0].games !== undefined ? '<th class="num">Games</th>' : ''}<th class="num">Score</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.user_id === me ? 'me' : ''}"><td>${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</td><td>${esc(r.player)}${r.level ? ` <span class="muted small">Lv ${r.level}</span>` : ''}</td>${r.games !== undefined ? `<td class="num">${r.games}</td>` : ''}<td class="num">${Number(r[key]).toLocaleString()}</td></tr>`).join('')}
    </tbody></table>`;
  }

  // ----------------------------------------------------------------- lab --
  LOADERS.lab = () => { $('#lab-current').hidden = !(S.game && S.game.status === 'active'); };
  $('#lab-example').addEventListener('click', () => { S.labIdx = (S.labIdx + 1) % LAB_EXAMPLES.length; $('#lab-input').value = LAB_EXAMPLES[S.labIdx]; });
  $('#lab-current').addEventListener('click', () => {
    if (!S.game) return;
    $('#lab-input').value = S.game.grid.map(r => r.map(v => v < 0 ? '#' : !v ? '.' : v % 100 === 11 ? '*' : v % 100).join(' ')).join('\n');
    S.labFrozen = S.game.frozen;
  });
  $('#lab-input').addEventListener('input', () => { S.labFrozen = []; });
  $('#lab-run').addEventListener('click', async () => {
    const out = $('#lab-result');
    out.innerHTML = '<h3>Result</h3><p class="muted">Searching…</p>';
    const r = await api('/api/solver', { board: $('#lab-input').value, frozen: S.labFrozen || [] });
    if (!r.success) { out.innerHTML = `<h3>Result</h3><p class="verdict bad">${esc(r.message)}</p>`; return; }
    const res = r.result;
    const path = res.solvable ? res.path : res.best_path;
    out.innerHTML = `
      <h3>Result</h3>
      ${verdictHtml(res)}
      <div class="kv">
        <div>Minimum moves</div><div>${res.solvable ? res.moves_to_clear : '-'}</div>
        <div>Estimated difficulty</div><div><span class="badge ${r.metrics.difficulty}">${r.estimated_difficulty}</span></div>
        ${!res.solvable ? `<div>Best partial clear</div><div>${res.max_pairs_cleared} pair${res.max_pairs_cleared === 1 ? '' : 's'}</div>` : ''}
      </div>
      <p class="muted small">${esc(res.reason)}</p>
      <div class="board-wrap lab-board" style="box-shadow:none">
        <div class="board" id="lab-board" style="--tile-size: clamp(26px, calc((min(100vw, 560px) - 90px) / ${r.grid[0].length}), 44px)"></div>
        <div class="solution-bar" id="lab-bar" hidden>
          <span id="lab-step"></span>
          <button class="btn small ghost" id="lab-prev">◀</button>
          <button class="btn small" id="lab-play">▶ Play</button>
          <button class="btn small ghost" id="lab-next">▶▶</button>
        </div>
      </div>
      ${path.length ? `<button class="btn ${res.solvable ? '' : 'ghost'}" id="lab-show">${res.solvable ? 'Show solution' : 'Show best partial line'}</button>
        <div class="steps-list" id="lab-steps" style="margin-top:10px">${path.map(([a, b], k) => `<div>Move ${k + 1}: (${a[0] + 1},${a[1] + 1}) ${label(r.grid[a[0]][a[1]])} ↔ ${label(r.grid[b[0]][b[1]])} (${b[0] + 1},${b[1] + 1})</div>`).join('')}</div>` : ''}
      <details style="margin-top:12px"><summary class="muted small">Board metrics</summary>${metricsHtml(r.metrics)}</details>`;
    renderBoard($('#lab-board'), r.grid, r.frozen);
    $('#lab-show')?.addEventListener('click', () => startSolution(path, r.grid, r.frozen, $('#lab-board'), $('#lab-bar'), $('#lab-step'), $('#lab-steps')));
    $('#lab-prev').addEventListener('click', () => solStep(-1));
    $('#lab-next').addEventListener('click', () => solStep(1));
    $('#lab-play').addEventListener('click', (e) => solPlay(e.currentTarget));
  });

  // --------------------------------------------------------------- stats --
  LOADERS.stats = async () => {
    const [r, a] = await Promise.all([api('/api/stats'), api('/api/achievements')]);
    if (!r.success) return;
    const t = r.table, p = r.profile;
    const row = (k, v) => `<div>${k}</div><div>${v ?? '-'}</div>`;
    $('#profile-table').innerHTML = `
      <div class="profile-box">
        <div class="pb-head">NUMMAT PROFILE · ${esc(p.username.toUpperCase())}</div>
        <div class="kv">
          ${row('Levels Completed', t.levels_completed)}
          ${row('Total Matches', t.total_matches)}
          ${row('Best Streak', t.best_streak)}
          ${row('Avg. Solve Time', t.avg_solve_time != null ? t.avg_solve_time + ' sec' : null)}
          ${row('Accuracy', t.accuracy != null ? t.accuracy + '%' : null)}
          ${row('Games Played', t.games_played)}
          ${row('Win Rate', t.win_rate != null ? t.win_rate + '%' : null)}
          ${row('Time Played', fmtTime(t.time_played))}
          ${row('Hints / Undos', `${t.hints_used} / ${t.undos_used}`)}
          ${row('Total Score', t.total_score.toLocaleString())}
        </div>
      </div>`;
    const ad = r.adaptive, n = ad.next;
    $('#skill-panel').innerHTML = `
      <div class="adaptive-head"><div><div class="eyebrow">Adaptive engine</div><h3 style="margin:4px 0">Current skill</h3></div>
      <div class="skill-gauge"><b>${ad.skill.toFixed(1)}</b><span>/ 10</span></div></div>
      <div class="meter" style="margin:8px 0 14px"><div class="meter-fill" style="width:${ad.skill * 10}%"></div></div>
      <div class="kv">
        <div>Next grid</div><div>${n.rows} × ${n.cols}</div>
        <div>Pairs</div><div>${n.pairs}</div>
        <div>Complexity</div><div><span class="badge ${n.tier}">${n.complexity}</span></div>
        <div>Par time</div><div>${n.time} sec</div>
        <div>Hints</div><div>${n.hints}</div>
      </div>
      <ul class="adaptive-reasons" style="margin-top:12px">${ad.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;

    const s = r.series;
    const charts = [
      ['Score', s.score, { color: 'var(--primary)' }],
      ['Solve time', s.solve_time, { color: 'var(--secondary)', suffix: 's' }],
      ['Accuracy', s.accuracy, { color: 'var(--success)', min: 0, max: 100, suffix: '%' }],
      ['Difficulty progression (skill)', s.skill, { color: 'var(--accent)', min: 0, max: 10 }],
      ['Streak history', s.streak, { color: 'var(--warning)' }],
      ['Hint usage', s.hints, { color: 'var(--danger)' }],
    ];
    $('#charts').innerHTML = charts.map(([title, vals], i) => {
      const last = [...vals].reverse().find(v => v != null);
      return `<article class="card chart-card"><h4>${title}<b>${last ?? '-'}</b></h4><div class="chart" id="chart-${i}"></div></article>`;
    }).join('');
    charts.forEach(([title, vals, opts], i) => Charts.lineChart($('#chart-' + i), vals, { ...opts, title }));

    const modes = Object.entries(r.by_mode);
    $('#mode-table').innerHTML = `<h3>By mode</h3>${modes.length ? `<table class="data"><thead><tr><th>Mode</th><th class="num">Games</th><th class="num">Won</th><th class="num">Best</th></tr></thead><tbody>
      ${modes.map(([m, v]) => `<tr><td>${esc(S.modes[m]?.icon || '')} ${esc(S.modes[m]?.name || m)}</td><td class="num">${v.games}</td><td class="num">${v.won}</td><td class="num">${v.best}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No games yet.</p>'}`;
    const maxT = Math.max(1, ...Object.values(r.tiers));
    $('#tier-bars').innerHTML = `<h3>Boards cleared by difficulty</h3>${Object.entries(r.tiers).map(([k, v]) => `
      <div class="bar-row"><span class="badge ${k}">${k}</span><div class="bar"><i style="width:${100 * v / maxT}%"></i></div><b>${v}</b></div>`).join('')}`;

    if (a.success) {
      $('#ach-count').textContent = `${a.unlocked} / ${a.total}`;
      $('#achievements').innerHTML = Object.entries(a.categories).map(([cat, list]) => `
        <div class="ach-category"><h3>${esc(cat)}</h3><div class="ach-grid">
          ${list.map(x => `<div class="ach ${x.unlocked ? 'on' : ''}"><span class="ai">${x.icon}</span><div><b>${esc(x.name)}</b><small>${esc(x.desc)}</small></div><span class="rw">+${x.reward}</span></div>`).join('')}
        </div></div>`).join('');
    }
  };

  // --------------------------------------------------------- leaderboard --
  LOADERS.ranks = async () => {
    const r = await api('/api/leaderboard?period=' + S.rankPeriod);
    if (!r.success) return;
    $$('#rank-tabs button').forEach(b => b.classList.toggle('active', b.dataset.period === S.rankPeriod));
    $('#rank-table').innerHTML = (r.scope === 'device' ? '<p class="muted small" style="margin-top:0">Players on this device.</p>' : '') + rankTable(r.rows, 'score', r.you);
  };
  $('#rank-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.rankPeriod = b.dataset.period; LOADERS.ranks();
  });

  // --------------------------------------------------------------- store --
  LOADERS.store = async () => {
    const r = await api('/api/shop');
    if (!r.success) return;
    $('#store-coins').textContent = r.coins;
    const inv = r.inventory || {};
    $('#store-grid').innerHTML = r.items.map(it => `
      <article class="card store-item">
        <div class="si-icon">${it.icon}</div>
        <div class="si-name">${esc(it.name)}</div>
        <div class="si-desc">${esc(it.desc)}</div>
        <div class="si-own">Owned: ${inv[it.id] || 0}</div>
        <button class="btn block" data-buy="${it.id}" ${r.coins < it.price ? 'disabled' : ''}>🪙 ${it.price}</button>
      </article>`).join('');
    $$('[data-buy]').forEach(b => b.addEventListener('click', async () => {
      const res = await api('/api/shop/buy', { item: b.dataset.buy });
      if (res.success) { toast('🛒 ' + res.message, '', 'info'); setProfile(res.profile); LOADERS.store(); }
      else toast('Not yet', res.message, 'info');
    }));
  };

  // ------------------------------------------------- players (login gate) --
  // First launch: "Who's playing?" - pick a player, create one (PIN optional) or play as Guest.
  // The desktop app remembers the last player, so later launches go straight in.
  const G = { players: [], desktop: false, shown: false };
  const initial = (n) => esc((n || '?').trim()[0] || '?').toUpperCase();

  async function showGate() {
    if (G.shown) return;
    G.shown = true;
    closeModal();
    const r = await api('/api/players');
    G.players = r.players || [];
    $('#gate').hidden = false;
    gatePick();
  }

  function hideGate() { $('#gate').hidden = true; G.shown = false; }

  function gatePick() {
    const body = $('#gate-body');
    if (G.players.length) {
      body.innerHTML = `
        <h2 id="gate-title">Who's playing?</h2>
        <div class="players-grid">
          ${G.players.map(p => `<button class="player-card" data-id="${p.id}" data-pin="${p.has_pin ? 1 : 0}" data-name="${esc(p.name)}">
              <span class="pc-avatar">${initial(p.name)}</span>
              <span class="pc-name">${esc(p.name)}</span>
              <span class="pc-meta">Level ${p.level} · 🪙 ${p.coins}${p.has_pin ? ' · 🔒' : ''}</span>
            </button>`).join('')}
          <button class="player-card new" id="gate-new"><span class="pc-avatar">+</span><span class="pc-name">New player</span><span class="pc-meta">First time here?</span></button>
        </div>
        <div class="gate-links"><button class="link-btn" id="gate-guest">Play as guest</button><button class="link-btn" id="gate-byname">Log in by name</button></div>`;
      body.querySelectorAll('.player-card[data-id]').forEach(b => b.addEventListener('click', () => {
        if (b.dataset.pin === '1') gatePin({ id: +b.dataset.id, name: b.dataset.name });
        else doLogin({ user_id: +b.dataset.id }, null);
      }));
    } else {
      body.innerHTML = `
        <h2 id="gate-title">Welcome!</h2>
        <p class="muted">Create your player to save your progress, coins and achievements on this device.</p>
        <div class="row gap" style="justify-content:center;margin:14px 0">
          <button class="btn big" id="gate-new">Create player</button>
          <button class="btn big ghost" id="gate-guest">Play as guest</button>
        </div>
        <div class="gate-links"><button class="link-btn" id="gate-byname">I already have a player</button></div>`;
    }
    $('#gate-new').addEventListener('click', gateNew);
    $('#gate-guest').addEventListener('click', async () => { const r = await api('/api/auth/guest', {}); if (r.success) loggedIn(r.profile, false); });
    $('#gate-byname').addEventListener('click', gateByName);
  }

  function gateNew() {
    $('#gate-body').innerHTML = `
      <h2 id="gate-title">New player</h2>
      <form class="form" id="new-form" autocomplete="off">
        <label>Your name<input name="username" required minlength="2" maxlength="20" placeholder="e.g. Dhekshitha" autofocus /></label>
        <label>PIN <span class="muted">(optional - keeps others out of your profile)</span>
          <input name="pin" type="password" inputmode="numeric" maxlength="12" placeholder="Leave empty for no PIN" /></label>
        <div class="form-error" id="gate-err"></div>
        <button class="btn block big" type="submit">Create player & start the tour</button>
      </form>
      <div class="gate-links"><button class="link-btn" id="gate-back">← Back</button></div>`;
    $('#gate-back').addEventListener('click', gatePick);
    $('#new-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const r = await api('/api/auth/register', { username: fd.get('username'), password: fd.get('pin') });
      if (!r.success) { $('#gate-err').textContent = r.message; return; }
      loggedIn(r.profile, true);
    });
    setTimeout(() => $('#new-form [name=username]')?.focus(), 50);
  }

  function gatePin(player) {
    $('#gate-body').innerHTML = `
      <h2 id="gate-title">Hi ${esc(player.name)}!</h2>
      <form class="form" id="pin-form" autocomplete="off">
        <label>Enter your PIN<input name="pin" type="password" class="pin-input" inputmode="numeric" maxlength="64" required /></label>
        <div class="form-error" id="gate-err"></div>
        <button class="btn block big" type="submit">Play</button>
      </form>
      <div class="gate-links"><button class="link-btn" id="gate-back">← Not me</button></div>`;
    $('#gate-back').addEventListener('click', gatePick);
    $('#pin-form').addEventListener('submit', (e) => { e.preventDefault(); doLogin({ user_id: player.id, password: new FormData(e.target).get('pin') }, '#gate-err'); });
    setTimeout(() => $('#pin-form [name=pin]')?.focus(), 50);
  }

  function gateByName() {
    $('#gate-body').innerHTML = `
      <h2 id="gate-title">Log in</h2>
      <form class="form" id="name-form" autocomplete="on">
        <label>Player name<input name="username" required autocomplete="username" /></label>
        <label>PIN <span class="muted">(if you set one)</span><input name="pin" type="password" autocomplete="current-password" /></label>
        <div class="form-error" id="gate-err"></div>
        <button class="btn block big" type="submit">Play</button>
      </form>
      <div class="gate-links"><button class="link-btn" id="gate-back">← Back</button></div>`;
    $('#gate-back').addEventListener('click', gatePick);
    $('#name-form').addEventListener('submit', (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      doLogin({ username: fd.get('username'), password: fd.get('pin') }, '#gate-err');
    });
  }

  async function doLogin(payload, errSel) {
    const r = await api('/api/auth/login', payload);
    if (!r.success) {
      if (r.needs_pin && !errSel) { const p = G.players.find(x => x.id === payload.user_id); if (p) { gatePin(p); return; } }
      if (errSel && $(errSel)) $(errSel).textContent = r.message; else toast('Could not log in', r.message, 'info');
      return;
    }
    loggedIn(r.profile, false);
  }

  function loggedIn(profile, isNew) {
    hideGate();
    setProfile(profile);
    applyTheme(profile.theme);
    if (!profile.tutorial_done) { startTour(true); return; }
    toast(`Welcome back, ${profile.username}!`, '', 'info');
    go('play');
  }

  async function switchPlayer() {
    if (S.game && S.game.status === 'active' && S.view === 'game') {
      if (!confirm('Switch player? Your current game will be ended.')) return;
      await api(`/api/games/${S.gameId}/end`, {});
    }
    closeModal();
    const r = await api('/api/auth/logout', {});
    S.profile = null; G.players = r.players || [];
    clearInterval(S.timer);
    G.shown = false;
    showGate();
  }

  function openSaveGuest() {
    const body = openModal('Save as a player', `
      <p class="muted" style="margin-top:0">Give the guest profile a name. Everything you've earned as Guest - coins, stats, achievements - moves to it.</p>
      <form class="form" id="save-form" autocomplete="off">
        <label>Your name<input name="username" required minlength="2" maxlength="20" /></label>
        <label>PIN <span class="muted">(optional)</span><input name="pin" type="password" inputmode="numeric" maxlength="12" /></label>
        <div class="form-error" id="save-err"></div>
        <button class="btn block" type="submit">Save player</button>
      </form>`);
    body.querySelector('#save-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      const r = await api('/api/auth/register', { username: fd.get('username'), password: fd.get('pin') });
      if (!r.success) { $('#save-err').textContent = r.message; return; }
      closeModal(); setProfile(r.profile); toast(`Saved as ${r.profile.username}!`, 'Your progress is kept.', 'info'); go('play');
    });
  }

  function openPinSettings() {
    const p = S.profile;
    const body = openModal(p.has_pin ? 'Change PIN' : 'Add a PIN', `
      <form class="form" id="pin-set" autocomplete="off">
        ${p.has_pin ? '<label>Current PIN<input name="current" type="password" required /></label>' : ''}
        <label>New PIN <span class="muted">${p.has_pin ? '(leave empty to remove the PIN)' : '(4+ characters)'}</span><input name="pin" type="password" /></label>
        <div class="form-error" id="pin-err"></div>
        <button class="btn block" type="submit">Save</button>
      </form>`);
    body.querySelector('#pin-set').addEventListener('submit', async (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      const r = await api('/api/auth/pin', { current: fd.get('current'), pin: fd.get('pin') });
      if (!r.success) { $('#pin-err').textContent = r.message; return; }
      closeModal(); setProfile(r.profile); toast(r.profile.has_pin ? 'PIN saved 🔒' : 'PIN removed', '', 'info');
    });
  }

  $('#avatar-btn').addEventListener('click', () => {
    const p = S.profile;
    if (!p) { showGate(); return; }
    const body = openModal(p.username, `
      <div class="kv">
        <div>Level</div><div>${p.level}</div>
        <div>Skill</div><div>${p.skill} / 10</div>
        <div>Coins</div><div>🪙 ${p.coins}</div>
        <div>Achievements</div><div>${p.achievements_unlocked} / ${p.achievements_total}</div>
      </div>
      <div class="modal-actions">
        ${p.is_guest ? '<button class="btn" id="m-save">Save as a player</button>' : `<button class="btn ghost" id="m-pin">${p.has_pin ? 'Change PIN' : 'Add a PIN'}</button>`}
        <button class="btn ghost" id="m-howto">How to play</button>
        <button class="btn" id="m-switch">Switch player</button>
      </div>`);
    body.querySelector('#m-save')?.addEventListener('click', openSaveGuest);
    body.querySelector('#m-pin')?.addEventListener('click', openPinSettings);
    body.querySelector('#m-howto').addEventListener('click', () => { closeModal(); startTour(false); });
    body.querySelector('#m-switch').addEventListener('click', switchPlayer);
  });

  // ------------------------------------------------------- how-to-play tour --
  // Shown automatically to new players (and any time from "How to play").
  const T = { i: 0, firstTime: false, practiceDone: false };

  // Tiny copy of the matching rules for the practice board (same as engine/rules.py).
  const canMatch = (a, b) => a > 0 && b > 0 && (a === 11 || b === 11 || a === b || a + b === 10);
  function connected(g, p1, p2) {
    const R = g.length, C = g[0].length;
    let [a, b] = (p1[0] * C + p1[1] < p2[0] * C + p2[1]) ? [p1, p2] : [p2, p1];
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let r = a[0] + dr, c = a[1] + dc;
      while (r >= 0 && r < R && c >= 0 && c < C) {
        if (g[r][c] !== 0) { if (r === b[0] && c === b[1]) return true; break; }
        r += dr; c += dc;
      }
    }
    for (let i = a[0] * C + a[1] + 1; i < R * C; i++) {          // row wrap
      const r = Math.floor(i / C), c = i % C;
      if (g[r][c] !== 0) return r === b[0] && c === b[1] && r !== a[0];
    }
    return false;
  }
  function anyPair(g) {
    for (let r1 = 0; r1 < g.length; r1++) for (let c1 = 0; c1 < g[0].length; c1++)
      for (let r2 = 0; r2 < g.length; r2++) for (let c2 = 0; c2 < g[0].length; c2++) {
        if ((r1 * 99 + c1) >= (r2 * 99 + c2)) continue;
        if (canMatch(g[r1][c1], g[r2][c2]) && connected(g, [r1, c1], [r2, c2])) return [[r1, c1], [r2, c2]];
      }
    return null;
  }

  function mini(grid, hl = [], bad = []) {
    const k = (r, c, list) => list.some(([a, b]) => a === r && b === c);
    return `<div class="mini" style="--cols:${grid[0].length}">${grid.map((row, r) => row.map((v, c) =>
      `<div class="tile ${v === 0 ? 'empty' : ''} ${k(r, c, hl) ? 'hl' : ''} ${k(r, c, bad) ? 'bad' : ''}">${v || ''}</div>`).join('')).join('')}</div>`;
  }

  const TOUR = [
    () => `<h2 id="tour-title">Welcome${S.profile && !S.profile.is_guest ? ', ' + esc(S.profile.username) : ''}! 👋</h2>
      <p>NUMMAT is a number puzzle: <b>clear the board by matching pairs of tiles</b>. It learns how you play and tunes every new board to you.</p>
      <p class="muted">This quick tour shows the rules, lets you try a tiny board, and points out the tools and rewards. It takes about a minute - you can skip it and replay it any time from <b>How to play</b>.</p>
      <div class="demo-row">${mini([[3, 7, 5, 5], [8, 2, 9, 1]], [[0, 0], [0, 1]])}</div>`,
    () => `<h2 id="tour-title">Rule 1 · Match equal numbers</h2>
      <p>Two tiles with the <b>same number</b> make a pair.</p>
      <div class="demo-row">
        <div class="demo-pair">${mini([[5, 5]], [[0, 0], [0, 1]])}<span class="ok">✓</span></div>
        <div class="demo-pair">${mini([[8, 8]], [[0, 0], [0, 1]])}<span class="ok">✓</span></div>
        <div class="demo-pair">${mini([[4, 7]], [], [[0, 0], [0, 1]])}<span class="no">✗</span></div>
      </div>`,
    () => `<h2 id="tour-title">Rule 2 · …or numbers that add up to 10</h2>
      <p>Two tiles whose numbers <b>sum to 10</b> are also a pair.</p>
      <div class="sum-chips"><span>1 + 9</span><span>2 + 8</span><span>3 + 7</span><span>4 + 6</span><span>5 + 5</span></div>
      <div class="demo-row"><div class="demo-pair">${mini([[3, 7]], [[0, 0], [0, 1]])}<span class="ok">3 + 7 = 10 ✓</span></div></div>
      <p class="muted small">In Expert and Spring you'll also meet ★ wildcards, which match any number.</p>`,
    () => `<h2 id="tour-title">Rule 3 · They need a clear line</h2>
      <p>The two tiles must be connected with <b>only empty cells between them</b>, in one of four ways:</p>
      <div class="conn-grid">
        <div class="conn-card">${mini([[3, 0, 0, 7]], [[0, 0], [0, 3]])}<b>Same row</b><small>gaps are fine</small></div>
        <div class="conn-card">${mini([[6], [0], [4]], [[0, 0], [2, 0]])}<b>Same column</b><small>up or down</small></div>
        <div class="conn-card">${mini([[2, 0, 0], [0, 0, 0], [0, 0, 8]], [[0, 0], [2, 2]])}<b>Diagonal</b><small>either direction</small></div>
        <div class="conn-card">${mini([[1, 4, 9, 5], [5, 3, 6, 2]], [[0, 3], [1, 0]])}<b>Row wrap</b><small>end of a row → start of the next</small></div>
      </div>
      <div class="demo-row"><div class="demo-pair">${mini([[3, 5, 7]], [], [[0, 0], [0, 2]])}<span class="no">✗</span><small class="muted">the 5 blocks the line</small></div></div>`,
    () => `<h2 id="tour-title">Try it! 🎯</h2>
      <p>Clear this little board. <b>Tap a tile, then its partner</b> - or drag from one to the other. Glowing tiles show a pair you can make.</p>
      <div class="practice"><div class="board" id="practice-board" role="grid" aria-label="Practice board"></div>
        <div class="practice-msg" id="practice-msg" aria-live="polite">Start with the glowing pair.</div></div>`,
    () => `<h2 id="tour-title">Six ways to play</h2>
      <div class="feature-grid">
        <div class="feature"><span class="fi">🎯</span><div><b>Classic</b><small>The original, plus 6 themed level packs that unlock as you go.</small></div></div>
        <div class="feature"><span class="fi">🔗</span><div><b>Chain</b><small>Play a pair your last match opened to grow a score multiplier.</small></div></div>
        <div class="feature"><span class="fi">⏱️</span><div><b>Time Attack</b><small>As many matches as you can in 2 minutes. New boards appear instantly.</small></div></div>
        <div class="feature"><span class="fi">📅</span><div><b>Daily Challenge</b><small>Same puzzle for everyone today. 20 moves, no hints, global scoreboard.</small></div></div>
        <div class="feature"><span class="fi">🧘</span><div><b>Zen</b><small>No timer, no score, unlimited undo. Just solve.</small></div></div>
        <div class="feature"><span class="fi">💀</span><div><b>Expert</b><small>Walls ■, frozen tiles ❄ (clear a neighbour to thaw) and ★ wildcards.</small></div></div>
      </div>`,
    () => `<h2 id="tour-title">Help when you're stuck</h2>
      <div class="feature-grid">
        <div class="feature"><span class="fi">💡</span><div><b>Hint</b><small>Shows a pair you can match.</small></div></div>
        <div class="feature"><span class="fi">❓</span><div><b>Why?</b><small>Explains the hinted pair - free.</small></div></div>
        <div class="feature"><span class="fi">🎯</span><div><b>Best move</b><small>The solver's optimal move.</small></div></div>
        <div class="feature"><span class="fi">↩</span><div><b>Undo</b><small>Take back your last match.</small></div></div>
        <div class="feature"><span class="fi">🧠</span><div><b>Solve</b><small>Checks if the board can still be cleared, and can play the solution.</small></div></div>
        <div class="feature"><span class="fi">➕</span><div><b>Add numbers</b><small>Copies every number left onto new rows at the bottom. 2 free per game, then 🪙50.</small></div></div>
        <div class="feature"><span class="fi">💣</span><div><b>Bomb tiles</b><small>Match one and it also clears the tiles around it.</small></div></div>
        <div class="feature"><span class="fi">➖</span><div><b>Row-clear tiles</b><small>Match one and its whole row disappears.</small></div></div>
      </div>
      <p class="muted small">Empty rows vanish and the board slides up (+25 each). No pairs left? Tap ➕ Add. In Daily you can't add - use Undo!</p>`,
    () => `<h2 id="tour-title">Rewards & progress</h2>
      <div class="feature-grid">
        <div class="feature"><span class="fi">🔥</span><div><b>Streaks</b><small>Match without mistakes for bonus points.</small></div></div>
        <div class="feature"><span class="fi">🪙</span><div><b>Coins & Store</b><small>Earned by playing. Buy Shuffle, Smart Hint, Time Freeze…</small></div></div>
        <div class="feature"><span class="fi">🏅</span><div><b>Achievements</b><small>23 to unlock across 5 categories.</small></div></div>
        <div class="feature"><span class="fi">🧠</span><div><b>Adaptive difficulty</b><small>Your skill (0-10) sets the next board's size and challenge.</small></div></div>
        <div class="feature"><span class="fi">📊</span><div><b>Stats & Leaderboard</b><small>Charts of your progress and rankings.</small></div></div>
        <div class="feature"><span class="fi">🎨</span><div><b>Themes</b><small>Winter snow, autumn leaves, spring petals, summer sun.</small></div></div>
      </div>`,
    () => `<h2 id="tour-title">You're ready! 🎉</h2>
      <p>Your first board is tuned to a gentle start - it grows with you as you improve.</p>
      <p class="muted">Tip: click your avatar (top right) to switch player, add a PIN or replay this tour.</p>
      <div class="tour-finish">
        <button class="btn big" id="tour-play">▶ Play my first level</button>
        <button class="btn big ghost" id="tour-home">Explore the menu</button>
      </div>`,
  ];
  const PRACTICE = [[5, 5, 2, 7], [7, 1, 8, 4], [5, 1, 6, 5]];   // every order of valid moves clears it

  function startTour(firstTime) {
    T.i = 0; T.firstTime = firstTime; T.practiceDone = false;
    closeModal();
    $('#tour').hidden = false;
    drawTour();
  }

  async function endTour(then) {
    $('#tour').hidden = true;
    if (S.profile && !S.profile.tutorial_done) {
      const r = await api('/api/tutorial/done', {});
      if (r.success) setProfile(r.profile);
    }
    if (then === 'play') startGame('classic');
    else go('play');
  }

  function drawTour() {
    $('#tour-body').innerHTML = TOUR[T.i]();
    $('#tour-body').style.animation = 'none'; void $('#tour-body').offsetWidth; $('#tour-body').style.animation = '';
    $('#tour-dots').innerHTML = TOUR.map((_, k) => `<i class="${k === T.i ? 'on' : ''}"></i>`).join('');
    $('#tour-back').style.visibility = T.i === 0 ? 'hidden' : 'visible';
    const last = T.i === TOUR.length - 1;
    $('#tour-next').hidden = last;
    $('#tour-next').textContent = T.i === 0 ? "Let's go →" : 'Next →';
    $('#tour-next').disabled = false;
    if (T.i === 4) setupPractice();
    if (last) {
      $('#tour-play').addEventListener('click', () => endTour('play'));
      $('#tour-home').addEventListener('click', () => endTour('home'));
    }
  }

  function setupPractice() {
    const board = $('#practice-board');
    let grid = PRACTICE.map(r => r.slice()), sel = null;
    const next = $('#tour-next');
    if (!T.practiceDone) { next.textContent = 'Skip practice →'; }
    const draw = () => {
      renderBoard(board, grid, []);
      const pair = anyPair(grid);
      if (pair) pair.forEach(p => tileAt(p, board)?.classList.add('hint'));
      if (sel) tileAt(sel, board)?.classList.add('selected');
    };
    const msg = (t, bad) => { const m = $('#practice-msg'); m.textContent = t; m.classList.toggle('bad', !!bad); };
    const tryPair = (a, b) => {
      const va = grid[a[0]][a[1]], vb = grid[b[0]][b[1]];
      if (!canMatch(va, vb)) { msg(`${va} and ${vb} are not equal and don't add to 10.`, true); FX.haptic([30, 40, 30]); return; }
      if (!connected(grid, a, b)) { msg('Those two are not on a clear line - something is in between.', true); FX.haptic([30, 40, 30]); return; }
      FX.burst(tileAt(b, board)); FX.haptic(15);
      grid[a[0]][a[1]] = 0; grid[b[0]][b[1]] = 0;
      const left = grid.flat().filter(v => v > 0).length;
      msg(left ? `${va === vb ? `${va} = ${vb}` : `${va} + ${vb} = 10`} ✓  -  ${left / 2} pair${left > 2 ? 's' : ''} to go` : '🎉 Board cleared - you\'ve got it!');
      if (!left) { T.practiceDone = true; next.textContent = 'Next →'; }
    };
    let dragFrom = null;
    board.onpointerdown = (e) => {
      const t = e.target.closest('.tile'); if (!t || t.classList.contains('empty')) return;
      const p = [+t.dataset.r, +t.dataset.c];
      if (sel && sel[0] === p[0] && sel[1] === p[1]) { sel = null; draw(); return; }
      if (sel) { const a = sel; sel = null; tryPair(a, p); draw(); return; }
      sel = p; dragFrom = p; draw();
    };
    board.onpointerup = (e) => {
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#practice-board .tile');
      if (dragFrom && over && !over.classList.contains('empty')) {
        const p = [+over.dataset.r, +over.dataset.c];
        if (p[0] !== dragFrom[0] || p[1] !== dragFrom[1]) { sel = null; tryPair(dragFrom, p); draw(); }
      }
      dragFrom = null;
    };
    draw();
  }

  $('#tour-next').addEventListener('click', () => { if (T.i < TOUR.length - 1) { T.i++; drawTour(); } });
  $('#tour-back').addEventListener('click', () => { if (T.i > 0) { T.i--; drawTour(); } });
  $('#tour-skip').addEventListener('click', () => endTour('home'));

  // ------------------------------------------------ Android back button --
  (() => {
    const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!CapApp) return;
    CapApp.addListener('backButton', () => {
      if (!$('#modal').hidden) { closeModal(); return; }
      if (!$('#theme-pop').hidden) { $('#theme-pop').hidden = true; return; }
      if (!$('#tour').hidden) { if (T.i > 0) { T.i--; drawTour(); } else endTour('home'); return; }
      if (S.solution) { stopSolution(); return; }
      if (!$('#gate').hidden) { CapApp.exitApp(); return; }
      if (S.view === 'game') { $('#a-exit').click(); return; }
      if (S.view !== 'play') { go('play'); return; }
      CapApp.exitApp();
    });
  })();

  // ---------------------------------------------------------------- boot --
  initTheme();
  (async () => {
    const me = await api('/api/me');
    if (!me.success || me.needs_login) {
      G.players = me.players || [];
      G.desktop = !!me.desktop;
      G.shown = true;
      $('#gate').hidden = false;
      gatePick();
      return;
    }
    setProfile(me.profile);
    if (!me.profile.tutorial_done) { startTour(true); return; }
    loadHome();
  })();
})();
