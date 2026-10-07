# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Filipino senior high school students taking part in a Practical Research 2 study that compares traditional studying with AI-assisted studying. They study mostly on budget Android phones connected to one shared study laptop over local Wi-Fi (no internet guaranteed); some use the laptop's browser. A researcher (the teacher/student running the study) uses the PIN-protected Admin area to upload lessons, add participant codes and export data.

## Product Purpose
Students open a lesson their teacher uploaded (.docx / .pptx / .pdf) and study it three ways: a sectioned review with Explain simpler and Filipino/Taglish rewrites, Anki-style flashcards, and mock quizzes built from those cards. Every study session, answer and self-monitoring tap is logged per participant code so the research can export it. Success: students come back to study on their own, and the logs are complete and trustworthy.

## Positioning
Everything is grounded in the lesson the teacher gave: key terms and flashcards carry an evidence quote from the lesson, and the AI may only use the lesson text. It runs on one laptop on local Wi-Fi for a classroom study, not as a cloud service.

## Operating Context
- Used in and after class on phones, often in short sittings; a flashcard sitting or a 10-question quiz is the typical unit.
- Several students share one host; each identifies with a participant code (P01, P02…).
- Bottom tab bar: Review, Flashcard, Mock Quiz, Stats; Settings behind a gear; Admin for the researcher only.

## Capabilities and Constraints
- React + Vite client, plain CSS with tokens in `client/src/styles/tokens.css`; Stats drawn in CSS; Motion for animation.
- Fonts are self-hosted (`@fontsource-variable` Literata + Hanken Grotesk) because students may be on local Wi-Fi only. No new font faces.
- Must stay light on budget phones: no heavy textures, large SVG backgrounds or expensive shadows.
- Visual work must not change logic, API, data or behaviour; all tests must keep passing.

## Brand Commitments
- Name: StudyRevr. Open source (MIT).
- The notebook concept: ruled paper, red margin line, highlighter yellow, ballpoint-blue ink; Literata for reading and headings, Hanken Grotesk for UI.
- Dark mode is "the same notebook at night", via `prefers-color-scheme` plus a manual toggle in Settings.
- Not cute or childish: no doodles, stickers, handwriting fonts or washi tape.

## Evidence on Hand
Real lessons and study data live in the git-ignored SQLite database; mockups use realistic but synthetic lesson titles and counts. No testimonials or results exist yet; none may be invented.

## Product Principles
1. The lesson is the source of truth; the interface shows where things came from.
2. Studying is the main act; research logging stays invisible to students.
3. Calm, honest feedback: no alarm colours for normal states, no gamified hype.
4. Works on the cheapest phone in the class over local Wi-Fi.

## Accessibility & Inclusion
WCAG 2.2 AA contrast in light and dark, visible focus, 44px tap targets, `prefers-reduced-motion` respected (every highlighter or swipe animation off), English UI with Filipino/Taglish rewrites of lesson content.
