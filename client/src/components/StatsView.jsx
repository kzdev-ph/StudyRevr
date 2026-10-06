import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { prettyTitle } from '../lib/format.js';
import { paths } from '../lib/router.js';
import { ACTIVITIES, cardsLine, mostActiveDay, pct, studyTime, weekRows } from '../lib/stats.js';

const AXIS = { fill: 'var(--ink-2)', fontSize: 14 };

function Swatch({ color }) {
  return <span className="swatch" style={{ '--swatch': color }} aria-hidden="true" />;
}

function WeekTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tip">
      <p className="chart-tip__title">
        {row.day} · {studyTime(row.total * 60_000)}
      </p>
      {ACTIVITIES.map((a) => (
        <p key={a.key} className="chart-tip__row">
          <Swatch color={a.color} /> {a.label}: {studyTime(row[a.key] * 60_000)}
        </p>
      ))}
    </div>
  );
}

// Study time this week: a tile per activity, then minutes per day stacked by activity (with a table view).
function WeekCard({ week, own }) {
  const rows = weekRows(week.days);
  const { totals } = week;
  const empty = totals.total_ms === 0;
  return (
    <section className="stats-card" aria-labelledby="stats-week">
      <h2 id="stats-week" className="stats-card__title">
        Study time this week
      </h2>
      <dl className="stat-tiles">
        <div className="stat-tile stat-tile--total">
          <dt>Total</dt>
          <dd>{studyTime(totals.total_ms)}</dd>
        </div>
        {ACTIVITIES.map((a) => (
          <div key={a.key} className="stat-tile">
            <dt>
              <Swatch color={a.color} /> {a.label}
            </dt>
            <dd>{studyTime(totals[`${a.key}_ms`])}</dd>
          </div>
        ))}
      </dl>
      {empty ? (
        <>
          <p className="muted">No study time yet this week. Time counts while you read, study flashcards or take a quiz.</p>
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
          <div className="stats-chart" aria-hidden="true">
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 18, right: 4, bottom: 0, left: -18 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="var(--line)" />
                <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--line-strong)' }} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={44} unit="m" />
                <Tooltip content={<WeekTip />} cursor={{ fill: 'var(--accent-wash)' }} />
                {ACTIVITIES.map((a, i) => (
                  <Bar
                    key={a.key}
                    dataKey={a.key}
                    stackId="time"
                    fill={a.color}
                    stroke="var(--sheet)"
                    strokeWidth={2}
                    radius={i === ACTIVITIES.length - 1 ? [4, 4, 0, 0] : 0}
                    isAnimationActive={false}
                  >
                    {i === ACTIVITIES.length - 1 && (
                      <LabelList dataKey="total" position="top" fill="var(--ink-2)" fontSize={14} formatter={(v) => (v >= 1 ? Math.round(v) : v > 0 ? '<1' : '')} />
                    )}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
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

function CardsCard({ cards, dueTomorrow, own }) {
  return (
    <section className="stats-card" aria-labelledby="stats-cards">
      <h2 id="stats-cards" className="stats-card__title">
        Flashcards
      </h2>
      <dl className="stat-tiles">
        <div className="stat-tile">
          <dt>Reviewed this week</dt>
          <dd>{cards.week.reviewed}</dd>
        </div>
        <div className="stat-tile">
          <dt>Good or Easy this week</dt>
          <dd>{pct(cards.week.good_easy_pct)}</dd>
        </div>
        <div className="stat-tile">
          <dt>Due tomorrow</dt>
          <dd>{dueTomorrow}</dd>
        </div>
        <div className="stat-tile">
          <dt>All time</dt>
          <dd className="stat-tile__note">{cardsLine(cards.all)}</dd>
        </div>
      </dl>
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

// First and best finished quiz score per lesson: one small chart per lesson, so long titles stay readable.
function QuizCard({ quiz }) {
  return (
    <section className="stats-card" aria-labelledby="stats-quiz">
      <h2 id="stats-quiz" className="stats-card__title">
        Quiz scores
      </h2>
      {quiz.length === 0 ? (
        <p className="muted">Finish a mock quiz to see your first and best score per lesson.</p>
      ) : (
        <>
          <ul className="quiz-scores">
            {quiz.map((q) => {
              const rows = scoreRows(q);
              return (
                <li key={q.lesson_id}>
                  <p className="quiz-scores__title">{prettyTitle(q.title)}</p>
                  <p className="visually-hidden">
                    {q.attempts === 1 ? `Score ${pct(q.best_pct)}, 1 finished quiz.` : `First try ${pct(q.first_pct)}, best ${pct(q.best_pct)}, ${q.attempts} finished quizzes.`}
                  </p>
                  <div className={`stats-chart stats-chart--small${rows.length === 1 ? ' stats-chart--one' : ''}`} aria-hidden="true">
                    <ResponsiveContainer>
                      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }} barCategoryGap="18%">
                        <XAxis type="number" domain={[0, 100]} hide />
                        <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={68} />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} background={{ fill: 'var(--paper)', radius: 4 }}>
                          {rows.map((r) => (
                            <Cell key={r.name} fill={r.color} />
                          ))}
                          <LabelList dataKey="value" position="right" fill="var(--ink)" fontSize={14} fontWeight={650} formatter={(v) => pct(v)} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="muted">
                    {q.attempts} finished {q.attempts === 1 ? 'quiz' : 'quizzes'}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

// Everything the Stats tab shows for one participant (also used by admin to look at a participant).
// `own`: the participant's own Stats tab (empty states link to what to do next; admin's view has no such links).
export default function StatsView({ stats, own = false }) {
  return (
    <div className="stats stack">
      <WeekCard week={stats.week} own={own} />
      <CardsCard cards={stats.cards} dueTomorrow={stats.due_tomorrow} own={own} />
      <QuizCard quiz={stats.quiz} />
    </div>
  );
}
