// H.264 / HEVC SEI: private data inside the video bitstream (Astra on worker
// #3). Drones and action cameras sometimes write GPS or telemetry into SEI
// messages — inside the picture stream, where container metadata stripping
// never reaches.
//
// Policy, per SEI NAL unit — CLOSED (Astra): clean it or refuse it.
//   PRIVATE      user_data_unregistered (type 5) — every one, encoder strings
//                included; user_data_registered (type 4, ITU-T T.35) unless
//                its WHOLE payload parses as HDR10+ dynamic metadata (ST
//                2094-40), nothing after (captions are private, for now)
//   IRRELEVANT   the types KNOWN not to affect presentation: filler_payload (3)
//                only. (buffering_period — 0 — is NOT: it carries the HRD's
//                initial removal delays, which can decide when a picture is shown.)
//   A NAL with no PRIVATE message is kept as it is. A NAL with PRIVATE
//   messages is NEUTRALIZED only when every other message in it is
//   IRRELEVANT; anything else beside private data — picture_timing (pic_struct,
//   repeat / field order), recovery points, HDR, orientation, any type we
//   don't list — means the file is REFUSED (ffmpeg can't remove one message
//   precisely, and dropping the NAL could change what is shown).
//   Neutralizing: in the remuxed MP4/MOV the NAL is rewritten IN PLACE — same
//   NAL type, same length — as an SEI holding only filler_payload messages,
//   which every decoder skips. No sample offset moves, and it is just as
//   valid inside the codec configuration (hvcC parameter-set arrays, where
//   x265 puts its own settings message) as in the samples.
//   The output is scanned again (independently, through the Annex-B
//   elementary stream ffmpeg extracts, parameter sets included): any PRIVATE
//   message left fails verification.
const proc = require('./proc');
const { open, stat, rm } = require('fs/promises');
const path = require('path');

const SEI_NAL = { h264: [6], hevc: [39, 40] };
const IRRELEVANT = new Set([3]); // filler payload

/** MSB-first bit reader over a Buffer; reading past the end throws. */
function bits(buf) {
  let pos = 0;
  return {
    u(n) {
      let v = 0;
      for (let i = 0; i < n; i++, pos++) {
        if (pos >= buf.length * 8) throw new Error('short');
        v = v * 2 + ((buf[pos >> 3] >> (7 - (pos & 7))) & 1);
      }
      return v;
    },
    get pos() { return pos; },
  };
}

/**
 * A T.35 payload that is EXACTLY HDR10+ dynamic metadata: the fixed header
 * (country B5, provider 003C, oriented 0001, application 4, version 0–1), then
 * the full ST 2094-40 structure as ffmpeg parses it (libavutil
 * hdr_dynamic_metadata), with every count in range, then nothing — only zero
 * bits up to the byte boundary, and no byte after.
 */
function isHdr10Plus(p) {
  if (!(p.length >= 7 && p[0] === 0xb5 && p.readUInt16BE(1) === 0x003c && p.readUInt16BE(3) === 0x0001 && p[5] === 4 && p[6] <= 1)) return false;
  try {
    const b = bits(p.subarray(7));
    const windows = b.u(2);
    if (windows < 1) return false;
    for (let w = 1; w < windows; w++) b.u(16 * 4 + 16 * 2 + 8 + 16 * 3 + 1); // window geometry + overlap option
    b.u(27); // targeted_system_display_maximum_luminance
    const lumTable = () => {
      if (!b.u(1)) return true;
      const rows = b.u(5), cols = b.u(5);
      if (rows < 2 || rows > 25 || cols < 2 || cols > 25) return false;
      b.u(4 * rows * cols);
      return true;
    };
    if (!lumTable()) return false; // targeted display actual peak luminance
    for (let w = 0; w < windows; w++) {
      b.u(17 * 3); // maxscl
      b.u(17); // average_maxrgb
      const n = b.u(4);
      for (let i = 0; i < n; i++) b.u(7 + 17); // percentage + percentile
      b.u(10); // fraction_bright_pixels
    }
    if (!lumTable()) return false; // mastering display actual peak luminance
    for (let w = 0; w < windows; w++) {
      if (b.u(1)) { b.u(12 + 12); b.u(10 * b.u(4)); } // tone mapping: knee point, bezier anchors
      if (b.u(1)) b.u(6); // colour saturation weight
    }
    const end = Math.ceil(b.pos / 8);
    if (end !== p.length - 7) return false; // trailing data
    while (b.pos < end * 8) if (b.u(1)) return false; // padding must be zero
    return true;
  } catch {
    return false; // truncated
  }
}
const isPrivate = (m) => m.type === 5 || (m.type === 4 && !isHdr10Plus(m.payload));

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

