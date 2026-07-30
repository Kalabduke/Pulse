/**
 * Video compression using ffmpeg.wasm
 * Lazy-loaded — the 25MB WASM binary is only downloaded when the user
 * actually picks a video. After the first download it's cached forever.
 *
 * Target: 480p H.264, ~200kbps video + 64kbps AAC audio
 * Result: ~400-600KB for a 15-second clip
 */

let ffmpegInstance = null;
let isLoading = false;
let loadPromise = null;

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;

  isLoading = true;
  loadPromise = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');

    const ffmpeg = new FFmpeg();

    // Load the core WASM files from CDN (cached after first load)
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL:   await toBlobURL(`${baseURL}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL:   await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      workerURL: await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, 'text/javascript'),
    });

    ffmpegInstance = ffmpeg;
    isLoading = false;
    return ffmpeg;
  })();

  return loadPromise;
}

/**
 * Compress a video file to 480p H.264 MP4
 * @param {File} file - input video file
 * @param {Function} onProgress - called with 0-100 progress value
 * @returns {Promise<File>} compressed video file
 */
export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file.type.startsWith('video/')) {
    throw new Error('Only video files are allowed.');
  }

  let ffmpeg;
  try {
    onProgress(5);
    ffmpeg = await getFFmpeg();
  } catch (err) {
    console.warn('[Pulse] ffmpeg.wasm failed to load, using original:', err.message);
    return file; // fallback: upload original
  }

  const { fetchFile } = await import('@ffmpeg/util');

  const inputName  = `input_${Date.now()}.${file.name.split('.').pop() || 'mp4'}`;
  const outputName = `output_${Date.now()}.mp4`;

  try {
    onProgress(10);

    // Write input file to ffmpeg virtual FS
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    onProgress(20);

    // Listen to ffmpeg progress events
    ffmpeg.on('progress', ({ progress }) => {
      // progress is 0-1
      const pct = Math.round(20 + progress * 70); // 20-90%
      onProgress(pct);
    });

    // H.264 480p, 200kbps video, 64kbps AAC audio
    // -vf scale: keep aspect ratio, height=480, width divisible by 2
    // -movflags faststart: makes MP4 streamable (plays while downloading)
    await ffmpeg.exec([
      '-i', inputName,
      '-vf', 'scale=-2:480',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',   // fastest encoding on device
      '-crf', '28',             // quality (23=great, 28=good, 32=acceptable)
      '-b:v', '200k',
      '-maxrate', '300k',
      '-bufsize', '400k',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', '+faststart',
      '-y',
      outputName
    ]);

    onProgress(92);

    // Read output
    const data = await ffmpeg.readFile(outputName);
    onProgress(97);

    // Cleanup virtual FS
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});

    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    const compressed = new File(
      [blob],
      file.name.replace(/\.[^.]+$/, '.mp4'),
      { type: 'video/mp4' }
    );

    onProgress(100);

    // If compression somehow made it bigger, return original
    return compressed.size < file.size ? compressed : file;

  } catch (err) {
    // Cleanup on error
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
    console.warn('[Pulse] FFmpeg compression failed, using original:', err.message);
    return file; // fallback: upload original
  }
}
