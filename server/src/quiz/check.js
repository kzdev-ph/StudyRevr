import { quizBuildOptions } from './options.js';
import { checkSummary } from '../services/check-review.js';
import { reviewItems } from '../services/quiz-review.js';
import { describe } from './review-flags.js';
import { QUIZ_LENGTH, quizCandidates, usableCount } from './build.js';
import { CARD_LEAK_RULES, cardLeaks, falseStatementProblems, lessonWords as lessonWordsOf, sharesWord, termInText, wrongOptionProblems } from './leaks.js';

// What gives answers away in one lesson, read from the database without any AI call: the flashcards that break rules
// g, i, j, k (rule h only as information), and every quiz question the builder could make (multiple choice, Yes/No false statements) with the ones it
// skips and why (rules a-f). Shared by the admin leak list and `npm run quiz:check`, and built on the quiz builder's
// own quizCandidates, so the report always matches what a quiz really asks.

const conceptRules = ['a', 'k', 'm', 'o'];

export function lessonLeakReport(db, lessonId) {
  const lesson = db.prepare('SELECT id, title, status, raw_text FROM lessons WHERE id = ?').get(lessonId);
  if (!lesson) return null;
  const cards = db.prepare('SELECT id, kind, front, back, evidence FROM flashcards WHERE lesson_id = ? ORDER BY position, id').all(lessonId);
  const opts = quizBuildOptions(db, lessonId);
  const lessonWords = lessonWordsOf(lesson.raw_text);
  const candidates = quizCandidates(cards, opts);

  // g, i, j, k give the answer away in flashcard study; h (a definition naming its term) is only listed: the quiz
  // blanks the term, and the card itself is still a fair "what does this term mean?"
  const checked = cards.map((card) => ({ id: card.id, kind: card.kind, front: card.front, back: card.back, rules: cardLeaks(card, cards) }));
  const flagged = checked.map((c) => ({ ...c, rules: c.rules.filter((r) => CARD_LEAK_RULES.includes(r.rule)) })).filter((c) => c.rules.length);
  const namesTerm = checked.filter((c) => c.rules.some((r) => r.rule === 'h')).map((c) => ({ ...c, rules: c.rules.filter((r) => r.rule === 'h') }));

  const mc = { possible: 0, clean: 0, skipped: [] };
  const falses = { possible: 0, clean: 0, skipped: [] };
  const never = [];
  const masked = [];
  for (const p of candidates) {
    const { card } = p;
    const cardProblems = p.problems.filter((x) => conceptRules.includes(x.rule));
    const otherAnswers = card.kind === 'term' ? [] : cards.filter((c) => c.kind !== 'term' && c.id !== card.id).map((c) => c.back);
    if (card.kind === 'term' && termInText(card.front, card.back)) masked.push({ card_id: card.id, front: card.front, shown: p.shown });

    if (p.mcWrong.length >= 3) {
      mc.possible += 1;
      if (p.mcClean.length >= 3) mc.clean += 1;
      else {
        const options = p.mcWrong.flatMap((w) => wrongOptionProblems(w, card.back, { lessonWords, otherAnswers, reworded: !p.sibling }).map((x) => ({ ...x, detail: `${x.detail}: "${w}"` })));
        mc.skipped.push({ card_id: card.id, question: card.front, answer: card.back, wrong: p.mcWrong, reasons: [...p.problems, ...options, ...p.excluded.map(excludedReason)] });
      }
    }

    const clean = new Set(p.falseClean);
    for (const statement of p.falsePool) {
      falses.possible += 1;
      if (clean.has(statement)) {
        falses.clean += 1;
        continue;
      }
      const named = card.kind === 'term' ? termInText(card.front, statement) : null;
      const reasons = [
        ...cardProblems,
        ...(named ? [{ rule: 'e', detail: `the statement holds the asked term (${named.join(', ')})` }] : []),
        ...falseStatementProblems(statement, p.shown, { reworded: card.kind !== 'term' && !p.sibling && p.mcWrong.length > 0 }),
        ...p.excluded.filter((x) => x.text === statement || (x.text === null && x.detail.startsWith('Yes/No'))).map(excludedReason),
        ...p.problems.filter((x) => x.rule === 'ai'),
      ];
      if (p.mcWrong.includes(statement)) reasons.push(...wrongOptionProblems(statement, card.back, { lengths: false, otherAnswers }).filter((x) => x.detail.startsWith('another card')).map((x) => ({ ...x, rule: 'e' })));
      if (!reasons.length && card.kind !== 'term' && !sharesWord(statement, card.front))
        reasons.push({ rule: 'e', detail: 'about another subject: shares no word with the question' });
      falses.skipped.push({ card_id: card.id, question: card.front, statement, reasons });
    }

    if (p.mcClean.length < 3 && !p.falseClean.length) {
      const left = p.excluded.length ? p.excluded.map(excludedReason) : [{ rule: '-', detail: card.kind === 'term' ? 'no clean other definition or 3 other terms' : 'no clean wrong answers saved' }];
      const reasons = p.problems.length ? p.problems : left;
      never.push({ card_id: card.id, kind: card.kind, front: card.front, reasons });
    }
  }

  // the AI exam reviewer's flags (services/quiz-review.js), per card, and the term families it found
  // Only reviews of what the quiz shows now count; one made for other options (remade since) is `pending` until the next
  // review. A database from before migration 013 has none.
  let items = [];
  try {
    items = reviewItems(db, lessonId);
  } catch {
    items = [];
  }
  const fresh = new Map(items.filter((x) => x.saved).map((x) => [x.card.id, x.saved]));
  const review = {
    reviewed: fresh.size,
    pending: items.length - fresh.size,
    families: opts.termFamilies,
    flagged: cards
      .map((c) => ({ card: c, r: fresh.get(c.id) }))
      .filter(({ r }) => r && (r.card.length || r.set.length || r.trueStatement.length || r.options.size))
      .map(({ card, r }) => ({
        card_id: card.id,
        front: card.front,
        round: r.round,
        card: r.card,
        set: r.set,
        true_statement: r.trueStatement,
        options: [...r.options].map(([text, flags]) => ({ text, flags })),
      })),
  };

  // the sections' quick checks (pipeline/quick-checks.js, services/check-review.js): how many have their lesson quote,
  // the review's counts and what it dropped. A database from before migration 014 has no reviews.
  let checks = null;
  try {
    const sections = db.prepare('SELECT title, check_questions, check_review FROM sections WHERE lesson_id = ? ORDER BY position').all(lessonId);
    const all = sections.flatMap((x) => JSON.parse(x.check_questions ?? '[]') ?? []);
    checks = {
      total: all.length,
      no_quote: all.filter((c) => !c.evidence).length,
      ...checkSummary(db, lessonId),
      dropped_checks: sections.flatMap((x) => (JSON.parse(x.check_review ?? 'null')?.dropped ?? []).map((d) => ({ section: x.title, ...d }))),
    };
  } catch {
    checks = null;
  }

  const usable = usableCount(cards, opts);
  return {
    review,
    checks,
    lesson: { id: lesson.id, title: lesson.title, status: lesson.status },
    cards: { total: cards.length, term: cards.filter((c) => c.kind === 'term').length, concept: cards.filter((c) => c.kind !== 'term').length, flagged, names_term: namesTerm },
    quiz: { multiple_choice: mc, yes_no_false: falses, masked, never, usable_cards: usable, clean_questions: Math.min(QUIZ_LENGTH, usable) },
  };
}

