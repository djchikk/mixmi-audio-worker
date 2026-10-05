// The shared secret, on every endpoint that does work: mixmi's server sends
// `x-mixmi-worker-secret`; the worker compares it with MEDIA_WORKER_SECRET in
// constant time. If the worker has no secret configured it refuses ALL work
// (fail closed) — never "open because unset". Storage I/O: lib/storageIO.
const crypto = require('crypto');

const SECRET_HEADER = 'x-mixmi-worker-secret';

/** Constant-time check of the presented secret. False if either is missing. */
function secretOk(presented, expected) {
  if (!expected || typeof presented !== 'string' || !presented) return false;
  // Hash both to equal-length digests so timingSafeEqual never throws on
  // length and the comparison time doesn't depend on where they differ.
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { SECRET_HEADER, secretOk };
