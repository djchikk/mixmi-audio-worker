const Fastify = require('fastify');
const cors = require('@fastify/cors');
const path = require('path');
const crypto = require('crypto');
// Through the module object (not destructured): the endpoint tests swap a
// step out to prove the output verification is what refuses a dirty file.
const media = require('./lib/stripMedia');
const { SECRET_HEADER, secretOk } = require('./lib/guards');
const io = require('./lib/storageIO');
const sei = require('./lib/videoSei');
const limits = require('./lib/limits');
const proc = require('./lib/proc');
const commands = require('./lib/commands');
const inputs = require('./lib/inputs');

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

// Guards
const MAX_INPUT_BYTES = 200 * 1024 * 1024; // 200MB input cap (audio and video)
const FFMPEG_TIMEOUT_MS = 8 * 60 * 1000; // kill runaway encodes
const DOWNLOAD_DEADLINE_MS = 3 * 60 * 1000; // the whole download, start to last byte
const UPLOAD_DEADLINE_MS = 3 * 60 * 1000;
const PROBE_DEADLINE_MS = 60 * 1000;
// Enhancement caps (Astra's P2-3): a long, highly compressed input can't turn
// into an output that exhausts the worker. Read per request (tests lower them).
const enhanceCaps = () => ({
  maxDurationSec: Number(process.env.ENHANCE_MAX_DURATION_SEC) || 15 * 60, // 15 min of audio
  maxOutputBytes: Number(process.env.ENHANCE_MAX_OUTPUT_BYTES) || 200 * 1024 * 1024, // ≈ 17 min of 48 kHz mono WAV
});
const transcodeCaps = () => ({
  maxDurationSec: Number(process.env.TRANSCODE_MAX_DURATION_SEC) || 600, // 10 min
  maxOutputBytes: Number(process.env.TRANSCODE_MAX_OUTPUT_BYTES) || 400 * 1024 * 1024,
});
// A strip is a lossless remux: its output is bounded by the input it copies
// (packet counts, below) and bytes slightly over the input's.
const stripCaps = (inputBytes) => ({
  maxDurationSec: Number(process.env.STRIP_MAX_DURATION_SEC) || 4 * 3600, // a long DJ mix
  maxOutputBytes: Number(process.env.STRIP_MAX_OUTPUT_BYTES) || Math.ceil(inputBytes * 1.02) + 1024 * 1024,
});

// Health check
app.get('/', async () => {
  return { status: 'ok', service: 'mixmi-audio-worker' };
});

app.get('/health', async () => {
  return { status: 'healthy', ffmpeg: true };
});

class UnsupportedError extends Error {}
class VerificationError extends Error {}

/** Error text for logs and replies: never a URL (they carry tokens). */
const scrub = (msg) => String(msg || 'failed').replace(/https?:\/\/\S+/g, '[url]').slice(0, 300);

/** Run ffmpeg under the OS limits (lib/proc): `fsizeBytes` for any file it writes, CPU from the deadline, in the job's dir. */
function runFfmpeg(args, { fsizeBytes, cwd, timeoutMs = FFMPEG_TIMEOUT_MS }) {
  return proc.run('ffmpeg', args, { fsizeBytes, cwd, timeoutMs });
}

/**
 * Every endpoint, one shape (lib/storageIO): the request names a signed READ
 * URL for an object in mixmi's private incoming bucket and a signed UPLOAD URL
 * for THE SAME object. The worker downloads it (streamed, capped, deadline),
 * `work` turns it into an output file that has passed its own verification,
 * and the output is written back in place (deadline). Temp files: one temp dir,
 * removed in finally. Logs: jobId + bucket/key only.
 */
