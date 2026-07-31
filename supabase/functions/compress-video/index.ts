/**
 * Supabase Edge Function: compress-video
 * Receives a raw video file path in Supabase storage,
 * runs FFmpeg to compress it to 480p/640kbps,
 * stores compressed version, deletes original,
 * returns the compressed public URL.
 *
 * Deploy: supabase functions deploy compress-video
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE = Deno.env.get('SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      }
    });
  }

  try {
    const { inputPath } = await req.json() as { inputPath: string };

    if (!inputPath) {
      return json({ error: 'inputPath required' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE);

    // Download the raw video from storage
    const { data: fileData, error: dlErr } = await supabase
      .storage
      .from('pulse-images')
      .download(inputPath);

    if (dlErr || !fileData) {
      return json({ error: `Download failed: ${dlErr?.message}` }, 500);
    }

    const inputBytes = new Uint8Array(await fileData.arrayBuffer());

    // Write input to a temp file
    const tmpIn  = `/tmp/input_${Date.now()}.mp4`;
    const tmpOut = `/tmp/output_${Date.now()}.mp4`;

    await Deno.writeFile(tmpIn, inputBytes);

    // Run FFmpeg: 480p, 640kbps video, 64kbps audio, max 10 seconds
    const ffmpegCmd = new Deno.Command('ffmpeg', {
      args: [
        '-i', tmpIn,
        '-vf', "scale='if(gte(ih,iw),480,-2)':'if(gte(ih,iw),-2,480)',format=yuv420p",
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-b:v', '640k',
        '-maxrate', '800k',
        '-bufsize', '1600k',
        '-c:a', 'aac',
        '-b:a', '64k',
        '-ar', '44100',
        '-movflags', '+faststart',
        '-t', '10',
        '-y',
        tmpOut
      ],
      stdout: 'piped',
      stderr: 'piped',
    });

    const { code, stderr } = await ffmpegCmd.output();

    if (code !== 0) {
      const errText = new TextDecoder().decode(stderr);
      console.error('FFmpeg failed:', errText);
      // Clean up
      await Deno.remove(tmpIn).catch(() => {});
      return json({ error: 'FFmpeg compression failed', details: errText.slice(-500) }, 500);
    }

    // Read compressed output
    const compressedBytes = await Deno.readFile(tmpOut);

    // Clean up temp files
    await Deno.remove(tmpIn).catch(() => {});
    await Deno.remove(tmpOut).catch(() => {});

    // Upload compressed file to storage (replace original path with .mp4 extension)
    const outputPath = inputPath.replace(/\.[^.]+$/, '_compressed.mp4');

    const { error: upErr } = await supabase
      .storage
      .from('pulse-images')
      .upload(outputPath, compressedBytes, {
        contentType: 'video/mp4',
        upsert: true,
      });

    if (upErr) {
      return json({ error: `Upload failed: ${upErr.message}` }, 500);
    }

    // Delete the original raw file
    await supabase.storage.from('pulse-images').remove([inputPath]);

    // Get public URL
    const { data: { publicUrl } } = supabase
      .storage
      .from('pulse-images')
      .getPublicUrl(outputPath);

    const inKB  = Math.round(inputBytes.length / 1024);
    const outKB = Math.round(compressedBytes.length / 1024);
    console.log(`Compressed: ${inKB}KB → ${outKB}KB`);

    return json({ url: publicUrl, inputKB: inKB, outputKB: outKB });

  } catch (err) {
    console.error('compress-video error:', err);
    return json({ error: String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    }
  });
}
