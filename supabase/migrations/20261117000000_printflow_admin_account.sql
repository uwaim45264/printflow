-- PrintFlow — lets the Super Admin change their own username and name from the Account page.
-- Run after 20261113000000_printflow_init.sql: SQL Editor → paste this file → Run. Safe to run again.

-- Changes the signed-in Super Admin's username and name. Requires the current password.
-- Returns the updated user (same shape as printflow_get_session_user). The session stays valid.
create or replace function public.printflow_admin_update_account(p_current_password text, p_username text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  u public.printflow_users;
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_old text;
begin
  perform printflow_private.require_admin();
  u := printflow_private.require_user();
  if v_username !~ '^[a-z0-9._-]{3,40}$' then
    perform printflow_private.fail(400, 'Username must be 3–40 letters, numbers, dots, dashes or underscores.', 'username');
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    perform printflow_private.fail(400, 'Name must be 1–80 characters.', 'name');
  end if;
  if not printflow_private.check_password(p_current_password, u.password_hash) then
    perform printflow_private.fail(400, 'Current password is incorrect.', 'currentPassword');
  end if;
  if v_username <> u.username and exists (select 1 from public.printflow_users where username = v_username) then
    perform printflow_private.fail(409, 'That username is already taken.', 'username');
  end if;

  v_old := u.username;
  update public.printflow_users set username = v_username, name = v_name where id = u.id returning * into u;
  perform printflow_private.log(u.username, 'Updated account details',
    case when v_old <> u.username then format('Username changed from %s to %s', v_old, u.username) else 'Name changed' end, null);
  return printflow_private.user_json(u);
end;
$$;

revoke execute on function public.printflow_admin_update_account(text, text, text) from public;
grant execute on function public.printflow_admin_update_account(text, text, text) to anon, authenticated;
