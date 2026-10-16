// Motion proposals board (design/ only, not part of the app). Web Animations API with the durations and easings the
// app's Motion code would use. Every animation can be skipped by a tap and none blocks a control.

const root = document.documentElement;
const os = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => (root.dataset.motion ? root.dataset.motion === 'reduce' : os.matches);
const OUT = 'cubic-bezier(0.16, 1, 0.3, 1)'; // confident arrival
const FLIP_EASE = 'cubic-bezier(0.3, 0.7, 0.2, 1)'; // FlipCard.jsx
const IN_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)';
const FADE_MS = 150;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const play = (el, frames, opts) => el.animate(frames, { fill: 'both', ...opts });
// two frames: the new content has been painted (a hidden tab gets no frames, so give up waiting after 100 ms)
const nextPaint = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
    setTimeout(resolve, 100);
  });

// ---- page controls ----------------------------------------------------------------------------------------------
const state = document.getElementById('motion-state');
const showMotion = () => {
  state.textContent = reduced() ? 'Playing: reduced motion (fades only)' : 'Playing: full motion';
};
for (const input of document.querySelectorAll('input[name="motion"]')) {
  input.addEventListener('change', () => {
    if (input.value === 'device') delete root.dataset.motion;
    else root.dataset.motion = input.value;
    showMotion();
  });
}
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', () => {
    root.dataset.theme = input.value;
  });
}
root.dataset.theme = 'light';
os.addEventListener('change', showMotion);
showMotion();

// ---- the research clock ------------------------------------------------------------------------------------------
// The same rule the app's answer clock will follow: waiting while something animates in, running once the card or
// question is usable, paused during a flip, stopped at the answer.
const clocks = new Set();
class Clock {
  constructor(el) {
    this.el = el;
    this.log = [];
    this.idle('nothing on screen yet');
    clocks.add(this);
  }
  now() {
    return performance.now();
  }
  set(state, why) {
    this.state = state;
    this.why = why;
    this.paint();
  }
  note(text) {
    this.log = [text, ...this.log].slice(0, 3);
    this.paint();
  }
  idle(why) {
    this.acc = 0;
    this.set('idle', why);
  }
  wait(why) {
    this.acc = 0;
    this.waitFrom = this.now();
    this.set('waiting', why);
  }
  // Only from waiting: a "usable" signal that arrives after the answer (a late paint) changes nothing.
  start(why) {
    if (this.state !== 'waiting') return;
    const waited = Math.round(this.now() - this.waitFrom);
    this.acc = 0;
    this.since = this.now();
    this.set('running', why);
    if (waited > 50) this.note(`${waited} ms of animation left out`);
  }
  // shown, then usable at the next paint (no entrance)
  startAtPaint(why) {
    this.wait('drawing the page');
    nextPaint().then(() => this.start(why));
  }
  pause(why) {
    if (this.state !== 'running') return;
    this.acc += this.now() - this.since;
    this.pausedAt = this.now();
    this.set('paused', why);
  }
  resume() {
    if (this.state !== 'paused') return;
    this.note(`${Math.round(this.now() - this.pausedAt)} ms flip left out`);
    this.since = this.now();
    this.set('running', 'card turned over');
  }
  read() {
    return Math.round(this.acc + (this.state === 'running' ? this.now() - this.since : 0));
  }
  stop(label) {
    const ms = this.read();
    this.acc = ms;
    this.set('stopped', label);
    this.note(`${label}: time_ms = ${ms}`);
    return ms;
  }
  paint() {
    if (!this.el) return;
    const t = (this.read() / 1000).toFixed(2);
    const words = {
      idle: 'not running',
      waiting: 'waiting',
      running: `running · ${t} s`,
      paused: `paused · ${t} s`,
      stopped: `stopped · ${t} s`,
    }[this.state];
    this.el.dataset.state = this.state;
    this.el.innerHTML = '';
    this.el.append(
      h('div', {}, h('b', { text: 'Answer clock: ' }), h('span', { class: 'clock__state', text: words }), this.why ? ` (${this.why})` : ''),
      ...this.log.map((line) => h('p', { class: 'clock__log', text: line })),
    );
  }
}
const tick = () => {
  for (const c of clocks) if (c.state === 'running') c.paint();
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

// ---- shared bits -----------------------------------------------------------------------------------------------
const back = () => h('span', { class: 'head__back', 'aria-hidden': 'true', text: '‹' });
const studyHead = (title, counts) =>
  h(
    'div',
    { class: 'head' },
    back(),
    h('p', { class: 'head__title', text: title }),
    counts &&
      h(
        'p',
        { class: 'counts' },
        h('span', {}, h('b', { class: 'c-new', text: counts.new }), ' New'),
        h('span', {}, h('b', { class: 'c-learn', text: counts.learning }), ' Learning'),
        h('span', {}, h('b', { class: 'c-due', text: counts.due }), ' Due'),
      ),
  );

// A hand-drawn loop round a w x h box, in its own pixels: a little more than one turn, slightly tilted, ending past
// where it began, the way a pen circles an answer.
function loopPath(w, h, { turns = 1.12, tilt = -0.07, start = -0.9 } = {}) {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - 2;
  const ry = h / 2 - 2;
  const n = 36;
  const pts = [];
  for (let k = 0; k <= n; k += 1) {
    const t = k / n;
    const a = start - t * turns * Math.PI * 2;
    const wobble = 1 + 0.035 * Math.sin(t * 9) + (t > 0.85 ? (t - 0.85) * 0.5 : 0);
    const x = Math.cos(a) * rx * wobble;
    const y = Math.sin(a) * ry * wobble;
    pts.push([cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)]);
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}
// Draw an SVG path in (stroke-dashoffset). `duration` 0 shows it at once.
function draw(path, { duration, delay = 0, easing = OUT }) {
  path.setAttribute('pathLength', '1');
  path.style.strokeDasharray = '1';
  if (!duration) {
    path.style.strokeDashoffset = '0';
    return path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, fill: 'both' });
  }
  return path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration, delay, easing, fill: 'both' });
}

