// An MP3 by its structure: MPEG audio frames, one after another, and nothing
// else (Astra's P1 on worker #4, 2026-10-31).
//
// ffmpeg's MP3 demuxer resyncs past bytes it doesn't understand and a lossless
// copy keeps them: an ID3v2 tag BETWEEN frames or AFTER the audio (v2.2, v2.3,
// v2.4 with or without its footer), in mono and stereo, came through the remux
// while the old check (an ID3v2 header at byte 0) said clean. So:
//
//   sanitizeMp3   (the input, before the remux) walks the whole file frame by
//                 frame and writes ONLY the frames to a new file. Tags it can
//                 parse (ID3v2 anywhere, ID3v1, APE, Lyrics3 v2) and runs of
//                 zero bytes are dropped; a cut-off last frame is dropped. Any
//                 other byte the walk can't account for refuses the file
//                 (`mp3-structure`): it is never guessed past.
//   mp3Leftovers  (the output, independently) must be frames from its first byte
//                 to its last, every one the same stream (MPEG version, layer,
//                 sample rate), the last one ending exactly at the end. Nothing
//                 is skipped: a tag, a zero byte, a short frame is a leftover.
//
// What's inside a frame is audio (ffmpeg decodes it), and is copied as it is.

const { open } = require('fs/promises');
const { tag } = require('./errors');

