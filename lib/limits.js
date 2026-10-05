// Duration and size limits, closed (Astra on worker #3). A file's length is
// MEASURED BOTH WAYS, over every picture and sound stream, and it is over the
// cap if EITHER way is:
//   - by count: decoded audio samples (every audio stream), coded video
//     frames — which a squeezed timestamp (asetpts=PTS/10) can't hide;
//   - by timestamps: each stream's span — which a slow picture-only stream
//     (5 fps, few frames, long) can't hide from.
// The container's declared duration is never used (live WebM has none).
// Measuring stops just past the cap, so a huge file costs at most the cap's
// worth of work. Every ffmpeg run then has hard limits of its own
// (lib/commands: counts and -fs) under the OS limits (lib/proc).
const proc = require('./proc');

class LimitError extends Error {}

const RATE = 8000; // audio is counted as 8 kHz mono s16 (2 bytes a sample)
const MAX_FPS = 60; // the frame budget for picture streams: cap × 60
const MAX_PACKET_RATE = 1000; // packets a second any stream may need (Opus at 2.5 ms: 400) — the counting stops past this

/** ffmpeg to a pipe (never a file: OS file-size limit 0), counting what it writes. */
async function counting(args, onData, timeoutMs, cwd) {
  try {
    return await proc.run('ffmpeg', ['-nostdin', '-v', 'error', ...args], { fsizeBytes: 0, timeoutMs, cwd, onStdout: onData });
  } catch (e) {
    if (e.deadline) throw e;
    throw new LimitError(`could not be decoded (${e.message})`);
  }
}

/** Seconds of audio in audio stream `index` (0 = the first), by DECODED SAMPLES; counting stops past `stopSec`. */
async function audioSeconds(input, stopSec, timeoutMs, index = 0, cwd) {
  let bytes = 0;
  const stopAt = Math.ceil(stopSec * RATE) * 2;
  await counting(['-i', input, '-map', `0:a:${index}`, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], (c) => (bytes += c.length) > stopAt, timeoutMs, cwd);
  return bytes / 2 / RATE;
}

/**
 * Per mapped stream, by stream copy to framecrc (one line per packet, nothing
 * decoded): the packet COUNT, and the TIMESTAMP SPAN in seconds (first pts to
 * the last pts + duration, in the stream's own time base). Stops once any
 * stream passes `stopAt` packets.
 * → { counts: [n per stream], spans: [s per stream], stopped }
 */
async function packetCounts(input, maps, stopAt, timeoutMs, cwd) {
  const counts = [], lo = [], hi = [], tb = [];
  let rest = '';
  const { stopped } = await counting(['-i', input, ...maps, '-c', 'copy', '-f', 'framecrc', 'pipe:1'], (c) => {
    const lines = (rest + c.toString('latin1')).split('\n');
    rest = lines.pop();
    for (const l of lines) {
      const t = /^#tb (\d+): (\d+)\/(\d+)/.exec(l);
      if (t) { tb[Number(t[1])] = Number(t[2]) / Number(t[3]); continue; }
      const m = /^(\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),/.exec(l);
      if (!m) continue;
      const i = Number(m[1]);
      counts[i] = (counts[i] || 0) + 1;
      const pts = Number(m[3]), dur = Math.max(0, Number(m[4]));
      if (Number.isSafeInteger(pts) && pts > -(2 ** 52)) {
        lo[i] = lo[i] === undefined ? pts : Math.min(lo[i], pts);
        hi[i] = hi[i] === undefined ? pts + dur : Math.max(hi[i], pts + dur);
      }
      if (counts[i] > stopAt) return true;
    }
    return false;
  }, timeoutMs, cwd);
  const spans = Array.from(counts, (_, i) => (lo[i] === undefined || !tb[i] ? 0 : (hi[i] - lo[i]) * tb[i]));
  return { counts: Array.from(counts, (n) => n || 0), spans, stopped };
}

/**
 * The shared measure, BOTH ways, over EVERY picture and sound stream:
 *   - counts: decoded audio samples for every audio stream; frames for every
 *     picture stream (over capSec × MAX_FPS is over);
 *   - timestamps: every stream's span.
 * Over the cap if EITHER is. → { audioSec: [per audio stream], videoFrames,
 * spanSec, over, why }
 */
async function trueDuration(input, { audioStreams = 0, capSec, timeoutMs, cwd }) {
  const why = [];
  const { counts, spans, stopped } = await packetCounts(input, ['-map', '0:V?', '-map', '0:a?'], (capSec + 1) * MAX_PACKET_RATE, timeoutMs, cwd);
  // output order: picture streams first, then audio (the maps' order)
  const videoN = counts.length - audioStreams;
  const videoFrames = videoN > 0 ? Math.max(...counts.slice(0, videoN)) : null;
  const spanSec = spans.length ? Math.max(...spans) : 0;
  if (stopped) why.push(`over ${(capSec + 1) * MAX_PACKET_RATE} packets in one stream`);
  if (videoFrames !== null && videoFrames > capSec * MAX_FPS) why.push(`${videoFrames}+ frames`);
  if (spanSec > capSec) why.push(`timestamps span ${spanSec.toFixed(1)} s`);
  const audioSec = [];
  for (let i = 0; i < audioStreams; i++) {
    const sec = await audioSeconds(input, capSec + 1, timeoutMs, i, cwd);
    audioSec.push(sec);
    if (sec > capSec) why.push(`${sec.toFixed(1)}+ s of audio${audioStreams > 1 ? ` (audio stream ${i + 1})` : ''}`);
  }
  return { audioSec, videoFrames, spanSec, over: why.length > 0, why };
}

module.exports = { trueDuration, audioSeconds, packetCounts, LimitError, MAX_FPS, RATE };
