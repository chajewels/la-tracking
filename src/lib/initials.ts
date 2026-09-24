/** Customer initials for a monogram — display only.
 *
 *  - A parenthesised part is a reading or nickname ("Bernadette （たかはし）"),
 *    not a surname: it is dropped so the monogram doesn't mix scripts.
 *  - Latin names: first letter of the first and last word ("JB").
 *  - Mixed Latin + Japanese ("Angel ペイブ"): the Latin word(s) only ("A").
 *  - All-Japanese names: the first character only ("髙").
 *  - Characters are whole grapheme clusters (Intl.Segmenter) of the NFC form,
 *    so a kana with a combining mark is never split into a broken glyph. */

const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const LATIN = /\p{Script=Latin}/u;

// Typed locally: the app's TS lib predates Intl.Segmenter (ES2022); every
// browser the Hub supports has it, and Array.from is the fallback.
type GraphemeSegmenter = new (locale?: string, options?: { granularity: 'grapheme' }) => {
  segment(input: string): Iterable<{ segment: string }>;
};
const Segmenter = typeof Intl !== 'undefined'
  ? (Intl as unknown as { Segmenter?: GraphemeSegmenter }).Segmenter
  : undefined;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;

function firstGrapheme(word: string): string {
  if (segmenter) {
    for (const { segment } of segmenter.segment(word)) return segment;
    return '';
  }
  return Array.from(word)[0] ?? '';
}

export function initialsOf(name: string | null | undefined): string {
  const full = (name ?? '').normalize('NFC');
  const base = full.replace(/[（(].*$/u, '').trim() || full.trim();
  let parts = base.split(/\s+/).map((w) => w.replace(/^[\p{P}\p{S}]+/u, '')).filter(Boolean);
  if (parts.length === 0) return 'CJ';

  const latin = parts.filter((w) => LATIN.test(firstGrapheme(w)));
  const japanese = parts.filter((w) => JAPANESE.test(firstGrapheme(w)));
  if (latin.length > 0 && japanese.length > 0) parts = latin;
  else if (latin.length === 0 && japanese.length === parts.length) return firstGrapheme(parts[0]);

  const first = firstGrapheme(parts[0]);
  const second = parts.length > 1 ? firstGrapheme(parts[parts.length - 1]) : '';
  return (first + second).toUpperCase();
}
