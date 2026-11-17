// PrintFlow — file access for the private `printflow-files` Storage bucket.
//
// Deploy:  npx supabase functions deploy printflow-files --no-verify-jwt
// (or Dashboard → Edge Functions → Deploy a new function → name `printflow-files`, paste this file,
//  and turn OFF "Verify JWT" — PrintFlow uses its own session tokens, checked below.)
//
// Actions (POST JSON):
//   { action: "sign", token, fileIds }  → short-lived download links for the signed-in shop owner's own files.
//                                         The database decides which files the token may open.
//   { action: "cleanup" }               → removes deleted files (and abandoned customer uploads) from Storage.
//                                         Only deletes what the database has already queued, so it needs no login.
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'printflow-files';
const LINK_SECONDS = 300;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function sign(token: unknown, fileIds: unknown) {
  if (typeof token !== 'string' || !token.startsWith('pf_')) return json({ error: 'Please sign in.' }, 401);
  if (!Array.isArray(fileIds) || fileIds.length === 0 || fileIds.length > 50 || !fileIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) {
    return json({ error: 'File not found.' }, 404);
  }
  // Ask the database as the caller (their session token), so only their own shop's files come back.
  const caller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { 'x-printflow-session': token } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await caller.rpc('printflow_shop_file_paths', { p_file_ids: fileIds });
  if (error) {
    const status = /^PT\d{3}$/.test(error.code ?? '') ? Number(error.code!.slice(2)) : 500;
    return json({ error: error.message }, status);
  }
  const files = (data ?? []) as { id: string; path: string; stored: boolean }[];
  const result: { id: string; url: string | null; deleted: boolean }[] = [];
  const live = files.filter((f) => f.stored);
  if (live.length) {
    const { data: links, error: signErr } = await admin.storage.from(BUCKET).createSignedUrls(live.map((f) => f.path), LINK_SECONDS);
    if (signErr) return json({ error: 'Could not open the files. Please try again.' }, 500);
    live.forEach((f, i) => result.push({ id: f.id, url: links?.[i]?.signedUrl ?? null, deleted: false }));
  }
  files.filter((f) => !f.stored).forEach((f) => result.push({ id: f.id, url: null, deleted: true }));
  return json({ files: result });
}

async function cleanup() {
  const { data: paths, error } = await admin.rpc('printflow_svc_storage_to_delete', { p_limit: 500 });
  if (error) return json({ error: error.message }, 500);
  const list = (paths ?? []) as string[];
  const removed: string[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const { error: rmErr } = await admin.storage.from(BUCKET).remove(chunk);
    if (!rmErr) removed.push(...chunk);
  }
  if (removed.length) await admin.rpc('printflow_svc_storage_deleted', { p_paths: removed });
  return json({ removed: removed.length });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === 'sign') return await sign(body.token, body.fileIds);
    if (body.action === 'cleanup') return await cleanup();
    return json({ error: 'Unknown action.' }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
});
