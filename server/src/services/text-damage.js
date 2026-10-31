// Does extracted text look like letters went missing? Only all-lowercase a-z tokens are judged, so names, acronyms,
// chemical symbols (Cl, Mg), mixed-case units (mmHg), accented and ñ words, digits and symbols never count.
// Lone consonants between two words ("let x be", "d ko alam") are counted apart (lone) because variables and text-speak
// make them common in clean text; 'broken' totals both, 'multi' is only the words of 2+ letters (see damageReason).
const NO_VOWEL_OK = new Set('ng mg nth st nd rd th pp vs mr mrs dr km cm mm nm kg ml dl hz khz mhz ghz ms ns ps pm dx dy dz dt ds dv ln lg sgn ft lb lbs pt pts qt hr hrs sq tsp tbsp mph rpm bpm ppm ppb psi pdf ppt hmm shh brr lcm gcd csc lng kc tlga nmn pls plss sbi ksi dba'.split(' '));
const ONSETS = new Set('bl br ch chl chr chth cl cr dr dw fl fr gh gl gn gr kh kl kn kr kw gw pw bw mn ph phl phr phth pl pr ps pn pt sc sch schr scl scr sh shr sk skr sl sm sn sp sph spl spr squ st str sv sw th thr tr ts tw wh wr ng mg dj zh'.split(' '));
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export const MIN_WORDS = 80; export const MIN_BROKEN = 12; export const MIN_MULTI = 8; export const BROKEN_SHARE = 0.07;
export const MIN_STRAYS = 5; export const STRAYS_PER_100_WORDS = 0.5;
export const MIN_REPLACEMENT = 10; export const REPLACEMENT_SHARE = 0.05;
export function textDamage(text) {
  const s = String(text ?? ''); let words = 0; let multi = 0; let lone = 0;
  for (const line of s.split('\n')) {
    const toks = line.split(/\s+/).filter(Boolean).map((t) => t.replace(EDGE, '')).map((t) => (/^\p{L}+$/u.test(t) ? t : null));
    toks.forEach((t, i) => {
      if (!t) return;
      words += 1;
      if (!/^[a-z]+$/.test(t)) return;
      if (t.length === 1) { // a lone consonant between two words ("where s the"); a, i, o are words (o: Filipino "or")
        if (!'aio'.includes(t) && toks[i - 1]?.length >= 2 && toks[i + 1]?.length >= 2) lone += 1;
        return;
      }
      if (NO_VOWEL_OK.has(t)) return;                                              // "th", "ng", units, text-speak "lng", "tlga"
      const onset = /^[^aeiouy]*/.exec(t)[0];
      if (onset === t) multi += 1;                 // no vowel: "nk"
      else if (onset.length >= 2 && !ONSETS.has(onset)) multi += 1;           // "nders"; "mga", "kwento", "pwede" fine
    });
  }
  const broken = multi + lone;
  return { words, broken, multi, share: words ? broken / words : 0, replacement: (s.match(/�/g) ?? []).length };
}
// -> 'stray_letters' | 'broken_words' | 'replacement_characters' | null
// multi (broken words of 2+ letters) defaults to broken for stats built by hand; lone variables alone never flag a text.
export function damageReason({ words, broken, multi = broken, share, replacement }, { strays = 0, wordCount = words } = {}) {
  if (strays >= MIN_STRAYS && strays * 100 >= STRAYS_PER_100_WORDS * Math.max(wordCount, 1)) return 'stray_letters';
  if (words >= MIN_WORDS && broken >= MIN_BROKEN && multi >= MIN_MULTI && share >= BROKEN_SHARE) return 'broken_words';
  if (replacement >= MIN_REPLACEMENT && replacement >= REPLACEMENT_SHARE * words) return 'replacement_characters';
  return null;
}
// One line for a person: "damaged (stray_letters); stray letters 201; broken words 0.4% (5 of 1200); unreadable characters 0"
export function describeDamage(d) {
  const share = ((d.share ?? 0) * 100).toFixed(1);
  const verdict = d.reason ? `damaged (${d.reason})` : 'looks fine';
  return `${verdict}; stray letters ${d.strays ?? 0}; broken words ${share}% (${d.broken} of ${d.words}); unreadable characters ${d.replacement}`;
}
