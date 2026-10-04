// Strip every bit of metadata from an uploaded media file — video or audio, any
// container we accept — without re-encoding, and PROVE the result carries none.
//
// Phones and editors record where and how media was made: a video's `©xyz` /
// ISO6709 / `loci` atoms and XMP; an MP3's ID3 tags and album art (whose JPEG can
// carry GPS EXIF — Astra's P2-1 on #646); FLAC / Ogg comments and picture blocks;
// Matroska tags and attachments. mixmi serves media publicly, so none of it may
// stay (the About page's globe privacy promise, 2026-10-04).
//
// Unconditional: every file is remuxed, whatever it seems to carry —
//
//   -map 0:V? -map 0:a?  keep only real picture and sound streams. `V` (capital)
//                        EXCLUDES attached pictures (album art / cover art), and
//                        data / subtitle / attachment streams are never mapped
//   -c copy              lossless: no re-encode
//   -map_metadata -1     drop container + stream metadata (tags, comments, …)
//   -map_chapters -1     drop chapters
//   bitexact flags       ffmpeg writes no versioned encoder tag of its own
//   per container        mp3: no ID3v2 / ID3v1 at all; mp4/mov: +faststart
//
// then (ISO only) any metadata box the muxer still writes is blanked to `free`,
// and `metadataReport` VERIFIES the output, per container, by its structure:
//   iso       no udta / meta / ilst / keys / uuid / XMP_ / loci / ©-box anywhere
//   mp3       no ID3v2 header, no ID3v1 / APE tag
//   wav       only fmt / data / fact chunks
//   flac      only STREAMINFO / PADDING / SEEKTABLE, and a comment block with
//             zero comments
//   ogg       comment header with zero comments
//   matroska  (webm) checked through its tags and streams below
// and for every container: only audio and real video streams (no attached
// picture, data, subtitle or attachment), and no tags beyond the structural
// ones listed — each with its value shape checked, so nothing personal fits.
const ffmpeg = require('fluent-ffmpeg');
const { open, stat } = require('fs/promises');
const { probeFile } = require('./storageIO');

// Byte markers, for tests (presence only — never the values).
const LOCATION_MARKERS = [
  { name: '©xyz', bytes: Buffer.from([0xa9, 0x78, 0x79, 0x7a]), atom: true },
  { name: 'ISO6709', bytes: Buffer.from('com.apple.quicktime.location.ISO6709', 'latin1'), atom: false },
  { name: 'loci', bytes: Buffer.from('loci', 'latin1'), atom: true },
  { name: 'xmp-gps', bytes: Buffer.from('exif:GPSLatitude', 'latin1'), atom: false },
];
function hasAtom(buf, name) {
  let i = buf.indexOf(name);
  while (i >= 4) {
    const size = buf.readUInt32BE(i - 4);
    if (size >= 8 && size <= 1 << 20) return true;
    i = buf.indexOf(name, i + 1);
  }
  return false;
}
function locationMarkers(buf) {
  return LOCATION_MARKERS.filter((m) => (m.atom ? hasAtom(buf, m.bytes) : buf.includes(m.bytes))).map((m) => m.name);
}

// ── what a file is, by probing ───────────────────────────────────────────────

const WEBM_CODECS = new Set(['vp8', 'vp9', 'av1', 'opus', 'vorbis']);

/**
 * The container, by probing the content (never the name): { family, muxer, brand }.
 *   iso: mp4 / mov / m4a / 3gp — QuickTime (major brand `qt`, or no ftyp at all,
 *        as in a MOV/M4A opening with a free box) stays mov, the rest mp4
 *   mp3 · wav · flac · ogg · matroska (webm when every codec is webm-legal)
 * null: anything else (refused).
 */
async function mediaFormat(file, deadlineMs = 60_000) {
  let p;
  try {
    p = await probeFile(file, deadlineMs);
  } catch {
    return null;
  }
  const name = p.format?.format_name || '';
  const streams = p.streams || [];
  if (/mov|mp4|m4a|3gp|3g2|mj2/.test(name)) {
    const brand = String(p.format?.tags?.major_brand || '').trim() || 'qt';
    return { family: 'iso', muxer: brand === 'qt' ? 'mov' : 'mp4', brand };
  }
  if (name === 'mp3') return { family: 'mp3', muxer: 'mp3' };
  if (name === 'wav') return { family: 'wav', muxer: 'wav' };
  if (name === 'flac') return { family: 'flac', muxer: 'flac' };
  if (name === 'ogg') return { family: 'ogg', muxer: 'ogg' };
  if (/matroska|webm/.test(name)) {
    const real = streams.filter((s) => (s.codec_type === 'audio' || s.codec_type === 'video') && !s.disposition?.attached_pic);
    return { family: 'matroska', muxer: real.every((s) => WEBM_CODECS.has(s.codec_name)) ? 'webm' : 'matroska' };
  }
  return null;
}

