import { LogoMark } from './Icons.jsx';

// The card the signed-out screens sit in: the wordmark, a title, then what the screen shows.
export default function GateCard({ title, children }) {
  return (
    <main className="gate" id="main">
      <div className="gate__inner">
        <div className="gate__card stack">
          <span className="wordmark">
            <LogoMark />
            <span>StudyRevr</span>
          </span>
          <h1 className="screen-title">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}
