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
import { check, cleanupStorage, filesFunction, getToken, isUuid, rpc, supabase } from './supabase';
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

/** Downloads files through short-lived links from the printflow-files Edge Function (which checks the session). */
async function downloadAll(rows: OrderFileRow[]): Promise<Map<string, Blob>> {
  const token = getToken();
  if (!token) throw new ServiceError(401, 'Please sign in.');
  const { files } = await filesFunction<{ files: { id: string; url: string | null; deleted: boolean }[] }>({
    action: 'sign',
    token,
    fileIds: rows.map((r) => r.id),
  });
  const out = new Map<string, Blob>();
  for (const row of rows) {
    const link = files.find((f) => f.id === row.id);
    if (!link || link.deleted || !link.url) throw new ServiceError(410, `"${row.original_name}" has been deleted.`);
    const res = await fetch(link.url).catch(() => null);
    if (!res || !res.ok) throw new ServiceError(res?.status === 404 ? 404 : 503, `Could not download "${row.original_name}". Please try again.`);
    const blob = await res.blob();
    out.set(row.id, blob.type === row.mime ? blob : new Blob([blob], { type: row.mime }));
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

/** Builds one PDF with the selected files of an order (images fitted to the paper size). Originals are not changed. */
export async function buildPrintBundle(orderId: string, fileIds: string[]): Promise<Blob> {
  const { shopId } = await owner();
  const order = await getOrder(orderId);
  const files = printableFiles(order, await orderFileRows(shopId, order.id), fileIds);
  const { PDFDocument } = await import('pdf-lib');
  const out = await PDFDocument.create();
  out.setTitle('PrintFlow print job');
  const [pw, ph] = PAGE_SIZES[order.paperSize] ?? PAGE_SIZES.A4;
  const margin = 18;

  const blobs = await downloadAll(files);
  for (const f of files) {
    const bytes = new Uint8Array(await blobs.get(f.id)!.arrayBuffer());
    if (f.mime === 'application/pdf') {
      let src;
      try {
        src = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
      } catch (err) {
        throw new ServiceError(
          422,
          /encrypt/i.test(String((err as Error)?.message))
            ? `"${f.original_name}" is password protected. Download it and print it from a PDF reader.`
            : `"${f.original_name}" could not be read as a PDF. Download it and print it from a PDF reader.`,
        );
      }
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } else {
      const img = f.mime === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      const landscape = img.width > img.height; // wide images go on landscape paper
      const [w, h] = landscape ? [ph, pw] : [pw, ph];
      const page = out.addPage([w, h]);
      const scale = Math.min((w - margin * 2) / img.width, (h - margin * 2) / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      page.drawImage(img, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh });
    }
  }
  const pdf = await out.save();
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}

/** Records that files were sent to the printer, and optionally moves the order to "printing". */
export async function logPrint(orderId: string, fileIds: string[], markPrinting: boolean): Promise<OrderDetail> {
  const { shopId } = await owner();
  const order = await getOrder(orderId);
  const files = printableFiles(order, await orderFileRows(shopId, order.id), fileIds);
  await rpc('printflow_shop_log_print', { p_order_id: order.id, p_file_ids: files.map((f) => f.id), p_mark_printing: markPrinting });
  return getOrder(orderId);
}
