/**
 * Video compression using ffmpeg.wasm
 * Loads core files directly as ArrayBuffer — avoids toBlobURL path issues.
 */

let ffmpegInstance = null;
let loadPromise    = null;

async function fetchAsBlob(url, mimeType) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf  = await res.arrayBuffer();
  return new Blob([buf], { type: mimeType });
}

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise)    return loadPromise;

  loadPromise = (async () => {
    onProgress?.(3);

    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    onProgress?.(7);

    const ff = new FFmpeg();
    ff.on('log', ({ message }) => console.log('[FFmpeg]', message));

    onProgress?.(10);

    // Fetch both files ourselves so we control the blob URLs
    const [coreBlob, wasmBlob] = await Promise.all([
      fetchAsBlob('/ffmpeg-core.js',   'text/javascript'),
      fetchAsBlob('/ffmpeg-core.wasm', 'application/wasm'),
    ]);

    onProgress?.(14);

    const coreURL = URL.createObjectURL(coreBlob);
    const wasmURL = URL.createObjectURL(wasmBlob);

    await ff.load({ coreURL, wasmURL });

    // Revoke after load — ffmpeg has already read them
    URL.revokeObjectURL(coreURL);
    URL.revokeObjectURL(wasmURL);

    onProgress?.(20);
    ffmpegInstance = ff;
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

export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file?.type?.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }
  if (file.size > 150 * 1024 * 1024) {
    throw new Error('Video too large. Max 150MB.');
  }

  const ff = await getFFmpeg(onProgress).catch(err => {
    console.error('[Pulse] FFmpeg load failed:', err);
    throw new Error(`Can't upload video right now. Please try again. (${err.message})`);
  });

  const { fetchFile } = await import('@ffmpeg/util');

  const ts         = Date.now();
  const ext        = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inputName  = `in_${ts}.${ext}`;
  const outputName = `out_${ts}.mp4`;

  const progressHandler = ({ progress }) => {
    onProgress(Math.min(95, Math.round(20 + progress * 75)));
  };
  ff.on('progress', progressHandler);

  try {
    await ff.writeFile(inputName, await fetchFile(file));
    onProgress(22);

    // Smart scale: larger dimension → 480, handles both portrait and landscape
    const scaleFilter =
      `scale='if(gte(ih,iw),480,-2)':'if(gte(ih,iw),-2,480)',format=yuv420p`;

    await ff.exec([
      '-i',        inputName,
      '-vf',       scaleFilter,
      '-c:v',      'libx264',
      '-preset',   'ultrafast',
      '-b:v',      '1000k',
      '-maxrate',  '1200k',
      '-bufsize',  '2400k',
      '-c:a',      'aac',
      '-b:a',      '64k',
      '-ar',       '44100',
      '-ac',       '2',
      '-movflags', '+faststart',
      '-t',        '60',
      '-y',
      outputName
    ]);

    onProgress(96);
    const data = await ff.readFile(outputName);
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
    ff.off('progress', progressHandler);

    const blob       = new Blob([data], { type: 'video/mp4' });
    const compressed = new File([blob], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' });

    console.log(`[Pulse] ${(file.size/1024/1024).toFixed(2)}MB → ${(compressed.size/1024/1024).toFixed(2)}MB`);
    onProgress(100);
    return compressed;

  } catch (err) {
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
    ff.off('progress', progressHandler);
    console.error('[Pulse] FFmpeg exec error:', err);
    throw new Error("Can't upload video right now. Please try again.");
  }
}
