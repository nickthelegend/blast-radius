/**
 * Typosquat proximity heuristics.
 *
 * Plain edit distance alone is a poor signal at registry scale: `react` and
 * `preact` are distance 1 and both entirely legitimate. What matters is the
 * *kind* of edit, so each candidate is scored by the substitutions typosquat
 * campaigns actually use — a neighbouring key, a visually confusable character,
 * a doubled or dropped letter, a hyphen shuffled around, a scope stripped off.
 */

/** QWERTY neighbours, used to detect a plausible slip of the finger. */
const KEYBOARD_NEIGHBORS: Record<string, string> = {
  q: 'wa',
  w: 'qeas',
  e: 'wrsd',
  r: 'etdf',
  t: 'ryfg',
  y: 'tugh',
  u: 'yihj',
  i: 'uojk',
  o: 'ipkl',
  p: 'ol',
  a: 'qwsz',
  s: 'awedxz',
  d: 'serfcx',
  f: 'drtgvc',
  g: 'ftyhbv',
  h: 'gyujnb',
  j: 'huikmn',
  k: 'jiolm',
  l: 'kop',
  z: 'asx',
  x: 'zsdc',
  c: 'xdfv',
  v: 'cfgb',
  b: 'vghn',
  n: 'bhjm',
  m: 'njk',
};

/** Characters that read as one another at a glance or in a bad font. */
const HOMOGLYPHS: Record<string, string> = {
  '0': 'o',
  o: '0',
  '1': 'll i',
  l: '1i',
  i: '1l',
  '5': 's',
  s: '5',
  rn: 'm',
  m: 'rn',
  '3': 'e',
  e: '3',
};

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export interface ProximityResult {
  distance: number;
  /** 0..1; higher means a more suspicious kind of edit, not just a closer one. */
  score: number;
  reason: string;
}

/** Strip an npm scope so "@types/node" compares against "node". */
function unscope(name: string): string {
  const slash = name.indexOf('/');
  return name.startsWith('@') && slash !== -1 ? name.slice(slash + 1) : name;
}

function isKeyboardAdjacent(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diffIndex = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diffIndex !== -1) return false;
      diffIndex = i;
    }
  }
  if (diffIndex === -1) return false;
  const from = a[diffIndex]!.toLowerCase();
  const to = b[diffIndex]!.toLowerCase();
  return (KEYBOARD_NEIGHBORS[from] ?? '').includes(to);
}

function isHomoglyph(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diffIndex = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      if (diffIndex !== -1) return false;
      diffIndex = i;
    }
  }
  if (diffIndex === -1) return false;
  const from = a[diffIndex]!.toLowerCase();
  const to = b[diffIndex]!.toLowerCase();
  return (HOMOGLYPHS[from] ?? '').includes(to);
}

/** True when the two names differ only by how they are punctuated. */
function isSeparatorVariant(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/[-_.]/g, '');
  return a !== b && strip(a) === strip(b);
}

function isTranspose(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const diffs: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
  if (diffs.length !== 2) return false;
  const [x, y] = diffs as [number, number];
  return y === x + 1 && a[x] === b[y] && a[y] === b[x];
}

/**
 * Compare a candidate package name against a trusted one.
 * Returns null when the pair is not close enough to be worth an edge.
 */
export function proximity(
  candidate: string,
  trusted: string,
  maxDistance: number,
): ProximityResult | null {
  if (candidate === trusted) return null;

  const a = unscope(candidate).toLowerCase();
  const b = unscope(trusted).toLowerCase();

  if (a === b) {
    // Dependency confusion: the *same* bare name published under different
    // ownership — "utils" versus "@acme/utils", or two rival scopes both
    // publishing "utilities".
    //
    // The bare name has to be distinctive enough to mean something. npm is full
    // of `@babel/core`, `@jest/core` and `@eslint/core`, which share the suffix
    // "core" and nothing else; flagging those as squats of each other buries
    // every real result. A six-character floor removes that whole class.
    if (b.length < 6) return null;
    return {
      distance: 0,
      score: 0.95,
      reason: `same package name as "${trusted}" under different ownership (dependency confusion)`,
    };
  }

  const distance = levenshtein(a, b, maxDistance);
  if (distance > maxDistance) return null;

  // Two *different* scopes that merely share a short suffix are not a finding.
  // Unscoping "@babel/core" and "@depup/jose" leaves "core" and "jose", which
  // are two edits apart purely because they are four letters long. Requiring
  // the bare names to be near-identical keeps genuine scope-swaps and drops the
  // combinatorial noise.
  const bothScoped = candidate.startsWith('@') && trusted.startsWith('@');
  if (bothScoped && distance > 1) return null;

  // Beyond a single edit, short names collide by chance far more often than
  // they are squatted.
  if (distance >= 2 && Math.min(a.length, b.length) < 8) return null;

  if (isSeparatorVariant(a, b)) {
    return { distance, score: 0.85, reason: `punctuation variant of "${trusted}"` };
  }
  if (isHomoglyph(a, b)) {
    return { distance, score: 0.95, reason: `visually confusable character swap on "${trusted}"` };
  }
  if (isKeyboardAdjacent(a, b)) {
    return { distance, score: 0.9, reason: `adjacent-key substitution on "${trusted}"` };
  }
  if (isTranspose(a, b)) {
    return { distance, score: 0.8, reason: `transposed characters in "${trusted}"` };
  }
  if (distance === 1 && a.length === b.length + 1) {
    return { distance, score: 0.75, reason: `one extra character versus "${trusted}"` };
  }
  if (distance === 1 && a.length === b.length - 1) {
    return { distance, score: 0.75, reason: `one missing character versus "${trusted}"` };
  }
  if (distance === 1) {
    return { distance, score: 0.7, reason: `single character differs from "${trusted}"` };
  }

  // Distance 2+ on a short name is mostly noise; on a long name it is still
  // worth surfacing, so the score decays with distance and grows with length.
  const lengthFactor = Math.min(1, b.length / 12);
  return {
    distance,
    score: Math.max(0.2, 0.55 - 0.1 * (distance - 2)) * lengthFactor,
    reason: `${distance} edits from "${trusted}"`,
  };
}