// ---- F1 the deck comes out --------------------------------------------------------------------------------------
const CARDS_SHOWN = 5;
function deckOut(stage, ms, onDone) {
  let finished = false;
  const anims = [];
  const deck = h('div', { class: 'deckout__deck', 'aria-hidden': 'true' });
  const box = h(
    'div',
    { class: 'deckout', tabindex: '0', role: 'button', 'aria-label': 'Getting your deck out. Press to skip.' },
    deck,
    h('p', { class: 'deckout__text', role: 'status', text: 'Getting your deck out' }),
    h('p', { class: 'muted', 'aria-hidden': 'true', text: 'Tap to skip' }),
  );
  const end = () => {
    if (finished) return;
    finished = true;
    for (const a of anims) a.cancel();
    onDone();
  };
  box.addEventListener('click', end);
  box.addEventListener('keydown', (e) => {
    if (['Enter', ' ', 'Escape'].includes(e.key)) {
      e.preventDefault();
      end();
    }
  });
  stage.append(box);
  const n = CARDS_SHOWN;
  for (let i = 0; i < n; i += 1) {
    const side = i % 2 ? 1 : -1;
    const ry = -i * 3;
    const rr = (i - (n - 1) / 2) * 1.5;
    const T = (x, y, r) => `translate(${x}px, ${y}px) rotate(${r}deg)`;
    const card = h('div', { class: 'deckout__card', style: `transform:${T(0, ry, rr)};z-index:${i}` });
    deck.append(card);
    if (reduced()) continue;
    // one riffle: split, cross over (the halves change places at the midpoint), back into one pile
    const frames =
      ms <= 600
        ? [
            { transform: T(0, ry, rr), zIndex: i, offset: 0 },
            { transform: T(side * 78, ry - 10, side * 9), zIndex: i, offset: 0.5 },
            { transform: T(side * 78, ry - 10, side * 9), zIndex: n - i, offset: 0.5 },
            { transform: T(0, ry, rr), zIndex: n - i, offset: 1 },
          ]
        : [
            { transform: T(0, ry, rr), zIndex: i, offset: 0 },
            { transform: T(side * 78, ry - 10, side * 9), zIndex: i, offset: 0.25 },
            { transform: T(0, ry, rr), zIndex: n - i, offset: 0.5 },
            { transform: T(side * -54, ry - 6, side * -6), zIndex: n - i, offset: 0.75 },
            { transform: T(0, ry, rr), zIndex: i, offset: 1 },
          ];
    anims.push(play(card, frames, { duration: ms - (n - 1) * 30, delay: i * 30, easing: 'ease-in-out' }));
  }
  if (reduced()) {
    const fadeIn = play(box, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS });
    anims.push(fadeIn);
    setTimeout(() => {
      if (finished) return;
      const fadeOut = play(box, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS });
      anims.push(fadeOut);
      fadeOut.finished.then(end, () => {});
    }, FADE_MS + 150);
  } else {
    setTimeout(end, ms);
  }
  box.focus({ preventScroll: true });
}

for (const page of document.querySelectorAll('[data-demo="deckout"]')) {
  const fig = page.closest('figure');
  const clock = new Clock(fig.querySelector('[data-clock]'));
  const ms = Number(page.dataset.ms);
  const run = () => {
    page.innerHTML = '';
    page.append(studyHead('Plate tectonics', { new: 2, learning: 0, due: 3 }));
    const stage = h('div', { style: 'flex:1;display:flex;flex-direction:column' });
    page.append(stage);
    clock.wait('the deck is coming out');
    const t0 = performance.now();
    deckOut(stage, ms, async () => {
      stage.innerHTML = '';
      stage.append(
        h(
          'div',
          { class: 'desk' },
          h('div', { class: 'desk__edges' }),
          h('div', { class: 'scene' }, h('div', { class: 'fc' }, h('div', { class: 'fc__face fc__face--front' }, h('p', { class: 'fc__kicker', text: 'Term' }), h('p', { class: 'fc__front', text: 'Lithosphere' })))),
        ),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn--primary btn--wide', type: 'button', text: 'Show answer' })),
      );
      await nextPaint();
      clock.start(`first card on screen after ${Math.round(performance.now() - t0)} ms`);
    });
  };
  fig.querySelector('[data-replay]').addEventListener('click', run);
  page.append(studyHead('Plate tectonics', { new: 2, learning: 0, due: 3 }), h('p', { class: 'muted', text: 'Press "Start the deck" below.' }));
}

// ---- F2 F3 F4 a flashcard sitting -------------------------------------------------------------------------------
const DECK = [
  { id: 1, queue: 'new', kind: 'Term', front: 'Lithosphere', back: 'The rigid outer layer of the Earth, made of the crust and the upper mantle.', evidence: 'The lithosphere includes the crust and the uppermost part of the mantle.', buttons: ['1m', '6m', '10m', '4d'] },
  { id: 2, queue: 'due', kind: 'Question', front: 'What moves the tectonic plates?', back: 'Convection currents in the mantle carry the plates slowly over the asthenosphere.', evidence: 'Heat from the core drives convection currents in the mantle.', buttons: ['10m', '3d', '8d', '15d'] },
  { id: 3, queue: 'due', kind: 'Term', front: 'Subduction', back: 'One plate sinks beneath another at a convergent boundary.', evidence: 'The denser oceanic plate sinks beneath the continental plate.', buttons: ['10m', '2d', '6d', '12d'] },
  { id: 4, queue: 'new', kind: 'Question', front: 'Why do earthquakes cluster along plate boundaries?', back: 'Stress builds up where plates meet and is released suddenly when the rocks break and slip.', evidence: 'Most earthquakes happen where plates meet.', buttons: ['1m', '6m', '10m', '4d'] },
  { id: 5, queue: 'due', kind: 'Term', front: 'Asthenosphere', back: 'The soft, partly molten layer of the upper mantle on which the plates move.', evidence: 'The plates float on the asthenosphere.', buttons: ['10m', '3d', '7d', '14d'] },
];
const RATE = [
  ['Again', 'again'],
  ['Hard', 'hard'],
  ['Good', 'good'],
  ['Easy', 'easy'],
];
const comesBackToday = (ivl) => ivl.endsWith('m');

