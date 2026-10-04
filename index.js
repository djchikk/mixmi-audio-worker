const Fastify = require('fastify');
const cors = require('@fastify/cors');
const ffmpeg = require('fluent-ffmpeg');
const { writeFile, unlink, mkdir } = require('fs/promises');
const { existsSync } = require('fs');
const { createReadStream } = require('fs');
const path = require('path');
const crypto = require('crypto');
const { videoHasMetadata, stripVideoMetadata, streamSummary, sameContent } = require('./lib/stripVideoMetadata');
const { SECRET_HEADER, secretOk, allowedStorageUrl, downloadCapped, TooLargeError } = require('./lib/guards');

// Use system FFmpeg (installed via apt in Dockerfile)

const app = Fastify({ logger: true });

// Enable CORS for mixmi frontend
app.register(cors, {
  origin: [
    'http://localhost:3000',
    'https://mixmi.io',
    'https://www.mixmi.io',
    /\.vercel\.app$/,
  ],
});

// Every endpoint that does work requires the shared secret (MEDIA_WORKER_SECRET,
// sent by mixmi's server as x-mixmi-worker-secret; constant-time compare). With
// no secret configured the worker refuses all work. Open: the two liveness GETs
// (static status, no data, no work) and CORS preflight.
const OPEN_ROUTES = new Set(['GET /', 'GET /health']);
app.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') return;
  const route = `${request.method} ${request.url.split('?')[0]}`;
  if (OPEN_ROUTES.has(route)) return;
  const secret = process.env.MEDIA_WORKER_SECRET;
  if (!secret) return reply.status(503).send({ error: 'Worker not configured' });
  if (!secretOk(request.headers[SECRET_HEADER], secret)) return reply.status(401).send({ error: 'Unauthorized' });
});

// FFmpeg filter chains for each enhancement type
// afftdn = FFT-based denoiser, nf = noise floor (dB), nr = noise reduction amount
// crystalizer = transient/clarity enhancement, asubboost = bass boost
const ENHANCEMENT_FILTERS = {
  auto: 'highpass=f=80,afftdn=nf=-25:nr=10,compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-45|-27/-25|0/-10,loudnorm=I=-14:TP=-1:LRA=11',
  voice: 'highpass=f=100,afftdn=nf=-20:nr=15,compand=attacks=0.2:decays=0.6:points=-80/-80|-45/-45|-27/-22|0/-8,loudnorm=I=-16:TP=-1:LRA=9',
  clean: 'highpass=f=80,afftdn=nf=-20:nr=20,loudnorm=I=-14:TP=-1:LRA=11',
  warm: 'highpass=f=60,afftdn=nf=-30:nr=8,equalizer=f=100:t=q:w=1:g=2,compand=attacks=0.4:decays=1.0:points=-80/-80|-45/-45|-27/-24|0/-8,loudnorm=I=-14:TP=-1:LRA=11',
  studio: 'highpass=f=40,afftdn=nf=-25:nr=12,equalizer=f=60:t=q:w=1:g=1,equalizer=f=10000:t=q:w=1:g=1,compand=attacks=0.2:decays=0.6:points=-80/-80|-50/-50|-30/-26|-10/-10|0/-6,loudnorm=I=-14:TP=-1:LRA=9',
  punchy: 'highpass=f=60,afftdn=nf=-25:nr=10,crystalizer=i=2,asubboost=dry=0.7:wet=0.3:decay=0.5:feedback=0.4:cutoff=100,compand=attacks=0.1:decays=0.4:points=-80/-80|-45/-45|-27/-20|0/-8,loudnorm=I=-12:TP=-1:LRA=9',
};

// Video transcode guards
const MAX_VIDEO_INPUT_BYTES = 200 * 1024 * 1024; // 200MB input cap
const MAX_VIDEO_DURATION_SEC = 600; // 10 minute cap
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000; // kill runaway encodes

// Health check
app.get('/', async () => {
  return { status: 'ok', service: 'mixmi-audio-worker' };
});

app.get('/health', async () => {
  return { status: 'healthy', ffmpeg: true };
});

