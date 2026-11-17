// Creates the Super Admin login in printflow_users (and, with --demo, the Demo Print Shop).
//
//   npm run seed            → Super Admin from SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD in .env
//   npm run seed -- --demo  → also "Demo Print Shop" (login demoshop / Shop1234, customer page /s/demoprint1)
//
// Needs VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env. The service-role key stays on this computer;
// it is never part of the web app (only VITE_* variables are). Safe to run again: existing logins are skipped.
//
// Without Node you can do the same in the Supabase SQL Editor:
//   select printflow_svc_create_super_admin('superadmin', 'YourPassword123');

import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminUsername = (process.env.SUPER_ADMIN_USERNAME || '').trim().toLowerCase();
const adminPassword = process.env.SUPER_ADMIN_PASSWORD || '';
const withDemo = process.argv.includes('--demo');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!url || !serviceKey) fail('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (Supabase Dashboard → Project Settings → API).');
if (/^change[-_ ]?me/i.test(adminPassword)) fail('SUPER_ADMIN_PASSWORD in .env is still the placeholder. Choose a real password (8+ characters, letters and numbers).');

const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function run(label, fn, args) {
  const { error } = await supabase.rpc(fn, args);
  if (!error) return console.log(`✔ ${label}`);
  if (error.code === 'PT409') return console.log(`• ${label}: already exists — skipped.`);
  if (error.code === 'PGRST202' || /does not exist|schema cache/i.test(error.message)) {
    fail(`${error.message}\n  Did you run supabase/migrations/20261113000000_printflow_init.sql in the SQL Editor?`);
  }
  fail(`${label}: ${error.message}`);
}

await run(`Super Admin "${adminUsername}" (sign in at /admin/login)`, 'printflow_svc_create_super_admin', {
  p_username: adminUsername,
  p_password: adminPassword,
  p_name: 'Super Admin',
});

if (withDemo) {
  await run('Demo Print Shop (login demoshop / Shop1234, customer page /s/demoprint1)', 'printflow_svc_create_demo_shop', {
    p_username: 'demoshop',
    p_password: 'Shop1234',
    p_qr_token: 'demoprint1',
  });
}
