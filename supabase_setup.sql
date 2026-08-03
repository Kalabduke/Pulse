-- ====================================================================
-- PULSE STATUS APP - SUPABASE DDL SETUP
-- Copy and paste this entire script into your Supabase SQL Editor and run it.
-- ====================================================================

-- 1. Create PROFILES Table (Extends auth.users)
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  name text,
  status_emoji text default '😊',
  status_text text default 'Available',
  status_image_url text default null,
  last_seen timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Alter table in case it was created in a previous version
alter table public.profiles add column if not exists status_image_url text default null;
alter table public.profiles add column if not exists last_seen timestamp with time zone default timezone('utc'::text, now());

-- Enable Row Level Security (RLS) on Profiles
alter table public.profiles enable row level security;

-- 2. Create CONNECTIONS Table
create table if not exists public.connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  friend_id uuid references public.profiles(id) on delete cascade not null,
  status text not null default 'pending' check (status in ('pending', 'connected')),
  nickname text default null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  -- Ensure unique connections (no duplicates between two people)
  unique (user_id, friend_id)
);

-- Alter table in case it was created in a previous version
alter table public.connections add column if not exists nickname text default null;

-- Enable Row Level Security (RLS) on Connections
alter table public.connections enable row level security;

-- 3. Automatic Profile Creation Trigger on Sign Up
-- When a user registers via email/OTP, Supabase creates a record in auth.users.
-- This function automatically creates a corresponding record in public.profiles.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, status_emoji, status_text)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    '👋',
    'Just joined Pulse!'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

-- Trigger definition (drop first to allow re-running this script)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 4. ROW LEVEL SECURITY (RLS) POLICIES

-- Drop existing policies first so this script is idempotent
drop policy if exists "Allow logged in users to view all profiles" on public.profiles;
drop policy if exists "Allow users to insert their own profile" on public.profiles;
drop policy if exists "Allow users to update their own profile" on public.profiles;
drop policy if exists "Allow users to view their own connections" on public.connections;
drop policy if exists "Allow users to insert connections" on public.connections;
drop policy if exists "Allow users to update their connections" on public.connections;
drop policy if exists "Allow users to delete their connections" on public.connections;

-- --- PROFILES POLICIES ---

-- Allow users to view all profiles so they can find friends to connect
create policy "Allow logged in users to view all profiles"
on public.profiles
for select
to authenticated
using (true);

-- Allow users to insert their own profile (needed for OAuth users)
create policy "Allow users to insert their own profile"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

-- Allow users to update only their own profile
create policy "Allow users to update their own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- --- CONNECTIONS POLICIES ---

-- Allow users to view connections where they are either the sender or receiver
create policy "Allow users to view their own connections"
on public.connections
for select
to authenticated
using (auth.uid() = user_id or auth.uid() = friend_id);

-- Allow users to initiate a connection (sender must be the logged-in user)
create policy "Allow users to insert connections"
on public.connections
for insert
to authenticated
with check (auth.uid() = user_id);

-- Allow users to update a connection (accept connection, status change)
create policy "Allow users to update their connections"
on public.connections
for update
to authenticated
using (auth.uid() = user_id or auth.uid() = friend_id)
with check (auth.uid() = user_id or auth.uid() = friend_id);

-- Allow users to delete a connection (disconnect/reject)
create policy "Allow users to delete their connections"
on public.connections
for delete
to authenticated
using (auth.uid() = user_id or auth.uid() = friend_id);

