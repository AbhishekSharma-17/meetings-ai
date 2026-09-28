/**
 * Client-side list search shared by every searchable list, so matching behaves the same everywhere:
 * case-insensitive, accent-insensitive ("jose" finds "José"), whitespace-tolerant, and every word of
 * the query must appear somewhere in the item's fields (in any order).
 */

/** A field a list item can be searched by. Nested arrays are flattened; empty values are ignored. */
export type SearchField = string | number | null | undefined | false | readonly SearchField[];

/** Lists with more items than this show a search box (fixed lists of three or fewer never do). */
export const SEARCH_MIN_ITEMS = 6;

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Lower-cases, strips accents and collapses whitespace. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** The normalised words of a query; an empty list means "match everything". */
export function searchTerms(query: string): string[] {
  return normalizeSearchText(query).split(" ").filter(Boolean);
}

function flatten(fields: readonly SearchField[], into: string[]): string[] {
  for (const field of fields) {
    if (field === null || field === undefined || field === false || field === "") continue;
    if (typeof field === "string" || typeof field === "number") into.push(String(field));
    else flatten(field, into);
  }
  return into;
}

/** True when every word of the query appears in at least one of the fields. */
export function matchesQuery(query: string, ...fields: SearchField[]): boolean {
  const terms = searchTerms(query);
  if (!terms.length) return true;
  const haystack = normalizeSearchText(flatten(fields, []).join(" \u0000 "));
  return terms.every((term) => haystack.includes(term));
}

/** Whether a list of this size should offer a search box. An active query always keeps it visible. */
export function shouldOfferSearch(count: number, query = ""): boolean {
  return count >= SEARCH_MIN_ITEMS || query.trim().length > 0;
}

/**
 * Character ranges of `text` that match any query word, for highlighting. Ranges index the original
 * text (accents intact), are sorted and never overlap.
 */
export function matchRanges(text: string, query: string): Array<[number, number]> {
  const terms = searchTerms(query);
  if (!terms.length || !text) return [];
  // Cheap rejection first: most rows in a long list don't contain any term.
  const whole = normalizeSearchText(text);
  if (!terms.some((term) => whole.includes(term))) return [];
  // Normalise per character so each normalised position maps back to its source character.
  // Plain ASCII only needs lower-casing; only other characters pay for Unicode normalisation.
  let folded = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const piece = char.charCodeAt(0) < 128 ? char.toLowerCase() : char.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
    for (let offset = 0; offset < piece.length; offset++) { folded += piece[offset]; origin.push(index); }
  }
  const hits: Array<[number, number]> = [];
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      hits.push([origin[at], origin[at + term.length - 1] + 1]);
    }
  }
  hits.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of hits) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
