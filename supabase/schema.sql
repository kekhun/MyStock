create table if not exists public.mystock_documents (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);

alter table public.mystock_documents enable row level security;

drop policy if exists "Users can read their own MyStock documents" on public.mystock_documents;
create policy "Users can read their own MyStock documents"
on public.mystock_documents
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own MyStock documents" on public.mystock_documents;
create policy "Users can insert their own MyStock documents"
on public.mystock_documents
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own MyStock documents" on public.mystock_documents;
create policy "Users can update their own MyStock documents"
on public.mystock_documents
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own MyStock documents" on public.mystock_documents;
create policy "Users can delete their own MyStock documents"
on public.mystock_documents
for delete
to authenticated
using ((select auth.uid()) = user_id);