const excludedReason = (x) => ({ rule: x.rule, detail: x.text ? `${x.detail}: "${x.text}"` : x.detail });

// { rule: count } over a list of { rules | reasons: [{ rule }] }, each rule counted once per item.
export function countByRule(items, key = 'reasons') {
  const counts = {};
  for (const item of items) for (const rule of new Set(item[key].map((r) => r.rule))) counts[rule] = (counts[rule] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

// The plain-text report `npm run quiz:check` prints for one lesson.
export function formatReport(report, { examples = 5 } = {}) {
  const { lesson, cards, quiz } = report;
  const rules = (counts) => Object.entries(counts).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
  const why = (reasons) => reasons.map((r) => `${r.rule}: ${r.detail}`).join('; ');
  const cut = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
  const lines = [];
  lines.push(`Lesson ${lesson.id}: ${lesson.title} (${lesson.status})`);
  lines.push(`  Flashcards: ${cards.total} (${cards.term} term, ${cards.concept} concept)`);
  lines.push(`  Flashcards that give their answer away (g, i, j, k): ${cards.flagged.length}  [${rules(countByRule(cards.flagged, 'rules'))}]`);
  for (const c of cards.flagged.slice(0, examples)) lines.push(`    #${c.id} "${cut(c.front)}" -> "${cut(c.back)}"  (${why(c.rules)})`);
  if (cards.names_term.length) lines.push(`  Info: term definitions that name their term (h; the quiz blanks it): ${cards.names_term.map((c) => `#${c.id}`).join(' ')}`);
  const mc = quiz.multiple_choice;
  lines.push(`  Multiple choice: ${mc.possible} possible, ${mc.clean} clean, ${mc.skipped.length} skipped  [${rules(countByRule(mc.skipped))}]`);
  for (const q of mc.skipped.slice(0, examples)) lines.push(`    #${q.card_id} "${cut(q.question)}"  (${cut(why(q.reasons), 200)})`);
  const tf = quiz.yes_no_false;
  lines.push(`  Yes/No false statements: ${tf.possible} possible, ${tf.clean} clean, ${tf.skipped.length} skipped  [${rules(countByRule(tf.skipped))}]`);
  for (const q of tf.skipped.slice(0, examples)) lines.push(`    #${q.card_id} "${cut(q.question, 60)}" / "${cut(q.statement, 70)}"  (${why(q.reasons)})`);
  if (quiz.masked.length) lines.push(`  Term definitions shown with the term blanked (d): ${quiz.masked.map((m) => `#${m.card_id}`).join(' ')}`);
  lines.push(`  Cards the quiz never asks: ${quiz.never.length}${quiz.never.length ? `  (${quiz.never.slice(0, examples).map((c) => `#${c.card_id} ${why(c.reasons)}`).join(' | ')})` : ''}`);
  const { review } = report;
  if (review) {
    lines.push(`  AI review: ${review.reviewed} of ${cards.total} cards reviewed${review.pending ? ` (${review.pending} not reviewed yet or changed since)` : ''}, ${review.flagged.length} with flags${review.families.length ? `; term families: ${review.families.map((f) => f.join(' / ')).join('; ')}` : ''}`);
    for (const c of review.flagged.slice(0, examples * 2)) {
      const parts = [
        c.card.length ? `card ${describe(c.card)}` : null,
        c.set.length ? `set ${describe(c.set)}` : null,
        c.true_statement.length ? `Yes/No ${describe(c.true_statement)}` : null,
        ...c.options.map((o) => `"${cut(o.text, 50)}" ${describe(o.flags)}`),
      ].filter(Boolean);
      lines.push(`    #${c.card_id} "${cut(c.front, 60)}" (round ${c.round}): ${cut(parts.join(' | '), 400)}`);
    }
  }
  const { checks } = report;
  if (checks) {
    lines.push(
      `  Quick checks: ${checks.total}${checks.no_quote ? ` (${checks.no_quote} without a lesson quote)` : ''}; AI review: ${checks.reviewed} reviewed${checks.pending ? `, ${checks.pending} not reviewed yet or changed since` : ''}, ${checks.dropped} dropped`,
    );
    for (const d of checks.dropped_checks.slice(0, examples)) lines.push(`    "${cut(d.section, 40)}": "${cut(d.question, 80)}" dropped (${cut(d.why, 120)})`);
  }
  lines.push(`  Clean questions available: ${quiz.clean_questions} of ${QUIZ_LENGTH}`);
  return lines.join('\n');
}
