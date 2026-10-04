// Strip location and every other metadata from a video, without re-encoding.
//
// Phones record where a video was made: Android in a `©xyz` atom, iPhone in the
// `com.apple.quicktime.location.ISO6709` key (and sometimes a timed-metadata
// track), 3GPP in a `loci` atom. mixmi serves videos publicly, so none of it
// may stay (the About page's globe privacy promise, 2026-10-04).
//
//   -map 0:v -map 0:a?   keep only picture and sound — drops data / timed-
//                        metadata tracks (where a moving location can live)
//   -c copy              no re-encode: same quality, fast
//   -map_metadata -1     drop container + stream metadata (location, creation
//                        time, make/model, encoder, …)
//   -map_chapters -1     drop chapters
//   bitexact flags       ffmpeg writes no encoder tag of its own
//   +faststart           playback can start while streaming
const ffmpeg = require('fluent-ffmpeg');
const { readFile } = require('fs/promises');

const LOCATION_MARKERS = [
  { name: '©xyz', bytes: Buffer.from([0xa9, 0x78, 0x79, 0x7a]), atom: true },
  { name: 'ISO6709', bytes: Buffer.from('com.apple.quicktime.location.ISO6709', 'latin1'), atom: false },
  { name: 'loci', bytes: Buffer.from('loci', 'latin1'), atom: true },
  { name: 'xmp-gps', bytes: Buffer.from('exif:GPSLatitude', 'latin1'), atom: false },
];

// An atom name only counts when preceded by a plausible atom size (the 4
// letters can occur by chance inside compressed media).
function hasAtom(buf, name) {
  let i = buf.indexOf(name);
  while (i >= 4) {
    const size = buf.readUInt32BE(i - 4);
    if (size >= 8 && size <= 1 << 20) return true;
    i = buf.indexOf(name, i + 1);
  }
  return false;
}

/** Which location markers a file carries (presence only — never the values). */
function locationMarkers(buf) {
  return LOCATION_MARKERS.filter((m) => (m.atom ? hasAtom(buf, m.bytes) : buf.includes(m.bytes))).map((m) => m.name);
}

const probe = (file) => new Promise((resolve, reject) => ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data))));

// Container tags that are structural, not about the person or the camera.
const STRUCTURAL = new Set(['major_brand', 'minor_version', 'compatible_brands']);
// Stream tags that are structural (track language / handler names).
const STRUCTURAL_STREAM = new Set(['language', 'handler_name', 'vendor_id']);

/** Does this video carry metadata worth removing? (Presence only.) */
async function videoHasMetadata(file) {
  const p = await probe(file);
  const formatTags = Object.keys(p.format?.tags || {}).filter((k) => !STRUCTURAL.has(k));
  const streamTags = (p.streams || []).flatMap((s) => Object.keys(s.tags || {}).filter((k) => !STRUCTURAL_STREAM.has(k)));
  const dataStreams = (p.streams || []).filter((s) => s.codec_type !== 'video' && s.codec_type !== 'audio').length;
  const markers = locationMarkers(await readFile(file));
  return {
    has: formatTags.length > 0 || streamTags.length > 0 || dataStreams > 0 || markers.length > 0,
    location: markers.length > 0,
    formatTags: formatTags.length,
    streamTags: streamTags.length,
    dataStreams,
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
        '-map 0:v',
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

module.exports = { videoHasMetadata, stripVideoMetadata, locationMarkers };
