import { CardsIcon, QuizIcon, StatsIcon } from '../components/Icons.jsx';
import { paths } from '../lib/router.js';

const COPY = {
  flashcards: {
    Icon: CardsIcon,
    title: 'Flashcards aren’t ready yet',
    text: 'Each lesson will get cards you flip and rate, so the ones you miss come back sooner.',
  },
  quiz: {
    Icon: QuizIcon,
    title: 'Mock quizzes aren’t ready yet',
    text: 'You’ll take a multiple-choice quiz on any lesson and see your score for each attempt.',
  },
  stats: {
    Icon: StatsIcon,
    title: 'Stats aren’t ready yet',
    text: 'Your study time, streak and quiz scores will show up here.',
  },
};

export default function PlaceholderScreen({ which }) {
  const { Icon, title, text } = COPY[which];
  return (
    <section className="empty">
      <Icon size={36} className="empty__icon" />
      <h1 className="empty__title">{title}</h1>
      <p className="empty__text">{text}</p>
      <a className="btn btn--primary" href={paths.library()}>
        Back to lessons
      </a>
    </section>
  );
}