/** Back-compat helper (tests, the endpoint's brand check): the ISO major brand or null. */
async function containerBrand(file, deadlineMs = 60_000) {
  const f = await mediaFormat(file, deadlineMs);
  return f && f.family === 'iso' ? f.brand : null;
}

// ── the strip ───────────────────────────────────────────────────────────────

/** Remux `input` → `output` with no metadata, losslessly. `fmt` from mediaFormat. */
function stripMedia(input, output, fmt, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let command;
    const killTimer = setTimeout(() => {
      try { command.kill('SIGKILL'); } catch (e) { /* ignore */ }
      reject(new Error('FFmpeg timed out'));
    }, timeoutMs);
    const opts = [
      '-map 0:V?', // real video only — never attached pictures
      '-map 0:a?',
      '-c copy',
      '-map_metadata -1',
      '-map_metadata:s -1',
      '-map_chapters -1',
      '-fflags +bitexact',
      '-flags:v +bitexact',
      '-flags:a +bitexact',
    ];
    if (fmt.family === 'iso') opts.push('-movflags +faststart');
    if (fmt.family === 'mp3') opts.push('-id3v2_version 0', '-write_id3v1 0');
    command = ffmpeg(input)
      .outputOptions(opts)
      .format(fmt.muxer)
      .on('error', (err) => { clearTimeout(killTimer); reject(err); })
      .on('end', () => { clearTimeout(killTimer); resolve(); });
    command.save(output);
  });
}
/** Old name, kept for the transcode path and tests: an ISO strip to mp4 or mov. */
const stripVideoMetadata = (input, output, muxer, timeoutMs) => stripMedia(input, output, { family: 'iso', muxer }, timeoutMs);

// ── ISO box tree ────────────────────────────────────────────────────────────

// Boxes that hold metadata — never allowed in the output, at any depth.
const METADATA_BOXES = new Set(['udta', 'meta', 'ilst', 'keys', 'uuid', 'XMP_', 'loci', 'xyz ', 'cprt', 'auth', 'titl', 'dscp', 'gnre', 'perf', 'albm', 'yrrc', 'rtng', 'clsf', 'kywd', 'smta', 'tags', 'covr']);
// Container boxes walked into (never mdat: media payload isn't structure).
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra', 'tref', 'sinf', 'schi', 'udta']);
const isMetadataBox = (t) => METADATA_BOXES.has(t) || t.charCodeAt(0) === 0xa9;
// Visual sample entries: their 32-byte `compressorname` names the camera's or
// encoder's codec writer — zeroed (same size) like any other metadata.
const VISUAL_ENTRIES = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp08', 'vp09', 'mp4v', 'jpeg', 'mjpa', 'mjpb', 's263', 'h263', 'apcn', 'apch', 'apcs', 'apco', 'ap4h', 'ap4x']);
const COMPRESSORNAME_AT = 50;
const VENDOR_AT = 20; // sample entry: 8 header + 6 reserved + 2 data-ref index + 2 version + 2 revision

/** Every box in the tree: { type, off, len, inStsd } (headers only; containers walked, mdat never). */
async function boxList(file) {
  const fh = await open(file, 'r');
  const types = [];
  const hdr = Buffer.alloc(16);
  try {
    const { size: fileSize } = await fh.stat();
    const walk = async (start, end, depth, inStsd = false) => {
      let off = start;
      while (off + 8 <= end) {
        await fh.read(hdr, 0, 16, off);
        let len = hdr.readUInt32BE(0);
        const type = hdr.subarray(4, 8).toString('latin1');
        let head = 8;
        if (len === 1) { len = Number(hdr.readBigUInt64BE(8)); head = 16; } else if (len === 0) len = end - off;
        if (len < head || off + len > end) throw new Error('malformed box tree');
        types.push({ type, off, len, inStsd: !!inStsd });
        if (depth < 12 && CONTAINERS.has(type)) await walk(off + head, off + len, depth + 1);
        else if (type === 'stsd' && len >= head + 8) await walk(off + head + 8, off + len, depth + 1, true);
        off += len;
      }
    };
    await walk(0, fileSize, 0);
  } finally {
    await fh.close();
  }
  return types;
}
async function boxTypes(file) {
  return (await boxList(file)).filter((b) => !b.inStsd).map((b) => b.type);
}