/** SEI messages in one SEI NAL's RBSP (after the NAL header; trailing zeros trimmed). */
function seiMessages(rbsp) {
  const msgs = [];
  let o = 0;
  const end = rbsp.length - 1; // the last byte is rbsp_trailing_bits (0x80)
  while (o < end) {
    let type = 0, size = 0;
    while (o < end && rbsp[o] === 0xff) { type += 255; o++; }
    if (o >= end) break;
    type += rbsp[o++];
    while (o < end && rbsp[o] === 0xff) { size += 255; o++; }
    if (o >= end) break;
    size += rbsp[o++];
    msgs.push({ type, payload: rbsp.subarray(o, Math.min(o + size, end)) });
    o += size;
  }
  return msgs;
}

/** 'keep' | 'neutralize' | 'refuse' for one SEI NAL (raw NAL bytes, header included). */
function nalVerdict(nal, codec) {
  const msgs = seiMessages(unescape(nal.subarray(codec === 'hevc' ? 2 : 1)));
  if (!msgs.some(isPrivate)) return { verdict: 'keep', msgs };
  const onlyIrrelevantBeside = msgs.every((m) => isPrivate(m) || IRRELEVANT.has(m.type));
  return { verdict: onlyIrrelevantBeside ? 'neutralize' : 'refuse', msgs };
}

const nalType = (b0, codec) => (codec === 'hevc' ? (b0 >> 1) & 0x3f : b0 & 0x1f);

/**
 * Scan an Annex-B file. A streaming state machine: the start-code state (the
 * run of zero bytes, a pending NAL header) carries across read chunks, so a
 * start code or an SEI NAL split anywhere across a chunk edge is still found.
 */
async function scanAnnexB(file, codec, chunkSize = 1 << 20) {
  const fh = await open(file, 'r');
  const seiTypes = SEI_NAL[codec];
  const report = { types: {}, private: 0, refuseNals: 0, neutralizeNals: 0, seiNals: 0 };
  const handleNal = (raw) => {
    let n = raw.length;
    while (n > 0 && raw[n - 1] === 0) n--; // trailing zeros (a 4-byte start code's leading 00)
    const nal = raw.subarray(0, n);
    if (!nal.length) return;
    report.seiNals++;
    const { verdict, msgs } = nalVerdict(nal, codec);
    for (const m of msgs) {
      report.types[m.type] = (report.types[m.type] || 0) + 1;
      if (isPrivate(m)) report.private++;
    }
    if (verdict === 'refuse') report.refuseNals++;
    if (verdict === 'neutralize') report.neutralizeNals++;
  };
  try {
    const buf = Buffer.alloc(chunkSize);
    let pos = 0;
    let zeros = 0;          // consecutive zero bytes just seen
    let awaitHeader = false; // the next byte is a NAL header
    let parts = null;        // the current NAL's bytes, when it is an SEI NAL
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let seg = 0;
      for (let i = 0; i < bytesRead; i++) {
        const b = buf[i];
        if (awaitHeader) {
          awaitHeader = false;
          if (seiTypes.includes(nalType(b, codec))) { parts = []; seg = i; }
          else parts = null;
        }
        if (b === 1 && zeros >= 2) {
          // a start code ends here: the NAL before it (if SEI) is complete — minus this 01 (its zeros are trimmed)
          if (parts) { parts.push(Buffer.from(buf.subarray(seg, i))); handleNal(Buffer.concat(parts)); }
          parts = null;
          awaitHeader = true;
          zeros = 0;
          continue;
        }
        zeros = b === 0 ? zeros + 1 : 0;
      }
      if (parts) parts.push(Buffer.from(buf.subarray(seg, bytesRead)));
    }
    if (parts) handleNal(Buffer.concat(parts));
  } finally {
    await fh.close();
  }
  return report;
}

/**
 * The elementary stream of the first video track, Annex-B (parameter sets
 * included), on disk — under an OS file-size limit: Annex-B can be far larger
 * than its MP4 (the codec configuration, SEI included, is repeated before
 * every keyframe), so the extraction may write at most `maxBytes`.
 */
