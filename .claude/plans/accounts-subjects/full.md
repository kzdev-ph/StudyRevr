PLAN: accounts (email + password), one-device login, True/False display, any-subject support. Work folder: D:\claude\pr2\Research_application_pr2_after_chapter_3 (never the old folder)

# 1) Verdict and build order

All four requirements fit in about 8 working days if two lanes run at once.

- **Auth (A, C):** large but low-risk. Every route already gets the student's identity from one place: `participantOf` / `requireParticipant` in `server/src/middleware/participant.js`, which returns `{ id, code }`. If only that function changes, the 10 per-participant tables, stats, export and withdrawal keep working unchanged.
- **True/False (D):** small and client-only.
- **Subjects (B):** the real risk. Here is what the code shows today:
  - mammoth silently drops Word equations. `m:oMath` is an "unrecognised element" in `mammoth/lib/docx/body-reader.js`.
  - officeparser 8.1 (already locked) turns PowerPoint equations into bare LaTeX glued into the line (`PowerPointParser.js` ~l.747, `ommlToLatex`). Its Word parser can do the same, but we don't use it for docx.
  - PDF superscripts flatten ("10²³" becomes "1023").
  - The AI tends to write `$\frac{..}{..}$`, which would be shown raw and would fail the grounding check against `raw_text`.
  - Formula-only quotes fail the "3 explaining words" rule (`pipeline/evidence.js`).
  - The wrong-answer prompt forbids numbers that aren't in the lesson, so numeric wrong answers can't be made.
  - The leak checks mostly don't see numbers, because single characters are not content words.

**What "any subject" can honestly mean:** a lesson in any subject whose content is text reaches ready. That includes formulas typed as text or made with Office's equation tool. It gets grounded sections, cards and a quiz, and math shows as readable Unicode text (x², √, π, ½ written as 1/2). Content that exists only as pictures (scans, equation screenshots, graphs) is not read; the existing low-text warning covers it. The app never invents new practice problems: it drills the lesson's own definitions, formulas, symbols, steps and worked examples.

**Recommended approach: no subject picker, no new card kinds, no AI content classifier, no new dependency.**
- One pure converter turns LaTeX into Unicode. It is applied to the extracted text and to every AI reply, so grounding compares like with like.
- The math prompt rules switch on only when the text looks mathematical, so prompts for today's text lessons stay byte-identical.
- A few small code-check fixes for numbers.

**Ideas I rejected:**
- New card kinds: the `flashcards.kind` and `quiz_answers.kind` CHECK constraints would need table rebuilds, with ripples into about 15 files.
- KaTeX: a new dependency, and rendering in about 8 components.
- An AI classifier per section: costs extra calls against the 500/day quota for no gain.
- A subject picker: the content is detected instead.

**Order (risk first; Lane A and Lane S touch different files and can run in parallel):**

| Day | Lane S (subjects) | Lane A (auth) | Lane T |
|---|---|---|---|
| 1 | Step 1 (spike, needs your Google key), Step 3 (pure) | Step 2 | Step 4 |
| 2 | Step 6 | Step 5 | |
| 3 | Step 8 | Step 7 | |
| 4 | Step 10 | Step 9 (biggest client step) | |
| 5 | Step 14 (after-run) | Step 11 | |
| 6 | | Step 12 | |
| 7 | | Step 13, then full regression | |
| 8–10 | buffer and demo rehearsal | | |

**Files two lanes both touch** (merge in step order):
- `app.js`: Steps 5, 7, 11, 12
- `lesson-access.test.js`: Steps 7, 11
- `extraction.test.js`: Steps 6, 11
- `codebook.js`: Step 4 edits lines 136–141, Step 13 edits lines 7 and 113–114
- `CLAUDE.md` and `docs/`: Steps 4, 13

The app keeps working after every step. The server accepts the old `X-Participant` header until the client has switched to tokens (Step 9). Step 11 then removes that header, and that removal can never be cut.

**Two problems with the agreed design (corrections, not re-litigation):**
- **Timeout setting logging.** `setting_events.participant_id` is NOT NULL (migration 011), so an admin setting can't be logged there. `show_taglish` and `lesson_thinking` are actually logged in `admin_events` (`setting_changed`, `key=value`, `routes/settings.js:30`). The plan logs `session_timeout_seconds` the same way.
- **Students can see their study ID today.** `GET /api/stats` returns `participant: <code>` (`stats/participant.js:67`), so the ID is visible in a student's own responses. Step 11 removes it.

---

## Step 1: Subjects spike — sample lessons and a baseline run
What: Make 5 sample lessons (math, physics, chemistry, history, literature), run each through today's pipeline, and record where each stage breaks.
For: sonnet-high-applier (uses the real AI, about 80 of the 500 daily requests)
Depends on: none

**Setup:**
- In D:\claude\pr2\Research_application_pr2_after_chapter_3: if `node_modules` is missing, run `npm ci` in the repo root only.
- If `.env` is missing, copy `.env.example`. GOOGLE_API_KEY must be filled by the user; if it is empty, stop and say so.

**Files:**
- NEW `server/scripts/make-subject-samples.js` (ES module dev tool). It writes into `test-lessons/subjects/` (gitignored) using the existing devDependencies `docx`, `pptxgenjs`, `pdf-lib` and the dependency `jszip`:
  1. `math-quadratics.docx`, about 300 words.
     - Definitions: quadratic equation, roots, discriminant.
     - Real Word equations built with docx `Math` / `MathRun` / `MathFraction` / `MathSuperScript` / `MathRadical`: ax²+bx+c=0, the quadratic formula, D=b²−4ac.
     - A numbered list of 4 factoring steps.
     - A worked example x²−5x+6=0 → (x−2)(x−3)=0 → x=2 or x=3, with these lines also as Word equations.
  2. `physics-newton.pptx`, 6 slides.
     - Formulas typed as text: "F = ma", "a = Δv/Δt", "W = mg", plus units N, kg, m/s².
     - A worked example: m = 5 kg, a = 2 m/s² → F = 10 N.
     - Speaker notes on 2 slides.
     - On slide 3, a real Office equation. Put a run with the text EQ_PLACEHOLDER on the slide, then use JSZip to replace that `<a:r>…</a:r>` in `ppt/slides/slide3.xml` with:
       `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main" Requires="a14"><a14:m><m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:oMath>…</m:oMath></m:oMathPara></a14:m></mc:Choice><mc:Fallback/></mc:AlternateContent>`
       The `<m:oMath>` holds KE = ½mv² (`m:f` for 1/2, `m:sSup` for v²).
  3. `chemistry-moles.pdf`, 2 pages, pdf-lib Helvetica.
     - WinAnsi characters only: no π, √ or →.
     - Avogadro's number drawn as "6.022 × 10", with "23" as a separate smaller raised text, the way real PDFs do it.
     - Molar mass of H2O and CO2, with a worked example (44.01 g/mol).
     - A 3-item list.
  4. `history-katipunan.pptx`, 6 text slides: Katipunan 1892, Bonifacio, Cry of Pugad Lawin 1896, a list of 4 causes, Tejeros 1897; notes on 2 slides.
  5. `literature-poem.docx`: "The Road Not Taken" (1916, public domain) in full, then imagery / metaphor / symbolism / tone defined, then a short analysis.
- `server/scripts/run-pipeline.js` additions:
  - `--show-text`: print `raw_text` after the "Extracted…" line.
  - `--save=<file.db>`: `fs.writeFileSync(file, db.serialize())` after the run.
  - Always print at the end:
    - (a) `formatReport(lessonLeakReport(db, lessonId))` from `src/quiz/check.js`, which prints "Clean questions available: N of 10".
    - (b) "LaTeX leftovers: N": student-facing stored texts (`sections.content`, `check_questions`, `key_points.text`, `key_terms.term`/`definition`, `flashcards.front`/`back`, `quiz_distractors.choices`) matching `/\\[a-zA-Z]+|\$[^$\n]+\$|\^\{|_\{/`, with up to 5 listed.

