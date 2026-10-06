import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sectionVersionsNotice } from '../src/lib/sectionVersions.js';

const lesson = (section_versions, status = 'ready') => ({ status, section_versions });

describe('sectionVersionsNotice (admin lesson row, "Prepare")', () => {
  it('offers Prepare while versions are missing, with how many are ready', () => {
    const n = sectionVersionsNotice(lesson({ missing: 6, total: 8, status: null, error: null }));
    assert.deepEqual([n.state, n.title, n.action], ['missing', 'Simpler and Taglish: 2 of 8 ready.', 'Prepare simpler and Taglish']);
  });
  it('shows progress while it runs, with no button', () => {
    const n = sectionVersionsNotice(lesson({ missing: 6, total: 8, status: 'running', error: null, progress: { done: 3, total: 6 } }));
    assert.deepEqual([n.state, n.detail, n.action], ['making', '3 of 6 made.', null]);
  });
  it('reports a failure with the reason and offers the rest', () => {
    const n = sectionVersionsNotice(lesson({ missing: 1, total: 8, status: 'failed', error: '1 version couldn’t be made.' }));
    assert.deepEqual([n.state, n.detail, n.action], ['failed', '1 version couldn’t be made.', 'Prepare the rest']);
  });
  it('says all are ready when nothing is missing, even after an earlier failure', () => {
    const n = sectionVersionsNotice(lesson({ missing: 0, total: 8, status: 'failed', error: 'old' }));
    assert.deepEqual([n.state, n.action], ['ready', null]);
  });
  it('says nothing for a lesson that is not ready or has no sections', () => {
    assert.equal(sectionVersionsNotice(lesson({ missing: 8, total: 8 }, 'processing')), null);
    assert.equal(sectionVersionsNotice(lesson({ missing: 0, total: 0 })), null);
  });
});
