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
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

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

-- 5. ENABLE REALTIME SUBSCRIPTIONS
-- Enable real-time replication for profiles and connections so status updates sync immediately!
-- Note: If these tables are already in the publication, the alter will be a no-op.
do $$
begin
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when others then
    -- already added, ignore
  end;
  begin
    alter publication supabase_realtime add table public.connections;
  exception when others then
    -- already added, ignore
  end;
end;
$$;

-- 6. ADD NICKNAME COLUMN (run this if you already have the connections table)
alter table public.connections add column if not exists nickname text default null;
