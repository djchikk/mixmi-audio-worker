// Strip every bit of metadata from a video or m4a, without re-encoding — and
// PROVE the result carries none.
//
// Phones record where a video was made: Android in a `©xyz` atom, iPhone in the
// `com.apple.quicktime.location.ISO6709` key (and sometimes a timed-metadata
// track), 3GPP in a `loci` atom, editors in XMP `uuid` boxes. mixmi serves
// media publicly, so none of it may stay (the About page's globe privacy
// promise, 2026-10-04).
//
// Unconditional (Astra on worker #3, finding 1): there is no "already clean"
// decision from tag names — every file is remuxed:
//
//   -map 0:v? -map 0:a?  keep only picture and sound (either may be absent —
//                        m4a has no picture) — drops data / timed-metadata
//                        tracks (where a moving location can live)
//   -c copy              no re-encode: same quality, fast
//   -map_metadata -1     drop container + stream metadata (udta / meta / ilst
//                        / keys — location, creation time, make/model, …)
//   -map_chapters -1     drop chapters
//   bitexact flags       ffmpeg writes no encoder tag of its own
//   +faststart           playback can start while streaming
//
// then every metadata box the muxer still writes (mp4: an empty udta/meta) is
// blanked to `free` (blankMetadataBoxes), and `metadataReport` verifies the OUTPUT: no metadata box anywhere in the
// box tree (udta, meta, ilst, keys, uuid, XMP_, loci, any ©-box — whatever the
// namespace prefix of what's inside), no data streams, and no tags beyond the
// structural ones (brand, track language / handler). Anything else fails.
const ffmpeg = require('fluent-ffmpeg');
const { open } = require('fs/promises');
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

// Boxes that hold metadata — never allowed in the output, at any depth.
const METADATA_BOXES = new Set(['udta', 'meta', 'ilst', 'keys', 'uuid', 'XMP_', 'loci', 'xyz ', 'cprt', 'auth', 'titl', 'dscp', 'gnre', 'perf', 'albm', 'yrrc', 'rtng', 'clsf', 'kywd', 'smta', 'tags']);
// Container boxes walked into (never mdat: media payload isn't structure).
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf', 'mfra', 'tref', 'sinf', 'schi', 'udta']);

/** Walk the ISO box tree of `file` (headers only) → every box type seen. */
async function boxTypes(file) {
  return (await boxList(file)).filter((b) => !b.inStsd).map((b) => b.type);
}

/** Every box in the tree: { type, off, len } (headers only; containers walked, mdat never). */
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
        // sample entries (a full box: version/flags + entry count, then the entries)
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

/** RIFF/WAVE chunk ids of `file` (top level). */
async function wavChunks(file) {
  const fh = await open(file, 'r');
  const ids = [];
  const hdr = Buffer.alloc(12);
  try {
    const { size } = await fh.stat();
    await fh.read(hdr, 0, 12, 0);
    if (hdr.subarray(0, 4).toString('latin1') !== 'RIFF' || hdr.subarray(8, 12).toString('latin1') !== 'WAVE') throw new Error('not a WAV');
    let off = 12;
    while (off + 8 <= size) {
      await fh.read(hdr, 0, 8, off);
      const id = hdr.subarray(0, 4).toString('latin1');
      const len = hdr.readUInt32LE(4);
      ids.push(id);
      off += 8 + len + (len & 1);
    }
  } finally {
    await fh.close();
  }
  return ids;
}