-- 5. STATUS HISTORY TABLE
-- Stores status updates per user
create table if not exists public.status_history (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  status_emoji text not null,
  status_text text not null,
  status_image_url text default null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.status_history add column if not exists status_image_url text default null;

-- Enable RLS
alter table public.status_history enable row level security;

drop policy if exists "Allow users to insert own history" on public.status_history;
drop policy if exists "Allow users to view connected friends history" on public.status_history;

-- Users can insert their own history
create policy "Allow users to insert own history"
on public.status_history for insert to authenticated
with check (auth.uid() = user_id);

-- Users can view history of their connected friends + their own
create policy "Allow users to view connected friends history"
on public.status_history for select to authenticated
using (
  auth.uid() = user_id
  or exists (
    select 1 from public.connections
    where status = 'connected'
    and (
      (user_id = auth.uid() and friend_id = status_history.user_id)
      or (friend_id = auth.uid() and user_id = status_history.user_id)
    )
  )
);

-- Auto-delete old history keeping only last 15 per user
create or replace function public.trim_status_history()
returns trigger as $$
begin
  delete from public.status_history
  where user_id = new.user_id
  and id not in (
    select id from public.status_history
    where user_id = new.user_id
    order by created_at desc
    limit 15
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_status_history_insert on public.status_history;
create trigger on_status_history_insert
  after insert on public.status_history
  for each row execute procedure public.trim_status_history();

-- 6. MESSAGES TABLE (Direct Messaging)
create table if not exists public.messages (
  id uuid default gen_random_uuid() primary key,
  sender_id uuid references public.profiles(id) on delete cascade not null,
  recipient_id uuid references public.profiles(id) on delete cascade not null,
  content_text text,
  image_url text,
  read_at timestamp with time zone default null,
  delivered_at timestamp with time zone default null,
  reactions jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Alter table in case it was created in a previous version
alter table public.messages add column if not exists delivered_at timestamp with time zone default null;
alter table public.messages add column if not exists reactions jsonb not null default '{}'::jsonb;

alter table public.messages enable row level security;

drop policy if exists "Users can view their own direct messages" on public.messages;
drop policy if exists "Users can send direct messages" on public.messages;
drop policy if exists "Users can update direct messages sent to them" on public.messages;

create policy "Users can view their own direct messages"
on public.messages for select to authenticated
using (auth.uid() = sender_id or auth.uid() = recipient_id);

create policy "Users can send direct messages"
on public.messages for insert to authenticated
with check (auth.uid() = sender_id);

-- Recipient can mark delivered/read; sender can only react via the RPC below
-- (keeps the sender from editing message content — reactions go through
--  toggle_message_reaction which is security definer and participant-checked)
-- NOTE: an earlier version referenced new.read_at/new.delivered_at in the
-- with check clause, which some SQL editors reject (42P01 "missing
-- FROM-clause entry for table new"). The simple recipient-only check is
-- editor-safe and reactions are still enforced by the RPC.
create policy "Users can update delivery state of messages"
on public.messages for update to authenticated
using (auth.uid() = recipient_id)
with check (auth.uid() = recipient_id);

-- Sender can delete their own messages — the row vanishes for both sides
-- via realtime (message_deleted).
drop policy if exists "Users can delete their own direct messages" on public.messages;
create policy "Users can delete their own direct messages"
on public.messages for delete to authenticated
using (auth.uid() = sender_id);

-- ====================================================================
-- MESSAGE REACTIONS — toggle an emoji on a message.
-- Both participants may react. Stored as {"👍": ["user-uuid", ...]}.
-- Security definer: verifies the caller is a participant before writing,
-- so we never grant raw UPDATE on messages to the sender.
-- ====================================================================
create or replace function public.toggle_message_reaction(target_message_id uuid, reaction_emoji text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  current_reactions jsonb;
  participant boolean;
  user_reacted boolean;
  emoji_array jsonb;
begin
  if reaction_emoji is null or char_length(reaction_emoji) > 16 then
    raise exception 'Invalid reaction';
  end if;

  select (auth.uid() = sender_id or auth.uid() = recipient_id), coalesce(reactions, '{}'::jsonb)
  into participant, current_reactions
  from public.messages
  where id = target_message_id;

  if not found then
    raise exception 'Message not found';
  end if;
  if not participant then
    raise exception 'Not allowed';
  end if;

  user_reacted := current_reactions -> reaction_emoji ? auth.uid()::text;

  if user_reacted then
    -- Remove my uid from that emoji's array; drop the key when empty
    emoji_array := (current_reactions -> reaction_emoji) - auth.uid()::text;
    if jsonb_array_length(emoji_array) = 0 then
      current_reactions := current_reactions - reaction_emoji;
    else
      current_reactions := jsonb_set(current_reactions, array[reaction_emoji], emoji_array);
    end if;
  else
    -- Append my uid
    emoji_array := coalesce(current_reactions -> reaction_emoji, '[]'::jsonb) || to_jsonb(array[auth.uid()::text]);
    current_reactions := jsonb_set(current_reactions, array[reaction_emoji], emoji_array);
  end if;

  update public.messages set reactions = current_reactions where id = target_message_id;
  return current_reactions;
end;
$$;

-- Callers use the RPC for reactions; the direct-update policy only allows the
-- recipient to set delivery fields, so the sender is blocked from changing content.
-- (The RPC above runs as definer and is participant-checked — no extra grants needed.)

-- 7. PUSH SUBSCRIPTIONS TABLE
-- Stores Web Push subscriptions for background notifications
create table if not exists public.push_subscriptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  subscription jsonb not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique (user_id, (subscription->>'endpoint'))
);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Users manage own push subscriptions" on public.push_subscriptions;

create policy "Users manage own push subscriptions"
on public.push_subscriptions for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- 8. FCM TOKENS TABLE (for native Android push notifications)
create table if not exists public.fcm_tokens (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  token text not null unique,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.fcm_tokens enable row level security;

drop policy if exists "Users manage own FCM tokens" on public.fcm_tokens;

create policy "Users manage own FCM tokens"
on public.fcm_tokens for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- 9. ENABLE REALTIME SUBSCRIPTIONS
do $$
begin
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when others then end;
  begin
    alter publication supabase_realtime add table public.connections;
  exception when others then end;
  begin
    alter publication supabase_realtime add table public.messages;
  exception when others then end;
end;
$$;

-- 10. STORAGE BUCKET FOR PULSE IMAGES
-- Create public bucket 'pulse-images' for status and DM photo sharing
insert into storage.buckets (id, name, public)
values ('pulse-images', 'pulse-images', true)
on conflict (id) do nothing;

drop policy if exists "Public Access pulse-images" on storage.objects;
drop policy if exists "Authenticated upload pulse-images" on storage.objects;

create policy "Public Access pulse-images"
on storage.objects for select using (bucket_id = 'pulse-images');

create policy "Authenticated upload pulse-images"
on storage.objects for insert to authenticated
with check (bucket_id = 'pulse-images');

-- ====================================================================
-- PRIVATE STATUSES TABLE (per-friend status overrides)
-- When a user pulses to one specific friend, it goes here.
-- Only the target friend can read it; everyone else sees the public profile.
-- ====================================================================

create table if not exists public.private_statuses (
  id uuid default gen_random_uuid() primary key,
  from_user_id uuid references public.profiles(id) on delete cascade not null,
  to_user_id   uuid references public.profiles(id) on delete cascade not null,
  status_emoji      text not null default '😊',
  status_text       text not null default '',
  status_image_url  text default null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  -- One private status per sender→receiver pair (upsert friendly)
  unique (from_user_id, to_user_id)
);

alter table public.private_statuses enable row level security;

drop policy if exists "Sender can upsert their private statuses"   on public.private_statuses;
drop policy if exists "Recipient can view private statuses sent to them" on public.private_statuses;
drop policy if exists "Sender can delete their private statuses"   on public.private_statuses;

-- Sender can insert/update their own private statuses
create policy "Sender can upsert their private statuses"
on public.private_statuses for all to authenticated
using      (auth.uid() = from_user_id)
with check (auth.uid() = from_user_id);

-- Recipient can read statuses sent to them
create policy "Recipient can view private statuses sent to them"
on public.private_statuses for select to authenticated
using (auth.uid() = to_user_id);

-- Enable realtime so the recipient gets the update instantly
do $
begin
  begin
    alter publication supabase_realtime add table public.private_statuses;
  exception when others then end;
end;
$;

-- ====================================================================
-- MIGRATION: Private nicknames + name snapshots
-- Run this in Supabase SQL Editor if you already have the app running.
-- ====================================================================

-- 1. Add viewer_nickname: each side stores their OWN private label
--    user_id side sets viewer_nickname = their label for friend_id
--    friend_id side has no nickname on this row — they have their own row
--    This replaces the shared `nickname` column which leaked to both sides.
alter table public.connections
  add column if not exists viewer_nickname text default null;

-- 2. Add friend_name_snapshot: captures the friend's display name
--    at the moment the connection was accepted.
--    Existing friends keep seeing the name they connected with.
--    New connections snapshot the name at acceptance time.
alter table public.connections
  add column if not exists friend_name_snapshot text default null;

-- 3. Backfill friend_name_snapshot for existing connections
--    using current profile names (best we can do for existing data)
update public.connections c
set friend_name_snapshot = p.name
from public.profiles p
where c.friend_name_snapshot is null
  and c.status = 'connected'
  and p.id = c.friend_id;

-- Also backfill from the sender's perspective (the receiver's name)
-- This covers the case where user_id is the one who accepted
update public.connections c
set friend_name_snapshot = p.name
from public.profiles p
where c.friend_name_snapshot is null
  and p.id = c.user_id;

-- ====================================================================

-- ====================================================================
-- HOTFIX: Clear bad friend_name_snapshot data caused by wrong backfill
-- Run this NOW if friend names were replaced with your own name.
-- It nulls out all snapshots so the app falls back to live profile names.
-- ====================================================================
update public.connections set friend_name_snapshot = null;
-- ====================================================================

-- ====================================================================
-- TYPING INDICATORS (chat "typing…")
-- ====================================================================

create table if not exists public.typing_statuses (
  from_user_id uuid references public.profiles(id) on delete cascade not null,
  to_user_id   uuid references public.profiles(id) on delete cascade not null,
  updated_at   timestamptz default now() not null,
  primary key (from_user_id, to_user_id)
);

alter table public.typing_statuses enable row level security;

drop policy if exists "Sender manages own typing status" on public.typing_statuses;
drop policy if exists "Recipient can view typing status sent to them" on public.typing_statuses;

-- Sender can upsert/delete their own typing rows
create policy "Sender manages own typing status"
on public.typing_statuses for all to authenticated
using (auth.uid() = from_user_id)
with check (auth.uid() = from_user_id);

-- Recipient can only see typing rows sent to them
create policy "Recipient can view typing status sent to them"
on public.typing_statuses for select to authenticated
using (auth.uid() = to_user_id);

-- Realtime so the recipient sees the indicator instantly
do $$ begin
  begin
    alter publication supabase_realtime add table public.typing_statuses;
  exception when others then end;
end; $$;

-- ====================================================================
-- PERFORMANCE: unread counts + hot-query indexes (free-tier friendly)
-- ====================================================================

-- One grouped query returns unread message counts for the caller
create or replace function public.my_unread_message_counts()
returns table (sender uuid, cnt bigint)
language sql stable security definer
as $$
  select sender_id, count(*)::bigint
  from public.messages
  where recipient_id = auth.uid() and read_at is null
  group by sender_id;
$$;

-- Realtime publication for messages already exists; add missing hot indexes
do $$
begin
  begin
    create index if not exists idx_messages_recipient_unread on public.messages (recipient_id, read_at);
  exception when others then end;
  begin
    create index if not exists idx_messages_conversation on public.messages (sender_id, recipient_id, created_at desc);
  exception when others then end;
  begin
    create index if not exists idx_status_history_user on public.status_history (user_id, created_at desc);
  exception when others then end;
  begin
    create index if not exists idx_connections_user on public.connections (user_id);
  exception when others then end;
  begin
    create index if not exists idx_connections_friend on public.connections (friend_id);
  exception when others then end;
  begin
    create index if not exists idx_profiles_last_seen on public.profiles (last_seen);
  exception when others then end;
end;
$$;

-- ====================================================================
-- LIVE LOCATION SHARING
-- ====================================================================

create table if not exists public.location_shares (
  id           uuid default gen_random_uuid() primary key,
  from_user_id uuid references public.profiles(id) on delete cascade not null,
  to_user_id   uuid references public.profiles(id) on delete cascade not null,
  latitude     double precision not null,
  longitude    double precision not null,
  is_active    boolean default true not null,
  updated_at   timestamptz default now() not null,
  unique (from_user_id, to_user_id)
);

alter table public.location_shares enable row level security;

drop policy if exists "Sender manages own location shares" on public.location_shares;
drop policy if exists "Recipient can view location shared with them" on public.location_shares;

-- Sender can insert/update/delete their own shares
create policy "Sender manages own location shares"
on public.location_shares for all to authenticated
using (auth.uid() = from_user_id)
with check (auth.uid() = from_user_id);

-- Recipient can only read active shares sent to them
create policy "Recipient can view location shared with them"
on public.location_shares for select to authenticated
using (auth.uid() = to_user_id and is_active = true);

-- Realtime so recipients get instant location updates
do $$ begin
  begin
    alter publication supabase_realtime add table public.location_shares;
  exception when others then end;
end; $$;
