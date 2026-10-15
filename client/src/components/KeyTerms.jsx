import { useLayoutEffect, useRef } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { truncateAtWord } from '../lib/format.js';
import { paths } from '../lib/router.js';

const EVIDENCE_MAX = 200;
const MARK = { duration: 0.38, ease: [0.16, 1, 0.3, 1] };
const STAGGER_MS = 70;
const STAGGER_MAX = 4; // terms that come into view together share a short stagger, never more than 280 ms

// The highlighter drawn under each term once, as it comes into view: the marker slides in from the left inside a clip
// that carries a copy of the word in the marker's ink (in dark mode the word turns dark under the marker). Terms are
// marked from the start: only a one-line term about to be marked is unmarked, just before the stroke, and a term on
// two lines, reduced motion or no IntersectionObserver keep the plain mark.
function useMarkerOnView(listRef, reduce) {
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || reduce || typeof IntersectionObserver === 'undefined') return undefined;
    const oneLine = (el) => el.offsetHeight < parseFloat(getComputedStyle(el).lineHeight) * 1.5;
    const names = [...list.querySelectorAll('.term__name')].filter((el) => el.querySelector('.term__wipe') && oneLine(el));
    for (const el of names) el.classList.add('term__name--wipe');
    const runs = new Set();
    let batch = 0;
    let batchTimer;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          io.unobserve(el);
          const delay = (Math.min(batch, STAGGER_MAX) * STAGGER_MS) / 1000;
          batch += 1;
          clearTimeout(batchTimer);
          batchTimer = setTimeout(() => (batch = 0), 120);
          const fill = el.querySelector('.term__wipe-fill');
          const a = animate(fill, { x: ['-101%', '0%'] }, { ...MARK, delay });
          const b = animate(fill.firstChild, { x: ['101%', '0%'] }, { ...MARK, delay });
          runs.add(a).add(b);
          a.then(() => el.classList.remove('term__name--wipe'));
        }
      },
      { threshold: 1 },
    );
    for (const el of names) io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(batchTimer);
      for (const r of runs) r.stop();
      for (const el of names) el.classList.remove('term__name--wipe');
    };
  }, [listRef, reduce]);
}

export default function KeyTerms({ terms, lessonId }) {
  const listRef = useRef(null);
  const reduce = useReducedMotion();
  useMarkerOnView(listRef, reduce);
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
      <dl className="terms" ref={listRef}>
        {terms.map((t) => (
          <div key={t.id} className="term">
            <dt className="term__name">
              {t.term}
              <span className="term__wipe" aria-hidden="true">
                <span className="term__wipe-fill">
                  <span>{t.term}</span>
                </span>
              </span>
            </dt>
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
