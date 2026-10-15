import { useLayoutEffect, useRef } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { prettyTitle } from '../lib/format.js';
import { paths } from '../lib/router.js';
import { ACTIVITIES, cardsLine, daySegments, mostActiveDay, pct, studyTime, weekRows } from '../lib/stats.js';

function Swatch({ color, activity }) {
  return <span className={activity ? `swatch swatch--${activity}` : 'swatch'} style={{ '--swatch': color }} aria-hidden="true" />;
}

// A percentage written in the margin. A screen reader hears "no answers yet" instead of "dash".
function Percent({ value }) {
  if (value === null || value === undefined) {
    return (
      <>
        <span aria-hidden="true">–</span>
        <span className="visually-hidden">No answers yet:</span>
      </>
    );
  }
  return pct(value);
}

const INK = { duration: 0.3, ease: [0.16, 1, 0.3, 1] };
const INK_STAGGER_S = 0.04;

// The week inked in, once each time Stats opens: each day's bar drawn from the left (scaleX), a day after the other.
// A tap finishes it; reduced motion shows the bars at once.
function useInkedBars(listRef, reduce) {
  const runs = useRef([]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || reduce) return undefined;
    const bars = [...list.querySelectorAll('.days__bar')];
    runs.current = bars.map((bar, k) => {
      bar.style.transform = 'scaleX(0)'; // waiting for its turn
      return animate(bar, { scaleX: [0, 1] }, { ...INK, delay: k * INK_STAGGER_S });
    });
    return () => {
      // never leave a bar half drawn or waiting at zero: finish, then give the style back to the stylesheet
      for (const r of runs.current) r.complete();
      for (const bar of bars) bar.style.transform = '';
      runs.current = [];
    };
  }, [listRef, reduce]);
  return () => {
    for (const r of runs.current) r.complete();
  };
}

