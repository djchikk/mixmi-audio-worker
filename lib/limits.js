// Duration and size limits, closed (Astra on worker #3): a file's true length
// is MEASURED by counting — decoded audio samples, or coded video frames —
// never read from timestamps or the container's declared duration, both of
// which a file can state freely (missing, as in a live WebM, or squeezed, as
// in asetpts=PTS/10). Measuring stops just past the cap, so a huge file costs
// at most the cap's worth of work. Every ffmpeg run then gets hard limits on
// both duration (sample / frame COUNTS: atrim end_sample, -frames) and output
// bytes (-fs), and an output that reaches either is refused, never uploaded.
const { spawn } = require('child_process');

class LimitError extends Error {}

const RATE = 8000; // audio is counted as 8 kHz mono s16 (2 bytes a sample)
const MAX_FPS = 60; // the frame budget for picture-only files: cap × 60

/**
 * Run ffmpeg, streaming its stdout into `onData(chunk)`; `onData` returns true
 * to stop it (enough counted). Resolves { stopped }, rejects on an ffmpeg error
 * or the deadline.
 */
function runCounting(args, onData, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stopped = false, timedOut = false, err = '';
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (c) => { if (!stopped && onData(c)) { stopped = true; p.kill('SIGKILL'); } });
    p.stderr.on('data', (c) => { if (err.length < 2000) err += c; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(Object.assign(new Error('measuring timed out'), { deadline: true }));
      if (stopped || code === 0) return resolve({ stopped });
      reject(new LimitError(`could not be decoded (${err.trim().split('\n').pop() || `exit ${code}`})`));
    });
  });
}

/** Seconds of audio in the first audio stream, by DECODED SAMPLES; counting stops past `stopSec`. */
async function audioSeconds(input, stopSec, timeoutMs) {
  let bytes = 0;
  const stopAt = Math.ceil(stopSec * RATE) * 2;
  await runCounting(['-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], (c) => (bytes += c.length) > stopAt, timeoutMs);
  return bytes / 2 / RATE;
}

/**
 * Coded packets per output stream for the given maps, by COUNT (stream copy to
 * framecrc: one line per packet; nothing decoded, no timestamp used). Stops
 * once any stream passes `stopAt`. → { counts: [n per mapped stream], stopped }
 */
async function packetCounts(input, maps, stopAt, timeoutMs) {
  const counts = [];
  let rest = '';
  const { stopped } = await runCounting(['-i', input, ...maps, '-c', 'copy', '-f', 'framecrc', 'pipe:1'], (c) => {
    const lines = (rest + c.toString('latin1')).split('\n');
    rest = lines.pop();
    for (const l of lines) {
      const m = /^(\d+),/.exec(l);
      if (!m) continue;
      const i = Number(m[1]);
      counts[i] = (counts[i] || 0) + 1;
      if (counts[i] > stopAt) return true;
    }
    return false;
  }, timeoutMs);
  return { counts: Array.from(counts, (n) => n || 0), stopped };
}

/**
 * The shared measure: { audioSec, videoFrames, over } for a file with audio
 * and/or picture. Over the cap when the decoded audio runs past `capSec`, or
 * the picture has more than capSec × MAX_FPS frames.
 */
async function trueDuration(input, { hasAudio, hasVideo, capSec, timeoutMs }) {
  let audioSec = null, videoFrames = null, over = false;
  if (hasAudio) {
    audioSec = await audioSeconds(input, capSec + 1, timeoutMs);
    if (audioSec > capSec) over = true;
  }
  if (hasVideo) {
    const budget = capSec * MAX_FPS;
    const { counts } = await packetCounts(input, ['-map', '0:V:0'], budget, timeoutMs);
    videoFrames = counts[0] || 0;
    if (videoFrames > budget) over = true;
  }
  return { audioSec, videoFrames, over };
}

module.exports = { trueDuration, audioSeconds, packetCounts, LimitError, MAX_FPS, RATE };