// kbps by bitrate index 1–14
const KBPS = {
  v1: { 1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  v2: { 1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
// sample rates by version bits (0 MPEG 2.5, 2 MPEG 2, 3 MPEG 1) and index
const RATES = { 0: [11025, 12000, 8000], 2: [22050, 24000, 16000], 3: [44100, 48000, 32000] };

/** A frame header at b[0..3]: { stream, len } (stream = version, layer and rate, for "the same stream"), or null. */
function frameAt(b) {
  if (b.length < 4 || b[0] !== 0xff || (b[1] & 0xe0) !== 0xe0) return null;
  const ver = (b[1] >> 3) & 3, layerBits = (b[1] >> 1) & 3, bri = b[2] >> 4, sri = (b[2] >> 2) & 3, pad = (b[2] >> 1) & 1;
  // reserved version / layer / rate / emphasis, free-format or bad bitrate: not a frame we can measure
  if (ver === 1 || layerBits === 0 || bri === 0 || bri === 15 || sri === 3 || (b[3] & 3) === 2) return null;
  const layer = 4 - layerBits;
  const rate = RATES[ver][sri];
  const bps = KBPS[ver === 3 ? 'v1' : 'v2'][layer][bri - 1] * 1000;
  const len = layer === 1 ? (Math.floor((12 * bps) / rate) + pad) * 4 : Math.floor(((layer === 3 && ver !== 3 ? 72 : 144) * bps) / rate) + pad;
  return { stream: `${ver}.${layer}.${rate}`, len };
}

const syncsafe = (b, o) => (b[o] & 0x80) | (b[o + 1] & 0x80) | (b[o + 2] & 0x80) | (b[o + 3] & 0x80) ? -1 : (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

/** An ID3v2 tag starting at b[0]: its whole length (header, body, a v2.4 footer), or null. */
function id3v2At(b) {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'ID3') return null;
  if (b[3] < 2 || b[3] > 4 || b[4] === 0xff) return null;
  const size = syncsafe(b, 6);
  if (size < 0) return null;
  return 10 + size + (b[3] === 4 && b[5] & 0x10 ? 10 : 0);
}
/** An APE tag starting at b[0] with its header: its whole length, or null. */
function apeHeaderAt(b) {
  if (b.length < 32 || b.toString('latin1', 0, 8) !== 'APETAGEX') return null;
  const size = b.readUInt32LE(12), flags = b.readUInt32LE(20);
  if (!(flags & 0x20000000) || size < 32) return null; // this is the header (a footer can't come first)
  return 32 + size;
}

/** Reads a file through a 1 MB window (never the whole file into memory). */
async function windowOn(file) {
  const fh = await open(file, 'r');
  const { size } = await fh.stat();
  let start = 0, buf = Buffer.alloc(0);
  return {
    size,
    /** Up to `len` bytes at `pos` (fewer at the end). */
    async at(pos, len) {
      len = Math.max(0, Math.min(len, size - pos));
      if (pos < start || pos + len > start + buf.length) {
        const b = Buffer.alloc(Math.min(1 << 20, size - pos));
        const { bytesRead } = await fh.read(b, 0, b.length, pos);
        buf = b.subarray(0, bytesRead);
        start = pos;
      }
      return buf.subarray(pos - start, pos - start + len);
    },
    close: () => fh.close(),
  };
}

/** Where the audio ends once the tags at the very end are taken off: ID3v1, APE (footer), ID3v2 (footer), Lyrics3 v2. */
async function endOfAudio(w, removed) {
  let end = w.size;
  for (let i = 0; i < 8; i++) {
    const t = await w.at(Math.max(0, end - 128), Math.min(end, 128));
    if (t.length === 128 && t.toString('latin1', 0, 3) === 'TAG') { end -= 128; removed.id3v1++; continue; }
    const foot = t.subarray(Math.max(0, t.length - 32));
    if (foot.length === 32 && foot.toString('latin1', 0, 8) === 'APETAGEX') {
      const total = foot.readUInt32LE(12) + (foot.readUInt32LE(20) & 0x80000000 ? 32 : 0);
      if (total >= 32 && total <= end) { end -= total; removed.ape++; continue; }
    }
    const f3 = t.subarray(Math.max(0, t.length - 10));
    if (f3.length === 10 && f3.toString('latin1', 0, 3) === '3DI') {
      const size = syncsafe(f3, 6), total = 20 + size;
      if (size >= 0 && total <= end && (await w.at(end - total, 3)).toString('latin1') === 'ID3') { end -= total; removed.id3v2++; continue; }
    }
    if (t.length >= 15 && t.toString('latin1', t.length - 9) === 'LYRICS200') {
      const digits = t.toString('latin1', t.length - 15, t.length - 9);
      const total = /^\d{6}$/.test(digits) ? Number(digits) + 15 : -1;
      if (total > 15 && total <= end && (await w.at(end - total, 11)).toString('latin1') === 'LYRICSBEGIN') { end -= total; removed.lyrics++; continue; }
    }
    break;
  }
  return end;
}

/**
 * The input, as frames only: written to `output`. → { frames, removed: { id3v2, id3v1, ape, lyrics, zeroBytes, cutFrame } }.
 * Throws `mp3-structure` (detail `at`: the byte offset) on anything it can't account for.
 */
async function sanitizeMp3(input, output) {
  const removed = { id3v2: 0, id3v1: 0, ape: 0, lyrics: 0, zeroBytes: 0, cutFrame: 0 };
  const w = await windowOn(input);
  const runs = []; // [start, end) byte ranges of frames to keep
  let frames = 0, stream = null;
  try {
    const end = await endOfAudio(w, removed);
    let pos = 0;
    while (pos < end) {
      const b = await w.at(pos, Math.min(32, end - pos));
      const f = frameAt(b);
      if (f && (stream === null || f.stream === stream)) {
        if (pos + f.len > end) { removed.cutFrame++; break; } // the last frame, cut short: dropped
        stream ||= f.stream;
        const last = runs[runs.length - 1];
        if (last && last[1] === pos) last[1] += f.len;
        else runs.push([pos, pos + f.len]);
        pos += f.len;
        frames++;
        continue;
      }
      const id3 = id3v2At(b);
      if (id3 !== null && pos + id3 <= end) { pos += id3; removed.id3v2++; continue; }
      const ape = apeHeaderAt(b);
      if (ape !== null && pos + ape <= end) { pos += ape; removed.ape++; continue; }
      if (b[0] === 0) {
        let n = 0;
        while (n < b.length && b[n] === 0) n++;
        pos += n;
        removed.zeroBytes += n;
        continue;
      }
      throw tag(new Error('unaccounted bytes in an MP3'), 'mp3-structure', { at: pos });
    }
    if (frames === 0) throw tag(new Error('no MPEG audio frames'), 'mp3-structure', { at: 0 });
    const out = await open(output, 'w');
    try {
      for (const [s, e] of runs) {
        for (let p = s; p < e; ) {
          const chunk = Buffer.from(await w.at(p, Math.min(1 << 20, e - p)));
          await out.write(chunk);
          p += chunk.length;
        }
      }
    } finally {
      await out.close();
    }
  } finally {
    await w.close();
  }
  return { frames, removed };
}

/**
 * The output, independently: frames of one stream from byte 0 to the end, and nothing else.
 * → [] when it is, else ONE leftover naming the first thing found (a tag's kind, or `mp3-unparsed` /
 * `mp3-short-frame` / `mp3-no-frames`). Types only, safe to log.
 */
async function mp3Leftovers(file) {
  const w = await windowOn(file);
  try {
    let pos = 0, stream = null, frames = 0;
    while (pos < w.size) {
      const b = await w.at(pos, Math.min(32, w.size - pos));
      const f = frameAt(b);
      if (f && (stream === null || f.stream === stream)) {
        if (pos + f.len > w.size) return ['mp3-short-frame'];
        stream ||= f.stream;
        pos += f.len;
        frames++;
        continue;
      }
      if (b.toString('latin1', 0, 3) === 'ID3' || b.toString('latin1', 0, 3) === '3DI') return ['id3v2'];
      if (b.toString('latin1', 0, 3) === 'TAG') return ['id3v1'];
      if (b.toString('latin1', 0, 8) === 'APETAGEX') return ['ape'];
      if (b.toString('latin1', 0, 11) === 'LYRICSBEGIN') return ['lyrics3'];
      // an APE tag written without its header starts with its items: named by its footer, at the very end
      if ((await w.at(Math.max(0, w.size - 32), 8)).toString('latin1') === 'APETAGEX') return ['ape'];
      return ['mp3-unparsed'];
    }
    return frames ? [] : ['mp3-no-frames'];
  } finally {
    await w.close();
  }
}

module.exports = { sanitizeMp3, mp3Leftovers, frameAt, id3v2At };
