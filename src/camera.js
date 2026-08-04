/**
 * In-app camera — photo + video, mirror mode for front camera
 */

let _stream = null;

// getUserMedia with a hard timeout — a hung/slow camera request must never
// make the user stare at "Starting camera..." for ages. A settled flag makes
// sure a stream that resolves AFTER the timeout fired gets stopped (no
// camera/mic LED left on) instead of leaking.
function getUserMediaWithTimeout(constraints, ms = 6000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DOMException('Camera request timed out', 'TimeoutError'));
    }, ms);
    navigator.mediaDevices.getUserMedia(constraints).then(
      (stream) => {
        clearTimeout(timer);
        if (settled) {
          // Timeout already fired — never leak the camera/mic stream
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        settled = true;
        resolve(stream);
      },
      (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      }
    );
  });
}

export function openCamera(onCapture, onError) {
  document.getElementById('pulse-camera-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pulse-camera-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9000;background:#000;
    display:flex;flex-direction:column;
  `;

  overlay.innerHTML = `
    <div style="flex:1;position:relative;overflow:hidden;background:#000;">
      <video id="pulse-cam-video" autoplay playsinline muted
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"></video>
      <div id="pulse-cam-status"
        style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        color:white;font-size:15px;text-align:center;padding:24px;background:rgba(0,0,0,0.6);">
        Starting camera...
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
      <button id="pulse-cam-mode-photo" style="background:none;border:none;color:white;font-size:13px;
        font-weight:700;cursor:pointer;padding:6px 16px;border-bottom:2px solid white;">PHOTO</button>
      <button id="pulse-cam-mode-video" style="background:none;border:none;color:#888;font-size:13px;
        font-weight:500;cursor:pointer;padding:6px 16px;border-bottom:2px solid transparent;">VIDEO</button>
    </div>
    <div style="background:#111;padding:16px 24px 32px;display:flex;align-items:center;justify-content:space-between;">
      <button id="pulse-cam-cancel" style="background:rgba(255,255,255,0.12);border:none;color:white;
        font-size:14px;padding:10px 20px;border-radius:24px;cursor:pointer;touch-action:manipulation;">Cancel</button>
      <button id="pulse-cam-shutter" style="width:70px;height:70px;border-radius:50%;
        border:5px solid rgba(255,255,255,0.4);background:white;cursor:pointer;touch-action:manipulation;">
        <div id="pulse-cam-inner" style="width:54px;height:54px;border-radius:50%;
          background:white;border:2px solid #333;margin:auto;"></div>
      </button>
      <button id="pulse-cam-flip" style="background:rgba(255,255,255,0.12);border:none;color:white;
        font-size:22px;padding:10px 14px;border-radius:24px;cursor:pointer;touch-action:manipulation;">🔄</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const video   = overlay.querySelector('#pulse-cam-video');
  const statusEl = overlay.querySelector('#pulse-cam-status');
  const recBar  = overlay.querySelector('#pulse-cam-rec-bar');
  const timerEl = overlay.querySelector('#pulse-cam-timer');
  const shutter = overlay.querySelector('#pulse-cam-shutter');
  const inner   = overlay.querySelector('#pulse-cam-inner');

  let facingMode = 'environment';
  let mode = 'photo';
  let recorder = null, recChunks = [], recTimer = null, recSecs = 0;
  let startingRec = false; // guards double-taps while the mic is being requested

  const closeCamera = () => {
    clearInterval(recTimer);
    if (recorder?.state === 'recording') recorder.stop();
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    overlay.remove();
  };

  const startStream = async (facing) => {
    statusEl.style.display = 'flex';
    statusEl.textContent = 'Starting camera...';
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }

    if (!navigator.mediaDevices?.getUserMedia) {
      closeCamera(); onError?.('no_camera'); return;
    }

    // Fastest-first: video only, no audio (avoids the mic permission prompt)
    // and no resolution hints (avoids slow camera negotiation). Audio is added
    // lazily at record time, so the preview appears almost instantly.
    // The FIRST attempt triggers the browser permission prompt, so it gets a
    // long timeout — users need time to read it and tap "Allow". Only the
    // retry gets the short timeout, so a genuinely hung camera still hands
    // off to native quickly.
    const tries = [
      { ms: 30000, constraints: { video: { facingMode: { ideal: facing } } } },
      { ms: 6000,  constraints: { video: true } },
    ];

    let gotStream = false;
    for (const { ms, constraints } of tries) {
      try {
        _stream = await getUserMediaWithTimeout(constraints, ms);
        gotStream = true;
        break;
      } catch (e) {
        console.warn('[Camera]', e.name, e.message);
        // No camera, denied, or took too long — hand off to the OS native
        // camera (which has its own permission flow) instead of retrying
        // pointless attempts or leaving the user stuck.
        if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError' || e.name === 'NotAllowedError') {
          closeCamera();
          onError?.('no_camera');
          return;
        }
        // OverconstrainedError or TimeoutError: retry with simpler constraints
      }
    }

    if (!gotStream) {
      closeCamera();
      onError?.('no_camera');
      return;
    }

    // Detect actual facing to apply correct mirroring
    const track = _stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const actualFacing = settings.facingMode || '';
    const label = (track?.label || '').toLowerCase();
    // Mirror if: explicitly user-facing, label says front, or unknown (PC webcam)
    const shouldMirror = actualFacing === 'user' || label.includes('front') || !actualFacing;
    facingMode = shouldMirror ? 'user' : 'environment';
    video.style.transform = shouldMirror ? 'scaleX(-1)' : 'none';

    video.srcObject = _stream;
    try {
      await video.play();
      statusEl.style.display = 'none';
    } catch {
      statusEl.textContent = 'Tap anywhere to start preview';
      overlay.addEventListener('click', () => {
        video.play().then(() => { statusEl.style.display = 'none'; }).catch(() => {});
      }, { once: true });
    }
  };

  const setMode = (m) => {
    mode = m;
    const ph = overlay.querySelector('#pulse-cam-mode-photo');
    const vi = overlay.querySelector('#pulse-cam-mode-video');
    if (m === 'photo') {
      ph.style.color='white'; ph.style.borderBottom='2px solid white';
      vi.style.color='#888';  vi.style.borderBottom='2px solid transparent';
      inner.style.borderRadius='50%'; inner.style.background='white';
    } else {
      vi.style.color='white'; vi.style.borderBottom='2px solid #ef4444';
      ph.style.color='#888';  ph.style.borderBottom='2px solid transparent';
      inner.style.borderRadius='6px'; inner.style.background='#ef4444';
    }
  };

  const takePhoto = () => {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (facingMode === 'user') {
      ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, w, h); ctx.restore();
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }
    canvas.toBlob(blob => {
      closeCamera();
      if (blob) onCapture(new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.85);
  };

  // Add a mic track to the live stream only when recording starts — this way
  // opening the camera never waits on a microphone permission prompt.
  const ensureAudio = async () => {
    if (!_stream || _stream.getAudioTracks().length > 0) return;
    try {
      const audio = await getUserMediaWithTimeout({ audio: true }, 5000);
      audio.getAudioTracks().forEach(t => _stream.addTrack(t));
    } catch {
      // No mic permission — record silently rather than blocking the video
    }
  };

  const startRec = async () => {
    if (!_stream || startingRec) return;
    startingRec = true;
    try {
      await ensureAudio();
    const mimes = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
    const mime = mimes.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';
    recChunks = [];
    recorder = new MediaRecorder(_stream, { mimeType: mime, videoBitsPerSecond: 1500000 });
    recorder.ondataavailable = e => { if (e.data?.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: mime });
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      closeCamera();
      if (blob.size) onCapture(new File([blob], `video_${Date.now()}.${ext}`, { type: mime }));
    };
    recorder.start(200);
    startingRec = false;
    inner.style.background='#ef4444'; inner.style.borderRadius='4px';
    recBar.style.display='flex'; recSecs=0; timerEl.textContent='0:00';
    recTimer = setInterval(() => {
      recSecs++;
      timerEl.textContent=`${Math.floor(recSecs/60)}:${String(recSecs%60).padStart(2,'0')}`;
      if (recSecs >= 10) stopRec();
    }, 1000);
    } catch (err) {
      // Mic request failed or recorder setup errored — reset the guard so the
      // user can simply tap record again.
      startingRec = false;
      console.warn('[Camera] Recorder start failed:', err);
    }
  };

  const stopRec = () => {
    clearInterval(recTimer); recTimer=null; recBar.style.display='none';
    inner.style.background='#ef4444'; inner.style.borderRadius='6px';
    if (recorder?.state==='recording') recorder.stop();
  };

  overlay.querySelector('#pulse-cam-mode-photo').addEventListener('click', () => setMode('photo'));
  overlay.querySelector('#pulse-cam-mode-video').addEventListener('click', () => setMode('video'));
  overlay.querySelector('#pulse-cam-cancel').addEventListener('click', closeCamera);
  overlay.querySelector('#pulse-cam-flip').addEventListener('click', async () => {
    facingMode = facingMode==='environment' ? 'user' : 'environment';
    await startStream(facingMode);
  });
  shutter.addEventListener('click', () => {
    if (mode==='photo') takePhoto();
    else if (!recorder || recorder.state==='inactive') startRec();
    else stopRec();
  });

  startStream(facingMode);
}
