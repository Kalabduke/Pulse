-- Make acquire_push_slot atomic (row-lock serialization instead of read-then-write)
create or replace function public.acquire_push_slot(recipient uuid, window_seconds int default 10)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  update public.push_cooldowns
  set last_sent_at = now()
  where sender_id = auth.uid() and recipient_id = recipient
    and last_sent_at <= now() - make_interval(secs => window_seconds);
  if found then
    return true;
  end if;

  insert into public.push_cooldowns (sender_id, recipient_id, last_sent_at)
  values (auth.uid(), recipient, now())
  on conflict (sender_id, recipient_id) do nothing;
  return found;
end;
$$;
