import { useMemo, useState } from 'react';
import { matchSource, splitBlocks } from '../lib/source.js';

const NOTES = /^Notes:$/;

// One block of the file: a slide, a page or a paragraph. A "Notes:" line starts the teacher's spoken notes.
function Block({ text }) {
  return (
    <div className="source__block">
      {text.split('\n').map((line, i) =>
        NOTES.test(line.trim()) ? (
          <p key={i} className="source__notes">Teacher's notes</p>
        ) : (
          <p key={i}>{line}</p>
        ),
      )}
    </div>
  );
}

export default function SourcePanel({ section, rawText, filename }) {
  const [all, setAll] = useState(false);
  const matches = useMemo(() => matchSource(`${section.title}\n${section.content}`, rawText), [section, rawText]);
  const blocks = useMemo(() => (all || !matches.length ? splitBlocks(rawText).map((text, index) => ({ index, text })) : matches), [all, matches, rawText]);

  return (
    <section className="source" aria-label="Original text">
      <h3 className="source__title">{all || !matches.length ? 'Everything in your file' : 'From your file'}</h3>
      <p className="source__hint">
        {all || !matches.length
          ? `The full text taken from ${filename}.`
          : `The parts of ${filename} this section was written from. The match is approximate.`}
      </p>
      {!matches.length && !all && <p className="source__hint">No close match was found, so the whole text is shown.</p>}
      <div className="source__blocks">
        {blocks.map((b) => (
          <Block key={b.index} text={b.text} />
        ))}
      </div>
      {matches.length > 0 && (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show only this section’s source' : 'Show the whole file'}
        </button>
      )}
    </section>
  );
}
