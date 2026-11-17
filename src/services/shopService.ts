import {
  COLOR_MODES,
  FINISHING_CODES,
  ORDER_STATUSES,
  PAPER_SIZES,
  type FinishingOption,
  type Order,
  type OrderDetail,
  type OrderStatus,
  type PaperSize,
  type PriceRule,
  type Shop,
  type ShopStats,
} from '../shared/types';
import { invalid, notFound, ServiceError } from './errors';
import {
  last7Days,
  startOfMonthIso,
  startOfTodayIso,
  toFinishing,
  toOrder,
  toOrderDetail,
  toPriceRules,
  toShop,
  weekStartIso,
  type FinishingRow,
  type OrderEventRow,
  type OrderFileRow,
  type OrderRow,
  type PriceRuleRow,
  type ShopRow,
} from './mappers';
import { requireRole } from './session';
import { parsePageRange } from '../shared/pageRange';
import { BUCKET, check, cleanupStorage, filesFunction, getToken, isUuid, rpc, supabase } from './supabase';
import { email, money, oneOf, phone, text } from './validate';

/**
 * Shop-owner operations. The shop id ALWAYS comes from the signed-in session, and Row Level Security
 * in the database only returns the owner's own shop's rows, so one shop can never see another shop's data.
 */

async function owner() {
  const user = await requireRole('shop_owner');
  return { shopId: user.shopId!, actor: user.username };
}

// ---------- Profile ----------

export async function getMyShop(): Promise<Shop> {
  const { shopId } = await owner();
  const row = check(await supabase.from('printflow_shops').select('*').eq('id', shopId).maybeSingle()) as ShopRow | null;
  if (!row) throw notFound('Shop not found.');
  return toShop(row);
}

export interface ShopProfileInput {
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  operatingHours: string;
}

export async function updateMyShop(v: ShopProfileInput): Promise<Shop> {
  await owner();
  await rpc('printflow_shop_update_profile', {
    p_name: text(v.name, 'name', { label: 'Shop name', required: true, max: 80, min: 2 }),
    p_phone: phone(v.phone, 'phone', 'Phone', true),
    p_email: email(v.email, 'email', false),
    p_address: text(v.address, 'address', { label: 'Address', max: 200 }),
    p_city: text(v.city, 'city', { label: 'City', max: 60 }),
    p_operating_hours: text(v.operatingHours, 'operatingHours', { label: 'Opening hours', max: 80 }),
  });
  return getMyShop();
}

export async function getStats(): Promise<ShopStats> {
  await owner();
  const s = await rpc<Omit<ShopStats, 'last7Days'> & { recent: string[] }>('printflow_shop_stats', {
    p_today: startOfTodayIso(),
    p_month: startOfMonthIso(),
    p_week_start: weekStartIso(),
  });
  const { recent, ...rest } = s;
  return { ...rest, revenueThisMonth: Number(rest.revenueThisMonth), last7Days: last7Days(recent) };
}

// ---------- Orders ----------

export type OrderFilter = OrderStatus | 'active' | 'all';

const ORDER_DETAIL_SELECT = '*, order_files:printflow_order_files(*), order_events:printflow_order_events(id, status, note, actor, created_at)';

export async function listOrders(opts: { status?: OrderFilter; q?: string; limit?: number; offset?: number } = {}): Promise<{ orders: Order[]; total: number }> {
  const { shopId } = await owner();
  const status = opts.status && opts.status !== 'all' ? opts.status : undefined;
  if (status && status !== 'active' && !ORDER_STATUSES.includes(status)) throw invalid('Unknown status filter.');
  const q = (opts.q ?? '').trim().slice(0, 60).toLowerCase();
  const limit = Math.min(500, Math.max(1, opts.limit ?? 25));
  const offset = Math.max(0, opts.offset ?? 0);

  let query = supabase.from('printflow_orders').select('*, order_files:printflow_order_files(count)', { count: 'exact' }).eq('shop_id', shopId);
  if (status === 'active') query = query.in('status', ['pending', 'accepted', 'printing', 'ready']);
  else if (status) query = query.eq('status', status);
  if (q) query = query.ilike('search_text', `%${q.replace(/[\\%_*]/g, (c) => `\\${c}`)}%`);
  const res = await query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  const rows = check(res) as (OrderRow & { order_files: { count: number }[] })[];
  return { total: res.count ?? rows.length, orders: rows.map((o) => toOrder(o)) };
}

