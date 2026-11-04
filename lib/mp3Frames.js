// An MP3 by its structure: MPEG audio frames, one after another, and nothing
// else (Astra's P1 on worker #4, 2026-10-31).
//
// ffmpeg's MP3 demuxer resyncs past bytes it doesn't understand and a lossless
// copy keeps them: an ID3v2 tag BETWEEN frames or AFTER the audio (v2.2, v2.3,
// v2.4 with or without its footer), in mono and stereo, came through the remux
// while the old check (an ID3v2 header at byte 0) said clean. So:
//
//   sanitizeMp3   (the input, before the remux) walks the whole file frame by
//                 frame and writes ONLY the frames to a new file. Tags between
//                 frames or at the end (ID3v2 anywhere, ID3v1, APE, Lyrics3 v2,
//                 Lyrics3 v1 directly before an ID3v1) and runs of zero bytes
//                 are dropped, and so is ONE cut-off last frame, whatever its
//                 duration (up to about 72 ms at the lowest rates), when
//                 nothing but those trailers follows it (Sandy, 2026-11-01 and
//                 -03: archive files often have no source left to re-export;
//                 the safety is that its bytes are dropped, not how short it
//                 is). Anything else refuses the file: bytes the walk can't
//                 account for, a cut frame anywhere else included, or a later
//                 complete frame inside the cut frame's remains
//                 (`mp3-structure`), or a recognisable tag INSIDE a whole frame
//                 (`mp3-tag-in-audio`). It never guesses past.
//   mp3Leftovers  (the output, independently) must be frames from its first byte
//                 to its last, every one the same stream (MPEG version, layer,
//                 sample rate), the last one ending exactly at the end, and no
//                 recognisable tag anywhere in it, frame interiors included.
//
// What the strip promises (Sandy's option A on Astra's second verdict,
// 2026-11-01): standard metadata that real tools write is removed; a
// recognisable tag inside the audio frames gets the file refused, never cut
// out (no byte surgery on compressed audio); arbitrary data hidden inside the
// audio is outside the promise. "Recognisable" is the validators below: the
// whole structure, not its signature alone, since compressed audio is close to
// random bytes and a 3-byte "TAG" turns up in real music by chance.

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

// ── the validators: a whole structure at b[0], its length, or null. `room` is how many bytes the file has from b[0].

