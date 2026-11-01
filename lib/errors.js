// What the worker says when a job fails: ONE fixed code from the list below, and
// optionally a few numbers. Never a message: an error's text can carry ffmpeg's
// stderr, storage's reply, a path or something from the file itself, and the
// worker's replies and logs go on into mixmi's logs (Astra's P2 on #781,
// 2026-10-31). mixmi logs only codes from its own copy of this list
// (lib/media/promote.ts WORKER_ERROR_CODES): keep the two the same.
//
// Reply on failure: { error: <code> } or { error: <code>, detail: { <name>: <number> } }.

/** Every code, with the HTTP status it goes out with. */
const CODES = {
  'not-configured': 503,
  unauthorized: 401,
  'bad-request': 400,
  'invalid-enhancement-type': 400,
  'input-refused': 415, // not an allowlisted container by its magic bytes (lib/inputs)
  'unsupported-media': 415,
  'video-codec-refused': 415,
  'video-tracks': 415,
  'private-sei-refused': 415,
  'no-audio': 415,
  'no-video': 415,
  undecodable: 415,
  'mp3-structure': 415, // bytes in an MP3 that are neither audio frames nor a tag (lib/mp3Frames)
  'source-too-large': 413,
  'duration-over-cap': 413,
  'output-over-cap': 413,
  'os-limit': 413,
  'sei-expands': 413,
  deadline: 504,
  'download-failed': 500,
  'redirect-refused': 500,
  'empty-source': 500,
  'upload-failed': 500,
  'probe-failed': 500,
  'metadata-survived': 500,
  'private-sei-survived': 500,
  'packets-mismatch': 500,
  'content-mismatch': 500,
  'ffmpeg-failed': 500,
  internal: 500,
};

// The numbers a detail may carry, by name. Anything else is dropped.
const DETAIL_KEYS = new Set([
  'status', 'exit', 'capSec', 'audioSec', 'spanSec', 'frames', 'packets', 'stream', 'capBytes', 'bytes', 'tracks', 'at',
  'leftovers', 'formatTags', 'streamTags', 'otherStreams', 'private', 'refuseNals',
  'inVideo', 'inAudio', 'outVideo', 'outAudio',
]);

/** Mark an error with its code (and numbers); returns the error, for `throw tag(new Error(…), …)`. */
function tag(error, code, detail) {
  if (!Object.prototype.hasOwnProperty.call(CODES, code)) throw new Error(`unknown worker error code: ${code}`);
  error.workerCode = code;
  if (detail) error.workerDetail = detail;
  return error;
}

/** A detail as it may leave the worker: listed names, finite numbers, at most 8. */
function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (Object.keys(out).length >= 8) break;
    if (DETAIL_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The reply for a failed job: { status, body } with body { error: code[, detail] }.
 * `classify(error)` gives a code for errors not tagged where they were thrown
 * (by class), or null; anything still unknown is `internal`.
 */
function failure(error, classify = () => null) {
  let code = error && Object.prototype.hasOwnProperty.call(CODES, error.workerCode) ? error.workerCode : null;
  code ||= classify(error);
  if (!code || !Object.prototype.hasOwnProperty.call(CODES, code)) code = 'internal';
  const detail = safeDetail(error?.workerDetail);
  return { status: CODES[code], body: detail ? { error: code, detail } : { error: code } };
}

module.exports = { CODES, DETAIL_KEYS, tag, safeDetail, failure };