function inPlaceEndpoint(name, work, validate = () => null) {
  return async (request, reply) => {
    const jobId = crypto.randomUUID();
    const { sourceUrl, uploadUrl } = request.body || {};
    let ref;
    try {
      ({ ref } = io.inPlaceTarget(sourceUrl, uploadUrl));
    } catch (e) {
      return reply.status(400).send({ error: e.message });
    }
    const invalid = validate(request.body || {});
    if (invalid) return reply.status(400).send({ error: invalid });
    try {
      const result = await io.withTempDir(async (dir) => {
        const input = path.join(dir, 'in');
        const got = await io.downloadToFile(sourceUrl, input, { maxBytes: MAX_INPUT_BYTES, deadlineMs: DOWNLOAD_DEADLINE_MS });
        app.log.info({ jobId, ref, endpoint: name, bytes: got.bytes }, 'Downloaded');
        // the closed input rule (lib/inputs): an allowlisted container by its
        // magic bytes, or refused before ffmpeg ever runs (playlists, concat
        // lists, SDP and every other indirection format included)
        if (!inputs.containerOfFile(input)) throw new inputs.InputRefused('Not an accepted media container');
        const out = await work({ jobId, ref, dir, input, contentType: got.contentType, body: request.body || {} });
        const up = await io.uploadFile(uploadUrl, out.file, out.contentType, { deadlineMs: UPLOAD_DEADLINE_MS });
        app.log.info({ jobId, ref, endpoint: name, bytes: up.bytes, ...out.log }, 'Written back in place');
      });
      // The ONE success shape, for every endpoint: exactly these three fields.
      // Every endpoint writes a verified metadata-free file, so stripped is
      // always true. (mixmi accepts nothing else as success.)
      return reply.send({ success: true, stripped: true, jobId });
    } catch (error) {
      // an OS file-size limit (lib/proc), or the Annex-B budget, is a size refusal
      const tooLarge = error instanceof io.TooLargeError || error instanceof proc.OsLimitError || error instanceof sei.SeiLimitError;
      const status = tooLarge ? 413 : error instanceof UnsupportedError || error instanceof inputs.InputRefused ? 415 : error instanceof io.DeadlineError || error.deadline ? 504 : 500;
      app.log.error({ jobId, ref, endpoint: name, error: scrub(error.message) }, 'Job failed');
      return reply.status(status).send({ error: scrub(error.message) });
    }
  };
}

/** The output must carry no metadata at all (structure and tags), or the job fails. */
async function verifyClean(file, kind) {
  const report = await media.metadataReport(file, kind, PROBE_DEADLINE_MS);
  if (!report.clean) {
    throw new VerificationError(`metadata survived (${report.leftovers.join(',') || '-'}, format tags ${report.formatTags}, stream tags ${report.streamTags}, other streams ${report.otherStreams})`);
  }
}

/** limits.* errors → the worker's statuses. */
async function counted(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.deadline) throw new io.DeadlineError('measuring the media timed out');
    if (e instanceof limits.LimitError) throw new UnsupportedError(`The media ${e.message}`);
    throw e;
  }
}

/** Refuse an input whose length, measured BOTH ways over every stream (lib/limits), is over the cap. */
async function measureOrRefuse(input, { audioStreams, capSec, what, cwd }) {
  const m = await counted(() => limits.trueDuration(input, { audioStreams, capSec, timeoutMs: FFMPEG_TIMEOUT_MS, cwd }));
  if (m.over) throw new io.TooLargeError(`${what} exceeds the ${capSec}s cap (measured: ${m.why.join(', ')})`);
  return m;
}
const audioCount = (probe) => (probe.streams || []).filter((s) => s.codec_type === 'audio').length;
const MB = 1024 * 1024;

/** An output that reached its byte cap was cut short by -fs: refused. */
async function refuseIfCut(output, maxBytes, what) {
  const written = await io.fileSize(output);
  if (written >= maxBytes) throw new io.TooLargeError(`${what} output exceeds the ${maxBytes}-byte cap (stopped at ${written} bytes)`);
}

/** Neutralize private SEI in place; refuse when it shares a NAL with picture-relevant SEI. */
async function neutralizeSei(file, codec) {
  const r = await sei.neutralizeSeiInIso(file, codec);
  if (r.refused) throw new UnsupportedError(`Video stream: ${r.refused} — refused`);
}

/** The picture stream must carry no private SEI at all (an independent re-scan, parameter sets included). */
async function verifySei(file, codec, dir) {
  const r = await sei.seiReport(file, codec, dir, PROBE_DEADLINE_MS * 2);
  if (r && (r.private > 0 || r.refuseNals > 0)) throw new VerificationError(`private data survived in the video stream (${r.private} SEI messages)`);
}

