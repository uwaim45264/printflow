import type {
  ColorMode,
  FinishingCode,
  FinishingOption,
  Order,
  OrderDetail,
  OrderEvent,
  OrderFile,
  OrderStatus,
  PaperSize,
  PaymentStatus,
  PriceRule,
  Shop,
  ShopStatus,
  Sides,
} from '../shared/types';
import { COLOR_MODES, FINISHING_CODES, PAPER_SIZES } from '../shared/types';

/** Database rows (snake_case, as Supabase returns them) and their conversion into the shapes the UI uses. */

export interface ShopRow {
  id: string;
  name: string;
  owner_name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  operating_hours: string;
  status: ShopStatus;
  qr_token: string;
  created_at: string;
  updated_at: string;
}

export interface OrderRow {
  id: string;
  shop_id: string;
  order_no: number;
  tracking_code: string;
  customer_name: string;
  customer_phone: string;
  notes: string;
  color_mode: ColorMode;
  paper_size: PaperSize;
  sides: Sides;
  copies: number;
  finishing: FinishingCode;
  page_count: number;
  estimated_total: number | string;
  final_amount: number | string | null;
  status: OrderStatus;
  payment_status: PaymentStatus;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderFileRow {
  id: string;
  order_id: string;
  shop_id: string;
  storage_path: string;
  original_name: string;
  mime: string;
  size: number;
  pages: number;
  created_at: string;
  stored: boolean;
}

export interface OrderEventRow {
  id: number;
  status: OrderStatus;
  note: string | null;
  actor: string;
  created_at: string;
}

export interface PriceRuleRow {
  paper_size: PaperSize;
  color_mode: ColorMode;
  price_single: number | string;
  price_double: number | string;
}

export interface FinishingRow {
  code: Exclude<FinishingCode, 'none'>;
  name: string;
  price: number | string;
  enabled: boolean;
}

const num = (v: number | string) => Number(v);

export const toShop = (r: ShopRow): Shop => ({
  id: r.id,
  name: r.name,
  ownerName: r.owner_name,
  phone: r.phone,
  email: r.email,
  address: r.address,
  city: r.city,
  operatingHours: r.operating_hours,
  status: r.status,
  qrToken: r.qr_token,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function toOrder(r: OrderRow & { order_files?: { count: number }[] | OrderFileRow[] }, fileCount?: number): Order {
  const files = r.order_files ?? [];
  const count = fileCount ?? (files.length && 'count' in files[0] ? (files[0] as { count: number }).count : files.length);
  return {
    id: r.id,
    shopId: r.shop_id,
    orderNo: r.order_no,
    trackingCode: r.tracking_code,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    notes: r.notes,
    colorMode: r.color_mode,
    paperSize: r.paper_size,
    sides: r.sides,
    copies: r.copies,
    finishing: r.finishing,
    pageCount: r.page_count,
    estimatedTotal: num(r.estimated_total),
    finalAmount: r.final_amount === null ? null : num(r.final_amount),
    status: r.status,
    paymentStatus: r.payment_status,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fileCount: count,
  };
}

export const toOrderFile = (f: OrderFileRow): OrderFile => ({
  id: f.id,
  originalName: f.original_name,
  mime: f.mime,
  size: Number(f.size),
  pages: f.pages,
  createdAt: f.created_at,
  purged: !f.stored,
});

export const toOrderEvent = (e: OrderEventRow): OrderEvent => ({ status: e.status, note: e.note, actor: e.actor, createdAt: e.created_at });

export function toOrderDetail(r: OrderRow & { order_files: OrderFileRow[]; order_events: OrderEventRow[] }): OrderDetail {
  const files = [...r.order_files].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.original_name.localeCompare(b.original_name)).map(toOrderFile);
  const events = [...r.order_events].sort((a, b) => a.id - b.id).map(toOrderEvent);
  return { ...toOrder(r, files.length), files, events };
}

export function toPriceRules(rows: PriceRuleRow[]): PriceRule[] {
  return rows
    .map((r) => ({ paperSize: r.paper_size, colorMode: r.color_mode, priceSingle: num(r.price_single), priceDouble: num(r.price_double) }))
    .sort((a, b) => PAPER_SIZES.indexOf(a.paperSize) - PAPER_SIZES.indexOf(b.paperSize) || COLOR_MODES.indexOf(a.colorMode) - COLOR_MODES.indexOf(b.colorMode));
}

export function toFinishing(rows: FinishingRow[]): FinishingOption[] {
  return rows
    .map((f) => ({ code: f.code, name: f.name, price: num(f.price), enabled: f.enabled }))
    .sort((a, b) => FINISHING_CODES.indexOf(a.code) - FINISHING_CODES.indexOf(b.code));
}

const localDateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function weekStart() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  return start;
}

/** Start of the 7-day chart window (local time), for queries. */
export const weekStartIso = () => weekStart().toISOString();

/** Orders per day for the last 7 days (local time), oldest first, from a list of order creation times. */
export function last7Days(createdAt: string[]) {
  const start = weekStart();
  const days: { date: string; count: number }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push({ date: localDateKey(d), count: 0 });
  }
  for (const c of createdAt) {
    const day = days.find((d) => d.date === localDateKey(new Date(c)));
    if (day) day.count += 1;
  }
  return days;
}

export function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function startOfMonthIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.toISOString();
}
