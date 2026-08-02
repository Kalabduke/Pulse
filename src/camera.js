/**
 * In-app camera — photo + video recording
 * Works on PC, Android (any version), iOS
 */

let _stream = null;

export function openCamera(onCapture, onError) {
  document.getElementById('pulse-camera-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pulse-camera-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;z-index:9000;background:#000;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
  `;

  overlay.innerHTML = `
    <div style="position:relative;width:100%;max-width:480px;flex:1;display:flex;
      align-items:center;justify-content:center;overflow:hidden;">
      <video id="pulse-cam-video" autoplay playsinline muted
        style="width:100%;height:100%;object-fit:cover;"></video>
      <div id="pulse-cam-status" style="position:absolute;top:50%;left:50%;
        transform:translate(-50%,-50%);color:white;font-size:14px;
        text-align:center;padding:20px;background:rgba(0,0,0,0.5);border-radius:12px;">
        Starting camera...</div>
      <!-- Recording indicator -->
      <div id="pulse-cam-rec" style="display:none;position:absolute;top:16px;left:50%;
        transform:translateX(-50%);background:rgba(239,68,68,0.9);color:white;
        font-size:13px;font-weight:700;padding:6px 14px;border-radius:20px;
        display:none;align-items:center;gap:6px;">
        <div style="width:8px;height:8px;border-radius:50%;background:white;
          animation:pulse-ring 1s infinite;"></div>
        <span id="pulse-cam-timer">0:00</span>
      </div>
    </div>

    <!-- Mode tabs -->
    <div style="display:flex;gap:24px;padding:12px 0;background:#111;">
      <button id="pulse-cam-mode-photo" style="background:none;border:none;color:white;
        font-size:13px;font-weight:700;cursor:pointer;opacity:1;padding:4px 12px;
        border-bottom:2px solid white;">PHOTO</button>
      <button id="pulse-cam-mode-video" style="background:none;border:none;color:white;
        font-size:13px;font-weight:500;cursor:pointer;opacity:0.5;padding:4px 12px;
        border-bottom:2px solid transparent;">VIDEO</button>
    </div>

    <!-- Controls -->
    <div style="display:flex;align-items:center;justify-content:space-between;
      width:100%;max-width:480px;padding:16px 24px 28px;background:#111;">
      <button id="pulse-cam-cancel" style="background:rgba(255,255,255,0.15);border:none;
        color:white;font-size:14px;padding:10px 20px;border-radius:24px;cursor:pointer;
        touch-action:manipulation;">Cancel</button>
      <!-- Shutter / Record button -->
      <button id="pulse-cam-shutter" style="width:70px;height:70px;border-radius:50%;
        background:white;border:5px solid rgba(255,255,255,0.35);cursor:pointer;
        display:flex;align-items:center;justify-content:center;
        touch-action:manipulation;transition:transform 0.1s;">
        <div id="pulse-cam-shutter-inner" style="width:54px;height:54px;border-radius:50%;
          background:white;border:2px solid #333;transition:all 0.2s;"></div>
      </button>
      <button id="pulse-cam-flip" style="background:rgba(255,255,255,0.15);border:none;
        color:white;font-size:22px;padding:10px 14px;border-radius:24px;cursor:pointer;
        touch-action:manipulation;">🔄</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const video   = overlay.querySelector('#pulse-cam-video');
  const status  = overlay.querySelector('#pulse-cam-status');
  const recBar  = overlay.querySelector('#pulse-cam-rec');
  const timerEl = overlay.querySelector('#pulse-cam-timer');
  const shutter = overlay.querySelector('#pulse-cam-shutter');
  const shutterInner = overlay.querySelector('#pulse-cam-shutter-inner');
  const modePhoto = overlay.querySelector('#pulse-cam-mode-photo');
  const modeVideo = overlay.querySelector('#pulse-cam-mode-video');

  let facingMode  = 'environment';
  let mode        = 'photo'; // 'photo' | 'video'
  let recorder    = null;
  let recChunks   = [];
  let recTimer    = null;
  let recSeconds  = 0;
  const MAX_VIDEO = 10; // 10 second max

  // ── Stream ──────────────────────────────────────────────────────────────
  const startStream = async (facing) => {
    if (_stream) _stream.getTracks().forEach(t => t.stop());
    status.style.display = 'block';
    status.textContent = 'Starting camera...';
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
      video.srcObject = _stream;
      video.onloadedmetadata = () => {
        video.play();
        status.style.display = 'none';
        // Mirror the preview for front camera — looks natural like a mirror
        video.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
      };
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        status.textContent = 'Camera permission denied. Please allow camera access.';
      } else if (err.name === 'NotFoundError') {
        closeCamera();
        onError?.('no_camera');
      } else {
        status.textContent = `Camera error: ${err.message}`;
      }
    }
  };

  const closeCamera = () => {
    stopRecording();
    if (_stream) _stream.getTracks().forEach(t => t.stop());
    _stream = null;
    overlay.remove();
  };

  // ── Mode switch ─────────────────────────────────────────────────────────
  const setMode = (m) => {
    mode = m;
    if (m === 'photo') {
      modePhoto.style.opacity = '1'; modePhoto.style.borderBottom = '2px solid white';
      modeVideo.style.opacity = '0.5'; modeVideo.style.borderBottom = '2px solid transparent';
      shutterInner.style.borderRadius = '50%';
      shutterInner.style.background = 'white';
    } else {
      modeVideo.style.opacity = '1'; modeVideo.style.borderBottom = '2px solid #ef4444';
      modePhoto.style.opacity = '0.5'; modePhoto.style.borderBottom = '2px solid transparent';
      shutterInner.style.borderRadius = '6px';
      shutterInner.style.background = '#ef4444';
    }
  };

  modePhoto.addEventListener('click', () => setMode('photo'));
  modeVideo.addEventListener('click', () => setMode('video'));

  // ── Capture photo ───────────────────────────────────────────────────────
  const takePhoto = () => {
    const canvas = document.createElement('canvas');
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    // For front camera: mirror the captured image to match the preview
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      closeCamera();
      if (blob) onCapture(new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.85);
  };

  // ── Record video ────────────────────────────────────────────────────────
  const startRecording = () => {
    if (!_stream) return;
    const mimes = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
    const mime  = mimes.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';
    recChunks = [];
    recorder  = new MediaRecorder(_stream, { mimeType: mime, videoBitsPerSecond: 1500000 });
    recorder.ondataavailable = e => { if (e.data?.size > 0) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: mime });
      const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
      closeCamera();
      if (blob.size > 0) onCapture(new File([blob], `video_${Date.now()}.${ext}`, { type: mime }));
    };
    recorder.start(200);

    // Update shutter to red stop button
    shutterInner.style.background = '#ef4444';
    shutter.style.border = '5px solid rgba(239,68,68,0.5)';
    recBar.style.display = 'flex';
    recSeconds = 0;
    timerEl.textContent = '0:00';
    recTimer = setInterval(() => {
      recSeconds++;
      const m = Math.floor(recSeconds / 60);
      const s = recSeconds % 60;
      timerEl.textContent = `${m}:${s.toString().padStart(2,'0')}`;
      if (recSeconds >= MAX_VIDEO) stopRecording();
    }, 1000);
  };

  const stopRecording = () => {
    clearInterval(recTimer);
    recTimer = null;
    if (recorder && recorder.state === 'recording') recorder.stop();
    recorder = null;
    recBar.style.display = 'none';
    shutterInner.style.background = '#ef4444';
    shutter.style.border = '5px solid rgba(255,255,255,0.35)';
  };

  // ── Shutter press ───────────────────────────────────────────────────────
  shutter.addEventListener('click', () => {
    if (mode === 'photo') {
      takePhoto();
    } else {
      if (!recorder || recorder.state === 'inactive') {
        startRecording();
      } else {
        stopRecording();
      }
    }
  });

  overlay.querySelector('#pulse-cam-cancel').addEventListener('click', closeCamera);
  overlay.querySelector('#pulse-cam-flip').addEventListener('click', async () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    await startStream(facingMode);
  });

  startStream(facingMode);
}
