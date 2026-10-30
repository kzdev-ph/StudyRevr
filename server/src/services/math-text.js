// Math text helpers: turn LaTeX (Office equations, AI replies) into readable Unicode, spot math-heavy text,
// and compare numeric answers. Pure functions, no dependencies.

const SUP = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ',
  n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

const SUB = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ',
  i: 'ᵢ', j: 'ⱼ', r: 'ᵣ', u: 'ᵤ', v: 'ᵥ',
};

const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const SYMBOLS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', propto: '∝', infty: '∞', to: '→', rightarrow: '→', longrightarrow: '→',
  leftarrow: '←', gets: '←', Rightarrow: '⇒', implies: '⇒', leftrightarrow: '↔', Leftrightarrow: '↔',
  rightleftharpoons: '⇌', circ: '°', degree: '°', angle: '∠', perp: '⊥', parallel: '∥',
  triangle: '△', bigtriangleup: '△', partial: '∂', nabla: '∇', in: '∈', notin: '∉', subset: '⊂',
  subseteq: '⊆', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃',
  ldots: '…', dots: '…', cdots: '…', prime: '′', langle: '⟨', rangle: '⟩',
};

// Symbols that behave like operators: no spaces are kept around them.
const OPERATORS = new Set([...'×÷·±∓≤≥≠≈≡∝→←⇒↔⇌⊥∥∈∉⊂⊆∪∩']);

const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'exp', 'max', 'min', 'sec', 'csc', 'cot', 'sinh', 'cosh', 'tanh']);
const BIG = { lim: 'lim', sum: '∑', prod: '∏', int: '∫', oint: '∮' };
const WRAPPERS = new Set(['text', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'textbf', 'textit', 'mathbb', 'mathcal', 'boldsymbol', 'mbox']);
const ACCENTS = { bar: '̄', overline: '̄', hat: '̂', vec: '⃗', dot: '̇', ddot: '̈', tilde: '̃' };
const FRACS = new Set(['frac', 'dfrac', 'tfrac']);
const ESCAPED = new Set([...'%$#_{}&']);

const KNOWN = new Set([
  ...Object.keys(GREEK), ...Object.keys(SYMBOLS), ...Object.keys(BIG), ...Object.keys(ACCENTS),
  ...FUNCTIONS, ...WRAPPERS, ...FRACS, 'sqrt', 'left', 'right',
]);

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const part = (raw) => conv(raw).replace(/\s+/g, ' ').trim();
const isSimple = (x) => !/[\s+\-−±∓×÷·*/=<>≤≥≠≈,;()]/.test(x);

// Index of the "}" that closes the "{" at `open` (or the string length when it never closes).
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length;
}

// One TeX argument: a {group}, a \command, or a single character. Returns the raw text and where to resume.
function readArg(s, from) {
  let i = from;
  while (i < s.length && isSpace(s[i])) i++;
  if (i >= s.length) return { raw: '', next: i };
  if (s[i] === '{') {
    const end = matchBrace(s, i);
    return { raw: s.slice(i + 1, end), next: Math.min(end + 1, s.length) };
  }
  if (s[i] === '\\') {
    const m = /^\\(?:[A-Za-z]+|[\s\S])?/.exec(s.slice(i));
    return { raw: m[0], next: i + Math.max(m[0].length, 1) };
  }
  return { raw: s[i], next: i + 1 };
}

function enclosed(x) {
  if (x[0] !== '(') return false;
  let depth = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === '(') depth++;
    else if (x[i] === ')' && --depth === 0) return i === x.length - 1;
  }
  return false;
}

const paren = (x) => (enclosed(x) ? x : `(${x})`);
const wrap = (x) => (isSimple(x) ? x : paren(x));

function script(str, table, mark) {
  const compact = str.replace(/\s+/g, '');
  if (!compact) return '';
  const chars = [...compact];
  if (chars.every((c) => Object.hasOwn(table, c))) return chars.map((c) => table[c]).join('');
  return `${mark}(${str})`;
}

const sup = (str) => (str === '°' || str === '′' ? str : script(str, SUP, '^'));
const sub = (str) => script(str, SUB, '_');

