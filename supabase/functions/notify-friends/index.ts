import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const serviceAccountStr = Deno.env.get('FIREBASE_SERVICE_ACCOUNT') ?? '';
    if (!serviceAccountStr) {
      return new Response(JSON.stringify({ error: 'FIREBASE_SERVICE_ACCOUNT not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const serviceAccount = JSON.parse(serviceAccountStr);
    const projectId = serviceAccount.project_id;

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

    // Find connected friends
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

    // Get FCM tokens
    const { data: tokens } = await supabase
      .from('fcm_tokens')
      .select('token, user_id')
      .in('user_id', friendIds);

    if (!tokens || tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no FCM tokens' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get Firebase access token
    const accessToken = await getFirebaseAccessToken(serviceAccount);

    let sent = 0;
    const errors: string[] = [];

    // Send to each token via FCM V1 API
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
          // Remove expired/invalid tokens
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

    return new Response(JSON.stringify({ sent, total: tokens.length, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
