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

export async function login(portal: 'admin' | 'shop', usernameInput: string, password: string): Promise<SessionUser> {
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
