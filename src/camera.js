/**
 * In-app camera — photo + video, mirror mode for front camera
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

    // Try progressively simpler constraints until one works
    const tries = [
      { video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true },
      { video: { facingMode: { ideal: facing } }, audio: false },
      { video: true, audio: false },
    ];

    let gotStream = false;
    for (const c of tries) {
      try {
        _stream = await navigator.mediaDevices.getUserMedia(c);
        gotStream = true;
        break;
      } catch (e) {
        console.warn('[Camera]', e.name, e.message);
        if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
          closeCamera(); onError?.('no_camera'); return;
        }
        // For NotAllowedError or others: keep trying simpler constraints
      }
    }

    if (!gotStream) {
      // Still failed — just show error, stay open so user sees it
      statusEl.textContent = '📷 Camera unavailable. Check browser permissions and try again.';
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

  const startRec = () => {
    if (!_stream) return;
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
    inner.style.background='#ef4444'; inner.style.borderRadius='4px';
    recBar.style.display='flex'; recSecs=0; timerEl.textContent='0:00';
    recTimer = setInterval(() => {
      recSecs++;
      timerEl.textContent=`${Math.floor(recSecs/60)}:${String(recSecs%60).padStart(2,'0')}`;
      if (recSecs >= 10) stopRec();
    }, 1000);
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
