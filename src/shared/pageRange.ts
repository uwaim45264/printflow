/** "Pages to print" and "Pages per sheet" — shared by the customer page, pricing and the print file. */

export const PAGES_PER_SHEET = [1, 2, 4] as const;
export type PagesPerSheet = (typeof PAGES_PER_SHEET)[number];

export const MAX_PAGE_RANGE_LENGTH = 100;

/**
 * Parses a page range such as "1-3, 5, 8-10" against `total` pages (all files together, in order).
 * Empty means all pages. Returns the selected 1-based page numbers in order (no duplicates) or an error.
 * Same rules as printflow_private.page_range_pages() in the database.
 */
export function parsePageRange(input: string, total: number): { pages: number[]; error?: undefined } | { pages?: undefined; error: string } {
  const text = (input ?? '').replace(/\s+/g, '');
  const all = Array.from({ length: Math.max(0, total) }, (_, i) => i + 1);
  if (!text) return { pages: all };
  if (text.length > MAX_PAGE_RANGE_LENGTH) return { error: 'Page range is too long.' };
  if (!/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(text)) return { error: 'Use page numbers like 1-3, 5.' };
  const seen = new Set<number>();
  const pages: number[] = [];
  for (const part of text.split(',')) {
    const [a, b = a] = part.split('-').map(Number);
    if (a < 1 || b < a) return { error: `"${part}" is not a valid range.` };
    if (b > total) return { error: `There ${total === 1 ? 'is only 1 page' : `are only ${total} pages`}.` };
    for (let p = a; p <= b; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        pages.push(p);
      }
    }
  }
  return { pages };
}

/** Printed sides of paper for one copy: selected pages put `perSheet` to a side. */
export const printedSides = (selectedPages: number, perSheet: number) => Math.ceil(Math.max(0, selectedPages) / Math.max(1, perSheet));
