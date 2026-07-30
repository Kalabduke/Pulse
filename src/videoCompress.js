/**
 * Video compression using ffmpeg.wasm (single-threaded core)
 * Does NOT require SharedArrayBuffer / COOP / COEP headers.
 * Works on all browsers and devices without special server config.
 *
 * Target: 480p H.264, ~200kbps → ~400-600KB for a 15s clip
 */

let ffmpegInstance = null;
let loadPromise = null;

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onProgress?.(2);

    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');

    onProgress?.(5);

    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      // Uncomment for debugging:
      // console.log('[FFmpeg]', message);
    });

    // Use single-threaded core — no SharedArrayBuffer required
    // Files served from the npm package via Vite's asset pipeline
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

    onProgress?.(8);

    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });

    onProgress?.(15);
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise = null;
    ffmpegInstance = null;
    throw err;
  }
}

/**
 * Compress a video to 480p H.264 MP4.
 * Throws with "Can't upload now" style message on failure.
 *
 * @param {File} file - input video
 * @param {Function} onProgress - 0-100 integer callback
 * @returns {Promise<File>} compressed MP4
 */
export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file.type.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }

  let ffmpeg;
  try {
    ffmpeg = await getFFmpeg(onProgress);
  } catch (err) {
    throw new Error("Can't compress video right now. Please try again.");
  }

  const { fetchFile } = await import('@ffmpeg/util');

  const ts         = Date.now();
  const ext        = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inputName  = `in_${ts}.${ext}`;
  const outputName = `out_${ts}.mp4`;

  // Remove stale progress listeners
  ffmpeg.off('progress');

  // Map ffmpeg's 0-1 progress to 15-95%
  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.min(95, Math.round(15 + (progress * 80)));
    onProgress(pct);
  });

  try {
    onProgress(16);
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    onProgress(20);

    await ffmpeg.exec([
      '-i', inputName,
      '-vf', 'scale=-2:480',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-b:v', '200k',
      '-maxrate', '300k',
      '-bufsize', '600k',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ar', '44100',
      '-movflags', '+faststart',
      '-y',
      outputName
    ]);

    onProgress(96);

    const data       = await ffmpeg.readFile(outputName);
    const blob       = new Blob([data], { type: 'video/mp4' });
    const compressed = new File(
      [blob],
      file.name.replace(/\.[^.]+$/, '.mp4'),
      { type: 'video/mp4' }
    );

    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
    ffmpeg.off('progress');

    console.log(
      `[Pulse] Video: ${(file.size/1024).toFixed(0)}KB → ${(compressed.size/1024).toFixed(0)}KB`
    );

    onProgress(100);
    return compressed;

  } catch (err) {
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
    ffmpeg.off('progress');

    console.error('[Pulse] FFmpeg error:', err);
    throw new Error("Can't upload video right now. Please try again.");
  }
}
