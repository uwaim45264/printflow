import { printedSides } from './pageRange';
import type { ColorMode, FinishingCode, FinishingOption, PaperSize, PriceRule, Sides } from './types';

export interface EstimateInput {
  /** Pages selected to print (all files together; after the page range). */
  pageCount: number;
  /** Pages printed on each side of a sheet (1, 2 or 4). Default 1. */
  pagesPerSheet?: number;
  copies: number;
  colorMode: ColorMode;
  paperSize: PaperSize;
  sides: Sides;
  finishing: FinishingCode;
}

export interface Estimate {
  sheets: number;
  ratePerSheet: number;
  printCost: number;
  finishingCost: number;
  total: number;
  available: boolean;
}

/**
 * Price estimate used by the customer page (preview) and publicService (saved with the order).
 * Pages are put pagesPerSheet to a side; double-sided rate is charged per sheet (2 sides per sheet).
 * Same formula as printflow_create_order() in the database.
 */
export function estimatePrice(input: EstimateInput, rules: PriceRule[], finishing: FinishingOption[]): Estimate {
  const rule = rules.find((r) => r.paperSize === input.paperSize && r.colorMode === input.colorMode);
  const pages = Math.max(0, Math.floor(input.pageCount));
  const copies = Math.max(1, Math.floor(input.copies));
  if (!rule) {
    return { sheets: 0, ratePerSheet: 0, printCost: 0, finishingCost: 0, total: 0, available: false };
  }
  const sides = printedSides(pages, input.pagesPerSheet ?? 1);
  const sheets = input.sides === 'double' ? Math.ceil(sides / 2) : sides;
  const ratePerSheet = input.sides === 'double' ? rule.priceDouble : rule.priceSingle;
  const printCost = sheets * ratePerSheet * copies;
  let finishingCost = 0;
  if (input.finishing !== 'none') {
    const opt = finishing.find((f) => f.code === input.finishing && f.enabled);
    if (opt) finishingCost = opt.price * copies;
  }
  return {
    sheets,
    ratePerSheet,
    printCost,
    finishingCost,
    total: Math.round((printCost + finishingCost) * 100) / 100,
    available: true,
  };
}

/** Rough PDF page counter that works on raw bytes. */
export function countPdfPages(text: string): number {
  const pageObjects = (text.match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
  let treeCount = 0;
  for (const m of text.matchAll(/\/Count\s+(\d{1,5})/g)) treeCount = Math.max(treeCount, Number(m[1]));
  return Math.min(5000, Math.max(1, pageObjects, treeCount));
}
