-- Records one Stripe payment exactly once and applies it to the item it pays for.
-- Called only by the stripe-webhook Edge Function (service role). Returns false
-- when this payment was already recorded (Stripe retries webhooks).
create or replace function public.apply_stripe_payment(
  p_txn_id text, p_kind text, p_item_id text, p_amount numeric,
  p_type text, p_desc text, p_stripe jsonb, p_patch jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare tbl text := case p_kind when 'res' then 'reservations' when 'reg' then 'regs'
                                when 'mem' then 'members' when 'drop' then 'dropins' end;
        d jsonb;
begin
  if tbl is null then raise exception 'unknown kind %', p_kind; end if;
  insert into public.txns (id, data) values (p_txn_id, jsonb_build_object(
    'id', p_txn_id, 'at', public.iso_local(), 'type', p_type, 'desc', p_desc,
    'amount', round(p_amount, 2), 'method', 'card',
    'ref', jsonb_build_object('kind', p_kind, 'id', p_item_id), 'stripe', p_stripe))
  on conflict (id) do nothing;
  if not found then return false; end if;

  execute format('select data from public.%I where id = $1 for update', tbl) into d using p_item_id;
  if d is null then return true; end if;  -- item deleted; the payment is still on record
  if p_kind = 'res' then
    d := d || jsonb_build_object('paid', least(coalesce((d->>'total')::numeric, 0),
                                               coalesce((d->>'paid')::numeric, 0) + p_amount));
  elsif p_kind in ('reg', 'drop') then
    d := d || jsonb_build_object('due', greatest(0, coalesce((d->>'due')::numeric, 0) - p_amount),
                                 'paid', coalesce((d->>'paid')::numeric, 0) + p_amount);
  else
    d := d || jsonb_build_object('owed', greatest(0, coalesce((d->>'owed')::numeric, 0) - p_amount));
  end if;
  execute format('update public.%I set data = $1 || $2, updated_at = now() where id = $3', tbl)
    using d, coalesce(p_patch, '{}'::jsonb), p_item_id;
  return true;
end $$;
revoke all on function public.apply_stripe_payment(text,text,text,numeric,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_payment(text,text,text,numeric,text,text,jsonb,jsonb) to service_role;

-- Owner-side metadata (Stripe ids, invoice links) merged into an item without touching money fields.
create or replace function public.patch_item(p_kind text, p_item_id text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare tbl text := case p_kind when 'res' then 'reservations' when 'reg' then 'regs'
                                when 'mem' then 'members' when 'drop' then 'dropins' end;
begin
  if tbl is null then raise exception 'unknown kind %', p_kind; end if;
  execute format('update public.%I set data = data || $1, updated_at = now() where id = $2', tbl)
    using p_patch, p_item_id;
end $$;
revoke all on function public.patch_item(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.patch_item(text,text,jsonb) to service_role;

-- Records one Stripe refund exactly once against the payment it refunds and lowers
-- what the item shows as paid (same rule the site uses for desk refunds).
-- Called only by the Stripe Edge Functions (service role). Returns false if already recorded.
create or replace function public.apply_stripe_refund(
  p_txn_id text, p_refund_of text, p_amount numeric, p_desc text, p_stripe jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare o jsonb; k text; rid text; tbl text; d jsonb;
begin
  select data into o from public.txns where id = p_refund_of for update;
  if o is null then raise exception 'payment % not found', p_refund_of; end if;
  k := o->'ref'->>'kind'; rid := o->'ref'->>'id';
  insert into public.txns (id, data) values (p_txn_id, jsonb_build_object(
    'id', p_txn_id, 'at', public.iso_local(), 'type', 'refund', 'desc', p_desc,
    'amount', -round(p_amount, 2), 'method', 'card', 'ref', o->'ref', 'refundOf', p_refund_of, 'stripe', p_stripe))
  on conflict (id) do nothing;
  if not found then return false; end if;
  tbl := case k when 'res' then 'reservations' when 'reg' then 'regs' when 'drop' then 'dropins' end;
  if tbl is null then return true; end if;  -- memberships: the refund is on record, nothing else changes
  execute format('select data from public.%I where id = $1 for update', tbl) into d using rid;
  if d is null then return true; end if;
  execute format('update public.%I set data = data || $1, updated_at = now() where id = $2', tbl)
    using jsonb_build_object('paid', greatest(0, coalesce((d->>'paid')::numeric, 0) - p_amount)), rid;
  return true;
end $$;
revoke all on function public.apply_stripe_refund(text,text,numeric,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_stripe_refund(text,text,numeric,text,jsonb) to service_role;