**Run:**
- `node server/scripts/make-subject-samples.js`
- For each file: `npm run pipeline -- test-lessons/subjects/<file> --show-text --save=test-lessons/subjects/out/<name>.db > test-lessons/subjects/out/<name>.log 2>&1`
- Also run every file the user put in `test-lessons/subjects/real/`.

**Hand back a table** with one row per lesson:
- ready / failed
- each equation as it appears in `raw_text` (quote it)
- counts of sections, key terms, term cards and concept cards
- cards dropped, by reason
- outcome of the `quiz_options` and `quiz_review` stages
- clean questions N of 10, split into multiple choice and true/false
- LaTeX leftovers
- anything a student couldn't read

**Expected, from reading the code:** the docx equations go missing; the pptx equation appears as bare LaTeX; PDF superscripts are flattened; formula quotes are dropped; numeric questions fall back to true/false or are skipped.

Tests: none. `npm test` in `server/` still passes.
Done-check: 5 sample files, 5 logs, and the table handed back.
Do NOT touch: `server/src/**` (no fixes in this step). Do not commit `test-lessons/` or `.env`.

---

## Step 2: Auth data model and store (server; no routes yet)
What: Migrations for accounts and login sessions, new study-session end reasons, and pure modules for passwords, accounts and login sessions.
For: sonnet-high-applier
Depends on: none

**Files:**
- NEW `server/src/db/migrations/018_accounts.sql` (header comments in the style of 008):
```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,                 -- trimmed + lowercased in code
  password_hash TEXT NOT NULL,                -- scrypt$16384$8$1$<salt b64url>$<hash b64url>
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  lockouts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  password_changed_at TEXT);
CREATE TABLE auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,            -- sha256 hex; the token itself is never stored
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IN ('signed_out','signed_out_elsewhere','signed_out_by_admin','password_reset')));
CREATE UNIQUE INDEX idx_auth_sessions_one_active ON auth_sessions(account_id) WHERE revoked_at IS NULL;
```
- NEW `019_session_end_reasons.sql`: rebuild `study_sessions` exactly as in 008 (same columns, foreign keys, both indexes). The only change is:
  `end_reason CHECK (end_reason IN ('left','idle','background','switched','signed_out','signed_out_elsewhere','signed_out_by_admin'))`
  Copy rows with explicit columns, id included.
- NEW `server/src/auth/passwords.js` (node:crypto only; no new dependency):
  - `hashPassword(pw)`: async scrypt, N=16384, r=8, p=1, keylen 64, 16-byte salt.
  - `verifyPassword(pw, stored)`: async; a malformed hash returns false; compares with timingSafeEqual.
  - `verifyDummy(pw)`: checks against a hash made lazily once, so unknown emails take as long as real ones.
  - `temporaryPassword()`: 10 characters from `abcdefghjkmnpqrstuvwxyz23456789`, chosen with `crypto.randomInt`.
  - `PASSWORD_MIN = 8`, `PASSWORD_MAX = 200`.
- NEW `server/src/auth/accounts.js`:
  - `normalizeEmail`, `findAccountByEmail`, `findAccountByCode`.
  - `nextStudyCode(db)`:
    - n = the larger of the settings row `last_study_number` and the highest number among participants other than P00, plus 1.
    - Above 999 → HttpError 503 `signups_full`.
    - Writes `last_study_number`, so a withdrawn ID is never reused.
  - `createAccount(db, { email, passwordHash, now })`, in one transaction:
    - an email that is taken → 409 `email_taken` "An account with this email already exists. Sign in instead."
    - otherwise get the next code, INSERT the participant, INSERT the account, and return `{ accountId, participantId, code }`.
  - Lockout:
    - `MAX_FAILED = 5`, `LOCK_BASE_MS = 60_000`, `LOCK_MAX_MS = 900_000`.
    - `lockedMs(account, now)`.
    - `recordFailedLogin(db, account, now)`: at the 5th failure, `locked_until` = now + min(BASE·2^lockouts, MAX); `lockouts` + 1; `failed_logins` back to 0. Returns `{ lockedMs }`.
    - `clearFailedLogins(db, accountId)`.
  - `setPassword(db, accountId, hash, { mustChange, now })`.
- NEW `server/src/auth/sessions.js`:
  - `newToken()`: 32 random bytes, base64url.
  - `tokenHash(t)`: sha256 hex.
  - `createAuthSession(db, accountId, now)`: returns the token.
  - `findByToken(db, token)`: returns `{ id, account_id, participant_id, code, email, must_change_password, last_seen_at, revoked_at, revoked_reason }` or null.
  - `activeSession(db, accountId)`.
  - `touch(db, session, now)`: writes `last_seen_at` only when it is at least `TOUCH_MS = 10_000` old.
  - `revokeSessions(db, { accountId, participantId, reason, now })`, in one transaction:
    - revoke the active row;
    - call `endOpenSessions` with the matching study-session reason: `signed_out` → `signed_out`; `signed_out_elsewhere` → `signed_out_elsewhere`; `signed_out_by_admin` and `password_reset` → `signed_out_by_admin`.
    - Returns how many were revoked.
- `server/src/sessions/store.js:10`:
  - `END_REASONS` (what the app may send) becomes `['left','idle','background','switched','signed_out']`; `switched` goes in Step 11.
  - Add `SERVER_END_REASONS = ['signed_out_elsewhere','signed_out_by_admin']`.
  - Add `endOpenSessions(db, { participantId, reason, now })`:
    `UPDATE study_sessions SET ended_at = last_active_at, end_reason = ? WHERE participant_id = ? AND ended_at IS NULL AND last_active_at >= now − STALE_MS`
    Older open rows stay as they are and keep reading as `unclosed`.
  - In `routes/sessions.js:61`, build the 400 message from `END_REASONS`.

**Tests:**
- NEW `server/test/auth-store.test.js`:
  - a hash round trip works; a wrong password and a malformed hash return false; two hashes of the same password differ; the temporary password has the right shape
  - the first two accounts get P01 and P02, and P00 is never handed out; after P02's participant is deleted, the next signup gets P03
  - "JUAN@x.com " and "juan@x.com" collide with 409
  - a second un-revoked `auth_sessions` row for one account throws
  - `revokeSessions` sets the reason, ends a study session last active 1 min ago with that reason, and leaves one last active 10 min ago open
  - lockout: 5 failures lock for 60 s; after that expires, 5 more lock for 120 s; the wait caps at 15 min; `clearFailedLogins` resets everything
- NEW `server/test/migration-019.test.js`: an existing row survives with its id; `signed_out_elsewhere` is accepted; `bogus` is rejected.

Done-check: `npm test` in `server/` is green.
Do NOT touch: migrations 001–017, the middleware, other routes, the client.

---

## Step 3: Math text converter (pure)
What: One module that turns LaTeX (from Office equations and from AI replies) into readable Unicode, detects math-heavy text, and compares numeric values.
For: sonnet-high-applier
Depends on: none

**File:** NEW `server/src/services/math-text.js` (no dependencies). Exports:

