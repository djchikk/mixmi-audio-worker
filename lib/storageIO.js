// The ONE way every endpoint touches storage (Astra's HOLD on worker #3).
//
// Contract — fixed, the same for /enhance, /transcode-video and
// /strip-video-metadata:
//
//   source       a short-lived signed READ URL for an object in mixmi's
//                PRIVATE `media-incoming` bucket on our Supabase Storage host:
//                https://<host>/storage/v1/object/sign/media-incoming/<key>?token=…
//   destination  a signed UPLOAD URL for THE SAME object (in place):
//                https://<host>/storage/v1/object/upload/sign/media-incoming/<key>?token=…
//
// Nothing else is accepted: another host, plain http, a public object, another
// bucket, another key, a missing token, a traversal. mixmi re-checks whatever
// the worker writes before anything becomes public (quarantine, then promote).
//
// Every request refuses redirects (redirect: 'manual'; any 3xx fails) and runs
// under a deadline (AbortController). Downloads stream to disk under a byte
// cap (Content-Length checked before the body is read, then counted). Every
// job's temp files live in one temp dir removed in `finally`. Logs carry only
// `bucket/key` — never a URL or a token.
const { mkdtemp, rm, stat, open } = require('fs/promises');
const { createWriteStream } = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const INCOMING_BUCKET = 'media-incoming';
const DEFAULT_HOST = 'apvdneaduthfbieywwjv.supabase.co';

class ContractError extends Error {}
class TooLargeError extends Error {}
class DeadlineError extends Error {}

/** The Storage host the worker may talk to (from SUPABASE_URL). */
function storageHost(env = process.env) {
  try {
    return new URL(env.SUPABASE_URL || `https://${DEFAULT_HOST}`).host;
  } catch {
    return null;
  }
}

/**
 * Parse a signed Storage URL. kind 'read' → /object/sign/…, 'upload' →
 * /object/upload/sign/…. Returns { bucket, key } or null if it isn't exactly
 * that shape on our host in the incoming bucket.
 */
function parseSignedUrl(url, kind, env = process.env) {
  if (typeof url !== 'string') return null;
  // the RAW path, before the URL parser normalises it: an encoded or literal
  // dot-dot, an encoded slash or a backslash is refused, never resolved
  if (/%2e|%2f|%5c|\\|\/\.\.?(\/|$)/i.test(url.split('?')[0])) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = storageHost(env);
  if (!host || u.protocol !== 'https:' || u.host !== host || u.username || u.password || u.port) return null;
  if (!u.searchParams.get('token')) return null;
  const prefix = kind === 'upload' ? '/storage/v1/object/upload/sign/' : '/storage/v1/object/sign/';
  // the raw (still-encoded) path: an encoded slash or dot can't sneak past
  if (!u.pathname.startsWith(prefix) || /%2f|%5c|%2e|\\/i.test(u.pathname)) return null;
  const rest = u.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (bucket !== INCOMING_BUCKET || !key) return null;
  const segs = key.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  return { bucket, key };
}

/** Validate the fixed contract: read + upload of the SAME incoming object. Throws ContractError. */
function inPlaceTarget(sourceUrl, uploadUrl, env = process.env) {
  const src = typeof sourceUrl === 'string' ? parseSignedUrl(sourceUrl, 'read', env) : null;
  if (!src) throw new ContractError('sourceUrl must be a signed read URL into our private incoming bucket');
  const dst = typeof uploadUrl === 'string' ? parseSignedUrl(uploadUrl, 'upload', env) : null;
  if (!dst) throw new ContractError('uploadUrl must be a signed upload URL into our private incoming bucket');
  if (dst.bucket !== src.bucket || dst.key !== src.key) throw new ContractError('uploadUrl must be the same object as sourceUrl (in place)');
  return { ref: `${src.bucket}/${src.key}` }; // what logs may carry
}

/** fetch with no redirects and a deadline. Any 3xx is a failure. */
async function guardedFetch(url, opts, deadlineMs, fetchImpl = fetch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), deadlineMs);
  try {
    const res = await fetchImpl(url, { ...opts, redirect: 'manual', signal: ctl.signal });
    if (res.status >= 300 && res.status < 400) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`refused a redirect (${res.status})`);
    }
    return { res, done: () => clearTimeout(t), signal: ctl.signal };
  } catch (e) {
    clearTimeout(t);
    if (ctl.signal.aborted) throw new DeadlineError('storage request timed out');
    throw e;
  }
}