// Enhance: an audio file → enhanced WAV, written back in place. mixmi then
// promotes it from the private incoming bucket (re-checked) to its public path.
app.post('/enhance', inPlaceEndpoint('enhance', async ({ dir, input, body }) => {
  const enhancementType = body.enhancementType || 'auto';
  const filterChain = ENHANCEMENT_FILTERS[enhancementType];
  const caps = enhanceCaps();
  let probe;
  try {
    probe = await io.probeFile(input, PROBE_DEADLINE_MS);
  } catch (e) {
    if (e instanceof io.DeadlineError) throw e;
    throw new UnsupportedError('Not audio ffmpeg can read');
  }
  if (!(probe.streams || []).some((st) => st.codec_type === 'audio')) throw new UnsupportedError('No audio stream');
  // Length measured both ways over every stream (lib/limits) — never the
  // container's declared duration; bounded just past the cap.
  await measureOrRefuse(input, { audioStreams: audioCount(probe), capSec: caps.maxDurationSec, what: 'Input (enhancement)', cwd: dir });
  const output = path.join(dir, 'out.wav');
  // hard limits: samples by count (atrim), -fs, and the OS file-size limit just above it
  await runFfmpeg(commands.enhanceArgs(input, output, filterChain, caps), { fsizeBytes: caps.maxOutputBytes + MB, cwd: dir });
  // reaching either limit means the output was cut short — refused, never uploaded
  await refuseIfCut(output, caps.maxOutputBytes, 'Enhanced');
  const outSec = await counted(() => limits.audioSeconds(output, caps.maxDurationSec + 1, FFMPEG_TIMEOUT_MS, 0, dir));
  if (outSec > caps.maxDurationSec) throw new io.TooLargeError(`Enhanced output reached the ${caps.maxDurationSec}s limit`);
  await verifyClean(output, 'wav');
  return { file: output, contentType: 'audio/wav', log: { enhancementType } };
}, (body) => (ENHANCEMENT_FILTERS[body.enhancementType || 'auto'] ? null : 'Invalid enhancementType')));

// Video transcode: webm (or anything ffmpeg reads) → iPhone-safe MP4, written
// back in place. H.264 main profile + AAC, faststart, CFR 30, capped at 1280px
// wide. mixmi then promotes it (re-checked) to its public path.
app.post('/transcode-video', inPlaceEndpoint('transcode', async ({ dir, input }) => {
  let probe;
  try {
    probe = await io.probeFile(input, PROBE_DEADLINE_MS);
  } catch (e) {
    if (e instanceof io.DeadlineError) throw e;
    throw new UnsupportedError('Not a video ffmpeg can read');
  }
  const caps = transcodeCaps();
  const hasAudio = (probe.streams || []).some((s) => s.codec_type === 'audio');
  const hasVideo = (probe.streams || []).some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!hasVideo) throw new UnsupportedError('No video stream');
  // Length measured both ways over every stream — MediaRecorder WebM (ordinary
  // browser output) has no container duration at all
  const m = await measureOrRefuse(input, { audioStreams: audioCount(probe), capSec: caps.maxDurationSec, what: 'Source', cwd: dir });
  const maxFrames = (caps.maxDurationSec + 1) * 30; // the output is CFR 30 (lib/commands: -frames:v)
  const output = path.join(dir, 'out.mp4');
  await runFfmpeg(commands.transcodeArgs(input, output, { hasAudio, caps }), { fsizeBytes: caps.maxOutputBytes + MB, cwd: dir });
  // reaching any limit means the output was cut short — refused, never uploaded
  await refuseIfCut(output, caps.maxOutputBytes, 'Transcoded');
  const outFrames = (await counted(() => limits.packetCounts(output, ['-map', '0:v:0'], maxFrames, FFMPEG_TIMEOUT_MS, dir))).counts[0] || 0;
  if (outFrames > caps.maxDurationSec * 30) throw new io.TooLargeError(`Transcoded output reached the ${caps.maxDurationSec}s limit (${outFrames} frames at 30 fps)`);
  if (hasAudio) {
    const outSec = await counted(() => limits.audioSeconds(output, caps.maxDurationSec + 1, FFMPEG_TIMEOUT_MS, 0, dir));
    if (outSec > caps.maxDurationSec) throw new io.TooLargeError(`Transcoded output reached the ${caps.maxDurationSec}s limit (audio)`);
  }
  await media.blankMetadataBoxes(output);
  await neutralizeSei(output, 'h264'); // x264's own settings message included
  await verifyClean(output, 'iso');
  await verifySei(output, 'h264', dir);
  return { file: output, contentType: 'video/mp4', log: { audioSec: m.audioSec, frames: m.videoFrames, spanSec: m.spanSec, hasAudio } };
}));

