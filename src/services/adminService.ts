import type { ActivityEntry, AdminStats, Shop, ShopWithStats } from '../shared/types';
import { passwordProblem } from './crypto';
import { invalid, notFound } from './errors';
import { last7Days, startOfTodayIso, toShop, weekStartIso, type ShopRow } from './mappers';
import { requireRole } from './session';
import { check, cleanupStorage, isUuid, rpc, supabase } from './supabase';
import { email, oneOf, phone, text, username } from './validate';

/**
 * Super Admin operations. Reads use Row Level Security (only a Super Admin sees every shop);
 * changes (including creating logins and resetting passwords) go through database functions.
 */

export interface ShopInput {
  name: string;
  ownerName: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  operatingHours: string;
}

export interface Credentials {
  username: string;
  temporaryPassword: string;
}

const admin = () => requireRole('super_admin');

function readShopFields(v: Partial<ShopInput>): ShopInput {
  return {
    name: text(v.name, 'name', { label: 'Shop name', required: true, max: 80, min: 2 }),
    ownerName: text(v.ownerName, 'ownerName', { label: 'Owner name', required: true, max: 80 }),
    phone: phone(v.phone, 'phone', 'Phone', true),
    email: email(v.email, 'email', false),
    address: text(v.address, 'address', { label: 'Address', max: 200 }),
    city: text(v.city, 'city', { label: 'City', max: 60 }),
    operatingHours: text(v.operatingHours, 'operatingHours', { label: 'Opening hours', max: 80 }),
  };
}

interface StatsRow {
  shop_id: string;
  order_count: number;
  pending_count: number;
  last_order_at: string | null;
}

interface OwnerInfo {
  shopId: string;
  username: string;
  lastLoginAt: string | null;
}

async function shopsWithStats(shopId?: string): Promise<ShopWithStats[]> {
  let shopsQ = supabase.from('printflow_shops').select('*').order('created_at', { ascending: false });
  let statsQ = supabase.from('printflow_shop_order_stats').select('*');
  if (shopId) {
    shopsQ = shopsQ.eq('id', shopId);
    statsQ = statsQ.eq('shop_id', shopId);
  }
  const [shops, owners, stats] = await Promise.all([shopsQ, rpc<OwnerInfo[]>('printflow_admin_shop_owners'), statsQ]);
  const ownerBy = new Map(owners.map((o) => [o.shopId, o]));
  const statsBy = new Map((check(stats) as StatsRow[]).map((s) => [s.shop_id, s]));
  return (check(shops) as ShopRow[]).map((s) => {
    const owner = ownerBy.get(s.id);
    const st = statsBy.get(s.id);
    return {
      ...toShop(s),
      ownerUsername: owner?.username ?? null,
      ownerLastLoginAt: owner?.lastLoginAt ?? null,
      orderCount: st?.order_count ?? 0,
      pendingCount: st?.pending_count ?? 0,
      lastOrderAt: st?.last_order_at ?? null,
    };
  });
}

export async function getStats(): Promise<AdminStats> {
  await admin();
  const s = await rpc<Omit<AdminStats, 'last7Days'> & { recent: string[] }>('printflow_admin_stats', { p_today: startOfTodayIso(), p_week_start: weekStartIso() });
  const { recent, ...rest } = s;
  return { ...rest, storageBytes: Number(rest.storageBytes), last7Days: last7Days(recent) };
}

export async function listShops(): Promise<ShopWithStats[]> {
  await admin();
  return shopsWithStats();
}

export async function getShop(id: string): Promise<ShopWithStats> {
  await admin();
  if (!isUuid(id)) throw notFound('Shop not found.');
  const [shop] = await shopsWithStats(id);
  if (!shop) throw notFound('Shop not found.');
  return shop;
}

export async function createShop(input: ShopInput & { ownerUsername: string; ownerPassword?: string }): Promise<{ shop: Shop; credentials: Credentials }> {
  await admin();
  const f = readShopFields(input);
  const ownerUsername = username(input.ownerUsername, 'ownerUsername');
  if (input.ownerPassword) {
    const problem = passwordProblem(input.ownerPassword);
    if (problem) throw invalid(problem, 'ownerPassword');
  }
  const res = await rpc<{ shopId: string; username: string; temporaryPassword: string }>('printflow_admin_create_shop', {
    p_name: f.name,
    p_owner_name: f.ownerName,
    p_phone: f.phone,
    p_email: f.email,
    p_address: f.address,
    p_city: f.city,
    p_operating_hours: f.operatingHours,
    p_owner_username: ownerUsername,
    p_owner_password: input.ownerPassword || null,
  });
  const row = check(await supabase.from('printflow_shops').select('*').eq('id', res.shopId).single()) as ShopRow;
  // The temporary password is shown once; the database stores only its bcrypt hash.
  return { shop: toShop(row), credentials: { username: res.username, temporaryPassword: res.temporaryPassword } };
}

export async function updateShop(id: string, input: ShopInput): Promise<ShopWithStats> {
  await admin();
  if (!isUuid(id)) throw notFound('Shop not found.');
  const f = readShopFields(input);
  await rpc('printflow_admin_update_shop', {
    p_shop_id: id,
    p_name: f.name,
    p_owner_name: f.ownerName,
    p_phone: f.phone,
    p_email: f.email,
    p_address: f.address,
    p_city: f.city,
    p_operating_hours: f.operatingHours,
  });
  return getShop(id);
}

export async function setShopStatus(id: string, status: 'active' | 'inactive'): Promise<ShopWithStats> {
  await admin();
  if (!isUuid(id)) throw notFound('Shop not found.');
  const next = oneOf(status, 'status', ['active', 'inactive'] as const, 'Status');
  await rpc('printflow_admin_set_shop_status', { p_shop_id: id, p_status: next });
  return getShop(id);
}

export async function resetOwnerPassword(id: string): Promise<Credentials> {
  await admin();
  if (!isUuid(id)) throw notFound('Shop not found.');
  return rpc<Credentials>('printflow_admin_reset_owner_password', { p_shop_id: id });
}

export async function deleteShop(id: string, confirmName: string): Promise<void> {
  await admin();
  if (!isUuid(id)) throw notFound('Shop not found.');
  await rpc('printflow_admin_delete_shop', { p_shop_id: id, p_confirm_name: confirmName });
  cleanupStorage(); // removes the shop's files from Storage in the background
}

interface ActivityRow {
  id: number;
  shop_id: string | null;
  actor: string;
  action: string;
  details: string;
  created_at: string;
  shop: { name: string } | null;
}

export async function listActivity(shopId?: string): Promise<ActivityEntry[]> {
  await admin();
  let q = supabase
    .from('printflow_activity_log')
    .select('id, shop_id, actor, action, details, created_at, shop:printflow_shops(name)')
    .order('id', { ascending: false })
    .limit(shopId ? 100 : 200);
  if (shopId) {
    if (!isUuid(shopId)) return [];
    q = q.eq('shop_id', shopId);
  }
  const rows = check(await q) as unknown as ActivityRow[];
  return rows.map((a) => ({
    id: a.id,
    shopId: a.shop_id,
    shopName: a.shop?.name ?? null,
    actor: a.actor,
    action: a.action,
    details: a.details,
    createdAt: a.created_at,
  }));
}
