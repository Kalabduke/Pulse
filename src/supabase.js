import { createClient } from '@supabase/supabase-js';

function safeLocalGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

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
    // For native Android: use Browser plugin to open OAuth,
    // then App plugin to detect when we return to the app
    const { data, error } = await client().auth.signInWithOAuth({
      provider: 'google',
      options: {
        // Deep-link back INTO the app via the custom scheme registered in
        // AndroidManifest.xml — NOT the web app, so the browser hands off
        // the callback to the app instead of opening Pulse on the web.
        redirectTo: 'com.pulse.statusapp://login-callback',
        queryParams: { prompt: 'select_account' },
        skipBrowserRedirect: true
      }
    });
    if (error) throw error;

    const { Browser } = await import('@capacitor/browser');
    const { App }     = await import('@capacitor/app');

    // Open Google OAuth in in-app browser
    await Browser.open({ url: data.url, presentationStyle: 'popover' });

    // Listen for the app to be resumed (after OAuth completes and redirects back)
    return new Promise((resolve, reject) => {
      const listener = App.addListener('appUrlOpen', async (event) => {
        listener.then(l => l.remove()).catch(() => {});
        await Browser.close().catch(() => {});

        const url = event.url || '';
        try {
          // PKCE flow hands back ?code=... ; implicit flow uses #access_token=...
          if (url.includes('code=')) {
            const code = new URL(url).searchParams.get('code') || '';
            const { error: exError } = await client().auth.exchangeCodeForSession(code);
            if (exError) throw exError;
          } else if (url.includes('access_token=')) {
            const hash = url.includes('#') ? url.split('#')[1] : url.split('?')[1] || '';
            const params = new URLSearchParams(hash);
            const accessToken = params.get('access_token') || '';
            const refreshToken = params.get('refresh_token') || '';
            const { error: ssError } = await client().auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken
            });
            if (ssError) throw ssError;
          } else {
            throw new Error('OAuth was cancelled or failed');
          }
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        listener.then(l => l.remove()).catch(() => {});
        Browser.close().catch(() => {}); // don't leave the Custom Tab lingering
        reject(new Error('OAuth timed out'));
      }, 300000);
    });
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
    return { ...(await ensureUsername(newProfile)), email: user.email };
  }

  return { ...(await ensureUsername(profile)), email: user.email };
}

/* ==========================================
   USERNAMES (Telegram-style handles)
   ========================================== */

// Derive a valid username from a display name (lowercase a-z, 0-9, _; 5-32 chars)
function deriveUsername(name) {
  let base = (name || 'user').toLowerCase().replace(/[^a-z0-9_]+/g, '');
  if (!base) base = 'user';
  while (base.length < 5) base += 'x';
  return base.slice(0, 32);
}

// Claim/change my username. Uniqueness is enforced server-side by the
// set_my_username RPC (case-insensitive unique index on lower(username)).
export async function setMyUsername(newUsername) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');
  const { data, error } = await client().rpc('set_my_username', { new_username: newUsername });
  if (error) throw new Error(error.message || 'Could not update username.');
  return data;
}

// User tapped "Skip for now" on the username onboarding modal — persist it so
// the modal doesn't reappear on every app launch.
export async function markUsernameSkipped() {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');
  const { error } = await client()
    .from('profiles')
    .update({ skip_username: true, updated_at: new Date().toISOString() })
    .eq('id', user.id);
  if (error) throw new Error(error.message || 'Could not save preference.');
}

// Best-effort: make sure my profile has a username (auto-claim from display
// name if the backfill hasn't run yet). Mirrors the SQL next_username() by
// retrying with a numeric suffix when the base name is taken. Never blocks.
export async function ensureUsername(profile) {
  if (!profile) return profile;
  if (profile.username) return profile;
  const base = deriveUsername(profile.name || 'user');
  try {
    const username = await setMyUsername(base);
    return { ...profile, username };
  } catch {
    // Base name taken — try kalab → kalab2 → kalab3 …
    for (let i = 2; i < 100; i++) {
      try {
        const candidate = `${base.slice(0, 30)}${i}`.slice(0, 32);
        const username = await setMyUsername(candidate);
        return { ...profile, username };
      } catch { /* keep trying next suffix */ }
    }
    return profile;
  }
}

