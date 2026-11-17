import { parsePageRange, PAGES_PER_SHEET } from '../shared/pageRange';
import { estimatePrice } from '../shared/pricing';
import { COLOR_MODES, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, PAPER_SIZES, type ColorMode, type FinishingCode, type PaperSize, type PublicShop, type PublicTracking, type Sides } from '../shared/types';
import { invalid, notFound, ServiceError } from './errors';
import { inspectUpload, type CheckedFile } from './fileInspect';
import { BUCKET, ensureConfigured, rpc, supabase } from './supabase';
import { int, oneOf, phone, text } from './validate';

/** Customer-facing operations (no sign-in needed). */

const INVALID_QR = 'This QR code is not valid. Please ask the shop for their current QR code.';

export async function getShopByToken(token: string): Promise<PublicShop> {
  ensureConfigured();
  if (!/^[a-z0-9]{6,40}$/.test(token)) throw notFound(INVALID_QR);
  return rpc<PublicShop>('printflow_get_public_shop', { p_token: token });
}

export interface NewOrderInput {
  customerName: string;
  customerPhone: string;
  notes: string;
  colorMode: ColorMode;
  paperSize: PaperSize;
  sides: Sides;
  copies: number;
  finishing: FinishingCode;
  /** Pages to print, e.g. "1-3, 5" (all files together). Empty = all. */
  pageRange?: string;
  /** 1, 2 or 4 pages on each side of a sheet. */
  pagesPerSheet?: number;
}

export interface NewOrderResult {
  trackingCode: string;
  orderNo: number;
  estimatedTotal: number;
  pageCount: number;
}

/**
 * Creates an order with its files.
 * 1. Each file is uploaded to the private Storage bucket (customers can upload but never read files).
 * 2. `create_order` checks the uploads exist, calculates the price from the shop's prices and saves the order.
 * `onProgress` receives 0..1 while files are uploaded.
 */
export async function createOrder(token: string, input: NewOrderInput, files: File[], onProgress?: (fraction: number) => void): Promise<NewOrderResult> {
  const shop = await getShopByToken(token);
  if (!shop.isOpen) throw new ServiceError(403, 'This shop is not accepting online orders right now.');

  if (files.length === 0) throw invalid('Please add at least one document.');
  if (files.length > MAX_UPLOAD_FILES) throw invalid(`You can upload up to ${MAX_UPLOAD_FILES} files at once.`);
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) throw invalid('One of the files is larger than 25 MB.');

  const customerName = text(input.customerName, 'customerName', { label: 'Your name', required: true, max: 80, min: 2 });
  const customerPhone = phone(input.customerPhone, 'customerPhone', 'Phone number', true);
  const notes = text(input.notes, 'notes', { label: 'Notes', max: 500, multiline: true });
  const colorMode = oneOf(input.colorMode, 'colorMode', COLOR_MODES, 'Color');
  const paperSize = oneOf(input.paperSize, 'paperSize', PAPER_SIZES, 'Paper size');
  const sides = oneOf(input.sides, 'sides', ['single', 'double'] as const, 'Sides');
  const copies = int(input.copies, 'copies', { label: 'Copies', min: 1, max: 500 });
  const finishing = oneOf(input.finishing, 'finishing', ['none', ...shop.finishing.map((f) => f.code)] as FinishingCode[], 'Finishing', 'none');

  const checked: CheckedFile[] = [];
  for (const f of files) checked.push(await inspectUpload(f));
  const pageCount = checked.reduce((sum, f) => sum + f.pages, 0);
  const pageRange = text(input.pageRange ?? '', 'pageRange', { label: 'Pages to print', max: 100 }).replace(/\s+/g, '');
  const range = parsePageRange(pageRange, pageCount);
  if (range.error !== undefined) throw invalid(range.error, 'pageRange');
  const pagesPerSheet = Number(input.pagesPerSheet ?? 1);
  if (!(PAGES_PER_SHEET as readonly number[]).includes(pagesPerSheet)) throw invalid('Pages per sheet must be 1, 2 or 4.', 'pagesPerSheet');
  const estimate = estimatePrice(
    { pageCount: range.pages.length, pagesPerSheet, copies, colorMode, paperSize, sides, finishing },
    shop.prices,
    shop.finishing,
  );
  if (!estimate.available) throw invalid('This shop does not offer that paper size and color combination.');

  // 1. Upload the files.
  const batch = crypto.randomUUID();
  const totalBytes = checked.reduce((s, f) => s + f.size, 0) || 1;
  let doneBytes = 0;
  onProgress?.(0);
  const uploaded: { path: string; name: string; mime: string; pages: number }[] = [];
  for (const f of checked) {
    const path = `incoming/${batch}/${crypto.randomUUID()}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, f.file, { contentType: f.mime, upsert: false });
    if (error) {
      throw new ServiceError(
        /size|too large|exceed/i.test(error.message) ? 413 : 503,
        /size|too large|exceed/i.test(error.message) ? `"${f.originalName}" is too large.` : `Could not upload "${f.originalName}". Check your connection and try again.`,
      );
    }
    uploaded.push({ path, name: f.originalName, mime: f.mime, pages: f.pages });
    doneBytes += f.size;
    onProgress?.(doneBytes / totalBytes);
  }

  // 2. Save the order (the database recalculates the price; the client's estimate is only a preview).
  return rpc<NewOrderResult>('printflow_create_order', {
    p_token: token,
    p_order: { customerName, customerPhone, notes, colorMode, paperSize, sides, copies, finishing, pageRange, pagesPerSheet },
    p_files: uploaded,
  });
}

export async function trackOrder(codeInput: string): Promise<PublicTracking> {
  ensureConfigured();
  const code = String(codeInput).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) throw notFound('No order found with that tracking code.');
  const t = await rpc<PublicTracking>('printflow_track_order', { p_code: code });
  return { ...t, estimatedTotal: Number(t.estimatedTotal), finalAmount: t.finalAmount === null ? null : Number(t.finalAmount) };
}
