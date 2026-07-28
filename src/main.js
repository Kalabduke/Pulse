import {
  initSupabase,
  isSupabaseConfigured,
  resetSupabaseConfig,
  signInWithPassword,
  signUpWithPassword,
  signInWithGoogle,
  sendPasswordReset,
  signOutUser,
  getSessionAndProfile,
  updateStatus,
  fetchConnections,
  fetchStatusHistory,
  fetchFriendsStatusHistory,
  sendConnectionRequest,
  setConnectionNickname,
  acceptInvitation,
  removeConnection,
  subscribeToPulseSync,
  savePushSubscription,
  saveFcmToken,
  notifyFriendsOfUpdate,
  uploadStatusImage,
  sendDirectMessage,
  fetchDirectMessages,
  markMessagesAsRead,
  updateLastSeen
} from './supabase.js';

const _savedHash = window.location.hash;
const _savedSearch = window.location.search;
(function cleanUrl() {
  const hasToken = _savedHash && (
    _savedHash.includes('access_token') ||
    _savedHash.includes('type=')
  );
  const hasCode = _savedSearch && new URLSearchParams(_savedSearch).has('code');
  if (hasToken || hasCode) {
    window.history.replaceState(null, '', window.location.pathname);
  }
})();

/* ==========================================
   APP STATE
   ========================================== */
const state = {
  userProfile: null,
  connections: [],
  selectedEmoji: '😊',
  realtimeChannel: null,
  authMode: 'signin',
  clockInterval: null,
  pollInterval: null
};

let currentStatusImage = null;
let currentStatusImageUrl = null;
let currentChatImage = null;
let currentChatFriend = null;

const cache = {
  connections: null,
  connectionsAt: 0,
  TTL: 30000
};

function getCachedConnections() {
  if (cache.connections && Date.now() - cache.connectionsAt < cache.TTL) {
    return cache.connections;
  }
  return null;
}

function setCachedConnections(data) {
  cache.connections = data;
  cache.connectionsAt = Date.now();
}

function invalidateCache() {
  cache.connections = null;
  cache.connectionsAt = 0;
}

/* ==========================================
   ONLINE PRESENCE — 60 SECOND THRESHOLD
   ========================================== */
const ONLINE_THRESHOLD_MS = 60 * 1000;

function isOnline(lastSeenTimestamp) {
  if (!lastSeenTimestamp) return false;
  const diff = Date.now() - new Date(lastSeenTimestamp).getTime();
  return diff < ONLINE_THRESHOLD_MS;
}

function startHeartbeat() {
  updateLastSeen().catch(() => {});
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      updateLastSeen().catch(() => {});
    }
  }, 20000);
}

/* ==========================================
   IMAGE COMPRESSION
   ========================================== */
function compressImage(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ==========================================
   TOAST NOTIFICATIONS
   ========================================== */
let toastTimer = null;

function showToast(text, type = 'success') {
  const toast = document.getElementById('global-toast');
  const textEl = document.getElementById('toast-text');
  const iconEl = document.getElementById('toast-icon');
  if (!toast || !textEl || !iconEl) return;

  textEl.textContent = text;
  iconEl.textContent = type === 'success' ? '✨' : type === 'error' ? '⚠️' : 'ℹ️';

  toast.className = `toast show toast-${type}`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 4000);
}

/* ==========================================
   ROUTING
   ========================================== */
function navigateTo(viewName) {
  const views = {
    config: document.getElementById('config-view'),
    auth: document.getElementById('auth-view'),
    dashboard: document.getElementById('dashboard-view'),
    chat: document.getElementById('chat-view')
  };

  Object.entries(views).forEach(([key, el]) => {
    if (!el) return;
    el.style.display = key === viewName ? 'flex' : 'none';
  });
}

async function checkNavigationState() {
  if (!isSupabaseConfigured()) {
    navigateTo('config');
    return;
  }

  try {
    const profile = await getSessionAndProfile(_savedHash, _savedSearch);

    if (profile) {
      state.userProfile = profile;
      state.selectedEmoji = profile.status_emoji || '😊';
      navigateTo('dashboard');
      setupRealtimeSync();
      await loadDashboardData();
      startSimulatorClock();
      startPollingFallback();
      setTimeout(requestNotificationPermission, 3000);
      registerFCMToken();
      startHeartbeat();
    } else {
      navigateTo('auth');
      setAuthMode('signin');
    }
  } catch (err) {
    console.error('[Pulse] Navigation check error:', err);
    navigateTo('auth');
    setAuthMode('signin');
  }
}

/* ==========================================
   AUTH HELPERS
   ========================================== */
function showAuthError(msg) {
  const box = document.getElementById('auth-error-msg');
  if (!box) return;
  box.textContent = msg;
  box.style.display = 'block';
}

function clearAuthError() {
  const box = document.getElementById('auth-error-msg');
  if (box) box.style.display = 'none';
}

