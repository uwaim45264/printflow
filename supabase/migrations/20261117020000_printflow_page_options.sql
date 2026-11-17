-- PrintFlow — "Pages to print" (page range) and "Pages per sheet" on orders.
-- Run after the earlier migrations: SQL Editor → paste this file → Run. Safe to run again.

alter table public.printflow_orders
  add column if not exists page_range text not null default '' check (char_length(page_range) <= 100),
  add column if not exists pages_per_sheet integer not null default 1 check (pages_per_sheet in (1, 2, 4));

-- Order of the files inside an order (page ranges count through the files in this order).
alter table public.printflow_order_files add column if not exists position integer not null default 0;

-- Number of pages selected by a range like "1-3, 5" out of p_total pages ('' = all). Raises 400 if invalid.
-- Same rules as parsePageRange() in src/shared/pageRange.ts.
create or replace function printflow_private.page_range_count(p_range text, p_total int)
returns int language plpgsql immutable set search_path = '' as $$
declare
  v text := regexp_replace(coalesce(p_range, ''), '\s+', '', 'g');
  part text;
  a int;
  b int;
  pages int[] := array[]::int[];
begin
  if v = '' then return p_total; end if;
  if char_length(v) > 100 then perform printflow_private.fail(400, 'Page range is too long.', 'pageRange'); end if;
  if v !~ '^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$' then
    perform printflow_private.fail(400, 'Use page numbers like 1-3, 5.', 'pageRange');
  end if;
  foreach part in array string_to_array(v, ',') loop
    a := split_part(part, '-', 1)::int;
    b := coalesce(nullif(split_part(part, '-', 2), '')::int, a);
    if a < 1 or b < a then perform printflow_private.fail(400, format('"%s" is not a valid range.', part), 'pageRange'); end if;
    if b > p_total then perform printflow_private.fail(400, format('The documents have only %s page(s).', p_total), 'pageRange'); end if;
    select array_agg(distinct x) into pages from unnest(pages || array(select generate_series(a, b))) x;
  end loop;
  return coalesce(cardinality(pages), 0);
end;
$$;
revoke execute on function printflow_private.page_range_count(text, int) from public, anon, authenticated;

-- Same as before, plus pageRange / pagesPerSheet and the file order.
-- p_order: {customerName, customerPhone, notes, colorMode, paperSize, sides, copies, finishing, pageRange, pagesPerSheet}
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
  v_range text := regexp_replace(coalesce(p_order ->> 'pageRange', ''), '\s+', '', 'g');
  v_per_sheet int;
  v_copies int;
  v_rule public.printflow_price_rules;
  v_fin_price numeric := 0;
  v_file jsonb;
  v_position int := 0;
  v_path text;
  v_size bigint;
  v_pages int;
  v_total_pages int := 0;
  v_selected int;
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
  begin
    v_per_sheet := coalesce((p_order ->> 'pagesPerSheet')::int, 1);
  exception when others then
    v_per_sheet := null;
  end;
  if v_per_sheet is null or v_per_sheet not in (1, 2, 4) then perform printflow_private.fail(400, 'Pages per sheet must be 1, 2 or 4.', 'pagesPerSheet'); end if;

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
                                       color_mode, paper_size, sides, copies, finishing, pages_per_sheet)
  values (v_order_id, s.id, v_order_no, v_code, v_name, v_phone, v_notes, v_color, v_paper, v_sides, v_copies, v_finishing, v_per_sheet);

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
    insert into public.printflow_order_files (order_id, shop_id, storage_path, original_name, mime, size, pages, position)
    values (v_order_id, s.id, v_path, v_file_name, v_mime, coalesce(v_size, 0), v_pages, v_position);
    v_position := v_position + 1;
    v_total_pages := v_total_pages + v_pages;
  end loop;

  -- Same formula as src/shared/pricing.ts: selected pages, pagesPerSheet to a side, double-sided rate per sheet.
  v_selected := printflow_private.page_range_count(v_range, v_total_pages);
  v_sheets := ceil(v_selected / v_per_sheet::numeric)::int;
  if v_sides = 'double' then v_sheets := ceil(v_sheets / 2.0)::int; end if;
  v_rate := case when v_sides = 'double' then v_rule.price_double else v_rule.price_single end;
  v_total := round(v_sheets * v_rate * v_copies + v_fin_price * v_copies, 2);

  update public.printflow_orders set page_count = v_total_pages, page_range = v_range, estimated_total = v_total where id = v_order_id;
  insert into public.printflow_order_events (order_id, shop_id, status, note, actor) values (v_order_id, s.id, 'pending', 'Order received via QR code', 'customer');
  perform printflow_private.log('customer', 'New order received', format('#%s · %s file(s)', v_order_no, jsonb_array_length(p_files)), s.id);

  return jsonb_build_object('trackingCode', v_code, 'orderNo', v_order_no, 'estimatedTotal', v_total, 'pageCount', v_total_pages);
end;
$$;
