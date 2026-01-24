const Fastify = require('fastify');
const cors = require('@fastify/cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { writeFile, unlink, mkdir } = require('fs/promises');
const { existsSync } = require('fs');
const { createReadStream } = require('fs');
const path = require('path');
const crypto = require('crypto');

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

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

// FFmpeg filter chains for each enhancement type
const ENHANCEMENT_FILTERS = {
  auto: 'highpass=f=80,compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-45|-27/-25|0/-10,loudnorm=I=-14:TP=-1:LRA=11',
  voice: 'highpass=f=100,compand=attacks=0.2:decays=0.6:points=-80/-80|-45/-45|-27/-22|0/-8,loudnorm=I=-16:TP=-1:LRA=9',
  clean: 'highpass=f=80,loudnorm=I=-14:TP=-1:LRA=11',
  warm: 'highpass=f=60,equalizer=f=100:t=q:w=1:g=2,compand=attacks=0.4:decays=1.0:points=-80/-80|-45/-45|-27/-24|0/-8,loudnorm=I=-14:TP=-1:LRA=11',
  studio: 'highpass=f=40,equalizer=f=60:t=q:w=1:g=1,equalizer=f=10000:t=q:w=1:g=1,compand=attacks=0.2:decays=0.6:points=-80/-80|-50/-50|-30/-26|-10/-10|0/-6,loudnorm=I=-14:TP=-1:LRA=9',
};

// Health check
app.get('/', async () => {
  return { status: 'ok', service: 'mixmi-audio-worker' };
});

app.get('/health', async () => {
  return { status: 'healthy', ffmpeg: !!ffmpegPath };
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

// Start server
const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0';

app.listen({ port, host }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🎛️ Audio worker listening on ${host}:${port}`);
});
