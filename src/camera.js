/**
 * In-app camera — works on PC, Android (any version), iOS
 * Uses getUserMedia API directly instead of relying on <input capture>
 */

let _stream = null;

export function openCamera(onCapture, onError) {
  // Remove any existing camera overlay
  document.getElementById('pulse-camera-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pulse-camera-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9000;
    background: #000;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
  `;

  overlay.innerHTML = `
    <div style="position:relative;width:100%;max-width:480px;flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;">
      <video id="pulse-cam-video" autoplay playsinline muted
        style="width:100%;height:100%;object-fit:cover;"></video>
      <div id="pulse-cam-status" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
        color:white;font-size:14px;text-align:center;padding:20px;">Starting camera...</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;
      width:100%;max-width:480px;padding:20px 24px;background:#111;">
      <button id="pulse-cam-cancel" style="background:rgba(255,255,255,0.15);border:none;
        color:white;font-size:14px;padding:10px 20px;border-radius:24px;cursor:pointer;">Cancel</button>
      <button id="pulse-cam-capture" style="width:64px;height:64px;border-radius:50%;
        background:white;border:4px solid rgba(255,255,255,0.4);cursor:pointer;
        display:flex;align-items:center;justify-content:center;">
        <div style="width:48px;height:48px;border-radius:50%;background:white;border:2px solid #333;"></div>
      </button>
      <button id="pulse-cam-flip" style="background:rgba(255,255,255,0.15);border:none;
        color:white;font-size:20px;padding:10px 16px;border-radius:24px;cursor:pointer;">🔄</button>
    </div>
  `;

  document.body.appendChild(overlay);

  const video  = overlay.querySelector('#pulse-cam-video');
  const status = overlay.querySelector('#pulse-cam-status');
  let facingMode = 'environment'; // start with back camera

  const startStream = async (facing) => {
    if (_stream) _stream.getTracks().forEach(t => t.stop());
    status.style.display = 'block';
    status.textContent = 'Starting camera...';
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = _stream;
      video.onloadedmetadata = () => {
        video.play();
        status.style.display = 'none';
      };
    } catch (err) {
      status.textContent = `Camera error: ${err.message}`;
      if (err.name === 'NotAllowedError') {
        status.textContent = 'Camera permission denied. Please allow camera access in your browser settings.';
      } else if (err.name === 'NotFoundError') {
        // No camera found — close overlay and fall back to file picker
        closeCamera();
        onError?.('no_camera');
      }
    }
  };

  const closeCamera = () => {
    if (_stream) _stream.getTracks().forEach(t => t.stop());
    _stream = null;
    overlay.remove();
  };

  overlay.querySelector('#pulse-cam-cancel').addEventListener('click', closeCamera);

  overlay.querySelector('#pulse-cam-flip').addEventListener('click', async () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    await startStream(facingMode);
  });

  overlay.querySelector('#pulse-cam-capture').addEventListener('click', () => {
    const canvas  = document.createElement('canvas');
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');

    // Mirror front camera
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      closeCamera();
      if (blob) {
        const file = new File([blob], `photo_${Date.now()}.jpg`, { type: 'image/jpeg' });
        onCapture(file);
      }
    }, 'image/jpeg', 0.85);
  });

  // Start with back camera
  startStream(facingMode);
}
