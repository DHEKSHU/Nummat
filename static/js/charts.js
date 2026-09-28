/* Tiny dependency-free SVG line chart used by the analytics dashboard. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  /**
   * lineChart(container, values, {color, min, max, suffix, title})
   * values may contain null (drawn as gaps).
   */
  function lineChart(container, values, opts = {}) {
    container.innerHTML = '';
    const pts = values.map((v, i) => [i, v]).filter(p => p[1] !== null && p[1] !== undefined);
    if (pts.length < 2) {
      container.innerHTML = '<div class="chart-empty">Play a few more games to see this chart.</div>';
      return;
    }
    const W = 320, H = 150, L = 34, R = 8, T = 10, B = 22;
    const color = opts.color || 'var(--primary)';
    const lo = opts.min !== undefined ? opts.min : Math.min(0, ...pts.map(p => p[1]));
    const hi = opts.max !== undefined ? opts.max : niceMax(Math.max(...pts.map(p => p[1])));
    const n = values.length;
    const x = i => L + (n === 1 ? 0 : (i / (n - 1)) * (W - L - R));
    const y = v => T + (1 - (v - lo) / ((hi - lo) || 1)) * (H - T - B);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.title || 'chart' });
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid-line' }, svg);
      const t = el('text', { x: L - 6, y: y(v) + 3, 'text-anchor': 'end', class: 'axis-label' }, svg);
      t.textContent = Math.round(v) + (opts.suffix || '');
    }
    const first = el('text', { x: L, y: H - 6, class: 'axis-label' }, svg); first.textContent = 'older';
    const last = el('text', { x: W - R, y: H - 6, 'text-anchor': 'end', class: 'axis-label' }, svg); last.textContent = 'latest';

    // split into continuous segments (nulls = gaps)
    let seg = [], segs = [];
    values.forEach((v, i) => {
      if (v === null || v === undefined) { if (seg.length) segs.push(seg); seg = []; }
      else seg.push([x(i), y(v)]);
    });
    if (seg.length) segs.push(seg);
    segs.forEach(s => {
      if (s.length > 1) {
        const d = s.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        el('path', { d: d + ` L${s[s.length - 1][0]} ${y(lo)} L${s[0][0]} ${y(lo)} Z`, class: 'area', fill: color }, svg);
        el('path', { d, class: 'line', stroke: color }, svg);
      }
    });
    pts.forEach(([i, v]) => {
      const c = el('circle', { cx: x(i), cy: y(v), r: 3, class: 'dot', fill: color }, svg);
      const tt = el('title', {}, c); tt.textContent = `${v}${opts.suffix || ''}`;
    });
    container.appendChild(svg);
  }

  window.Charts = { lineChart };
})();
