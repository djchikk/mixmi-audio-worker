// Request guards for every endpoint that does work.
//
// 1. The shared secret: mixmi's server sends `x-mixmi-worker-secret`; the
//    worker compares it with MEDIA_WORKER_SECRET in constant time. If the
//    worker has no secret configured it refuses ALL work (fail closed) — never
//    "open because unset".
// 2. Source / upload URLs: only our Supabase Storage host — public objects to
//    read (`/storage/v1/object/public/…`), signed upload URLs to write
//    (`/storage/v1/object/upload/sign/…`). The worker can't be pointed at
//    anything else.
// 3. Downloads are size-capped BEFORE the body is read (Content-Length), and
//    again while streaming (a missing or lying header can't exceed the cap).
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

/** The Supabase Storage host the worker may talk to (from SUPABASE_URL). */
function storageHost(env = process.env) {
  try {
    return new URL(env.SUPABASE_URL || 'https://apvdneaduthfbieywwjv.supabase.co').host;
  } catch {
    return null;
  }
}

/** Is `url` our Storage host with the given kind of path? kind: 'read' | 'upload'. */
function allowedStorageUrl(url, kind, env = process.env) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = storageHost(env);
  if (!host || u.protocol !== 'https:' || u.host !== host) return false;
  const prefix = kind === 'upload' ? '/storage/v1/object/upload/sign/' : '/storage/v1/object/public/';
  return u.pathname.startsWith(prefix) && !u.pathname.includes('..');
}

class TooLargeError extends Error {}

/** Download with a byte cap: Content-Length checked first, then enforced while reading. */
async function downloadCapped(url, maxBytes, fetchImpl = fetch) {
  const head = await fetchImpl(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`Failed to reach source: ${head.status}`);
  const declared = Number(head.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLargeError(`Source exceeds ${maxBytes} byte cap`);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Failed to download source: ${res.status}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new TooLargeError(`Source exceeds ${maxBytes} byte cap`);
    chunks.push(Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') };
}

module.exports = { SECRET_HEADER, secretOk, storageHost, allowedStorageUrl, downloadCapped, TooLargeError };