const syncsafe = (b, o) => (b[o] & 0x80) | (b[o + 1] & 0x80) | (b[o + 2] & 0x80) | (b[o + 3] & 0x80) ? -1 : (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
// the flag bits each ID3v2 version leaves undefined (they must be 0)
const ID3_UNDEFINED_FLAGS = { 2: 0x3f, 3: 0x1f, 4: 0x0f };

/** An ID3v2 header (v2.2–v2.4): its whole length (header, body, a v2.4 footer), or null. */
function id3v2At(b, room = Infinity) {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null; // 'ID3'
  if (b[3] < 2 || b[3] > 4 || b[4] === 0xff || b[5] & ID3_UNDEFINED_FLAGS[b[3]]) return null;
  const size = syncsafe(b, 6);
  if (size < 0) return null;
  const total = 10 + size + (b[3] === 4 && b[5] & 0x10 ? 10 : 0);
  return total <= room ? total : null;
}
// a frame id: v2.2 three characters, v2.3 and v2.4 four (A–Z and 0–9, starting with a letter)
const FRAME_ID = { 2: /^[A-Z][A-Z0-9]{2}$/, 3: /^[A-Z][A-Z0-9]{3}$/, 4: /^[A-Z][A-Z0-9]{3}$/ };
/**
 * Inside the audio, an ID3v2 header counts when its tag carries something: a valid header, a body, and a first frame
 * with a real frame id (or an extended header, or v2.2 compression, first). "ID3", a version byte and then zeros is
 * what quiet audio can look like (Sandy's 94-minute set has a "TAG" so placed): a size-0 or padding-only tag holds no
 * data. Between frames and at the end the plain header (id3v2At) is enough to remove a tag.
 */
function id3v2CarryingAt(b, room) {
  const total = id3v2At(b, room);
  if (total === null || total <= 10) return null;
  if (b[5] & 0x40) return total;
  const idLen = b[3] === 2 ? 3 : 4;
  return b.length >= 10 + idLen && FRAME_ID[b[3]].test(b.toString('latin1', 10, 10 + idLen)) ? total : null;
}
/** An ID3v2.4 footer ('3DI', which says so in its own flags): 10, or null. */
function id3v2FooterAt(b) {
  if (b.length < 10 || b[0] !== 0x33 || b[1] !== 0x44 || b[2] !== 0x49) return null; // '3DI'
  if (b[3] !== 4 || b[4] === 0xff || b[5] & ID3_UNDEFINED_FLAGS[4] || !(b[5] & 0x10) || syncsafe(b, 6) < 0) return null;
  return 10;
}
// ID3v1 text (rule A, Sandy, 2026-11-01; UTF-8 added on Astra's P1, 2026-11-03): a field counts as text when every
// byte is printable ASCII or Latin-1, or NUL, in any order (so a field a tagger shortened, its new text, a NUL and the
// old text's tail, still counts); or when it is valid UTF-8 of printable characters with NULs anywhere between them.
// Real taggers write UTF-8 there (ffmpeg's ID3v1 is UTF-8, and it cuts a title at the field's 30 bytes, mid-character
// if it falls there), so a character cut by the field's end or by a NUL counts too
const latin1Text = (b, from, to) => {
  for (let i = from; i < to; i++) if (!(b[i] === 0 || (b[i] >= 0x20 && b[i] !== 0x7f && (b[i] < 0x80 || b[i] >= 0xa0)))) return false;
  return true;
};
function utf8Text(b, from, to) {
  for (let i = from; i < to; ) {
    const c = b[i];
    if (c < 0x80) {
      if (c !== 0 && (c < 0x20 || c === 0x7f)) return false;
      i++;
      continue;
    }
    // a lead byte: how many continuation bytes follow (C0, C1 and F5–FF never lead)
    const n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
    if (!n) return false;
    let cp = c & (0x3f >> n), k = 1;
    for (; k <= n && i + k < to && b[i + k] !== 0; k++) {
      if ((b[i + k] & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (b[i + k] & 0x3f);
    }
    // whole: not overlong, not a surrogate, not past U+10FFFF, not a C1 control
    if (k > n && ((n === 2 && cp < 0x800) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff) || cp <= 0x9f)) return false;
    i += k;
  }
  return true;
}
const v1Text = (b, from, to) => latin1Text(b, from, to) || utf8Text(b, from, to);
/**
 * Inside the audio, an ID3v1 tag (128 bytes: TAG, title, artist, album, year, comment or v1.1 comment + track,
 * genre): 128, or null. It counts when every text field is text by v1Text, at any length, empty included (rule A,
 * Sandy, 2026-11-01). Measured on the corpus and Sandy's five named MP3s: of 25 chance "TAG"s inside their frames,
 * it counts one, in her 94-minute set (at 45,522,714: TAG ßG}2oô and then zeros), so that file is refused; UTF-8
 * counts no other. Her refinement (a tag with every text field empty doesn't count) was measured too: it spares none
 * of them, that title isn't empty, so it is not kept.
 */
function id3v1At(b, room = Infinity) {
  if (b.length < 128 || room < 128 || b[0] !== 0x54 || b[1] !== 0x41 || b[2] !== 0x47) return null; // 'TAG'
  // title, artist, album, year; then the comment: v1.0 30 bytes, or v1.1 28 bytes, a NUL and the track number
  if (!v1Text(b, 3, 33) || !v1Text(b, 33, 63) || !v1Text(b, 63, 93) || !v1Text(b, 93, 97)) return null;
  return v1Text(b, 97, 127) || (b[125] === 0 && v1Text(b, 97, 125)) ? 128 : null;
}
/** An APE tag header or footer ('APETAGEX', version 1000 or 2000, a size of at least its own 32 bytes, reserved bytes 0): { size, header, hasHeader }, or null. */
function apeBlockAt(b) {
  if (b.length < 32 || b.toString('latin1', 0, 8) !== 'APETAGEX') return null;
  const version = b.readUInt32LE(8), size = b.readUInt32LE(12);
  if ((version !== 1000 && version !== 2000) || size < 32 || b.readUInt32LE(24) !== 0 || b.readUInt32LE(28) !== 0) return null;
  return { size, header: !!(b.readUInt32LE(20) & 0x20000000), hasHeader: !!(b.readUInt32LE(20) & 0x80000000) };
}
/** An APE tag starting with its header: its whole length, or null. */
function apeHeaderAt(b, room = Infinity) {
  const a = apeBlockAt(b);
  return a && a.header && 32 + a.size <= room ? 32 + a.size : null;
}
// Lyrics3: its markers are long enough to be recognised as they are
const LYRICS_MARKERS = ['LYRICSBEGIN', 'LYRICS200', 'LYRICSEND'].map((m) => Buffer.from(m, 'latin1'));
const lyricsAt = (b) => (LYRICS_MARKERS.some((m) => b.length >= m.length && b.subarray(0, m.length).equals(m)) ? 11 : null);

// every recognisable structure, by the first bytes it starts with
const RECOGNISED = [
  ['ID3', 'id3v2', (b, room) => id3v2CarryingAt(b, room)],
  ['3DI', 'id3v2', (b) => id3v2FooterAt(b)],
  ['TAG', 'id3v1', (b, room) => id3v1At(b, room)],
  ['APETAGEX', 'ape', (b, room) => { const a = apeBlockAt(b); return a && (a.header ? 32 + a.size <= room : room >= 32) ? 32 : null; }],
  ['LYRICS', 'lyrics3', (b) => lyricsAt(b)],
].map(([magic, kind, valid]) => ({ magic: Buffer.from(magic, 'latin1'), kind, valid }));
const LONGEST = 128; // the most bytes any validator reads (ID3v1)

/** Reads a file through a 1 MB window (never the whole file into memory). */
async function windowOn(file) {
  const fh = await open(file, 'r');
  const { size } = await fh.stat();
  let start = 0, buf = Buffer.alloc(0);
  return {
    size,
    /** Up to `len` bytes at `pos` (fewer at the end), `len` at most 1 MB. */
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

/**
 * The first recognisable structure STARTING in [from, to) of the window's file: { kind, at } or null.
 * A structure may run past `to` (its bytes are read from the file); only where it starts counts.
 */
async function recognisedWithin(w, from, to) {
  const STEP = (1 << 20) - LONGEST;
  let first = null;
  for (let p = from; p < to && !first; p += STEP) {
    const starts = Math.min(STEP, to - p);
    const chunk = await w.at(p, starts + LONGEST);
    for (const { magic, kind, valid } of RECOGNISED) {
      for (let i = chunk.indexOf(magic); i >= 0 && i < starts; i = chunk.indexOf(magic, i + 1)) {
        if (first && p + i >= first.at) break;
        if (valid(chunk.subarray(i), w.size - (p + i)) !== null) { first = { kind, at: p + i }; break; }
      }
    }
  }
  return first;
}

// Lyrics3 v1: LYRICSBEGIN, at most 5100 bytes of lyrics, LYRICSEND, and then an ID3v1 tag (it has no size of its own)
const LYRICS1_MAX = 11 + 5100 + 9;

/**
 * Where the trailers at the very end begin (ID3v1, APE by its footer, ID3v2 by its footer, Lyrics3 v2, and Lyrics3
 * v1 directly before an ID3v1), read back from the end of the file. A frame that runs into this point is the cut
 * last frame (or holds the trailer's start): the frame walk drops it with them.
 */
async function endOfAudio(w, removed) {
  let end = w.size, beforeV1 = false;
  for (let i = 0; i < 8; i++) {
    const t = await w.at(Math.max(0, end - 128), Math.min(end, 128));
    // at the end, 'TAG' alone (a real tool's ID3v1 can have untidy fields): the frame walk refuses an overlap
    if (t.length === 128 && t.toString('latin1', 0, 3) === 'TAG') { end -= 128; removed.id3v1++; beforeV1 = true; continue; }
    const v1Next = beforeV1;
    beforeV1 = false;
    // Lyrics3 v1, only where it belongs: its LYRICSEND directly before an ID3v1 just removed. From the last
    // LYRICSBEGIN within its maximum length (anything before that is left to the frame walk)
    if (v1Next && t.length >= 20 && t.toString('latin1', t.length - 9) === 'LYRICSEND') {
      const back = await w.at(Math.max(0, end - LYRICS1_MAX), Math.min(end, LYRICS1_MAX));
      const begin = back.lastIndexOf('LYRICSBEGIN', back.length - 20, 'latin1');
      if (begin >= 0) { end -= back.length - begin; removed.lyrics++; continue; }
    }
    const foot = t.subarray(Math.max(0, t.length - 32));
    const ape = apeBlockAt(foot);
    if (ape && !ape.header) {
      const total = ape.size + (ape.hasHeader ? 32 : 0);
      if (total <= end && (!ape.hasHeader || apeHeaderAt(await w.at(end - total, 32), total) === total)) { end -= total; removed.ape++; continue; }
    }
    const f3 = t.subarray(Math.max(0, t.length - 10));
    if (id3v2FooterAt(f3) !== null) {
      const total = 20 + syncsafe(f3, 6);
      if (total <= end && id3v2At(await w.at(end - total, 10), total) === total) { end -= total; removed.id3v2++; continue; }
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

/** A frame header cut short (1–3 bytes): the start of a header of the stream whose first header is `first`. */
const headerStart = (b, first) => b.length > 0 && b.length < 4 && b[0] === 0xff && (b.length < 2 || b[1] === first[1])
  && (b.length < 3 || ((b[2] & 0x0c) === (first[2] & 0x0c) && b[2] >> 4 !== 0 && b[2] >> 4 !== 15));

/** Bytes that start a header of this stream: a whole header (4 bytes) of it, or the start of one (1–3: 0xFF, then as headerStart). */
const startsHeader = (h, stream, first) => (h.length >= 4 ? frameAt(h)?.stream === stream : h.length >= 2 ? headerStart(h, first) : h[0] === 0xff);

/**
 * Inside a cut last frame's remains (`rest`, from its own header to where the audio ends): where a LATER COMPLETE FRAME
 * starts, or -1. One counts when a header of the stream starts there, its frame fits before the audio's end, and the
 * stream confirms it: the audio ends exactly where it does, or only zero bytes follow it, or what follows starts another
 * header of the stream (from a single 0xFF on). Without that, a header there is the cut frame's own bytes as far as
 * anything can tell: compressed audio holds headers by chance, a quiet frame's filler (runs of 0xFF, 0x55, 0xAA) more
 * often, and what follows one is audio, not a frame. So is a header whose frame runs past the end (a cut frame's start
 * or chance): nothing after it can confirm it, and it is dropped with the cut frame.
 */
function laterFrameIn(rest, stream, first) {
  for (let q = 1; q + 4 <= rest.length; q++) {
    if (rest[q] !== 0xff) continue;
    const g = frameAt(rest.subarray(q, q + 4));
    if (!g || g.stream !== stream || q + g.len > rest.length) continue;
    const after = rest.subarray(q + g.len);
    if (!after.length || after.every((c) => c === 0) || startsHeader(after, stream, first)) return q;
  }
  return -1;
}

/**
 * The input, as frames only: written to `output`. → { frames, removed: { id3v2, id3v1, ape, lyrics, zeroBytes,
 * cutFrame } }. Throws (detail `at`: the byte offset in the input) `mp3-structure` on anything it can't account for,
 * `mp3-tag-in-audio` on a recognisable tag inside a whole frame. Nothing is written then.
 */
async function sanitizeMp3(input, output) {
  const removed = { id3v2: 0, id3v1: 0, ape: 0, lyrics: 0, zeroBytes: 0, cutFrame: 0 };
  const w = await windowOn(input);
  const runs = []; // [start, end) byte ranges of frames to keep
  let frames = 0, stream = null, first = null;
  try {
    const end = await endOfAudio(w, removed);
    let pos = 0;
    while (pos < end) {
      // (only bytes before the trailers: a frame header is read from the audio alone)
      const b = await w.at(pos, Math.min(32, end - pos));
      const f = frameAt(b);
      const ours = f && (stream === null || f.stream === stream);
      // the last frame, cut short: the audio ends inside it (the file's end, or a trailer read back from the end).
      // Dropped with the trailers (Sandy, 2026-11-01), so nothing in its bytes is kept: a cut frame's remains, or a
      // tag inside the real last frame that was read as a trailer. A cut frame anywhere else leaves the walk on bytes
      // it can't account for, and is refused
      if ((ours && pos + f.len > end) || (first && headerStart(b, first))) {
        // Sandy's three promises (2026-11-03): no complete frame is ever dropped, no byte of the cut frame survives, at
        // most one frame is trimmed. So exactly ONE incomplete frame, whatever its duration: a later complete frame
        // inside its remains (a VBR file's 32 kbps frame inside a cut 320 kbps one, Astra's P2 on #4) refuses the
        // file. What is dropped is less than this one frame's own length, from the last header the walk followed
        if (!frames) break; // a file that is one cut frame: no frames, refused below
        const q = laterFrameIn(await w.at(pos, end - pos), stream, first);
        if (q >= 0) throw tag(new Error('a complete frame inside the cut last MP3 frame'), 'mp3-structure', { at: pos + q });
        removed.cutFrame++;
        break;
      }
      if (ours) {
        stream ||= f.stream;
        first ||= Buffer.from(b.subarray(0, 4));
        const last = runs[runs.length - 1];
        if (last && last[1] === pos) last[1] += f.len;
        else runs.push([pos, pos + f.len]);
        pos += f.len;
        frames++;
        continue;
      }
      const id3 = id3v2At(b, end - pos);
      if (id3 !== null) { pos += id3; removed.id3v2++; continue; }
      const ape = apeHeaderAt(b, end - pos);
      if (ape !== null) { pos += ape; removed.ape++; continue; }
      if (b[0] === 0) {
        let n = 0;
        while (n < b.length && pos + n < end && b[n] === 0) n++;
        pos += n;
        removed.zeroBytes += n;
        continue;
      }
      throw tag(new Error('unaccounted bytes in an MP3'), 'mp3-structure', { at: pos });
    }
    if (frames === 0) throw tag(new Error('no MPEG audio frames'), 'mp3-structure', { at: 0 });
    // inside the frames: a recognisable tag refuses the file (it is never cut out of the audio)
    for (const [s, e] of runs) {
      const hit = await recognisedWithin(w, s, e);
      if (hit) throw tag(new Error('a tag inside the MP3 frames'), 'mp3-tag-in-audio', { at: hit.at });
    }
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
 * The output, independently: frames of one stream from byte 0 to the end, and no recognisable structure anywhere in
 * the file (frame interiors included). → [] when it is, else ONE leftover naming the first thing found (a tag's
 * kind, or `mp3-unparsed` / `mp3-short-frame` / `mp3-no-frames`). Types only, safe to log.
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
      if (b.toString('latin1', 0, 6) === 'LYRICS') return ['lyrics3'];
      // an APE tag written without its header starts with its items: named by its footer, at the very end
      if ((await w.at(Math.max(0, w.size - 32), 8)).toString('latin1') === 'APETAGEX') return ['ape'];
      return ['mp3-unparsed'];
    }
    if (!frames) return ['mp3-no-frames'];
    // every byte is a frame: now inside them, the whole file
    const hit = await recognisedWithin(w, 0, w.size);
    return hit ? [hit.kind] : [];
  } finally {
    await w.close();
  }
}

module.exports = { sanitizeMp3, mp3Leftovers, recognisedWithin, windowOn, frameAt, id3v2At, id3v2CarryingAt, id3v2FooterAt, id3v1At, apeBlockAt };
