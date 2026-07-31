/**
 * Video compression using ffmpeg.wasm
 * Target: 10s max, ~800KB output, 480p H.264
 * WASM cached in IndexedDB after first download so subsequent loads are instant.
 */

const WASM_CACHE_KEY = 'pulse-ffmpeg-wasm-v1';
const JS_CACHE_KEY   = 'pulse-ffmpeg-js-v1';

// Cache WASM in IndexedDB so we only download it once ever
async function getCachedFile(key, url, onProgress, startPct, endPct) {
  // Try IndexedDB first
  try {
    const db  = await openCache();
    const buf = await dbGet(db, key);
    if (buf) {
      onProgress?.(endPct);
      return buf;
    }
  } catch {}

  // Not cached — fetch with progress
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  const total  = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let   loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (total > 0 && onProgress) {
      const pct = Math.round(startPct + ((loaded / total) * (endPct - startPct)));
      onProgress(Math.min(endPct, pct));
    }
  }

  // Merge chunks
  const merged = new Uint8Array(loaded);
  let   offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }

  // Cache in IndexedDB
  try {
    const db = await openCache();
    await dbPut(db, key, merged.buffer);
  } catch {}

  onProgress?.(endPct);
  return merged.buffer;
}

// Tiny IndexedDB helpers
function openCache() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('pulse-ffmpeg', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('files');
    req.onsuccess = e => res(e.target.result);
    req.onerror   = ()  => rej(new Error('IndexedDB unavailable'));
  });
}
function dbGet(db, key) {
  return new Promise((res, rej) => {
    const req = db.transaction('files').objectStore('files').get(key);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = ()  => rej();
  });
}
function dbPut(db, key, val) {
  return new Promise((res, rej) => {
    const req = db.transaction('files', 'readwrite').objectStore('files').put(val, key);
    req.onsuccess = () => res();
    req.onerror   = ()  => rej();
  });
}

let ffmpegInstance = null;
let loadPromise    = null;

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise)    return loadPromise;

  loadPromise = (async () => {
    onProgress?.(2);

    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    onProgress?.(5);

    // Download (or load from IndexedDB cache) with progress
    // JS: 5→25%, WASM: 25→85%
    const [jsBuffer, wasmBuffer] = await Promise.all([
      getCachedFile(JS_CACHE_KEY,   '/ffmpeg-core.js',   onProgress, 5,  25),
      getCachedFile(WASM_CACHE_KEY, '/ffmpeg-core.wasm', onProgress, 25, 85),
    ]);

    onProgress?.(86);

    const jsBlob  = new Blob([jsBuffer],   { type: 'text/javascript'  });
    const coreURL = URL.createObjectURL(jsBlob);

    const ff = new FFmpeg();
    ff.on('log', ({ message }) => console.log('[FFmpeg]', message));

    await ff.load({
      coreURL,
      wasmURL: new Uint8Array(wasmBuffer),
    });

    URL.revokeObjectURL(coreURL);

    onProgress?.(90);
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

/**
 * Compress video: 10s max, ~800KB output, 480p H.264
 * @param {File}     file
 * @param {Function} onProgress  0-100
 * @returns {Promise<File>}
 */
export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file?.type?.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }
  if (file.size > 200 * 1024 * 1024) {
    throw new Error('Video too large. Max 200MB input.');
  }

  const ff = await getFFmpeg(onProgress).catch(err => {
    console.error('[Pulse] FFmpeg load failed:', err);
    const msg = err?.message || String(err);
    throw new Error(`Can't compress video right now. Please try again. (${msg})`);
  });

  const { fetchFile } = await import('@ffmpeg/util');

  const ts         = Date.now();
  const ext        = (file.name.split('.').pop() || 'mp4').toLowerCase();
  const inputName  = `in_${ts}.${ext}`;
  const outputName = `out_${ts}.mp4`;

  // Progress: 90% (loaded) → 98% (encoding done)
  const progressHandler = ({ progress }) => {
    onProgress(Math.min(98, Math.round(90 + progress * 8)));
  };
  ff.on('progress', progressHandler);

  try {
    await ff.writeFile(inputName, await fetchFile(file));

    // Smart scale: larger dimension → 480p (handles portrait + landscape)
    const scaleFilter =
      `scale='if(gte(ih,iw),480,-2)':'if(gte(ih,iw),-2,480)',format=yuv420p`;

    // 10s cap, ~640kbps video + 64kbps audio = ~800KB total for 10s
    await ff.exec([
      '-i',        inputName,
      '-vf',       scaleFilter,
      '-c:v',      'libx264',
      '-preset',   'ultrafast',
      '-b:v',      '640k',
      '-maxrate',  '800k',
      '-bufsize',  '1600k',
      '-c:a',      'aac',
      '-b:a',      '64k',
      '-ar',       '44100',
      '-ac',       '2',
      '-movflags', '+faststart',
      '-t',        '10',          // hard cap: 10 seconds
      '-y',
      outputName
    ]);

    onProgress(99);
    const data = await ff.readFile(outputName);
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
    ff.off('progress', progressHandler);

    const blob       = new Blob([data], { type: 'video/mp4' });
    const compressed = new File([blob], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' });

    const inMB  = (file.size      / 1024 / 1024).toFixed(2);
    const outKB = (compressed.size / 1024).toFixed(0);
    console.log(`[Pulse] Video: ${inMB}MB → ${outKB}KB`);

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
