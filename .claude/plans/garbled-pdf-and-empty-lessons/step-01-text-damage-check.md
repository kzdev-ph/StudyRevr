## Step 1: Text damage check (pure function)
What: add `server/src/services/text-damage.js` with `textDamage(text)` and `damageReason(stats, { strays, wordCount })`, plus tests.
For: sonnet-high-applier
Depends on: none
Status: done
Changes: a new file with exactly this logic (the thresholds above were measured with it):
```js
// Does extracted text look like letters went missing? Only all-lowercase a-z tokens are judged, so names, acronyms,
// chemical symbols (Cl, Mg), mixed-case units (mmHg), accented and ñ words, digits and symbols never count.
const NO_VOWEL_OK = new Set('ng mg nth st nd rd th pp vs mr mrs dr km cm mm nm kg ml dl hz khz mhz ghz ms ns ps pm dx dy dz dt ds dv ln lg sgn ft lb lbs pt pts qt hr hrs sq tsp tbsp mph rpm bpm ppm ppb psi pdf ppt hmm shh brr'.split(' '));
const ONSETS = new Set('bl br ch chl chr chth cl cr dr dw fl fr gh gl gn gr kh kl kn kr kw gw pw bw mn ph phl phr phth pl pr ps pn pt sc sch schr scl scr sh shr sk skr sl sm sn sp sph spl spr squ st str sv sw th thr tr ts tw wh wr ng mg dj zh'.split(' '));
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const MIN_WORDS = 80; export const MIN_BROKEN = 12; export const BROKEN_SHARE = 0.07;
export const MIN_STRAYS = 5; export const STRAYS_PER_100_WORDS = 0.5;
export const MIN_REPLACEMENT = 10; export const REPLACEMENT_SHARE = 0.05;
export function textDamage(text) {
  const s = String(text ?? ''); let words = 0; let broken = 0;
  for (const line of s.split('\n')) {
    const toks = line.split(/\s+/).filter(Boolean).map((t) => t.replace(EDGE, '')).map((t) => (/^\p{L}+$/u.test(t) ? t : null));
    toks.forEach((t, i) => {
      if (!t) return;
      words += 1;
      if (!/^[a-z]+$/.test(t)) return;
      if (t.length === 1) { // a lone consonant between two words ("where s the"); a, i, o are words (o: Filipino "or")
        if (!'aio'.includes(t) && toks[i - 1]?.length >= 2 && toks[i + 1]?.length >= 2) broken += 1;
        return;
      }
      const onset = /^[^aeiouy]*/.exec(t)[0];
      if (onset === t) { if (!NO_VOWEL_OK.has(t)) broken += 1; }                 // no vowel: "nk"; "th", "ng" allowed
      else if (onset.length >= 2 && !ONSETS.has(onset)) broken += 1;           // "nders"; "mga", "kwento", "pwede" fine
    });
  }
  return { words, broken, share: words ? broken / words : 0, replacement: (s.match(/\uFFFD/g) ?? []).length };
}
// -> 'stray_letters' | 'broken_words' | 'replacement_characters' | null
export function damageReason({ words, broken, share, replacement }, { strays = 0, wordCount = words } = {}) {
  if (strays >= MIN_STRAYS && strays * 100 >= STRAYS_PER_100_WORDS * Math.max(wordCount, 1)) return 'stray_letters';
  if (words >= MIN_WORDS && broken >= MIN_BROKEN && share >= BROKEN_SHARE) return 'broken_words';
  if (replacement >= MIN_REPLACEMENT && replacement >= REPLACEMENT_SHARE * words) return 'replacement_characters';
  return null;
}
```
Tests: `server/test/text-damage.test.js` (node:test, strict assert).
- **Garbled.** About 120 words made by repeating "Th nk carefu y abut how each force affects an ob ect. Don t forget the ang e factor and ntegra n Work." and "Next Master ng Phys cs dead ne s next Monday. Exam #2 s next Fr day at 10 am." Expect `damageReason` = 'broken_words' and share > 0.07.
- **Clean English** prose (~150 words): reason null, share < 0.02.
- **Filipino** (~150-word Aralin text using ng, mga, sa, ay, si, ni, o, kwento, pwede, tsaka, "ng mga Anak ng Bayan"): broken 0.
- **Taglish** ("Ang photosynthesis ay ang proseso kung saan…", "i-review ninyo ang notes", "Sa Monday po ang deadline"): broken 0.
- **Math prose** ("ang m ay ang slope at ang b ay ang y-intercept", "where m is the slope", "y = mx + b"), ~150 words: reason null.
- **Fixed cases:**
  - DNA, KKK, Cl, Mg, mmHg are never counted.
  - Under 80 words never flags.
  - `damageReason(cleanStats, { strays: 5, wordCount: 1000 })` is 'stray_letters'.
  - `{ strays: 4 }` gives null, and so does `{ strays: 5, wordCount: 2000 }`.
  - 26 U+FFFD in 844 words gives null; 50 in 500 words gives 'replacement_characters'.

Done-check: `npm test` in `server/` passes. The file has no imports.
Do NOT touch: anything else.

Do NOT touch (whole plan): pipeline/evidence.js and every grounding call (no fuzzy matching); ai/prompts.js; services/claude-exchange.js, scripts/import-lesson.js, scripts/export-lesson.js; the research export and codebook; the events and lesson_events CHECKs; the admin PIN middleware; visibleSql; status transitions in run.js; CLAUDE.md. Do not commit or push.
