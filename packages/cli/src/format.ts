/** Terminal formatting. No dependency — a handful of ANSI codes is enough. */

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const ESC = '\u001b';
const wrap = (code: string) => (text: string) =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');

export function heading(text: string): string {
  return bold(text);
}

/** "2026-08-14T09:03:12Z" */
export function iso(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "09:03:12Z" — used where the date is already established by a header. */
export function clock(ms: number): string {
  if (!ms) return '—';
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

/** "09:00:00–09:06:00 UTC, Aug 14 2026" */
export function windowLabel(from: number, to: number): string {
  const start = new Date(from);
  const end = new Date(to);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const date = `${months[start.getUTCMonth()]} ${start.getUTCDate()} ${start.getUTCFullYear()}`;
  return `${start.toISOString().slice(11, 19)}–${end.toISOString().slice(11, 19)} UTC, ${date}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Wrap a long dependency chain across lines, indenting continuations under the
 * first one so the chain stays readable in an 80-column terminal.
 */
export function wrapChain(chain: string, firstIndent: number, width = 78): string[] {
  const parts = chain.split(' -> ');
  const lines: string[] = [];
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    const piece = i === 0 ? parts[i]! : ` -> ${parts[i]!}`;
    if (current.length + piece.length > width - firstIndent && current.length > 0) {
      lines.push(current);
      current = `-> ${parts[i]!}`;
    } else {
      current += piece;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function bar(value: number, max: number, width = 24): string {
  if (max <= 0) return ' '.repeat(width);
  const filled = Math.min(width, Math.round((value / max) * width));
  return '█'.repeat(filled) + dim('·'.repeat(width - filled));
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}
