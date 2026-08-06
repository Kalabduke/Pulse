import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Cron-scheduled (or manual) job: permanently deletes accounts whose
// 30-day grace period (deletion_requested_at) has elapsed. Deleting the
// auth user cascades to profiles, connections, messages, etc.
//
// Schedule (Supabase dashboard → Edge Functions → cleanup-deleted-accounts → cron):
//   */30 * * * *   (every 30 min) or daily  0 3 * * *
Deno.serve(async (req) => {
  // REQUIRED: a CRON_SECRET header so only the scheduler can trigger it.
  // Fail CLOSED — if the secret isn't configured we refuse to run rather than
  // let anyone with the URL delete accounts (this function holds the
  // service-role key, and an unset secret previously left it wide open).
  const cronSecret = Deno.env.get('CRON_SECRET');
  if (!cronSecret) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: CRON_SECRET not set' }), { status: 500 });
  }
  const auth = req.headers.get('Authorization') || '';
  if (auth !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Missing env vars' }), { status: 500 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Find users whose grace period expired
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: doomed, error: fetchError } = await admin
    .from('profiles')
    .select('id')
    .not('deletion_requested_at', 'is', null)
    .lt('deletion_requested_at', cutoff);

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 });
  }

  let deleted = 0;
  const errors: string[] = [];
  for (const row of (doomed ?? [])) {
    try {
      const { error } = await admin.auth.admin.deleteUser(row.id);
      if (error) {
        errors.push(`${row.id}: ${error.message}`);
      } else {
        deleted++;
      }
    } catch (e: any) {
      errors.push(`${row.id}: ${e.message}`);
    }
  }

  return new Response(JSON.stringify({ checked: (doomed ?? []).length, deleted, errors }), {
    headers: { 'Content-Type': 'application/json' }
  });
});
