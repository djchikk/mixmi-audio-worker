// The closed input rule (Astra on worker #3): ffmpeg and ffprobe read ONLY
// the job's own local file, as a container WE name, never one they guess.
//
//   1. The container is decided from the file's magic bytes against a strict
//      allowlist (below). Anything else — HLS / m3u8 playlists, concat and
//      ffconcat lists, SDP, image sequences, any format that points at other
//      files or the network — is refused BEFORE ffmpeg runs.
//   2. Every input is then passed as
//        -protocol_whitelist file -f <that container> -i <path in the job dir>
//      so ffmpeg can't probe its way into a playlist or indirection format,
//      and the demuxer can open nothing but local files. (mov's external data
//      references stay off: its enable_drefs defaults to 0.)
//   lib/proc refuses any ffmpeg / ffprobe call whose inputs don't have this
//   exact shape, and whose input isn't inside the job's directory.
const { openSync, readSync, closeSync } = require('fs');

class InputRefused extends Error {}

/** ffmpeg demuxer names we allow, by what the first bytes say. */
const ALLOWED = new Set(['mov', 'mp3', 'wav', 'flac', 'ogg', 'matroska']);

/**
 * ISO BMFF / QuickTime: top-level boxes from byte 0 — padding boxes (free,
 * skip, wide, pnot, uuid) may come first — until ftyp, moov or mdat, within
 * the bytes given.
 */
function isoBoxes(b) {
  let o = 0;
  for (let n = 0; n < 32 && o + 8 <= b.length; n++) {
    let size = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    if (['ftyp', 'moov', 'mdat'].includes(type)) return true;
    if (!['free', 'skip', 'wide', 'pnot', 'uuid'].includes(type)) return false;
    if (size === 1) { if (o + 16 > b.length) return false; size = Number(b.readBigUInt64BE(o + 8)); }
    if (size < 8) return false;
    o += size;
  }
  return false;
}

/** The allowlisted container these first bytes identify, or null. */
function containerOf(b) {
  if (b.length < 12) return null;
  const at = (o, s) => b.toString('latin1', o, o + s.length) === s;
  if (isoBoxes(b)) return 'mov'; // ISO BMFF / QuickTime
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'fLaC')) return 'flac';
  if (at(0, 'OggS')) return 'ogg';
  if (b.readUInt32BE(0) === 0x1a45dfa3) return 'matroska'; // EBML: Matroska / WebM
  if (at(0, 'ID3')) return 'mp3';
  // an MPEG audio frame header: 11 sync bits, version not reserved, layer III, bitrate / rate not invalid
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && ((b[1] >> 3) & 3) !== 1 && ((b[1] >> 1) & 3) === 1 && (b[2] >> 4) !== 15 && ((b[2] >> 2) & 3) !== 3) return 'mp3';
  return null;
}

/** The container of a local file (its first 64 KB), or null. */
function containerOfFile(file) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(64 * 1024);
    const n = readSync(fd, b, 0, b.length, 0);
    return containerOf(b.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** The ONLY way an input is given to ffmpeg / ffprobe. Throws InputRefused for anything off the allowlist. */
function inputArgs(file) {
  const fmt = containerOfFile(file);
  if (!fmt || !ALLOWED.has(fmt)) throw new InputRefused('Not an accepted media container');
  return ['-protocol_whitelist', 'file', '-f', fmt, '-i', file];
}

module.exports = { ALLOWED, containerOf, containerOfFile, inputArgs, InputRefused };