// Fast availability check — uses the username_taken RPC backed by the
// lower(username) unique index (O(1) indexed lookup, no table scan). Falls
// back to an ilike query only if the RPC doesn't exist yet.
export async function isUsernameTaken(username) {
  const clean = (username || '').trim().replace(/^@/, '').toLowerCase();
  if (!clean) return false;
  try {
    const { data, error } = await client().rpc('username_taken', { candidate: clean });
    if (!error && typeof data === 'boolean') return data;
  } catch { /* RPC missing — fall through */ }
  const { data: rows } = await client()
    .from('profiles')
    .select('id')
    .ilike('username', clean)
    .limit(1);
  return Array.isArray(rows) && rows.length > 0;
}

// Fast exact-username profile lookup — indexed RPC, single row. Falls back to
// a direct query if the RPC isn't deployed yet.
export async function findByUsername(candidate) {
  const clean = (candidate || '').trim().replace(/^@/, '');
  if (!clean) return null;
  try {
    const { data, error } = await client().rpc('find_by_username', { candidate: clean });
    if (!error && data && data.length > 0) return data[0];
    if (!error) return null;
  } catch { /* RPC missing — fall through */ }
  const { data } = await client()
    .from('profiles')
    .select('id, name, username')
    .ilike('username', clean)
    .limit(1);
  return data && data.length > 0 ? data[0] : null;
}

/* ==========================================
   IMAGE UPLOAD
   ========================================== */

export async function uploadStatusImage(file) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  // If file was processed by Cloudinary, the URL is already set — use it directly
  if (file._cloudinaryUrl) {
    console.log('[Pulse] Using Cloudinary URL:', file._cloudinaryUrl);
    return file._cloudinaryUrl;
  }

  const fileExt = file.name.split('.').pop().toLowerCase();
  const fileName = `${user.id}/${Date.now()}.${fileExt}`;
  const filePath = `statuses/${fileName}`;

  const isVideo = file.type.startsWith('video/') ||
    ['mov', 'mp4', 'webm', 'avi', 'mkv', 'm4v', '3gp'].includes(fileExt);

  const contentType = file.type ||
    (fileExt === 'mp4'  ? 'video/mp4'  :
     fileExt === 'webm' ? 'video/webm' :
     fileExt === 'mov'  ? 'video/quicktime' :
     fileExt === 'jpg' || fileExt === 'jpeg' ? 'image/jpeg' :
     fileExt === 'png'  ? 'image/png'  :
     'application/octet-stream');

  const { error: uploadError } = await client()
    .storage
    .from('pulse-images')
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
      contentType
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

