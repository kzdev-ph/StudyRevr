import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import EndCard from './EndCard.jsx';
import SectionPage from './SectionPage.jsx';
import { ChevronLeft, ChevronRight } from './Icons.jsx';
import { initialProgress, useSavedProgress } from '../hooks/useSavedProgress.js';
import { api } from '../lib/api.js';

const slide = {
  enter: (dir) => ({ opacity: 0, x: dir * 28 }),
  center: { opacity: 1, x: 0 },
  exit: (dir) => ({ opacity: 0, x: dir * -28 }),
};

const isTyping = (el) => el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

// The review: one section at a time, then the "What's next" card. `index === sections.length` is that card.
export default function SectionsReview({ lesson, sections, progress, keyTermCount, onVersion }) {
  const count = sections.length;
  const saved = initialProgress(progress);
  const [index, setIndex] = useState(() => Math.min(Math.max(saved.last_section, 0), count - 1));
  const [dir, setDir] = useState(1);
  const [navigated, setNavigated] = useState(false);
  const [completed, setCompleted] = useState(() => new Set(saved.completed_sections.filter((n) => n < count)));
  const [variant, setVariant] = useState('summary');
  const [showSource, setShowSource] = useState(false);
  const [busy, setBusy] = useState({});
  const [failure, setFailure] = useState({});

  useSavedProgress(lesson.id, Math.min(index, count - 1), completed, saved);

  const atEnd = index === count;
  const section = sections[Math.min(index, count - 1)];

  const goTo = useCallback(
    (next, markDone = false) => {
      if (next < 0 || next > count) return;
      if (markDone) setCompleted((set) => new Set(set).add(Math.min(index, count - 1)));
      setDir(next >= index ? 1 : -1);
      setVariant('summary');
      setNavigated(true);
      setIndex(next);
      window.scrollTo({ top: 0 });
    },
    [count, index],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || isTyping(document.activeElement)) return;
      if (e.key === 'ArrowRight' && index < count) goTo(index + 1, true);
      if (e.key === 'ArrowLeft' && index > 0) goTo(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, index, count]);

  const generate = async (target, kind) => {
    const key = `${target.id}:${kind}`;
    setBusy((b) => ({ ...b, [key]: true }));
    setFailure((f) => ({ ...f, [key]: null }));
    try {
      const { version } = await (kind === 'simple' ? api.simplifySection(target.id) : api.translateSection(target.id));
      onVersion(target.id, kind, version);
    } catch (err) {
      setFailure((f) => ({ ...f, [key]: err.message }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  // The first tap makes the rewrite, later taps just switch to it; tapping the active one goes back to the summary.
  const chooseVariant = (kind) => {
    if (variant === kind) return setVariant('summary');
    setVariant(kind);
    const have = kind === 'simple' ? section.simple_version : section.filipino_version;
    if (!have && !busy[`${section.id}:${kind}`]) generate(section, kind);
  };

  const key = `${section.id}:${variant}`;
  const percent = atEnd ? 100 : ((index + 1) / count) * 100;

  return (
    <div className="review">
      <div className="progress">
        <p className="progress__label" aria-live="polite">
          {atEnd ? `${count}/${count}` : `${index + 1}/${count}`} sections
        </p>
        <div className="progress__track" role="progressbar" aria-label="Sections read" aria-valuemin={0} aria-valuemax={count} aria-valuenow={atEnd ? count : index + 1}>
          <motion.span className="progress__fill" initial={false} animate={{ width: `${percent}%` }} transition={{ duration: 0.3, ease: 'easeOut' }} />
        </div>
      </div>

      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div className="review__body" key={index} custom={dir} variants={slide} initial="enter" animate="center" exit="exit" transition={{ duration: 0.16 }}>
          {atEnd ? (
            <EndCard lessonId={lesson.id} sectionCount={count} termCount={keyTermCount} onRestart={() => goTo(0)} />
          ) : (
            <SectionPage
              lesson={lesson}
              section={section}
              variant={variant}
              busy={Boolean(busy[key])}
              failure={failure[key]}
              showSource={showSource}
              focusTitle={navigated}
              onVariant={chooseVariant}
              onRetry={() => generate(section, variant)}
              onToggleSource={() => setShowSource((v) => !v)}
            />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="lesson-nav">
        <button type="button" className="btn btn--quiet" onClick={() => goTo(index - 1)} disabled={index === 0}>
          <ChevronLeft size={18} /> Previous
        </button>
        {!atEnd && (
          <button type="button" className="btn btn--primary" onClick={() => goTo(index + 1, true)}>
            {index === count - 1 ? 'Finish' : 'Next section'} <ChevronRight size={18} />
          </button>
        )}
      </div>
    </div>
  );
}
