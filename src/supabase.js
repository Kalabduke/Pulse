import { createClient } from '@supabase/supabase-js';

let supabase = null;

export function initSupabase(url = null, anonKey = null) {
  const configUrl = url
    || localStorage.getItem('pulse_supabase_url')
    || import.meta.env.VITE_SUPABASE_URL;
  const configKey = anonKey
    || localStorage.getItem('pulse_supabase_anon_key')
    || import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!configUrl || !configKey) return false;

  if (url && anonKey) {
    localStorage.setItem('pulse_supabase_url', url);
    localStorage.setItem('pulse_supabase_anon_key', anonKey);
  }

  try {
    supabase = createClient(configUrl, configKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
    return true;
  } catch (err) {
    console.error('[Pulse] Failed to initialize Supabase:', err);
    return false;
  }
}

export function isSupabaseConfigured() {
  if (supabase) return true;
  return initSupabase();
}

export function resetSupabaseConfig() {
  localStorage.removeItem('pulse_supabase_url');
  localStorage.removeItem('pulse_supabase_anon_key');
  supabase = null;
}

export function client() {
  if (!supabase && !initSupabase()) {
    throw new Error('Supabase is not configured.');
  }
  return supabase;
}

/* ==========================================
   AUTHENTICATION
   ========================================== */

export async function signInWithPassword(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUpWithPassword(email, password, name) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: {
      data: { name },
      emailRedirectTo: window.location.origin
    }
  });
  if (error) throw error;
  return data;
}

export async function signInWithGoogle() {
  const isNative = window.Capacitor?.isNativePlatform();
  if (isNative) {
    const { data, error } = await client().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: 'https://pulse-gray-eight.vercel.app',
        queryParams: { prompt: 'select_account' }
      }
    });
    if (error) throw error;
    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: data.url });
    return data;
  } else {
    const { data, error } = await client().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        queryParams: { prompt: 'select_account' }
      }
    });
    if (error) throw error;
    return data;
  }
}