export async function getOrder(orderId: string): Promise<OrderDetail> {
  const { shopId } = await owner();
  if (!isUuid(orderId)) throw notFound('Order not found.');
  const row = check(await supabase.from('printflow_orders').select(ORDER_DETAIL_SELECT).eq('id', orderId).eq('shop_id', shopId).maybeSingle()) as
    | (OrderRow & { order_files: OrderFileRow[]; order_events: OrderEventRow[] })
    | null;
  if (!row) throw notFound('Order not found.');
  return toOrderDetail(row);
}

export async function setOrderStatus(orderId: string, next: OrderStatus, extra: { reason?: string; note?: string } = {}): Promise<OrderDetail> {
  await owner();
  if (!isUuid(orderId)) throw notFound('Order not found.');
  const status = oneOf(next, 'status', ORDER_STATUSES, 'Status');
  const reason = status === 'rejected' ? text(extra.reason, 'reason', { label: 'Reason', required: true, max: 300 }) : null;
  const note = text(extra.note, 'note', { label: 'Note', max: 300 }) || null;
  await rpc('printflow_shop_set_order_status', { p_order_id: orderId, p_status: status, p_reason: reason, p_note: note });
  return getOrder(orderId);
}

export async function setBilling(orderId: string, finalAmount: number | null, paymentStatus: 'paid' | 'unpaid'): Promise<OrderDetail> {
  await owner();
  if (!isUuid(orderId)) throw notFound('Order not found.');
  const amount = finalAmount === null ? null : money(finalAmount, 'Final amount', 'finalAmount');
  const pay = oneOf(paymentStatus, 'paymentStatus', ['unpaid', 'paid'] as const, 'Payment status');
  await rpc('printflow_shop_set_billing', { p_order_id: orderId, p_final_amount: amount, p_payment_status: pay });
  return getOrder(orderId);
}

/** Deletes the stored documents of an order (the order record and history are kept). */
export async function purgeOrderFiles(orderId: string): Promise<OrderDetail> {
  await owner();
  if (!isUuid(orderId)) throw notFound('Order not found.');
  await rpc<number>('printflow_shop_purge_order_files', { p_order_id: orderId });
  cleanupStorage(); // removes the files from Storage in the background
  return getOrder(orderId);
}

async function fileRow(shopId: string, fileId: string): Promise<OrderFileRow> {
  if (!isUuid(fileId)) throw notFound('File not found.');
  const row = check(await supabase.from('printflow_order_files').select('*').eq('id', fileId).eq('shop_id', shopId).maybeSingle()) as OrderFileRow | null;
  if (!row) throw notFound('File not found.');
  if (!row.stored) throw new ServiceError(410, 'This file has been deleted.');
  return row;
}

const typed = (blob: Blob, mime: string) => (blob.type === mime ? blob : new Blob([blob], { type: mime }));

/**
 * Downloads files straight from Storage (Row Level Security checks the session header, see migration
 * 20261117010000). If that is not set up, falls back to the printflow-files Edge Function.
 */
async function downloadAll(rows: OrderFileRow[]): Promise<Map<string, Blob>> {
  const token = getToken();
  if (!token) throw new ServiceError(401, 'Please sign in.');
  const out = new Map<string, Blob>();
  const missing: OrderFileRow[] = [];
  for (const row of rows) {
    if (!row.stored) throw new ServiceError(410, `"${row.original_name}" has been deleted.`);
    const { data, error } = await supabase.storage.from(BUCKET).download(row.storage_path);
    if (data && !error) out.set(row.id, typed(data, row.mime));
    else missing.push(row);
  }
  if (missing.length) (await downloadViaFunction(token, missing)).forEach((blob, id) => out.set(id, blob));
  return out;
}

/** Downloads files through short-lived links from the printflow-files Edge Function (which checks the session). */
async function downloadViaFunction(token: string, rows: OrderFileRow[]): Promise<Map<string, Blob>> {
  let files: { id: string; url: string | null; deleted: boolean }[];
  try {
    ({ files } = await filesFunction<{ files: { id: string; url: string | null; deleted: boolean }[] }>({
      action: 'sign',
      token,
      fileIds: rows.map((r) => r.id),
    }));
  } catch (err) {
    // 503 = function unreachable, 404 = function not deployed.
    if (err instanceof ServiceError && (err.status === 503 || err.status === 404)) {
      throw new ServiceError(
        503,
        `Could not open "${rows[0].original_name}". File access is not set up yet: run supabase/migrations/20261117010000_printflow_direct_file_access.sql in the Supabase SQL Editor.`,
      );
    }
    throw err;
  }
  const out = new Map<string, Blob>();
  for (const row of rows) {
    const link = files.find((f) => f.id === row.id);
    if (!link || link.deleted || !link.url) throw new ServiceError(410, `"${row.original_name}" has been deleted.`);
    const res = await fetch(link.url).catch(() => null);
    if (!res || !res.ok) throw new ServiceError(res?.status === 404 ? 404 : 503, `Could not download "${row.original_name}". Please try again.`);
    out.set(row.id, typed(await res.blob(), row.mime));
  }
  return out;
}