// Main enhancement endpoint
app.post('/enhance', async (request, reply) => {
  const { sourceUrl, enhancementType = 'auto' } = request.body;

  if (!sourceUrl) {
    return reply.status(400).send({ error: 'sourceUrl is required' });
  }

  if (!ENHANCEMENT_FILTERS[enhancementType]) {
    return reply.status(400).send({ error: 'Invalid enhancementType' });
  }

  const tempFiles = [];
  const jobId = crypto.randomUUID();

  try {
    app.log.info({ jobId, sourceUrl, enhancementType }, 'Starting enhancement');

    // Ensure temp directory exists
    const tempDir = '/tmp/enhance';
    if (!existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true });
    }

    // Download source audio
    app.log.info({ jobId }, 'Downloading source audio...');
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    app.log.info({ jobId, size: audioBuffer.length }, 'Downloaded audio');

    // Determine input format
    const inputExt = sourceUrl.includes('.wav') ? 'wav' :
                     sourceUrl.includes('.webm') ? 'webm' :
                     sourceUrl.includes('.mp3') ? 'mp3' : 'wav';

    const inputPath = path.join(tempDir, `input-${jobId}.${inputExt}`);
    const outputPath = path.join(tempDir, `output-${jobId}.wav`);
    tempFiles.push(inputPath, outputPath);

    // Write input file
    await writeFile(inputPath, audioBuffer);

    // Process with FFmpeg
    app.log.info({ jobId, enhancementType }, 'Processing with FFmpeg...');
    const filterChain = ENHANCEMENT_FILTERS[enhancementType];

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters(filterChain)
        .audioCodec('pcm_s16le')
        .audioFrequency(48000)
        .audioChannels(1)
        .format('wav')
        .on('start', (cmd) => app.log.info({ jobId, cmd }, 'FFmpeg started'))
        .on('error', (err) => reject(err))
        .on('end', () => resolve())
        .save(outputPath);
    });

    app.log.info({ jobId }, 'FFmpeg processing complete');

    // Read and return the enhanced file
    const { readFile } = require('fs/promises');
    const enhancedBuffer = await readFile(outputPath);

    app.log.info({ jobId, inputSize: audioBuffer.length, outputSize: enhancedBuffer.length }, 'Enhancement complete');

    // Cleanup temp files
    for (const f of tempFiles) {
      try { await unlink(f); } catch (e) { /* ignore */ }
    }

    // Return the enhanced audio as WAV
    reply.header('Content-Type', 'audio/wav');
    reply.header('Content-Disposition', `attachment; filename="enhanced-${jobId}.wav"`);
    return reply.send(enhancedBuffer);

  } catch (error) {
    app.log.error({ jobId, error: error.message }, 'Enhancement failed');

    // Cleanup on error
    for (const f of tempFiles) {
      try { await unlink(f); } catch (e) { /* ignore */ }
    }

    return reply.status(500).send({ error: error.message });
  }
});

