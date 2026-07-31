/**
 * Video handling — no WASM, works on all mobile browsers
 *
 * Camera: record via getUserMedia at 480p/640kbps — native compression
 * Gallery: accept files up to 8MB as-is (phones compress on capture)
 *
 * For gallery files > 8MB we reject with a clear message.
 * A phone-recorded 10s clip is typically 3-8MB already.
 */

const MAX_GALLERY_MB  = 8;
const MAX_DURATION_S  = 10;
const VIDEO_BITRATE   = 640000;  // 640kbps
const AUDIO_BITRATE   = 64000;   //  64kbps

/**
 * Validate and prepare a gallery video file.
 * No re-encoding — just checks size and trims via a silent video element if needed.
 * @param {File} file
 * @param {Function} onProgress
 * @returns {Promise<File>}
 */
export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file?.type?.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }

  onProgress(10);

  const sizeMB = file.size / 1024 / 1024;

  // If file is small enough, use as-is
  if (sizeMB <= MAX_GALLERY_MB) {
    onProgress(100);
    return file;
  }

  // File too large — try to re-encode using MediaRecorder (browser native)
  return reencodeWithMediaRecorder(file, onProgress);
}

/**
 * Re-encode using MediaRecorder — plays video into canvas, records output.
 * Works without WASM. Quality is lower than FFmpeg but it's instant.
 * Only called for files > 8MB.
 */
function reencodeWithMediaRecorder(file, onProgress) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === 'undefined') {
      reject(new Error(`Video is ${(file.size/1024/1024).toFixed(1)}MB — too large. Please pick a video under ${MAX_GALLERY_MB}MB.`));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const video     = document.createElement('video');
    video.muted     = true;
    video.playsInline = true;
    video.preload   = 'auto';

    video.addEventListener('loadedmetadata', () => {
      // Check duration
      if (video.duration > MAX_DURATION_S * 3) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Video too long. Please pick a clip under ${MAX_DURATION_S} seconds.`));
        return;
      }

      const origW = video.videoWidth  || 640;
      const origH = video.videoHeight || 480;

      // Scale so larger dimension = 480
      const scale = 480 / Math.max(origW, origH);
      const w = Math.round(origW * scale / 2) * 2;
      const h = Math.round(origH * scale / 2) * 2;

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      // Find best supported MIME
      const mimes = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      const mime  = mimes.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || 'video/webm';

      let stream, recorder;
      try {
        stream   = canvas.captureStream(24);
        recorder = new MediaRecorder(stream, {
          mimeType:        mime,
          videoBitsPerSecond: VIDEO_BITRATE,
          audioBitsPerSecond: AUDIO_BITRATE
        });
      } catch {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Video is ${(file.size/1024/1024).toFixed(1)}MB — too large. Please pick under ${MAX_GALLERY_MB}MB.`));
        return;
      }

      const chunks = [];
      recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        URL.revokeObjectURL(objectUrl);
        const blob = new Blob(chunks, { type: mime });
        const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
        const out  = new File([blob], file.name.replace(/\.[^.]+$/, `.${ext}`), { type: mime });
        console.log(`[Pulse] Re-encoded: ${(file.size/1024/1024).toFixed(1)}MB → ${(out.size/1024).toFixed(0)}KB`);
        resolve(out);
      };
      recorder.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Can't upload video right now. Please try again."));
      };

      let raf;
      const maxT = Math.min(video.duration, MAX_DURATION_S);

      const draw = () => {
        if (video.currentTime >= maxT) {
          cancelAnimationFrame(raf);
          if (recorder.state === 'recording') recorder.stop();
          return;
        }
        try { ctx.drawImage(video, 0, 0, w, h); } catch {}
        onProgress(Math.min(98, Math.round(20 + (video.currentTime / maxT) * 78)));
        raf = requestAnimationFrame(draw);
      };

      video.play().then(() => {
        recorder.start(100);
        raf = requestAnimationFrame(draw);
        video.onended = () => {
          cancelAnimationFrame(raf);
          if (recorder.state === 'recording') recorder.stop();
        };
      }).catch(() => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Video is ${(file.size/1024/1024).toFixed(1)}MB — too large. Please pick under ${MAX_GALLERY_MB}MB.`));
      });
    });

    video.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Can't read this video file. Please try a different one."));
    });

    video.src = objectUrl;
    video.load();
    onProgress(15);
  });
}