/**
 * ffmpeg's mp4 muxer writes an (empty) udta/meta even with -map_metadata -1.
 * Retype every metadata box to `free` and zero its payload (same size: no
 * sample offset moves), and zero the visual sample entries' compressorname.
 */
async function blankMetadataBoxes(file) {
  const all = await boxList(file);
  const boxes = all.filter((b) => !b.inStsd && isMetadataBox(b.type));
  const outer = boxes.filter((b) => !boxes.some((o) => o !== b && o.off <= b.off && b.off + b.len <= o.off + o.len));
  const visual = all.filter((b) => b.inStsd && VISUAL_ENTRIES.has(b.type) && b.len >= COMPRESSORNAME_AT + 32);
  // QuickTime sample entries carry a 4-byte vendor code (Apple writes 'appl')
  // at offset 20; in ISO files those bytes are reserved zeros anyway.
  const entries = all.filter((b) => b.inStsd && b.len >= VENDOR_AT + 4);
  if (!outer.length && !visual.length && !entries.length) return 0;
  const fh = await open(file, 'r+');
  try {
    for (const v of visual) await fh.write(Buffer.alloc(32), 0, 32, v.off + COMPRESSORNAME_AT);
    for (const e of entries) await fh.write(Buffer.alloc(4), 0, 4, e.off + VENDOR_AT);
    for (const b of outer) {
      const hdr = Buffer.alloc(16);
      await fh.read(hdr, 0, 16, b.off);
      const head = hdr.readUInt32BE(0) === 1 ? 16 : 8;
      await fh.write(Buffer.from('free', 'latin1'), 0, 4, b.off + 4);
      const zeros = Buffer.alloc(Math.min(b.len - head, 1 << 20));
      for (let o = b.off + head; o < b.off + b.len; o += zeros.length) {
        await fh.write(zeros, 0, Math.min(zeros.length, b.off + b.len - o), o);
      }
    }
  } finally {
    await fh.close();
  }
  return outer.length + visual.length + entries.length;
}

// ── per-container structure checks (what is LEFT that could carry metadata) ─

async function readRange(file, start, len) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** WAV: chunk ids other than fmt / data / fact. */
async function wavLeftovers(file) {
  const fh = await open(file, 'r');
  const out = [];
  const hdr = Buffer.alloc(12);
  try {
    const { size } = await fh.stat();
    await fh.read(hdr, 0, 12, 0);
    if (hdr.subarray(0, 4).toString('latin1') !== 'RIFF' || hdr.subarray(8, 12).toString('latin1') !== 'WAVE') return ['not-a-wav'];
    let off = 12;
    while (off + 8 <= size) {
      await fh.read(hdr, 0, 8, off);
      const id = hdr.subarray(0, 4).toString('latin1');
      const len = hdr.readUInt32LE(4);
      if (!['fmt ', 'data', 'fact'].includes(id)) out.push(`chunk:${id}`);
      off += 8 + len + (len & 1);
    }
  } finally {
    await fh.close();
  }
  return out;
}

/** MP3: an ID3v2 header, an ID3v1 or APE tag. */
async function mp3Leftovers(file) {
  const { size } = await stat(file);
  const head = await readRange(file, 0, 10);
  const tail = await readRange(file, Math.max(0, size - 160), 160);
  const out = [];
  if (head.subarray(0, 3).toString('latin1') === 'ID3') out.push('id3v2');
  if (tail.length >= 128 && tail.subarray(tail.length - 128, tail.length - 125).toString('latin1') === 'TAG') out.push('id3v1');
  if (tail.includes(Buffer.from('APETAGEX', 'latin1'))) out.push('ape');
  return out;
}

/** FLAC: metadata blocks other than STREAMINFO / PADDING / SEEKTABLE, or any comment. */
async function flacLeftovers(file) {
  const out = [];
  const fh = await open(file, 'r');
  try {
    const sig = Buffer.alloc(4);
    await fh.read(sig, 0, 4, 0);
    if (sig.toString('latin1') !== 'fLaC') return ['not-a-flac'];
    let off = 4;
    for (let i = 0; i < 256; i++) {
      const h = Buffer.alloc(4);
      await fh.read(h, 0, 4, off);
      const last = h[0] & 0x80, type = h[0] & 0x7f, len = h.readUIntBE(1, 3);
      if (type === 4) {
        const body = Buffer.alloc(len);
        await fh.read(body, 0, len, off + 4);
        const vl = body.readUInt32LE(0);
        const n = body.readUInt32LE(4 + vl);
        if (n !== 0) out.push(`vorbis-comments:${n}`);
      } else if (![0, 1, 3].includes(type)) out.push(`block:${type}`);
      off += 4 + len;
      if (last) break;
    }
  } finally {
    await fh.close();
  }
  return out;
}

