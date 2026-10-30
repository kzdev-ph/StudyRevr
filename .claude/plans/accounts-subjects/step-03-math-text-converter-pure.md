What: One module that turns LaTeX (from Office equations and from AI replies) into readable Unicode, detects math-heavy text, and compares numeric values.
For: sonnet-high-applier
Depends on: none
Status: done (957/957 server tests green; boss spot-checked the plan's exact strings)

# Step 3: Math text converter (pure)

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
