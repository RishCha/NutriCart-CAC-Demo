-- Run once in the Supabase SQL Editor. No secret or project-specific value is required.
create table if not exists public.nutricart_saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('grocery_plan', 'meal_plan', 'shopping_list')),
  name text not null check (char_length(name) between 1 and 80),
  plan_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists nutricart_saved_items_owner_kind
  on public.nutricart_saved_items (user_id, kind, updated_at desc);

alter table public.nutricart_saved_items enable row level security;

grant usage on schema public to authenticated;
revoke all on table public.nutricart_saved_items from public;
revoke all on table public.nutricart_saved_items from anon;
revoke all on table public.nutricart_saved_items from authenticated;
grant select, insert, update, delete on table public.nutricart_saved_items to authenticated;

drop policy if exists "NutriCart users select own saved items" on public.nutricart_saved_items;
create policy "NutriCart users select own saved items"
  on public.nutricart_saved_items for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "NutriCart users insert own saved items" on public.nutricart_saved_items;
create policy "NutriCart users insert own saved items"
  on public.nutricart_saved_items for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "NutriCart users update own saved items" on public.nutricart_saved_items;
create policy "NutriCart users update own saved items"
  on public.nutricart_saved_items for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "NutriCart users delete own saved items" on public.nutricart_saved_items;
create policy "NutriCart users delete own saved items"
  on public.nutricart_saved_items for delete
  to authenticated
  using ((select auth.uid()) = user_id);