export async function updateStatus(name, emoji, text, imageUrl = null, mediaType = 'image') {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

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
      status_media_type: mediaType,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;

  // Log to history — try with media_type, fall back without it
  const historyRow = { user_id: user.id, status_emoji: emoji, status_text: text, status_image_url: imageUrl };
  client().from('status_history').insert({ ...historyRow, status_media_type: mediaType })
    .then(({ error: e1 }) => {
      if (e1) {
        // Retry without status_media_type in case column doesn't exist
        client().from('status_history').insert(historyRow)
          .then(({ error: e2 }) => {
            if (e2) console.warn('[Pulse] History log failed:', e2.message);
          });
      }
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
      viewer_nickname,
      friend_name_snapshot,
      created_at,
      user_id,
      friend_id,
      sender:profiles!connections_user_id_fkey(id, name, username, status_emoji, status_text, status_image_url, updated_at, last_seen),
      receiver:profiles!connections_friend_id_fkey(id, name, username, status_emoji, status_text, status_image_url, updated_at, last_seen)
    `)
    .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);

  if (!res1.error && res1.data) {
    data = res1.data;
  } else {
    // Fallback without explicit constraint names
    const res2 = await client()
      .from('connections')
      .select('id, status, nickname, viewer_nickname, friend_name_snapshot, created_at, user_id, friend_id')
      .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);

    if (res2.error) throw res2.error;

    const conns = res2.data || [];
    const profileIds = [...new Set(conns.flatMap(c => [c.user_id, c.friend_id]))].filter(Boolean);

    let profilesMap = {};
    if (profileIds.length > 0) {
      const { data: profs } = await client()
        .from('profiles')
        .select('id, name, username, status_emoji, status_text, status_image_url, updated_at, last_seen')
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
      // Single grouped RPC call (function added in supabase_setup.sql) — 1 query instead of scanning rows
      const { data: unreadRows, error: rpcError } = await client().rpc('my_unread_message_counts');
      if (!rpcError && Array.isArray(unreadRows)) {
        unreadRows.forEach(row => {
          if (row.sender) unreadCounts[row.sender] = Number(row.cnt || 0);
        });
      } else {
        // Fallback for older DBs without the function
        const { data: unreadData } = await client()
          .from('messages')
          .select('sender_id')
          .eq('recipient_id', user.id)
          .is('read_at', null)
          .in('sender_id', friendIds)
          .limit(1000);

        if (unreadData) {
          unreadData.forEach(row => {
            unreadCounts[row.sender_id] = (unreadCounts[row.sender_id] || 0) + 1;
          });
        }
      }
    } catch (e) {
      console.warn('[Pulse] Unread count query notice:', e.message);
    }
  }

  const mapped = (data || []).map(conn => {
    const isSender = conn.sender?.id === user.id || conn.user_id === user.id;
    const friend = isSender ? conn.receiver : conn.sender;
    const friendId = isSender ? (conn.receiver?.id || conn.friend_id) : (conn.sender?.id || conn.user_id);

    // viewer_nickname: only read from YOUR owned row (where user_id = you)
    const myNickname = isSender ? (conn.viewer_nickname || conn.nickname || null) : null;
    const friendName = friend?.name || 'Unknown';

    return {
      connectionId: conn.id,
      status: conn.status,
      isOutgoing: isSender,
      isSender,
      nickname: myNickname,
      friendId,
      name: friendName,
      displayName: myNickname?.trim() || friendName,
      username: friend?.username || null,
      createdAt: conn.created_at,
      statusEmoji: friend?.status_emoji || '😊',
      statusText: friend?.status_text || 'Available',
      statusImageUrl: friend?.status_image_url || null,
      statusMediaType: friend?.status_media_type || 'image',
      updatedAt: friend?.updated_at,
      lastSeen: friend?.last_seen,
      unreadCount: unreadCounts[friendId] || 0
    };
  });

  // Dedup: when both A→B and B→A rows exist, prefer the one where isSender=true
  // (our owned row) because it has our viewer_nickname. Keep only one entry per friendId.
  const seen = new Map();
  for (const conn of mapped) {
    if (!conn.friendId) continue;
    const existing = seen.get(conn.friendId);
    if (!existing) {
      seen.set(conn.friendId, conn);
    } else if (conn.isSender && !existing.isSender) {
      // Our owned row — use it (has our nickname)
      seen.set(conn.friendId, { ...conn, unreadCount: existing.unreadCount || conn.unreadCount });
    }
    // If existing is already isSender, keep it
  }

  return Array.from(seen.values());
}

export async function sendConnectionRequest(friendIdOrName) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const query = friendIdOrName.trim().replace(/^@/, '');
  if (!query) throw new Error('Please enter a @username or display name.');
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

  // 1) Exact UUID (legacy Pulse IDs still work)
  if (uuidRegex.test(query)) {
    const { data } = await client()
      .from('profiles')
      .select('id, name, username')
      .eq('id', query)
      .limit(1);
    if (data && data.length > 0) friendProfile = data[0];
  }

  // 2) Exact username (case-insensitive) — Telegram-style @handle, indexed RPC
  if (!friendProfile && /^[a-z0-9_]{5,32}$/i.test(query)) {
    friendProfile = await findByUsername(query);
  }

  // 3) Fallback: display-name search
  if (!friendProfile) {
    const { data } = await client()
      .from('profiles')
      .select('id, name, username')
      .ilike('name', `%${query}%`)
      .limit(1);
    if (data && data.length > 0) friendProfile = data[0];
  }

  if (!friendProfile) {
    throw new Error("Friend not found. Check their @username or display name.");
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
    .insert({
      user_id: user.id,
      friend_id: friendProfile.id,
      status: 'pending',
      friend_name_snapshot: friendProfile.name   // snapshot at invite time
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function setConnectionNickname(connectionId, nickname, friendId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const trimmed = nickname?.trim() || null;

  // Step 1: Try to update a row we own directly
  const { data: owned } = await client()
    .from('connections')
    .update({ viewer_nickname: trimmed })
    .eq('id', connectionId)
    .eq('user_id', user.id)
    .select()
    .maybeSingle();

  if (owned) return owned;

  // Step 2: We don't own that row — upsert our own reverse row using friendId
  // friendId is passed from the card button (the other person's profile id)
  if (!friendId) throw new Error('Could not save nickname — missing friend ID.');

  const { data, error } = await client()
    .from('connections')
    .upsert({
      user_id: user.id,
      friend_id: friendId,
      status: 'connected',
      viewer_nickname: trimmed
    }, { onConflict: 'user_id,friend_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function acceptInvitation(connectionId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { data: conn, error: connErr } = await client()
    .from('connections')
    .select('user_id, friend_id')
    .eq('id', connectionId)
    .single();

  if (connErr) throw connErr;

  // Mark the original row as connected
  const { data, error } = await client()
    .from('connections')
    .update({ status: 'connected' })
    .eq('id', connectionId)
    .select()
    .single();

  if (error) throw error;

  // Create a reverse row so the acceptor also owns a row and can store their own nickname
  // Use upsert so it's safe to run multiple times
  await client()
    .from('connections')
    .upsert({
      user_id: user.id,
      friend_id: conn.user_id,
      status: 'connected'
    }, { onConflict: 'user_id,friend_id' });

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
   LIVE LOCATION SHARING
   ========================================== */

export async function startLocationShare(toUserIds, latitude, longitude) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  // Upsert a row for each selected recipient
  const rows = toUserIds.map(toId => ({
    from_user_id: user.id,
    to_user_id: toId,
    latitude,
    longitude,
    is_active: true,
    updated_at: new Date().toISOString()
  }));

  const { error } = await client()
    .from('location_shares')
    .upsert(rows, { onConflict: 'from_user_id,to_user_id' });

  if (error) throw error;
}

export async function updateLocationShare(latitude, longitude) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) return;

  await client()
    .from('location_shares')
    .update({ latitude, longitude, updated_at: new Date().toISOString() })
    .eq('from_user_id', user.id)
    .eq('is_active', true);
}

export async function stopLocationShare(toUserIds = null) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) return;

  let query = client()
    .from('location_shares')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('from_user_id', user.id);

  if (toUserIds && toUserIds.length > 0) {
    query = query.in('to_user_id', toUserIds);
  }

  await query;
}

export async function fetchActiveLocationShares() {
  // Fetch locations being shared TO the current user (from friends)
  const { data: { user } } = await client().auth.getUser();
  if (!user) return [];

  const { data, error } = await client()
    .from('location_shares')
    .select('from_user_id, latitude, longitude, updated_at')
    .eq('to_user_id', user.id)
    .eq('is_active', true);

  if (error) return [];
  return data || [];
}

export async function fetchMyActiveShares() {
  // Fetch who I'm currently sharing my location with
  const { data: { user } } = await client().auth.getUser();
  if (!user) return [];

  const { data, error } = await client()
    .from('location_shares')
    .select('to_user_id')
    .eq('from_user_id', user.id)
    .eq('is_active', true);

  if (error) return [];
  return (data || []).map(r => r.to_user_id);
}

export async function clearOutgoingPrivateStatuses() {
  const { data: { user } } = await client().auth.getUser();
  if (!user) return;

  await client()
    .from('private_statuses')
    .delete()
    .eq('from_user_id', user.id);
}

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

  // Do NOT log private statuses to status_history —
  // history is visible to ALL connected friends, which would leak the private status
  // The recipient sees it on their friend card with the 🔒 Private badge instead

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

export async function sendDirectMessage(recipientId, text, imageUrl = null, replyToId = null) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');
  if (!recipientId) throw new Error('Recipient is required.');
  if (!text?.trim() && !imageUrl) throw new Error('Message cannot be empty.');
  if (text && text.length > 500) throw new Error('Message too long. Max 500 characters.');

  const { data, error } = await client()
    .from('messages')
    .insert({
      sender_id:    user.id,
      recipient_id: recipientId,
      content_text: text,
      image_url:    imageUrl,
      reply_to_id:  replyToId || null
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function fetchDirectMessages(friendId, limit = 50) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { data, error } = await client()
    .from('messages')
    .select('*, reply:reply_to_id(id, content_text, image_url, sender_id)')
    .or(`and(sender_id.eq.${user.id},recipient_id.eq.${friendId}),and(sender_id.eq.${friendId},recipient_id.eq.${user.id})`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  // Return in ascending order for display
  return (data || []).reverse();
}

export async function markMessagesAsRead(friendId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  // Reading implies the message was also delivered — set both timestamps
  const now = new Date().toISOString();
  const { error } = await client()
    .from('messages')
    .update({ read_at: now, delivered_at: now })
    .eq('recipient_id', user.id)
    .eq('sender_id', friendId)
    .is('read_at', null);

  if (error) throw error;
}

// Mark messages from a friend as delivered (their device received them via
// realtime) even when the chat isn't open — gives the sender the ✓✓ receipt
// without them having to read.
export async function markMessagesAsDelivered(friendId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { error } = await client()
    .from('messages')
    .update({ delivered_at: new Date().toISOString() })
    .eq('recipient_id', user.id)
    .eq('sender_id', friendId)
    .is('delivered_at', null);

  if (error) throw error;
}

// Delete one of your own messages. RLS enforces sender-only deletes.
export async function deleteDirectMessage(messageId) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');

  const { error } = await client()
    .from('messages')
    .delete()
    .eq('id', messageId)
    .eq('sender_id', user.id);

  if (error) throw error;
}

// Full-history text search inside one conversation (DB-side ILIKE).
// Returns matches oldest-first for display.
export async function searchDirectMessages(friendId, query, limit = 30) {
  const { data: { user } } = await client().auth.getUser();
  if (!user) throw new Error('Not logged in.');
  if (!query || !query.trim()) return [];

  const { data, error } = await client()
    .from('messages')
    .select('*, reply:reply_to_id(id, content_text, image_url, sender_id)')
    .or(`and(sender_id.eq.${user.id},recipient_id.eq.${friendId}),and(sender_id.eq.${friendId},recipient_id.eq.${user.id})`)
    .ilike('content_text', `%${query.trim()}%`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).reverse();
}

// Toggle an emoji reaction on a message. Backed by the security-definer RPC
// toggle_message_reaction (participant-checked). Returns the new reactions map
// ({"👍": ["user-uuid", ...]}) or null on failure.
export async function toggleMessageReaction(messageId, emoji) {
  if (!messageId || !emoji) return null;
  try {
    const { data, error } = await client().rpc('toggle_message_reaction', {
      target_message_id: messageId,
      reaction_emoji: emoji
    });
    if (error) {
      console.warn('[Pulse] Reaction toggle failed:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.warn('[Pulse] Reaction toggle error:', e.message);
    return null;
  }
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

// Push a DM notification to a friend via the notify-friends edge function
// (fires when their app is closed/backgrounded — in-app uses realtime instead)
export async function notifyFriendOfMessage(recipientId, senderName, emoji, messageText, imageUrl = null) {
  try {
    const supabaseUrl = localStorage.getItem('pulse_supabase_url')
      || import.meta.env.VITE_SUPABASE_URL;

    const { data: { session } } = await client().auth.getSession();
    const token = session?.access_token;
    if (!token || !recipientId) return;

    await fetch(`${supabaseUrl}/functions/v1/notify-friends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        type: 'message',
        recipientId,
        name: senderName,
        emoji,
        messageText: (messageText || '').slice(0, 300),
        imageUrl: imageUrl || null
      })
    });
  } catch (err) {
    console.warn('[Pulse] DM push notification failed:', err.message);
  }
}

