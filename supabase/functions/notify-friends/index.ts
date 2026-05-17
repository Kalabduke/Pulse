import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// @ts-ignore
import webpush from 'https://esm.sh/web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const VAPID_PUBLIC_KEY  = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
    const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const VAPID_SUBJECT     = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@pulse.app';

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = await req.json();
    const { userId, emoji, statusText, name } = body;

    if (!userId) {
      return new Response(JSON.stringify({ error: 'userId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Find all connected friends
    const { data: connections, error: connError } = await supabase
      .from('connections')
      .select('user_id, friend_id')
      .eq('status', 'connected')
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`);

    if (connError) throw connError;

    const friendIds = (connections ?? [])
      .map(c => c.user_id === userId ? c.friend_id : c.user_id)
      .filter(id => id !== userId);

    if (friendIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no friends' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get push subscriptions for all friends
    const { data: subscriptions, error: subError } = await supabase
      .from('push_subscriptions')
      .select('id, subscription')
      .in('user_id', friendIds);

    if (subError) throw subError;
    if (!subscriptions || subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no push subscriptions' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const payload = JSON.stringify({
      friendName: name || 'A friend',
      emoji: emoji || '💫',
      statusText: statusText || 'Updated their status',
      url: '/'
    });

    let sent = 0;
    const errors: string[] = [];

    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub.subscription, payload);
        sent++;
      } catch (err: any) {
        // 410 = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        } else {
          errors.push(`${err.statusCode}: ${err.message}`);
        }
      }
    }

    return new Response(JSON.stringify({ sent, total: subscriptions.length, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
