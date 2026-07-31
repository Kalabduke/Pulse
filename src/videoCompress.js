/**
 * Video compression using ffmpeg.wasm 0.12
 * Passes WASM binary directly as Uint8Array — no blob URL path issues.
 */

let ffmpegInstance = null;
let loadPromise    = null;

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise)    return loadPromise;

  loadPromise = (async () => {
    onProgress?.(3);

    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    onProgress?.(7);

    // Fetch both files
    const [jsRes, wasmRes] = await Promise.all([
      fetch('/ffmpeg-core.js'),
      fetch('/ffmpeg-core.wasm'),
    ]);

    if (!jsRes.ok)   throw new Error(`ffmpeg-core.js fetch failed: ${jsRes.status}`);
    if (!wasmRes.ok) throw new Error(`ffmpeg-core.wasm fetch failed: ${wasmRes.status}`);

    onProgress?.(13);

    const jsText    = await jsRes.text();
    const wasmBytes = await wasmRes.arrayBuffer();

    onProgress?.(17);

    // Create blob URL for JS — needed so ff.load() can eval it
    const jsBlob  = new Blob([jsText], { type: 'text/javascript' });
    const coreURL = URL.createObjectURL(jsBlob);

    const ff = new FFmpeg();
    ff.on('log', ({ message }) => console.log('[FFmpeg]', message));

    // Pass WASM as Uint8Array directly — bypasses the relative path resolution
    await ff.load({
      coreURL,
      wasmURL:  new Uint8Array(wasmBytes),
    });

    URL.revokeObjectURL(coreURL);

    onProgress?.(22);
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
    const msg = err?.message || String(err) || 'unknown error';
    throw new Error(`Can't upload video right now (${msg}). Please try again.`);
  });

  const { fetchFile } = await import('@ffmpeg/util');

  const ts         = Date.now();
  const ext        = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inputName  = `in_${ts}.${ext}`;
  const outputName = `out_${ts}.mp4`;

  const progressHandler = ({ progress }) => {
    onProgress(Math.min(95, Math.round(22 + progress * 73)));
  };
  ff.on('progress', progressHandler);

  try {
    await ff.writeFile(inputName, await fetchFile(file));
    onProgress(24);

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