// Strip every bit of metadata from an uploaded media file — video or audio,
// any container mixmi accepts (mp4 / mov / m4a, mp3, wav, flac, ogg, webm) —
// unconditionally: remux losslessly with no metadata, tags or attached pictures
// (lib/stripMedia), blank any metadata box the muxer still writes, VERIFY the
// output carries none by its structure, and check it kept every real stream
// and its duration. Written back in place; mixmi re-checks it before promoting
// it out of the private incoming bucket.
app.post('/strip-metadata', inPlaceEndpoint('strip', async ({ dir, input, contentType }) => {
  // Container by content (probe), never by name or first box.
  const fmt = await media.mediaFormat(input, PROBE_DEADLINE_MS);
  if (!fmt) throw new UnsupportedError('Not a media file this worker accepts');
  // Picture: an allowlisted codec, one track. (Clean it or refuse it: e.g.
  // Motion-JPEG frames can each carry EXIF, so other codecs are refused.)
  if (fmt.video.some((c) => !media.VIDEO_CODECS.has(c))) throw new UnsupportedError(`Video codec not accepted: ${fmt.video.join(', ')}`);
  if (fmt.video.length > 1) throw new UnsupportedError('More than one picture track');
  // H.264 / HEVC: private SEI (lib/videoSei) — neutralized in place after the
  // remux (MP4 / MOV), or the file refused
  const codec = fmt.video[0];
  const avc = codec === 'h264' || codec === 'hevc';
  if (avc && fmt.family !== 'iso') {
    // no in-place editing outside MP4 / MOV: private SEI there is refused
    const r = await sei.seiReport(input, codec, dir, PROBE_DEADLINE_MS * 2);
    if (r.private) throw new UnsupportedError('Private data in the video stream of a non-MP4 container — refused');
  }
  if (fmt.family === 'mp3') await media.trimMp3Trailers(input); // ID3v1 / APE trailers: cut, never copied
  // TRUE length by counting; then the remux is limited to exactly the packets
  // counted in the input (per stream) and bytes just over the input's
  const caps = stripCaps(await io.fileSize(input));
  await measureOrRefuse(input, { audioStreams: fmt.audio, capSec: caps.maxDurationSec, what: 'Input', cwd: dir });
  const STRIP_MAPS = ['-map', '0:V?', '-map', '0:a?'];
  const inPackets = (await counted(() => limits.packetCounts(input, STRIP_MAPS, Infinity, FFMPEG_TIMEOUT_MS, dir))).counts;
  const output = path.join(dir, `out.${fmt.muxer}`);
  await media.stripMedia(input, output, fmt, FFMPEG_TIMEOUT_MS, { frames: inPackets, maxBytes: caps.maxOutputBytes });
  await refuseIfCut(output, caps.maxOutputBytes, 'Stripped');
  const outPackets = (await counted(() => limits.packetCounts(output, STRIP_MAPS, Infinity, FFMPEG_TIMEOUT_MS, dir))).counts;
  if (JSON.stringify(outPackets) !== JSON.stringify(inPackets)) throw new VerificationError(`output packets ${JSON.stringify(outPackets)} ≠ input ${JSON.stringify(inPackets)}`);
  if (fmt.family === 'iso') await media.blankMetadataBoxes(output);
  if (avc && fmt.family === 'iso') await neutralizeSei(output, codec);
  await verifyClean(output, fmt.family);
  if (avc) await verifySei(output, codec, dir);
  // Same real picture and sound streams, same duration — before anything is written back
  const [inSum, outSum] = await Promise.all([media.streamSummary(input, PROBE_DEADLINE_MS), media.streamSummary(output, PROBE_DEADLINE_MS)]);
  if (!media.sameContent(inSum, outSum)) {
    throw new VerificationError(`output doesn't match input (streams v${inSum.video}/a${inSum.audio} → v${outSum.video}/a${outSum.audio}, duration ${inSum.duration} → ${outSum.duration})`);
  }
  const type = /^(video|audio)\//.test(contentType || '') ? contentType : 'application/octet-stream';
  return { file: output, contentType: type, log: { family: fmt.family } };
}));

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
