import { createClient, FunctionsHttpError } from '@supabase/supabase-js';
import { ServiceError } from './errors';

/**
 * The Supabase client. Only the public URL and anon (publishable) key are used in the browser.
 *
 * PrintFlow has its own users table and sessions (Supabase Auth is not used). The session token is kept in
 * this browser and sent as the `x-printflow-session` header on every database request; Row Level Security and
 * the database functions use it to decide what the caller may read or change.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabaseConfigured = Boolean(url && anonKey);

/** Storage bucket for uploaded documents (private). */
export const BUCKET = 'printflow-files';

// ---------- session token (this browser) ----------

const TOKEN_KEY = 'printflow:session';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the session lasts until the page is closed */
  }
}

export const TOKEN_STORAGE_KEY = TOKEN_KEY;

/** Adds the session header to database (PostgREST) and Storage requests (RLS on both reads it). */
const fetchWithSession: typeof fetch = (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const token = getToken();
  if (!token || !(target.includes('/rest/v1/') || target.includes('/storage/v1/'))) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('x-printflow-session', token);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(url || 'http://localhost:54321', anonKey || 'not-configured', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: fetchWithSession },
});

export function ensureConfigured() {
  if (!supabaseConfigured) {
    throw new ServiceError(503, 'The app is not connected to Supabase. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env and restart.');
  }
}

// ---------- errors ----------

interface DbError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

/** Converts a Supabase/PostgREST error into the ServiceError the UI understands. */
export function toDbServiceError(err: DbError): ServiceError {
  const code = err.code ?? '';
  const pt = /^PT(\d{3})$/.exec(code);
  if (pt) return new ServiceError(Number(pt[1]), err.message, err.details || undefined, err.hint || undefined);
  if (code === 'PGRST116' || code === '22P02') return new ServiceError(404, 'Not found.');
  if (code === '23505') return new ServiceError(409, 'That already exists.');
  if (code === '23514' || code === '23502' || code === '22023' || code === '22003') return new ServiceError(400, 'Some of the details are not valid.');
  if (code === '42501') return new ServiceError(403, 'You do not have access to this area.');
  if (/fetch|network/i.test(err.message)) return new ServiceError(503, 'Could not reach the server. Check your internet connection and try again.');
  return new ServiceError(500, err.message || 'Something went wrong. Please try again.');
}

/** Unwraps a Supabase query result, throwing a ServiceError on failure. */
export function check<T>(res: { data: T; error: DbError | null }): T {
  if (res.error) throw toDbServiceError(res.error);
  return res.data;
}

// ---------- calls ----------

/** Database functions that only read; every other call changes data and notifies the UI. */
const READ_ONLY = new Set([
  'printflow_get_session_user',
  'printflow_get_public_shop',
  'printflow_track_order',
  'printflow_shop_stats',
  'printflow_admin_stats',
  'printflow_admin_shop_owners',
]);

let onWrite: () => void = () => {};
/** Registered by realtime.ts so that changes refresh the screens. */
export function setWriteListener(fn: () => void) {
  onWrite = fn;
}

/** Calls a database function (RPC). */
export async function rpc<T = void>(fn: string, args?: Record<string, unknown>): Promise<T> {
  ensureConfigured();
  const data = check(await supabase.rpc(fn, args)) as T;
  if (!READ_ONLY.has(fn)) onWrite();
  return data;
}

/** Calls the `printflow-files` Edge Function (download links, storage cleanup). */
export async function filesFunction<T>(body: Record<string, unknown>): Promise<T> {
  ensureConfigured();
  const { data, error } = await supabase.functions.invoke('printflow-files', { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response;
      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ServiceError(res.status, payload?.error || 'Something went wrong. Please try again.');
    }
    throw new ServiceError(503, 'Could not reach the file service. Is the printflow-files Edge Function deployed?');
  }
  return data as T;
}

/**
 * Removes deleted files from Storage in the background (best effort). The database lists what the signed-in
 * user may remove (see migration 20261117010000); the printflow-files Edge Function is used too if it is deployed.
 */
export function cleanupStorage() {
  if (!supabaseConfigured) return;
  void (async () => {
    const { data: paths, error } = await supabase.rpc('printflow_storage_to_delete_mine', { p_limit: 200 });
    if (error || !Array.isArray(paths) || !paths.length) return;
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = (paths as string[]).slice(i, i + 100);
      const { data: removed } = await supabase.storage.from(BUCKET).remove(chunk);
      const names = (removed ?? []).map((o) => o.name);
      if (names.length) await supabase.rpc('printflow_storage_forget_deleted', { p_paths: names });
    }
  })().catch(() => {});
  void supabase.functions.invoke('printflow-files', { body: { action: 'cleanup' } }).catch(() => {});
}

export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
