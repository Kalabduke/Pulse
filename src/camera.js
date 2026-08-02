/**
 * In-app camera — photo + video
 * Mirror mode: front camera preview and capture both mirrored (like a real mirror)
 */

let _stream = null;

export function openCamera(onCapture, onError) {
  document.getElementById('pulse-camera-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pulse-camera-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9000;background:#000;
    display:flex;flex-direction:column;
  `;

  overlay.innerHTML = `
    <div id="pulse-cam-wrap" style="flex:1;position:relative;overflow:hidden;background:#000;">
      <video id="pulse-cam-video" autoplay playsinline muted webkit-playsinline
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"></video>
      <div id="pulse-cam-status"
        style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
          color:white;font-size:15px;text-align:center;padding:24px;
          background:rgba(0,0,0,0.6);">
        Requesting camera...
      </div>
      <div id="pulse-cam-rec-bar"
        style="display:none;position:absolute;top:16px;left:50%;transform:translateX(-50%);
          background:rgba(239,68,68,0.9);color:white;font-size:13px;font-weight:700;
          padding:6px 16px;border-radius:20px;align-items:center;gap:8px;">
        <div style="width:8px;height:8px;border-radius:50%;background:white;"></div>
        <span id="pulse-cam-timer">0:00</span>
      </div>
    </div>

    <div style="background:#111;padding:8px 0 4px;display:flex;justify-content:center;gap:32px;">
      <button id="pulse-cam-mode-photo"
        style="background:none;border:none;color:white;font-size:13px;font-weight:700;
          cursor:pointer;padding:6px 16px;border-bottom:2px solid white;">PHOTO</button>
      <button id="pulse-cam-mode-video"
        style="background:none;border:none;color:#888;font-size:13px;font-weight:500;
          cursor:pointer;padding:6px 16px;border-bottom:2px solid transparent;">VIDEO</button>
    </div>

    <div style="background:#111;padding:16px 24px 32px;
      display:flex;align-items:center;justify-content:space-between;">
      <button id="pulse-cam-cancel"
        style="background:rgba(255,255,255,0.12);border:none;color:white;
          font-size:14px;padding:10px 20px;border-radius:24px;cursor:pointer;
          touch-action:manipulation;">Cancel</button>
      <button id="pulse-cam-shutter"
        style="width:70px;height:70px;border-radius:50%;border:5px solid rgba(255,255,255,0.4);
          background:white;cursor:pointer;touch-action:manipulation;flex-shrink:0;">
        <div id="pulse-cam-inner"
          style="width:54px;height:54px;border-radius:50%;background:white;border:2px solid #333;
            margin:auto;"></div>
      </button>
      <button id="pulse-cam-flip"
        style="background:rgba(255,255,255,0.12);border:none;color:white;
          font-size:22px;padding:10px 14px;border-radius:24px;cursor:pointer;
          touch-action:manipulation;">🔄</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const video    = document.getElementById('pulse-cam-video');
  const statusEl = document.getElementById('pulse-cam-status');
  const recBar   = document.getElementById('pulse-cam-rec-bar');
  const timerEl  = document.getElementById('pulse-cam-timer');
  const shutter  = document.getElementById('pulse-cam-shutter');
  const inner    = document.getElementById('pulse-cam-inner');

  let facingMode = 'environment';
  let mode       = 'photo';
  let recorder   = null;
  let recChunks  = [];
  let recTimer   = null;
  let recSecs    = 0;

  /* ── stream ── */
  const startStream = async (facing) => {
    statusEl.style.display = 'flex';
    statusEl.textContent = 'Starting camera...';
    if (_stream) {
      _stream.getTracks().forEach(t => t.stop());
      _stream = null;
    }

    // Mirror preview for front camera — like touching a mirror
    video.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';

    // Check if getUserMedia is available
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = 'Camera not supported on this browser. Use the 🖼️ Gallery button instead.';
      return;
    }

    const constraints = [
      { video: { facingMode: { exact: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { video: { facingMode: { ideal: facing } }, audio: true },
      { video: { facingMode: facing }, audio: false },
      { video: true, audio: false },
    ];

    let lastErr;
    for (const c of constraints) {
      try {
        console.log('[Camera] Trying constraints:', JSON.stringify(c));
        _stream = await navigator.mediaDevices.getUserMedia(c);
        console.log('[Camera] Got stream:', _stream.getTracks().map(t => t.kind + ':' + t.label).join(', '));
        break;
      } catch (e) {
        console.warn('[Camera] Constraint failed:', e.name, e.message);
        lastErr = e;
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') break;
        if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
          closeCamera(); onError?.('no_camera'); return;
        }
      }
    }

    if (!_stream) {
      // All getUserMedia attempts failed — close overlay and fall back to OS native camera
      console.warn('[Camera] All getUserMedia failed, falling back to file input');
      closeCamera();
      onError?.('no_camera');
      return;
    }
    try {
      video.srcObject = _stream;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.muted = true;

      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = reject;
        setTimeout(resolve, 3000); // fallback if metadata never fires
      });

      await video.play();
      statusEl.style.display = 'none';
      console.log('[Camera] Playing. Size:', video.videoWidth, 'x', video.videoHeight);
    } catch (e) {
      console.warn('[Camera] Play failed:', e.message);
      // Try playing on next user interaction
      statusEl.textContent = 'Tap to start preview';
      const startOnTap = () => {
        video.play().then(() => { statusEl.style.display = 'none'; }).catch(() => {});
        overlay.removeEventListener('click', startOnTap);
      };
      overlay.addEventListener('click', startOnTap);
    }
  };

  /* ── close ── */
  const closeCamera = () => {
    clearInterval(recTimer);
    if (recorder?.state === 'recording') recorder.stop();
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    overlay.remove();
  };

  /* ── mode ── */
  const setMode = (m) => {
    mode = m;
    const ph = document.getElementById('pulse-cam-mode-photo');
    const vi = document.getElementById('pulse-cam-mode-video');
    if (m === 'photo') {
      ph.style.color = 'white'; ph.style.borderBottom = '2px solid white';
      vi.style.color = '#888';  vi.style.borderBottom = '2px solid transparent';
      inner.style.borderRadius = '50%'; inner.style.background = 'white';
    } else {
      vi.style.color = 'white'; vi.style.borderBottom = '2px solid #ef4444';
      ph.style.color = '#888';  ph.style.borderBottom = '2px solid transparent';
      inner.style.borderRadius = '6px'; inner.style.background = '#ef4444';
    }
  };

  /* ── photo ── */
  const takePhoto = () => {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Mirror captured image for front camera to match the mirrored preview
    if (facingMode === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(blob => {
      closeCamera();
      if (blob) onCapture(new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.85);
  };

  /* ── video rec ── */
  const startRec = () => {
    if (!_stream) return;
    const mimes = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
    const mime = mimes.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';
    recChunks = [];
    recorder = new MediaRecorder(_stream, { mimeType: mime, videoBitsPerSecond: 1500000 });
    recorder.ondataavailable = e => { if (e.data?.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: mime });
      const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
      closeCamera();
      if (blob.size) onCapture(new File([blob], `video_${Date.now()}.${ext}`, { type: mime }));
    };
    recorder.start(200);
    inner.style.background = '#ef4444'; inner.style.borderRadius = '4px';
    recBar.style.display = 'flex';
    recSecs = 0; timerEl.textContent = '0:00';
    recTimer = setInterval(() => {
      recSecs++;
      timerEl.textContent = `${Math.floor(recSecs/60)}:${String(recSecs%60).padStart(2,'0')}`;
      if (recSecs >= 10) stopRec();
    }, 1000);
  };

  const stopRec = () => {
    clearInterval(recTimer); recTimer = null;
    recBar.style.display = 'none';
    inner.style.background = '#ef4444'; inner.style.borderRadius = '6px';
    if (recorder?.state === 'recording') recorder.stop();
  };

  /* ── events ── */
  overlay.querySelector('#pulse-cam-mode-photo').addEventListener('click', () => setMode('photo'));
  overlay.querySelector('#pulse-cam-mode-video').addEventListener('click', () => setMode('video'));
  overlay.querySelector('#pulse-cam-cancel').addEventListener('click', closeCamera);
  overlay.querySelector('#pulse-cam-flip').addEventListener('click', async () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    await startStream(facingMode);
  });

  shutter.addEventListener('click', () => {
    if (mode === 'photo') { takePhoto(); }
    else if (!recorder || recorder.state === 'inactive') { startRec(); }
    else { stopRec(); }
  });

  startStream(facingMode);
}
