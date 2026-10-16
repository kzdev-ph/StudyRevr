import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMotion, getMotionChoice, resolveReduced, setMotionChoice, motionReduced } from '../src/lib/motion.js';

// lib/motion.js reads window.localStorage and window.matchMedia only when called; these are the small fakes it needs.
const store = (blocked = false) => {
  const data = new Map();
  return {
    getItem: (k) => {
      if (blocked) throw new Error('blocked');
      return data.has(k) ? data.get(k) : null;
    },
    setItem: (k, v) => {
      if (blocked) throw new Error('blocked');
      data.set(k, String(v));
    },
    removeItem: (k) => {
      if (blocked) throw new Error('blocked');
      data.delete(k);
    },
  };
};
const root = () => {
  const r = { dataset: {} };
  return r;
};
const setup = ({ device = false, blocked = false } = {}) => {
  globalThis.window = { localStorage: store(blocked), matchMedia: () => ({ matches: device, addEventListener() {}, removeEventListener() {} }) };
  globalThis.document = { documentElement: root() };
  return globalThis.document.documentElement;
};

describe('resolveReduced: Motion choice x device setting', () => {
  const cases = [
    ['system', false, false],
    ['system', true, true],
    ['less', false, true],
    ['less', true, true],
    ['full', false, false],
    ['full', true, false],
  ];
  for (const [choice, device, expected] of cases) {
    it(`${choice}, device ${device ? 'asks for less motion' : 'does not'} -> ${expected ? 'reduced' : 'full'}`, () => {
      assert.equal(resolveReduced(choice, device), expected);
    });
  }
});

describe('the choice is kept like the theme', () => {
  it('defaults to Match my device, stores less / full, and system removes the key', () => {
    setup();
    assert.equal(getMotionChoice(), 'system');
    setMotionChoice('less');
    assert.equal(getMotionChoice(), 'less');
    assert.equal(window.localStorage.getItem('studyrevr-motion'), 'less');
    setMotionChoice('full');
    assert.equal(window.localStorage.getItem('studyrevr-motion'), 'full');
    setMotionChoice('system');
    assert.equal(window.localStorage.getItem('studyrevr-motion'), null);
    assert.equal(getMotionChoice(), 'system');
  });

  it('an unknown stored value is Match my device', () => {
    setup();
    window.localStorage.setItem('studyrevr-motion', 'reduce');
    assert.equal(getMotionChoice(), 'system');
  });

  it('blocked storage still applies the choice for this visit', () => {
    const r = setup({ blocked: true });
    assert.equal(getMotionChoice(), 'system');
    setMotionChoice('less');
    assert.equal(r.dataset.motion, 'less');
    assert.equal(motionReduced(), true);
  });

  it('motionReduced follows the choice and, for Match, the device', () => {
    setup({ device: true });
    setMotionChoice('system');
    assert.equal(motionReduced(), true);
    setMotionChoice('full');
    assert.equal(motionReduced(), false);
    setMotionChoice('less');
    assert.equal(motionReduced(), true);
    setup({ device: false });
    setMotionChoice('system');
    assert.equal(motionReduced(), false);
    setMotionChoice('less');
    assert.equal(motionReduced(), true);
  });
});

describe('data-motion on <html> (the attribute the CSS reads)', () => {
  it('less and full set it; Match my device removes it', () => {
    const r = root();
    applyMotion('less', r);
    assert.equal(r.dataset.motion, 'less');
    applyMotion('full', r);
    assert.equal(r.dataset.motion, 'full');
    applyMotion('system', r);
    assert.equal('motion' in r.dataset, false);
  });

  it('setMotionChoice writes it on the page root', () => {
    const r = setup();
    setMotionChoice('full');
    assert.equal(r.dataset.motion, 'full');
    setMotionChoice('system');
    assert.equal('motion' in r.dataset, false);
  });
});

describe('the CSS follows the setting', () => {
  const css = (name) => readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  for (const [file, probe] of [
    ['base.css', '*'],
    ['base.css', '.spinner'],
    ['review.css', '.rules__ink'],
  ]) {
    it(`${file}: ${probe} is reduced for the device (unless Full motion) and for Less motion`, () => {
      const s = css(file);
      assert.ok(s.includes(`:root:not([data-motion='full']) ${probe}`), 'device rule, off when Full is chosen');
      assert.ok(s.includes(`:root[data-motion='less'] ${probe}`), 'Less motion rule');
    });
  }

  it('every prefers-reduced-motion rule is guarded by :not([data-motion=full])', () => {
    for (const file of ['base.css', 'review.css', 'flashcards.css', 'quiz.css', 'stats.css', 'shell.css', 'library.css', 'participants.css', 'admin.css']) {
      const s = css(file);
      let at = s.indexOf('@media (prefers-reduced-motion');
      while (at !== -1) {
        const end = s.indexOf('\n}\n', at);
        const block = s.slice(at, end);
        const selectors = block.split('\n').slice(1).filter((l) => /^ {2}\S/.test(l) && l.trim() !== '}'); // the selector lines, two spaces in
        assert.ok(selectors.length > 0, file);
        assert.ok(selectors.every((l) => l.startsWith("  :root:not([data-motion='full']) ")), `${file}: ${selectors.join(' / ')}`);
        at = s.indexOf('@media (prefers-reduced-motion', end);
      }
    }
  });
});
