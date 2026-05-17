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
  notifyFriendsOfUpdate
} from './supabase.js';

// ── Clean URL immediately — remove tokens/codes before anything renders ──
// Save them first so getSessionAndProfile can still use them
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
  pollInterval: null       // iOS fallback polling
};

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
    dashboard: document.getElementById('dashboard-view')
  };

  Object.entries(views).forEach(([key, el]) => {
    if (el) el.style.display = key === viewName ? 'flex' : 'none';
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
          // Find the friend's display name (nickname or real name)
          const friend = state.connections.find(c => c.friendId === updatedId);
          const displayName = friend?.nickname?.trim() || change.record.name || 'A friend';
          const emoji = change.record.status_emoji || '💫';
          const text = change.record.status_text || 'Updated their status';

          // Show lockscreen notification
          notifyFriendStatusUpdate(displayName, emoji, text);

          showToast(`${emoji} ${displayName} updated their status!`);
          await loadDashboardData();
        }
      }
    } else if (change.type === 'connection_changed') {
      await loadDashboardData();
    }
  });
}

/* ==========================================
   DASHBOARD DATA
   ========================================== */
async function loadDashboardData() {
  try {
    const profile = await getSessionAndProfile();
    if (profile) {
      state.userProfile = profile;
      updateMyStatusUI();
      updateSimulatorUI();
    }

    const connections = await fetchConnections();
    state.connections = connections;

    renderFriendsFeed();
    renderPendingInvites();

    // Load friends' status history (not own)
    if (state.userProfile) {
      const connectedFriendIds = state.connections
        .filter(c => c.status === 'connected')
        .map(c => c.friendId);
      const history = await fetchFriendsStatusHistory(connectedFriendIds);
      renderStatusHistory(history, state.connections);
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
  const idDisplay = document.getElementById('my-id-display');

  if (myName) myName.textContent = state.userProfile.name || 'My Status';
  if (myAvatar) myAvatar.textContent = state.userProfile.status_emoji || '👋';
  if (myStatusBubble) {
    myStatusBubble.textContent = `"${state.userProfile.status_text || 'Available'}"`;
  }
  if (idDisplay) {
    idDisplay.textContent = state.userProfile.id;
    idDisplay.title = 'Click to copy your Pulse ID';
  }
}

/* ==========================================
   EMOJI PICKER — CATEGORIES & CUSTOM INPUT
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

  // Update preview
  const preview = document.getElementById('emoji-preview');
  if (preview) preview.textContent = emoji;

  // Update custom input
  const customInput = document.getElementById('emoji-custom-input');
  if (customInput) customInput.value = emoji;

  // Update active state in grid
  document.querySelectorAll('#emoji-grid .emoji-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.emoji === emoji);
  });
}

function initEmojiPicker() {
  // Category tabs
  document.getElementById('emoji-category-tabs')?.querySelectorAll('.emoji-cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.emoji-cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentEmojiCategory = tab.dataset.cat;
      renderEmojiGrid(currentEmojiCategory, state.selectedEmoji);
    });
  });

  // Custom emoji input
  const customInput = document.getElementById('emoji-custom-input');
  customInput?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (!val) return;
    // Extract first emoji/character
    const chars = [...val];
    const emoji = chars[0];
    if (emoji) selectEmoji(emoji);
  });

  // Initial render
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
    const card = document.createElement('div');
    card.className = 'glass-card user-status-card';
    card.innerHTML = `
      <div class="avatar-container">
        <span>${friend.statusEmoji || '😊'}</span>
        <span class="online-pulse-dot"></span>
      </div>
      <div class="status-details">
        <div class="status-user-name">
          <span class="friend-display-name">${escapeHtml(friend.nickname?.trim() || friend.name)}</span>
          ${friend.nickname ? `<span class="real-name-tag" title="Real name">${escapeHtml(friend.name)}</span>` : ''}
        </div>
        <div class="status-bubble">"${escapeHtml(friend.statusText || 'Available')}"</div>
        <div class="status-time">${formatTimeAgo(friend.updatedAt)}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 6px; align-self: flex-start; flex-shrink: 0;">
        <button
          class="btn btn-secondary btn-small nickname-btn"
          data-conn-id="${friend.connectionId}"
          data-current-nickname="${escapeHtml(friend.nickname || '')}"
          data-real-name="${escapeHtml(friend.name)}"
          title="${friend.nickname ? 'Edit nickname' : 'Add nickname'}"
          style="padding: 4px 8px; font-size: 11px;"
        >${friend.nickname ? '✏️' : '🏷️'}</button>
        <button
          class="btn btn-secondary btn-small btn-small-danger remove-connection-btn"
          data-conn-id="${friend.connectionId}"
          style="padding: 4px 8px; font-size: 11px;"
        >✕</button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.nickname-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const connId = btn.dataset.connId;
      const currentNickname = btn.dataset.currentNickname;
      const realName = btn.dataset.realName;

      const input = await showNicknameModal({ realName, currentNickname });
      if (input === null) return; // cancelled

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
    btn.addEventListener('click', async () => {
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
   PENDING INVITES RENDERER
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
   STATUS HISTORY RENDERER (friends' history)
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
    // Use nickname if set
    const conn = connections.find(c => c.friendId === entry.profile?.id);
    const displayName = conn?.nickname?.trim() || realName;

    return `
      <div class="history-item">
        <span class="history-emoji">${entry.status_emoji}</span>
        <div class="history-details">
          <span class="history-name">${escapeHtml(displayName)}</span>
          <span class="history-text">"${escapeHtml(entry.status_text)}"</span>
          <span class="history-time">${formatTimeAgo(entry.created_at)}</span>
        </div>
      </div>
    `;
  }).join('');
}

/* ==========================================
   CUSTOM MODAL HELPERS (replaces prompt/confirm)
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
   Supabase Realtime WebSockets get suspended on iOS
   when the app is backgrounded. Poll every 30s as fallback.
   ========================================== */
function startPollingFallback() {
  if (state.pollInterval) clearInterval(state.pollInterval);

  // Only poll on iOS Safari / PWA
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (!isIOS) return;

  state.pollInterval = setInterval(async () => {
    // Only poll if realtime channel is not SUBSCRIBED
    const channelStatus = state.realtimeChannel?.state;
    if (channelStatus !== 'joined') {
      console.log('[Pulse] iOS polling fallback triggered');
      await loadDashboardData();
    }
  }, 30000); // every 30 seconds

  // Also reload when app comes back to foreground
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.userProfile) {
      await loadDashboardData();
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

      // Subscribe to Web Push for background notifications
      await subscribeToPushNotifications();

      // Show a test notification
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

/**
 * Subscribe to Web Push and save the subscription to Supabase.
 * This enables background notifications even when the app is closed.
 */
async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[Pulse] Push not supported on this browser');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    console.log('[Pulse] SW ready, checking push subscription...');

    let subscription = await reg.pushManager.getSubscription();

    if (!subscription) {
      const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      console.log('[Pulse] VAPID key present:', !!VAPID_PUBLIC_KEY);

      if (!VAPID_PUBLIC_KEY) {
        console.warn('[Pulse] VAPID_PUBLIC_KEY not set in env — background push disabled');
        showToast('Notifications enabled (in-app only — VAPID key missing)', 'info');
        return;
      }

      console.log('[Pulse] Subscribing to push...');
      const keyBytes = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes
      });
      console.log('[Pulse] Push subscription created:', subscription.endpoint);
    } else {
      console.log('[Pulse] Already subscribed:', subscription.endpoint);
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

/**
 * Sends FRIEND_STATUS_UPDATE to the SW which shows:
 *   1. A pop-up heads-up banner (like Telegram/Snapchat)
 *   2. A persistent summary notification that stays on the lockscreen
 */
function showPersistentStatusNotification(friendName, emoji, statusText) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  // Try SW first (better — shows on lockscreen)
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'FRIEND_STATUS_UPDATE',
      friendName,
      emoji,
      statusText,
      url: '/'
    });
  }

  // Always also show a direct notification as fallback
  // (works even if SW message fails)
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

