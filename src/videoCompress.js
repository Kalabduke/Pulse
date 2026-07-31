/**
 * Video compression — optimized for Vercel + Capacitor Android
 * Targets: 360p–480p stories, ~1–3MB per 15–30s clip
 *
 * Core files served from /public (committed to git, deployed by Vercel):
 *   /ffmpeg-core.js   — ffmpeg wasm bootstrap
 *   /ffmpeg-core.wasm — the actual WASM binary (~8MB, cached after first load)
 */

let ffmpegInstance = null;
let loadPromise    = null;

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise)    return loadPromise;

  loadPromise = (async () => {
    onProgress?.(2);

    const { FFmpeg }    = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');

    const ff = new FFmpeg();
    ff.on('log', ({ message }) => console.log('[FFmpeg]', message));

    await ff.load({
      coreURL: await toBlobURL('/ffmpeg-core.js',   'text/javascript'),
      wasmURL: await toBlobURL('/ffmpeg-core.wasm', 'application/wasm'),
    });

    ffmpegInstance = ff;
    onProgress?.(12);
    return ff;
  })();

  try {
    return await loadPromise;
  } catch (err) {
    loadPromise    = null;
    ffmpegInstance = null;
    throw err;
  }
}

/**
 * Compress video for story-style upload.
 * @param {File}     file
 * @param {Function} onProgress — 0 to 100
 * @returns {Promise<File>}
 */
export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file?.type?.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }

  // Reject massive files before touching WASM
  if (file.size > 150 * 1024 * 1024) {
    throw new Error('Video too large. Please pick a file under 150MB.');
  }

  const ff = await getFFmpeg(onProgress).catch(err => {
    console.error('[Pulse] FFmpeg load failed:', err);
    throw new Error(`Video compressor failed to load: ${err.message || err}. Please try again.`);
  });

  const { fetchFile } = await import('@ffmpeg/util');

  const ts         = Date.now();
  const ext        = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inputName  = `in_${ts}.${ext}`;
  const outputName = `out_${ts}.mp4`;

  // Progress: 12% (loaded) → 95% (encoding done)
  const progressHandler = ({ progress }) => {
    onProgress(Math.min(95, Math.round(12 + progress * 83)));
  };
  ff.on('progress', progressHandler);

  // ── Encoding settings ─────────────────────────────────────────────────────
  // Portrait 9:16 → 480×854. Landscape → 854×480.
  // Smart scale: makes the LARGER dimension = targetSize
  const targetSize   = 480;
  const videoBitrate = '1000k';   // ~1 Mbps — crisp at 480p, ~2MB for 15s
  const maxRate      = '1200k';
  const bufSize      = '2400k';
  const audioBitrate = '64k';

  // If height >= width (portrait), scale width to targetSize; else scale height
  const scaleFilter =
    `scale='if(gte(ih,iw),${targetSize},-2)':'if(gte(ih,iw),-2,${targetSize})',format=yuv420p`;

  try {
    await ff.writeFile(inputName, await fetchFile(file));
    onProgress(15);

    await ff.exec([
      '-i',        inputName,
      '-vf',       scaleFilter,
      '-c:v',      'libx264',
      '-preset',   'ultrafast',
      '-b:v',      videoBitrate,
      '-maxrate',  maxRate,
      '-bufsize',  bufSize,
      '-c:a',      'aac',
      '-b:a',      audioBitrate,
      '-ar',       '44100',
      '-ac',       '2',
      '-movflags', '+faststart',
      '-t',        '60',          // hard cap at 60s
      '-y',
      outputName
    ]);

    onProgress(96);

    const data = await ff.readFile(outputName);

    // Cleanup WASM virtual FS
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
    ff.off('progress', progressHandler);

    const blob       = new Blob([data], { type: 'video/mp4' });
    const compressed = new File(
      [blob],
      file.name.replace(/\.[^.]+$/, '.mp4'),
      { type: 'video/mp4' }
    );

    const before = (file.size      / 1024 / 1024).toFixed(2);
    const after  = (compressed.size / 1024 / 1024).toFixed(2);
    console.log(`[Pulse] Video: ${before}MB → ${after}MB`);

    onProgress(100);
    return compressed;

  } catch (err) {
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
    ff.off('progress', progressHandler);
    console.error('[Pulse] FFmpeg exec error:', err);
    throw new Error("Couldn't compress this video. It may be an unsupported format.");
  }
}
