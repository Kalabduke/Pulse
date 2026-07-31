/**
 * Client-side video compression using MediaRecorder + canvas
 *
 * All videos: attempt re-encode at 360p/300kbps → target ~400KB for 10s
 * If browser can't decode (MOV/HEVC on some browsers): reject with clear message
 * Hard cap: 10 seconds (longer clips trimmed)
 */

const MAX_DURATION_S = 10;
const TARGET_HEIGHT  = 360;
const VIDEO_BITRATE  = 300000; // 300kbps
const AUDIO_BITRATE  = 48000;  // 48kbps

export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file?.type?.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }

  onProgress(5);

  const sizeMB = file.size / 1024 / 1024;
  console.log(`[Pulse] Video input: ${sizeMB.toFixed(2)}MB, type: ${file.type}`);

  // Always try to compress — even small files benefit from trimming to 10s
  return reencodeVideo(file, onProgress);
}

function reencodeVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const objectUrl   = URL.createObjectURL(file);
    const video       = document.createElement('video');
    video.muted       = true;
    video.playsInline = true;
    video.preload     = 'metadata';

    onProgress(8);

    // Timeout: if video doesn't load metadata in 15s, reject
    const loadTimeout = setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Can't process this video format. Please convert to MP4 first."));
    }, 15000);

    video.addEventListener('error', () => {
      clearTimeout(loadTimeout);
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Can't read this video. Please use MP4 format."));
    });

    video.addEventListener('loadedmetadata', () => {
      clearTimeout(loadTimeout);

      const origW    = video.videoWidth  || 640;
      const origH    = video.videoHeight || 480;
      const maxDim   = Math.max(origW, origH);
      const scale    = maxDim > TARGET_HEIGHT ? TARGET_HEIGHT / maxDim : 1;
      const w        = Math.round(origW * scale / 2) * 2 || 640;
      const h        = Math.round(origH * scale / 2) * 2 || 360;
      const duration = Math.min(video.duration || MAX_DURATION_S, MAX_DURATION_S);

      onProgress(12);
      console.log(`[Pulse] Encoding ${w}x${h}, ${duration.toFixed(1)}s`);

      const canvas = document.createElement('canvas');
      canvas.width  = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: false });

      const mimes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
      const mime = mimes.find(m => {
        try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
      });

      if (!mime) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Video compression not supported on this browser. Please use Chrome or Firefox."));
        return;
      }

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
        reject(new Error(`Can't compress video: ${e.message}`));
        return;
      }

      const chunks = [];
      recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

      recorder.onstop = () => {
        URL.revokeObjectURL(objectUrl);
        const blob = new Blob(chunks, { type: mime });

        if (blob.size === 0) {
          reject(new Error("Video compression produced empty output. Please try a different video."));
          return;
        }

        const out = new File(
          [blob],
          file.name.replace(/\.[^.]+$/, '.webm'),
          { type: mime }
        );
        const inKB  = (file.size / 1024).toFixed(0);
        const outKB = (out.size  / 1024).toFixed(0);
        console.log(`[Pulse] Video: ${inKB}KB → ${outKB}KB`);
        onProgress(100);
        resolve(out);
      };

      recorder.onerror = (e) => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error(`Recording failed: ${e.error?.message || 'unknown error'}`));
      };

      // Play video and draw frames to canvas
      video.play().then(() => {
        recorder.start(200);
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

        raf = requestAnimationFrame(draw);

        video.onended = () => {
          cancelAnimationFrame(raf);
          if (recorder.state === 'recording') recorder.stop();
        };

      }).catch((e) => {
        URL.revokeObjectURL(objectUrl);
        // video.play() failed — likely unsupported codec (MOV/HEVC)
        reject(new Error("Can't play this video format in browser. Please use MP4."));
      });

      // Also set src now so it starts loading
      video.src = objectUrl;
    });

    video.src = objectUrl;
  });
}
