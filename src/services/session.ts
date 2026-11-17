import type { Role, SessionUser } from '../shared/types';
import { ServiceError } from './errors';
import { ensureConfigured, getToken, rpc } from './supabase';

/**
 * The signed-in user of this browser, read from the database with the stored session token.
 *
 * Note: these checks only give friendly errors. The real protection is in the database (RLS + functions),
 * which checks the session token on every request no matter what the browser does.
 */

export interface SessionInfo extends SessionUser {
  shopActive: boolean;
}

let cache: { token: string; at: number; value: Promise<SessionInfo | null> } | null = null;
const CACHE_MS = 15_000;

/** Forget the cached user (after sign-in/out, password change, or when data changes). */
export function invalidateSession() {
  cache = null;
}

/** Store a freshly loaded user (e.g. right after sign-in) so it is not fetched again. */
export function primeSession(token: string, info: SessionInfo) {
  cache = { token, at: Date.now(), value: Promise.resolve(info) };
}

export async function sessionInfo(): Promise<SessionInfo | null> {
  ensureConfigured();
  const token = getToken();
  if (!token) {
    cache = null;
    return null;
  }
  if (cache && cache.token === token && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = rpc<SessionInfo | null>('printflow_get_session_user');
  cache = { token, at: Date.now(), value };
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}

export const toSessionUser = (s: SessionInfo): SessionUser => ({
  id: s.id,
  username: s.username,
  name: s.name,
  role: s.role,
  shopId: s.shopId,
  mustChangePassword: s.mustChangePassword,
});

/** The signed-in user, or null. A deactivated shop's owner counts as signed out. */
export async function currentUser(): Promise<SessionUser | null> {
  const s = await sessionInfo();
  if (!s || !s.shopActive) return null;
  return toSessionUser(s);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new ServiceError(401, 'Please sign in.');
  return user;
}

/** Checks the signed-in user's role. Shop ids always come from the session, never from the caller. */
export async function requireRole(role: Role): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== role) throw new ServiceError(403, 'You do not have access to this area.');
  if (user.mustChangePassword) throw new ServiceError(403, 'Please change your temporary password first.', undefined, 'PASSWORD_CHANGE_REQUIRED');
  if (role === 'shop_owner' && !user.shopId) throw new ServiceError(403, 'No shop assigned.');
  return user;
}