// A simple fraction glued to a letter, digit, "(" or a root is wrapped so it reads as one factor.
function startsFactor(rest) {
  if (/^[A-Za-z0-9(√]/.test(rest)) return true;
  const m = /^\\([A-Za-z]+)/.exec(rest);
  return Boolean(m && (m[1] === 'sqrt' || Object.hasOwn(GREEK, m[1])));
}

// Splits a matrix body into rows of cells on top-level "\\" and "&".
function matrixRows(body) {
  const rows = [[]];
  let cell = '';
  let depth = 0;
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (ch === '\\') {
      if (body[k + 1] === '\\' && depth === 0) {
        rows[rows.length - 1].push(cell);
        cell = '';
        rows.push([]);
      } else {
        cell += ch + (body[k + 1] ?? '');
      }
      k++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === '&' && depth === 0) {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  rows[rows.length - 1].push(cell);
  return rows
    .map((r) => r.map(part))
    .filter((r) => r.some(Boolean));
}

function conv(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '{') {
      const end = matchBrace(s, i);
      out += conv(s.slice(i + 1, end));
      i = Math.min(end + 1, s.length);
    } else if (c === '^' || c === '_') {
      const a = readArg(s, i + 1);
      const inner = conv(a.raw).replace(/\s+/g, ' ').trim();
      out += c === '^' ? sup(inner) : sub(inner);
      i = a.next;
    } else if (c === '~' || c === '&') {
      out += ' ';
      i++;
    } else if (c === '}') {
      i++;
    } else if (c !== '\\') {
      out += c;
      i++;
    } else if (!/[A-Za-z]/.test(s[i + 1] ?? '')) {
      const ch = s[i + 1];
      i += 2;
      if (ch === undefined) continue;
      if (ESCAPED.has(ch)) out += ch;
      else if (ch === '\\') out += '; ';
      else if (ch === ',' || ch === ';' || ch === ':' || ch === ' ') out += ' ';
      else if (ch === '!') out += '';
      else if (ch === '|') out += '∥';
      else out += ch;
    } else {
      const name = /^[A-Za-z]+/.exec(s.slice(i + 1))[0];
      i += 1 + name.length;

      if (name === 'textbackslash' || name === 'textasciitilde' || name === 'textasciicircum') {
        out += name === 'textbackslash' ? '\\' : name === 'textasciitilde' ? '~' : '^';
        if (s.startsWith('{}', i)) i += 2;
      } else if (FRACS.has(name)) {
        const a = readArg(s, i);
        const b = readArg(s, a.next);
        i = b.next;
        const num = part(a.raw);
        const den = part(b.raw);
        if (isSimple(num) && isSimple(den)) out += startsFactor(s.slice(i)) ? `(${num}/${den})` : `${num}/${den}`;
        else out += `${wrap(num)}/${wrap(den)}`;
      } else if (name === 'sqrt') {
        let j = i;
        while (j < s.length && isSpace(s[j])) j++;
        let index = null;
        if (s[j] === '[') {
          const close = s.indexOf(']', j);
          const end = close === -1 ? s.length : close;
          index = part(s.slice(j + 1, end));
          i = Math.min(end + 1, s.length);
        }
        const a = readArg(s, i);
        i = a.next;
        const x = part(a.raw);
        out += index === null ? `√${wrap(x)}` : `${sup(index)}√${paren(x)}`;
      } else if (WRAPPERS.has(name)) {
        const a = readArg(s, i);
        i = a.next;
        out += conv(a.raw);
      } else if (Object.hasOwn(ACCENTS, name)) {
        const a = readArg(s, i);
        i = a.next;
        const x = part(a.raw);
        if (!x) continue;
        if ((name === 'bar' || name === 'overline') && [...x].length > 1) out += `‾(${x})`;
        else out += x + ACCENTS[name];
      } else if (name === 'left' || name === 'right') {
        if (s[i] === '.') i++; // "\left." is an empty delimiter
      } else if (name === 'quad' || name === 'qquad') {
        out += ' ';
      } else if (name === 'begin') {
        const a = readArg(s, i);
        i = a.next;
        const envName = a.raw.trim();
        const endTag = `\\end{${envName}}`;
        const endAt = s.indexOf(endTag, i);
        if (/matrix$/.test(envName) && endAt !== -1) {
          const rows = matrixRows(s.slice(i, endAt));
          out += `[${rows.map((r) => r.join(', ')).join('; ')}]`;
          i = endAt + endTag.length;
        }
      } else if (name === 'end') {
        i = readArg(s, i).next;
      } else if (Object.hasOwn(BIG, name)) {
        let lower = null;
        let upper = null;
        for (;;) {
          let j = i;
          while (j < s.length && isSpace(s[j])) j++;
          if (s[j] === '_' && lower === null) {
            const a = readArg(s, j + 1);
            lower = part(a.raw);
            i = a.next;
          } else if (s[j] === '^' && upper === null) {
            const a = readArg(s, j + 1);
            upper = part(a.raw);
            i = a.next;
          } else break;
        }
        out += BIG[name];
        if (lower !== null && upper !== null) out += `(${lower} to ${upper})`;
        else if (lower !== null) out += `(${lower})`;
        else if (upper !== null) out += `(to ${upper})`;
      } else if (FUNCTIONS.has(name)) {
        out += name;
      } else if (Object.hasOwn(GREEK, name)) {
        out += GREEK[name];
      } else if (Object.hasOwn(SYMBOLS, name)) {
        const sym = SYMBOLS[name];
        if (OPERATORS.has(sym)) {
          out = out.replace(/ +$/, '');
          while (i < s.length && isSpace(s[i])) i++;
        }
        out += sym;
      } else {
        out += name; // unknown command: keep its name
      }
    }
  }
  return out;
}