- **`latexToText(latex)`:**
  - **Unescape** what officeparser escapes: `\% \$ \# \_ \{ \} \&`, `\textbackslash{}`, `\textasciitilde{}`, `\textasciicircum{}`.
  - **Fractions** (`\frac`, `\dfrac`, `\tfrac`) become `a/b` when both parts are single tokens without spaces or operators. Otherwise they become `(a)/(b)`. A simple fraction directly followed by a letter, digit, `(` or `√` becomes `(a/b)`: `\frac{1}{2}mv^{2}` → `(1/2)mv²`.
  - **Superscripts** (`^{…}` / `^x`) use superscript characters when every character has one (0–9, + − = ( ) n i, and the modifier letters); otherwise `^(…)`. `^{\circ}` becomes °.
  - **Subscripts** (`_{…}`) use subscript characters when every character has one (0–9, + − = ( ), a e o x h k l m n p s t i j r u v); otherwise `_(…)`.
  - **Roots:** `\sqrt{x}` → `√x` for a single token, else `√(…)`. `\sqrt[n]{x}` → `ⁿ√(x)`.
  - **Greek letters**, upper and lower case, and the `\var…` forms.
  - **Symbols:** × ÷ · ± ∓ ≤ ≥ ≠ ≈ ≡ ∝ ∞ → ← ⇒ ↔ ⇌ ° ∠ ⊥ ∥ △ ∂ ∇ ∑ ∏ ∫ ∮ ∈ ∉ ⊂ ⊆ ∪ ∩ ∅ ∀ ∃ … ′, from their usual commands (`\times`, `\le`/`\leq`, `\to`/`\rightarrow`, `\ldots`/`\dots`/`\cdots`, and so on).
  - **Function names** `\sin \cos \tan \log \ln \lim \max \min \exp` become the plain word.
  - **Limits on operators:** `\lim_{x\to a}` → `lim(x→a)`, `\sum_{i=1}^{n}` → `∑(i=1 to n)`, `\int_{a}^{b}` → `∫(a to b)`.
  - **Delimiters:** `\left`/`\right` are dropped and the delimiter kept; `\left.` becomes nothing.
  - **Text wrappers** `\text \mathrm \mathbf \mathit \operatorname` become their content.
  - **Accents:** `\bar`/`\overline` on one character adds U+0304, and on longer content gives `‾(…)`. `\hat` adds U+0302, `\vec` U+20D7, `\dot` U+0307.
  - **Spacing:** `\, \; \: \! \quad \qquad ~` become one space or nothing.
  - **Matrices** become `[a, b; c, d]`; `\\` becomes `; `.
  - **Anything else:** an unknown `\cmd` becomes `cmd`; leftover braces are removed; spaces are collapsed.
  - No spaces are added around operators.