async function extractAnnexB(input, codec, out, deadlineMs, maxBytes) {
  const bsf = codec === 'hevc' ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';
  try {
    await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...require('./inputs').inputArgs(input), '-map', '0:V:0', '-c', 'copy', '-bsf:v', bsf, '-f', codec, out], { fsizeBytes: maxBytes, timeoutMs: deadlineMs, cwd: path.dirname(out) });
  } catch (e) {
    if (e instanceof proc.OsLimitError) throw new SeiLimitError(`the video bitstream expands past ${maxBytes} bytes`);
    if (e instanceof require('./inputs').InputRefused) throw e;
    throw new Error('could not read the video bitstream');
  }
}
class SeiLimitError extends Error {}

/** The Annex-B budget for a file of `size` bytes: twice its size, plus 1 MiB (env SEI_EXTRACT_MAX_BYTES overrides — tests). */
const annexBBudget = (size) => Number(process.env.SEI_EXTRACT_MAX_BYTES) || 2 * size + 1024 * 1024;

/** SEI report for a file's first video stream (h264 / hevc), or null for other codecs. */
async function seiReport(input, codec, dir, deadlineMs = 120_000) {
  if (codec !== 'h264' && codec !== 'hevc') return null;
  const es = path.join(dir, `es-${Date.now()}-${Math.random().toString(36).slice(2)}.${codec}`);
  await extractAnnexB(input, codec, es, deadlineMs, annexBBudget((await stat(input)).size));
  try {
    return await scanAnnexB(es, codec);
  } finally {
    await rm(es, { force: true });
  }
}

// ── in-place neutralization in an MP4 / MOV ────────────────────────────────

async function readBoxes(fh, start, end) {
  const out = [];
  const h = Buffer.alloc(16);
  let o = start;
  while (o + 8 <= end) {
    await fh.read(h, 0, 16, o);
    let len = h.readUInt32BE(0);
    const type = h.subarray(4, 8).toString('latin1');
    let head = 8;
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); head = 16; } else if (len === 0) len = end - o;
    if (len < head || o + len > end) throw new Error('malformed box tree');
    out.push({ type, off: o, len, body: o + head, end: o + len });
    o += len;
  }
  return out;
}
const child = async (fh, box, type) => (await readBoxes(fh, box.body, box.end)).find((b) => b.type === type);
async function readBody(fh, box, skip = 0) {
  const b = Buffer.alloc(box.end - box.body - skip);
  await fh.read(b, 0, b.length, box.body + skip);
  return b;
}

/**
 * An SEI NAL of exactly `len` bytes, same NAL header, holding only
 * filler_payload (type 3) messages of 0xFF bytes — what a neutralized SEI NAL
 * becomes. Messages are packed greedily so the length matches exactly.
 */
function fillerSei(len, header) {
  const out = [Buffer.from(header)];
  let rem = len - header.length - 1; // the last byte is rbsp_trailing_bits
  if (rem < 2) throw new Error('SEI NAL too short to neutralize');
  while (rem > 0) {
    // the largest n with 1 (type) + size bytes + n ≤ rem, never leaving exactly 1 byte
    let n = rem - 2;
    const used = (k) => 1 + Math.floor(k / 255) + 1 + k;
    while (n > 0 && (used(n) > rem || rem - used(n) === 1)) n--;
    const size = [...Array(Math.floor(n / 255)).fill(0xff), n % 255];
    out.push(Buffer.from([3, ...size]), Buffer.alloc(n, 0xff));
    rem -= used(n);
  }
  out.push(Buffer.from([0x80]));
  const b = Buffer.concat(out);
  if (b.length !== len) throw new Error('filler SEI length mismatch');
  return b;
}

/**
 * Neutralize every SEI NAL with private data in the (single) video track of an
 * MP4 / MOV, in place. { neutralized, refused } — `refused` when a private
 * message shares a NAL with a picture-relevant one, or the file is fragmented
 * and holds private data the sample tables can't reach.
 */