export async function sendPasswordReset(email) {
  const { error } = await client().auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?reset=true`
  });
  if (error) throw error;
}

export async function signOutUser() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}

export async function getSessionAndProfile(savedHash = '', savedSearch = '') {
  let { data: { session }, error: sessionError } = await client().auth.getSession();
  if (sessionError) throw sessionError;

  if (!session && savedHash && savedHash.includes('access_token')) {
    const hashParams = new URLSearchParams(savedHash.substring(1));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    if (accessToken) {
      const { data, error } = await client().auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken || ''
      });
      if (!error && data.session) session = data.session;
    }
  }

  const code = new URLSearchParams(savedSearch).get('code');
  if (code) {
    const { data, error } = await client().auth.exchangeCodeForSession(code);
    if (!error && data.session) session = data.session;
  }

  if (!session) return null;
  const user = session.user;

  const { data: profile, error: profileError } = await client()
    .from('profiles')
    .select('*, last_seen')
    .eq('id', user.id)
    .single();

  if (profileError) {
    const { data: newProfile, error: insertError } = await client()
      .from('profiles')
      .upsert({
        id: user.id,
        name: user.user_metadata?.full_name || user.user_metadata?.name || user.email.split('@')[0],
        status_emoji: '👋',
        status_text: 'Just joined Pulse!',
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .select()
      .single();

    if (insertError) {
      return {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.email.split('@')[0],
        status_emoji: '👋',
        status_text: 'Connecting...',
        updated_at: new Date().toISOString()
      };
    }
    return { ...newProfile, email: user.email };
  }

  return { ...profile, email: user.email };
}

/* ==========================================
   IMAGE UPLOAD
   ========================================== */

export async function uploadStatusImage(file) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const fileExt = file.name.split('.').pop();
  const fileName = `${user.id}/${Date.now()}.${fileExt}`;
  const filePath = `statuses/${fileName}`;

  const { error: uploadError } = await client()
    .storage
    .from('pulse-images')
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false
    });

  if (uploadError) throw uploadError;

  const { data: { publicUrl } } = client()
    .storage
    .from('pulse-images')
    .getPublicUrl(filePath);

  return publicUrl;
}

/* ==========================================
   STATUS & PROFILES
   ========================================== */

export async function updateStatus(name, emoji, text, imageUrl = null) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  // Server-side validation
  if (!name || typeof name !== 'string') throw new Error('Display name is required.');
  if (name.length > 50) throw new Error('Display name must be 50 characters or less.');
  if (text && text.length > 60) throw new Error('Status text must be 60 characters or less.');
  if (!emoji || typeof emoji !== 'string') throw new Error('Emoji is required.');

  const { data, error } = await client()
    .from('profiles')
    .upsert({
      id: user.id,
      name,
      status_emoji: emoji,
      status_text: text,
      status_image_url: imageUrl,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;

  client()
    .from('status_history')
    .insert({
      user_id: user.id,
      status_emoji: emoji,
      status_text: text,
      status_image_url: imageUrl
    })
    .then(({ error: histErr }) => {
      if (histErr) console.warn('[Pulse] History log failed:', histErr.message);
    });

  return data;
}

export async function fetchFriendsStatusHistory(connectedFriendIds) {
  if (!connectedFriendIds || connectedFriendIds.length === 0) return [];

  const { data, error } = await client()
    .from('status_history')
    .select(`
      id,
      status_emoji,
      status_text,
      status_image_url,
      created_at,
      profile:profiles!status_history_user_id_fkey(id, name)
    `)
    .in('user_id', connectedFriendIds)
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) throw error;
  return data || [];
}

/* ==========================================
   CONNECTIONS (with unread counts + last_seen)
   ========================================== */

export async function fetchConnections() {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  let data = null;

  // Try fetching with explicit foreign key hints first
  const res1 = await client()
    .from('connections')
    .select(`
      id,
      status,
      nickname,
      created_at,
      user_id,
      friend_id,
      sender:profiles!connections_user_id_fkey(id, name, status_emoji, status_text, status_image_url, updated_at, last_seen),
      receiver:profiles!connections_friend_id_fkey(id, name, status_emoji, status_text, status_image_url, updated_at, last_seen)
    `)
    .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);

  if (!res1.error && res1.data) {
    data = res1.data;
  } else {
    // Fallback without explicit constraint names
    const res2 = await client()
      .from('connections')
      .select('id, status, nickname, created_at, user_id, friend_id')
      .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);

    if (res2.error) throw res2.error;

    const conns = res2.data || [];
    const profileIds = [...new Set(conns.flatMap(c => [c.user_id, c.friend_id]))].filter(Boolean);

    let profilesMap = {};
    if (profileIds.length > 0) {
      const { data: profs } = await client()
        .from('profiles')
        .select('id, name, status_emoji, status_text, status_image_url, updated_at, last_seen')
        .in('id', profileIds);

      if (profs) {
        profs.forEach(p => { profilesMap[p.id] = p; });
      }
    }

    data = conns.map(c => ({
      ...c,
      sender: profilesMap[c.user_id],
      receiver: profilesMap[c.friend_id]
    }));
  }

  const friendIds = (data || []).map(conn => {
    const isSender = conn.sender?.id === user.id || conn.user_id === user.id;
    return isSender ? (conn.receiver?.id || conn.friend_id) : (conn.sender?.id || conn.user_id);
  }).filter(Boolean);

  const unreadCounts = {};
  if (friendIds.length > 0) {
    try {
      const { data: unreadData } = await client()
        .from('messages')
        .select('sender_id')
        .eq('recipient_id', user.id)
        .is('read_at', null)
        .in('sender_id', friendIds);

      if (unreadData) {
        unreadData.forEach(row => {
          unreadCounts[row.sender_id] = (unreadCounts[row.sender_id] || 0) + 1;
        });
      }
    } catch (e) {
      console.warn('[Pulse] Unread count query notice:', e.message);
    }
  }

  return (data || []).map(conn => {
    const isSender = conn.sender?.id === user.id || conn.user_id === user.id;
    const friend = isSender ? conn.receiver : conn.sender;
    const friendId = isSender ? (conn.receiver?.id || conn.friend_id) : (conn.sender?.id || conn.user_id);
    const nickname = conn.nickname || null;

    return {
      connectionId: conn.id,
      status: conn.status,
      isOutgoing: isSender,
      nickname,
      friendId,
      name: friend?.name || 'Unknown',
      displayName: nickname?.trim() || friend?.name || 'Unknown',
      statusEmoji: friend?.status_emoji || '😊',
      statusText: friend?.status_text || 'Available',
      statusImageUrl: friend?.status_image_url || null,
      updatedAt: friend?.updated_at,
      lastSeen: friend?.last_seen,
      unreadCount: unreadCounts[friendId] || 0
    };
  });
}

export async function sendConnectionRequest(friendIdOrName) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const query = friendIdOrName.trim();
  if (!query) throw new Error('Please enter a Pulse ID or display name.');
  if (query.toLowerCase() === user.id.toLowerCase()) {
    throw new Error("You can't connect with yourself!");
  }

  const existing = await fetchConnections();
  const activeCount = existing.filter(c => c.status === 'connected').length;
  if (activeCount >= 5) {
    throw new Error('MVP limit: You can only have up to 5 connections.');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let friendProfile = null;

  if (uuidRegex.test(query)) {
    const { data } = await client()
      .from('profiles')
      .select('id, name')
      .eq('id', query)
      .limit(1);
    if (data && data.length > 0) friendProfile = data[0];
  } else {
    const { data } = await client()
      .from('profiles')
      .select('id, name')
      .ilike('name', `%${query}%`)
      .limit(1);
    if (data && data.length > 0) friendProfile = data[0];
  }

  if (!friendProfile) {
    throw new Error("Friend not found. Check their Pulse ID or display name.");
  }
  if (friendProfile.id === user.id) {
    throw new Error("You can't connect with yourself!");
  }

  const duplicate = existing.find(c => c.friendId === friendProfile.id);
  if (duplicate) {
    throw new Error(`You already have a ${duplicate.status} connection with this person.`);
  }

  const { data, error } = await client()
    .from('connections')
    .insert({ user_id: user.id, friend_id: friendProfile.id, status: 'pending' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setConnectionNickname(connectionId, nickname) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  // RLS allows both user_id and friend_id to update the row
  // We only update the nickname field — this is safe for both sender and receiver
  const { data, error } = await client()
    .from('connections')
    .update({ nickname: nickname?.trim() || null })
    .eq('id', connectionId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function acceptInvitation(connectionId) {
  const { data, error } = await client()
    .from('connections')
    .update({ status: 'connected' })
    .eq('id', connectionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeConnection(connectionId) {
  const { error } = await client()
    .from('connections')
    .delete()
    .eq('id', connectionId);
  if (error) throw error;
}

/* ==========================================
   PRIVATE STATUSES (per-friend status overrides)
   ========================================== */

export async function upsertPrivateStatus(toUserId, emoji, text, imageUrl = null) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { data, error } = await client()
    .from('private_statuses')
    .upsert({
      from_user_id: user.id,
      to_user_id: toUserId,
      status_emoji: emoji,
      status_text: text || '',
      status_image_url: imageUrl,
      updated_at: new Date().toISOString()
    }, { onConflict: 'from_user_id,to_user_id' })
    .select()
    .single();

  if (error) throw error;

  // Log to status_history — awaited so we know it worked
  // The recipient can read this via RLS because they are a connected friend
  const { error: histErr } = await client()
    .from('status_history')
    .insert({
      user_id: user.id,
      status_emoji: emoji,
      status_text: text || '',
      status_image_url: imageUrl
    });

  if (histErr) console.warn('[Pulse] Private status history log failed:', histErr.message);

  return data;
}

// Fetch all private statuses sent TO the current user (from any friend)
export async function fetchPrivateStatusesForMe() {
  const { data: { user } } = await client().auth.getUser();
  if (!user) return { received: [], sent: [] };

  const [receivedRes, sentRes] = await Promise.all([
    client()
      .from('private_statuses')
      .select('from_user_id, to_user_id, status_emoji, status_text, status_image_url, updated_at')
      .eq('to_user_id', user.id),
    client()
      .from('private_statuses')
      .select('from_user_id, to_user_id, status_emoji, status_text, status_image_url, updated_at')
      .eq('from_user_id', user.id)
  ]);

  return {
    received: receivedRes.data || [],
    sent: sentRes.data || []
  };
}

export async function sendDirectMessage(recipientId, text, imageUrl = null) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');
  if (!recipientId) throw new Error('Recipient is required.');
  if (!text?.trim() && !imageUrl) throw new Error('Message cannot be empty.');
  if (text && text.length > 500) throw new Error('Message too long. Max 500 characters.');

  const { data, error } = await client()
    .from('messages')
    .insert({
      sender_id: user.id,
      recipient_id: recipientId,
      content_text: text,
      image_url: imageUrl
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function fetchDirectMessages(friendId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { data, error } = await client()
    .from('messages')
    .select('*')
    .or(`and(sender_id.eq.${user.id},recipient_id.eq.${friendId}),and(sender_id.eq.${friendId},recipient_id.eq.${user.id})`)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function markMessagesAsRead(friendId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { error } = await client()
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', user.id)
    .eq('sender_id', friendId)
    .is('read_at', null);

  if (error) throw error;
}

/* ==========================================
   ONLINE PRESENCE HEARTBEAT
   ========================================== */

export async function updateLastSeen() {
  const { data: { user } } = await client().auth.getUser();
  if (!user) return;

  await client()
    .from('profiles')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', user.id);
}

/* ==========================================
   PUSH & REALTIME
   ========================================== */

export async function saveFcmToken(token) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { error } = await client()
    .from('fcm_tokens')
    .upsert({ user_id: user.id, token }, { onConflict: 'token' });

  if (error) throw error;
}

export async function savePushSubscription(subscription) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const subJson = subscription.toJSON();
  const { error } = await client()
    .from('push_subscriptions')
    .upsert({
      user_id: user.id,
      subscription: subJson
    }, { onConflict: 'user_id,endpoint' });

  if (error) throw error;
}

export async function notifyFriendsOfUpdate(userId, name, emoji, statusText) {
  try {
    const supabaseUrl = localStorage.getItem('pulse_supabase_url')
      || import.meta.env.VITE_SUPABASE_URL;
    const anonKey = localStorage.getItem('pulse_supabase_anon_key')
      || import.meta.env.VITE_SUPABASE_ANON_KEY;

    await fetch(`${supabaseUrl}/functions/v1/bright-processor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anonKey}`
      },
      body: JSON.stringify({ userId, name, emoji, statusText })
    });
  } catch (err) {
    console.warn('[Pulse] Push notification failed:', err.message);
  }
}

export function subscribeToPulseSync(userId, callback) {
  if (!isSupabaseConfigured()) return null;

  return client()
    .channel(`pulse-sync-${userId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles' },
      (payload) => {
        callback({ type: 'profile_updated', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'connections' },
      (payload) => {
        callback({
          type: 'connection_changed',
          event: payload.eventType,
          record: payload.new || payload.old
        });
      }
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${userId}` },
      (payload) => {
        callback({ type: 'new_message', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'private_statuses', filter: `to_user_id=eq.${userId}` },
      (payload) => {
        callback({ type: 'private_status_updated', record: payload.new });
      }
    )
    .subscribe((status) => {
      console.log('[Pulse] Realtime channel status:', status);
    });
}