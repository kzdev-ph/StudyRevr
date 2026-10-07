# StudyRevr redesign

**Decision (step 2): Direction B, all modules, nothing from A**, with three changes before applying it: the dark-mode highlighter is a bright marker (#f4d548) over the word with dark text instead of a muddy amber stroke under pale ink; the phone reader uses a slim 14px margin so body text gets 338px; and every desktop screen uses the page width (two columns where a screen has two kinds of content). The app now implements it; `screenshots/after/` shows every screen in light and dark at 380px and 1440px.

## Step 1

Static mockups only. Nothing here is wired into the app, and no file under `client/` or `server/` changed.

- `critique.md`: what's wrong with the current look, with file and selector for each issue.
- `screenshots/current/`: the app today, phone 380px light/dark (code screen, Review, lesson, Flashcards, study, quiz list, quiz question, Stats, Settings) and desktop 1440px (Flashcards, lesson, Stats).
- `a-ruled-notebook/`: Direction A. `index.html` (4 screens × light/dark at 380px, contrast table, modular change list), `desktop.html` (Stats at desktop width; `?theme=dark` or the toggle).
- `b-study-journal/`: Direction B, same layout.
- `screenshots/a/`, `screenshots/b/`: captures of the mockups.
- `PRODUCT.md`: the product facts impeccable designs against (users, constraints, brand commitments).
- `shared/`: the board around the mockups and the script that renders each screen in both themes and computes contrast from the live tokens.

The mockups load Literata and Hanken Grotesk from Google Fonts; the app keeps its self-hosted fontsource packages. Neither direction adds a font face.

## The two directions in one line each

**A. Ruled notebook (literal).** Every screen is a ruled page: blue rules every 28px set the line height of all running text, a red double margin line runs top to bottom, decks are index cards with a red heading line, buttons are ballpoint ink, and a skewed highlighter swipe sits behind the active tab, key numbers and key terms. Desktop is an open two-page spread. Dark: graphite-blue paper, faint rules, warm off-white ink, saturated ink-blue buttons.

**B. Study journal with marginalia (quieter).** A plain page with a wide margin column where the important number is written large next to what it describes (due count beside each deck, answer keys, section number, the week's figures). Rules only under list rows; the reading column stays plain. Decks are small stacks of index cards. The highlighter is a marker stroke under the words. Desktop is one centred page with divider tabs on its edge. Dark: warm charcoal paper, pale ink, a glowing amber marker, pale-ink primary buttons.

## Mixing

Both change lists use the same module letters, so you can pick per module, e.g. "B's palette and margin column, A's index cards and highlighter swipe":

| | Module | A | B |
|---|---|---|---|
| a | Light palette | cool white paper, ballpoint blue #2a45c2 | grey-white paper, fountain-pen blue #233a8c, blue-black ink |
| b | Dark palette | graphite-blue #15171e, ink-blue button fill | warm charcoal #1b1a18, pale-ink button fill |
| c | Paper and rules | the whole page ruled, 28px rhythm | rules under list rows only |
| d | Margin | red double line, 32px | red single line at a 52px margin column holding numbers |
| e | Highlighter | skewed swipe behind words | marker stroke under words (glows at night) |
| f | Buttons | ink fill, pen outline | ink fill, ruled outline |
| g | Cards | index card with red heading line and blue rules | plain index card, stacked edges for decks |
| h | Navigation | swipe on the active label; desktop tabs in the header | divider tabs; desktop dividers on the page edge |
| i | Stats | ledger with dotted leaders, chart on the rules | days as ruled lines, figures large in the margin |
| j | Reader | text set on (lighter) rules, indented paragraphs | plain text, section number and sources in the margin |
| k | Desktop | two-page spread | centred page plus a second column |
| l | Logo | ruled page with a highlighter stroke | page with an "S" over a marker stroke |
| m | Empty states | blank rules with one written line | margin dash with one written line |
| n | Radii / shadow | cards 3px, buttons 5px, one card shadow | cards 2px, buttons 3px, one card shadow |

Exact token values (old → new, light and dark) are in each direction's `index.html` under "What Direction … changes".

Fixes that ship with either direction: the Learning count stops using red; the Appearance fieldset loses its default border; "Researcher admin" moves from Settings to the foot of the code screen; the resume notice uses a neutral note instead of the warning style; focus rings keep each element's corners; the quiz progress animates `transform`; every highlighter or swipe animation (including the Motion tab slide) is off under `prefers-reduced-motion`.
