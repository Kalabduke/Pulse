import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Generate a JWT for Firebase service account authentication
async function getFirebaseAccessToken(serviceAccount: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging'
  };

  const encode = (obj: any) => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const signingInput = `${encode(header)}.${encode(payload)}`;

  // Import the private key
  const pemKey = serviceAccount.private_key;
  const pemBody = pemKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    // ---- 1. Verify the caller — only the status owner can trigger pushes ----
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } }
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = await req.json();
    const { userId, emoji, statusText, name } = body;

    // The update must belong to the authenticated caller
    if (!userId || userId !== user.id) {
      return new Response(JSON.stringify({ error: 'userId must match the authenticated user' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ---- 2. Find connected friends ----
    const { data: connections, error: connError } = await supabase
      .from('connections')
      .select('user_id, friend_id')
      .eq('status', 'connected')
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`);

    if (connError) throw connError;

    const friendIds = (connections ?? [])
      .map((c: any) => c.user_id === userId ? c.friend_id : c.user_id)
      .filter((id: string) => id !== userId);

    if (friendIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no friends' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ---- 3. Android FCM push (native app) ----
    const serviceAccountStr = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? '';
    let sent = 0;
    let tokenTotal = 0;
    const errors: string[] = [];
    if (serviceAccountStr) {
      const serviceAccount = JSON.parse(serviceAccountStr);
      const projectId = serviceAccount.project_id;

      const { data: tokens } = await supabase
        .from('fcm_tokens')
        .select('token, user_id')
        .in('user_id', friendIds);

      tokenTotal = tokens?.length ?? 0;
      if (tokens && tokens.length > 0) {
        const accessToken = await getFirebaseAccessToken(serviceAccount);

        for (const { token, user_id } of tokens) {
          try {
            const message = {
              message: {
                token,
                notification: {
                  title: `${emoji || '💫'} ${name || 'A friend'}`,
                  body: `"${statusText || 'Updated their status'}"`
                },
                data: {
                  friendName: name || 'A friend',
                  emoji: emoji || '💫',
                  statusText: statusText || 'Updated their status',
                  url: '/'
                },
                android: {
                  priority: 'high',
                  notification: {
                    channel_id: 'pulse_status',
                    priority: 'high',
                    default_sound: true,
                    default_vibrate_timings: true,
                    icon: 'ic_stat_pulse'
                  }
                }
              }
            };

            const res = await fetch(
              `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(message)
              }
            );

            if (res.ok) {
              sent++;
            } else {
              const err = await res.json();
              if (err.error?.status === 'NOT_FOUND' || err.error?.status === 'INVALID_ARGUMENT') {
                await supabase.from('fcm_tokens').delete()
                  .eq('token', token).eq('user_id', user_id);
              }
              errors.push(err.error?.message || 'Unknown FCM error');
            }
          } catch (e: any) {
            errors.push(e.message);
          }
        }
      }
    }

    // ---- 4. Web push (PWA / browsers) via VAPID ----
    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@pulse.app';
    let webSent = 0;

    if (VAPID_PUBLIC && VAPID_PRIVATE) {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

      const { data: subs } = await supabase
        .from('push_subscriptions')
        .select('subscription, user_id')
        .in('user_id', friendIds);

      const payload = JSON.stringify({
        friendName: name || 'A friend',
        emoji: emoji || '💫',
        statusText: statusText || 'Updated their status',
        url: '/'
      });

      for (const row of (subs ?? [])) {
        try {
          await webpush.sendNotification(row.subscription, payload, { TTL: 3600 });
          webSent++;
        } catch (e: any) {
          // 404/410 → subscription is gone; clean it up
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await supabase.from('push_subscriptions').delete()
              .eq('user_id', row.user_id)
              .eq('subscription->>endpoint', row.subscription?.endpoint ?? '');
          }
          errors.push(e?.body ?? 'Web push error');
        }
      }
    }

    return new Response(JSON.stringify({ sent, total: tokenTotal, webSent, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
