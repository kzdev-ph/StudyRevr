import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The real LessonRow component, rendered. (An effect that read a value declared further down made the whole library
// screen throw "Cannot access before initialization" in the built app while every pure-function test passed.)
const clientDir = fileURLToPath(new URL('..', import.meta.url));

const run = () => {
  const result = spawnSync(process.execPath, ['--import', './test/helpers/register.mjs', 'test/helpers/lessonRow.mjs'], { cwd: clientDir, encoding: 'utf8', timeout: 60_000 });
  const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${result.status}):\n${result.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
};

describe('LessonRow', () => {
  const r = run();

  it("renders, and a student's own unstudied upload can be deleted with an ink (not red) confirm", () => {
    assert.equal(r.studentHasDelete, true);
    assert.equal(r.studentConfirmOpen, true);
    assert.equal(r.studentConfirmButtonClass, 'btn btn--primary');
    assert.equal(r.studentLink, '#/review/7');
  });

  it('closes an open delete confirm when the server stops offering the delete', () => {
    assert.equal(r.confirmClosedWhenGone, true);
    assert.equal(r.sharedHasDelete, false);
  });

  it("admin's row opens the read-only preview, says whose it is, and asks with the red button", () => {
    assert.equal(r.adminLink, '#/admin/lessons/7');
    assert.match(r.adminNote, /Uploaded by P07/);
    assert.equal(r.adminConfirmButtonClass, 'btn btn--danger');
  });

  it("admin's list is where a failed lesson shows its real error and is retried", () => {
    assert.equal(r.adminFailedText, true);
    assert.equal(r.adminRetry, true);
  });
});
