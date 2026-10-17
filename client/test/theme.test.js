import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme, getThemeChoice, setThemeChoice, THEME_CHOICES } from '../src/lib/theme.js';

// lib/theme.js reads window.localStorage and touches document.documentElement / document.head only when called.
const store = (blocked = false) => {
  const data = new Map();
  return {
    data,
    getItem: (k) => {
      if (blocked) throw new Error('blocked');
      return data.has(k) ? data.get(k) : null;
    },
    setItem: (k, v) => {
      if (blocked) throw new Error('blocked');
      data.set(k, String(v));
    },
  };
};
const fakeHead = () => {
  const tags = [];
  return {
    tags,
    querySelector: (sel) => (sel.includes('data-theme-override') ? tags.find((t) => t.name === 'theme-color') ?? null : null),
    prepend: (tag) => tags.unshift(tag),
  };
};
const setup = ({ blocked = false, saved } = {}) => {
  const localStorage = store(blocked);
  if (saved !== undefined) localStorage.data.set('studyrevr-theme', saved);
  const head = fakeHead();
  globalThis.window = { localStorage };
  globalThis.document = {
    documentElement: { dataset: {} },
    head,
    createElement: () => {
      const tag = { name: '', content: '', dataset: {} };
      tag.remove = () => head.tags.splice(head.tags.indexOf(tag), 1);
      return tag;
    },
  };
  return { localStorage, head, root: document.documentElement };
};

describe('theme choice', () => {
  it('offers Match my device, Light, Dark, AMA and AMA Dark', () => {
    assert.deepEqual(THEME_CHOICES, ['system', 'light', 'dark', 'ama', 'ama-dark']);
  });

  it('is AMA on a device with no saved choice, and when storage is blocked or holds something unknown', () => {
    setup();
    assert.equal(getThemeChoice(), 'ama');
    setup({ blocked: true });
    assert.equal(getThemeChoice(), 'ama');
    setup({ saved: 'sepia' });
    assert.equal(getThemeChoice(), 'ama');
  });

  it('applyTheme() at startup sets data-theme="ama" for a new device', () => {
    const { root } = setup();
    applyTheme();
    assert.equal(root.dataset.theme, 'ama');
  });

  it('keeps each saved choice and sets data-theme to it', () => {
    for (const choice of ['light', 'dark', 'ama', 'ama-dark']) {
      const { root } = setup({ saved: choice });
      assert.equal(getThemeChoice(), choice);
      applyTheme();
      assert.equal(root.dataset.theme, choice);
    }
  });

  it('Match my device is stored as `system` (so it differs from never chose) and removes data-theme', () => {
    const { localStorage, root } = setup({ saved: 'dark' });
    applyTheme();
    assert.equal(root.dataset.theme, 'dark');
    setThemeChoice('system');
    assert.equal(localStorage.data.get('studyrevr-theme'), 'system');
    assert.equal(root.dataset.theme, undefined);
    assert.equal(getThemeChoice(), 'system'); // a reload keeps Match my device, it does not fall back to AMA
  });

  it('stores every other choice too, and still applies it when storage is blocked', () => {
    const { localStorage, root } = setup();
    setThemeChoice('ama-dark');
    assert.equal(localStorage.data.get('studyrevr-theme'), 'ama-dark');
    assert.equal(root.dataset.theme, 'ama-dark');
    const blocked = setup({ blocked: true });
    setThemeChoice('light');
    assert.equal(blocked.root.dataset.theme, 'light');
  });
});

describe('status-bar colour', () => {
  const override = (head) => head.tags.filter((t) => t.name === 'theme-color');

  it('AMA and AMA Dark add one theme-color tag in front of the media-based ones, with their paper colour', () => {
    const { head } = setup();
    applyTheme('ama');
    assert.equal(override(head).length, 1);
    assert.equal(override(head)[0].content, '#f7f3e8');
    applyTheme('ama-dark');
    assert.equal(override(head).length, 1);
    assert.equal(override(head)[0].content, '#1b1a18');
  });

  it('Match my device, Light and Dark leave the media-based tags alone (no override)', () => {
    const { head } = setup();
    applyTheme('ama');
    for (const choice of ['system', 'light', 'dark']) {
      applyTheme(choice);
      assert.equal(override(head).length, 0, choice);
    }
  });
});
