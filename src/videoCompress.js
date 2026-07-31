/**
 * Client-side video compression using MediaRecorder + canvas
 * No WASM — works on all browsers, no memory crashes.
 *
 * Files < 1.2MB: pass through as-is
 * Files ≥ 1.2MB: re-encode at 360p/300kbps → ~375KB for 10s
 * Hard cap: 10 seconds
 */

const COMPRESS_THRESHOLD = 1.2 * 1024 * 1024; // 1.2MB
const MAX_DURATION_S     = 10;
const TARGET_HEIGHT      = 360;   // 360p for small output
const VIDEO_BITRATE      = 300000; // 300kbps → ~375KB for 10s
const AUDIO_BITRATE      = 48000;  // 48kbps audio

export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file?.type?.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }

  onProgress(5);

  // Small enough — pass through, no re-encoding needed
  if (file.size < COMPRESS_THRESHOLD) {
    console.log(`[Pulse] Video ${(file.size/1024).toFixed(0)}KB < 1.2MB, skipping compression`);
    onProgress(100);
    return file;
  }

  console.log(`[Pulse] Compressing ${(file.size/1024/1024).toFixed(2)}MB video...`);
  return reencodeVideo(file, onProgress);
}

function reencodeVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const objectUrl   = URL.createObjectURL(file);
    const video       = document.createElement('video');
    video.muted       = true;
    video.playsInline = true;
    video.preload     = 'auto';
    video.src         = objectUrl;
    video.load();

    onProgress(8);

    video.addEventListener('error', () => {
      URL.revokeObjectURL(objectUrl);
      // Can't re-encode — return original with a warning toast
      console.warn('[Pulse] Cannot re-encode video, using original');
      resolve(file);
    });

    video.addEventListener('loadedmetadata', () => {
      const origW    = video.videoWidth  || 640;
      const origH    = video.videoHeight || 480;
      const maxDim   = Math.max(origW, origH);
      const scale    = maxDim > TARGET_HEIGHT ? TARGET_HEIGHT / maxDim : 1;
      const w        = Math.round(origW * scale / 2) * 2;
      const h        = Math.round(origH * scale / 2) * 2;
      const duration = Math.min(video.duration || MAX_DURATION_S, MAX_DURATION_S);

      onProgress(12);

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: false });

      // Pick best supported MIME type
      const mimes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4'
      ];
      const mime = mimes.find(m => {
        try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
      }) || 'video/webm';

      let stream, recorder;
      try {
        stream   = canvas.captureStream(24);
        recorder = new MediaRecorder(stream, {
          mimeType:           mime,
          videoBitsPerSecond: VIDEO_BITRATE,
          audioBitsPerSecond: AUDIO_BITRATE
        });
      } catch (e) {
        URL.revokeObjectURL(objectUrl);
        console.warn('[Pulse] MediaRecorder unavailable:', e.message);
        resolve(file); // fallback to original
        return;
      }

      const chunks = [];
      recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

      recorder.onstop = () => {
        URL.revokeObjectURL(objectUrl);
        const blob = new Blob(chunks, { type: mime });

        // If re-encoding made it bigger (rare), use original
        if (blob.size >= file.size) {
          console.log('[Pulse] Re-encoded was larger, using original');
          resolve(file);
          return;
        }

        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const out = new File(
          [blob],
          file.name.replace(/\.[^.]+$/, `.${ext}`),
          { type: mime }
        );
        const inKB  = (file.size / 1024).toFixed(0);
        const outKB = (out.size  / 1024).toFixed(0);
        console.log(`[Pulse] Video: ${inKB}KB → ${outKB}KB`);
        resolve(out);
      };

      recorder.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve(file); // fallback to original on error
      };

      let raf;
      const draw = () => {
        if (video.currentTime >= duration) {
          cancelAnimationFrame(raf);
          if (recorder.state === 'recording') recorder.stop();
          return;
        }
        try { ctx.drawImage(video, 0, 0, w, h); } catch {}
        const pct = Math.min(98, Math.round(12 + (video.currentTime / duration) * 86));
        onProgress(pct);
        raf = requestAnimationFrame(draw);
      };

      video.play().then(() => {
        recorder.start(200);
        raf = requestAnimationFrame(draw);
        video.onended = () => {
          cancelAnimationFrame(raf);
          if (recorder.state === 'recording') recorder.stop();
        };
      }).catch(() => {
        URL.revokeObjectURL(objectUrl);
        resolve(file); // can't play, use original
      });
    });
  });
}