/**
 * Show a notification when a friend updates their status.
 */
function notifyFriendStatusUpdate(friendName, emoji, statusText) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  showPersistentStatusNotification(friendName, emoji, statusText);
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */
function initEventListeners() {

  // ── Config: Save Supabase credentials ──────────────────────────────
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

  // ── Config: Toggle anon key visibility ─────────────────────────────
  document.getElementById('btn-toggle-key-visibility')?.addEventListener('click', () => {
    const keyInput = document.getElementById('config-key');
    const btn = document.getElementById('btn-toggle-key-visibility');
    if (!keyInput) return;
    const isHidden = keyInput.type === 'password';
    keyInput.type = isHidden ? 'text' : 'password';
    if (btn) btn.textContent = isHidden ? '🙈' : '👁';
  });

  // Allow Enter key in config fields
  ['config-url', 'config-key'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-save-config')?.click();
    });
  });

  // ── Config: Reset from dashboard — accessible only via config screen directly

  // ── Auth: Show config from auth screen ─────────────────────────────
  document.getElementById('btn-show-config')?.addEventListener('click', () => {
    navigateTo('config');
  });

  // ── Auth: Tab switcher ─────────────────────────────────────────────
  document.getElementById('tab-signin')?.addEventListener('click', () => setAuthMode('signin'));
  document.getElementById('tab-signup')?.addEventListener('click', () => setAuthMode('signup'));

  // ── Auth: Toggle password visibility ──────────────────────────────
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

  // ── Auth: Google OAuth ─────────────────────────────────────────────
  document.getElementById('btn-google-auth')?.addEventListener('click', async () => {
    try {
      await signInWithGoogle();
      // Page will redirect to Google — no further action needed here
    } catch (err) {
      showAuthError(err.message || 'Google sign-in failed.');
    }
  });

  // ── Auth: Forgot password ──────────────────────────────────────────
  document.getElementById('btn-forgot-password')?.addEventListener('click', async () => {
    const email = document.getElementById('auth-email')?.value.trim();
    if (!email || !email.includes('@')) {
      showAuthError('Enter your email address above first.');
      return;
    }
    try {
      await sendPasswordReset(email);
      showToast('Password reset email sent!');
    } catch (err) {
      showAuthError(err.message || 'Failed to send reset email.');
    }
  });

  // ── Auth: Submit (Sign In or Sign Up) ──────────────────────────────
  const btnAuthSubmit = document.getElementById('btn-auth-submit');
  btnAuthSubmit?.addEventListener('click', async () => {
    clearAuthError();
    const email    = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const name     = document.getElementById('auth-name')?.value.trim();
    const confirm  = document.getElementById('auth-password-confirm')?.value;

    // Validation
    if (!email || !email.includes('@')) {
      showAuthError('Please enter a valid email address.'); return;
    }
    if (!password || password.length < 6) {
      showAuthError('Password must be at least 6 characters.'); return;
    }
    if (state.authMode === 'signup') {
      if (!name) { showAuthError('Please enter a display name.'); return; }
      if (password !== confirm) { showAuthError('Passwords do not match.'); return; }
    }

    setButtonLoading(btnAuthSubmit, true, state.authMode === 'signin' ? 'Signing in...' : 'Creating account...');

    try {
      if (state.authMode === 'signin') {
        await signInWithPassword(email, password);
        showToast('Welcome back!');
        await checkNavigationState();
      } else {
        const result = await signUpWithPassword(email, password, name);
        // Email confirmation required — Supabase returns user but no session
        if (result.user && !result.session) {
          // Show a clear confirmation screen
          showAuthError('');
          const card = document.getElementById('auth-email-card') || document.querySelector('.auth-form-card');
          if (card) {
            card.innerHTML = `
              <div style="text-align: center; display: flex; flex-direction: column; gap: 16px; padding: 8px 0;">
                <div style="font-size: 48px;">📬</div>
                <h2 style="font-size: 20px;">Check your email</h2>
                <p style="font-size: 14px; color: hsl(var(--text-secondary)); line-height: 1.6;">
                  We sent a confirmation link to<br>
                  <strong style="color: #a5b4fc;">${escapeHtml(email)}</strong>
                </p>
                <p style="font-size: 13px; color: hsl(var(--text-muted)); line-height: 1.5;">
                  Click the link in the email to verify your account, then come back and sign in.
                </p>
                <button id="btn-back-to-signin" class="btn btn-primary">
                  <span>Go to Sign In</span>
                </button>
              </div>
            `;
            document.getElementById('btn-back-to-signin')?.addEventListener('click', () => {
              // Reload auth view cleanly
              navigateTo('auth');
              setAuthMode('signin');
            });
          }
          return;
        }
        showToast('Account created! Welcome to Pulse 🎉');
        await checkNavigationState();
      }
    } catch (err) {
      const msg = err.message || '';
      if (msg.toLowerCase().includes('email not confirmed') || msg.toLowerCase().includes('not confirmed')) {
        showAuthError('Please confirm your email first. Check your inbox for the verification link.');
      } else if (msg.toLowerCase().includes('invalid login credentials')) {
        showAuthError('Incorrect email or password. Please try again.');
      } else if (msg.toLowerCase().includes('user already registered')) {
        showAuthError('An account with this email already exists. Try signing in instead.');
        setAuthMode('signin');
      } else {
        showAuthError(msg || 'Something went wrong. Please try again.');
      }
    } finally {
      setButtonLoading(btnAuthSubmit, false, state.authMode === 'signin' ? 'Sign In' : 'Create Account');
    }
  });

  // Allow Enter key to submit
  ['auth-email', 'auth-password', 'auth-name', 'auth-password-confirm'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') btnAuthSubmit?.click();
    });
  });

  // ── Dashboard: Sign out ────────────────────────────────────────────
  document.getElementById('btn-signout')?.addEventListener('click', async () => {
    const confirmed = await showConfirmModal({
      icon: '👋',
      title: 'Sign out?',
      body: 'You will be signed out of Pulse.',
      okLabel: 'Sign Out',
      okDanger: false
    });
    if (!confirmed) return;
    try {
      await signOutUser();
      state.userProfile = null;
      state.connections = [];
      state.realtimeChannel?.unsubscribe();
      state.realtimeChannel = null;
      clearInterval(state.clockInterval);
      clearInterval(state.pollInterval);
      showToast('Signed out.');
      checkNavigationState();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Status Modal: Open ─────────────────────────────────────────────
  document.getElementById('btn-open-status-modal')?.addEventListener('click', () => {
    if (!state.userProfile) return;

    const nameInput = document.getElementById('status-name-input');
    const textInput = document.getElementById('status-text-input');
    if (nameInput) nameInput.value = state.userProfile.name || '';
    if (textInput) textInput.value = state.userProfile.status_text || '';

    state.selectedEmoji = state.userProfile.status_emoji || '😊';

    // Init emoji picker with current emoji selected
    initEmojiPicker();
    selectEmoji(state.selectedEmoji);

    document.getElementById('status-modal')?.classList.add('show');
  });

  // ── Status Modal: Close ────────────────────────────────────────────
  document.getElementById('btn-close-status-modal')?.addEventListener('click', () => {
    document.getElementById('status-modal')?.classList.remove('show');
  });

  // Close modal on backdrop click — only if clicking the dark overlay itself
  document.getElementById('status-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'status-modal') {
      e.currentTarget.classList.remove('show');
    }
  });

  // ── Status Modal: Emoji picker — handled dynamically by initEmojiPicker()

  // ── Status Modal: Save ─────────────────────────────────────────────
  const btnSaveStatus = document.getElementById('btn-save-status');
  btnSaveStatus?.addEventListener('click', async () => {
    const name = document.getElementById('status-name-input')?.value.trim();
    const text = document.getElementById('status-text-input')?.value.trim();

    if (!name) {
      showToast('Please enter a display name.', 'error');
      return;
    }

    setButtonLoading(btnSaveStatus, true, 'Pulsing out...');
    try {
      const updated = await updateStatus(name, state.selectedEmoji, text || 'Available');
      state.userProfile = { ...state.userProfile, ...updated };
      document.getElementById('status-modal')?.classList.remove('show');
      showToast('Status updated!');
      updateMyStatusUI();
      updateSimulatorUI();

      // Notify friends via server-side push (works when their app is closed)
      notifyFriendsOfUpdate(
        state.userProfile.id,
        name,
        state.selectedEmoji,
        text || 'Available'
      );
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setButtonLoading(btnSaveStatus, false, 'Save & Pulse Out!');
    }
  });

  // ── Connections: Send invite ───────────────────────────────────────
  const btnSendInvite = document.getElementById('btn-send-invite');
  btnSendInvite?.addEventListener('click', async () => {
    const input = document.getElementById('friend-id-input');
    const query = input?.value.trim();

    if (!query) {
      showToast("Enter your friend's Pulse ID or display name.", 'error');
      return;
    }

    setButtonLoading(btnSendInvite, true, '...');
    try {
      await sendConnectionRequest(query);
      showToast('Connection request sent!');
      if (input) input.value = '';
      await loadDashboardData();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setButtonLoading(btnSendInvite, false, 'Connect');
    }
  });

  // Allow Enter key in friend ID input
  document.getElementById('friend-id-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-send-invite')?.click();
  });

  // ── Refresh button ────────────────────────────────────────────────
  document.getElementById('btn-refresh')?.addEventListener('click', async () => {
    const icon = document.getElementById('refresh-icon');
    if (icon) icon.style.animation = 'spin 0.6s linear infinite';
    try {
      await loadDashboardData();
      showToast('Refreshed!');
    } catch {
      showToast('Could not refresh. Check your connection.', 'error');
    } finally {
      if (icon) icon.style.animation = '';
    }
  });

  // ── Copy Pulse ID ──────────────────────────────────────────────────
  function copyMyId() {
    const id = document.getElementById('my-id-display')?.textContent;
    if (id && id !== 'Loading...') {
      navigator.clipboard.writeText(id).then(() => showToast('Pulse ID copied!'));
    }
  }
  document.getElementById('btn-copy-id')?.addEventListener('click', copyMyId);
  document.getElementById('my-id-display')?.addEventListener('click', copyMyId);

  // Simulator toggle removed — lockscreen preview panel removed
}

/* ==========================================
   BUTTON LOADING STATE HELPER
   ========================================== */
function setButtonLoading(btn, loading, label) {
  if (!btn) return;
  btn.disabled = loading;
  const span = btn.querySelector('span');
  if (span) {
    span.textContent = label;
  } else {
    btn.textContent = label;
  }
}

/* ==========================================
   BOOT
   ========================================== */
document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  initEventListeners();
  checkNavigationState();
});

/* ==========================================
   SIMULATOR — REMOVED (no-ops kept for safety)
   ========================================== */
function updateSimulatorUI() { /* no-op */ }
function startSimulatorClock() { /* no-op */ }