{
  const page = document.querySelector('[data-demo="sitting"]');
  const fig = page.closest('figure');
  const clock = new Clock(fig.querySelector('[data-clock]'));
  const opt = (name) => fig.querySelector(`[data-opt="${name}"]`).checked;
  let queue;
  let revealed;
  let pile;
  let undo;
  let studied;
  let flipAnim = null;
  let els = {};

  const counts = () => ({
    new: queue.filter((c) => c.queue === 'new').length,
    learning: queue.filter((c) => c.queue === 'learning').length,
    due: queue.filter((c) => c.queue === 'due').length,
  });

  function frontFace(card) {
    return h('div', { class: 'fc__face fc__face--front' }, h('p', { class: 'fc__kicker', text: card.kind }), h('p', { class: 'fc__front', text: card.front }), h('span', { class: 'fc__shade' }));
  }
  function backFace(card) {
    return h(
      'div',
      { class: 'fc__face fc__face--back' },
      h('p', { class: 'fc__asked', text: card.front }),
      h('p', { class: 'fc__back', text: card.back }),
      h('p', { class: 'fc__evidence' }, h('b', { text: 'From the lesson: ' }), `“${card.evidence}”`),
      h('span', { class: 'fc__shade' }),
    );
  }

  function pileEl() {
    const cards = h('div', { class: 'pile__cards' });
    for (let i = 0; i < Math.min(4, pile); i += 1) cards.append(h('span', { class: 'pile__card' }));
    const n = h('span', { class: 'mnote__n', text: String(pile) });
    // an empty pile is only a place for the first card to land
    return h('div', { class: 'pile', 'aria-label': `${pile} done today` }, cards, pile > 0 && h('span', { class: 'mnote' }, n, h('span', { class: 'mnote__label', text: 'done' })));
  }

  function render() {
    page.innerHTML = '';
    page.append(studyHead('Plate tectonics', counts()));
    const card = queue[0];
    if (!card) return renderDone();
    const fc = h('div', { class: `fc${reduced() ? ' fc--flat' : ''}` }, frontFace(card), backFace(card));
    const scene = h('div', { class: 'scene', onclick: reveal }, fc);
    const desk = h('div', { class: 'desk' }, h('div', { class: 'desk__edges' }), scene);
    if (opt('f4')) desk.append(pileEl());
    if (reduced()) fc.children[1].style.opacity = '0';
    const actions = h('div', { class: 'actions' });
    page.append(desk, actions);
    els = { desk, scene, fc, actions };
    renderActions();
  }

  function renderActions() {
    const { actions } = els;
    actions.innerHTML = '';
    const card = queue[0];
    if (revealed) {
      actions.append(
        h(
          'div',
          { class: 'rate', role: 'group', 'aria-label': 'How well did you remember it?' },
          RATE.map(([name, tone], i) =>
            h('button', { type: 'button', class: `rate__btn rate__btn--${tone}`, onclick: () => rate(i) }, h('span', { class: 'rate__name', text: name }), h('span', { class: 'rate__ivl', text: card.buttons[i] })),
          ),
        ),
      );
    } else {
      actions.append(h('button', { type: 'button', class: 'btn btn--primary btn--wide', text: 'Show answer', onclick: reveal }));
    }
    actions.append(h('button', { type: 'button', class: 'undo', text: '↶ Undo', disabled: !undo.length, onclick: doUndo }));
  }

  function reveal() {
    if (revealed || !queue[0]) return;
    if (clock.state === 'waiting') clock.start('first tap');
    revealed = true;
    const { fc } = els;
    const [front, backF] = fc.children;
    clock.pause('the card is turning over');
    if (reduced()) {
      flipAnim = play(backF, [{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      play(front, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 });
    } else if (opt('f2')) {
      flipAnim = play(
        fc,
        [
          { transform: 'translateY(0) rotateY(0deg)' },
          { transform: 'translateY(-4px) rotateY(90deg)', offset: 0.5 },
          { transform: 'translateY(0) rotateY(180deg)' },
        ],
        { duration: 420, easing: FLIP_EASE },
      );
      play(front.querySelector('.fc__shade'), [{ opacity: 0 }, { opacity: 0.16, offset: 0.5 }, { opacity: 0.16 }], { duration: 420, easing: FLIP_EASE });
      play(backF.querySelector('.fc__shade'), [{ opacity: 0.16 }, { opacity: 0.16, offset: 0.5 }, { opacity: 0 }], { duration: 420, easing: FLIP_EASE });
    } else {
      flipAnim = play(fc, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], { duration: 420, easing: FLIP_EASE });
    }
    const resume = () => clock.resume();
    flipAnim.finished.then(resume, resume);
    renderActions();
  }

  async function rate(i) {
    const card = queue.shift();
    const ivl = card.buttons[i]; // read before the next card replaces the buttons
    const dest = comesBackToday(ivl) ? 'deck' : 'pile';
    clock.stop(`${RATE[i][0]} (${ivl})`);
    flipAnim?.cancel();
    studied += 1;
    // back in the deck as a learning card: its next Good graduates it (1 day), so it ends on the pile
    if (dest === 'deck') queue.push({ ...card, queue: 'learning', buttons: ['1m', '6m', '1d', '4d'] });
    else pile += 1;
    undo.push({ card, dest });
    revealed = false;
    const rect = els.scene.getBoundingClientRect();
    render();
    if (queue[0]) clock.startAtPaint('next card on top from the first frame');
    if (reduced() || !queue[0]) return;
    ghostAway(dest, rect);
  }

  // The answered card leaves from behind the next one: into the deck (down, under the edges) or onto the pile.
  function ghostAway(dest, rect, reverse = false) {
    const { desk } = els;
    if (!desk) return;
    if (dest === 'deck' && !opt('f3')) return;
    if (dest === 'pile' && !opt('f4')) return;
    const ghost = h('div', { class: 'ghost', 'aria-hidden': 'true' }, h('span', { class: 'ghost__line' }), h('span', { class: 'ghost__line' }));
    ghost.style.height = `${rect.height}px`;
    desk.prepend(ghost);
    let frames;
    let duration;
    if (dest === 'deck') {
      frames = [
        { transform: 'translateY(0) scale(1)', opacity: 1 },
        { transform: 'translateY(30px) scale(0.96)', opacity: 0 },
      ];
      duration = 260;
    } else {
      const pileBox = desk.querySelector('.pile__cards').getBoundingClientRect();
      const deskBox = desk.getBoundingClientRect();
      const x = pileBox.left - deskBox.left;
      const y = pileBox.top - deskBox.top;
      frames = [
        { transform: 'translate(0, 0) scale(1, 1) rotate(0deg)' },
        { transform: `translate(${x}px, ${y}px) scale(${pileBox.width / rect.width}, ${pileBox.height / rect.height}) rotate(-3deg)` },
      ];
      duration = 300;
    }
    if (reverse) frames.reverse();
    const a = play(ghost, frames, { duration, easing: reverse ? OUT : dest === 'deck' ? IN_OUT : OUT });
    a.finished.then(() => {
      ghost.remove();
      if (dest === 'pile' && !reverse) {
        const n = desk.querySelector('.pile .mnote__n');
        if (n) play(n, [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 200, easing: OUT });
      }
    }, () => ghost.remove());
  }

  function renderDone() {
    const wrap = h('div', { class: 'desk', style: 'margin-top:4px' });
    if (opt('f4')) wrap.append(pileEl());
    const done = h(
      'div',
      { class: 'done' },
      h('h3', { class: 'done__title', text: 'Done for today' }),
      h('p', { class: 'done__text', text: 'The next card is due tomorrow.' }),
      h('p', { class: 'muted', text: `Cards studied: ${studied}` }),
      h('button', { type: 'button', class: 'btn btn--primary', text: 'Take the mock quiz' }),
    );
    wrap.append(done);
    page.append(wrap, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'undo', text: '↶ Undo', disabled: !undo.length, onclick: doUndo })));
    els = { desk: wrap };
    clock.idle('deck finished');
    if (reduced()) return;
    // the pile squares up, then the done card arrives
    const pileCards = [...wrap.querySelectorAll('.pile__card')];
    pileCards.forEach((c) => play(c, [{ transform: getComputedStyle(c).transform }, { transform: 'none' }], { duration: 200, easing: OUT }));
    play(done, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: opt('f4') ? 160 : 0, easing: OUT });
  }

  async function doUndo() {
    const last = undo.pop();
    if (!last) return;
    if (last.dest === 'deck') queue.pop();
    else pile -= 1;
    studied -= 1;
    const rect = els.scene?.getBoundingClientRect() ?? els.desk.getBoundingClientRect();
    queue.unshift(last.card);
    revealed = false;
    render();
    clock.startAtPaint('the card is back on top');
    if (!reduced()) ghostAway(last.dest, { height: rect.height, width: els.scene.getBoundingClientRect().width }, true);
  }

  async function start() {
    queue = DECK.map((c) => ({ ...c }));
    revealed = false;
    pile = 0;
    undo = [];
    studied = 0;
    clock.log = [];
    render();
    clock.startAtPaint('first card on screen');
  }
  fig.querySelector('[data-replay]').addEventListener('click', start);
  for (const box of fig.querySelectorAll('[data-opt]')) box.addEventListener('change', start);
  // the card's layout (3D or flat) depends on the motion setting: start the deck again when it changes
  document.querySelectorAll('input[name="motion"]').forEach((r) => r.addEventListener('change', start));
  start();
}

