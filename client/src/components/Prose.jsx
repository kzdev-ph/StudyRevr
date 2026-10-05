import { toBlocks } from '../lib/format.js';

// Section text as short paragraphs and lists. Long paragraphs are split here, for display only.
export default function Prose({ text, className = '' }) {
  return (
    <div className={`prose ${className}`}>
      {toBlocks(text).map((block, i) =>
        block.type === 'ul' ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{block.text}</p>
        ),
      )}
    </div>
  );
}
