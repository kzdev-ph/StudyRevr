import { truncateAtWord } from '../lib/format.js';
import { paths } from '../lib/router.js';

const EVIDENCE_MAX = 200;

export default function KeyTerms({ terms, lessonId }) {
  if (!terms.length) {
    return (
      <section className="stack">
        <p className="muted">No key terms were found in this lesson. The text may not define any terms outright.</p>
        <a className="btn btn--quiet" href={paths.lesson(lessonId)}>Read the sections</a>
      </section>
    );
  }
  return (
    <section className="stack">
      <p className="muted">Each term comes with the line from your file it was taken from.</p>
      <dl className="terms">
        {terms.map((t) => (
          <div key={t.id} className="term">
            <dt className="term__name">{t.term}</dt>
            <dd className="term__def">{t.definition}</dd>
            {t.evidence && (
              <dd className="term__evidence">
                <span className="term__from">From the lesson:</span> “{truncateAtWord(t.evidence, EVIDENCE_MAX)}”
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}