- **`mathText(text)`:** converts only clear LaTeX:
  - `$$…$$`;
  - `$…$`, only when the inside holds `\`, `^`, `_` or `{` and has no newline;
  - `\(…\)` and `\[…\]`;
  - bare spans that start with a known command or with `^{` / `_{`.
  - Any other text comes back as the identical string.
- **`mathTextDeep(value)`:** applies `mathText` to every string inside a JSON value.
- **`looksMathy(text)`:** true with at least 3 hits. A hit is any of:
  - a line with an equation, matching `[\p{L}\p{N})\]]\s*(=|≤|≥|≈|<|>|→|⇌)\s*[\p{L}\p{N}(√−-]`;
  - any of `√ π ∑ ∫ ± × ÷ ² ³ ⁴–⁹ ₀–₉ Δ`;
  - a number with a unit: m/s, m/s², km/h, kg, g/mol, mol, N, J, W, Pa, °C, K, cm, mm, km, mL, L, s.
- **`isMathAnswer(text)`:** at most 12 words; has a digit, an equation sign or a math symbol; and has fewer than 3 words of 4 or more letters.
- **`mathKey(text)` and `sameValue(a, b)`:**
  - `mathKey`, in this order:
    1. Superscript and subscript digits become `^n` / `_n` first, so "10²" ≠ "102".
    2. Apply NFKC and lowercase.
    3. `−` → `-`; `×` and `·` → `*`.
    4. Drop spaces and a final full stop.
    5. Each number becomes `String(Number(n))` ("10.0" → "10", "1,000" → "1000").
    6. A fraction of two integers becomes its decimal; this also covers "½" after NFKC.
  - `sameValue(a, b) = /\d/.test(a) && mathKey(a) === mathKey(b)`.

**Tests:** NEW `server/test/math-text.test.js`, at least one case per rule, plus exact strings:
- `x=\frac{-b\pm\sqrt{b^{2}-4ac}}{2a}` → `x=(-b±√(b²-4ac))/2a`
- `KE=\frac{1}{2}mv^{2}` → `KE=(1/2)mv²`
- `F=ma` is unchanged
- `$x^{2}$` → `x²`
- "It costs $5 and $10." is unchanged
- an English PR2-style paragraph and a Filipino paragraph come back `===` and `looksMathy` is false for both; it is true for a physics slide text
- `sameValue("10 N","10.0 N.")` is true; `("10 N","12 N")` false; `("0.5","1/2")` true; `("10² m","102 m")` false

Done-check: server tests are green.
Do NOT touch: any other file.

---

## Step 4: True/False display (client only, plus docs)
What: Every true/false question shows "True or False", then "Question: <one statement>", then [True] [False]. No Yes/No, "Does this match?" or "Is this the answer?" anywhere.
For: sonnet-high-applier
Depends on: none

**`client/src/lib/quiz.js`:**
- `questionLead`: tf → `'True or False'` for both kinds (line 24).
- Remove `yesNoAsk` and `yesNo` (lines 30–48).
- Add `lowerFirst(text)`. It lowercases the first letter only when the first word is:
  - a common opener (A, An, The, It, Its, This, That, These, Those, Any, Each, Every, One, Some, To, When, How, What, Which, Who, Where, In, On, For, By, With, From, Ang, Mga, Isang, Ito), or
  - a capitalised -ing word.
  - Names, acronyms and pH are left alone.
- Add `tfStatement(q)`. `endSentence` adds "." when the text doesn't end in `.!?` (a closing quote or bracket is allowed):
  - term: `` `${q.question} means ${lowerFirst(endSentence(q.statement))}` ``
  - concept: `` `${endSentence(q.question)} ${capitalFirst(endSentence(q.statement))}` ``
- `questionText(q)` for tf returns `tfStatement(q)`.

**`client/src/components/QuizQuestion.jsx`:**
- The tf branch (lines 49–60) renders only:
  `<h2 id="quiz-q-text" className="quiz-q__question" tabIndex={-1} ref={headingRef}><span className="quiz-q__for-label">Question:</span> {tfStatement(q)}</h2>`
- The group uses `aria-labelledby="quiz-q-text"`.
- Line 86 becomes `capitalFirst(choice)` for every question type.
- Drop the `ask` variable and the old imports.

**`client/src/components/QuizResults.jsx` (lines 42–45, 96):**
- The right answer is "True"; or `False. ` + (term card: `${m.question} means: `, otherwise `The right answer: `) + `answer_text`.
- The student's answer is shown as stored.

**Other files:**
- `client/src/styles/quiz.css:228`: change the comment to "true / false: two boxes side by side". Remove `.quiz-q__prompt` and `.quiz-q__for` only if a grep shows nothing else uses them; keep `.quiz-q__for-label`.
- `client/test/quiz.test.js:32-64`: replace the Yes/No tests:
  - lead is 'True or False' for both kinds
  - `tfStatement` of term ('Sampling', 'Picking part of a population to study') → 'Sampling means picking part of a population to study.'
  - concept ('Why sample?', 'to save time') → 'Why sample? To save time.'
  - `lowerFirst` keeps 'DNA…', 'pH…', 'Filipino…'
  - `questionText(tf) === tfStatement`
  - the module exports no `yesNo`
- Docs and codebook:
  - `docs/quiz.md:16`: rewrite the true/false sentences.
  - `CLAUDE.md:67`: "True/False display … stored and exported values stay True/False".
  - `server/src/export/codebook.js:136-141`: true/false questions are shown as "True or False" with "Question:" and one statement ("<term> means <definition>" for a term card; the card's question followed by the suggested answer for a concept card); choices, chosen_answer and right_answer stay True or False.

Done-check: `npm test` at the root is green. Manually, a true/false question shows the three lines and the results list says True/False.
Do NOT touch:
- `server/src/quiz/*`: TF_CHOICES in `build.js:33` and the 'Yes/No:' detail in `check.js:60`
- `quiz-review.test.js:114`
- the AI prompts (`prompts.js:338,348`, `prompts-haiku.js:141`; reviewer-facing only, see decision D15)
- `docs/CLAUDE-full.md` and `docs/history.md`

---

## Step 5: Token auth in the middleware (old code header kept for now) and test helpers
What: Study requests are identified by `Authorization: Bearer <token>`; the identity check, its error codes and last-seen updates live in one place.
For: sonnet-high-applier
Depends on: 2

**`server/src/middleware/participant.js`:**
- `participantOf(db, req)` is memoised per request (a WeakMap keyed by `req`):
  1. **Bearer token present.** Look it up with `findByToken`.
     - Not found → 401 `session_unknown` "Please sign in again."
     - Revoked → 401, with the code taken from `revoked_reason` (`signed_out` maps to `session_unknown`):
       - `signed_out_elsewhere`: "You were signed out because your account was opened on another device."
       - `signed_out_by_admin`: "Your teacher signed you out. Sign in again."
       - `password_reset`: "Your teacher reset your password. Sign in with the new one."
     - `must_change_password` → 403 `password_change_required` "Choose a new password first."
     - Otherwise `touch(db, session, now)`, with `now = req.app.get('clock')?.() ?? new Date()`, and return `{ id: participant_id, code, accountId, sessionId }`.
  2. **LEGACY, removed in Step 11 (say so in a comment):** no Authorization header but `X-Participant` present → behaviour unchanged from today.
  3. **Neither** → null.
- Export `sessionOf(db, req)`: the same Bearer lookup and 401s, but without the must-change gate (for the `/auth` routes).
- `requireParticipant`: null → 401 `auth_required` "Sign in first."

**Other files:**
- `server/src/app.js`: `app.set('clock', clock)` right after `express()`.
- `server/test/helpers.js`:
  - `tokenFor(db, code, now)`, cached per db:
    - a missing participant gives `'no-such-token'`;
    - otherwise create, if missing, an account (`<code lowercased>@test.invalid`, `password_hash 'test'`) and an active session (`createAuthSession`), and return the token.
  - `t.call({ as })` sends `authorization: Bearer ${tokenFor(t.db, as, new Date(t.now))}` instead of x-participant.
  - Add `TEST_TOKEN = 'test-token-p00'` and `seedTestLogin(db)`: a P00 account plus an active session whose `token_hash = tokenHash(TEST_TOKEN)`. These are used in Step 11.
  - `STUDY_HEADERS` is unchanged for now. Update the comments at lines 57–66.
- Fix the assertions that name the old identity codes:
  - `lesson-access.test.js:159`: 'participant_required' → 'auth_required'.
  - In `participants.test.js`, only where a test sends no identity (→ `auth_required`) or an unknown code through `as` (→ `session_unknown`). Tests of `/api/participants/:code` stay as they are.

**Tests:** NEW `server/test/auth-middleware.test.js`:
- a token works on GET `/api/stats` and POST `/api/sessions`
- an unknown token → 401 `session_unknown`
- each revoke reason → 401 with its code
- `must_change` → 403
- `last_seen_at` moves only after 10 s on the fake clock
- a valid token plus `X-Participant: P02` acts as the token's participant

Done-check: server and client tests are green; the running app still works with codes.
Do NOT touch: `middleware/admin.js`, the client, the routes.

---

## Step 6: Equations survive extraction
What: Word and PowerPoint equations reach `raw_text` as readable Unicode, and typed LaTeX in any file is converted.
For: sonnet-high-applier
Depends on: 3

**`server/src/services/pptx.js`:**
- Add `nodeText(node)`. When a descendant is `{ type: 'code', metadata: { math } }`, build the text from the children:
  - text nodes as they are;
  - math nodes as `` ` ${latexToText(child.text)} ` ``;
  - nested children recursively.
- Otherwise return `node.text` unchanged, so lessons without equations take the old path.
- Use `nodeText` for paragraph/heading, list and table cells in `nodeLines`. Export `nodeLines`.
- **Before writing code:** log the AST of the Step 1 pptx fixture (or one made in the test) and confirm each run appears exactly once. officeparser 8.1 `PowerPointParser.js` ~l.762 also appends the LaTeX to `paragraph.text`, so never use both.

**`server/src/services/extract.js` (docx):**
- Read `word/document.xml` with JSZip. If it matches `/<m:oMath[\s>]/`, use `extractDocxWithMath(buffer)`:
  - `OfficeParser.parseOffice(buffer, { fileType: 'docx', ignoreNotes: true, ignoreHeadersAndFooters: true })`;
  - for each `ast.content` node of type paragraph, heading, list or table, `nodeLines(node)`; any other node type is skipped;
  - every line is its own block (`join('\n\n')`), keeping the docx rule that every paragraph is its own block.
- If that throws, log a warning and fall back to mammoth.
- Without equations: mammoth exactly as today.

**`extractText` (all file types):** `raw = mathText(raw)` before `normalizeText`.

**Tests in `server/test/extraction.test.js`:**
1. A docx built with docx `Math` ("The area is " + A=πr² using MathSuperScript, and a MathFraction 1/2) → the text holds "A=πr²" and "1/2" with the surrounding words in order, and no backslash. The existing docx tests stay byte-identical.
2. A pptxgenjs deck patched with OMML as in Step 1 → the slide line equals the exact `latexToText` output for ½mv² ("KE=(1/2)mv²"), with no backslash.
3. A PDF with "x^{2}" typed literally → "x²".

Done-check: server tests are green; re-run `npm run pipeline -- test-lessons/subjects/math-quadratics.docx --show-text` and paste the equation lines.
Do NOT touch: the mammoth path for docx without equations, the PDF reflow, source numbering, `zipguard.js`.

---

## Step 7: Auth routes — signup, login, one-device, lockout, timeout setting
What: The account API, with a growing per-account lockout stored in the database and one active login per account.
For: sonnet-high-applier
Depends on: 5

**NEW `server/src/routes/auth.js`, `authRouter({ db, clock })`.** Mount it in `app.js` with `mount('/api', authRouter({ db, clock }))`.

Request bodies use zod strict objects:
- signup: `{ email: trimmed, lowercased z.email() max 254, password: min 8 max 200 }`
- login: `{ email, password: min 1 max 200, takeover?: boolean }`
- password: `{ current: min 1, next: min 8 max 200 }`
- Anything invalid → 400 with a plain message.

**`POST /auth/signup`:**
- `signupsAllowed(db)` false → 403 `signups_off` "Sign-ups are closed. Ask your teacher."
- In-memory limit per IP: 10 per 10 min → 429 `signup_rate_limited`.
- Hash the password, `createAccount`, `createAuthSession` → 201 `{ token, account: { email, must_change_password: false } }`.
- The study ID is never in the response.

**`POST /auth/login`:**
- No account for the email → `verifyDummy`, then 401 `login_failed` "Email or password is wrong."
- Account locked → 429 `login_locked` "Too many wrong passwords. Try again in N min." plus `retry_after_s`. The password is not checked.
- Wrong password → `recordFailedLogin` → 401 `login_failed`, or 429 if this try triggered the lock.
- Right password → `clearFailedLogins`, then in one transaction:
  - `active = activeSession(...)`;
  - if `active` exists, now − `last_seen_at` < `sessionTimeoutSeconds(db)`·1000, and `takeover` is not set → 409 `active_elsewhere` "This account is active on another device. Continue here?" No token is issued and nothing changes.
  - else if `active` exists → `revokeSessions('signed_out_elsewhere')`, which also ends that device's open study sessions;
  - then `createAuthSession` → 200 `{ token, account: { email, must_change_password } }`.

**The other routes:**
- `POST /auth/logout` (uses `sessionOf`): `revokeSessions('signed_out')` → 204.
- `GET /auth/me` (uses `sessionOf`, which touches `last_seen`; this is the presence ping) → `{ account: { email, must_change_password } }`.
- `POST /auth/password` (uses `sessionOf`):
  - wrong current password → 401 `wrong_password` "That isn't your current password.";
  - otherwise set the new hash, clear `must_change_password`, and answer 204. The session stays.

**`server/src/services/settings.js`:**
- `DEFAULT_SESSION_TIMEOUT_S = 60`.
- `sessionTimeoutSeconds(db)`: a whole number from 30 to 1800, else 60.
- `signupsAllowed(db)`: `getBoolSetting('allow_signups', true)`.
- Add `session_timeout_seconds: z.number().int().min(30).max(1800).optional()` and `allow_signups: z.boolean().optional()` to `appSettingsBody`, `describeAppSettings` and `saveAppSettings`. PUT `/api/settings` then writes `admin_events setting_changed session_timeout_seconds=45` (admin settings are logged there, not in `setting_events`).

**Liveness.** "Active elsewhere" is judged from `auth_sessions.last_seen_at`: the time of the last authenticated request made with that token (any route), written at most every 10 s.
- The client pings `GET /auth/me` every 20 s, and only while the tab is visible (Step 9).
- The 30 s study heartbeat counts too, but nothing relies on it: it runs only on study screens and stops after 5 min idle.
- A hidden or closed device stops counting after the timeout.
- A token never expires by time. The same device returning with its token just continues.

**`server/test/lesson-access.test.js` NOT_LESSON_ROUTES:** add 'POST /auth/signup', 'POST /auth/login', 'POST /auth/logout', 'GET /auth/me', 'POST /auth/password'.

**Tests:** NEW `server/test/auth-routes.test.js` (use startStudyApp and move `t.now`):
- signup gives a token that works on `/api/stats`, and the body has no `/P\d/`
- a duplicate email in other case → 409; signups off → 403
- 5 wrong passwords → 429; after 61 s, login works; a second lock lasts 120 s
- another session seen within 60 s → 409; the same login with `takeover` → 200; the old token → 401 `signed_out_elsewhere`; the old device's open study session gets `end_reason` `signed_out_elsewhere`
- after the old session has been idle longer than the timeout → 200 with no prompt
- a token used again 3 days later on the same device still works
- logout → the token gives 401 and the open study session is `signed_out`
- `me` and `password`
- PUT `/api/settings {session_timeout_seconds:45}` with the PIN → an `admin_events` row; 20 → 400

Done-check: server tests are green.
Do NOT touch: the client, `middleware/admin.js`, `routes/participants.js` (removed in Step 11).

---

## Step 8: Math in AI replies and prompts
What: No LaTeX ever reaches a student, and math lessons get math-aware instructions. Prompts for non-math text stay byte-identical.
For: sonnet-high-applier
Depends on: 3

**`server/src/ai/client.js` (~l.406):** `value = mathTextDeep(parseJsonReply(content))`, before zod validation. This covers processing and live calls.

**`server/src/ai/prompts.js`:**
- Export these rule texts:
  - **MATH_TEXT:** "- Math: write formulas, numbers, units and symbols exactly as the lesson text writes them, as plain text with Unicode symbols (x², v₀, √, π, ×, ÷, ±, ≤, ≥, →, °) and fractions as a/b. Never use LaTeX, dollar signs, backslash commands or markdown."
  - **MATH_TERMS:** "- A term may be the name of a formula or quantity the lesson defines ("Kinetic energy", "Discriminant"); its definition says what it is and may end with the formula as the lesson writes it."
  - **MATH_CARDS:** "- This lesson has formulas or worked examples. Besides concepts, make cards that ask: which formula the lesson gives for a quantity (the answer is the formula as the lesson writes it); what a symbol in a formula stands for and its unit; the next step of a method the lesson shows; and the result of a worked example the lesson itself solves (the question gives the example's values, the answer is the lesson's own result with its unit, and the evidence quote holds that result). Never make up a new problem or new numbers, and never give a result the lesson does not show."
  - **MATH_OPTIONS:** "- When the correct answer is a number with a unit, a formula or an expression, each wrong answer is the same kind of thing in the same format (a number with the same unit; a formula with the same symbols), the result of a common mistake: a wrong operation, a missing square, root or factor, swapped quantities, a wrong unit conversion or a sign error. These wrong answers may use numbers that are not in the lesson (the one exception to rule 1), but must never equal the correct answer in another form (0.5 and 1/2 are the same answer)."
- Add `mathRules(text, ...rules)`, which returns `''` unless `looksMathy(text)`.
- Insert the rules into these prompts:

| Prompt | Rules added (only for math text) |
|---|---|
| `sectionsPrompt` | MATH_TEXT, plus "Keep each worked example's steps in order with its numbers and units." |
| `keyTermsPrompt` | MATH_TEXT, MATH_TERMS |
| `flashcardsPrompt` | MATH_TEXT, MATH_CARDS |
| `quickChecksPrompt`, `regenerateCardPrompt`, `regenerateCardsPrompt` | MATH_TEXT |
| `simplifyPrompt`, `translatePrompt` | MATH_TEXT (checked against the section content) |
| `distractorsPrompt` | MATH_TEXT and MATH_OPTIONS, when any card answer passes `isMathAnswer` |

**Client:**
- `client/src/styles/tokens.css`: in `--font-read` and `--font-ui`, add `'Cambria Math', 'STIX Two Math', 'Noto Sans Math'` before the generic family. This is a glyph fallback, not a colour or radius.
- Make sure `.prose`, the flashcard faces and `.quiz-opt__text` have `overflow-wrap: anywhere`; add it where it is missing.

**Tests:**
- `ai.test.js`: a scripted reply `{"answer":"$x^{2}$","n":1}` comes back as "x²".
- `content-prompts.test.js`:
  - a physics chunk gets the rules;
  - every existing prompt test text gets none (assert the system text doesn't include MATH_TEXT);
  - `distractorsPrompt` with answer "10 N" includes MATH_OPTIONS, and with "Builds confidence" it doesn't.

Done-check: tests are green; `npm run pipeline` on `physics-newton.pptx` → LaTeX leftovers 0.
Do NOT touch: `prompts-haiku.js`, `claude-exchange.js` (the Claude-import path), the existing rule texts (KEEP_MEANING etc.), `quizReviewPrompt`.

---

## Step 9: Client accounts — sign in and sign up, token on every request, presence, sign out
What: Students sign up and sign in with email and password, the token goes on every study request, the takeover prompt works, and the old device returns to the sign-in screen.
For: sonnet-high-applier
Depends on: 7

**NEW `client/src/lib/auth.js`:**
- **Token:** stored with `storedValue('studyrevr.auth-token', local)`; exports `getToken`, `setToken`, `useSignedIn`. A `storage` event for that key notifies subscribers, so all tabs sign in and out together. Add a notify hook to `lib/store.js` if needed, without changing its API.
- **Account (memory):** `setAccount`, `useAccount`, `useMustChangePassword`.
- **Signed-out notice:** kept in sessionStorage `studyrevr.signed-out`; `takeSignedOutNotice()` returns the message once. Use the server's texts for `signed_out_elsewhere`, `signed_out_by_admin` and `password_reset`.
- **`onBeforeSignOut(fn)`:** the handler may return a promise.
- **`async signOut()`:**
  1. run the handlers and await them for at most 2 s;
  2. `await api.logout()`, ignoring errors;
  3. `setToken(null)`, `setAccount(null)`, `lockAdmin()`.
- **`signedOutByServer(code)`:** clears the same state, stores the notice, and makes no server call.

**`client/src/lib/api.js` (~l.17–33):**
- `headersFor`: `const token = admin ? null : as ?? getToken()`. If there is a token, send `authorization: Bearer <token>`. Never send `x-participant`. Admin calls send the PIN and no token.
- `onRefused`:
  - 401 with `auth_required`, `session_unknown`, `signed_out_elsewhere`, `signed_out_by_admin` or `password_reset` → `signedOutByServer`;
  - 403 `password_change_required` → mark must-change;
  - `admin_pin` as today.
- Remove `checkParticipant`. Add `signup`, `login({ email, password, takeover })`, `logout`, `me(signal)`, `changePassword`.

**Study-session closing:**
- `client/src/lib/session.js`: `send`, `end` and `close` return the promise of the last report. The comment says `'signed_out'`.
- `client/src/hooks/useStudySession.js`: `who = getToken()`; `onBeforeSignOut(() => t.close('signed_out'))`.
- NEW `client/src/hooks/usePresence.js`: while signed in and visible, call `api.me()` at once and then every 20 s; pause while hidden; store the account from each reply.

**NEW `client/src/screens/AuthScreen.jsx`** (replaces ParticipantScreen; reuse its `gate` markup and `participants.css`):
- **Sign in:**
  - email field: type=email, autocomplete=email, autoCapitalize=none
  - password field with a 44 px Show/Hide toggle
  - "Sign in" button, a "Create an account" link-button, and the muted line "Forgot your password? Ask your teacher to reset it."
- **Create your account:**
  - email, password (autocomplete=new-password), "Type it again"
  - hint "At least 8 characters. Use a new password just for StudyRevr."
  - "Create account" button and an "I already have an account" link-button
- **Shared behaviour:**
  - errors are shown in `Notice`;
  - a notice from `takeSignedOutNotice()` appears on top;
  - the quiet "Researcher admin" link stays.
- **On 409 `active_elsewhere`:**
  - show `Notice` "This account is active on another device. Continue here? The other device will be signed out." with a primary "Continue here" (sends the login again with `takeover`) and a quiet "Cancel";
  - keep the password only in component state until then.

**NEW `client/src/screens/ChangePasswordScreen.jsx`:**
- heading "Choose a new password"
- the line "Your teacher gave you a temporary password. Choose your own to keep studying."
- fields: Temporary password, New password, Type it again
- "Save password" button and a quiet "Sign out"

**Wiring:**
- `client/src/App.jsx`:
  - not signed in and not on an admin route → AuthScreen;
  - must change password → ChangePasswordScreen;
  - `usePresence()`;
  - keep the focus effect.
- `Shell.jsx`: the chip shows the email's part before "@" (CSS ellipsis); aria-label "Signed in as <email>. Account settings".
- `SettingsScreen.jsx`: "Signed in as <email>" / "Everything you study is saved to this account." plus a "Sign out" button. CUT-FIRST: an inline "Change password".
- `AdminScreen.jsx:13,327`: use `useSignedIn`.
- `lib/participant.js`: keep only `normalizeCode`.
- Delete `ParticipantScreen.jsx`.

**Tests:**
- `client/test/api.test.js`:
  - STUDENT list: remove `checkParticipant`; add signup, login, logout, me, changePassword;
  - student calls send `authorization: Bearer t1` and no x-participant;
  - ADMIN calls send no authorization;
  - the switch tests become signOut tests (admin is locked after sign-out).
- `session.test.js`: `close` resolves after its report; the reason is `signed_out`.
- `helpers/scenario.mjs`: `setToken('t')`.
- NEW `client/test/auth.test.js`: signOut waits for a slow handler (up to 2 s), then calls logout, then clears the token; `signedOutByServer` shows its notice once; a storage event notifies subscribers.

Done-check: root `npm test` is green. Manual with two devices: sign up, study, sign in on the other device, see the prompt, continue; the first device is back at sign-in within about 20 s with the notice.
Do NOT touch: the server, the PIN logic in `lib/admin.js`, the answer clock, motion.

---

## Step 10: Math-aware grounding and quiz checks
What: Formula quotes ground, worked-example answers must come from their quote, pure-math list lines need no card, and numeric options are judged by value.
For: sonnet-high-applier
Depends on: 3

- `server/src/pipeline/evidence.js` `checkEvidence`: when the quote holds `=`, `≈`, `≤`, `≥`, `→` or `⇌`, `minExplaining = Math.min(minExplaining, 1)`. Everything else is unchanged.
- `server/src/pipeline/flashcards.js` `checkConceptCards` (~l.216): drop a concept card when its answer holds a number (compared per number, as in `mathKey`) that its evidence quote doesn't. The reason is 'a number in the answer is not in its quote'. This catches invented or miscomputed results.
- `server/src/pipeline/flashcards.js` `listItems` (~l.35): a line with no word of 3 or more letters (`/\p{L}{3,}/u`) is not a list item that needs a card. Examples: "x = 2", "F = ma", "3.5 m/s". "- Igneous" is kept.
- `server/src/quiz/leaks.js` `answerInQuestion` (l.242): skip the one-word exact rule when the answer's only content word is a pure number. The whole-phrase check still applies.
- `server/src/quiz/leaks.js` `wrongOptionProblems` (l.310): add rule f "the right answer in another form (same value)" when `sameValue(wrong, correct)`. `falseStatementProblems` (l.374) gets the same as rule e.

**Tests:**
- `evidence.test.js`:
  - "Newton's second law" with quote "F = ma" → ok;
  - "Area of a circle" with quote "A = πr²" → ok;
  - a 2-word quote without an equation still fails.
- The flashcards tests (or a new `math-cards.test.js`):
  - answer "12 N" with quote "F = ma = 10 N" → dropped; "10 N" → kept;
  - pure-math list lines are skipped and word items kept.
- `quiz-leaks.test.js`:
  - "If m = 10 kg and a = 1 m/s², what is F?" → "10 N" is not a leak;
  - "Ten" is still a leak for its old case;
  - wrong option "10.0 N" for "10 N" → rule f;
  - "12 N" → no problem.

Done-check: server tests are green.
Do NOT touch: the thresholds (REWORDED, NEAR_DUPLICATE, …), the Filipino stemmer, quiz selection in `build.js`, card kinds and CHECK constraints.

---

## Step 11: Students no longer use codes — remove the old header and migrate the remaining tests
What: `X-Participant` gets no access anywhere, the code-check route is gone, and students never receive their study ID.
For: sonnet-high-applier
Depends on: 9

**Source changes:**
- `middleware/participant.js`: delete the legacy `X-Participant` branch and `PARTICIPANT_HEADER`.
- Delete `server/src/routes/participants.js`, together with its import and mount in `app.js:61`. Remove 'GET /participants/:code' from NOT_LESSON_ROUTES.
- `sessions/store.js`: `END_REASONS` drops `'switched'` (the CHECK keeps it for old rows).
- `routes/stats.js`: the student response leaves out `participant`:
  `const { participant: _id, ...stats } = participantStats(...)`
  Admin's `/admin/participants/:code/stats` keeps it.

**Test migration:**
- `test/helpers.js`: `STUDY_HEADERS = { authorization: \`Bearer ${TEST_TOKEN}\`, 'x-admin-pin': TEST_PIN }`.
- Call `seedTestLogin(db)` on the db passed to `createApp` in each of these 9 files: extraction, flashcards-api, lessons, pipeline, quiz-api, section-sources, sections, settings-ai, zipguard (all `*.test.js`).
- Replace direct `x-participant` headers with `tokenFor` tokens in:
  - `backup-restore.test.js:155,164`. Line 167 called `/api/participants/P01`; use `GET /api/auth/me` with that token instead.
  - `live-ai.test.js:192`
  - `prepare-versions.test.js:51`
  - `student-uploads.test.js:46,240,262,271,278,285`
- `participants.test.js`:
  - keep the `normalizeCode` / `parseCodeList` unit tests and the isolation tests;
  - replace the code-check and code-lockout tests with: "X-Participant alone is 401 auth_required on every study route" and "a valid token works".

**Tests:** GET `/api/stats` as a student has no `participant` key.
Done-check: root `npm test` is green; `grep -rni "x-participant" server/src client/src` finds nothing.
Do NOT touch: the admin PIN, the export queries.

---

## Step 12: Admin accounts screen, test login, timeout and sign-up settings
What: The admin "Participants" add-codes form becomes an accounts list with Reset password and Sign out, plus a P00 test login and the two settings.
For: sonnet-high-applier
Depends on: 11

**Server:**
- NEW `server/src/routes/admin-accounts.js`, `adminAccountsRouter({ db, clock, requireAdmin })`. It starts with `router.use(requireAdmin)` and is mounted with `mount('/api/admin', adminAccountsRouter(...))`.
  - `GET /accounts` → `{ timeout_s, accounts: [...] }`, ordered by code. Each row has `{ code, email, created_at, test: code==='P00', signed_in, active_now, last_seen_at, locked_until, must_change_password }`.
  - `POST /accounts/:code/reset-password`:
    - `temporaryPassword()`, `setPassword(mustChange: true)`, `clearFailedLogins`, `revokeSessions('password_reset')`;
    - answers `{ temporary_password }`; the password is never logged;
    - writes `admin_events` `password_reset` with the code as detail.
  - `POST /accounts/:code/sign-out`: `revokeSessions('signed_out_by_admin')` → `{ signed_out: n }`; writes `admin_events` `signed_out_by_admin`.
  - `PUT /accounts/test-login {email, password}`: creates or replaces P00's account (409 if the email belongs to someone else) and revokes P00's session; writes `admin_events` `test_login_set`.
  - An unknown code → 404 "No account with that study ID."
- `server/src/auth/accounts.js`: `listAccounts(db, now, timeoutMs)`.
- `routes/admin.js`: remove `POST /participants` (adding codes) and its imports. Keep the summary and stats routes.

**Client:**
- `api.js`, all with `admin: true`: add `adminAccounts`, `resetPassword(code)`, `signOutAccount(code)`, `setTestLogin`; remove `addParticipants`. Update `api.test.js` ADMIN.
- NEW `client/src/components/AdminAccounts.jsx`:
  - **Table:** Study ID (a link to `paths.adminParticipant`), Email, Status (Active now / Signed in / Signed out / Locked until HH:MM / Must change password; P00 is "Your test login").
  - **Reset password:** an inline confirm "Give <email> a temporary password? They will be signed out.", then the password in a `Notice` with a Copy button and "Read it to the student; they choose a new one when they sign in."
  - **Sign out:** an inline confirm.
  - **Test login (P00) form:** email and password.
  - Use existing admin classes, `btn` / `btn--quiet`, and 44 px targets.
- `AdminScreen.jsx` `ParticipantsSection`:
  - remove the add-codes form;
  - retitle it "Study summary", with the help text "Each account has a study ID (P01…); students never see it. To withdraw someone: npm run participant:delete -- <email or study ID>.";
  - render `<AdminAccounts/>` above it.
- `AdminAiSettings.jsx`, following the `show_taglish` pattern:
  - a switch "Allow new sign-ups";
  - a number field "Ask before signing in on a new device while the account was active in the last … seconds" (30–1800, default 60), with the help text "Only matters when a different device signs in."

**Tests:**
- NEW `server/test/admin-accounts.test.js`:
  - the list needs the PIN and shows email and code;
  - after a reset, the old token → 401 `password_reset`; the temporary login → study route 403 → change password → 200;
  - sign-out → study session `signed_out_by_admin`;
  - after setting the P00 test login, signing in as P00 works and its records are left out of the export by default.
- Remove the add-codes test.

Done-check: tests are green; manual walk through the admin screen.
Do NOT touch: `middleware/admin.js`, the export, `GET /admin/participants`.

---

## Step 13: Backup, withdrawal, export codebook and docs
What: Emails and logins are handled everywhere the data goes, and the docs describe accounts.
For: sonnet-high-applier
Depends on: 12, 4

- **`services/backup.js` `stripSecrets` (l.26):** `DELETE FROM auth_sessions` when the table exists. Keep `accounts`, so a restore keeps logins (decision D4). `backup-restore.test.js`: `auth_sessions` is empty, `accounts` is kept.
- **`scripts/delete-participant.js`:**
  - takes an email or a study ID;
  - TABLES gains `['accounts','account (email and password)']` and `['auth_sessions','sign-in sessions']`;
  - the confirmation asks the user to type the study ID; update the usage comment.
  - `delete-participant.test.js`: deleting by email works, and the email's bytes are gone from the db file (scan it like `student-key-wipe.test.js`).
- **Export:**
  - `export/research.js:12` comment and `codebook.js:7`: "Participants appear by study ID only (P01, P02, …). The database holds each student's email and a password hash for signing in; the export never includes them, nor settings or API keys."
  - `codebook.js:113-114` `end_reason`: replace `switched` with "signed_out (signed out on this device) | signed_out_elsewhere (the account signed in on another device) | signed_out_by_admin (the researcher signed the account out or reset its password)".
  - `export.test.js`: create an account with a known email; no file in the export zip contains that email or "scrypt$".
- **Docs:**
  - `CLAUDE.md` "Participants, sessions, admin": accounts, the hidden study ID, `Authorization: Bearer` on every study request, one active login per account plus `session_timeout_seconds`, the admin accounts list, withdrawal by email or ID. Commands: `participant:delete` takes an email.
  - `docs/participants-sessions.md`, `admin.md`, `api.md` (new endpoints; `/participants/:code` and `POST /admin/participants` removed), `data-model.md` (`accounts`, `auth_sessions`, the new end reasons, migrations 018/019), `stats-export-settings.md` (Settings: Signed in as / Sign out), plus one entry in `history.md`.

Done-check: tests are green; `grep -rn "X-Participant" CLAUDE.md docs/*.md` finds hits only in `history.md` and `CLAUDE-full.md`.
Do NOT touch: export columns, `restore.js` logic.

---

## Step 14: Subjects after-run, comparison and demo lessons
What: Re-run Step 1 after Steps 6, 8 and 10; compare with the baseline; pick the 3 demo lessons.
For: sonnet-high-applier (real AI)
Depends on: 1, 6, 8, 10

**Run:** Step 1's runs again, on the 5 samples and any real files, and the same table side by side with the baseline.

**Success criteria, per lesson:**
- it reaches ready;
- equations are readable in `raw_text`, in sections and in cards;
- LaTeX leftovers = 0;
- at least 6 cards;
- clean questions at least 5 of 10;
- no card, option or true statement contradicts the lesson's numbers. Read every math card and option by hand and list any that are wrong.

**If a math or physics lesson has wrong numbers at Low:** run it once with `--thinking=medium` and record the result.

**Demo lessons:**
1. Use a fresh `DB_PATH` and `npm run study`.
2. Upload 3 demo lessons in admin: one math or physics, one chemistry, one history or literature.
3. `npm run quiz:check -- --db <file>` must say ≥ 5 for each.

**No code changes** except fixing a crash. Every other finding goes back to the boss.
Done-check: the comparison table and the demo database are ready.

---

# 3) Decisions you still need to make (my recommendation in brackets)

**Quiz display**
- **D1. Concept true/false sentence.** Join the question and the suggested answer: "Question: Why sample? To save time." Turning the pair into one declarative sentence ("Researchers sample to save time") needs a new AI stage plus a migration. [Join now; skip the AI rewrite.]
- **D15. Reviewer prompts.** They still describe the true/false form as "Is this the answer?" (reviewer-facing only). [Leave them.]
- **D16. Filipino lessons.** True/false reads "<term> means <Filipino definition>". [Accept.]

**Subjects**
- **D2. Math display.** Unicode text, or KaTeX rendering (a new dependency and about 8 components). [Unicode.]
- **D3. Practice problems.** Only the lesson's own worked examples, never new problems. Code enforces that answer numbers appear in the quote. [Yes.]
- **D13. Inputs from you.** Put GOOGLE_API_KEY and ADMIN_PIN in the new folder's `.env` before Step 1. Optionally add 2–3 real teacher files (a physics or math pptx, a chemistry pdf) in `test-lessons/subjects/real/`. [Strongly recommended: generated samples under-represent equation screenshots.]
- **D14. Thinking level for math lessons.** [Keep Low by default; use Medium for a math lesson only if Step 14 shows wrong numbers.]

**Accounts and privacy**
- **D4. Backup contents.** The backup keeps `accounts` (emails and password hashes) so a restore keeps logins, and drops `auth_sessions`. [Yes.]
- **D5. Emails in the database.** This contradicts "no names exist anywhere". Update the codebook, the consent/Chapter 3 wording (Data Privacy Act 2012), and plan to withdraw or delete accounts after the study. [Tell the panel plainly; the export stays pseudonymous.]
- **D6. Study-session end reasons.** `signed_out`, `signed_out_elsewhere`, `signed_out_by_admin`; `switched` is kept only as a legacy value. [Yes.]
- **D7. Timeout setting log.** Changes go to `admin_events`, not `setting_events` (correction above). [Yes.]
- **D8. Sign-ups.** An `allow_signups` switch, default on; turn it off after enrolment. [Yes.]
- **D9. Passwords over plain HTTP on the LAN.** HTTPS is out of scope; the signup hint says to use a new password. [Accept and say so to the panel.]
- **D10. Researcher test login.** Admin sets a P00 test login. [Yes.]
- **D11. Token expiry.** No time-based expiry; only sign-out, takeover or admin ends a login. [Yes.]
- **D12. Header chip.** It shows the email's name part. [Yes, and it can be cut.]
- **D17. Duplicate accounts.** A student who signs up twice gets two study IDs. [Tell students to use one email; Settings shows "Signed in as"; withdraw duplicates.]

---

# 4) Risks, and what to cut first

**Risks**
1. **Subjects quality.** gemini-3.5-flash-lite may write wrong common-mistake options or few clean questions for math. Step 14 measures this; the mitigations are Medium thinking and the AI review. Be honest that equation images, graphs and scans are not read, and PDF math is flattened.
2. **officeparser AST shape.** Steps 6 and 1 assume it; Step 6 checks it against the fixture before writing code.
3. **Test churn in Steps 5 and 11.** Mechanical but it touches about 15 files; run the full suite after each.
4. **Step 9 is the largest client step,** with many UI states. It needs a real two-device check.
5. **Security trade-offs.** Plain HTTP; a classmate can lock an account by typing wrong passwords (at most 15 min; admin reset clears it); the token sits in localStorage.
6. **Ethics and privacy.** Emails stored on the host (D5).
7. **Deadline.** 14 steps in about 8 working days, with 2 days of buffer.

**Cut order (first to cut):**
1. Self-service Change password in Settings (the forced change after a reset stays).
2. The header email chip.
3. The `allow_signups` switch (sign-ups stay open).
4. The signup per-IP limiter.
5. The docx Word-equation path in Step 6, if your real files are pptx or pdf.
6. The `sameValue` checks in Step 10 (lean on the AI review).
7. The font fallback and wrapping tweaks.

**Never cut:**
- Steps 2, 5, 7, 9 and 11: auth core and removal of the old header (without Step 11, anyone could pick a study ID by header and bypass passwords);
- Reset password and sign-out in Step 12;
- Step 4 (True/False);
- Steps 3 and 8 (no LaTeX ever shown);
- The no-email export in Step 13.

---

# 5) Defense demo checklist

**Setup (the day before):**
- A fresh DB, ADMIN_PIN and the Google key; `npm run study`; a phone and a laptop on the same Wi-Fi.
- The 3 demo lessons from Step 14 uploaded; `quiz:check` shows ≥ 5 clean questions each.
- The P00 test login set; sign-ups on.

**1. Login.**
- On the phone: Create an account → land in Review.
- Settings shows "Signed in as …" and no P-code anywhere on the student side.
- The admin Accounts list shows the email next to P01.
- 5 wrong passwords → "Too many wrong passwords. Try again in 1 min."

**2. One device.**
- With the phone open, sign in on the laptop → "This account is active on another device. Continue here?" → Continue.
- Within about 20 s the phone is back at sign-in with "You were signed out because your account was opened on another device."
- An unfinished quiz resumes on the laptop.
- In the export, `sessions.csv` shows the phone's session with `end_reason = signed_out_elsewhere`.

**3. Admin timeout.**
- Set 30 s in admin and show the `setting_changed` record.
- Lock the phone screen, wait more than 30 s, sign in on the laptop: no prompt.

**4. Reset and sign-out.**
- Reset password → read out the temporary password → the student signs in → "Choose a new password" → keeps studying.
- Sign out everywhere → the device shows "Your teacher signed you out."

**5. True/False.**
- In a mock quiz, show "True or False / Question: X means … / [True] [False]".
- The results list says True/False; `quiz_answers.csv` choices are True/False.

**6. Subjects.**
- Math or physics: readable formulas in a section, a formula card, a worked-example card, numeric multiple-choice options.
- Chemistry: H₂O, molar mass.
- History or literature: normal cards and quiz.
- Show "Clean questions available: N of 10" for each.
- Optional: an image-only PDF gives the low-text warning, not a crash.

**7. Privacy.**
- Open the export zip: no emails in any CSV, and the README explains the study IDs.

**Relevant paths (all in D:\claude\pr2\Research_application_pr2_after_chapter_3):**
- `server/src/middleware/participant.js`, `server/src/services/lesson-access.js`, `server/src/sessions/store.js`
- `server/src/services/settings.js`, `server/src/services/extract.js`, `server/src/services/pptx.js`
- `server/src/ai/client.js`, `server/src/ai/prompts.js`
- `server/src/pipeline/evidence.js`, `server/src/pipeline/flashcards.js`, `server/src/quiz/leaks.js`
- `server/src/routes/stats.js`, `server/src/services/backup.js`, `server/scripts/delete-participant.js`, `server/scripts/run-pipeline.js`
- `server/test/helpers.js`, `server/test/lesson-access.test.js`
- `client/src/lib/api.js`, `client/src/lib/quiz.js`, `client/src/lib/session.js`
- `client/src/components/QuizQuestion.jsx`, `client/src/components/QuizResults.jsx`, `client/src/App.jsx`
- `server/src/export/codebook.js`