/** The contents of one uploaded file, as a Blob with the right type. */
export async function getFileBlob(fileId: string): Promise<{ blob: Blob; name: string; mime: string }> {
  const { shopId } = await owner();
  const row = await fileRow(shopId, fileId);
  const blob = (await downloadAll([row])).get(row.id)!;
  return { blob, name: row.original_name, mime: row.mime };
}

// ---------- Pricing ----------

export async function getPricing(): Promise<{ prices: PriceRule[]; finishing: FinishingOption[] }> {
  const { shopId } = await owner();
  const [prices, finishing] = await Promise.all([
    supabase.from('printflow_price_rules').select('paper_size, color_mode, price_single, price_double').eq('shop_id', shopId),
    supabase.from('printflow_finishing_options').select('code, name, price, enabled').eq('shop_id', shopId),
  ]);
  return { prices: toPriceRules(check(prices) as PriceRuleRow[]), finishing: toFinishing(check(finishing) as FinishingRow[]) };
}

export async function savePricing(input: { prices: PriceRule[]; finishing: { code: string; price: number; enabled: boolean }[] }) {
  await owner();
  const { prices, finishing } = input;
  if (!Array.isArray(prices) || !Array.isArray(finishing)) throw invalid('Prices and finishing options are required.');
  if (prices.length > PAPER_SIZES.length * COLOR_MODES.length || finishing.length > FINISHING_CODES.length) throw invalid('Too many price rows.');
  const cleanPrices = prices.map((p) => {
    const size = oneOf(p.paperSize, 'paperSize', PAPER_SIZES, 'Paper size');
    const mode = oneOf(p.colorMode, 'colorMode', COLOR_MODES, 'Color mode');
    return { paperSize: size, colorMode: mode, priceSingle: money(p.priceSingle, `${size} single-sided price`), priceDouble: money(p.priceDouble, `${size} double-sided price`) };
  });
  const seen = new Set(cleanPrices.map((p) => `${p.paperSize}/${p.colorMode}`));
  if (seen.size !== cleanPrices.length) throw invalid('Each paper size and color can only have one price.');
  const cleanFinishing = finishing.map((f) => ({ code: oneOf(f.code, 'code', FINISHING_CODES, 'Finishing option'), price: money(f.price, 'Finishing price'), enabled: !!f.enabled }));
  await rpc('printflow_shop_save_pricing', { p_prices: cleanPrices, p_finishing: cleanFinishing });
  return getPricing();
}

// ---------- QR code ----------

export async function regenerateQr(): Promise<Shop> {
  await owner();
  await rpc('printflow_shop_regenerate_qr');
  return getMyShop();
}

// ---------- Printing (browser print dialog) ----------

const PRINTABLE_MIMES = ['application/pdf', 'image/png', 'image/jpeg'];

function printableFiles(order: OrderDetail, rows: OrderFileRow[], fileIds: string[]) {
  if (!fileIds.length) throw invalid('Select at least one file to print.');
  return [...new Set(fileIds)].map((id) => {
    const f = rows.find((r) => r.id === id && r.order_id === order.id);
    if (!f) throw notFound('One of the selected files was not found in this order.');
    if (!f.stored) throw new ServiceError(410, `"${f.original_name}" has been deleted and can’t be printed.`);
    if (!PRINTABLE_MIMES.includes(f.mime)) throw new ServiceError(422, `"${f.original_name}" is a Word document. Download it and print it from Word.`);
    return f;
  });
}

async function orderFileRows(shopId: string, orderId: string): Promise<OrderFileRow[]> {
  return check(await supabase.from('printflow_order_files').select('*').eq('order_id', orderId).eq('shop_id', shopId)) as OrderFileRow[];
}

const PAGE_SIZES: Record<PaperSize, [number, number]> = { A4: [595.28, 841.89], A3: [841.89, 1190.55], Legal: [612, 1008] };

/**
 * Where to draw content of size w×h, rotated `rot` degrees counter-clockwise and scaled by s, so it is centred on a
 * pw×ph page. Returns the drawing origin (pdf-lib rotates around it).
 */
