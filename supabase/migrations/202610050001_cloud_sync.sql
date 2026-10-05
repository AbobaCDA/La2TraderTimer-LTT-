-- LTT cloud sync / Telegram backend schema
-- Apply with Supabase SQL Editor. This migration is safe to run more than once.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'member' check (role in ('owner', 'member')),
  access_status text not null default 'pending' check (access_status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.characters (
  user_id uuid not null references public.profiles(id) on delete cascade,
  id text not null check (length(id) between 1 and 100),
  name text not null check (length(trim(name)) between 1 and 32),
  license boolean not null default false,
  started_at timestamptz,
  end_at timestamptz,
  shift_hours smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint characters_timer_fields_check check (
    (started_at is null and end_at is null and shift_hours is null)
    or
    (started_at is not null and end_at is not null and shift_hours in (12, 24) and end_at > started_at)
  )
);

create table if not exists public.telegram_pairing_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text not null,
  chat_id text not null,
  telegram_username text,
  first_name text not null default '',
  code_hash text not null unique check (length(code_hash) = 64),
  status text not null default 'pending' check (status in ('pending', 'approved', 'consumed', 'rejected', 'expired')),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  linked_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists telegram_pairing_requests_pending_idx
  on public.telegram_pairing_requests (created_at desc)
  where status = 'pending';
create index if not exists telegram_pairing_requests_tg_idx
  on public.telegram_pairing_requests (telegram_user_id, created_at desc);

create table if not exists public.telegram_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  telegram_user_id text not null unique,
  chat_id text not null unique,
  telegram_username text,
  linked_at timestamptz not null default now()
);

create table if not exists public.timer_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  character_id text not null,
  timer_started_at timestamptz not null,
  timer_ends_at timestamptz not null,
  reminder_minutes smallint not null check (reminder_minutes in (60, 30, 10)),
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timer_notifications_character_fk
    foreign key (user_id, character_id)
    references public.characters(user_id, id)
    on delete cascade,
  constraint timer_notifications_once_per_timer
    unique (user_id, character_id, timer_started_at, reminder_minutes)
);

create index if not exists timer_notifications_due_idx
  on public.timer_notifications (due_at, next_attempt_at)
  where status = 'pending';

-- New Supabase Auth accounts get a private, inactive profile. Entering a valid
-- one-time Telegram code activates only that user's own cloud data.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists characters_set_updated_at on public.characters;
create trigger characters_set_updated_at
before update on public.characters
for each row execute function public.set_updated_at();

drop trigger if exists timer_notifications_set_updated_at on public.timer_notifications;
create trigger timer_notifications_set_updated_at
before update on public.timer_notifications
for each row execute function public.set_updated_at();

-- Rebuild only unsent reminders when a timer is started or its boarding time changes.
create or replace function public.rebuild_character_notifications()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reminder smallint;
  reminder_due_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    update public.timer_notifications
       set status = 'cancelled', lease_until = null, updated_at = now()
     where user_id = old.user_id
       and character_id = old.id
       and status in ('pending', 'sending');
  end if;

  if new.started_at is not null and new.end_at is not null then
    foreach reminder in array array[60, 30, 10]::smallint[] loop
      reminder_due_at := new.end_at - make_interval(mins => reminder::integer);
      if reminder_due_at > now() then
        insert into public.timer_notifications (
          user_id, character_id, timer_started_at, timer_ends_at,
          reminder_minutes, due_at, status, next_attempt_at
        ) values (
          new.user_id, new.id, new.started_at, new.end_at,
          reminder, reminder_due_at, 'pending', reminder_due_at
        )
        on conflict (user_id, character_id, timer_started_at, reminder_minutes) do nothing;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists characters_schedule_notifications_insert on public.characters;
create trigger characters_schedule_notifications_insert
after insert on public.characters
for each row execute function public.rebuild_character_notifications();

drop trigger if exists characters_schedule_notifications_update on public.characters;
create trigger characters_schedule_notifications_update
after update of started_at, end_at on public.characters
for each row
when (old.started_at is distinct from new.started_at or old.end_at is distinct from new.end_at)
execute function public.rebuild_character_notifications();

-- Atomically consume an approved, unexpired code and bind one Telegram account
-- to the signed-in Supabase Auth user. Only the server-side secret key can call it.
drop function if exists public.consume_telegram_pairing_code(text, uuid);