function setAuthMode(mode) {
  state.authMode = mode;

  const tabSignin = document.getElementById('tab-signin');
  const tabSignup = document.getElementById('tab-signup');
  const fieldName = document.getElementById('field-name');
  const fieldConfirm = document.getElementById('field-confirm');
  const linkForgot = document.getElementById('link-forgot');
  const label = document.getElementById('btn-auth-label');
  const passwordInput = document.getElementById('auth-password');

  if (mode === 'signin') {
    tabSignin?.classList.add('active');
    tabSignup?.classList.remove('active');
    if (fieldName) fieldName.style.display = 'none';
    if (fieldConfirm) fieldConfirm.style.display = 'none';
    if (linkForgot) linkForgot.style.display = 'block';
    if (label) label.textContent = 'Sign In';
    if (passwordInput) passwordInput.autocomplete = 'current-password';
  } else {
    tabSignup?.classList.add('active');
    tabSignin?.classList.remove('active');
    if (fieldName) fieldName.style.display = 'flex';
    if (fieldConfirm) fieldConfirm.style.display = 'flex';
    if (linkForgot) linkForgot.style.display = 'none';
    if (label) label.textContent = 'Create Account';
    if (passwordInput) passwordInput.autocomplete = 'new-password';
  }

  clearAuthError();
}

/* ==========================================
   REAL-TIME SYNC
   ========================================== */
function setupRealtimeSync() {
  if (state.realtimeChannel) {
    state.realtimeChannel.unsubscribe();
    state.realtimeChannel = null;
  }

  if (!state.userProfile) return;

  state.realtimeChannel = subscribeToPulseSync(state.userProfile.id, async (change) => {
    if (change.type === 'profile_updated') {
      const updatedId = change.record.id;

      if (updatedId === state.userProfile.id) {
        state.userProfile = { ...state.userProfile, ...change.record };
        updateMyStatusUI();
        updateSimulatorUI();
      } else {
        const isFriend = state.connections.some(
          c => c.friendId === updatedId && c.status === 'connected'
        );
        if (isFriend) {
          const friend = state.connections.find(c => c.friendId === updatedId);
          const displayName = friend?.nickname?.trim() || change.record.name || 'A friend';
          const emoji = change.record.status_emoji || '💫';
          const text = change.record.status_text || 'Updated their status';

          notifyFriendStatusUpdate(displayName, emoji, text);
          showToast(`${emoji} ${displayName} updated their status!`);
          await loadDashboardData();
        }
      }
    } else if (change.type === 'connection_changed') {
      invalidateCache();
      await loadDashboardData();
    } else if (change.type === 'new_message') {
      const msg = change.record;
      if (currentChatFriend && msg.sender_id === currentChatFriend.friendId) {
        await loadChatMessages(currentChatFriend.friendId);
        await markMessagesAsRead(currentChatFriend.friendId);
      } else {
        showToast('New message! 💬');
        invalidateCache();
        await loadDashboardData();
      }
    }
  });
}

/* ==========================================
   DASHBOARD DATA
   ========================================== */
async function loadDashboardData() {
  try {
    const cachedConns = getCachedConnections();

    const [profile, connections] = await Promise.all([
      getSessionAndProfile(_savedHash, _savedSearch),
      cachedConns ? Promise.resolve(cachedConns) : fetchConnections()
    ]);

    if (profile) {
      state.userProfile = profile;
      updateMyStatusUI();
      updateSimulatorUI();
    }

    if (!cachedConns) setCachedConnections(connections);
    state.connections = connections;
    renderFriendsFeed();
    renderPendingInvites();

    const directSelect = document.getElementById('direct-friend-select');
    if (directSelect) {
      directSelect.innerHTML = '<option value="">Select a friend...</option>';
      connections
        .filter(c => c.status === 'connected')
        .forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.friendId;
          opt.textContent = c.displayName;
          directSelect.appendChild(opt);
        });
    }

    const connectedFriendIds = connections
      .filter(c => c.status === 'connected')
      .map(c => c.friendId);

    if (connectedFriendIds.length > 0) {
      fetchFriendsStatusHistory(connectedFriendIds)
        .then(history => renderStatusHistory(history, connections))
        .catch(() => {});
    } else {
      renderStatusHistory([], connections);
    }

  } catch (err) {
    console.error('[Pulse] Dashboard load error:', err);
    showToast('Failed to sync. Check your connection.', 'error');
  }
}

function updateMyStatusUI() {
  if (!state.userProfile) return;

  const myName = document.getElementById('my-name');
  const myAvatar = document.getElementById('my-avatar');
  const myStatusBubble = document.getElementById('my-status-bubble');
  const myStatusImage = document.getElementById('my-status-image');
  const idDisplay = document.getElementById('my-id-display');
  const myDot = document.getElementById('my-pulse-dot');

  if (myName) myName.textContent = state.userProfile.name || 'My Status';
  if (myAvatar) myAvatar.textContent = state.userProfile.status_emoji || '👋';
  if (myStatusBubble) {
    myStatusBubble.textContent = `"${state.userProfile.status_text || 'Available'}"`;
  }
  if (myStatusImage) {
    if (state.userProfile.status_image_url) {
      myStatusImage.src = state.userProfile.status_image_url;
      myStatusImage.style.display = 'block';
    } else {
      myStatusImage.style.display = 'none';
    }
  }
  if (idDisplay) {
    idDisplay.textContent = state.userProfile.id;
    idDisplay.title = 'Click to copy your Pulse ID';
  }
  if (myDot) {
    myDot.className = 'online-pulse-dot';
  }
}

