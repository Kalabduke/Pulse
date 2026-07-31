/**
 * Supabase Edge Function: compress-video
 * Accepts multipart form upload of ANY video format.
 * Uses ffmpeg via npm (esm.sh) to compress to MP4 480p.
 * Returns the compressed file as binary response.
 *
 * Client sends: POST multipart/form-data with 'video' field
 * Server returns: compressed MP4 binary
 */

// @ts-ignore
import { createFFmpeg, fetchFile } from 'https://esm.sh/@ffmpeg/ffmpeg@0.11.6';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const videoFile = formData.get('video') as File | null;

    if (!videoFile) {
      return new Response(JSON.stringify({ error: 'No video file provided' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ext      = videoFile.name.split('.').pop()?.toLowerCase() || 'mp4';
    const inputBuf = new Uint8Array(await videoFile.arrayBuffer());

    console.log(`Input: ${(inputBuf.length / 1024 / 1024).toFixed(2)}MB .${ext}`);

    // Initialise ffmpeg WASM (single-threaded, no SharedArrayBuffer needed)
    const ffmpeg = createFFmpeg({
      log: true,
      corePath: 'https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
    });
    await ffmpeg.load();

    const inputName  = `input.${ext}`;
    const outputName = 'output.mp4';

    ffmpeg.FS('writeFile', inputName, inputBuf);

    await ffmpeg.run(
      '-i', inputName,
      '-vf', "scale='if(gte(ih,iw),480,-2)':'if(gte(ih,iw),-2,480)',format=yuv420p",
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-b:v', '640k',
      '-maxrate', '800k',
      '-bufsize', '1600k',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-ar',  '44100',
      '-movflags', '+faststart',
      '-t', '10',
      '-y',
      outputName
    );

    const outputData = ffmpeg.FS('readFile', outputName);
    ffmpeg.FS('unlink', inputName);
    ffmpeg.FS('unlink', outputName);

    const outKB = (outputData.length / 1024).toFixed(0);
    const inKB  = (inputBuf.length  / 1024).toFixed(0);
    console.log(`Output: ${inKB}KB → ${outKB}KB`);

    return new Response(outputData.buffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type':        'video/mp4',
        'Content-Disposition': 'inline; filename="compressed.mp4"',
        'X-Input-KB':  inKB,
        'X-Output-KB': outKB,
      }
    });

  } catch (err) {
    console.error('compress-video error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
