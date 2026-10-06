// Stroke icons on a 24px grid. They inherit the text colour and are decorative unless a parent labels them.

const Svg = ({ children, size = 24, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {children}
  </svg>
);

export const ReviewIcon = (p) => (
  <Svg {...p}>
    <path d="M4 5.5C4 5.2 4.2 5 4.5 5H10c1.1 0 2 .9 2 2v12c0-1.1-.9-2-2-2H4.5a.5.5 0 0 1-.5-.5v-11Z" />
    <path d="M20 5.5c0-.3-.2-.5-.5-.5H14c-1.1 0-2 .9-2 2v12c0-1.1.9-2 2-2h5.5c.3 0 .5-.2.5-.5v-11Z" />
  </Svg>
);

export const CardsIcon = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="8" width="13" height="11" rx="2" />
    <path d="M7.5 8V6.5c0-1.1.9-2 2-2H18c1.1 0 2 .9 2 2V14c0 1.1-.9 2-2 2h-1.5" />
  </Svg>
);

export const QuizIcon = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M9.5 9.7c0-1.1.9-1.9 2.1-1.9 1.2 0 2.1.8 2.1 1.8 0 1.5-2 1.5-2 3" />
    <path d="M11.7 15.6h.01" strokeWidth="2.4" />
  </Svg>
);

export const StatsIcon = (p) => (
  <Svg {...p}>
    <path d="M5 20V12M12 20V5M19 20v-5" />
  </Svg>
);

// A cog: eight teeth around a ring, with a hole in the middle. (It used to be a circle with rays, which read as a sun.)
export const GearIcon = (p) => (
  <Svg {...p}>
    <path d="M10.16 5.14 L10.48 2.42 L13.52 2.42 L13.84 5.14 A7.1 7.1 0 0 1 15.55 5.85  L17.7 4.15 L19.85 6.3 L18.15 8.45 A7.1 7.1 0 0 1 18.86 10.16  L21.58 10.48 L21.58 13.52 L18.86 13.84 A7.1 7.1 0 0 1 18.15 15.55  L19.85 17.7 L17.7 19.85 L15.55 18.15 A7.1 7.1 0 0 1 13.84 18.86  L13.52 21.58 L10.48 21.58 L10.16 18.86 A7.1 7.1 0 0 1 8.45 18.15  L6.3 19.85 L4.15 17.7 L5.85 15.55 A7.1 7.1 0 0 1 5.14 13.84  L2.42 13.52 L2.42 10.48 L5.14 10.16 A7.1 7.1 0 0 1 5.85 8.45  L4.15 6.3 L6.3 4.15 L8.45 5.85 A7.1 7.1 0 0 1 10.16 5.14 Z" />
    <circle cx="12" cy="12" r="2.6" />
  </Svg>
);

export const UploadIcon = (p) => (
  <Svg {...p}>
    <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5" />
    <path d="M5 15v3a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18v-3" />
  </Svg>
);

export const TrashIcon = (p) => (
  <Svg {...p}>
    <path d="M5 7h14M9.5 7V5.5c0-.3.2-.5.5-.5h4c.3 0 .5.2.5.5V7M7 7l.8 11.2c0 .5.5.8 1 .8h6.4c.5 0 1-.3 1-.8L17 7" />
  </Svg>
);

export const ChevronLeft = (p) => (
  <Svg {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Svg>
);

export const ChevronRight = (p) => (
  <Svg {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);

export const CheckIcon = (p) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const AlertIcon = (p) => (
  <Svg {...p}>
    <path d="M12 4 3 19.5h18L12 4Z" />
    <path d="M12 10v4.2M12 16.9h.01" />
  </Svg>
);

export const RetryIcon = (p) => (
  <Svg {...p}>
    <path d="M19 12a7 7 0 1 1-2.1-5" />
    <path d="M19 4.5v4h-4" />
  </Svg>
);

export const SimplerIcon = (p) => (
  <Svg {...p}>
    <path d="M5 8h14M5 12h9M5 16h5" />
  </Svg>
);

export const TranslateIcon = (p) => (
  <Svg {...p}>
    <path d="M4 6h9M8.5 4v2M6 6c.4 3 2.4 5.2 5 6.5M12 6c-.5 3.2-3 5.6-6.5 6.8" />
    <path d="m12.5 19 3.3-8 3.2 8M13.7 16.5h4.2" />
  </Svg>
);

export const SourceIcon = (p) => (
  <Svg {...p}>
    <path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
    <path d="M13 3.5V8.5h5M9 13h6M9 16.5h4" />
  </Svg>
);

export const LogoMark = ({ size = 28 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="7" fill="var(--accent)" />
    <rect x="6" y="19" width="20" height="6" rx="1.5" fill="var(--hi)" />
    <path d="M9 8h14M9 13h14" stroke="var(--on-accent)" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
);

export const UndoIcon = (p) => (
  <Svg {...p}>
    <path d="M9 14 4.5 9.5 9 5" />
    <path d="M4.5 9.5h9.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);

export const CloseIcon = (p) => (
  <Svg {...p}>
    <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
  </Svg>
);