/* ==========================================
   EMOJI PICKER
   ========================================== */
const EMOJI_CATEGORIES = {
  mood: ['😊','😄','😁','🥰','😍','🤩','😎','🥳','😂','🤣','😅','😌','😏','🤔','😐','😑','😶','🙄','😒','😔','😞','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','😈','👿','😱','😨','😰','😥','😓','🤗','🤭','🤫','🤥','😬','🤐','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','🥶','🥵','😴','💤','🤤','😪'],
  health: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','🩺','💊','🩹','🏥','🧬','🦷','🦴','👁️','🫀','🫁','🧠','💪','🦾','🏃','🧘','🛌','😴','🔋','⚡','🌡️','🩻','🧪'],
  activity: ['💻','📱','🎮','🎧','🎵','🎶','📚','✏️','🖊️','🎨','🎭','🎬','📷','🎤','🎸','🥁','🎹','⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🏋️','🤸','🚴','🏊','🧗','🤾','🎯','🎲','♟️','🧩','🚀','✈️','🛸','🔭','🔬','⚗️','🧪','💡','🔧','🛠️','🏆','🥇','🎖️'],
  nature: ['🌿','🌱','🌲','🌳','🌴','🌵','🌾','🍀','🍁','🍂','🍃','🌺','🌸','🌼','🌻','🌹','🌷','💐','🍄','🌊','🌈','⭐','🌟','✨','💫','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','💨','🌪️','🌫️','🌊','🌙','🌛','🌜','🌝','🌞','🪐','🌍','🌎','🌏'],
  food: ['🍕','🍔','🌮','🌯','🥗','🍜','🍝','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🍥','🥮','🍢','🧆','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🥪','🥙','🧀','🥨','🥐','🥖','🍞','🥜','🌰','🍫','🍬','🍭','🍮','🍯','🍰','🎂','🧁','🍩','🍪','☕','🍵','🧃','🥤','🧋','🍺','🍻','🥂','🍷','🥃','🍸','🍹'],
  travel: ['✈️','🚀','🛸','🚁','🛩️','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚌','🚍','🚎','🚐','🚑','🚒','🚓','🚔','🚕','🚖','🚗','🚘','🚙','🛻','🚚','🚛','🚜','🏎️','🏍️','🛵','🚲','🛴','🛹','🛼','🚏','🛣️','🛤️','⛽','🚦','🚥','🗺️','🧭','🏔️','⛰️','🌋','🗻','🏕️','🏖️','🏜️','🏝️','🏞️','🏟️','🏛️','🗼','🗽','🗿','🏰','🏯','🕌','🕍','⛪','🕋']
};

let currentEmojiCategory = 'mood';

function renderEmojiGrid(category, selectedEmoji) {
  const grid = document.getElementById('emoji-grid');
  if (!grid) return;

  const emojis = EMOJI_CATEGORIES[category] || EMOJI_CATEGORIES.mood;
  grid.innerHTML = emojis.map(e => `
    <button class="emoji-btn ${e === selectedEmoji ? 'active' : ''}" data-emoji="${e}">${e}</button>
  `).join('');

  grid.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectEmoji(btn.dataset.emoji);
    });
  });
}

function selectEmoji(emoji) {
  state.selectedEmoji = emoji;
  const preview = document.getElementById('emoji-preview');
  if (preview) preview.textContent = emoji;
  const customInput = document.getElementById('emoji-custom-input');
  if (customInput) customInput.value = emoji;
  document.querySelectorAll('#emoji-grid .emoji-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.emoji === emoji);
  });
}

function initEmojiPicker() {
  document.getElementById('emoji-category-tabs')?.querySelectorAll('.emoji-cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.emoji-cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentEmojiCategory = tab.dataset.cat;
      renderEmojiGrid(currentEmojiCategory, state.selectedEmoji);
    });
  });

  const customInput = document.getElementById('emoji-custom-input');
  customInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (!val) return;
    const chars = [...val];
    const emoji = chars[0];
    if (emoji) selectEmoji(emoji);
  });

  renderEmojiGrid(currentEmojiCategory, state.selectedEmoji);
}

/* ==========================================
   TIME FORMATTING
   ========================================== */
function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Just now';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const s = Math.floor(diffMs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (s < 10) return 'Just now';
  if (s < 60) return `${s}s ago`;
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
}

/* ==========================================
   FRIENDS FEED RENDERER
   ========================================== */
