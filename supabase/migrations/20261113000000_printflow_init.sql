-- PrintFlow — Supabase schema (own users table, no Supabase Auth).
--
-- Run once on your Supabase project: SQL Editor → paste this file → Run   (or `npx supabase db push`).
-- Every object is prefixed `printflow_` so it can share a project with other apps.
--
-- Sign-in
--   * Users live in printflow_users (bcrypt password hashes via pgcrypto). Supabase Auth is not used.
--   * printflow_login() returns a random session token; only its SHA-256 hash is stored (printflow_sessions).
--   * The web app sends the token in the `x-printflow-session` header on every API request. RLS policies and
--     functions read it from PostgREST's `request.headers` to know who is calling.
--   * 5 wrong passwords lock the account for 5 minutes.
--
-- Data access
--   * Every table has Row Level Security. Clients may only SELECT their own data:
--       super admin → everything, shop owner → their own (active) shop, customer → nothing.
--     printflow_users / printflow_sessions are never readable directly (password hashes, tokens).
--   * Every write goes through a SECURITY DEFINER function that checks the caller and writes the activity log.
--
-- Files (private Storage bucket `printflow-files`)
--   * Customers may upload new files into incoming/… but never read anything.
--   * Shop owners get short-lived download links from the `printflow-files` Edge Function, which asks the
--     database (with the owner's session token) which files they may open.
--   * Deleted files are queued in printflow_storage_trash and removed from Storage by that Edge Function.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists printflow_private;
revoke all on schema printflow_private from public;

-- ============================================================================
-- Tables
-- ============================================================================

create table public.printflow_shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  owner_name text not null check (char_length(owner_name) between 1 and 80),
  phone text not null default '' check (phone = '' or (char_length(phone) <= 30 and phone ~ '^[+0-9][0-9 ()-]{5,}$')),
  email text not null default '' check (email = '' or (char_length(email) <= 120 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  address text not null default '' check (char_length(address) <= 200),
  city text not null default '' check (char_length(city) <= 60),
  operating_hours text not null default '' check (char_length(operating_hours) <= 80),
  status text not null default 'active' check (status in ('active', 'inactive')),
  qr_token text not null unique check (qr_token ~ '^[a-z0-9]{6,40}$'),
  next_order_no integer not null default 1001,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.printflow_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9._-]{3,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  password_hash text not null,
  role text not null check (role in ('super_admin', 'shop_owner')),
  shop_id uuid references public.printflow_shops (id) on delete cascade,
  must_change_password boolean not null default false,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  password_changed_at timestamptz,
  check ((role = 'shop_owner') = (shop_id is not null))
);
create index printflow_users_shop_id_idx on public.printflow_users (shop_id);

create table public.printflow_sessions (
  token_hash text primary key,
  user_id uuid not null references public.printflow_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index printflow_sessions_user_idx on public.printflow_sessions (user_id);

create table public.printflow_price_rules (
  shop_id uuid not null references public.printflow_shops (id) on delete cascade,
  paper_size text not null check (paper_size in ('A4', 'A3', 'Legal')),
  color_mode text not null check (color_mode in ('bw', 'color')),
  price_single numeric(12, 2) not null check (price_single between 0 and 1000000),
  price_double numeric(12, 2) not null check (price_double between 0 and 1000000),
  primary key (shop_id, paper_size, color_mode)
);

create table public.printflow_finishing_options (
  shop_id uuid not null references public.printflow_shops (id) on delete cascade,
  code text not null check (code in ('staple', 'spiral_binding', 'lamination')),
  name text not null,
  price numeric(12, 2) not null check (price between 0 and 1000000),
  enabled boolean not null default true,
  primary key (shop_id, code)
);

create table public.printflow_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.printflow_shops (id) on delete cascade,
  order_no integer not null,
  tracking_code text not null unique,
  customer_name text not null check (char_length(customer_name) between 2 and 80),
  customer_phone text not null check (char_length(customer_phone) <= 30),
  notes text not null default '' check (char_length(notes) <= 500),
  color_mode text not null check (color_mode in ('bw', 'color')),
  paper_size text not null check (paper_size in ('A4', 'A3', 'Legal')),
  sides text not null check (sides in ('single', 'double')),
  copies integer not null check (copies between 1 and 500),
  finishing text not null default 'none' check (finishing in ('none', 'staple', 'spiral_binding', 'lamination')),
  page_count integer not null default 0,
  estimated_total numeric(12, 2) not null default 0,
  final_amount numeric(12, 2) check (final_amount is null or final_amount between 0 and 1000000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'printing', 'ready', 'completed', 'rejected')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  rejection_reason text check (char_length(rejection_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Used by the shop's order search box.
  search_text text generated always as (lower(customer_name || ' ' || customer_phone || ' ' || tracking_code || ' ' || order_no::text)) stored,
  unique (shop_id, order_no)
);
create index printflow_orders_shop_created_idx on public.printflow_orders (shop_id, created_at desc);
create index printflow_orders_created_idx on public.printflow_orders (created_at);

create table public.printflow_order_files (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.printflow_orders (id) on delete cascade,
  shop_id uuid not null references public.printflow_shops (id) on delete cascade,
  storage_path text not null unique,
  original_name text not null check (char_length(original_name) between 1 and 150),
  mime text not null,
  size bigint not null check (size >= 0),
  pages integer not null check (pages between 1 and 5000),
  created_at timestamptz not null default now(),
  -- false once the shop deleted the file contents (the record is kept).
  stored boolean not null default true
);
create index printflow_order_files_order_idx on public.printflow_order_files (order_id);
create index printflow_order_files_shop_idx on public.printflow_order_files (shop_id);

create table public.printflow_order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.printflow_orders (id) on delete cascade,
  shop_id uuid not null references public.printflow_shops (id) on delete cascade,
  status text not null,
  note text,
  actor text not null,
  created_at timestamptz not null default now()
);
create index printflow_order_events_order_idx on public.printflow_order_events (order_id);

create table public.printflow_activity_log (
  id bigint generated always as identity primary key,
  shop_id uuid references public.printflow_shops (id) on delete set null,
  actor text not null,
  action text not null,
  details text not null default '',
  created_at timestamptz not null default now()
);
create index printflow_activity_log_shop_idx on public.printflow_activity_log (shop_id, id desc);

-- Storage objects waiting to be deleted by the printflow-files Edge Function.
create table public.printflow_storage_trash (
  path text primary key,
  created_at timestamptz not null default now()
);

-- Per-shop order counters for the Super Admin's shop list (respects RLS of the caller).
create view public.printflow_shop_order_stats with (security_invoker = true) as
select
  shop_id,
  count(*)::int as order_count,
  count(*) filter (where status = 'pending')::int as pending_count,
  max(created_at) as last_order_at
from public.printflow_orders
group by shop_id;

-- ============================================================================
-- Session helpers (used by RLS policies and functions)
-- ============================================================================

create or replace function printflow_private.hash_token(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function printflow_private.current_token_hash()
returns text language sql stable set search_path = '' as $$
  select printflow_private.hash_token(nullif(current_setting('request.headers', true), '')::json ->> 'x-printflow-session');
$$;

-- The user id of the session token sent in the `x-printflow-session` header, or null.
create or replace function public.printflow_session_user_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select s.user_id
  from public.printflow_sessions s
  where s.token_hash = printflow_private.current_token_hash() and s.expires_at > now();
$$;

create or replace function public.printflow_is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.printflow_users
    where id = public.printflow_session_user_id() and role = 'super_admin' and not must_change_password);
$$;

-- The signed-in owner's shop id, or null (not an owner, shop deactivated, or temporary password not changed yet).
create or replace function public.printflow_current_shop_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select u.shop_id
  from public.printflow_users u
  join public.printflow_shops s on s.id = u.shop_id
  where u.id = public.printflow_session_user_id() and u.role = 'shop_owner' and s.status = 'active' and not u.must_change_password;
$$;

-- ============================================================================
-- Row Level Security (read-only for clients; writes go through functions)
-- ============================================================================

alter table public.printflow_shops enable row level security;
alter table public.printflow_users enable row level security;
alter table public.printflow_sessions enable row level security;
alter table public.printflow_price_rules enable row level security;
alter table public.printflow_finishing_options enable row level security;
alter table public.printflow_orders enable row level security;
alter table public.printflow_order_files enable row level security;
alter table public.printflow_order_events enable row level security;
alter table public.printflow_activity_log enable row level security;
alter table public.printflow_storage_trash enable row level security;

-- Password hashes, session tokens and the trash queue are never reachable through the API (no grants, no policies).
revoke all on public.printflow_users, public.printflow_sessions, public.printflow_storage_trash from anon, authenticated;

create policy "shops: admin or own" on public.printflow_shops for select to anon, authenticated
  using ((select public.printflow_is_super_admin()) or id = (select public.printflow_current_shop_id()));
create policy "price_rules: admin or own" on public.printflow_price_rules for select to anon, authenticated
  using ((select public.printflow_is_super_admin()) or shop_id = (select public.printflow_current_shop_id()));
create policy "finishing: admin or own" on public.printflow_finishing_options for select to anon, authenticated
  using ((select public.printflow_is_super_admin()) or shop_id = (select public.printflow_current_shop_id()));
create policy "orders: admin or own" on public.printflow_orders for select to anon, authenticated
  using ((select public.printflow_is_super_admin()) or shop_id = (select public.printflow_current_shop_id()));
create policy "order_files: admin or own" on public.printflow_order_files for select to anon, authenticated
  using ((select public.printflow_is_super_admin()) or shop_id = (select public.printflow_current_shop_id()));
create policy "order_events: admin or own" on public.printflow_order_events for select to anon, authenticated
  using ((select public.printflow_is_super_admin()) or shop_id = (select public.printflow_current_shop_id()));
create policy "activity: admin" on public.printflow_activity_log for select to anon, authenticated
  using ((select public.printflow_is_super_admin()));

-- ============================================================================
-- Internal helpers (schema printflow_private is not reachable through the API)
-- ============================================================================

-- Raises an error that the API returns with the given HTTP status (PostgREST "PTxxx" codes).
-- `field` (→ error.details) tells the form which input is wrong; `code` (→ error.hint) is a machine-readable code.
create or replace function printflow_private.fail(p_status int, p_message text, p_field text default null, p_code text default null)
returns void language plpgsql as $$
begin
  raise exception using errcode = 'PT' || p_status::text, message = p_message,
    detail = coalesce(p_field, ''), hint = coalesce(p_code, '');
end;
$$;

create or replace function printflow_private.log(p_actor text, p_action text, p_details text, p_shop uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.printflow_activity_log (actor, action, details, shop_id) values (p_actor, p_action, coalesce(p_details, ''), p_shop);
$$;

-- Unambiguous uppercase code (tracking codes, QR tokens). 32 symbols → unbiased from random bytes.
create or replace function printflow_private.random_code(n int)
returns text language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(n);
  result text := '';
begin
  for i in 0 .. n - 1 loop
    result := result || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

create or replace function printflow_private.new_qr_token()
returns text language plpgsql volatile set search_path = '' as $$
declare t text;
begin
  loop
    t := lower(printflow_private.random_code(10));
    exit when not exists (select 1 from public.printflow_shops where qr_token = t);
  end loop;
  return t;
end;
$$;

-- Readable temporary password, e.g. "Cedar-7342-Moss".
create or replace function printflow_private.temp_password()
returns text language plpgsql volatile set search_path = '' as $$
declare
  words constant text[] := array['Amber', 'Cedar', 'Coral', 'Delta', 'Ember', 'Falcon', 'Harbor', 'Indigo', 'Juniper', 'Lotus',
                                 'Maple', 'Nova', 'Orchid', 'Pine', 'Quartz', 'Raven', 'Sable', 'Tide', 'Willow', 'Zephyr'];
  b bytea := extensions.gen_random_bytes(4);
begin
  return words[1 + get_byte(b, 0) % 20] || '-' || (1000 + (get_byte(b, 1) * 256 + get_byte(b, 2)) % 9000)::text || '-' || words[1 + get_byte(b, 3) % 20];
end;
$$;

create or replace function printflow_private.password_problem(p text)
returns text language sql immutable as $$
  select case
    when p is null or p = '' then 'Password is required.'
    when char_length(p) < 8 then 'Password must be at least 8 characters.'
    when char_length(p) > 128 then 'Password must be at most 128 characters.'
    when p !~ '[A-Za-z]' or p !~ '[0-9]' then 'Password must contain letters and numbers.'
  end;
$$;

create or replace function printflow_private.hash_password(p text)
returns text language sql volatile set search_path = '' as $$
  select extensions.crypt(p, extensions.gen_salt('bf', 10));
$$;

create or replace function printflow_private.check_password(p text, p_hash text)
returns boolean language sql stable set search_path = '' as $$
  select p_hash = extensions.crypt(coalesce(p, ''), p_hash);
$$;

-- Creates a session for a user and returns the token (given to the client once; only its hash is stored).
create or replace function printflow_private.create_session(p_user uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_token text := 'pf_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from public.printflow_sessions where expires_at < now();
  insert into public.printflow_sessions (token_hash, user_id, expires_at)
  values (printflow_private.hash_token(v_token), p_user, now() + interval '12 hours');
  return v_token;
end;
$$;

create or replace function printflow_private.user_json(u public.printflow_users)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', u.id, 'username', u.username, 'name', u.name, 'role', u.role, 'shopId', u.shop_id,
    'mustChangePassword', u.must_change_password,
    'shopActive', case when u.role = 'shop_owner'
                       then coalesce((select status = 'active' from public.printflow_shops where id = u.shop_id), false)
                       else true end);
$$;

create or replace function printflow_private.seed_shop_defaults(p_shop uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.printflow_price_rules (shop_id, paper_size, color_mode, price_single, price_double) values
    (p_shop, 'A4', 'bw', 10, 15), (p_shop, 'A4', 'color', 30, 50),
    (p_shop, 'A3', 'bw', 25, 40), (p_shop, 'A3', 'color', 70, 120),
    (p_shop, 'Legal', 'bw', 12, 18), (p_shop, 'Legal', 'color', 35, 60);
  insert into public.printflow_finishing_options (shop_id, code, name, price, enabled) values
    (p_shop, 'staple', 'Staple', 10, true),
    (p_shop, 'spiral_binding', 'Spiral binding', 100, true),
    (p_shop, 'lamination', 'Lamination', 60, true);
$$;

create or replace function printflow_private.require_user()
returns public.printflow_users language plpgsql stable security definer set search_path = '' as $$
declare u public.printflow_users;
begin
  select * into u from public.printflow_users where id = public.printflow_session_user_id();
  if not found then perform printflow_private.fail(401, 'Please sign in.'); end if;
  return u;
end;
$$;

create or replace function printflow_private.require_admin()
returns text language plpgsql stable security definer set search_path = '' as $$
declare u public.printflow_users;
begin
  u := printflow_private.require_user();
  if u.role <> 'super_admin' then perform printflow_private.fail(403, 'You do not have access to this area.'); end if;
  if u.must_change_password then perform printflow_private.fail(403, 'Please change your temporary password first.', null, 'PASSWORD_CHANGE_REQUIRED'); end if;
  return u.username;
end;
$$;

-- Returns the caller's shop id and username, or raises 401/403.
create or replace function printflow_private.require_shop(out shop_id uuid, out actor text)
language plpgsql stable security definer set search_path = '' as $$
declare u public.printflow_users;
begin
  u := printflow_private.require_user();
  if u.role <> 'shop_owner' then perform printflow_private.fail(403, 'You do not have access to this area.'); end if;
  if u.must_change_password then perform printflow_private.fail(403, 'Please change your temporary password first.', null, 'PASSWORD_CHANGE_REQUIRED'); end if;
  shop_id := public.printflow_current_shop_id();
  if shop_id is null then
    perform printflow_private.fail(403, 'This shop is currently deactivated. Please contact the platform administrator.');
  end if;
  actor := u.username;
end;
$$;

create or replace function printflow_private.price_rules_json(p_shop uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'paperSize', paper_size, 'colorMode', color_mode, 'priceSingle', price_single, 'priceDouble', price_double)
    order by array_position(array['A4', 'A3', 'Legal'], paper_size), array_position(array['bw', 'color'], color_mode)), '[]'::jsonb)
  from public.printflow_price_rules where shop_id = p_shop;
$$;

create or replace function printflow_private.finishing_json(p_shop uuid, p_enabled_only boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'price', price, 'enabled', enabled)
    order by array_position(array['staple', 'spiral_binding', 'lamination'], code)), '[]'::jsonb)
  from public.printflow_finishing_options where shop_id = p_shop and (enabled or not p_enabled_only);
$$;

-- Creates a shop, its owner login and default prices. Returns the shop id.
create or replace function printflow_private.create_shop(
  p_actor text, p_name text, p_owner_name text, p_phone text, p_email text, p_address text, p_city text, p_operating_hours text,
  p_owner_username text, p_owner_password text, p_must_change_password boolean, p_qr_token text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_shop uuid;
  v_username text := lower(btrim(coalesce(p_owner_username, '')));
  v_problem text := printflow_private.password_problem(p_owner_password);
begin
  if v_username !~ '^[a-z0-9._-]{3,40}$' then
    perform printflow_private.fail(400, 'Username must be 3–40 letters, numbers, dots, dashes or underscores.', 'ownerUsername');
  end if;
  if exists (select 1 from public.printflow_users where username = v_username) then
    perform printflow_private.fail(409, 'That username is already taken.', 'ownerUsername');
  end if;
  if v_problem is not null then perform printflow_private.fail(400, v_problem, 'ownerPassword'); end if;

  insert into public.printflow_shops (name, owner_name, phone, email, address, city, operating_hours, qr_token)
  values (btrim(coalesce(p_name, '')), btrim(coalesce(p_owner_name, '')), btrim(coalesce(p_phone, '')), lower(btrim(coalesce(p_email, ''))),
          btrim(coalesce(p_address, '')), btrim(coalesce(p_city, '')), btrim(coalesce(p_operating_hours, '')),
          coalesce(p_qr_token, printflow_private.new_qr_token()))
  returning id into v_shop;
  insert into public.printflow_users (username, name, password_hash, role, shop_id, must_change_password)
  values (v_username, btrim(p_owner_name), printflow_private.hash_password(p_owner_password), 'shop_owner', v_shop, p_must_change_password);
  perform printflow_private.seed_shop_defaults(v_shop);
  perform printflow_private.log(p_actor, 'Created shop', format('%s (owner login: %s)', btrim(p_name), v_username), v_shop);
  return v_shop;
end;
$$;

-- ============================================================================
-- Sign-in
-- ============================================================================

-- Returns {token, user} on success, or {error, status, code} on failure (returned rather than raised, so the
-- failed-attempt counter is saved).
create or replace function public.printflow_login(p_portal text, p_username text, p_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  u public.printflow_users;
  v_generic constant jsonb := jsonb_build_object('status', 401, 'error', 'Incorrect username or password.');
  v_expected text := case p_portal when 'admin' then 'super_admin' when 'shop' then 'shop_owner' end;
begin
  if v_expected is null then return jsonb_build_object('status', 400, 'error', 'Portal is not valid.'); end if;
  select * into u from public.printflow_users where username = lower(btrim(coalesce(p_username, '')));
  if not found then
    perform printflow_private.hash_password(coalesce(p_password, '')); -- take as long as a real check
    return v_generic;
  end if;
  if u.locked_until is not null and u.locked_until > now() then
    return jsonb_build_object('status', 429, 'error', 'Too many wrong passwords. Please wait a few minutes and try again.');
  end if;
  if not printflow_private.check_password(p_password, u.password_hash) then
    update public.printflow_users set
      failed_logins = case when failed_logins + 1 >= 5 then 0 else failed_logins + 1 end,
      locked_until = case when failed_logins + 1 >= 5 then now() + interval '5 minutes' else null end
    where id = u.id;
    return v_generic;
  end if;
  update public.printflow_users set failed_logins = 0, locked_until = null where id = u.id;

  -- Each role signs in through its own page. The password was correct, so it is safe to say which page to use.
  if u.role <> v_expected then
    return case when u.role = 'super_admin'
      then jsonb_build_object('status', 401, 'code', 'USE_ADMIN_LOGIN', 'error', 'This is a Super Admin account. Please sign in on the Super Admin page.')
      else jsonb_build_object('status', 401, 'code', 'USE_SHOP_LOGIN', 'error', 'This is a shop owner account. Please sign in on the Shop sign-in page.') end;
  end if;
  if u.role = 'shop_owner' and not exists (select 1 from public.printflow_shops where id = u.shop_id and status = 'active') then
    return jsonb_build_object('status', 403, 'error', 'This shop is currently deactivated. Please contact the platform administrator.');
  end if;

  update public.printflow_users set last_login_at = now() where id = u.id;
  perform printflow_private.log(u.username, 'Signed in', case when u.role = 'super_admin' then 'Super Admin portal' else 'Shop portal' end, u.shop_id);
  return jsonb_build_object('token', printflow_private.create_session(u.id), 'user', printflow_private.user_json(u));
end;
$$;

create or replace function public.printflow_logout()
returns void language sql security definer set search_path = '' as $$
  delete from public.printflow_sessions where token_hash = printflow_private.current_token_hash();
$$;

-- The signed-in user (from the session header), or null.
create or replace function public.printflow_get_session_user()
returns jsonb language sql stable security definer set search_path = '' as $$
  select printflow_private.user_json(u) from public.printflow_users u where u.id = public.printflow_session_user_id();
$$;

-- Changes the caller's own password and signs out their other sessions.
create or replace function public.printflow_change_password(p_current_password text, p_new_password text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  u public.printflow_users;
  v_problem text := printflow_private.password_problem(p_new_password);
begin
  u := printflow_private.require_user();
  if v_problem is not null then perform printflow_private.fail(400, v_problem, 'newPassword'); end if;
  if not printflow_private.check_password(p_current_password, u.password_hash) then
    perform printflow_private.fail(400, 'Current password is incorrect.', 'currentPassword');
  end if;
  if printflow_private.check_password(p_new_password, u.password_hash) then
    perform printflow_private.fail(400, 'New password must be different from the current one.', 'newPassword');
  end if;
  update public.printflow_users set password_hash = printflow_private.hash_password(p_new_password),
    must_change_password = false, password_changed_at = now()
  where id = u.id returning * into u;
  delete from public.printflow_sessions where user_id = u.id and token_hash <> printflow_private.current_token_hash();
  perform printflow_private.log(u.username, 'Changed password', '', u.shop_id);
  return printflow_private.user_json(u);
end;
$$;

-- ============================================================================
-- Customer — QR page, new order, tracking (no sign-in)
-- ============================================================================

create or replace function public.printflow_get_public_shop(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.printflow_shops;
begin
  if p_token is null or p_token !~ '^[a-z0-9]{6,40}$' then
    perform printflow_private.fail(404, 'This QR code is not valid. Please ask the shop for their current QR code.');
  end if;
  select * into s from public.printflow_shops where qr_token = p_token;
  if not found then
    perform printflow_private.fail(404, 'This QR code is not valid. Please ask the shop for their current QR code.');
  end if;
  return jsonb_build_object(
    'name', s.name, 'address', s.address, 'city', s.city, 'phone', s.phone, 'operatingHours', s.operating_hours,
    'isOpen', s.status = 'active',
    'prices', printflow_private.price_rules_json(s.id),
    'finishing', printflow_private.finishing_json(s.id, true));
end;
$$;

-- Creates an order for files the customer already uploaded (bucket printflow-files, path incoming/<uuid>/<uuid>).
-- p_order: {customerName, customerPhone, notes, colorMode, paperSize, sides, copies, finishing}
-- p_files: [{path, name, mime, pages}]   (size is taken from storage, not from the client)
-- The price is calculated here from the shop's prices, so the client cannot change it.
create or replace function public.printflow_create_order(p_token text, p_order jsonb, p_files jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.printflow_shops;
  v_name text := btrim(coalesce(p_order ->> 'customerName', ''));
  v_phone text := btrim(coalesce(p_order ->> 'customerPhone', ''));
  v_notes text := btrim(coalesce(p_order ->> 'notes', ''));
  v_color text := p_order ->> 'colorMode';
  v_paper text := p_order ->> 'paperSize';
  v_sides text := p_order ->> 'sides';
  v_finishing text := coalesce(nullif(p_order ->> 'finishing', ''), 'none');
  v_copies int;
  v_rule public.printflow_price_rules;
  v_fin_price numeric := 0;
  v_file jsonb;
  v_path text;
  v_size bigint;
  v_pages int;
  v_total_pages int := 0;
  v_file_name text;
  v_mime text;
  v_order_id uuid := gen_random_uuid();
  v_order_no int;
  v_code text;
  v_sheets int;
  v_rate numeric;
  v_total numeric;
begin
  if p_token is null or p_token !~ '^[a-z0-9]{6,40}$' then
    perform printflow_private.fail(404, 'This QR code is not valid. Please ask the shop for their current QR code.');
  end if;
  select * into s from public.printflow_shops where qr_token = p_token for update;
  if not found then
    perform printflow_private.fail(404, 'This QR code is not valid. Please ask the shop for their current QR code.');
  end if;
  if s.status <> 'active' then perform printflow_private.fail(403, 'This shop is not accepting online orders right now.'); end if;

  if char_length(v_name) < 2 or char_length(v_name) > 80 then perform printflow_private.fail(400, 'Your name must be 2–80 characters.', 'customerName'); end if;
  if char_length(v_phone) > 30 or v_phone !~ '^[+0-9][0-9 ()-]{5,}$' then perform printflow_private.fail(400, 'Phone number is not valid.', 'customerPhone'); end if;
  if char_length(v_notes) > 500 then perform printflow_private.fail(400, 'Notes must be at most 500 characters.', 'notes'); end if;
  if v_color is null or v_color not in ('bw', 'color') then perform printflow_private.fail(400, 'Color is not valid.', 'colorMode'); end if;
  if v_paper is null or v_paper not in ('A4', 'A3', 'Legal') then perform printflow_private.fail(400, 'Paper size is not valid.', 'paperSize'); end if;
  if v_sides is null or v_sides not in ('single', 'double') then perform printflow_private.fail(400, 'Sides is not valid.', 'sides'); end if;
  begin
    v_copies := (p_order ->> 'copies')::int;
  exception when others then
    v_copies := null;
  end;
  if v_copies is null or v_copies < 1 or v_copies > 500 then perform printflow_private.fail(400, 'Copies must be a whole number between 1 and 500.', 'copies'); end if;

  select * into v_rule from public.printflow_price_rules where shop_id = s.id and paper_size = v_paper and color_mode = v_color;
  if not found then perform printflow_private.fail(400, 'This shop does not offer that paper size and color combination.'); end if;
  if v_finishing <> 'none' then
    select price into v_fin_price from public.printflow_finishing_options where shop_id = s.id and code = v_finishing and enabled;
    if not found then perform printflow_private.fail(400, 'Finishing is not valid.', 'finishing'); end if;
  end if;

  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    perform printflow_private.fail(400, 'Please add at least one document.');
  end if;
  if jsonb_array_length(p_files) > 10 then perform printflow_private.fail(400, 'You can upload up to 10 files at once.'); end if;

  update public.printflow_shops set next_order_no = next_order_no + 1 where id = s.id returning next_order_no - 1 into v_order_no;
  loop
    v_code := printflow_private.random_code(8);
    exit when not exists (select 1 from public.printflow_orders where tracking_code = v_code);
  end loop;

  insert into public.printflow_orders (id, shop_id, order_no, tracking_code, customer_name, customer_phone, notes,
                                       color_mode, paper_size, sides, copies, finishing)
  values (v_order_id, s.id, v_order_no, v_code, v_name, v_phone, v_notes, v_color, v_paper, v_sides, v_copies, v_finishing);

  for v_file in select value from jsonb_array_elements(p_files) loop
    v_path := v_file ->> 'path';
    if v_path is null or v_path !~ '^incoming/[0-9a-f-]{36}/[0-9a-f-]{36}$' then
      perform printflow_private.fail(400, 'One of the uploads is not valid. Please try again.');
    end if;
    select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o where o.bucket_id = 'printflow-files' and o.name = v_path;
    if not found then perform printflow_private.fail(400, 'One of the files did not finish uploading. Please try again.'); end if;
    v_mime := v_file ->> 'mime';
    if v_mime is null or v_mime not in ('application/pdf', 'image/png', 'image/jpeg', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document') then
      perform printflow_private.fail(400, 'One of the files is not a supported file type.');
    end if;
    v_file_name := left(regexp_replace(coalesce(v_file ->> 'name', ''), '[\x00-\x1f\x7f<>:"/\\|?*]', '_', 'g'), 150);
    if v_file_name = '' then v_file_name := 'document'; end if;
    begin
      v_pages := (v_file ->> 'pages')::int;
    exception when others then
      v_pages := null;
    end;
    if v_pages is null or v_pages < 1 or v_pages > 5000 then perform printflow_private.fail(400, 'Page count of a file is not valid.'); end if;

    -- storage_path is unique, so one upload can never be attached to two orders.
    insert into public.printflow_order_files (order_id, shop_id, storage_path, original_name, mime, size, pages)
    values (v_order_id, s.id, v_path, v_file_name, v_mime, coalesce(v_size, 0), v_pages);
    v_total_pages := v_total_pages + v_pages;
  end loop;

  -- Same formula as src/shared/pricing.ts: double-sided rate is per sheet (2 pages per sheet).
  v_sheets := case when v_sides = 'double' then ceil(v_total_pages / 2.0)::int else v_total_pages end;
  v_rate := case when v_sides = 'double' then v_rule.price_double else v_rule.price_single end;
  v_total := round(v_sheets * v_rate * v_copies + v_fin_price * v_copies, 2);

  update public.printflow_orders set page_count = v_total_pages, estimated_total = v_total where id = v_order_id;
  insert into public.printflow_order_events (order_id, shop_id, status, note, actor) values (v_order_id, s.id, 'pending', 'Order received via QR code', 'customer');
  perform printflow_private.log('customer', 'New order received', format('#%s · %s file(s)', v_order_no, jsonb_array_length(p_files)), s.id);

  return jsonb_build_object('trackingCode', v_code, 'orderNo', v_order_no, 'estimatedTotal', v_total, 'pageCount', v_total_pages);
end;
$$;

create or replace function public.printflow_track_order(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  o public.printflow_orders;
begin
  select * into o from public.printflow_orders where tracking_code = v_code;
  if not found then perform printflow_private.fail(404, 'No order found with that tracking code.'); end if;
  return jsonb_build_object(
    'trackingCode', o.tracking_code, 'orderNo', o.order_no,
    'shopName', coalesce((select name from public.printflow_shops where id = o.shop_id), ''),
    'status', o.status, 'estimatedTotal', o.estimated_total, 'finalAmount', o.final_amount,
    'paymentStatus', o.payment_status, 'rejectionReason', o.rejection_reason,
    'fileCount', (select count(*) from public.printflow_order_files where order_id = o.id),
    'createdAt', o.created_at, 'updatedAt', o.updated_at,
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'createdAt', e.created_at) order by e.id)
                        from public.printflow_order_events e where e.order_id = o.id), '[]'::jsonb));
end;
$$;

-- ============================================================================
-- Shop owner
-- ============================================================================

create or replace function public.printflow_shop_update_profile(
  p_name text, p_phone text, p_email text, p_address text, p_city text, p_operating_hours text)
returns void language plpgsql security definer set search_path = '' as $$
declare me record;
begin
  select * into me from printflow_private.require_shop();
  update public.printflow_shops set
    name = btrim(coalesce(p_name, '')), phone = btrim(coalesce(p_phone, '')), email = lower(btrim(coalesce(p_email, ''))),
    address = btrim(coalesce(p_address, '')), city = btrim(coalesce(p_city, '')),
    operating_hours = btrim(coalesce(p_operating_hours, '')), updated_at = now()
  where id = me.shop_id;
  perform printflow_private.log(me.actor, 'Updated shop profile', '', me.shop_id);
end;
$$;

create or replace function public.printflow_shop_stats(p_today timestamptz, p_month timestamptz, p_week_start timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me record;
begin
  select * into me from printflow_private.require_shop();
  return (
    select jsonb_build_object(
      'ordersToday', count(*) filter (where created_at >= p_today),
      'pending', count(*) filter (where status = 'pending'),
      'inProgress', count(*) filter (where status in ('accepted', 'printing')),
      'readyForPickup', count(*) filter (where status = 'ready'),
      'completedThisMonth', count(*) filter (where status = 'completed' and updated_at >= p_month),
      'revenueThisMonth', coalesce(sum(coalesce(final_amount, estimated_total)) filter (where payment_status = 'paid' and updated_at >= p_month), 0),
      'recent', coalesce(jsonb_agg(created_at) filter (where created_at >= p_week_start), '[]'::jsonb))
    from public.printflow_orders where shop_id = me.shop_id);
end;
$$;

create or replace function public.printflow_shop_set_order_status(p_order_id uuid, p_status text, p_reason text default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me record;
  o public.printflow_orders;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_allowed text[];
begin
  select * into me from printflow_private.require_shop();
  select * into o from public.printflow_orders where id = p_order_id and shop_id = me.shop_id for update;
  if not found then perform printflow_private.fail(404, 'Order not found.'); end if;
  v_allowed := case o.status
    when 'pending' then array['accepted', 'rejected']
    when 'accepted' then array['printing', 'rejected']
    when 'printing' then array['ready']
    when 'ready' then array['completed']
    else array[]::text[] end;
  if p_status is null or not (p_status = any (v_allowed)) then
    perform printflow_private.fail(400, format('An order that is "%s" cannot be moved to "%s".', o.status, coalesce(p_status, '')));
  end if;
  if p_status = 'rejected' and v_reason is null then perform printflow_private.fail(400, 'Reason is required.', 'reason'); end if;
  if char_length(v_reason) > 300 or char_length(v_note) > 300 then perform printflow_private.fail(400, 'Reason and note must be at most 300 characters.'); end if;

  update public.printflow_orders set
    status = p_status,
    rejection_reason = case when p_status = 'rejected' then v_reason else rejection_reason end,
    updated_at = now()
  where id = o.id;
  insert into public.printflow_order_events (order_id, shop_id, status, note, actor)
  values (o.id, o.shop_id, p_status, coalesce(v_note, case when p_status = 'rejected' then v_reason end), me.actor);
  perform printflow_private.log(me.actor, 'Order status changed', format('#%s → %s', o.order_no, p_status), me.shop_id);
end;
$$;

create or replace function public.printflow_shop_set_billing(p_order_id uuid, p_final_amount numeric, p_payment_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare me record;
begin
  select * into me from printflow_private.require_shop();
  if p_payment_status is null or p_payment_status not in ('paid', 'unpaid') then perform printflow_private.fail(400, 'Payment status is not valid.'); end if;
  if p_final_amount is not null and (p_final_amount < 0 or p_final_amount > 1000000) then
    perform printflow_private.fail(400, 'Final amount must be a positive amount.', 'finalAmount');
  end if;
  update public.printflow_orders set final_amount = round(p_final_amount, 2), payment_status = p_payment_status, updated_at = now()
  where id = p_order_id and shop_id = me.shop_id;
  if not found then perform printflow_private.fail(404, 'Order not found.'); end if;
end;
$$;

-- Marks an order's files as deleted and queues them for removal from Storage. Returns how many were deleted.
create or replace function public.printflow_shop_purge_order_files(p_order_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  me record;
  o public.printflow_orders;
  v_paths text[];
begin
  select * into me from printflow_private.require_shop();
  select * into o from public.printflow_orders where id = p_order_id and shop_id = me.shop_id;
  if not found then perform printflow_private.fail(404, 'Order not found.'); end if;
  with purged as (
    update public.printflow_order_files set stored = false
    where order_id = o.id and shop_id = me.shop_id and stored
    returning storage_path)
  select coalesce(array_agg(storage_path), array[]::text[]) into v_paths from purged;
  insert into public.printflow_storage_trash (path) select unnest(v_paths) on conflict do nothing;
  perform printflow_private.log(me.actor, 'Deleted order files', format('#%s', o.order_no), me.shop_id);
  return cardinality(v_paths);
end;
$$;

-- Storage paths of the caller's own files (used by the printflow-files Edge Function to create download links).
create or replace function public.printflow_shop_file_paths(p_file_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me record;
begin
  select * into me from printflow_private.require_shop();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'path', storage_path, 'stored', stored))
    from public.printflow_order_files where shop_id = me.shop_id and id = any (p_file_ids)), '[]'::jsonb);
end;
$$;

-- p_prices: [{paperSize, colorMode, priceSingle, priceDouble}], p_finishing: [{code, price, enabled}]
create or replace function public.printflow_shop_save_pricing(p_prices jsonb, p_finishing jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare me record;
begin
  select * into me from printflow_private.require_shop();
  if jsonb_typeof(p_prices) <> 'array' or jsonb_typeof(p_finishing) <> 'array' then
    perform printflow_private.fail(400, 'Prices and finishing options are required.');
  end if;
  if jsonb_array_length(p_prices) > 6 or jsonb_array_length(p_finishing) > 3 then perform printflow_private.fail(400, 'Too many price rows.'); end if;

  delete from public.printflow_price_rules where shop_id = me.shop_id;
  insert into public.printflow_price_rules (shop_id, paper_size, color_mode, price_single, price_double)
  select me.shop_id, r."paperSize", r."colorMode", round(r."priceSingle", 2), round(r."priceDouble", 2)
  from jsonb_to_recordset(p_prices) as r("paperSize" text, "colorMode" text, "priceSingle" numeric, "priceDouble" numeric);

  update public.printflow_finishing_options f set price = round(x.price, 2), enabled = coalesce(x.enabled, false)
  from jsonb_to_recordset(p_finishing) as x(code text, price numeric, enabled boolean)
  where f.shop_id = me.shop_id and f.code = x.code;

  perform printflow_private.log(me.actor, 'Updated printing prices', '', me.shop_id);
end;
$$;

create or replace function public.printflow_shop_regenerate_qr()
returns void language plpgsql security definer set search_path = '' as $$
declare me record;
begin
  select * into me from printflow_private.require_shop();
  update public.printflow_shops set qr_token = printflow_private.new_qr_token(), updated_at = now() where id = me.shop_id;
  perform printflow_private.log(me.actor, 'Generated a new QR code', 'Previous QR code no longer works', me.shop_id);
end;
$$;

-- Records that files were sent to the printer, and optionally moves the order to "printing".
create or replace function public.printflow_shop_log_print(p_order_id uuid, p_file_ids uuid[], p_mark_printing boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  me record;
  o public.printflow_orders;
  v_count int;
  v_status text;
begin
  select * into me from printflow_private.require_shop();
  select * into o from public.printflow_orders where id = p_order_id and shop_id = me.shop_id for update;
  if not found then perform printflow_private.fail(404, 'Order not found.'); end if;
  select count(*) into v_count from public.printflow_order_files where order_id = o.id and id = any (p_file_ids) and stored;
  if v_count = 0 then perform printflow_private.fail(400, 'Select at least one file to print.'); end if;
  v_status := o.status;
  if p_mark_printing and o.status = 'accepted' then
    v_status := 'printing';
    update public.printflow_orders set status = 'printing', updated_at = now() where id = o.id;
  end if;
  insert into public.printflow_order_events (order_id, shop_id, status, note, actor)
  values (o.id, o.shop_id, v_status, format('Sent %s file%s to the printer (print dialog)', v_count, case when v_count = 1 then '' else 's' end), me.actor);
  perform printflow_private.log(me.actor, 'Printed order files', format('#%s · %s file(s)', o.order_no, v_count), me.shop_id);
end;
$$;

-- ============================================================================
-- Super Admin
-- ============================================================================

create or replace function public.printflow_admin_stats(p_today timestamptz, p_week_start timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform printflow_private.require_admin();
  return jsonb_build_object(
    'shopsTotal', (select count(*) from public.printflow_shops),
    'shopsActive', (select count(*) from public.printflow_shops where status = 'active'),
    'ordersTotal', (select count(*) from public.printflow_orders),
    'ordersToday', (select count(*) from public.printflow_orders where created_at >= p_today),
    'ordersPending', (select count(*) from public.printflow_orders where status = 'pending'),
    'storageBytes', (select coalesce(sum(size), 0) from public.printflow_order_files where stored),
    'recent', (select coalesce(jsonb_agg(created_at), '[]'::jsonb) from public.printflow_orders where created_at >= p_week_start),
    'topShops', (select coalesce(jsonb_agg(t order by t.orders desc, t.name), '[]'::jsonb) from (
        select s.id, s.name, count(o.id)::int as orders
        from public.printflow_shops s left join public.printflow_orders o on o.shop_id = s.id
        group by s.id, s.name
        order by count(o.id) desc, s.name
        limit 5) t));
end;
$$;

-- Shop owners' usernames and last sign-in (printflow_users itself is not readable through the API).
create or replace function public.printflow_admin_shop_owners()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform printflow_private.require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('shopId', shop_id, 'username', username, 'lastLoginAt', last_login_at))
                   from public.printflow_users where role = 'shop_owner'), '[]'::jsonb);
end;
$$;

-- Creates a shop and its owner login. Without p_owner_password a temporary password is generated.
-- Returns {shopId, username, temporaryPassword}; the password is shown once, only its hash is stored.
create or replace function public.printflow_admin_create_shop(
  p_name text, p_owner_name text, p_phone text, p_email text, p_address text, p_city text, p_operating_hours text,
  p_owner_username text, p_owner_password text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor text := printflow_private.require_admin();
  v_password text := coalesce(nullif(p_owner_password, ''), printflow_private.temp_password());
  v_shop uuid;
begin
  v_shop := printflow_private.create_shop(v_actor, p_name, p_owner_name, p_phone, p_email, p_address, p_city, p_operating_hours,
                                          p_owner_username, v_password, true);
  return jsonb_build_object('shopId', v_shop, 'username', lower(btrim(p_owner_username)), 'temporaryPassword', v_password);
end;
$$;

create or replace function public.printflow_admin_update_shop(
  p_shop_id uuid, p_name text, p_owner_name text, p_phone text, p_email text, p_address text, p_city text, p_operating_hours text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor text := printflow_private.require_admin();
begin
  update public.printflow_shops set
    name = btrim(coalesce(p_name, '')), owner_name = btrim(coalesce(p_owner_name, '')), phone = btrim(coalesce(p_phone, '')),
    email = lower(btrim(coalesce(p_email, ''))), address = btrim(coalesce(p_address, '')), city = btrim(coalesce(p_city, '')),
    operating_hours = btrim(coalesce(p_operating_hours, '')), updated_at = now()
  where id = p_shop_id;
  if not found then perform printflow_private.fail(404, 'Shop not found.'); end if;
  update public.printflow_users set name = btrim(p_owner_name) where shop_id = p_shop_id and role = 'shop_owner';
  perform printflow_private.log(v_actor, 'Updated shop details', btrim(p_name), p_shop_id);
end;
$$;

-- Deactivating signs the owner out everywhere and blocks access immediately.
create or replace function public.printflow_admin_set_shop_status(p_shop_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor text := printflow_private.require_admin();
  v_name text;
begin
  if p_status is null or p_status not in ('active', 'inactive') then perform printflow_private.fail(400, 'Status is not valid.'); end if;
  update public.printflow_shops set status = p_status, updated_at = now() where id = p_shop_id returning name into v_name;
  if not found then perform printflow_private.fail(404, 'Shop not found.'); end if;
  if p_status = 'inactive' then
    delete from public.printflow_sessions where user_id in (select id from public.printflow_users where shop_id = p_shop_id);
  end if;
  perform printflow_private.log(v_actor, case when p_status = 'active' then 'Activated shop' else 'Deactivated shop' end, v_name, p_shop_id);
end;
$$;

-- New temporary password for the shop's owner; signs them out everywhere. Returns {username, temporaryPassword}.
create or replace function public.printflow_admin_reset_owner_password(p_shop_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor text := printflow_private.require_admin();
  v_password text := printflow_private.temp_password();
  u public.printflow_users;
begin
  update public.printflow_users set password_hash = printflow_private.hash_password(v_password), must_change_password = true,
    password_changed_at = now(), failed_logins = 0, locked_until = null
  where shop_id = p_shop_id and role = 'shop_owner' returning * into u;
  if not found then perform printflow_private.fail(404, 'This shop has no owner account.'); end if;
  delete from public.printflow_sessions where user_id = u.id;
  perform printflow_private.log(v_actor, 'Reset shop owner password',
    format('%s (%s)', (select name from public.printflow_shops where id = p_shop_id), u.username), p_shop_id);
  return jsonb_build_object('username', u.username, 'temporaryPassword', v_password);
end;
$$;

-- Deletes the shop and everything in it; its files are queued for removal from Storage.
create or replace function public.printflow_admin_delete_shop(p_shop_id uuid, p_confirm_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor text := printflow_private.require_admin();
  s public.printflow_shops;
begin
  select * into s from public.printflow_shops where id = p_shop_id for update;
  if not found then perform printflow_private.fail(404, 'Shop not found.'); end if;
  if p_confirm_name is distinct from s.name then
    perform printflow_private.fail(400, 'Type the shop name exactly to confirm deletion.', 'confirmName');
  end if;
  insert into public.printflow_storage_trash (path)
  select storage_path from public.printflow_order_files where shop_id = s.id and stored on conflict do nothing;
  delete from public.printflow_shops where id = s.id; -- cascades to owner login, sessions, prices, orders, files, events
  perform printflow_private.log(v_actor, 'Deleted shop', s.name, null);
end;
$$;

-- ---------- service-role only (seed script, printflow-files Edge Function) ----------

create or replace function public.printflow_svc_create_super_admin(p_username text, p_password text, p_name text default 'Super Admin')
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_problem text := printflow_private.password_problem(p_password);
begin
  if v_username !~ '^[a-z0-9._-]{3,40}$' then perform printflow_private.fail(400, 'Username must be 3–40 letters, numbers, dots, dashes or underscores.'); end if;
  if v_problem is not null then perform printflow_private.fail(400, v_problem); end if;
  if exists (select 1 from public.printflow_users where username = v_username) then
    perform printflow_private.fail(409, 'That username is already taken.');
  end if;
  insert into public.printflow_users (username, name, password_hash, role)
  values (v_username, p_name, printflow_private.hash_password(p_password), 'super_admin');
  perform printflow_private.log('system', 'Created Super Admin account', v_username, null);
end;
$$;

create or replace function public.printflow_svc_create_demo_shop(p_username text, p_password text, p_qr_token text)
returns uuid language sql security definer set search_path = '' as $$
  select printflow_private.create_shop('system', 'Demo Print Shop', 'Demo Owner', '0300 1234567', '', 'Shop 4, Main Market', 'Lahore',
                                       'Mon–Sat, 9am–9pm', p_username, p_password, false, p_qr_token);
$$;

-- Storage paths to delete: queued trash plus customer uploads older than a day that never became an order.
create or replace function public.printflow_svc_storage_to_delete(p_limit int default 500)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(path), array[]::text[]) from (
    (select t.path from public.printflow_storage_trash t order by t.created_at limit p_limit)
    union
    (select o.name as path from storage.objects o
     where o.bucket_id = 'printflow-files' and o.name like 'incoming/%' and o.created_at < now() - interval '1 day'
       and not exists (select 1 from public.printflow_order_files f where f.storage_path = o.name)
     limit p_limit)) x;
$$;

create or replace function public.printflow_svc_storage_deleted(p_paths text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.printflow_storage_trash where path = any (p_paths);
$$;

-- ============================================================================
-- Function permissions
-- ============================================================================

revoke execute on all functions in schema printflow_private from public, anon, authenticated;

revoke execute on function public.printflow_svc_create_super_admin(text, text, text) from public, anon, authenticated;
revoke execute on function public.printflow_svc_create_demo_shop(text, text, text) from public, anon, authenticated;
revoke execute on function public.printflow_svc_storage_to_delete(int) from public, anon, authenticated;
revoke execute on function public.printflow_svc_storage_deleted(text[]) from public, anon, authenticated;
grant execute on function public.printflow_svc_create_super_admin(text, text, text) to service_role;
grant execute on function public.printflow_svc_create_demo_shop(text, text, text) to service_role;
grant execute on function public.printflow_svc_storage_to_delete(int) to service_role;
grant execute on function public.printflow_svc_storage_deleted(text[]) to service_role;

-- ============================================================================
-- Storage: private bucket for uploaded documents
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('printflow-files', 'printflow-files', false, 26214400, array[
  'application/pdf', 'image/png', 'image/jpeg', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

-- Customers may upload new files into incoming/<uuid>/<uuid>. Nobody can list, read or overwrite files through the
-- API; shop owners download through short-lived signed links from the printflow-files Edge Function.
create policy "printflow-files: anyone uploads new files" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'printflow-files' and name ~ '^incoming/[0-9a-f-]{36}/[0-9a-f-]{36}$');
