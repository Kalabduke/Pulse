/**
 * Video upload via Cloudinary
 * - Accepts ANY format (MOV, MP4, HEVC, AVI, MKV, 3GP, WebM...)
 * - Cloudinary compresses server-side to H.264 MP4
 * - Returns a compressed URL with transformations applied
 * - Free tier: 25GB storage, 25GB bandwidth/month
 */

const CLOUDINARY_CLOUD  = 'vknwfft5';
const CLOUDINARY_PRESET = 'pulse_video';

// Transformation string applied to the delivery URL:
// w_854,h_480 = max 854x480 (landscape) or 480x854 (portrait)
// c_limit     = only downscale, never upscale
// vc_h264     = H.264 codec
// br_640k     = 640kbps video bitrate → ~800KB for 10s
// du_10       = trim to 10 seconds max
// f_mp4       = output as MP4
// q_auto:low  = auto quality, targeting small file size
const TRANSFORM = 'w_854,h_480,c_limit,vc_h264,br_640k,du_10,f_mp4,q_auto:low';

/**
 * Upload video to Cloudinary with server-side compression.
 * @param {File}     file
 * @param {Function} onProgress  0-100 integer
 * @returns {Promise<{file: File, url: string}>}
 *   file = a 1-byte placeholder File (actual video is on Cloudinary CDN)
 *   url  = the compressed Cloudinary delivery URL
 */
export async function compressVideoFFmpeg(file, onProgress = () => {}) {
  if (!file) throw new Error('No file provided.');

  const isVideo = file.type.startsWith('video/') ||
    /\.(mp4|mov|webm|avi|mkv|m4v|3gp|hevc|heic)$/i.test(file.name);

  if (!isVideo) throw new Error('Only video files are allowed.');

  onProgress(5);

  // Build the upload URL
  const uploadURL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`;

  const form = new FormData();
  form.append('file',         file);
  form.append('upload_preset', CLOUDINARY_PRESET);
  form.append('folder',       'pulse');
  // Request eager transformation so the compressed version is ready immediately
  form.append('eager',        TRANSFORM);
  form.append('eager_async',  'false');

  onProgress(10);

  // Upload with XHR so we get real progress
  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        // Upload is 10-80%, processing is 80-100%
        const pct = Math.round(10 + (e.loaded / e.total) * 70);
        onProgress(pct);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid response from Cloudinary'));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error?.message || `Upload failed: ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      }
    };

    xhr.onerror   = () => reject(new Error("Can't upload video. Check your connection."));
    xhr.ontimeout = () => reject(new Error('Upload timed out. Please try again.'));
    xhr.timeout   = 120000; // 2 min timeout

    xhr.open('POST', uploadURL);
    xhr.send(form);
  });

  onProgress(90);

  // Use the eager transformation URL if available, otherwise build it from public_id
  let deliveryUrl;
  if (result.eager?.[0]?.secure_url) {
    deliveryUrl = result.eager[0].secure_url;
  } else {
    // Build transformation URL from public_id
    const publicId = result.public_id;
    deliveryUrl = `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/video/upload/${TRANSFORM}/${publicId}.mp4`;
  }

  const inMB  = (file.size / 1024 / 1024).toFixed(2);
  const outKB = result.eager?.[0]?.bytes
    ? (result.eager[0].bytes / 1024).toFixed(0) + 'KB'
    : 'processing';

  console.log(`[Pulse] Cloudinary: ${inMB}MB → ${outKB} | ${deliveryUrl}`);

  onProgress(100);

  // Return the delivery URL so uploadStatusImage can store it
  // Also return a tiny placeholder File so existing code doesn't break
  const placeholder = new File([''], file.name.replace(/\.[^.]+$/, '.mp4'), { type: 'video/mp4' });
  placeholder._cloudinaryUrl = deliveryUrl;

  return placeholder;
}
