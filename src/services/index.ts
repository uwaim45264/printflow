/**
 * The app's data layer. UI code imports from here only.
 *
 * Backed by Supabase: Postgres (with Row Level Security) and Storage.
 * Own users/sessions tables (no Supabase Auth). See supabase/migrations for the database and
 * supabase/functions/printflow-files for file downloads.
 */
export * as authService from './authService';
export * as adminService from './adminService';
export * as shopService from './shopService';
export * as publicService from './publicService';
export { ServiceError, toServiceError } from './errors';
export { onDbChange } from './realtime';
export { supabaseConfigured } from './supabase';