export function latexToText(latex) {
  return conv(String(latex ?? '')).replace(/\s+/g, ' ').trim();
}

// End of a bare LaTeX span: the next space outside braces (or a newline).
function spanEnd(text, from) {
  let depth = 0;
  let j = from;
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === '\n') break;
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && isSpace(c)) break;
  }
  return j;
}

// Real math inside a delimited span: a LaTeX command (\frac, \alpha; not one glued to a path like C:\Users), a
// superscript or subscript with an operand (x^2, x_1, x^{2}), never mere braces or an underscore in a word.
function hasScript(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') {
      k++;
      continue;
    }
    if (c !== '^' && c !== '_') continue;
    if (c === '_' && /[\p{L}\p{N}_]{2}$/u.test(s.slice(Math.max(0, k - 2), k))) continue; // snake_case, not a subscript
    const next = s[k + 1] ?? '';
    if (/[\p{L}\p{N}]/u.test(next)) return true;
    if (next === '{') {
      const end = matchBrace(s, k + 1);
      if (end < s.length && end > k + 2) return true;
    }
  }
  return false;
}

const hasMathSyntax = (s) => /(?<![:\\])\\[A-Za-z]+/.test(s) || hasScript(s);

// $..$ is math only when the $ opens on a non-space, closes on a non-space not followed by a digit (a price), does not
// start like a price ("$5 for", "$12, "), stays on one line, and holds real math syntax.
function isDollarMath(inner, after) {
  if (!inner || inner.includes('\n')) return false;
  if (/^\s|\s$/.test(inner) || /\d/.test(after ?? '')) return false;
  if (/^\d[\d.,]*(?:[ \t]+(?!\\)|,|\.\s)/.test(inner)) return false;
  return hasMathSyntax(inner);
}

// $$..$$ and \[..\] stay inside one paragraph and hold real math syntax.
const isDisplayMath = (inner) => Boolean(inner) && !/\n\s*\n/.test(inner) && hasMathSyntax(inner);

// \(..\) is math with real syntax, or a short equation or single symbol ("\(x\)", "\(F = ma\)", "\(2+3\)").
function isInlineMath(inner) {
  if (!inner || /\n\s*\n/.test(inner)) return false;
  if (hasMathSyntax(inner)) return true;
  return /^\s*[\p{L}\p{N}]{1,2}\s*$/u.test(inner) || (/^[\p{L}\p{N}\s=+\-−×÷*/.,<>≤≥()²³]{1,40}$/u.test(inner) && /[=+\-−×÷*/<>≤≥]/.test(inner) && !/\p{L}{3,}/u.test(inner));
}

