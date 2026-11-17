import type { SessionUser } from '../shared/types';
import { passwordProblem } from './crypto';
import { invalid, ServiceError } from './errors';
import { currentUser, invalidateSession, primeSession, requireUser, toSessionUser, type SessionInfo } from './session';
import { ensureConfigured, getToken, rpc, setToken } from './supabase';
import { oneOf, text } from './validate';

/** Sign-in with PrintFlow's own users table (printflow_users) — Supabase Auth is not used. */

export async function getCurrentUser(): Promise<SessionUser | null> {
  if (!getToken()) return null;
  const user = await currentUser();
  if (!user) {
    // Expired, revoked (password reset / shop deactivated) or invalid: forget it.
    setToken(null);
    invalidateSession();
  }
  return user;
}

interface LoginResult {
  token?: string;
  user?: SessionInfo;
  error?: string;
  status?: number;
  code?: string;
}

/**
 * Signs in. portal 'any' (the single sign-in page) accepts Super Admins and shop owners: it tries the shop
 * portal first and, if the database says the account is a Super Admin (password already verified), the admin portal.
 */
export async function login(portal: 'admin' | 'shop' | 'any', usernameInput: string, password: string): Promise<SessionUser> {
  if (portal === 'any') {
    try {
      return await login('shop', usernameInput, password);
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'USE_ADMIN_LOGIN') return login('admin', usernameInput, password);
      throw err;
    }
  }
  ensureConfigured();
  oneOf(portal, 'portal', ['admin', 'shop'] as const, 'Portal');
  const username = text(usernameInput, 'username', { label: 'Username', required: true, max: 60 }).toLowerCase();
  if (!password) throw invalid('Password is required.', 'password');

  const res = await rpc<LoginResult>('printflow_login', { p_portal: portal, p_username: username, p_password: password });
  if (!res.token || !res.user) throw new ServiceError(res.status ?? 401, res.error ?? 'Incorrect username or password.', undefined, res.code);
  setToken(res.token);
  primeSession(res.token, res.user);
  return toSessionUser(res.user);
}

/** Signs out this browser only (other devices stay signed in). */
export async function logout(): Promise<void> {
  try {
    if (getToken()) await rpc('printflow_logout');
  } finally {
    setToken(null);
    invalidateSession();
  }
}

/** Super Admin only: changes their own username and name (needs the current password). Stays signed in. */
export async function updateAdminAccount(currentPassword: string, usernameInput: string, nameInput: string): Promise<SessionUser> {
  await requireUser();
  const newUsername = text(usernameInput, 'username', { label: 'Username', required: true, max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(newUsername)) {
    throw invalid('Username must be 3–40 letters, numbers, dots, dashes or underscores.', 'username');
  }
  const name = text(nameInput, 'name', { label: 'Name', required: true, max: 80 });
  if (!currentPassword) throw invalid('Enter your current password.', 'currentPassword');
  const info = await rpc<SessionInfo>('printflow_admin_update_account', {
    p_current_password: currentPassword,
    p_username: newUsername,
    p_name: name,
  });
  const token = getToken();
  if (token) primeSession(token, info);
  return toSessionUser(info);
}

/** Changes the signed-in user's password; other devices are signed out, this one stays signed in. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<SessionUser> {
  await requireUser(); // also works while a temporary password must be changed
  const problem = passwordProblem(newPassword);
  if (problem) throw invalid(problem, 'newPassword');
  if (!currentPassword) throw invalid('Current password is incorrect.', 'currentPassword');
  if (currentPassword === newPassword) throw invalid('New password must be different from the current one.', 'newPassword');
  const info = await rpc<SessionInfo>('printflow_change_password', { p_current_password: currentPassword, p_new_password: newPassword });
  const token = getToken();
  if (token) primeSession(token, info);
  return toSessionUser(info);
}
