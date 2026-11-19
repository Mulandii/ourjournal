-- ============================================================================
--  Little Journal — Supabase setup
--  1. Change the setup code on the line marked  >>>  below (any secret, 8+ characters).
--  2. Paste this whole file into Supabase → SQL Editor → New query, then press Run.
--  Safe to run again later (for example after updating the app).
-- ============================================================================

create table if not exists public.journal_settings (
  id int primary key default 1 check (id = 1),
  setup_code text not null
);
insert into public.journal_settings (id, setup_code)
values (1, 'CHANGE-ME')   -- >>> put your own secret setup code here, e.g. 'pancake-violet-harbor'
on conflict (id) do update set setup_code = excluded.setup_code;
revoke all on public.journal_settings from anon, authenticated;
alter table public.journal_settings enable row level security;

-- ---------------------------------------------------------------- tables
create table if not exists public.profiles (
  id   uuid primary key references auth.users (id) on delete cascade,
  who  text not null unique check (who in ('a', 'b')),
  name text not null check (char_length(name) between 1 and 24)
);

create table if not exists public.meta (
  id    int primary key default 1 check (id = 1),
  title text not null default 'Our little journal' check (char_length(title) <= 60)
);
insert into public.meta (id) values (1) on conflict (id) do nothing;

create table if not exists public.pages (
  id      uuid primary key default gen_random_uuid(),
  title   text not null default '' check (char_length(title) <= 80),
  date    text not null default '' check (char_length(date) <= 10),
  place   text not null default '' check (char_length(place) <= 60),
  note    text not null default '' check (char_length(note) <= 400),
  layout  text not null default 'D' check (layout in ('D', 'C')),
  cover   uuid,
  owner   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created timestamptz not null default now()
);

create table if not exists public.media (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('image', 'video')),
  page       uuid references public.pages (id) on delete cascade,
  caption    text not null default '' check (char_length(caption) <= 80),
  w          int not null default 0,
  h          int not null default 0,
  duration   real not null default 0,
  size       bigint not null default 0,
  name       text not null default '' check (char_length(name) <= 120),
  sort_order double precision not null default 0,
  added_at   bigint not null default 0,
  owner      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  file       text not null,
  poster     text,
  created    timestamptz not null default now()
);
create index if not exists media_page_idx on public.media (page);

-- target = a media id, or 'pg.<page id>' for a journal page
create table if not exists public.hearts (
  id      uuid primary key default gen_random_uuid(),
  target  text not null check (char_length(target) <= 60),
  who     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created timestamptz not null default now(),
  unique (target, who)
);

create table if not exists public.notes (
  id      uuid primary key default gen_random_uuid(),
  target  text not null check (char_length(target) <= 60),
  who     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text    text not null check (char_length(text) between 1 and 240),
  created timestamptz not null default now()
);
create index if not exists notes_target_idx on public.notes (target);

-- ---------------------------------------------------------------- helpers
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;

-- names for the sign-in screen (the only thing visible before signing in)
create or replace function public.journal_people() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'setup', (select count(*) from public.profiles) < 2,
    'people', coalesce((select json_agg(json_build_object('slot', who, 'name', name) order by who) from public.profiles), '[]'::json)
  );
$$;
grant execute on function public.journal_people() to anon, authenticated;

-- lets the setup screen say "wrong code" before trying to create accounts
create or replace function public.journal_check_code(code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.journal_settings s
    where s.id = 1 and s.setup_code not like 'CHANGE-ME%' and char_length(s.setup_code) >= 8 and s.setup_code = code
  ) and (select count(*) from public.profiles) < 2;
$$;
grant execute on function public.journal_check_code(text) to anon, authenticated;

-- every new account must come from the setup screen (right code, free slot, max two people)
create or replace function public.journal_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  code text;
  slot text := new.raw_user_meta_data ->> 'slot';
  nm   text := btrim(coalesce(new.raw_user_meta_data ->> 'name', ''));
begin
  select setup_code into code from public.journal_settings where id = 1;
  if code is null or code like 'CHANGE-ME%' or char_length(code) < 8 then
    raise exception 'Setup is switched off: set your setup code in schema.sql and run it again.';
  end if;
  if coalesce(new.raw_user_meta_data ->> 'setup_code', '') <> code then
    raise exception 'Wrong setup code.';
  end if;
  if slot is null or slot not in ('a', 'b') then raise exception 'Bad slot.'; end if;
  if nm = '' then raise exception 'A name is needed.'; end if;
  if (select count(*) from public.profiles) >= 2 or exists (select 1 from public.profiles where who = slot) then
    raise exception 'This journal is already set up.';
  end if;
  insert into public.profiles (id, who, name) values (new.id, slot, left(nm, 24));
  return new;
end $$;
drop trigger if exists journal_new_user on auth.users;
create trigger journal_new_user after insert on auth.users
  for each row execute function public.journal_new_user();

-- a page's words, date, place and cover belong to its owner; anyone in the journal may switch its layout
create or replace function public.journal_page_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('journal.cleanup', true), '') = 'on' then return new; end if;
  if new.owner is distinct from old.owner then raise exception 'Pages can''t change owner.'; end if;
  if old.owner <> auth.uid() and (new.title, new.date, new.place, new.note, new.cover)
       is distinct from (old.title, old.date, old.place, old.note, old.cover) then
    raise exception 'Only the person who made this page can change it.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists journal_page_guard on public.pages;