function placement(w: number, h: number, rot: number, s: number, pw: number, ph: number) {
  const sideways = rot === 90 || rot === 270;
  const bw = (sideways ? h : w) * s;
  const bh = (sideways ? w : h) * s;
  const left = (pw - bw) / 2;
  const bottom = (ph - bh) / 2;
  if (rot === 90) return { x: left + bw, y: bottom };
  if (rot === 180) return { x: left + bw, y: bottom + bh };
  if (rot === 270) return { x: left, y: bottom + bh };
  return { x: left, y: bottom };
}

/** Above this many printed pages the copies are not repeated inside the file (too slow to preview); the dialog's
 *  Copies preset is used instead. */
const MAX_BAKED_PAGES = 1500;

/** Turns an image grey (for black & white orders), keeping PNG transparency. */
async function toGrayscale(blob: Blob, mime: string): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!out) throw new ServiceError(500, 'Could not prepare the image for black & white printing.');
  return new Uint8Array(await out.arrayBuffer());
}

/** Areas of one sheet that hold 1, 2 (stacked) or 4 (2×2) pages, in reading order. */
function sheetCells(perSheet: number, pw: number, ph: number) {
  if (perSheet === 2) return [{ x: 0, y: ph / 2, w: pw, h: ph / 2 }, { x: 0, y: 0, w: pw, h: ph / 2 }];
  if (perSheet === 4) {
    const w = pw / 2;
    const h = ph / 2;
    return [{ x: 0, y: h, w, h }, { x: w, y: h, w, h }, { x: 0, y: 0, w, h }, { x: w, y: 0, w, h }];
  }
  return [{ x: 0, y: 0, w: pw, h: ph }];
}

export interface PrintBundle {
  blob: Blob;
  /** True when every copy is already inside the file (leave Copies at 1 in the dialog). */
  copiesIncluded: boolean;
  /** Printed pages in the file (all copies, including blank backs added for double-sided). */
  sheets: number;
}

/**
 * Builds one PDF with the selected files of an order, ready to print as the customer asked. Originals are not changed.
 *  - only the customer's "Pages to print", put "Pages per sheet" to a side
 *  - every sheet has the customer's paper size (portrait; content is turned when that fits the space better)
 *  - copies are repeated inside the file unless `includeCopies` is false (the print program sets copies itself);
 *    double-sided: a blank back is added after an odd page count so each copy starts on a new sheet
 *  - black & white orders: photos are made grey
 *  - single/double-sided is stored as a print preset (Chrome/Edge pre-select it on printers that support it)
 */
