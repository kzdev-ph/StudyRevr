# StudyRevr — current look, critique

> ⚠️ DEGRADED: single-context (you capped agents at 2 for design directions, so the design review and the detector pass ran here one after the other, design review first).

Screens: `design/screenshots/current/` (phone 380 px, light and dark; desktop 1440 px for Flashcards, the lesson and Stats). Captured with headless Edge on a copy of the database as P00, with reduced motion on.

Skills used: impeccable (critique + craft floor), avoid-ai-design (detector), design-critique heuristics, accessibility-review (contrast, targets, focus).

## Verdict
**Design specificity: weak.** Remove the wordmark and this could be any SaaS dashboard: navy ground, periwinkle buttons, rounded tiles, a yellow pill in the nav. The notebook idea survives in three small places only: the 2px red rule on the code card and quiz card, the yellow mark behind the active tab, and Literata headings. In dark mode it is gone; the navy `#0e1126` ground plus `#8f9cff` buttons reads "dark admin theme", not "notebook at night".

Health (Nielsen, 0–4): status 3 · real-world match 2 · control 3 · consistency 3 · error prevention 3 · recognition 3 · flexibility 3 · aesthetic/minimal 2 · error recovery 3 · help n/a. The structure and copy are good. The problems are visual identity and hierarchy, not usability.

## What's working
- The information architecture is clear: four tabs, one job per screen, honest plain-language copy ("About 4 min for today's cards").
- Stats already puts every number in words ("Most active day: Tuesday (1 min)") and has a table view.
- The reading column (Literata, about 17px, generous leading) is pleasant, and the red margin down the section is the one place the notebook shows.

## Priority issues
1. **[P1] Stats is a dashboard, not a notes page.** `stats.css` `.stats-card` (r-lg, sheet) wraps `.stat-tile`s (r-md, paper, border): a card inside a card, three levels deep with the page. It's the hero-metric template ("Total / 1 min" in a box). At 380px, "Total 1 min" takes a full-width tile and the three parts wrap 2+1, leaving a hole. *Fix:* write the week as sentences on ruled lines with the key numbers highlighted; one chart; no tiles.
2. **[P1] The nav highlighter is a Material pill.** `.tab__mark` is a 52×28px `border-radius:14px` capsule (`shell.css:76`); on desktop it fills the whole 46px row (`shell.css:122`). It reads as Material 3's "active indicator", not a highlighter. *Fix:* a low, slightly skewed swipe behind the **label** text, with uneven ends, used the same way on key numbers and key terms.
3. **[P1] Buttons don't read as ink.** Dark `--accent #8f9cff` with dark text is a pastel fill (`tokens.css:57`); light `#3040d8` is closer, but the 10px radius and the flat fill make it a generic app button. *Fix:* a saturated ballpoint-blue (or ink-coloured) fill with white text, a smaller radius, and secondary actions as underlined ink or a pen-outline.
4. **[P1] No ruled paper anywhere a student looks for it.** Lesson and deck lists use `--line` hairlines (`library.css:57`); there is no margin line in lists, and the "All lessons" deck (`.deck-all`) is a rounded box like every other box. *Fix:* lists on ruled lines with the margin; decks as index cards.
5. **[P2] Desktop wastes the screen.** From 56rem the main column is `max-width:52rem` hugging the left rail (`shell.css:132-137`). At 1440px the right 30% is empty and the nav is a floating list. *Fix:* centre the page and use the width (two-page spread or margin + notes columns).

## Smaller findings
- **Learning count in red** (`flashcards.css:24`, `--danger`): it copies Anki, but in this app red means error. Use an amber/pencil tone; keep green for Due.
- **Settings › Appearance fieldset** shows the browser's default 2px groove border, because `base.css` resets fieldset margin/padding but not `border` or `min-inline-size`.
- **"Researcher admin"** is a full accent link on the student's Settings screen (`SettingsScreen.jsx:45`). Agreed fix: move it to the foot of the code screen only, quietly.
- **Generic logo:** `LogoMark` is a rounded square with two lines and a yellow bar, the app-icon template.
- **Resume notice uses the warning style** (yellow box, ⚠ icon) for "Picking up where you left off", a neutral fact. It belongs in the info voice, not warn.
- **Quiz card:** a dark gutter sits left of the margin rule (`.quiz-card` padding plus the rule), so the rule floats inside the card instead of being the page's margin.
- **Empty states are dead:** "Finish a mock quiz to see your first and best score per lesson." sits in an empty rounded box. The notebook could show the empty ruled lines waiting to be filled.
- **Side stripes:** `.example` and `.check__answer` use 4px coloured `border-left` stripes (`review.css:196, 342`), the most recognisable generated-UI tell. Replace them with a highlighter or margin note.
- **Layout animation:** `.quiz-progress` animates `width` (`quiz.css:16`). Use `transform: scaleX`.
- **Focus ring** forces `border-radius:4px` (`base.css:57-61`), which squares pills and option cards (known Phase 5/6 carry-over).
- The detector also flags the bold **[term]** in the Yes/No question and the score in results as "one accented word". Both carry meaning; the redesign makes them deliberate highlighter swipes.

## Accessibility snapshot (current tokens)
Text contrast passes AA in both themes (ink 15.5:1 light, 16.2:1 dark; ink-2 6.6:1 light, 8.1:1 dark). Tap targets are ≥44px except `.btn--small` (40px, admin only). Focus is visible. Reduced motion is respected globally, but the Motion `layoutId` tab slide is JS-driven and is not covered by the CSS rule; check that it honours `useReducedMotion` in step 2.

## Personas
- **Casey (distracted, budget phone):** the Stats tiles scroll past 2.5 screens before Quiz scores; the notes-page version should fit the week on one screen.
- **Jordan (first-timer):** "Learning" in red looks like something went wrong.
- **Sam (keyboard / screen reader):** fine overall; the carry-overs in CLAUDE.md still apply.

Questions skipped: direction choice happens on the mockups (step 1 stops there).
