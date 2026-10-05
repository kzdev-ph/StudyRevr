import { useMemo, useState } from 'react';
import { exactSource, matchSource, numberedBlocks, sourceLabel, splitBlocks } from '../lib/source.js';

const NOTES = /^Notes:$/;

// One block of the file: a slide, a page or a paragraph. A "Notes:" line starts the teacher's spoken notes.
// `label` ("Slide 3") says which one, when the lesson knows.
function Block({ text, label }) {
  return (
    <div className="source__block">
      {label && <p className="source__label">{label}</p>}
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

// What a section was written from. A lesson that recorded its slide / page numbers shows exactly the slides or pages
// the section names. An older lesson has no such record, so the parts are found by matching words and the panel says
// the match is approximate.
export default function SourcePanel({ section, lesson }) {
  const [all, setAll] = useState(false);
  const { raw_text: rawText, filename, source } = lesson;
  const kind = source?.kind;

  const numbered = useMemo(() => numberedBlocks(rawText, source), [rawText, source]);
  const exact = useMemo(() => exactSource(section.sources, rawText, source), [section.sources, rawText, source]);
  const approximate = useMemo(
    () => (exact ? [] : matchSource(`${section.title}\n${section.content}`, rawText).map((b) => ({ number: numbered?.[b.index]?.number, text: b.text, index: b.index }))),
    [exact, section, rawText, numbered],
  );
  const shown = exact ?? approximate;
  const whole = all || !shown.length;
  const blocks = whole ? numbered ?? splitBlocks(rawText).map((text, index) => ({ text, index })) : shown;
  const labelFor = (b) => (b.number ? sourceLabel(kind, [b.number]) : null);

  let title;
  let hint;
  if (whole) {
    title = 'Everything in your file';
    hint = `The full text taken from ${filename}.`;
  } else if (exact) {
    title = `From ${sourceLabel(kind, exact.map((b) => b.number)).toLowerCase()}`;
    hint = `Exactly what this section was written from in ${filename}.`;
  } else {
    title = 'From your file';
    hint = `The parts of ${filename} this section was written from. The match is approximate.`;
  }

  return (
    <section className="source" aria-label="Original text">
      <h3 className="source__title">{title}</h3>
      <p className="source__hint">{hint}</p>
      {!shown.length && !all && <p className="source__hint">No close match was found, so the whole text is shown.</p>}
      <div className="source__blocks">
        {blocks.map((b, i) => (
          <Block key={b.number ?? b.index ?? i} text={b.text} label={labelFor(b)} />
        ))}
      </div>
      {shown.length > 0 && (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show only this section’s source' : 'Show the whole file'}
        </button>
      )}
    </section>
  );
}