const isMetadataBox = (t) => METADATA_BOXES.has(t) || t.charCodeAt(0) === 0xa9;
// Visual sample entries: their 32-byte `compressorname` field names the camera's
// or encoder's codec writer ("H.264", "Lavc libx264") — ffprobe reports it as an
// `encoder` tag. Zeroed (same size) like any other metadata.
const VISUAL_ENTRIES = new Set(['avc1', 'avc2', 'avc3', 'avc4', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp08', 'vp09', 'mp4v', 'jpeg', 'mjpa', 'mjpb', 's263', 'h263', 'apcn', 'apch', 'apcs', 'apco', 'ap4h', 'ap4x']);
const COMPRESSORNAME_AT = 50; // sample entry: 8 header + 8 + 16 + 4 size + 8 res + 4 + 2 frame count

/**
 * ffmpeg's mp4 muxer writes an (empty) udta/meta even with -map_metadata -1.
 * Retype every metadata box in the tree to `free` and zero its payload: same
 * size, so no sample offset moves; `free` is legal at any level. Outermost
 * boxes only (a nested one is zeroed with its parent). Returns how many.
 */
async function blankMetadataBoxes(file) {
  const all = await boxList(file);
  const boxes = all.filter((b) => !b.inStsd && isMetadataBox(b.type));
  const outer = boxes.filter((b) => !boxes.some((o) => o !== b && o.off <= b.off && b.off + b.len <= o.off + o.len));
  const visual = all.filter((b) => b.inStsd && VISUAL_ENTRIES.has(b.type) && b.len >= COMPRESSORNAME_AT + 32);
  if (!outer.length && !visual.length) return 0;
  const fh = await open(file, 'r+');
  try {
    for (const v of visual) await fh.write(Buffer.alloc(32), 0, 32, v.off + COMPRESSORNAME_AT);
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
  return outer.length + visual.length;
}

const STRUCTURAL_FORMAT = new Set(['major_brand', 'minor_version', 'compatible_brands']);
const STRUCTURAL_STREAM = new Set(['language', 'handler_name', 'vendor_id']);
const WAV_ALLOWED = new Set(['fmt ', 'data', 'fact']);

/**
 * What metadata a file still carries — structure only, never values.
 * kind: 'iso' (mp4 / mov / m4a) or 'wav'. `clean` only when there is none.
 */
async function metadataReport(file, kind, deadlineMs = 60_000) {
  const p = await probeFile(file, deadlineMs);
  const formatTags = Object.keys(p.format?.tags || {}).filter((k) => !STRUCTURAL_FORMAT.has(k));
  const streamTags = (p.streams || []).flatMap((s) => Object.keys(s.tags || {}).filter((k) => !STRUCTURAL_STREAM.has(k)));
  const dataStreams = (p.streams || []).filter((s) => s.codec_type !== 'video' && s.codec_type !== 'audio').length;
  const boxes = kind === 'wav'
    ? (await wavChunks(file)).filter((id) => !WAV_ALLOWED.has(id))
    : (await boxList(file)).filter((b) => !b.inStsd && isMetadataBox(b.type)).map((b) => b.type);
  return {
    clean: formatTags.length === 0 && streamTags.length === 0 && dataStreams === 0 && boxes.length === 0,
    formatTags: formatTags.length,
    streamTags: streamTags.length,
    dataStreams,
    boxes: [...new Set(boxes)], // box TYPES only (e.g. 'udta') — safe to log
  };
}

/** Remux `input` → `output` with no metadata. `format` is 'mp4' or 'mov'. */
function stripVideoMetadata(input, output, format, timeoutMs = 8 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let command;
    const killTimer = setTimeout(() => {
      try { command.kill('SIGKILL'); } catch (e) { /* ignore */ }
      reject(new Error('FFmpeg timed out'));
    }, timeoutMs);
    command = ffmpeg(input)
      .outputOptions([
        '-map 0:v?',
        '-map 0:a?',
        '-c copy',
        '-map_metadata -1',
        '-map_metadata:s:v -1',
        '-map_metadata:s:a -1',
        '-map_chapters -1',
        '-fflags +bitexact',
        '-flags:v +bitexact',
        '-flags:a +bitexact',
        '-movflags +faststart',
      ])
      .format(format)
      .on('error', (err) => { clearTimeout(killTimer); reject(err); })
      .on('end', () => { clearTimeout(killTimer); resolve(); });
    command.save(output);
  });
}

/** What a file contains, for the before/after match: stream counts + duration. */
async function streamSummary(file, deadlineMs = 60_000) {
  const p = await probeFile(file, deadlineMs);
  const streams = p.streams || [];
  return {
    video: streams.filter((s) => s.codec_type === 'video').length,
    audio: streams.filter((s) => s.codec_type === 'audio').length,
    duration: Number(p.format?.duration) || 0,
  };
}

/** The output keeps every picture and sound stream and the same duration (±0.5 s). */
function sameContent(before, after) {
  return before.video === after.video && before.audio === after.audio && before.video + before.audio > 0 && Math.abs(before.duration - after.duration) <= 0.5;
}

/**
 * The ISO container's major brand, by probing the content (ffprobe reads past
 * a leading free/wide/mdat box). No ftyp at all → 'qt' (legacy QuickTime: ISO
 * files must carry an ftyp). null if ffprobe doesn't see an ISO/QuickTime file.
 */
async function containerBrand(file, deadlineMs = 60_000) {
  let p;
  try {
    p = await probeFile(file, deadlineMs);
  } catch {
    return null;
  }
  if (!/mov|mp4|m4a|3gp|3g2|mj2/.test(p.format?.format_name || '')) return null;
  return String(p.format?.tags?.major_brand || '').trim() || 'qt';
}

module.exports = { stripVideoMetadata, blankMetadataBoxes, metadataReport, boxTypes, locationMarkers, streamSummary, sameContent, containerBrand };