/** Stream `url` to `file` under a byte cap and a total deadline. Returns { bytes, contentType }. */
async function downloadToFile(url, file, { maxBytes, deadlineMs }, fetchImpl = fetch) {
  const { res, done, signal } = await guardedFetch(url, {}, deadlineMs, fetchImpl);
  try {
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`download failed (${res.status})`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      throw new TooLargeError(`source exceeds ${maxBytes} byte cap`);
    }
    const out = createWriteStream(file);
    let bytes = 0;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new TooLargeError(`source exceeds ${maxBytes} byte cap`);
        if (!out.write(Buffer.from(chunk))) await new Promise((r) => out.once('drain', r));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (bytes === 0) throw new Error('empty source');
    return { bytes, contentType: res.headers.get('content-type') };
  } catch (e) {
    if (signal.aborted && !(e instanceof TooLargeError)) throw new DeadlineError('download timed out');
    throw e;
  } finally {
    done();
  }
}

const STREAM_CHUNK = 64 * 1024;

/**
 * A file as a web ReadableStream with REAL backpressure: one chunk is read
 * from disk per pull, and pulls happen only while the queue holds less than
 * one chunk of BYTES (ByteLengthQueuingStrategy — Readable.toWeb counts
 * chunks, not bytes). A slow consumer therefore holds at most ~2 chunks in
 * memory. `bytesRead()` reports how far the file has been read (tests).
 */
function fileStream(file, chunkSize = STREAM_CHUNK) {
  let fh = null;
  let pos = 0;
  const stream = new ReadableStream(
    {
      async pull(controller) {
        fh ||= await open(file, 'r');
        const buf = Buffer.alloc(chunkSize);
        const { bytesRead } = await fh.read(buf, 0, chunkSize, pos);
        if (!bytesRead) {
          await fh.close(); fh = null;
          controller.close();
          return;
        }
        pos += bytesRead;
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
      },
      async cancel() { if (fh) { await fh.close(); fh = null; } },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: chunkSize })
  );
  return { stream, bytesRead: () => pos };
}

/**
 * PUT `file` to a signed upload URL (upsert: the same object, in place) under a
 * deadline — STREAMED from disk with real backpressure (fileStream; never read
 * into memory — Astra's P2-3), with its Content-Length.
 */
async function uploadFile(url, file, contentType, { deadlineMs }, fetchImpl = fetch) {
  const bytes = (await stat(file)).size;
  const body = fileStream(file).stream;
  const { res, done } = await guardedFetch(url, { method: 'PUT', headers: { 'Content-Type': contentType, 'Content-Length': String(bytes), 'x-upsert': 'true' }, body, duplex: 'half' }, deadlineMs, fetchImpl);
  try {
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`upload failed (${res.status})${text ? ` ${text.slice(0, 120)}` : ''}`);
    return { bytes };
  } finally {
    done();
  }
}

/** ffprobe as JSON, under the OS limits (no file writes at all) and the deadline. */
async function probeFile(file, deadlineMs = 60_000) {
  const proc = require('./proc');
  let r;
  try {
    r = await proc.run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...require('./inputs').inputArgs(file)], { fsizeBytes: 0, timeoutMs: deadlineMs, cwd: path.dirname(file), keepStdout: true, maxStdout: 16 * 1024 * 1024 });
  } catch (e) {
    if (e instanceof require('./inputs').InputRefused) throw e;
    throw e.deadline ? new DeadlineError('probe timed out') : new Error('probe failed');
  }
  try {
    return JSON.parse(r.stdout.toString('utf8'));
  } catch {
    throw new Error('probe output unreadable');
  }
}

/** Run `fn(dir)` with a fresh temp dir that is always removed afterwards. */
async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mixmi-job-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const fileSize = async (f) => (await stat(f)).size;

module.exports = {
  INCOMING_BUCKET, ContractError, TooLargeError, DeadlineError,
  storageHost, parseSignedUrl, inPlaceTarget, guardedFetch, downloadToFile, uploadFile, fileStream, probeFile, withTempDir, fileSize,
};
