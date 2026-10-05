// The ffmpeg command lines, built in one place as plain argument arrays (no
// fluent-ffmpeg, no shell), each with its HARD limits — so each limit can be
// tested on its own by running the real command on an over-long input
// (test/worker.test.js), independent of the measuring that normally refuses
// such inputs first.
//   duration, by COUNT  audio: atrim end_sample (decoded samples)
//                       video: trim end_frame (frames) — NOT -frames:v: in
//                       ffmpeg 6+ any -frames limit sends the output through a
//                       sync queue that ends EVERY stream when the picture
//                       ends (a short picture would cut its sound), and 5.1
//                       (production) doesn't — the filter counts the same way
//                       in both
//                       strip: -frames:0 (packets) — for a SINGLE-stream file
//                       only: in ffmpeg 6+ any -frames, at any value, makes a
//                       multi-stream copy end every stream with the first
//                       (measured: 10 s of sound after 1 s of picture → 1 s).
//                       A multi-stream strip is bounded instead by the measured
//                       input (a copy can't add packets), checked after by
//                       exact per-stream packet counts, and by -fs / the OS.
//   bytes               -fs (and, under it, the OS file-size limit — lib/proc)

const { inputArgs } = require('./inputs');

const BASE = ['-nostdin', '-v', 'error', '-y'];
const NO_METADATA = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact'];

/** Enhancement: the preset's filters, then 48 kHz mono 16-bit WAV, limited to (cap + 1) s of samples and the byte cap. */
function enhanceArgs(input, output, filterChain, caps) {
  const endSample = (caps.maxDurationSec + 1) * 48000;
  return [
    ...BASE, ...inputArgs(input), '-map', '0:a:0',
    '-af', `${filterChain},aresample=48000,atrim=end_sample=${endSample}`,
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
    ...NO_METADATA, '-flags:a', '+bitexact',
    '-fs', String(caps.maxOutputBytes),
    '-f', 'wav', output,
  ];
}

/** Transcode: iPhone-safe H.264 / AAC MP4, CFR 30, ≤ 1280 wide; limited to (cap + 1) s of frames and samples, and the byte cap. */
function transcodeArgs(input, output, { hasAudio, caps }) {
  const maxFrames = (caps.maxDurationSec + 1) * 30;
  const args = [
    ...BASE, ...inputArgs(input),
    '-map', '0:v:0', '-vf', `scale='min(1280,iw)':-2,fps=30,trim=end_frame=${maxFrames}`,
    // yuv420p: canvas-captured WebM can carry alpha · main / 4.0: iOS · faststart: playback starts while streaming
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23',
    '-movflags', '+faststart', ...NO_METADATA, '-flags:v', '+bitexact',
  ];
  if (hasAudio) {
    args.push('-map', '0:a:0', '-af', `aresample=48000,atrim=end_sample=${(caps.maxDurationSec + 1) * 48000}`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-flags:a', '+bitexact');
  }
  args.push('-fs', String(caps.maxOutputBytes), '-f', 'mp4', output);
  return args;
}

/** Strip: a lossless remux with no metadata; for a single-stream file at most `limits.frames[0]` packets; `limits.maxBytes`. */
function stripArgs(input, output, fmt, limits = {}) {
  const args = [
    ...BASE, ...inputArgs(input),
    '-map', '0:V?', '-map', '0:a?', // real video only — never attached pictures
    '-c', 'copy', '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
  ];
  if (fmt.family === 'iso') args.push('-movflags', '+faststart');
  if (fmt.family === 'mp3') args.push('-id3v2_version', '0', '-write_id3v1', '0');
  if (limits.frames && limits.frames.length === 1) args.push('-frames:0', String(limits.frames[0]));
  if (limits.maxBytes) args.push('-fs', String(limits.maxBytes));
  args.push('-f', fmt.muxer, output);
  return args;
}

module.exports = { enhanceArgs, transcodeArgs, stripArgs };
