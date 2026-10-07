// Mockup helper (design/ only, not part of the app).
// Every <template data-screen="..." data-title="..."> is rendered twice, in a light and a dark phone frame (380px wide).
// [data-contrast] tables are filled from the frames' real tokens: data-pairs="fgVar bgVar min label; ...".

const lum = (hex) => {
  const m = hex.trim().replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m.slice(0, 6);
  return [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function frame(tpl, theme) {
  const fig = document.createElement('figure');
  fig.className = 'frame';
  const cap = document.createElement('figcaption');
  cap.textContent = `${tpl.dataset.title} · ${theme} · 380px`;
  const phone = document.createElement('div');
  phone.className = `phone theme-${theme}`;
  phone.append(tpl.content.cloneNode(true));
  fig.append(cap, phone);
  return fig;
}

for (const tpl of document.querySelectorAll('template[data-screen]')) {
  const row = document.createElement('section');
  row.className = 'screen-row';
  row.setAttribute('aria-label', tpl.dataset.title);
  const h = document.createElement('h2');
  h.textContent = tpl.dataset.title;
  const note = tpl.dataset.note ? Object.assign(document.createElement('p'), { textContent: tpl.dataset.note, className: 'row-note' }) : null;
  const frames = document.createElement('div');
  frames.className = 'frames';
  frames.append(frame(tpl, 'light'), frame(tpl, 'dark'));
  row.append(h, ...(note ? [note] : []), frames);
  tpl.replaceWith(row);
}

for (const table of document.querySelectorAll('[data-contrast]')) {
  const pairs = table.dataset.pairs.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [fg, bg, min, ...label] = s.split(/\s+/);
    return { fg, bg, min: Number(min), label: label.join(' ') };
  });
  const body = table.querySelector('tbody');
  for (const theme of ['light', 'dark']) {
    const probe = document.querySelector(`.phone.theme-${theme}`);
    if (!probe) continue;
    const cs = getComputedStyle(probe);
    for (const p of pairs) {
      const fg = cs.getPropertyValue(p.fg).trim();
      const bg = cs.getPropertyValue(p.bg).trim();
      const r = ratio(fg, bg);
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${theme}</td><td>${p.label}</td><td><span class="chip" style="background:${fg}"></span>${fg} on <span class="chip" style="background:${bg}"></span>${bg}</td><td>${r.toFixed(2)}:1</td><td>${r >= p.min ? 'pass' : 'FAIL'} (≥${p.min})</td>`;
      if (r < p.min) tr.className = 'fail';
      body.append(tr);
    }
  }
}

// Replay the highlighter swipe (it draws in once; off under prefers-reduced-motion).
document.querySelector('[data-replay]')?.addEventListener('click', () => {
  document.documentElement.classList.remove('swipe-in');
  void document.documentElement.offsetWidth;
  document.documentElement.classList.add('swipe-in');
});
document.documentElement.classList.add('swipe-in');