// A bare \command counts only at the start, or after whitespace, an opening bracket or an operator: not in a Windows
// path or command ("C:\Users\Delta", "D:\sum\text") where a letter, digit, underscore, backslash or ":" comes first.
const COMMAND_PREFIX = /[\s(\[{=+\-−*/×÷·±<>≤≥,;|&^"'“‘]/;
const commandStartsHere = (text, i) => i === 0 || COMMAND_PREFIX.test(text[i - 1]);

// Converts only clear LaTeX: $$..$$, $..$ (with real math syntax inside), \(..\), \[..\], and bare spans.
export function mathText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '$' && text[i + 1] === '$') {
      const j = text.indexOf('$$', i + 2);
      if (j > i + 2 && isDisplayMath(text.slice(i + 2, j))) {
        out += latexToText(text.slice(i + 2, j));
        i = j + 2;
        continue;
      }
    } else if (c === '$') {
      const j = text.indexOf('$', i + 1);
      if (j !== -1 && isDollarMath(text.slice(i + 1, j), text[j + 1])) {
        out += latexToText(text.slice(i + 1, j));
        i = j + 1;
        continue;
      }
    } else if (c === '\\' && (text[i + 1] === '(' || text[i + 1] === '[')) {
      const round = text[i + 1] === '(';
      const j = text.indexOf(round ? '\\)' : '\\]', i + 2);
      const inner = j > i + 2 ? text.slice(i + 2, j) : '';
      if (round ? isInlineMath(inner) : isDisplayMath(inner)) {
        out += latexToText(inner);
        i = j + 2;
        continue;
      }
    } else if (c === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(text.slice(i, i + 24));
      if (m && KNOWN.has(m[1]) && commandStartsHere(text, i)) {
        const end = spanEnd(text, i);
        out += latexToText(text.slice(i, end));
        i = end;
        continue;
      }
    } else if ((c === '^' || c === '_') && text[i + 1] === '{' && !(c === '_' && /[\p{L}\p{N}_]{2}$/u.test(text.slice(Math.max(0, i - 2), i)))) {
      const end = spanEnd(text, i);
      out += latexToText(text.slice(i, end));
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function mathTextDeep(value) {
  if (typeof value === 'string') return mathText(value);
  if (Array.isArray(value)) return value.map(mathTextDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mathTextDeep(v)]));
  }
  return value;
}

const MATH_CHARS = /[√π∑∫±×÷²³⁴-⁹₀-₉Δ]/gu;
const UNITS = 'm\\/s²|m\\/s|km\\/h|kg|g\\/mol|mol|Pa|°C|N|J|W|K|cm|mm|km|mL|L|s';
const NUMBER_UNIT = new RegExp(`\\d(?:\\.\\d+)?\\s*(?:${UNITS})(?![\\p{L}\\p{N}])`, 'gu');
const NUMBER_UNIT_ONE = new RegExp(NUMBER_UNIT.source, 'u');
const QUANTITY = new RegExp(`^\\s*[-−+]?\\d[\\d.,]*\\s*(?:${UNITS})\\.?\\s*$`, 'u');

// A number followed by a unit anywhere in the text ("12 N", "3.5 m/s").
export const hasNumberUnit = (text) => NUMBER_UNIT_ONE.test(String(text ?? ''));

// ---- operators: what makes a string a formula rather than a date, a count or a title --------------------------------
const SYMBOL_OP = /[=≠≈≤≥≡−×÷±√π∑∫Δ⁰¹²³⁴-⁹₀-₉]/u;
const BINARY_OP = /[\p{L}\p{N})\]]\s*[+*/^]\s*[\p{L}\p{N}([√]/u;
const SPACED_MINUS = /(?:\d|\)|(?<!\p{L})\p{L})\s+-\s+(?:\d|\(|\p{L}(?![\p{L}\p{N}]))/u;

// True when the text holds an arithmetic or relation operator, a math symbol, a super/subscript, or an arrow next to
// a digit or subscript (a reaction): "F = ma", "x² − 5x + 6", "(1/2)mv²". A bare digit, a plain hyphen ("K-12",
// "1898-1901") and an arrow between words ("Plan → Do") do not count.
export function hasMathOperator(text) {
  const s = String(text ?? '');
  return SYMBOL_OP.test(s) || BINARY_OP.test(s) || SPACED_MINUS.test(s) || (/[→⇌]/.test(s) && /[\d₀-₉]/.test(s));
}

const RELATION = /[=≈≤≥<>]/;
const CODE_LINE = /\b(?:let|const|var|function|return|def|import|print)\b|\b(?:if|for|while)\s*\(|[=!]==?|=>|->|<<|>>/;

// A line that is an equation: a relation between operands that carry real math (an operator, a symbol, a power), or a
// short variable on the left of a short term ("F = ma"); not code ("let x = 5;") or a comparison of words ("score < 75").
function isEquationLine(raw) {
  const line = raw.trim();
  if (!line || /[;{}]$/.test(line) || CODE_LINE.test(line)) return false;
  const at = line.search(RELATION);
  if (at < 1) return false;
  const left = line.slice(0, at).trim();
  const right = line.slice(at + 1).replace(/^[=]/, '').trim();
  if (!left || !right || !/[\p{L}\p{N})\]]\s*[=≈≤≥<>]\s*[\p{L}\p{N}(√−-]/u.test(line)) return false;
  if (SYMBOL_OP.test(line.replace(RELATION, '')) || BINARY_OP.test(line) || SPACED_MINUS.test(line) || /\^/.test(line)) return true;
  return /^\p{L}[\p{L}\p{N}]?$/u.test(left) && /^\S{1,12}$/u.test(right) && /\p{L}/u.test(right);
}

// True when the text has at least 3 math hits (equation lines, math symbols, numbers with units).
export function looksMathy(text) {
  if (typeof text !== 'string' || !text) return false;
  const equations = text.split('\n').filter(isEquationLine).length;
  const symbols = (text.match(MATH_CHARS) ?? []).length;
  const units = (text.match(NUMBER_UNIT) ?? []).length;
  return equations + symbols + units >= 3;
}

// A short answer that is mostly a number, equation or symbols rather than prose.
export function isMathAnswer(text) {
  if (typeof text !== 'string') return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  if (!/\d|[=≤≥≈≠<>→⇌√π∑∫±×÷²³⁴-⁹₀-₉Δ∞°]/u.test(text)) return false;
  const longWords = words.filter((w) => /\p{L}{4,}/u.test(w)).length;
  return longWords < 3;
}

// A math answer that is a formula: it holds an operator or math symbol (see hasMathOperator). "1898", "Section 5" and
// "Phase 2 of mitosis" are not: a digit alone is not formula evidence.
export const isFormulaLike = (text) => isMathAnswer(text) && hasMathOperator(text);

// An answer that is a formula or a bare quantity ("10 N", "3.5 m/s"): what the wrong-answer prompt writes math options for.
export const isFormulaOrQuantity = (text) => isFormulaLike(text) || (typeof text === 'string' && QUANTITY.test(text));

const SUP_DIGITS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-' };

// Normal form of an answer so "10 N" and "10.0 N." (or "0.5" and "1/2") compare equal.
export function mathKey(text) {
  return String(text ?? '')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, (run) => `^${[...run].map((c) => SUP_DIGITS[c]).join('')}`)
    .replace(/[₀-₉₊₋]+/g, (run) => `_${[...run].map((c) => (c === '₊' ? '+' : c === '₋' ? '-' : String(c.charCodeAt(0) - 0x2080))).join('')}`)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[⁄∕]/g, '/')
    .replace(/−/g, '-')
    .replace(/[×·]/g, '*')
    .replace(/\s+/g, '')
    .replace(/\.$/, '')
    .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+/g, (n) => String(Number(n.replace(/,/g, ''))))
    .replace(/(?<![\d.])(\d+)\/(\d+)(?![\d.])/g, (whole, a, b) => (Number(b) === 0 ? whole : String(Number(a) / Number(b))));
}

export function sameValue(a, b) {
  return /\d/.test(String(a ?? '')) && mathKey(a) === mathKey(b);
}