create or replace function public.consume_telegram_pairing_code(
  p_code_hash text,
  p_user_id uuid,
  p_owner_telegram_id text default null
)
returns table (telegram_user_id text, chat_id text, telegram_username text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.telegram_pairing_requests%rowtype;
begin
  if p_user_id is null or not exists (
    select 1 from public.profiles where id = p_user_id and access_status <> 'suspended'
  ) then
    raise exception 'ACCOUNT_NOT_AVAILABLE';
  end if;

  select * into request_row
    from public.telegram_pairing_requests
   where code_hash = p_code_hash
     and status = 'approved'
     and expires_at > now()
     and consumed_at is null
   for update;

  if not found then
    raise exception 'PAIRING_CODE_INVALID_EXPIRED_OR_NOT_APPROVED';
  end if;

  if exists (select 1 from public.telegram_accounts where user_id = p_user_id)
     or exists (select 1 from public.telegram_accounts where telegram_user_id = request_row.telegram_user_id) then
    raise exception 'TELEGRAM_ACCOUNT_ALREADY_LINKED';
  end if;

  insert into public.telegram_accounts (user_id, telegram_user_id, chat_id, telegram_username)
  values (p_user_id, request_row.telegram_user_id, request_row.chat_id, request_row.telegram_username);

  update public.telegram_pairing_requests
     set status = 'consumed', consumed_at = now(), linked_user_id = p_user_id
   where id = request_row.id;

  update public.profiles
     set role = case
       when nullif(p_owner_telegram_id, '') is not null
        and request_row.telegram_user_id = nullif(p_owner_telegram_id, '')
       then 'owner'
       else role
     end,
     access_status = 'active'
   where id = p_user_id;

  return query
    select request_row.telegram_user_id, request_row.chat_id, request_row.telegram_username;
end;
$$;

revoke all on function public.consume_telegram_pairing_code(text, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_telegram_pairing_code(text, uuid, text) to service_role;

-- Claim due reminder jobs without allowing two scheduled invocations to send the same reminder.
create or replace function public.claim_due_timer_notifications(p_limit integer default 100)
returns table (
  job_id uuid,
  user_id uuid,
  character_id text,
  telegram_chat_id text,
  character_name text,
  reminder_minutes smallint,
  timer_started_at timestamptz,
  timer_ends_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select n.id
      from public.timer_notifications n
      join public.telegram_accounts ta on ta.user_id = n.user_id
      join public.profiles p on p.id = n.user_id and p.access_status = 'active'
      join public.characters c on c.user_id = n.user_id and c.id = n.character_id
     where n.status in ('pending', 'sending')
       and n.due_at <= now()
       and n.next_attempt_at <= now()
       and (n.lease_until is null or n.lease_until < now())
       and c.started_at = n.timer_started_at
       and c.end_at = n.timer_ends_at
     order by n.due_at
     limit greatest(1, least(coalesce(p_limit, 100), 500))
     for update of n skip locked
  ), claimed as (
    update public.timer_notifications n
       set status = 'sending',
           attempts = n.attempts + 1,
           lease_until = now() + interval '3 minutes',
           updated_at = now()
      from candidates x
     where n.id = x.id
    returning n.*
  )
  select claimed.id, claimed.user_id, claimed.character_id, ta.chat_id,
         c.name, claimed.reminder_minutes, claimed.timer_started_at, claimed.timer_ends_at
    from claimed
    join public.telegram_accounts ta on ta.user_id = claimed.user_id
    join public.profiles p on p.id = claimed.user_id and p.access_status = 'active'
    join public.characters c on c.user_id = claimed.user_id and c.id = claimed.character_id
   where c.started_at = claimed.timer_started_at and c.end_at = claimed.timer_ends_at;
end;
$$;

revoke all on function public.claim_due_timer_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_due_timer_notifications(integer) to service_role;

-- Client-facing access: each signed-in member can access only their own rows.
-- Owners intentionally receive no cross-user data policy.
alter table public.profiles enable row level security;
alter table public.characters enable row level security;
alter table public.telegram_pairing_requests enable row level security;
alter table public.telegram_accounts enable row level security;
alter table public.timer_notifications enable row level security;

revoke all on public.profiles from anon, authenticated;
revoke all on public.characters from anon, authenticated;
revoke all on public.telegram_pairing_requests from anon, authenticated;
revoke all on public.telegram_accounts from anon, authenticated;
revoke all on public.timer_notifications from anon, authenticated;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.characters to authenticated;
grant all on public.profiles to service_role;
grant all on public.characters to service_role;
grant all on public.telegram_pairing_requests to service_role;
grant all on public.telegram_accounts to service_role;
grant all on public.timer_notifications to service_role;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists characters_select_self on public.characters;
create policy characters_select_self
  on public.characters for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.access_status = 'active'
    )
  );

drop policy if exists characters_insert_self on public.characters;
create policy characters_insert_self
  on public.characters for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.access_status = 'active'
    )
  );

drop policy if exists characters_update_self on public.characters;
create policy characters_update_self
  on public.characters for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.access_status = 'active'
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.access_status = 'active'
    )
  );

drop policy if exists characters_delete_self on public.characters;
create policy characters_delete_self
  on public.characters for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.profiles p
       where p.id = (select auth.uid()) and p.access_status = 'active'
    )
  );

-- Tables used only by Edge Functions must not be accessible through the public Data API.
comment on table public.telegram_pairing_requests is 'Private one-time Telegram-to-app pairing requests; Edge Functions only.';
comment on table public.telegram_accounts is 'Private Telegram identity mapping; Edge Functions only.';
comment on table public.timer_notifications is 'Private scheduled notification queue; Edge Functions only.';
comment on table public.profiles is 'One private profile per Supabase Auth user; owners cannot read other users profiles.';
comment on table public.characters is 'Timer data isolated by user_id via RLS; owner role has no cross-user visibility.';