async function neutralizeSeiInIso(file, codec) {
  const fh = await open(file, 'r+');
  let neutralized = 0;
  try {
    const { size } = await fh.stat();
    const top = await readBoxes(fh, 0, size);
    if (top.some((b) => b.type === 'moof')) return { neutralized: 0, refused: 'fragmented MP4 — sample tables do not cover every sample' };
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error('no moov');
    for (const trak of (await readBoxes(fh, moov.body, moov.end)).filter((b) => b.type === 'trak')) {
      const mdia = await child(fh, trak, 'mdia'); if (!mdia) continue;
      const hdlr = await child(fh, mdia, 'hdlr'); if (!hdlr) continue;
      if ((await readBody(fh, hdlr)).subarray(8, 12).toString('latin1') !== 'vide') continue;
      const minf = await child(fh, mdia, 'minf'); const stbl = minf && (await child(fh, minf, 'stbl'));
      if (!stbl) continue;
      const boxes = await readBoxes(fh, stbl.body, stbl.end);
      const get = (t) => boxes.find((b) => b.type === t);
      // the sample entry's codec configuration: the NAL length size
      const stsd = get('stsd');
      const entry = (await readBoxes(fh, stsd.body + 8, stsd.end))[0];
      const cfg = (await readBoxes(fh, entry.off + 86, entry.end)).find((b) => b.type === (codec === 'hevc' ? 'hvcC' : 'avcC'));
      if (!cfg) throw new Error(`no ${codec === 'hevc' ? 'hvcC' : 'avcC'}`);
      const cfgBody = await readBody(fh, cfg);
      const lengthSize = ((codec === 'hevc' ? cfgBody[21] : cfgBody[4]) & 3) + 1;
      if (codec === 'hevc') {
        // hvcC parameter-set arrays can carry SEI NALs (x265 puts its settings message there)
        let q = 23;
        const arrays = cfgBody[22];
        for (let a = 0; a < arrays && q + 3 <= cfgBody.length; a++) {
          const t = cfgBody[q] & 0x3f;
          const n = cfgBody.readUInt16BE(q + 1);
          q += 3;
          for (let k = 0; k < n && q + 2 <= cfgBody.length; k++) {
            const nlen = cfgBody.readUInt16BE(q);
            const ns = q + 2;
            if (ns + nlen > cfgBody.length) throw new Error('malformed hvcC');
            if (SEI_NAL.hevc.includes(t)) {
              const v = nalVerdict(cfgBody.subarray(ns, ns + nlen), 'hevc').verdict;
              if (v === 'refuse') return { neutralized, refused: 'private data shares an SEI NAL with picture-relevant SEI (codec configuration)' };
              if (v === 'neutralize') {
                await fh.write(fillerSei(nlen, cfgBody.subarray(ns, ns + 2)), 0, nlen, cfg.body + ns);
                neutralized++;
              }
            }
            q = ns + nlen;
          }
        }
      }
      // sample sizes
      const stszB = await readBody(fh, get('stsz'), 4);
      const fixed = stszB.readUInt32BE(0), count = stszB.readUInt32BE(4);
      const sizeOf = (i) => (fixed ? fixed : stszB.readUInt32BE(8 + 4 * i));
      // chunk offsets
      const co = get('stco') || get('co64');
      const coB = await readBody(fh, co, 4);
      const nChunks = coB.readUInt32BE(0);
      const chunkOff = (i) => (co.type === 'co64' ? Number(coB.readBigUInt64BE(4 + 8 * i)) : coB.readUInt32BE(4 + 4 * i));
      // samples per chunk
      const stscB = await readBody(fh, get('stsc'), 4);
      const runs = Array.from({ length: stscB.readUInt32BE(0) }, (_, k) => ({ first: stscB.readUInt32BE(4 + 12 * k), per: stscB.readUInt32BE(8 + 12 * k) }));
      let sample = 0;
      for (let c = 0; c < nChunks && sample < count; c++) {
        const run = runs.filter((r) => r.first <= c + 1).pop();
        let off = chunkOff(c);
        for (let k = 0; k < (run ? run.per : 0) && sample < count; k++, sample++) {
          const len = sizeOf(sample);
          const s = Buffer.alloc(len);
          await fh.read(s, 0, len, off);
          let p = 0;
          while (p + lengthSize < len) {
            const nlen = s.readUIntBE(p, lengthSize);
            const ns = p + lengthSize;
            if (nlen <= 0 || ns + nlen > len) throw new Error('malformed NAL lengths');
            if (SEI_NAL[codec].includes(nalType(s[ns], codec))) {
              const v = nalVerdict(s.subarray(ns, ns + nlen), codec).verdict;
              if (v === 'refuse') return { neutralized, refused: 'private data shares an SEI NAL with picture-relevant SEI' };
              if (v === 'neutralize') {
                await fh.write(fillerSei(nlen, s.subarray(ns, ns + (codec === 'hevc' ? 2 : 1))), 0, nlen, off + ns);
                neutralized++;
              }
            }
            p = ns + nlen;
          }
          off += len;
        }
      }
    }
  } finally {
    await fh.close();
  }
  return { neutralized, refused: null };
}

module.exports = { SeiLimitError, annexBBudget, seiReport, scanAnnexB, seiMessages, nalVerdict, neutralizeSeiInIso, isHdr10Plus, fillerSei, unescape };