function renderFriendsFeed() {
  const container = document.getElementById('friends-status-container');
  const counterEl = document.getElementById('connected-count');
  if (!container) return;

  const connected = state.connections.filter(c => c.status === 'connected');
  if (counterEl) counterEl.textContent = `${connected.length}/5`;

  if (connected.length === 0) {
    container.innerHTML = `
      <div class="glass-card empty-state-card">
        <span class="empty-icon">👥</span>
        No connected friends yet. Share your Pulse ID below to start syncing lockscreens in real-time!
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  connected.forEach(friend => {
    const hasImage = friend.statusImageUrl;
    const hasUnread = friend.unreadCount > 0;
    const online = isOnline(friend.lastSeen);
    
    const card = document.createElement('div');
    card.className = 'glass-card user-status-card';
    card.dataset.friendId = friend.friendId;
    card.style.cursor = 'pointer';
    card.style.position = 'relative';
    
    card.innerHTML = `
      <div class="avatar-container" style="position:relative;">
        <span>${friend.statusEmoji || '😊'}</span>
        ${online ? '<span class="online-pulse-dot"></span>' : '<span class="offline-dot"></span>'}
        ${hasUnread ? `<span class="unread-badge">${friend.unreadCount}</span>` : ''}
      </div>
      <div class="status-details" style="flex:1; min-width:0;">
        <div class="status-user-name">
          <span class="friend-display-name">${escapeHtml(friend.nickname?.trim() || friend.name)}</span>
          ${friend.nickname ? `<span class="real-name-tag" title="Real name">${escapeHtml(friend.name)}</span>` : ''}
        </div>
        <div class="status-bubble">"${escapeHtml(friend.statusText || 'Available')}"</div>
        ${hasImage ? `<img src="${friend.statusImageUrl}" class="friend-status-image" alt="Status image" loading="lazy" onclick="event.stopPropagation()">` : ''}
        <div class="status-time">${formatTimeAgo(friend.updatedAt)}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px; align-self: flex-start; flex-shrink: 0;">
        <button class="btn btn-secondary btn-small nickname-btn" data-conn-id="${friend.connectionId}" data-current-nickname="${escapeHtml(friend.nickname || '')}" data-real-name="${escapeHtml(friend.name)}" title="${friend.nickname ? 'Edit nickname' : 'Add nickname'}" style="padding: 4px 8px; font-size: 11px;">${friend.nickname ? '✏️' : '🏷️'}</button>
        <button class="btn btn-secondary btn-small btn-small-danger remove-connection-btn" data-conn-id="${friend.connectionId}" style="padding: 4px 8px; font-size: 11px;">✕</button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.user-status-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      const friendId = card.dataset.friendId;
      const friend = state.connections.find(c => c.friendId === friendId);
      if (friend) openChat(friend);
    });
  });

  container.querySelectorAll('.nickname-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const connId = btn.dataset.connId;
      const currentNickname = btn.dataset.currentNickname;
      const realName = btn.dataset.realName;

      const input = await showNicknameModal({ realName, currentNickname });
      if (input === null) return;

      try {
        await setConnectionNickname(connId, input);
        showToast(input.trim() ? `Nickname set to "${input.trim()}"` : 'Nickname cleared.');
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('.remove-connection-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const connId = btn.dataset.connId;
      const confirmed = await showConfirmModal({
        icon: '💔',
        title: 'Disconnect friend?',
        body: 'They will no longer see your status and you won\'t see theirs.',
        okLabel: 'Disconnect',
        okDanger: true
      });
      if (!confirmed) return;
      try {
        await removeConnection(connId);
        showToast('Friend disconnected.');
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

/* ==========================================
   PENDING INVITES
   ========================================== */
function renderPendingInvites() {
  const container = document.getElementById('pending-invites-container');
  if (!container) return;

  const pending = state.connections.filter(c => c.status === 'pending');

  if (pending.length === 0) {
    container.innerHTML = `
      <div style="font-size: 12px; color: hsl(var(--text-muted)); font-style: italic; padding: 4px 0;">
        No pending requests.
      </div>
    `;
    return;
  }

  container.innerHTML = '';

  pending.forEach(conn => {
    const card = document.createElement('div');
    card.className = 'friend-item';

    if (conn.isOutgoing) {
      card.innerHTML = `
        <div class="friend-item-info">
          <div class="friend-avatar">✉️</div>
          <div class="friend-details">
            <span class="friend-name">${escapeHtml(conn.name)}</span>
            <span class="friend-email">Outgoing invite — waiting for them to accept</span>
          </div>
        </div>
        <div class="friend-actions">
          <button class="btn btn-secondary btn-small btn-small-danger cancel-invite-btn" data-conn-id="${conn.connectionId}">Cancel</button>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="friend-item-info">
          <div class="friend-avatar">🔔</div>
          <div class="friend-details">
            <span class="friend-name">${escapeHtml(conn.name)}</span>
            <span class="friend-email">Wants to connect with you!</span>
          </div>
        </div>
        <div class="friend-actions">
          <button class="btn btn-secondary btn-small btn-small-success accept-invite-btn" data-conn-id="${conn.connectionId}">Accept</button>
          <button class="btn btn-secondary btn-small btn-small-danger cancel-invite-btn" data-conn-id="${conn.connectionId}">Reject</button>
        </div>
      `;
    }

    container.appendChild(card);
  });

  container.querySelectorAll('.accept-invite-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await acceptInvitation(btn.dataset.connId);
        showToast('Connected! You can now see each other\'s status.');
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('.cancel-invite-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await removeConnection(btn.dataset.connId);
        showToast('Invite removed.');
        await loadDashboardData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

/* ==========================================
   STATUS HISTORY
   ========================================== */
function renderStatusHistory(history, connections = []) {
  const container = document.getElementById('status-history-container');
  if (!container) return;

  if (!history || history.length === 0) {
    container.innerHTML = `<div style="font-size: 12px; color: hsl(var(--text-muted)); font-style: italic; padding: 4px 0;">No history yet — connect with friends and their updates will appear here.</div>`;
    return;
  }

  container.innerHTML = history.map(entry => {
    const realName = entry.profile?.name || 'Unknown';
    const conn = connections.find(c => c.friendId === entry.profile?.id);
    const displayName = conn?.nickname?.trim() || realName;
    const hasImage = entry.status_image_url;

    return `
      <div class="history-item">
        <span class="history-emoji">${entry.status_emoji}</span>
        <div class="history-details">
          <span class="history-name">${escapeHtml(displayName)}</span>
          <span class="history-text">"${escapeHtml(entry.status_text)}"</span>
          ${hasImage ? `<img src="${entry.status_image_url}" class="history-image" alt="Status image" loading="lazy">` : ''}
          <span class="history-time">${formatTimeAgo(entry.created_at)}</span>
        </div>
      </div>
    `;
  }).join('');
}

/* ==========================================
   CHAT / DM VIEW
   ========================================== */
async function openChat(friend) {
  currentChatFriend = friend;
  
  document.getElementById('chat-friend-emoji').textContent = friend.statusEmoji;
  document.getElementById('chat-friend-name').textContent = friend.displayName;
  
  document.querySelectorAll('.view-container').forEach(v => v.style.display = 'none');
  const chatView = document.getElementById('chat-view');
  if (chatView) chatView.style.display = 'flex';
  
  await loadChatMessages(friend.friendId);
  await markMessagesAsRead(friend.friendId);
  
  friend.unreadCount = 0;
  renderFriendsFeed();
  
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

async function loadChatMessages(friendId) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '<div class="spinner" style="margin:auto;"></div>';

  try {
    const messages = await fetchDirectMessages(friendId);
    const { data: { user } } = await client().auth.getUser();
    
    if (messages.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));padding:40px 0;">No messages yet. Say hello! 👋</div>';
      return;
    }

    container.innerHTML = messages.map(msg => {
      const isSent = msg.sender_id === user.id;
      const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      return `
        <div class="chat-bubble ${isSent ? 'sent' : 'received'}">
          ${msg.content_text ? `<div>${escapeHtml(msg.content_text)}</div>` : ''}
          ${msg.image_url ? `<img src="${msg.image_url}" alt="Shared image" loading="lazy" onclick="window.open('${msg.image_url}', '_blank')">` : ''}
          <span class="chat-bubble-time">${time}</span>
        </div>
      `;
    }).join('');
    
    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = '<div style="text-align:center;color:hsl(var(--text-muted));">Failed to load messages</div>';
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim() || '';
  const sendBtn = document.getElementById('chat-send-btn');
  
  if (!text && !currentChatImage) return;
  if (!currentChatFriend) return;
  
  sendBtn.disabled = true;
  
  try {
    let imageUrl = null;
    if (currentChatImage) {
      showToast('Uploading image...');
      imageUrl = await uploadStatusImage(currentChatImage);
    }
    
    await sendDirectMessage(currentChatFriend.friendId, text, imageUrl);
    if (input) input.value = '';
    removeChatImage();
    await loadChatMessages(currentChatFriend.friendId);
  } catch (err) {
    showToast(err.message || 'Failed to send', 'error');
  } finally {
    sendBtn.disabled = false;
  }
}

function removeChatImage() {
  currentChatImage = null;
  const preview = document.getElementById('chat-image-preview');
  const img = document.getElementById('chat-preview-img');
  if (preview) preview.style.display = 'none';
  if (img) img.src = '';
  const fileInput = document.getElementById('chat-file-input');
  const camInput = document.getElementById('chat-camera-input');
  if (fileInput) fileInput.value = '';
  if (camInput) camInput.value = '';
}

async function handleChatImage(file) {
  if (!file) return;
  try {
    showToast('Compressing...');
    const compressed = await compressImage(file);
    currentChatImage = compressed;
    const preview = document.getElementById('chat-image-preview');
    const img = document.getElementById('chat-preview-img');
    if (img) img.src = URL.createObjectURL(compressed);
    if (preview) preview.style.display = 'block';
  } catch (err) {
    showToast('Failed to process image', 'error');
  }
}

/* ==========================================
   STATUS IMAGE HANDLERS
   ========================================== */
async function handleStatusImage(file) {
  if (!file) return;
  try {
    showToast('Compressing image...');
    const compressed = await compressImage(file);
    currentStatusImage = compressed;
    const preview = document.getElementById('status-image-preview');
    const img = document.getElementById('status-preview-img');
    if (img) img.src = URL.createObjectURL(compressed);
    if (preview) preview.style.display = 'block';
  } catch (err) {
    showToast('Failed to process image', 'error');
  }
}

function removeStatusImage() {
  currentStatusImage = null;
  currentStatusImageUrl = null;
  const preview = document.getElementById('status-image-preview');
  const img = document.getElementById('status-preview-img');
  if (preview) preview.style.display = 'none';
  if (img) img.src = '';
  const fileInput = document.getElementById('status-file-input');
  const camInput = document.getElementById('status-camera-input');
  if (fileInput) fileInput.value = '';
  if (camInput) camInput.value = '';
}

/* ==========================================
   CUSTOM MODALS
   ========================================== */
function showConfirmModal({ icon = '⚠️', title, body, okLabel = 'Confirm', okDanger = true }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    document.getElementById('confirm-modal-icon').textContent = icon;
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body;
    const okBtn = document.getElementById('confirm-modal-ok');
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${okDanger ? 'btn-danger-solid' : 'btn-primary'}`;

    modal.style.display = 'flex';

    const cleanup = (result) => {
      modal.style.display = 'none';
      okBtn.replaceWith(okBtn.cloneNode(true));
      document.getElementById('confirm-modal-cancel').replaceWith(
        document.getElementById('confirm-modal-cancel').cloneNode(true)
      );
      resolve(result);
    };

    document.getElementById('confirm-modal-ok').addEventListener('click', () => cleanup(true), { once: true });
    document.getElementById('confirm-modal-cancel').addEventListener('click', () => cleanup(false), { once: true });
  });
}

function showNicknameModal({ realName, currentNickname = '' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('nickname-modal');
    document.getElementById('nickname-modal-body').textContent =
      `Give "${realName}" a nickname only you can see. Leave empty to use their real name.`;
    const input = document.getElementById('nickname-modal-input');
    input.value = currentNickname;

    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 100);

    const cleanup = (result) => {
      modal.style.display = 'none';
      resolve(result);
    };

    const saveBtn = document.getElementById('nickname-modal-save');
    const cancelBtn = document.getElementById('nickname-modal-cancel');

    const onSave = () => {
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      cleanup(input.value);
    };
    const onCancel = () => {
      saveBtn.removeEventListener('click', onSave);
      cancelBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      cleanup(null);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') onSave();
      if (e.key === 'Escape') onCancel();
    };

    saveBtn.addEventListener('click', onSave);
    cancelBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

/* ==========================================
   iOS POLLING FALLBACK
   ========================================== */
function startPollingFallback() {
  if (state.pollInterval) clearInterval(state.pollInterval);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  state.pollInterval = setInterval(async () => {
    const channelStatus = state.realtimeChannel?.state;
    if (channelStatus !== 'joined') {
      await loadDashboardData();
    }
  }, isIOS ? 20000 : 45000);

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.userProfile) {
      const now = Date.now();
      if (!startPollingFallback._lastVisible || now - startPollingFallback._lastVisible > 30000) {
        invalidateCache();
        await loadDashboardData();
      }
      startPollingFallback._lastVisible = now;
    } else {
      startPollingFallback._lastVisible = Date.now();
    }
  });
}

/* ==========================================
   SECURITY HELPER
   ========================================== */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================
   PWA — SERVICE WORKER & NOTIFICATIONS
   ========================================== */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('[Pulse] SW registered:', reg.scope))
        .catch(err => console.warn('[Pulse] SW registration failed:', err));
    });
  }
}

async function registerFCMToken() {
  if (!window.Capacitor?.isNativePlatform()) return;

  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    await PushNotifications.requestPermissions();
    await PushNotifications.register();

    PushNotifications.addListener('registration', async (token) => {
      console.log('[Pulse] FCM token:', token.value);
      try {
        const { saveFcmToken } = await import('./supabase.js');
        await saveFcmToken(token.value);
        console.log('[Pulse] FCM token saved');
      } catch (e) {
        console.warn('[Pulse] FCM token save failed:', e.message);
      }
    });

    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('[Pulse] Push received:', notification);
      if (state.userProfile) {
        invalidateCache();
        loadDashboardData();
      }
    });

    PushNotifications.addListener('pushNotificationActionPerformed', () => {
      navigateTo('dashboard');
    });

  } catch (e) {
    console.warn('[Pulse] FCM registration failed:', e.message);
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;

  const dashboard = document.getElementById('dashboard-view');
  if (!dashboard) return;

  const banner = document.createElement('div');
  banner.id = 'notif-banner';
  banner.className = 'notif-banner';
  banner.innerHTML = `
    <span style="font-size: 20px;">🔔</span>
    <div style="flex: 1;">
      <div style="font-weight: 600; font-size: 13px; color: hsl(var(--text-primary));">Enable lockscreen alerts</div>
      <div style="font-size: 11px; color: hsl(var(--text-muted));">Get notified when friends update their status</div>
    </div>
    <span style="font-size: 18px; color: hsl(var(--text-muted));">→</span>
  `;

  banner.addEventListener('click', async () => {
    const permission = await Notification.requestPermission();
    banner.remove();

    if (permission === 'granted') {
      showToast('Lockscreen alerts enabled! 🔔');
      await subscribeToPushNotifications();

      setTimeout(() => {
        new Notification('Pulse is ready! 💫', {
          body: "You'll be notified when friends update their status.",
          icon: '/icon-192.png',
          badge: '/notification-icon.png'
        });
      }, 500);
    }
  });

  const header = dashboard.querySelector('.header');
  if (header) header.insertAdjacentElement('afterend', banner);
}

async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Pulse] Push not supported on this browser');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();

    if (!subscription) {
      const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!VAPID_PUBLIC_KEY) {
        console.warn('[Pulse] VAPID_PUBLIC_KEY not set in env');
        showToast('Notifications enabled (in-app only — VAPID key missing)', 'info');
        return;
      }

      const keyBytes = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes
      });
    }

    await savePushSubscription(subscription);
    console.log('[Pulse] Push subscription saved to Supabase ✓');
  } catch (err) {
    console.error('[Pulse] Push subscription error:', err.message, err);
    showToast('Could not enable background notifications: ' + err.message, 'error');
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function showPersistentStatusNotification(friendName, emoji, statusText) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'FRIEND_STATUS_UPDATE',
      friendName,
      emoji,
      statusText,
      url: '/'
    });
  }

  try {
    new Notification(`${emoji} ${friendName}`, {
      body: `"${statusText}"`,
      icon: '/icon-192.png',
      badge: '/notification-icon.png',
      tag: `pulse-popup-${friendName}`,
      renotify: true,
      silent: false
    });
  } catch (e) {
    console.warn('[Pulse] Direct notification failed:', e.message);
  }
}

function notifyFriendStatusUpdate(friendName, emoji, statusText) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  showPersistentStatusNotification(friendName, emoji, statusText);
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */
function initEventListeners() {

  document.getElementById('btn-save-config')?.addEventListener('click', () => {
    const url = document.getElementById('config-url')?.value.trim();
    const key = document.getElementById('config-key')?.value.trim();

    if (!url || !key) {
      showToast('Please enter both the project URL and anon key.', 'error');
      return;
    }

    if (initSupabase(url, key)) {
      showToast('Supabase connected!');
      checkNavigationState();
    } else {
      showToast('Failed to connect. Check the URL format.', 'error');
    }
  });

  document.getElementById('btn-toggle-key-visibility')?.addEventListener('click', () => {
    const keyInput = document.getElementById('config-key');
    const btn = document.getElementById('btn-toggle-key-visibility');
    if (!keyInput) return;
    const isHidden = keyInput.type === 'password';
    keyInput.type = isHidden ? 'text' : 'password';
    if (btn) btn.textContent = isHidden ? '🙈' : '👁';
  });

  ['config-url', 'config-key'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-save-config')?.click();
    });
  });

  document.getElementById('btn-show-config')?.addEventListener('click', () => {
    navigateTo('config');
  });

  document.getElementById('tab-signin')?.addEventListener('click', () => setAuthMode('signin'));
  document.getElementById('tab-signup')?.addEventListener('click', () => setAuthMode('signup'));

  document.getElementById('btn-toggle-password')?.addEventListener('click', () => {
    const inp = document.getElementById('auth-password');
    const btn = document.getElementById('btn-toggle-password');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    if (btn) btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  });

  document.getElementById('btn-toggle-confirm')?.addEventListener('click', () => {
    const inp = document.getElementById('auth-password-confirm');
    const btn = document.getElementById('btn-toggle-confirm');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    if (btn) btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  });

  document.getElementById('btn-google-auth')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      showAuthError(err.message);
    }
  });

  document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();

    const email = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const name = document.getElementById('auth-name')?.value.trim();
    const confirm = document.getElementById('auth-password-confirm')?.value;

    if (!email || !password) {
      showAuthError('Please enter email and password.');
      return;
    }

    try {
      if (state.authMode === 'signup') {
        if (!name) {
          showAuthError('Please enter your name.');
          return;
        }
        if (password !== confirm) {
          showAuthError('Passwords do not match.');
          return;
        }
        if (password.length < 6) {
          showAuthError('Password must be at least 6 characters.');
          return;
        }
        await signUpWithPassword(email, password, name);
        showToast('Account created! Check your email to confirm.');
        setAuthMode('signin');
      } else {
        await signInWithPassword(email, password);
        showToast('Welcome back! 💫');
      }
    } catch (err) {
      showAuthError(err.message);
    }
  });

  document.getElementById('link-forgot')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email')?.value.trim();
    if (!email) {
      showAuthError('Enter your email above first.');
      return;
    }
    try {
      await sendPasswordReset(email);
      showToast('Password reset link sent! Check your email.');
    } catch (err) {
      showAuthError(err.message);
    }
  });

  document.getElementById('btn-signout')?.addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      icon: '👋',
      title: 'Sign out?',
      body: 'You will stop receiving real-time updates until you sign back in.',
      okLabel: 'Sign Out',
      okDanger: true
    });
    if (!confirmed) return;

    try {
      await signOutUser();
      state.userProfile = null;
      state.connections = [];
      if (state.realtimeChannel) {
        state.realtimeChannel.unsubscribe();
        state.realtimeChannel = null;
      }
      invalidateCache();
      navigateTo('auth');
      setAuthMode('signin');
      showToast('Signed out successfully.');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('status-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.userProfile) return;

    const textInput = document.getElementById('status-text-input');
    const text = textInput?.value.trim() || '';

    try {
      let imageUrl = state.userProfile.status_image_url || null;

      if (currentStatusImage) {
        showToast('Uploading image...');
        imageUrl = await uploadStatusImage(currentStatusImage);
        currentStatusImageUrl = imageUrl;
      }

      await updateStatus(state.selectedEmoji, text, imageUrl);
      showToast('Status updated! 💫');
      if (textInput) textInput.value = '';

      removeStatusImage();
      await notifyFriendsOfUpdate();
      await loadDashboardData();
    } catch (err) {
      showToast(err.message || 'Failed to update status', 'error');
    }
  });

  document.getElementById('status-file-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleStatusImage(e.target.files[0]);
  });

  document.getElementById('status-camera-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleStatusImage(e.target.files[0]);
  });

  document.getElementById('btn-remove-status-image')?.addEventListener('click', () => {
    removeStatusImage();
  });

  document.getElementById('connection-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('connection-id-input');
    const id = input?.value.trim();

    if (!id) {
      showToast('Please enter a Pulse ID.', 'error');
      return;
    }

    try {
      await sendConnectionRequest(id);
      showToast('Connection request sent! ✉️');
      if (input) input.value = '';
      await loadDashboardData();
    } catch (err) {
      showToast(err.message || 'Failed to send request', 'error');
    }
  });

  document.getElementById('chat-send-btn')?.addEventListener('click', sendChatMessage);

  document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  document.getElementById('chat-file-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleChatImage(e.target.files[0]);
  });

  document.getElementById('chat-camera-input')?.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleChatImage(e.target.files[0]);
  });

  document.getElementById('btn-remove-chat-image')?.addEventListener('click', () => {
    removeChatImage();
  });

  document.getElementById('btn-chat-back')?.addEventListener('click', () => {
    currentChatFriend = null;
    navigateTo('dashboard');
    loadDashboardData();
  });

  document.getElementById('my-id-display')?.addEventListener('click', async () => {
    if (!state.userProfile?.id) return;
    try {
      await navigator.clipboard.writeText(state.userProfile.id);
      showToast('Pulse ID copied to clipboard! 📋');
    } catch (err) {
      showToast('Failed to copy ID', 'error');
    }
  });

  document.getElementById('btn-reset-config')?.addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      icon: '⚙️',
      title: 'Reset configuration?',
      body: 'This will clear your Supabase settings and sign you out.',
      okLabel: 'Reset',
      okDanger: true
    });
    if (!confirmed) return;

    resetSupabaseConfig();
    state.userProfile = null;
    state.connections = [];
    if (state.realtimeChannel) {
      state.realtimeChannel.unsubscribe();
      state.realtimeChannel = null;
    }
    invalidateCache();
    navigateTo('config');
    showToast('Configuration reset.');
  });
}

/* ==========================================
   LOCKSCREEN SIMULATOR
   ========================================== */
function startSimulatorClock() {
  if (state.clockInterval) clearInterval(state.clockInterval);

  const updateClock = () => {
    const now = new Date();
    const timeEl = document.getElementById('sim-time');
    const dateEl = document.getElementById('sim-date');
    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    }
  };

  updateClock();
  state.clockInterval = setInterval(updateClock, 1000);
}

function updateSimulatorUI() {
  const simEmoji = document.getElementById('sim-emoji');
  const simText = document.getElementById('sim-text');
  const simImage = document.getElementById('sim-image');

  if (simEmoji) simEmoji.textContent = state.userProfile?.status_emoji || '😊';
  if (simText) simText.textContent = state.userProfile?.status_text || 'Available';
  if (simImage) {
    if (state.userProfile?.status_image_url) {
      simImage.src = state.userProfile.status_image_url;
      simImage.style.display = 'block';
    } else {
      simImage.style.display = 'none';
    }
  }
}

/* ==========================================
   INIT
   ========================================== */
document.addEventListener('DOMContentLoaded', () => {
  initEmojiPicker();
  initEventListeners();
  registerServiceWorker();
  checkNavigationState();
});