// Study time this week, written out: one sentence with the total, the three parts, then one ruled line per day (the
// day in the margin, a bar in the activity colours, the time written at the end), with a table view.
function Week({ week, own }) {
  const listRef = useRef(null);
  const finishInk = useInkedBars(listRef, useReducedMotion());
  const rows = weekRows(week.days);
  const { totals } = week;
  const empty = totals.total_ms === 0;
  const most = Math.max(...rows.map((r) => r.total), 0);
  const scale = most || 1;
  return (
    <section className="stats-part" aria-labelledby="stats-week">
      <h2 id="stats-week" className="stats-part__title">
        This week
      </h2>
      {empty ? (
        <>
          <p className="stats-lede">No study time yet this week. Time counts while you read, study flashcards or take a quiz.</p>
          {own && (
            <div>
              <a className="link-btn" href={paths.library()}>
                Open a lesson
              </a>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="stats-lede">
            You studied <strong className="mk">{studyTime(totals.total_ms)}</strong> this week.
          </p>
          <dl className="legend">
            {ACTIVITIES.map((a) => (
              <div key={a.key} className="legend__item">
                <dt>
                  <Swatch color={a.color} activity={a.key} /> {a.label}
                </dt>
                <dd>{studyTime(totals[`${a.key}_ms`])}</dd>
              </div>
            ))}
          </dl>
          <ul className="days" aria-label="Study time per day" ref={listRef} onPointerDown={finishInk}>
            {rows.map((r) => (
              <li key={r.date} className={`days__row${r.total > 0 && r.total === most ? ' days__row--peak' : ''}`}>
                <span className="days__day">{r.day}</span>
                <span className="days__bar" aria-hidden="true">
                  {daySegments(r, scale).map((s) => (
                    <i key={s.key} data-activity={s.key} style={{ width: s.width, backgroundColor: s.color }} />
                  ))}
                </span>
                <span className="days__time">{r.total > 0 ? studyTime(r.total * 60_000) : <span className="muted">–<span className="visually-hidden">none</span></span>}</span>
              </li>
            ))}
          </ul>
          <p className="muted">{mostActiveDay(week.days)}</p>
          <details className="table-view">
            <summary>Show as a table</summary>
            <div className="table-wrap" role="region" aria-label="Study time per day" tabIndex={0}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    {ACTIVITIES.map((a) => (
                      <th key={a.key} scope="col">
                        {a.label}
                      </th>
                    ))}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.date}>
                      <th scope="row">{r.day}</th>
                      {ACTIVITIES.map((a) => (
                        <td key={a.key}>{studyTime(r[a.key] * 60_000)}</td>
                      ))}
                      <td>{studyTime(r.total * 60_000)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

// The flashcard figures, each written large in the margin with what it means beside it.
function Cards({ cards, dueTomorrow, own }) {
  return (
    <section className="stats-part" aria-labelledby="stats-cards">
      <h2 id="stats-cards" className="stats-part__title">
        Flashcards
      </h2>
      <ul className="figures">
        <li className="figure">
          <span className="figure__n">{cards.week.reviewed}</span>
          <span>reviewed this week</span>
        </li>
        <li className="figure">
          <span className="figure__n">
            {cards.week.good_easy_pct === null || cards.week.good_easy_pct === undefined ? (
              <Percent value={null} />
            ) : (
              <span className="mk">{pct(cards.week.good_easy_pct)}</span>
            )}
          </span>
          <span>answered Good or Easy this week</span>
        </li>
        <li className="figure">
          <span className="figure__n">{dueTomorrow}</span>
          <span>due tomorrow</span>
        </li>
      </ul>
      <p className="muted">All time: {cardsLine(cards.all)}.</p>
      {own && cards.all.reviewed === 0 && (
        <div>
          <a className="link-btn" href={paths.tab('flashcards')}>
            Study flashcards
          </a>
        </div>
      )}
    </section>
  );
}

// Not the activity colours above (reading / flashcards / quiz time): those would mean two things on one screen.
const FIRST_TRY = { label: 'First try', color: 'var(--ink-2)' };
const BEST = { label: 'Best', color: 'var(--accent)' };

// One bar when only one quiz is finished (its first try is also its best), two otherwise.
const scoreRows = (q) =>
  q.attempts === 1
    ? [{ name: 'Score', value: q.best_pct, color: BEST.color }]
    : [
        { name: FIRST_TRY.label, value: q.first_pct, color: FIRST_TRY.color },
        { name: BEST.label, value: q.best_pct, color: BEST.color },
      ];

// First and best finished quiz score per lesson: the best score in the margin, a thin track per score.
function Quiz({ quiz }) {
  return (
    <section className="stats-part" aria-labelledby="stats-quiz">
      <h2 id="stats-quiz" className="stats-part__title">
        Quiz scores
      </h2>
      {quiz.length === 0 ? (
        <p className="figure figure--empty">
          <span className="figure__n" aria-hidden="true">
            –
          </span>
          <span className="muted">Finish a mock quiz to see your first and best score per lesson.</span>
        </p>
      ) : (
        <ul className="figures">
          {quiz.map((q) => {
            const rows = scoreRows(q);
            return (
              <li key={q.lesson_id} className="figure figure--quiz">
                <span className="figure__n figure__n--pct" aria-hidden="true">
                  {pct(q.best_pct)}
                </span>
                <div className="quiz-score-lines">
                  <h3 className="quiz-scores__title">{prettyTitle(q.title)}</h3>
                  <p className="visually-hidden">
                    {q.attempts === 1 ? `Score ${pct(q.best_pct)}, 1 finished quiz.` : `First try ${pct(q.first_pct)}, best ${pct(q.best_pct)}, ${q.attempts} finished quizzes.`}
                  </p>
                  <div aria-hidden="true">
                    {rows.map((r) => (
                      <div key={r.name} className="score-line">
                        <span className={r.name === FIRST_TRY.label ? 'muted' : undefined}>{r.name}</span>
                        <span className="score-line__track">
                          <i style={{ transform: `scaleX(${(r.value ?? 0) / 100})`, background: r.color }} />
                        </span>
                        <b>{pct(r.value)}</b>
                      </div>
                    ))}
                  </div>
                  <p className="muted">
                    {q.attempts} finished {q.attempts === 1 ? 'quiz' : 'quizzes'}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Everything the Stats tab shows for one participant (also used by admin to look at a participant), written like a
// page of notes: no cards or tiles. On a wide screen the week sits on the left, flashcards and quiz scores beside it.
// `own`: the participant's own Stats tab (empty states link to what to do next; admin's view has no such links).
export default function StatsView({ stats, own = false }) {
  return (
    <div className="stats">
      <Week week={stats.week} own={own} />
      <div className="stats__side">
        <Cards cards={stats.cards} dueTomorrow={stats.due_tomorrow} own={own} />
        <Quiz quiz={stats.quiz} />
      </div>
    </div>
  );
}
