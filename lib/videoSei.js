// H.264 / HEVC SEI: private text inside the video bitstream (Astra's P2 on
// worker #3). Drones and action cameras sometimes write GPS or telemetry into
// user_data_unregistered SEI messages (payload type 5) — inside the picture
// stream, where container metadata stripping never reaches.
//
// Policy — clean it or refuse it:
//   - a type-5 payload is allowed only if it is on a tiny allowlist: the x264 /
//     x265 encoder-settings strings (matched by their UUID AND their text shape);
//   - any other type-5 payload is REMOVED by dropping the SEI NAL units — but
//     only when the stream's other SEI is limited to types the MP4/MOV container
//     already covers (buffering period, picture timing, recovery point). If SEI
//     the picture may need (HDR mastering / light level, orientation, frame
//     packing, …) sits alongside private user data, the file is REFUSED —
//     ffmpeg has no filter that removes one SEI payload type precisely;
//   - the output is scanned again: any type-5 payload not on the allowlist
//     fails verification.
//
// The scan reads the elementary stream (ffmpeg *_mp4toannexb → Annex-B on
// disk) in chunks and parses only SEI NAL units (emulation prevention removed).
const { execFile } = require('child_process');
const { open } = require('fs/promises');
const path = require('path');

const ALLOWED_USER_DATA = [
  { uuid: 'dc45e9bde6d948b7962cd820d923eeef', text: /^x264 - core \d+/ }, // x264 encoder settings
  { uuid: '2ca2de09b51747dbbb55a4fe7fc2fc4e', text: /^x265 \(build \d+\)/ }, // x265 encoder settings
];
// SEI payload types the container already carries — safe to drop with the SEI NAL units
const DROPPABLE = new Set([0, 1, 5, 6]); // buffering period, pic timing, user data unregistered, recovery point
const SEI_NAL = { h264: [6], hevc: [39, 40] };

/** The elementary stream of the first video track, Annex-B, on disk. */
function extractAnnexB(input, codec, out, deadlineMs) {
  const bsf = codec === 'hevc' ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', input, '-map', '0:V:0', '-c', 'copy', '-bsf:v', bsf, '-f', codec, out], { timeout: deadlineMs, killSignal: 'SIGKILL' }, (err) => (err ? reject(new Error('could not read the video bitstream')) : resolve()));
  });
}

/** Remove emulation-prevention bytes (00 00 03 → 00 00). */
function unescape(b) {
  const out = Buffer.alloc(b.length);
  let n = 0, zeros = 0;
  for (let i = 0; i < b.length; i++) {
    if (zeros >= 2 && b[i] === 3) { zeros = 0; continue; }
    zeros = b[i] === 0 ? zeros + 1 : 0;
    out[n++] = b[i];
  }
  return out.subarray(0, n);
}

/** SEI messages in one SEI NAL's RBSP (after the NAL header; trailing zeros already trimmed). */
function seiMessages(rbsp) {
  const msgs = [];
  let o = 0;
  // the last byte is rbsp_trailing_bits (0x80); messages fill everything before it
  const end = rbsp.length - 1;
  while (o < end) {
    let type = 0, size = 0;
    while (o < end && rbsp[o] === 0xff) { type += 255; o++; }
    if (o >= end) break;
    type += rbsp[o++];
    while (o < end && rbsp[o] === 0xff) { size += 255; o++; }
    if (o >= end) break;
    size += rbsp[o++];
    msgs.push({ type, payload: rbsp.subarray(o, Math.min(o + size, end)), truncated: o + size > end });
    o += size;
  }
  return msgs;
}

function userDataAllowed(payload) {
  if (payload.length < 16) return false;
  const uuid = payload.subarray(0, 16).toString('hex');
  const text = payload.subarray(16, 16 + 256).toString('latin1');
  return ALLOWED_USER_DATA.some((a) => a.uuid === uuid && a.text.test(text));
}

/** Scan an Annex-B file: SEI payload types seen, and type-5 payloads NOT on the allowlist. */
async function scanAnnexB(file, codec) {
  const fh = await open(file, 'r');
  const types = new Map();
  let disallowed = 0, allowed = 0;
  const seiTypes = SEI_NAL[codec];
  const hdr = codec === 'hevc' ? 2 : 1;
  const handleNal = (raw) => {
    let n = raw.length;
    while (n > 0 && raw[n - 1] === 0) n--; // trailing zeros (and a 4-byte start code's leading 00)
    const nal = raw.subarray(0, n);
    if (!nal.length) return;
    const t = codec === 'hevc' ? (nal[0] >> 1) & 0x3f : nal[0] & 0x1f;
    if (!seiTypes.includes(t)) return;
    for (const m of seiMessages(unescape(nal.subarray(hdr)))) {
      types.set(m.type, (types.get(m.type) || 0) + 1);
      if (m.type === 5) { if (userDataAllowed(m.payload)) allowed++; else disallowed++; }
    }
  };
  try {
    const CH = 1 << 20;
    const buf = Buffer.alloc(CH);
    let carry = Buffer.alloc(0);
    let pos = 0;
    let parts = null; // the current NAL's bytes when it is an SEI NAL; null while skipping others
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CH, pos);
      pos += bytesRead;
      const last = bytesRead === 0;
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      // look for start codes up to `end`; the last 3 bytes wait for the next chunk
      const end = last ? data.length : Math.max(0, data.length - 3);
      let i = 0, seg = 0;
      while (i + 3 < data.length && i < end) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
          if (parts) { parts.push(data.subarray(seg, i)); handleNal(Buffer.concat(parts)); }
          const t = codec === 'hevc' ? (data[i + 3] >> 1) & 0x3f : data[i + 3] & 0x1f;
          parts = seiTypes.includes(t) ? [] : null;
          i += 3;
          seg = i;
          continue;
        }
        i++;
      }
      if (last) {
        if (parts) { parts.push(data.subarray(seg)); handleNal(Buffer.concat(parts)); }
        break;
      }
      if (parts) parts.push(data.subarray(seg, end));
      carry = Buffer.from(data.subarray(end));
    }
  } finally {
    await fh.close();
  }
  return { types, disallowed, allowed };
}

/**
 * SEI report for a file's first video stream (h264 / hevc), or null if the
 * stream is another codec. { types: {type: count}, disallowed, allowed }.
 */
async function seiReport(input, codec, dir, deadlineMs = 120_000) {
  if (codec !== 'h264' && codec !== 'hevc') return null;
  const es = path.join(dir, `es-${Date.now()}-${Math.random().toString(36).slice(2)}.${codec}`);
  await extractAnnexB(input, codec, es, deadlineMs);
  const r = await scanAnnexB(es, codec);
  return { types: Object.fromEntries(r.types), disallowed: r.disallowed, allowed: r.allowed };
}

/**
 * What to do with a stream's SEI: 'keep' (nothing private), 'drop-sei' (private
 * user data, and only droppable SEI types beside it), or 'refuse'.
 */
function seiDecision(report) {
  if (!report || report.disallowed === 0) return 'keep';
  const others = Object.keys(report.types).map(Number).filter((t) => !DROPPABLE.has(t));
  return others.length ? 'refuse' : 'drop-sei';
}

/** The ffmpeg bitstream filter that drops every SEI NAL unit for a codec. */
const dropSeiFilter = (codec) => `filter_units=remove_types=${SEI_NAL[codec].join('|')}`;

module.exports = { seiReport, seiDecision, dropSeiFilter, scanAnnexB, seiMessages, userDataAllowed, ALLOWED_USER_DATA };
