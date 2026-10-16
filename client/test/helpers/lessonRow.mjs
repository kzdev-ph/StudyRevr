// The real LessonRow in jsdom (helpers/env.mjs), as a student, as admin, and with its delete option going away while
// its confirm is open. Prints what it found as JSON; test/lessonRow.test.js runs it and checks.
import { settle } from './env.mjs';

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { default: LessonRow } = await import('../../src/components/LessonRow.jsx');

const base = { id: 7, title: 'plants', word_count: 120, created_at: '2026-10-05T04:00:00.000Z', status: 'ready', origin: 'student', shared: false, mine: true, can_delete: true, can_retry: false, error: null };
const host = document.getElementById('root');
const root = createRoot(host);
const render = async (props) => {
  await act(async () => root.render(React.createElement('ul', null, React.createElement(LessonRow, props))));
  await settle(act);
};
const click = async (el) => {
  await act(async () => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await settle(act);
};
const text = () => host.textContent;
const button = (label) => [...host.querySelectorAll('button')].find((b) => b.textContent.includes(label) || b.getAttribute('aria-label')?.includes(label));

const out = {};

// a student's own, unstudied upload
const noop = async () => {};
await render({ lesson: base, onDeleteOwn: noop, onRetry: noop });
out.studentHasDelete = Boolean(button('Delete plants'));
out.studentLink = host.querySelector('a').getAttribute('href');
await click(button('Delete plants'));
out.studentConfirmOpen = text().includes('Delete plants?') || text().includes('Delete plants');
out.studentConfirmButtonClass = button('Delete lesson')?.className;
// the lesson was studied meanwhile: the server stops offering the delete, the confirm closes by itself
await render({ lesson: { ...base, can_delete: false }, onDeleteOwn: noop, onRetry: noop });
out.confirmClosedWhenGone = !button('Delete lesson') && !button('Keep it');

// a student's upload that is shared: no delete at all
await render({ lesson: { ...base, shared: true, can_delete: false }, onDeleteOwn: noop });
out.sharedHasDelete = Boolean(button('Delete plants'));

// admin
const admin = { ...base, mine: false, can_delete: undefined, owner_code: 'P07' };
await render({ lesson: admin, admin: true, onDelete: noop, onShare: noop });
out.adminLink = host.querySelector('a').getAttribute('href');
out.adminNote = host.querySelector('.lesson__meta').textContent;
await click(button('Delete plants'));
out.adminConfirmButtonClass = button('Delete lesson')?.className;
await click(button('Keep it'));

// admin: a failed lesson has a Retry, with the error
await render({ lesson: { ...admin, status: 'failed', error: 'The real reason' }, admin: true, onDelete: noop, onRetry: noop });
out.adminFailedText = text().includes('The real reason');
out.adminRetry = Boolean(button('Retry'));
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
