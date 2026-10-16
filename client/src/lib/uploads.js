// Student uploads: what the library says about them. Pure text helpers, so the wording is tested
// (client/test/uploads.test.js).

// The server runs these in this order, one after the other (the processing page and the library use the same words).
export const STAGES = [
  { id: 'sections', doing: 'Writing the review sections', done: 'Review sections written' },
  { id: 'key_points', doing: 'Picking the key points', done: 'Key points picked' },
  { id: 'key_terms', doing: 'Finding the key terms', done: 'Key terms found' },
  { id: 'flashcards', doing: 'Making the flashcards', done: 'Flashcards made' },
  { id: 'quiz_options', doing: 'Preparing the quiz answers', done: 'Quiz answers ready' },
];

// Under the upload button: how many uploads the student has left today. `status` is GET /api/my-uploads.
export function uploadsLeftText(status) {
  if (!status?.allowed) return null;
  if (status.per_day === 0) return 'Uploads are not available right now.';
  if (status.left_today <= 0) return 'You’ve used today’s uploads. You can upload again tomorrow.';
  return `${status.left_today} ${status.left_today === 1 ? 'upload' : 'uploads'} left today`;
}

// The line under a lesson's title in the student's library for lessons that are theirs: who can see it. Null for the
// teacher's lessons and other students' shared ones.
export function ownLessonNote(lesson) {
  if (!lesson.mine) return null;
  return lesson.shared ? 'Yours, shared with everyone' : 'Only you see this';
}

// While one of the student's uploads is being prepared: where it has got to, in the processing page's words.
export function processingLine(lesson) {
  if (lesson.status !== 'processing') return null;
  const { stage, status } = lesson.processing ?? {};
  if (status === 'queued' || !stage) return 'Waiting its turn…';
  const found = STAGES.find((s) => s.id === stage);
  return found ? `${found.doing}…` : 'Preparing…';
}

// What a student's own lesson row offers: Delete only before it is studied or shared (the server decides: `can_delete`),
// Try again for a failed upload.
export function rowActions(lesson) {
  return { delete: Boolean(lesson.mine && lesson.can_delete), retry: Boolean(lesson.mine && lesson.can_retry) };
}

// Admin's note on a student's upload: whose it is and who can see it. Null for the teacher's own lessons.
export function adminLessonNote(lesson) {
  if (lesson.origin !== 'student') return null;
  const who = lesson.owner_code ?? 'a withdrawn participant';
  if (lesson.shared) return `Uploaded by ${who} · shared with everyone`;
  // a private upload whose owner withdrew is visible to nobody (the visibility rule fails closed)
  return `Uploaded by ${who} · ${lesson.owner_code ? `only ${lesson.owner_code} can see it` : 'nobody can see it'}`;
}
