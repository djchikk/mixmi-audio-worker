// Request guards for every endpoint that does work.
//
// 1. The shared secret: mixmi's server sends `x-mixmi-worker-secret`; the
//    worker compares it with MEDIA_WORKER_SECRET in constant time. If the
//    worker has no secret configured it refuses ALL work (fail closed) — never
//    "open because unset".
// 2. Source / upload URLs: only the PRIVATE quarantine bucket on our Supabase
//    Storage host (mixmi uploads land there first and are promoted only once
//    clean) — a short-lived signed download URL to read
//    (`/storage/v1/object/sign/media-incoming/…`), a signed upload URL to write
//    the clean copy back (`/storage/v1/object/upload/sign/media-incoming/…`).
//    The worker can't be pointed at anything else.
// 3. Downloads are size-capped BEFORE the body is read (the response's
//    Content-Length), and again while streaming (a missing or lying header
//    can't exceed the cap).
const crypto = require('crypto');

const SECRET_HEADER = 'x-mixmi-worker-secret';
const INCOMING_BUCKET = 'media-incoming';

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
  const prefix = kind === 'upload' ? `/storage/v1/object/upload/sign/${INCOMING_BUCKET}/` : `/storage/v1/object/sign/${INCOMING_BUCKET}/`;
  return u.pathname.startsWith(prefix) && !u.pathname.includes('..') && u.searchParams.has('token');
}

class TooLargeError extends Error {}

/** Download with a byte cap: the response's Content-Length checked before the body is read, then enforced while reading. */
async function downloadCapped(url, maxBytes, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Failed to download source: ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch (e) { /* ignore */ }
    throw new TooLargeError(`Source exceeds ${maxBytes} byte cap`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new TooLargeError(`Source exceeds ${maxBytes} byte cap`);
    chunks.push(Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') };
}

module.exports = { SECRET_HEADER, INCOMING_BUCKET, secretOk, storageHost, allowedStorageUrl, downloadCapped, TooLargeError };