export async function buildPrintBundle(orderId: string, fileIds: string[], opts: { includeCopies?: boolean } = {}): Promise<PrintBundle> {
  const { shopId } = await owner();
  const order = await getOrder(orderId);
  const files = printableFiles(order, await orderFileRows(shopId, order.id), fileIds);
  const { PDFDocument, Duplex, degrees } = await import('pdf-lib');
  type Page = ReturnType<Awaited<ReturnType<typeof PDFDocument.create>>['addPage']>;
  type Cell = { x: number; y: number; w: number; h: number };
  const out = await PDFDocument.create();
  out.setTitle(`PrintFlow order #${order.orderNo}`);
  const [pw, ph] = PAGE_SIZES[order.paperSize] ?? PAGE_SIZES.A4;
  const double = order.sides === 'double';
  const perSheet = [1, 2, 4].includes(order.pagesPerSheet) ? order.pagesPerSheet : 1;

  const prefs = out.catalog.getOrCreateViewerPreferences();
  prefs.setDuplex(double ? Duplex.DuplexFlipLongEdge : Duplex.Simplex);
  prefs.setPickTrayByPDFSize(true);
  prefs.setDisplayDocTitle(true);

  /**
   * Draws content of natural size w×h (already turned by `baseRot`) into a cell: turned a quarter more when that
   * fits better, scaled to fit inside the margin and centred.
   */
  const fit = (w: number, h: number, baseRot: number, cell: Cell, margin: number) => {
    const sideways = baseRot === 90 || baseRot === 270;
    const [vw, vh] = sideways ? [h, w] : [w, h];
    const turn = vw > vh !== cell.w > cell.h && Math.abs(vw - vh) > 1;
    const rot = turn ? (baseRot + 270) % 360 : baseRot;
    const turned = rot === 90 || rot === 270;
    const s = Math.min((cell.w - margin * 2) / (turned ? h : w), (cell.h - margin * 2) / (turned ? w : h));
    const at = placement(w, h, rot, s, cell.w, cell.h);
    return { x: cell.x + at.x, y: cell.y + at.y, s, rot };
  };

  // Global page numbers count through all of the order's files in order (that is what "Pages to print" refers to).
  const offsets = new Map<string, number>();
  let running = 0;
  for (const f of order.files) {
    offsets.set(f.id, running);
    running += f.pages;
  }
  const range = parsePageRange(order.pageRange, order.pageCount);
  const wanted = range.pages ? new Set(range.pages) : null; // invalid stored range → print everything

  // One entry per page to print, in document order.
  const items: ((page: Page, cell: Cell) => void)[] = [];
  const gap = perSheet === 1 ? 0 : 6;
  const blobs = await downloadAll(files);
  for (const f of order.files.filter((x) => files.some((r) => r.id === x.id))) {
    const row = files.find((r) => r.id === f.id)!;
    const offset = offsets.get(f.id) ?? 0;
    const blob = blobs.get(f.id)!;
    if (row.mime === 'application/pdf') {
      let src: Awaited<ReturnType<typeof PDFDocument.load>>;
      try {
        src = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), { ignoreEncryption: false, updateMetadata: false });
      } catch (err) {
        throw new ServiceError(
          422,
          /encrypt/i.test(String((err as Error)?.message))
            ? `"${row.original_name}" is password protected. Download it and print it from a PDF reader.`
            : `"${row.original_name}" could not be read as a PDF. Download it and print it from a PDF reader.`,
        );
      }
      const srcPages = src.getPages().filter((_, i) => !wanted || wanted.has(offset + i + 1));
      if (!srcPages.length) continue;
      const boxes = srcPages.map((p) => {
        const b = p.getCropBox();
        return { left: b.x, bottom: b.y, right: b.x + b.width, top: b.y + b.height };
      });
      const embedded = await out.embedPages(srcPages, boxes);
      srcPages.forEach((p, i) => {
        const e = embedded[i];
        // The page's own /Rotate turns it clockwise in viewers; drawing turns counter-clockwise.
        const own = ((p.getRotation().angle % 360) + 360) % 360;
        const baseRot = (360 - own) % 360;
        items.push((page, cell) => {
          const { x, y, s, rot } = fit(e.width, e.height, baseRot, cell, gap);
          page.drawPage(e, { x, y, xScale: s, yScale: s, rotate: degrees(rot) });
        });
      });
    } else {
      if (wanted && !wanted.has(offset + 1)) continue;
      const bytes = order.colorMode === 'bw' ? await toGrayscale(blob, row.mime) : new Uint8Array(await blob.arrayBuffer());
      const img = row.mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      items.push((page, cell) => {
        const { x, y, s, rot } = fit(img.width, img.height, 0, cell, perSheet === 1 ? 18 : gap);
        page.drawImage(img, { x, y, width: img.width * s, height: img.height * s, rotate: degrees(rot) });
      });
    }
  }
  if (!items.length) throw invalid('None of the selected files contain the pages the customer asked for.');

  // Group the pages onto sheets.
  const cells = sheetCells(perSheet, pw, ph);
  const sides: ((page: Page) => void)[] = [];
  for (let i = 0; i < items.length; i += perSheet) {
    const group = items.slice(i, i + perSheet);
    sides.push((page) => group.forEach((draw, j) => draw(page, cells[j])));
  }

  const copies = Math.max(1, Math.round(order.copies));
  const padBack = double && sides.length % 2 === 1 && copies > 1; // each copy starts on a fresh sheet
  const perCopy = sides.length + (padBack ? 1 : 0);
  const copiesIncluded = opts.includeCopies !== false && perCopy * copies <= MAX_BAKED_PAGES;
  const repeat = copiesIncluded ? copies : 1;
  if (!copiesIncluded && opts.includeCopies !== false) prefs.setNumCopies(copies); // too big to repeat: ask the dialog

  for (let c = 0; c < repeat; c++) {
    for (const side of sides) side(out.addPage([pw, ph]));
    if (padBack && c < repeat - 1) out.addPage([pw, ph]); // blank back
  }
  const pdf = await out.save();
  return { blob: new Blob([pdf as BlobPart], { type: 'application/pdf' }), copiesIncluded, sheets: out.getPageCount() };
}

/** Records that files were sent to the printer, and optionally moves the order to "printing". */
export async function logPrint(orderId: string, fileIds: string[], markPrinting: boolean): Promise<OrderDetail> {
  const { shopId } = await owner();
  const order = await getOrder(orderId);
  const files = printableFiles(order, await orderFileRows(shopId, order.id), fileIds);
  await rpc('printflow_shop_log_print', { p_order_id: order.id, p_file_ids: files.map((f) => f.id), p_mark_printing: markPrinting });
  return getOrder(orderId);
}