// ---- the quiz questions ------------------------------------------------------------------------------------------
const QUESTIONS = [
  { kicker: 'Which term matches this description?', text: 'The rigid outer layer of the Earth, made of the crust and the upper mantle.', choices: ['Asthenosphere', 'Lithosphere', 'Mantle plume', 'Outer core'], answer: 1, evidence: 'The lithosphere includes the crust and the uppermost part of the mantle.' },
  { kicker: 'Choose the best answer', text: 'What happens at a convergent boundary?', choices: ['Two plates move apart and new crust forms', 'One plate sinks beneath the other', 'Two plates slide past each other sideways', 'The mantle cools and the plates stop'], answer: 1, evidence: 'The denser oceanic plate sinks beneath the continental plate.' },
  { kicker: 'Choose the best answer', text: 'Why do earthquakes cluster along plate boundaries?', choices: ['The crust is thinnest in the middle of a plate', 'Stress builds where plates meet and is released when rocks slip', 'Volcanoes form only at the edges of oceans', 'The core is closest to the surface there'], answer: 1, evidence: 'Most earthquakes happen where plates meet.' },
];
const ICON = {
  check: 'M4 10.5 8.5 15 16 5.5',
  close: 'M5 5 15 15 M15 5 5 15',
};
const icon = (d, color) => svg('svg', { class: 'opt__icon', viewBox: '0 0 20 20', width: '20', height: '20', 'aria-hidden': 'true' }, svg('path', { d, fill: 'none', stroke: color, 'stroke-width': '2.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));

// One question on the sheet. `onAnswer(i)` is called once; `mark(feedback)` shows how it went.
function questionEl(q, onAnswer) {
  const opts = h('div', { class: 'opts', role: 'group' });
  q.choices.forEach((choice, i) => {
    opts.append(
      h(
        'button',
        { type: 'button', class: 'opt', onclick: () => onAnswer(i) },
        h('span', { class: 'opt__key', 'aria-hidden': 'true', text: String(i + 1) }),
        h('span', { class: 'opt__text' }, h('span', { text: choice })),
        h('span', { class: 'opt__mark', 'aria-hidden': 'true' }),
      ),
    );
  });
  return h('article', { class: 'sheet' }, h('p', { class: 'qkicker', text: q.kicker }), h('h3', { class: 'qtext', tabindex: '-1', text: q.text }), opts);
}

// Show the answer on the options. pen: draw the loop and the teacher's marks (after the answer is saved).
function markAnswer(article, q, chosen, { pen }) {
  const buttons = [...article.querySelectorAll('.opt')];
  buttons.forEach((b, i) => {
    b.disabled = true;
    b.classList.add(i === q.answer ? 'opt--right' : i === chosen ? 'opt--wrong' : 'opt--other');
  });
  const right = buttons[q.answer];
  const mine = buttons[chosen];
  const anims = [];
  if (!pen) {
    right.querySelector('.opt__mark').append(icon(ICON.check, 'var(--ok)'));
    if (chosen !== q.answer) mine.querySelector('.opt__mark').append(icon(ICON.close, 'var(--danger)'));
    return anims;
  }
  const still = reduced();
  // the student's loop round the number they chose
  const key = mine.querySelector('.opt__key');
  const loop = svg('path', { d: loopPath(40, 34) });
  key.append(svg('svg', { class: 'pen', viewBox: '0 0 40 34', 'aria-hidden': 'true' }, loop));
  anims.push(draw(loop, { duration: still ? 0 : 260 }));
  // the teacher's tick on the right answer
  const tickPath = svg('path', { d: 'M3.5 10.5 L8.5 15.5 L17 4' });
  right.querySelector('.opt__mark').append(svg('svg', { class: 'tick', viewBox: '0 0 20 20', 'aria-hidden': 'true' }, tickPath));
  anims.push(draw(tickPath, { duration: still ? 0 : 180, delay: 220 }));
  // and a line through a wrong choice
  if (chosen !== q.answer) {
    const strike = h('span', { class: 'strike', 'aria-hidden': 'true' });
    mine.querySelector('.opt__text').append(strike);
    anims.push(
      still
        ? play(strike, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS })
        : play(strike, [{ transform: 'rotate(-1.5deg) scaleX(0)' }, { transform: 'rotate(-1.5deg) scaleX(1)' }], { duration: 180, delay: 220, easing: OUT }),
    );
  }
  return anims;
}

function feedbackEl(q, chosen) {
  const ok = chosen === q.answer;
  return h(
    'div',
    { class: 'sheet', style: 'gap:8px' },
    h('p', { class: `verdict verdict--${ok ? 'right' : 'wrong'}`, text: ok ? 'Correct' : 'Not quite' }),
    !ok && h('p', { class: 'answer-line' }, 'The right answer: ', h('strong', { text: q.choices[q.answer] })),
    h('p', { class: 'fc__evidence' }, h('b', { text: 'From the lesson: ' }), `“${q.evidence}”`),
  );
}

// ---- Q0 today vs fixed -------------------------------------------------------------------------------------------
for (const page of document.querySelectorAll('[data-demo="q0"]')) {
  const fig = page.closest('figure');
  const clock = new Clock(fig.querySelector('[data-clock]'));
  const today = page.dataset.variant === 'today';
  let i;
  let body;

  function show(index) {
    i = index;
    const q = QUESTIONS[i % QUESTIONS.length];
    const counter = h('p', { class: 'qcounter', text: `Question ${(i % QUESTIONS.length) + 1} of ${QUESTIONS.length}` });
    const article = questionEl(q, (c) => answer(article, q, c));
    const wrap = h('div', { class: 'sheet' }, counter, article);
    body.replaceChildren(wrap);
    return wrap;
  }
  async function answer(article, q, chosen) {
    if (article.dataset.done) return;
    if (clock.state === 'waiting') clock.start('first tap');
    article.dataset.done = '1';
    clock.stop(`answered ${chosen + 1}`);
    markAnswer(article, q, chosen, { pen: false });
    article.after(feedbackEl(q, chosen));
    const next = h('button', { type: 'button', class: 'btn btn--primary btn--wide', text: 'Next question', onclick: () => goNext() });
    body.append(h('div', { class: 'actions' }, next));
  }
  async function goNext() {
    if (today) {
      // today's QuizRunScreen: the clock starts here, then AnimatePresence mode="wait" exits the old question and fades
      // the new one in from transparent
      const pressed = performance.now();
      clock.wait('');
      clock.start('started when Next was pressed');
      const old = body.firstElementChild;
      if (!reduced()) await play(old, [{ opacity: 1 }, { opacity: 0 }], { duration: 180 }).finished;
      const wrap = show(i + 1);
      if (!reduced()) await play(wrap, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 180 }).finished;
      clock.note(`question fully shown ${Math.round(performance.now() - pressed)} ms after the clock started: counted in time_ms`);
    } else {
      show(i + 1);
      clock.startAtPaint('question on screen at first paint');
    }
  }
  async function start() {
    clock.log = [];
    page.innerHTML = '';
    body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
    page.append(body);
    show(0);
    clock.startAtPaint('first question on screen');
  }
  fig.querySelector('[data-replay]').addEventListener('click', start);
  start();
}

// ---- Q1-Q4 a mock quiz on exam paper -----------------------------------------------------------------------------
{
  const page = document.querySelector('[data-demo="quiz"]');
  const fig = page.closest('figure');
  const clock = new Clock(fig.querySelector('[data-clock]'));
  const opt = (name) => fig.querySelector(`[data-opt="${name}"]`).checked;
  let i;
  let score;
  let marks = [];
  let sheet;
  let progress;
  let startedAt;
  let loadTimer;

  const head = () => h('div', { class: 'head' }, back(), h('p', { class: 'head__title', text: 'Plate tectonics' }), h('p', { class: 'qcounter', 'data-counter': '' }));

  function progressEl() {
    if (opt('q3')) {
      return h(
        'div',
        { class: 'bubbles', role: 'progressbar', 'aria-label': 'Quiz progress', 'aria-valuemin': '0', 'aria-valuemax': String(QUESTIONS.length), 'aria-valuenow': '0' },
        QUESTIONS.map(() => h('span', { class: 'bubble' }, h('i'))),
      );
    }
    return h('div', { class: 'track', role: 'progressbar', 'aria-label': 'Quiz progress' }, h('span', { class: 'track__fill' }));
  }
  function setProgress(answered) {
    if (opt('q3')) {
      [...progress.children].forEach((b, k) => {
        b.classList.toggle('is-now', k === i && answered === i);
        if (k < answered && !b.classList.contains('is-done')) {
          b.classList.add('is-done');
          if (!reduced()) play(b.firstChild, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 150, easing: OUT });
        }
      });
      progress.setAttribute('aria-valuenow', String(answered));
    } else {
      progress.firstChild.style.transform = `scaleX(${answered / QUESTIONS.length})`;
    }
  }

  function intro() {
    clearTimeout(loadTimer);
    clock.idle('nothing on screen yet');
    clock.log = [];
    clock.paint();
    page.innerHTML = '';
    page.append(
      h('div', { class: 'head' }, back(), h('p', { class: 'head__title', text: 'Mock quiz' })),
      h('p', { class: 'muted', text: 'Plate tectonics · 3 questions · not taken yet' }),
      h('button', { type: 'button', class: 'btn btn--primary', text: 'Start', onclick: load }),
    );
  }

  function load() {
    page.innerHTML = '';
    page.append(h('div', { class: 'head' }, back(), h('p', { class: 'head__title', text: 'Plate tectonics' })), loadingRules('Getting your quiz ready…'));
    loadTimer = setTimeout(handOut, 1100);
  }

  // Q1: the sheet arrives; the clocks start when it's in place, skipped, or touched
  function handOut() {
    stopLoops(page);
    page.innerHTML = '';
    i = 0;
    score = 0;
    progress = progressEl();
    sheet = h('div', { class: 'sheet', style: 'flex:1;gap:14px' });
    const paper = h('div', { style: 'display:flex;flex-direction:column;gap:14px;flex:1' }, head(), progress, sheet);
    page.append(paper);
    showQuestion(false);
    const ready = () => {
      startedAt = performance.now();
      clock.start('the sheet is in place');
    };
    clock.wait('the sheet is being handed out');
    if (!opt('q1')) {
      nextPaint().then(ready);
      return;
    }
    const a = reduced()
      ? play(paper, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS })
      : play(paper, [{ opacity: 0, transform: 'translateY(32px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: OUT });
    const skip = () => a.finish();
    paper.addEventListener('pointerdown', skip, { once: true });
    a.finished.then(() => {
      paper.removeEventListener('pointerdown', skip);
      ready();
    });
  }

  function showQuestion(startClock = true) {
    for (const m of marks) m.cancel?.();
    marks = [];
    const q = QUESTIONS[i];
    page.querySelector('[data-counter]').textContent = `Question ${i + 1} of ${QUESTIONS.length}`;
    const article = questionEl(q, (c) => answer(article, q, c));
    sheet.replaceChildren(article);
    setProgress(i);
    page.scrollTop = 0;
    if (startClock) clock.startAtPaint('question on screen at first paint');
  }

  async function answer(article, q, chosen) {
    if (article.dataset.done) return;
    // a tap during the hand-out ends it: the first input counts as "usable"
    if (clock.state === 'waiting') clock.start('first tap');
    article.dataset.done = '1';
    clock.stop(`answer ${chosen + 1} saved`);
    await new Promise((r) => setTimeout(r, 120)); // the request to the server
    if (chosen === q.answer) score += 1;
    setProgress(i + 1);
    marks = markAnswer(article, q, chosen, { pen: opt('q2') });
    article.after(feedbackEl(q, chosen));
    const last = i === QUESTIONS.length - 1;
    sheet.append(h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn--primary btn--wide', text: last ? 'See results' : 'Next question', onclick: () => (last ? results() : (i += 1, showQuestion())) })));
  }

  function results() {
    for (const m of marks) m.cancel?.();
    const total = QUESTIONS.length;
    const secs = Math.round((performance.now() - (startedAt ?? performance.now())) / 1000);
    clock.idle('quiz finished');
    page.innerHTML = '';
    const grade = h('span', { class: 'grade', 'aria-label': `${score} of ${total} right` }, `${score}/${total}`);
    page.append(
      h('div', { class: 'head' }, back(), h('p', { class: 'head__title', text: 'Plate tectonics' }), h('p', { class: 'qcounter', text: 'Results' })),
      h(
        'div',
        { class: 'results' },
        grade,
        h('p', { class: 'results__line', text: `${Math.round((score / total) * 100)}% · ${secs} s` }),
        h('p', { class: 'muted', text: 'Your first score on this lesson.' }),
        h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' }, h('button', { type: 'button', class: 'btn btn--primary', text: 'Retake', onclick: load }), h('button', { type: 'button', class: 'btn btn--quiet', text: 'Back to lesson' })),
      ),
    );
    if (!opt('q4')) return;
    nextPaint().then(() => {
      const w = grade.offsetWidth + 20;
      const hh = grade.offsetHeight + 14;
      const ring = svg('path', { d: loopPath(w, hh, { turns: 1.08, tilt: -0.05, start: -0.7 }) });
      grade.append(svg('svg', { class: 'grade__ring', viewBox: `0 0 ${w} ${hh}`, 'aria-hidden': 'true' }, ring));
      const a = draw(ring, { duration: reduced() ? 0 : 500, delay: 120 });
      grade.addEventListener('pointerdown', () => a.finish(), { once: true });
    });
  }

  fig.querySelector('[data-replay]').addEventListener('click', intro);
  for (const box of fig.querySelectorAll('[data-opt]')) box.addEventListener('change', intro);
  intro();
}

// ---- S2 ruled lines being written on ----------------------------------------------------------------------------
const LINES = 5;
const STEP = 420;
const DRAW = 520;
const CLEAR = 400;
const CYCLE = (LINES - 1) * STEP + DRAW + 600 + CLEAR;
function loadingRules(label) {
  const lines = h('div', { class: 'rules', 'aria-hidden': 'true' });
  const box = h('div', { class: 'loading', role: 'status' }, h('p', { class: 'loading__label', text: label }), lines);
  const inks = [];
  for (let k = 0; k < LINES; k += 1) {
    const ink = h('span', { class: 'rules__ink' });
    inks.push(ink);
    lines.append(h('span', { class: 'rules__line' }, ink));
  }
  if (!reduced()) {
    box._loops = inks.map((ink, k) => {
      const s = (k * STEP) / CYCLE;
      const e = (k * STEP + DRAW) / CYCLE;
      const f = (CYCLE - CLEAR) / CYCLE;
      return ink.animate(
        [
          { transform: 'scaleX(0)', opacity: 1, offset: 0 },
          { transform: 'scaleX(0)', opacity: 1, offset: s },
          { transform: 'scaleX(1)', opacity: 1, offset: e, easing: 'ease-in' },
          { transform: 'scaleX(1)', opacity: 1, offset: f },
          { transform: 'scaleX(1)', opacity: 0, offset: 1 },
        ],
        { duration: CYCLE, iterations: Infinity, easing: 'linear' },
      );
    });
    // stops while it's off screen
    const io = new IntersectionObserver(([entry]) => {
      for (const a of box._loops) entry.isIntersecting ? a.play() : a.pause();
    });
    io.observe(box);
    box._io = io;
  }
  return box;
}
function stopLoops(scope) {
  for (const box of scope.querySelectorAll('.loading')) {
    for (const a of box._loops ?? []) a.cancel();
    box._io?.disconnect();
  }
}
for (const page of document.querySelectorAll('[data-demo="loading"]')) {
  const build = () => {
    stopLoops(page);
    page.innerHTML = '';
    page.append(h('p', { class: 'section-h', text: 'Explain simpler' }));
    if (page.dataset.variant === 'shimmer') {
      page.append(h('div', { class: 'loading', role: 'status' }, h('p', { class: 'loading__label', text: 'Writing a simpler version…' }), h('div', { class: 'shimmer', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'), h('span'))));
    } else {
      page.append(loadingRules('Writing a simpler version…'));
    }
  };
  build();
  document.querySelectorAll('input[name="motion"]').forEach((r) => r.addEventListener('change', build));
}

// ---- R1 key terms marked as they come into view ------------------------------------------------------------------
const TERMS = [
  ['Lithosphere', 'The rigid outer layer of the Earth, made of the crust and the upper mantle.'],
  ['Asthenosphere', 'The soft, partly molten layer of the upper mantle on which the plates move.'],
  ['Convection current', 'A loop of rising hot material and sinking cooler material in the mantle.'],
  ['Convergent boundary', 'Where two plates move toward each other.'],
  ['Divergent boundary', 'Where two plates move apart and new crust forms.'],
  ['Transform boundary', 'Where two plates slide past each other sideways.'],
  ['Subduction', 'One plate sinks beneath another at a convergent boundary.'],
  ['Seafloor spreading', 'New ocean floor forms at a mid-ocean ridge and moves away from it.'],
];
{
  const page = document.querySelector('[data-demo="terms"]');
  const fig = page.closest('figure');
  let io;
  const build = () => {
    io?.disconnect();
    page.innerHTML = '';
    page.scrollTop = 0;
    const list = h('dl', { class: 'terms' });
    for (const [term, def] of TERMS) {
      const mk = h('span', { class: 'tmk' }, h('span', { text: term }), h('span', { class: 'tmk__clip', 'aria-hidden': 'true' }, h('span', { class: 'tmk__fill' }, h('span', { text: term }))));
      list.append(h('div', { class: 'term' }, h('dt', { class: 'term__name' }, mk), h('dd', { class: 'term__def', text: def })));
    }
    page.append(h('h3', { class: 'section-h', text: 'Key terms' }), h('p', { class: 'muted', text: 'Scroll down: each term is marked once, as it comes into view.' }), list);
    if (reduced()) {
      for (const mk of page.querySelectorAll('.tmk')) mk.classList.add('is-in');
      return;
    }
    let batch = 0;
    let batchTimer;
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const mk = entry.target;
          io.unobserve(mk);
          const fill = mk.querySelector('.tmk__fill');
          const delay = Math.min(batch, 4) * 70; // a few at once share a short stagger, never more than 280 ms
          batch += 1;
          clearTimeout(batchTimer);
          batchTimer = setTimeout(() => (batch = 0), 120);
          // a term on two lines is marked without the slide
          if (mk.getClientRects().length > 1 || mk.offsetHeight > 40) {
            mk.classList.add('is-in');
            continue;
          }
          const a = play(fill, [{ transform: 'translateX(-101%)' }, { transform: 'translateX(0)' }], { duration: 380, delay, easing: OUT });
          play(fill.firstChild, [{ transform: 'translateX(101%)' }, { transform: 'translateX(0)' }], { duration: 380, delay, easing: OUT });
          a.finished.then(() => mk.classList.add('is-in'));
        }
      },
      { root: page, threshold: 1 },
    );
    for (const mk of page.querySelectorAll('.tmk')) io.observe(mk);
  };
  fig.querySelector('[data-replay]').addEventListener('click', build);
  document.querySelectorAll('input[name="motion"]').forEach((r) => r.addEventListener('change', build));
  build();
}

// ---- R2 quick check -----------------------------------------------------------------------------------------------
const CHECK = {
  q: 'Why does the oceanic plate sink at a convergent boundary?',
  a: 'It is denser than the continental plate, so it sinks beneath it into the mantle.',
};
for (const page of document.querySelectorAll('[data-demo="check"]')) {
  const fig = page.closest('figure');
  const cover = page.dataset.variant === 'cover';
  const rateRow = () =>
    h('div', { class: 'check__rate', role: 'group', 'aria-label': 'How did you do?' }, h('span', { text: 'How did your answer compare?' }), h('button', { type: 'button', class: 'btn btn--small btn--ok', text: 'I got it' }), h('button', { type: 'button', class: 'btn btn--small btn--quiet', text: 'Not quite' }));
  const answerCard = () => h('div', { class: 'check__answer' }, h('p', { class: 'check__answer-label', text: 'Answer' }), h('p', { text: CHECK.a }));
  const build = () => {
    page.innerHTML = '';
    const box = h('div', { class: 'check' }, h('h3', { class: 'check__title', text: 'Quick check' }), h('p', { class: 'check__q', text: CHECK.q }), h('textarea', { rows: '2', placeholder: 'Type your answer…', 'aria-label': 'Your answer' }));
    page.append(h('p', { class: 'muted', text: '…the end of section 3 of 8.' }), box);
    if (!cover) {
      // today: a Show answer button; the answer grows open (height 0 → auto)
      const btn = h('button', {
        type: 'button',
        class: 'btn btn--quiet',
        text: 'Show answer',
        onclick: () => {
          btn.remove();
          const reveal = h('div', { style: 'width:100%;overflow:hidden' }, answerCard(), h('div', { style: 'margin-top:12px' }, rateRow()));
          box.append(reveal);
          if (reduced()) return;
          const full = reveal.offsetHeight;
          play(reveal, [{ height: '0px', opacity: 0 }, { height: `${full}px`, opacity: 1 }], { duration: 220 }).finished.then(() => (reveal.style.height = ''));
        },
      });
      box.append(btn, h('p', { class: 'muted', text: 'Below the quick check: the Previous / Next bar.' }));
      return;
    }
    // proposed: the answer lies under an index card, holding its space; lift the card to see it
    const answer = answerCard();
    answer.inert = true;
    answer.setAttribute('aria-hidden', 'true');
    const slot = h('div', { class: 'check__slot' }, answer);
    const lid = h('button', {
      type: 'button',
      class: 'cover',
      text: 'Show answer',
      onclick: () => {
        lid.disabled = true;
        answer.inert = false;
        answer.removeAttribute('aria-hidden');
        const row = rateRow();
        slot.after(row);
        const a = reduced()
          ? play(lid, [{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS })
          : play(lid, [{ transform: 'translateX(0) rotate(0deg)', opacity: 1 }, { transform: 'translateX(30%) rotate(2deg)', opacity: 1, offset: 0.55 }, { transform: 'translateX(70%) rotate(5deg)', opacity: 0 }], { duration: 280, easing: IN_OUT });
        play(row, [{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, delay: reduced() ? 0 : 120 });
        a.finished.then(() => lid.remove());
      },
    });
    slot.append(lid);
    box.append(slot, h('p', { class: 'muted', text: 'Below the quick check: the Previous / Next bar.' }));
  };
  fig.querySelector('[data-replay]').addEventListener('click', build);
  build();
}

// ---- S1 the week, inked in ---------------------------------------------------------------------------------------
const WEEK = [
  ['Mon', 25, 18, 0],
  ['Tue', 20, 30, 12],
  ['Wed', 0, 0, 0],
  ['Thu', 15, 22, 0],
  ['Fri', 10, 14, 9],
  ['Sat', 0, 8, 0],
  ['Sun', 6, 0, 0],
];
{
  const page = document.querySelector('[data-demo="week"]');
  const fig = page.closest('figure');
  const time = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
  const build = () => {
    page.innerHTML = '';
    const totals = WEEK.reduce((t, [, r, f, q]) => [t[0] + r, t[1] + f, t[2] + q], [0, 0, 0]);
    const most = Math.max(...WEEK.map(([, r, f, q]) => r + f + q));
    const rows = WEEK.map(([day, r, f, q]) => {
      const sum = r + f + q;
      const bar = h(
        'span',
        { class: 'days__bar', 'aria-hidden': 'true' },
        r > 0 ? h('i', { style: `width:${(r / most) * 100}%;background-color:var(--series-reading)` }) : null,
        f > 0 ? h('i', { style: `width:${(f / most) * 100}%;background-color:var(--series-flashcards)` }) : null,
        q > 0 ? h('i', { 'data-activity': 'quiz', style: `width:${(q / most) * 100}%;background-color:var(--series-quiz)` }) : null,
      );
      return h('li', { class: `days__row${sum === most ? ' days__row--peak' : ''}` }, h('span', { class: 'days__day', text: day }), bar, h('span', { class: 'days__time' }, sum ? time(sum) : h('span', { class: 'muted', text: '–' })));
    });
    page.append(
      h('p', { class: 'stats-lede' }, 'You studied ', h('strong', { class: 'mk', text: time(totals[0] + totals[1] + totals[2]) }), ' this week.'),
      h(
        'p',
        { class: 'legend' },
        h('span', {}, h('i', { class: 'swatch', style: 'background-color:var(--series-reading)' }), 'Reading ', h('b', { text: time(totals[0]) })),
        h('span', {}, h('i', { class: 'swatch', style: 'background-color:var(--series-flashcards)' }), 'Flashcards ', h('b', { text: time(totals[1]) })),
        h('span', {}, h('i', { class: 'swatch swatch--quiz', style: 'background-color:var(--series-quiz)' }), 'Quiz ', h('b', { text: time(totals[2]) })),
      ),
      h('ul', { class: 'days', 'aria-label': 'Study time per day' }, rows),
      h('p', { class: 'muted', text: 'Most active day: Tuesday (1 h 2 min).' }),
    );
    if (reduced()) return;
    [...page.querySelectorAll('.days__bar')].forEach((bar, k) => {
      const a = play(bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 300, delay: k * 40, easing: OUT });
      page.addEventListener('pointerdown', () => a.finish(), { once: true });
    });
  };
  fig.querySelector('[data-replay]').addEventListener('click', build);
  // plays once when Stats "opens" (the frame comes into view)
  const io = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      build();
      io.disconnect();
    }
  }, { threshold: 0.5 });
  io.observe(page);
}