/** Ogg: the comment header's comment count (OpusTags or Vorbis). */
async function oggLeftovers(file) {
  const head = await readRange(file, 0, 256 * 1024);
  const out = [];
  for (const [marker, skip] of [[Buffer.from('OpusTags', 'latin1'), 8], [Buffer.from('\x03vorbis', 'latin1'), 7]]) {
    const i = head.indexOf(marker);
    if (i < 0) continue;
    const vl = head.readUInt32LE(i + skip);
    const n = head.readUInt32LE(i + skip + 4 + vl);
    if (n !== 0) out.push(`ogg-comments:${n}`);
  }
  if (head.includes(Buffer.from('METADATA_BLOCK_PICTURE', 'latin1'))) out.push('ogg-picture');
  return out;
}

// Structural tags, each with the only value shape allowed — nothing personal fits.
const STRUCTURAL_FORMAT = {
  major_brand: /^[\w ]{1,4}$/,
  minor_version: /^\d+$/,
  compatible_brands: /^[\w ]+$/,
  encoder: /^Lavf$/, // the Matroska muxer's own fixed name under bitexact (no version)
};
const STRUCTURAL_STREAM = {
  language: /^[a-z]{3}$/,
  handler_name: /^(VideoHandler|SoundHandler)$/,
  vendor_id: /^\[0\]\[0\]\[0\]\[0\]$/,
  DURATION: /^\d{2}:\d{2}:\d{2}\.\d+$/, // Matroska's computed duration
};
const badTags = (tags, allowed) => Object.entries(tags || {}).filter(([k, v]) => !(allowed[k] && allowed[k].test(String(v)))).map(([k]) => k);

/**
 * What metadata a file still carries — structure only, never values. `family`
 * from mediaFormat ('iso' | 'mp3' | 'wav' | 'flac' | 'ogg' | 'matroska').
 * `clean` only when there is none.
 */
async function metadataReport(file, family, deadlineMs = 60_000) {
  const p = await probeFile(file, deadlineMs);
  const formatTags = badTags(p.format?.tags, STRUCTURAL_FORMAT);
  const streams = p.streams || [];
  const streamTags = streams.flatMap((s) => badTags(s.tags, STRUCTURAL_STREAM));
  const otherStreams = streams.filter((s) => !(s.codec_type === 'audio' || s.codec_type === 'video') || s.disposition?.attached_pic).length;
  let leftovers = [];
  if (family === 'iso') leftovers = (await boxList(file)).filter((b) => !b.inStsd && isMetadataBox(b.type)).map((b) => `box:${b.type}`);
  else if (family === 'wav') leftovers = await wavLeftovers(file);
  else if (family === 'mp3') leftovers = await mp3Leftovers(file);
  else if (family === 'flac') leftovers = await flacLeftovers(file);
  else if (family === 'ogg') leftovers = await oggLeftovers(file);
  else if (family !== 'matroska') leftovers = [`unknown-family:${family}`];
  return {
    clean: formatTags.length === 0 && streamTags.length === 0 && otherStreams === 0 && leftovers.length === 0,
    formatTags: formatTags.length,
    streamTags: streamTags.length,
    otherStreams,
    leftovers: [...new Set(leftovers)], // types only (e.g. 'box:udta', 'id3v2') — safe to log
  };
}

/** What a file contains, for the before/after match: real streams + duration. */
async function streamSummary(file, deadlineMs = 60_000) {
  const p = await probeFile(file, deadlineMs);
  const streams = p.streams || [];
  return {
    video: streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic).length,
    audio: streams.filter((s) => s.codec_type === 'audio').length,
    duration: Number(p.format?.duration) || 0,
  };
}

/** The output keeps every real picture and sound stream and the same duration (±0.5 s). */
function sameContent(before, after) {
  return before.video === after.video && before.audio === after.audio && before.video + before.audio > 0 && Math.abs(before.duration - after.duration) <= 0.5;
}

module.exports = {
  mediaFormat, containerBrand, stripMedia, stripVideoMetadata, blankMetadataBoxes, metadataReport,
  boxTypes, locationMarkers, streamSummary, sameContent,
};
