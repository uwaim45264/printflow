-- PrintFlow — open and clean up files straight from Storage (no Edge Function needed).
-- Run after the earlier migrations: SQL Editor → paste this file → Run. Safe to run again.
--
-- Supabase Storage passes the request headers to Row Level Security, so the same `x-printflow-session` header
-- used for the database decides who may read or delete a file:
--   * shop owner  → read files of their own shop's orders; delete their files that were queued for deletion
--   * super admin → read any file; delete queued files and customer uploads that never became an order (> 1 day)
--   * customers   → unchanged: may only upload new files into incoming/…

-- May the caller read this Storage object?
create or replace function public.printflow_can_read_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.printflow_is_super_admin()
      or exists (select 1 from public.printflow_order_files f
                 where f.storage_path = p_name and f.stored and f.shop_id = public.printflow_current_shop_id());
$$;

-- May the caller delete this Storage object? Only files the database has already queued for deletion,
-- plus (super admin) abandoned customer uploads.
create or replace function public.printflow_can_delete_file(p_name text, p_created_at timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    (exists (select 1 from public.printflow_storage_trash t where t.path = p_name)
      and (public.printflow_is_super_admin()
           or exists (select 1 from public.printflow_order_files f
                      where f.storage_path = p_name and f.shop_id = public.printflow_current_shop_id())))
    or (public.printflow_is_super_admin()
        and p_name like 'incoming/%' and p_created_at < now() - interval '1 day'
        and not exists (select 1 from public.printflow_order_files f where f.storage_path = p_name));
$$;

-- Storage paths the caller should remove now (used by the app after deleting files or shops).
create or replace function public.printflow_storage_to_delete_mine(p_limit int default 200)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(o.name), array[]::text[]) from (
    select o.name from storage.objects o
    where o.bucket_id = 'printflow-files' and public.printflow_can_delete_file(o.name, o.created_at)
    limit least(greatest(coalesce(p_limit, 200), 1), 500)) o;
$$;

-- Forgets queued paths that are gone from Storage (only removes entries whose file no longer exists).
create or replace function public.printflow_storage_forget_deleted(p_paths text[])
returns void language sql security definer set search_path = '' as $$
  delete from public.printflow_storage_trash t
  where t.path = any (p_paths)
    and not exists (select 1 from storage.objects o where o.bucket_id = 'printflow-files' and o.name = t.path);
$$;

revoke execute on function public.printflow_can_read_file(text) from public;
revoke execute on function public.printflow_can_delete_file(text, timestamptz) from public;
revoke execute on function public.printflow_storage_to_delete_mine(int) from public;
revoke execute on function public.printflow_storage_forget_deleted(text[]) from public;
grant execute on function public.printflow_can_read_file(text) to anon, authenticated;
grant execute on function public.printflow_can_delete_file(text, timestamptz) to anon, authenticated;
grant execute on function public.printflow_storage_to_delete_mine(int) to anon, authenticated;
grant execute on function public.printflow_storage_forget_deleted(text[]) to anon, authenticated;

drop policy if exists "printflow-files: owners read own files" on storage.objects;
create policy "printflow-files: owners read own files" on storage.objects for select to anon, authenticated
  using (bucket_id = 'printflow-files' and (public.printflow_can_read_file(name) or public.printflow_can_delete_file(name, created_at)));

drop policy if exists "printflow-files: delete queued files" on storage.objects;
create policy "printflow-files: delete queued files" on storage.objects for delete to anon, authenticated
  using (bucket_id = 'printflow-files' and public.printflow_can_delete_file(name, created_at));