// Video transcode endpoint: webm (or anything ffmpeg reads) → iPhone-safe MP4.
// H.264 main profile + AAC, faststart, CFR 30, capped at 1280px wide.
// Stateless like /enhance: the caller supplies a Supabase signed upload URL;
// the worker never holds storage credentials.
app.post('/transcode-video', async (request, reply) => {
  const { sourceUrl, uploadUrl } = request.body || {};

  if (!sourceUrl) {
    return reply.status(400).send({ error: 'sourceUrl is required' });
  }
  if (!uploadUrl) {
    return reply.status(400).send({ error: 'uploadUrl is required' });
  }

  const tempFiles = [];
  const jobId = crypto.randomUUID();

  try {
    app.log.info({ jobId, sourceUrl }, 'Starting video transcode');

    const tempDir = '/tmp/transcode';
    if (!existsSync(tempDir)) {
      await mkdir(tempDir, { recursive: true });
    }

    // Download source video
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to download source: ${response.status}`);
    }
    const videoBuffer = Buffer.from(await response.arrayBuffer());
    if (videoBuffer.length > MAX_VIDEO_INPUT_BYTES) {
      return reply.status(413).send({ error: `Source exceeds ${MAX_VIDEO_INPUT_BYTES} byte cap` });
    }
    app.log.info({ jobId, size: videoBuffer.length }, 'Downloaded source video');

    const inputExt = sourceUrl.toLowerCase().includes('.mp4') ? 'mp4' :
                     sourceUrl.toLowerCase().includes('.mov') ? 'mov' : 'webm';
    const inputPath = path.join(tempDir, `input-${jobId}.${inputExt}`);
    const outputPath = path.join(tempDir, `output-${jobId}.mp4`);
    tempFiles.push(inputPath, outputPath);
    await writeFile(inputPath, videoBuffer);

    // Probe for duration guard + whether an audio stream exists
    const probe = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => (err ? reject(err) : resolve(data)));
    });
    // MediaRecorder webm often has no container duration (ffprobe says 'N/A') —
    // normalize to 0 so the guard passes and the JSON stays numeric.
    const durationSec = Number(probe.format?.duration) || 0;
    if (durationSec > MAX_VIDEO_DURATION_SEC) {
      return reply.status(413).send({ error: `Source exceeds ${MAX_VIDEO_DURATION_SEC}s duration cap` });
    }
    const hasAudio = (probe.streams || []).some((s) => s.codec_type === 'audio');

    // Transcode. Notes for iPhone compatibility:
    // - yuv420p is mandatory (canvas-captured webm can carry alpha)
    // - CFR 30fps: MediaRecorder webm is variable-frame-rate, which iOS
    //   stutters on even inside an mp4 container
    // - faststart moves the moov atom up so playback starts while streaming
    app.log.info({ jobId, durationSec, hasAudio }, 'Transcoding with FFmpeg...');
    await new Promise((resolve, reject) => {
      let command;
      const killTimer = setTimeout(() => {
        try { command.kill('SIGKILL'); } catch (e) { /* ignore */ }
        reject(new Error('FFmpeg timed out'));
      }, FFMPEG_TIMEOUT_MS);

      const outputOptions = [
        '-c:v libx264',
        '-profile:v main',
        '-level 4.0',
        '-pix_fmt yuv420p',
        '-preset veryfast',
        '-crf 23',
        '-movflags +faststart',
        // never carry the source's metadata (a phone's location, creation time, …)
        '-map_metadata -1',
        '-map_chapters -1',
      ];
      if (hasAudio) {
        outputOptions.push('-c:a aac', '-b:a 192k', '-ar 48000', '-ac 2');
      }

      command = ffmpeg(inputPath)
        .videoFilters("scale='min(1280,iw)':-2,fps=30")
        .outputOptions(outputOptions)
        .format('mp4')
        .on('start', (cmd) => app.log.info({ jobId, cmd }, 'FFmpeg started'))
        .on('error', (err) => { clearTimeout(killTimer); reject(err); })
        .on('end', () => { clearTimeout(killTimer); resolve(); });
      command.save(outputPath);
    });

    const { readFile } = require('fs/promises');
    const outputBuffer = await readFile(outputPath);
    app.log.info({ jobId, inputSize: videoBuffer.length, outputSize: outputBuffer.length }, 'Transcode complete');

    // Upload to the caller-supplied signed URL (Supabase signed upload URL)
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: outputBuffer,
    });
    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '');
      throw new Error(`Upload failed: ${uploadResponse.status} ${text.slice(0, 200)}`);
    }
    app.log.info({ jobId }, 'Uploaded transcoded mp4');

    for (const f of tempFiles) {
      try { await unlink(f); } catch (e) { /* ignore */ }
    }

    return reply.send({
      success: true,
      jobId,
      inputSize: videoBuffer.length,
      outputSize: outputBuffer.length,
      durationSec,
      hasAudio,
    });
  } catch (error) {
    app.log.error({ jobId, error: error.message }, 'Video transcode failed');
    for (const f of tempFiles) {
      try { await unlink(f); } catch (e) { /* ignore */ }
    }
    return reply.status(500).send({ error: error.message });
  }
});

// Strip location and every other metadata from a stored video, in place.
// The caller (mixmi's /api/media/sanitize) supplies the public source URL and a
// Supabase signed upload URL for the SAME path (upsert); the worker never holds
// storage credentials. Videos already clean are left alone.
app.post('/strip-video-metadata', async (request, reply) => {
  const { sourceUrl, uploadUrl } = request.body || {};
  if (!sourceUrl) return reply.status(400).send({ error: 'sourceUrl is required' });
  if (!uploadUrl) return reply.status(400).send({ error: 'uploadUrl is required' });
  // Only our Storage: read a public object, write through a signed upload URL.
  if (!allowedStorageUrl(sourceUrl, 'read')) return reply.status(400).send({ error: 'sourceUrl must be a public object in our Storage' });
  if (!allowedStorageUrl(uploadUrl, 'upload')) return reply.status(400).send({ error: 'uploadUrl must be a signed upload URL for our Storage' });

  const tempFiles = [];
  const jobId = crypto.randomUUID();
  try {
    const tempDir = '/tmp/strip';
    if (!existsSync(tempDir)) await mkdir(tempDir, { recursive: true });

    // Content-Length checked before the body is read; the cap holds while streaming too.
    const { buffer: videoBuffer, contentType } = await downloadCapped(sourceUrl, MAX_VIDEO_INPUT_BYTES);
    // Container by content: QuickTime ('qt  ' brand) stays .mov, everything else mp4 (incl. m4a)
    const brand = videoBuffer.subarray(8, 12).toString('latin1');
    const format = brand === 'qt  ' ? 'mov' : 'mp4';
    const inputPath = path.join(tempDir, `in-${jobId}.${format}`);
    const outputPath = path.join(tempDir, `out-${jobId}.${format}`);
    tempFiles.push(inputPath, outputPath);
    await writeFile(inputPath, videoBuffer);

    const before = await videoHasMetadata(inputPath);
    if (!before.has) {
      app.log.info({ jobId }, 'Already clean');
      return reply.send({ success: true, jobId, stripped: false });
    }
    // Counts only — never the values (a location must not reach the logs)
    app.log.info({ jobId, location: before.location, formatTags: before.formatTags, streamTags: before.streamTags, dataStreams: before.dataStreams }, 'Stripping metadata');

    await stripVideoMetadata(inputPath, outputPath, format, FFMPEG_TIMEOUT_MS);
    const after = await videoHasMetadata(outputPath);
    if (after.location || after.formatTags || after.dataStreams) throw new Error('metadata survived the strip');
    // Same picture and sound streams, same duration — before anything is overwritten
    const [inSum, outSum] = await Promise.all([streamSummary(inputPath), streamSummary(outputPath)]);
    if (!sameContent(inSum, outSum)) {
      throw new Error(`output doesn't match input (streams v${inSum.video}/a${inSum.audio} → v${outSum.video}/a${outSum.audio}, duration ${inSum.duration} → ${outSum.duration})`);
    }

    const { readFile } = require('fs/promises');
    const outputBuffer = await readFile(outputPath);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType || (format === 'mov' ? 'video/quicktime' : 'video/mp4'), 'x-upsert': 'true' },
      body: outputBuffer,
    });
    if (!uploadResponse.ok) {
      const text = await uploadResponse.text().catch(() => '');
      throw new Error(`Upload failed: ${uploadResponse.status} ${text.slice(0, 200)}`);
    }
    for (const f of tempFiles) { try { await unlink(f); } catch (e) { /* ignore */ } }
    return reply.send({ success: true, jobId, stripped: true, inputSize: videoBuffer.length, outputSize: outputBuffer.length });
  } catch (error) {
    app.log.error({ jobId, error: error.message }, 'Metadata strip failed');
    for (const f of tempFiles) { try { await unlink(f); } catch (e) { /* ignore */ } }
    return reply.status(error instanceof TooLargeError ? 413 : 500).send({ error: error.message });
  }
});

// Start server (only when run directly — tests require the app and use inject)
if (require.main === module) {
  const port = process.env.PORT || 3001;
  const host = process.env.HOST || '0.0.0.0';
  app.listen({ port, host }, (err) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    console.log(`🎛️ Audio worker listening on ${host}:${port}`);
  });
}

module.exports = app;
