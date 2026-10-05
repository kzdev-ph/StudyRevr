import { CardsIcon, QuizIcon, StatsIcon } from '../components/Icons.jsx';
import { paths } from '../lib/router.js';

const COPY = {
  flashcards: {
    Icon: CardsIcon,
    title: 'Flashcards are on their way',
    text: 'Soon each lesson will turn into cards you flip, rate and see again just before you forget them.',
  },
  quiz: {
    Icon: QuizIcon,
    title: 'Mock quizzes are on their way',
    text: 'Soon you will be able to take a multiple-choice quiz on any lesson and see how your score improves.',
  },
  stats: {
    Icon: StatsIcon,
    title: 'Stats are on their way',
    text: 'Soon this is where your study time, streak and quiz scores will show up.',
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
        Back to your lessons
      </a>
    </section>
  );
}
