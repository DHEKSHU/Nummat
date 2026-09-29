/* NUMMAT visual effects: seasonal particle layer + match bursts.
   Each theme has its own particle behaviour so the theme changes the feel,
   not just the background image. */
(function () {
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, dpr = 1, parts = [], theme = 'classic', raf = null;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const PROFILES = {
    classic: { count: 40, make: () => ({ x: rnd(W), y: rnd(H), vx: rnd(.4, -.2), vy: rnd(.4, -.2), r: rnd(2, 1), kind: 'dot' }) },
    winter:  { count: 90, make: (top) => ({ x: rnd(W), y: top ? -10 : rnd(H), vx: rnd(.4, -.2), vy: rnd(1.1, .4), r: rnd(2.6, 1), kind: 'snow', sway: rnd(Math.PI * 2) }) },
    autumn:  { count: 26, make: (top) => ({ x: rnd(W), y: top ? -20 : rnd(H), vx: rnd(.6, -.1), vy: rnd(1, .5), r: rnd(7, 5), kind: 'leaf', rot: rnd(6.28), vr: rnd(.04, -.02), hue: [22, 32, 12, 40][Math.floor(rnd(4))] }) },
    spring:  { count: 34, make: (top) => ({ x: top ? rnd(W * .6) - W * .2 : rnd(W), y: top ? -10 : rnd(H), vx: rnd(.9, .3), vy: rnd(.8, .35), r: rnd(5, 3), kind: 'petal', rot: rnd(6.28), vr: rnd(.03, -.015) }) },
    summer:  { count: 30, make: (top) => ({ x: rnd(W), y: top ? H + 10 : rnd(H), vx: rnd(.2, -.1), vy: -rnd(.6, .2), r: rnd(3.5, 1.5), kind: 'sun', life: rnd(1) }) },
  };

  function rnd(span, min = 0) { return min + Math.random() * span; }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function reset() {
    const p = PROFILES[theme] || PROFILES.classic;
    const n = Math.round(p.count * Math.min(1, (W * H) / (1280 * 800)) + 8);
    parts = Array.from({ length: n }, () => p.make(false));
  }

  function draw(p, primary, accent) {
    ctx.save();
    switch (p.kind) {
      case 'dot':
        ctx.globalAlpha = .25; ctx.fillStyle = primary;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); break;
      case 'snow':
        ctx.globalAlpha = .85; ctx.fillStyle = '#ffffff'; ctx.shadowColor = 'rgba(98,195,232,.8)'; ctx.shadowBlur = 4;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); break;
      case 'leaf':
        ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = .75;
        ctx.fillStyle = `hsl(${p.hue}, 80%, 50%)`;
        ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * .5, 0, 0, 6.28); ctx.fill();
        ctx.strokeStyle = `hsl(${p.hue}, 70%, 32%)`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-p.r, 0); ctx.lineTo(p.r, 0); ctx.stroke(); break;
      case 'petal':
        ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = .7;
        ctx.fillStyle = '#f7a1c4';
        ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * .6, 0, 0, 6.28); ctx.fill(); break;
      case 'sun': {
        const a = Math.sin(p.life * Math.PI);
        ctx.globalAlpha = .55 * a; ctx.fillStyle = '#ffd166'; ctx.shadowColor = '#ffb703'; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); break;
      }
    }
    ctx.restore();
  }

  function step() {
    ctx.clearRect(0, 0, W, H);
    const primary = css('--primary') || '#3a8dde';
    const prof = PROFILES[theme] || PROFILES.classic;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.kind === 'snow') { p.sway += .02; p.x += p.vx + Math.sin(p.sway) * .3; } else p.x += p.vx;
      p.y += p.vy;
      if (p.rot !== undefined) p.rot += p.vr;
      if (p.kind === 'sun') { p.life += .004; if (p.life > 1) parts[i] = prof.make(true); }
      if (p.kind === 'dot') {
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
      } else if (p.y > H + 20 || p.x > W + 30 || p.x < -40 || p.y < -30) {
        parts[i] = prof.make(true);
      }
      draw(parts[i], primary);
    }
    raf = requestAnimationFrame(step);
  }

  function setTheme(t) {
    theme = PROFILES[t] ? t : 'classic';
    reset();
    if (reduced) { ctx.clearRect(0, 0, W, H); parts.forEach(p => draw(p, css('--primary'))); return; }
    if (!raf) step();
  }

  function burst(el, count = 12) {
    if (reduced || !el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const colors = [css('--primary'), css('--accent'), css('--secondary')];
    for (let i = 0; i < count; i++) {
      const d = document.createElement('div');
      d.className = 'burst';
      const ang = (Math.PI * 2 * i) / count, dist = 36 + Math.random() * 40;
      d.style.left = cx + 'px'; d.style.top = cy + 'px';
      d.style.background = colors[i % 3];
      d.style.setProperty('--tx', Math.cos(ang) * dist + 'px');
      d.style.setProperty('--ty', Math.sin(ang) * dist + 'px');
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 850);
    }
  }

  function fxEl(cls, style) {
    const d = document.createElement('div');
    d.className = cls;
    Object.assign(d.style, style);
    document.body.appendChild(d);
    return d;
  }
  const centre = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r]; };

  // a glowing line between two matched tiles
  function line(a, b) {
    if (reduced || !a || !b) return;
    const [x1, y1] = centre(a), [x2, y2] = centre(b);
    const d = fxEl('fx-line', { left: x1 + 'px', top: (y1 - 3) + 'px', width: Math.hypot(x2 - x1, y2 - y1) + 'px',
      transform: `rotate(${Math.atan2(y2 - y1, x2 - x1)}rad)` });
    setTimeout(() => d.remove(), 500);
  }

  // bomb: shockwave ring over the 3x3 area
  function shock(el) {
    if (!el) return;
    const [x, y, r] = centre(el);
    const size = r.width * 3.6;
    if (!reduced) { const d = fxEl('fx-shock', { left: x + 'px', top: y + 'px', width: size + 'px', height: size + 'px' }); setTimeout(() => d.remove(), 650); }
    burst(el, 22);
  }

  // row clear: a beam across the row
  function beam(first, last) {
    if (reduced || !first || !last) return;
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    const h = a.height * .5;
    const d = fxEl('fx-beam', { left: (a.left - 10) + 'px', top: (a.top + a.height / 2 - h / 2) + 'px', width: (b.right - a.left + 20) + 'px', height: h + 'px' });
    setTimeout(() => d.remove(), 600);
  }

  // board cleared: confetti rain
  function confetti(count = 90) {
    if (reduced) return;
    const colors = [css('--primary'), css('--accent'), css('--secondary'), '#ffcf4a', '#ff6b8b', '#4ade80'];
    for (let i = 0; i < count; i++) {
      const d = fxEl('confetti', { left: Math.random() * 100 + 'vw', background: colors[i % colors.length], animationDelay: Math.random() * .6 + 's' });
      d.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
      d.style.setProperty('--rot', (Math.random() * 900 - 450) + 'deg');
      d.style.setProperty('--dur', (1.8 + Math.random() * 1.4) + 's');
      if (i % 3 === 0) d.style.borderRadius = '50%';
      setTimeout(() => d.remove(), 3800);
    }
  }

  function haptic(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* unsupported */ } }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && raf) { cancelAnimationFrame(raf); raf = null; }
    else if (!document.hidden && !raf && !reduced) step();
  });
  window.addEventListener('resize', () => { resize(); reset(); });
  resize();

  window.FX = { setTheme, burst, haptic, line, shock, beam, confetti };
})();