create trigger journal_page_guard before update on public.pages
  for each row execute function public.journal_page_guard();

create or replace function public.journal_media_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.owner is distinct from old.owner or new.file is distinct from old.file then
    raise exception 'That can''t be changed.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists journal_media_guard on public.media;
create trigger journal_media_guard before update on public.media
  for each row execute function public.journal_media_guard();

-- deleting a photo/video or page also removes its hearts + notes (including the other person's)
create or replace function public.journal_media_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.hearts where target = old.id::text;
  delete from public.notes  where target = old.id::text;
  perform set_config('journal.cleanup', 'on', true);
  update public.pages set cover = null where cover = old.id;
  perform set_config('journal.cleanup', 'off', true);
  return old;
end $$;
drop trigger if exists journal_media_deleted on public.media;
create trigger journal_media_deleted after delete on public.media
  for each row execute function public.journal_media_deleted();

create or replace function public.journal_page_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.hearts where target = 'pg.' || old.id::text;
  delete from public.notes  where target = 'pg.' || old.id::text;
  return old;
end $$;
drop trigger if exists journal_page_deleted on public.pages;
create trigger journal_page_deleted after delete on public.pages
  for each row execute function public.journal_page_deleted();

-- ---------------------------------------------------------------- access rules
alter table public.profiles enable row level security;
alter table public.meta     enable row level security;
alter table public.pages    enable row level security;
alter table public.media    enable row level security;
alter table public.hearts   enable row level security;
alter table public.notes    enable row level security;

revoke update on public.profiles from anon, authenticated;
grant update (name) on public.profiles to authenticated;

-- (policies are dropped first so this file can be run again)
drop policy if exists "members read"   on public.profiles;
drop policy if exists "own name"       on public.profiles;
drop policy if exists "members read"   on public.meta;
drop policy if exists "members rename" on public.meta;
drop policy if exists "members read"   on public.pages;
drop policy if exists "owner adds"     on public.pages;
drop policy if exists "members edit"   on public.pages;
drop policy if exists "owner deletes"  on public.pages;
drop policy if exists "members read"   on public.media;
drop policy if exists "owner adds"     on public.media;
drop policy if exists "owner edits"    on public.media;
drop policy if exists "owner deletes"  on public.media;
drop policy if exists "members read"   on public.hearts;
drop policy if exists "own heart"      on public.hearts;
drop policy if exists "unheart own"    on public.hearts;
drop policy if exists "members read"   on public.notes;
drop policy if exists "own note"       on public.notes;
drop policy if exists "remove own"     on public.notes;

create policy "members read"   on public.profiles for select to authenticated using (public.is_member());
create policy "own name"       on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members read"   on public.meta for select to authenticated using (public.is_member());
create policy "members rename" on public.meta for update to authenticated using (public.is_member()) with check (public.is_member());

create policy "members read"   on public.pages for select to authenticated using (public.is_member());
create policy "owner adds"     on public.pages for insert to authenticated with check (owner = auth.uid() and public.is_member());
create policy "members edit"   on public.pages for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "owner deletes"  on public.pages for delete to authenticated using (owner = auth.uid());

create policy "members read"   on public.media for select to authenticated using (public.is_member());
create policy "owner adds"     on public.media for insert to authenticated with check (
  owner = auth.uid() and public.is_member()
  and (page is null or exists (select 1 from public.pages p where p.id = page and p.owner = auth.uid())));
create policy "owner edits"    on public.media for update to authenticated using (owner = auth.uid()) with check (
  owner = auth.uid() and (page is null or exists (select 1 from public.pages p where p.id = page and p.owner = auth.uid())));
create policy "owner deletes"  on public.media for delete to authenticated using (owner = auth.uid());

create policy "members read"   on public.hearts for select to authenticated using (public.is_member());
create policy "own heart"      on public.hearts for insert to authenticated with check (who = auth.uid() and public.is_member());
create policy "unheart own"    on public.hearts for delete to authenticated using (who = auth.uid());

create policy "members read"   on public.notes for select to authenticated using (public.is_member());
create policy "own note"       on public.notes for insert to authenticated with check (who = auth.uid() and public.is_member());
create policy "remove own"     on public.notes for delete to authenticated using (who = auth.uid());

-- ---------------------------------------------------------------- photo + video storage (private)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('journal', 'journal', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "journal members read"   on storage.objects;
drop policy if exists "journal upload own"     on storage.objects;
drop policy if exists "journal delete own"     on storage.objects;
create policy "journal members read" on storage.objects for select to authenticated
  using (bucket_id = 'journal' and public.is_member());
create policy "journal upload own"   on storage.objects for insert to authenticated
  with check (bucket_id = 'journal' and public.is_member() and (storage.foldername(name))[1] = auth.uid()::text);
create policy "journal delete own"   on storage.objects for delete to authenticated
  using (bucket_id = 'journal' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------- live updates
do $$
declare t text;
begin
  foreach t in array array['pages', 'media', 'hearts', 'notes', 'meta', 'profiles'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

select 'Little Journal is ready ♡  Next: Authentication → Sign In / Providers → Email → turn OFF "Confirm email".' as next_step;
