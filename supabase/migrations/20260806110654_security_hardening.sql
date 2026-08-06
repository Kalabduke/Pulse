-- ====================================================================
-- SECURITY HARDENING (idempotent — safe to re-run)
-- ====================================================================

-- 1. Tighten the profiles SELECT policy. Previously ANY authenticated user
--    could read every profile including last_seen (presence tracking) and the
--    account flags (deactivated_at / deletion_requested_at). Now only your own
--    profile and profiles of people you have a connection row with (pending
--    OR connected — both directions) are visible. Strangers find you via the
--    profiles_public view below, which exposes safe fields only.
drop policy if exists "Allow logged in users to view all profiles" on public.profiles;

create policy "Users can view profiles they are connected with"
on public.profiles
for select
to authenticated
using (
  auth.uid() = id
  or exists (
    select 1 from public.connections c
    where (c.user_id = auth.uid() and c.friend_id = public.profiles.id)
       or (c.friend_id = auth.uid() and c.user_id = public.profiles.id)
  )
);

-- 2. Public directory view — ONLY safe fields (id, name, username, status).
--    No last_seen, no deactivated_at, no deletion_requested_at, no email.
--    Username/name search routes through this view instead of profiles.
create or replace view public.profiles_public
with (security_invoker = false)
as
select id, name, username, status_emoji, status_text, status_image_url, status_media_type, updated_at
from public.profiles
where deactivated_at is null;

grant select on public.profiles_public to authenticated;

-- 3. Storage: enforce per-folder ownership on uploads (statuses/<my-uid>/…)
--    + owner-only delete + per-file size / mime limits (free-tier protection).
drop policy if exists "Authenticated upload pulse-images" on storage.objects;
drop policy if exists "Owners can delete their pulse-images" on storage.objects;

create policy "Authenticated upload pulse-images"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'pulse-images'
  and (storage.foldername(name))[1] = 'statuses'
  and (storage.foldername(name))[2] = auth.uid()::text
);

create policy "Owners can delete their pulse-images"
on storage.objects for delete to authenticated
using (
  bucket_id = 'pulse-images'
  and (storage.foldername(name))[1] = 'statuses'
  and (storage.foldername(name))[2] = auth.uid()::text
);

update storage.buckets
set file_size_limit = 52428800, -- 50 MB max per file (videos are compressed client-side)
    allowed_mime_types = array[
      'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
      'video/mp4','video/webm','video/quicktime','application/octet-stream'
    ]
where id = 'pulse-images';

-- 4. Per-sender push cooldown (anti-spam) — max 1 push per (sender→recipient)
--    pair per window. Written only by the security-definer RPC below.
create table if not exists public.push_cooldowns (
  sender_id uuid references public.profiles(id) on delete cascade not null,
  recipient_id uuid references public.profiles(id) on delete cascade not null,
  last_sent_at timestamptz not null default now(),
  primary key (sender_id, recipient_id)
);

alter table public.push_cooldowns enable row level security;
-- No direct access policies — the RPC is the only writer.

create or replace function public.acquire_push_slot(recipient uuid, window_seconds int default 10)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  last_sent timestamptz;
begin
  select last_sent_at into last_sent
  from public.push_cooldowns
  where sender_id = auth.uid() and recipient_id = recipient;

  if last_sent is not null and last_sent > now() - make_interval(secs => window_seconds) then
    return false;
  end if;

  insert into public.push_cooldowns (sender_id, recipient_id, last_sent_at)
  values (auth.uid(), recipient, now())
  on conflict (sender_id, recipient_id) do update set last_sent_at = now();

  return true;
end;
$$;