/* ==========================================
   TYPING INDICATORS
   ========================================== */

export async function setTypingStatus(friendId, typing) {
  const { data: { user } } = await client().auth.getUser();
  if (!user || !friendId) return;
  try {
    if (typing) {
      await client()
        .from('typing_statuses')
        .upsert({
          from_user_id: user.id,
          to_user_id: friendId,
          updated_at: new Date().toISOString()
        }, { onConflict: 'from_user_id,to_user_id' });
    } else {
      await client()
        .from('typing_statuses')
        .delete()
        .eq('from_user_id', user.id)
        .eq('to_user_id', friendId);
    }
  } catch (e) {
    // Table may not exist yet on older projects — typing is best-effort
  }
}

/* ==========================================
   STORAGE CLEANUP (free-tier bucket protection)
   ========================================== */

// Delete a previously-uploaded status image from the bucket. Called when a user
// replaces/removes their status photo so the 1GB free bucket doesn't fill up.
export async function deleteStatusImage(url) {
  if (!url || !url.includes('/storage/v1/object/public/pulse-images/')) return;
  try {
    const marker = '/storage/v1/object/public/pulse-images/';
    const path = url.split(marker)[1]?.split('?')[0];
    if (path) await client().storage.from('pulse-images').remove([path]);
  } catch (e) {
    console.warn('[Pulse] Old status image cleanup failed:', e.message);
  }
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

    // Send the user's own access token so the edge function can verify identity
    const { data: { session } } = await client().auth.getSession();
    const token = session?.access_token;
    if (!token) return;

    await fetch(`${supabaseUrl}/functions/v1/notify-friends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ userId, name, emoji, statusText })
    });
  } catch (err) {
    console.warn('[Pulse] Push notification failed:', err.message);
  }
}

export function subscribeToPulseSync(userId, callback, friendIds = []) {
  if (!isSupabaseConfigured()) return null;

  // Only receive profile updates for ourselves + connected friends — otherwise
  // every user's heartbeat floods every client's channel (free-tier realtime dies).
  const profileIds = friendIds.length ? [userId, ...friendIds] : [userId];

  return client()
    .channel(`pulse-sync-${userId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=in.(${profileIds.join(',')})` },
      (payload) => {
        callback({ type: 'profile_updated', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'connections', filter: `or=(user_id=eq.${userId},friend_id=eq.${userId})` },
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
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `or=(sender_id=eq.${userId},recipient_id=eq.${userId})` },
      (payload) => {
        // Read/delivered receipts + reactions on messages I sent OR received —
        // the client patches the bubble in place (no full chat reload)
        callback({ type: 'message_updated', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'messages', filter: `or=(sender_id=eq.${userId},recipient_id=eq.${userId})` },
      (payload) => {
        // A message in one of my conversations was deleted — remove it in place
        callback({ type: 'message_deleted', record: payload.old });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'private_statuses', filter: `to_user_id=eq.${userId}` },
      (payload) => {
        callback({ type: 'private_status_updated', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'location_shares', filter: `to_user_id=eq.${userId}` },
      (payload) => {
        callback({ type: 'location_updated', record: payload.new });
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'typing_statuses', filter: `to_user_id=eq.${userId}` },
      (payload) => {
        callback({
          type: 'typing_updated',
          eventType: payload.eventType,
          record: payload.new || payload.old
        });
      }
    )
    .subscribe((status) => {
      console.log('[Pulse] Realtime channel status:', status);
    });
}