import { paths } from '../lib/router.js';

export default function KeyPoints({ points, lessonId }) {
  if (!points.length) {
    return (
      <section className="stack">
        <p className="muted">No key points were found for this lesson.</p>
        <a className="btn btn--quiet" href={paths.lesson(lessonId)}>Read the sections</a>
      </section>
    );
  }
  return (
    <section className="sheet">
      <ul className="points">
        {points.map((p) => (
          <li key={p.id} className="points__item">
            {p.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
