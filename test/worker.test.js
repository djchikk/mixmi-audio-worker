// The worker's safety tests (Astra's HOLDs on worker #3). Every breaking input
// goes through the REAL endpoints (Fastify inject) with Storage stubbed at
// fetch, plus the library pieces underneath.
//
// Fixtures carry a location (a made-up point in open ocean); *-free-first are
// the same files with the ftyp retyped to `free` (no ftyp: legacy QuickTime).
// Run: npm test  (needs ffmpeg + ffprobe on PATH)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readFile, writeFile, copyFile, readdir, mkdtemp, rm, stat } = require('fs/promises');
const { execFile } = require('child_process');
const media = require('../lib/stripMedia');
const io = require('../lib/storageIO');
const { secretOk, SECRET_HEADER } = require('../lib/guards');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); } };
const FIX = (f) => path.join(__dirname, 'fixtures', f);
// ffmpeg never waits on stdin (an existing output file would otherwise prompt and hang)
const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, cmd === 'ffmpeg' ? ['-nostdin', '-y', ...args] : args, { timeout: 120_000 }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
const crypto = require('crypto');
const sei = require('../lib/videoSei');
const limits = require('../lib/limits');
/** The HDR10+ T.35 payload x265 wrote into test/fixtures/hdr.mp4 (ffmpeg reads it as SMPTE 2094-40). */
async function hdr10PlusFromFixture() {
  const es = path.join(os.tmpdir(), `hdr-${process.pid}.hevc`);
  await sh('ffmpeg', ['-v', 'error', '-i', FIX('hdr.mp4'), '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'hevc_mp4toannexb', '-f', 'hevc', es]);
  const b = await readFile(es); await rm(es, { force: true });
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && ((b[i + 3] >> 1) & 0x3f) === 39) {
      let j = i + 3; while (j + 2 < b.length && !(b[j] === 0 && b[j + 1] === 0 && b[j + 2] <= 1)) j++;
      const m = sei.seiMessages(sei.unescape(b.subarray(i + 5, j))).find((x) => x.type === 4);
      if (m) return Buffer.from(m.payload);
    }
  }
  throw new Error('fixture: no T.35 payload');
}
/** Decoded audio (first audio stream → s16le PCM), hashed: proves the SOUND is unchanged, not just stream counts. */
/** The audio packets of a file, hashed in order (a stream copy: no decoding), for an MP3 whose remux gains an Info frame.
 *  framemd5's sixth field is the packet's own hash (a skip-samples side-data hash may follow it on the first packet). */
const packetHash = async (file) => crypto.createHash('sha256').update(await sh('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'framemd5', '-fflags', '+bitexact', 'pipe:1']).then((o) => o.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')[5].trim()).join('\n'))).digest('hex');
const pcmHash = async (file) => { const out = `${file}.pcm`; await sh('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-c:a', 'pcm_s16le', out]); const h = crypto.createHash('sha256').update(await readFile(out)).digest('hex'); await rm(out, { force: true }); return h; };
/** Decoded video frames, hashed (framemd5 of the first picture stream). */
const frameHash = async (file) => { const out = `${file}.fmd5`; await sh('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:V:0', '-f', 'framemd5', out]); const t = (await readFile(out, 'utf8')).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim()).join(','); await rm(out, { force: true }); return crypto.createHash('sha256').update(t).digest('hex'); };
/** Recompute every Ogg page CRC in place (poly 0x04c11db7, no reflection). */
function oggFixCrcs(b) {
  const table = Array.from({ length: 256 }, (_, i) => { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0; return r >>> 0; });
  let o = 0;
  while (o + 27 <= b.length && b.subarray(o, o + 4).toString('latin1') === 'OggS') {
    const nseg = b[o + 26];
    const len = 27 + nseg + [...b.subarray(o + 27, o + 27 + nseg)].reduce((a, x) => a + x, 0);
    b.writeUInt32LE(0, o + 22);
    let crc = 0;
    for (let i = o; i < o + len; i++) crc = ((crc << 8) ^ table[((crc >>> 24) ^ b[i]) & 0xff]) >>> 0;
    b.writeUInt32LE(crc, o + 22);
    o += len;
  }
}
const jobDirs = async () => (await readdir(os.tmpdir())).filter((d) => d.startsWith('mixmi-job-'));

const HOST = 'abc.supabase.co';
const S = `https://${HOST}/storage/v1/object`;
const env = { SUPABASE_URL: `https://${HOST}` };
const readUrl = (key = '0xabc/5f1e', bucket = 'media-incoming') => `${S}/sign/${bucket}/${key}?token=READTOKEN`;
const upUrl = (key = '0xabc/5f1e', bucket = 'media-incoming') => `${S}/upload/sign/${bucket}/${key}?token=WRITETOKEN`;

async function library() {
  console.log('\nStrip library: unconditional remux, then proof');
  for (const [file, brand, format] of [['gps-video.mp4', 'isom', 'mp4'], ['gps-video.mov', 'qt', 'mov'], ['gps-video-xyz.mov', 'qt', 'mov'], ['gps-audio.m4a', 'isom', 'mp4'], ['gps-video-free-first.mov', 'qt', 'mov'], ['gps-audio-free-first.m4a', 'qt', 'mov']]) {
    const input = FIX(file);
    const b = await media.containerBrand(input);
    check(`${file}: brand by probe = ${brand} → ${format}`, b === brand, String(b));
    const before = await media.metadataReport(input, 'iso');
    check(`${file}: carries metadata before (boxes ${before.leftovers.join(',')})`, !before.clean && media.locationMarkers(await readFile(input)).length > 0);
    // like a job: input and output in one directory (lib/proc refuses an input outside it)
    const jd = await mkdtemp(path.join(os.tmpdir(), 'wt-lib-'));
    const local = path.join(jd, file);
    await copyFile(input, local);
    const out = path.join(jd, `out.${format}`);
    await media.stripVideoMetadata(local, out, format);
    await media.blankMetadataBoxes(out);
    const after = await media.metadataReport(out, 'iso');
    check(`${file}: after — no metadata boxes, tags or data streams; no location bytes`, after.clean && media.locationMarkers(await readFile(out)).length === 0, JSON.stringify(after));
    check(`${file}: container kept — output brand ${brand}`, (await media.containerBrand(out)) === brand);
    check(`${file}: same streams and duration`, media.sameContent(await media.streamSummary(input), await media.streamSummary(out)));
    await rm(jd, { recursive: true, force: true });
  }
  {
    // the mp4 muxer's own empty udta/meta: the verifier sees it; blanking removes it
    const jd = await mkdtemp(path.join(os.tmpdir(), 'wt-lib-'));
    const local = path.join(jd, 'in.mp4');
    await copyFile(FIX('gps-video.mp4'), local);
    const out = path.join(jd, 'out.mp4');
    await media.stripVideoMetadata(local, out, 'mp4');
    const raw = await media.metadataReport(out, 'iso');
    check('verification is structural: a bare remux still has the muxer\'s udta/meta — caught', !raw.clean && raw.leftovers.includes('box:udta'), JSON.stringify(raw));
    await rm(jd, { recursive: true, force: true });
  }
  {
    // a metadata box under any namespace: a ©-box with an invented name, and a uuid (XMP-style) box
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wt-'));
    const box = (type, payload) => { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length, 0); typeof type === 'string' ? b.write(type, 4, 'latin1') : type.copy(b, 4); payload.copy(b, 8); return b; };
    const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
    for (const [label, inner] of [['an invented ©-box', box(Buffer.from([0xa9, 0x7a, 0x7a, 0x7a]), Buffer.from('x'))], ['a uuid box', box('uuid', Buffer.alloc(24))], ['an XMP_ box', box('XMP_', Buffer.from('<x/>'))]]) {
      const f = path.join(dir, 'f.mp4');
      await writeFile(f, Buffer.concat([ftyp, box('moov', Buffer.concat([box('mvhd', Buffer.alloc(100)), box('trak', inner)]))]));
      const types = await media.boxTypes(f);
      check(`box walk finds ${label} nested in moov/trak`, types.some((t) => t === 'uuid' || t === 'XMP_' || t.charCodeAt(0) === 0xa9), types.join(','));
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function storage() {
  console.log('\nStorage I/O: the fixed contract');
  const ok = (a, b) => { try { io.inPlaceTarget(a, b, env); return true; } catch { return false; } };
  check('in place: signed read + signed upload of the SAME incoming object → accepted', ok(readUrl(), upUrl()));
  const refused = {
    'another key': [readUrl(), upUrl('0xabc/other')],
    'the clean-copy key (not in place)': [readUrl(), upUrl('0xabc/5f1e.clean')],
    'another bucket (public video-clips)': [readUrl('a.mp4', 'video-clips'), upUrl('a.mp4', 'video-clips')],
    'a public object as the source': [`${S}/public/media-incoming/0xabc/5f1e`, upUrl()],
    'a read URL as the destination': [readUrl(), readUrl()],
    'no token': [`${S}/sign/media-incoming/0xabc/5f1e`, upUrl()],
    'a literal dot-dot': [`${S}/sign/media-incoming/0xabc/../x?token=t`, `${S}/upload/sign/media-incoming/0xabc/../x?token=t`],
    'an encoded dot-dot': [`${S}/sign/media-incoming/0xabc/%2e%2e/x?token=t`, `${S}/upload/sign/media-incoming/0xabc/%2e%2e/x?token=t`],
    'an encoded slash': [`${S}/sign/media-incoming/0xabc%2f5f1e?token=t`, `${S}/upload/sign/media-incoming/0xabc%2f5f1e?token=t`],
    'another host': [readUrl().replace(HOST, 'evil.example'), upUrl().replace(HOST, 'evil.example')],
    'plain http': [readUrl().replace('https:', 'http:'), upUrl().replace('https:', 'http:')],
    'a port': [readUrl().replace(HOST, `${HOST}:8443`), upUrl().replace(HOST, `${HOST}:8443`)],
    'userinfo': [readUrl().replace(HOST, `x@${HOST}`), upUrl().replace(HOST, `x@${HOST}`)],
    'not a URL': ['nope', upUrl()],
  };
  const passed = Object.entries(refused).filter(([, [a, b]]) => ok(a, b)).map(([k]) => k);
  check(`refused: ${Object.keys(refused).join('; ')}`, passed.length === 0, passed.join(' | '));

  const resp = (status, body, headers = {}) => new Response(body, { status, headers });
  let e;
  e = null; try { await io.guardedFetch('https://x', {}, 1000, async () => resp(302, null, { location: 'https://evil.example/' })); } catch (x) { e = x; }
  check('a redirect (302) is refused, never followed', !!e && /redirect/.test(e.message));
  let sawManual = false;
  await io.guardedFetch('https://x', {}, 1000, async (u, o) => { sawManual = o.redirect === 'manual'; return resp(200, 'x'); }).then((r) => r.done());
  check("every request is made with redirect: 'manual' and an abort signal", sawManual);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'wt-'));
  let bodyRead = false;
  const lazy = (n) => new ReadableStream({ pull(c) { bodyRead = true; c.enqueue(new Uint8Array(n)); c.close(); } }, { highWaterMark: 0 });
  e = null; try { await io.downloadToFile('u', path.join(dir, 'a'), { maxBytes: 100, deadlineMs: 1000 }, async () => resp(200, lazy(1000), { 'content-length': '1000' })); } catch (x) { e = x; }
  check('too large by Content-Length → refused BEFORE the body is read', e instanceof io.TooLargeError && !bodyRead);
  e = null; try { await io.downloadToFile('u', path.join(dir, 'b'), { maxBytes: 100, deadlineMs: 1000 }, async () => resp(200, lazy(500))); } catch (x) { e = x; }
  check('no Content-Length, too large while streaming → refused', e instanceof io.TooLargeError);
  const never = async (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  e = null; const t0 = Date.now(); try { await io.downloadToFile('u', path.join(dir, 'c'), { maxBytes: 100, deadlineMs: 150 }, never); } catch (x) { e = x; }
  check('a download that never answers → the deadline aborts it', e instanceof io.DeadlineError && Date.now() - t0 < 2000, e?.message);
  const stall = async (u, o) => resp(200, new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); o.signal.addEventListener('abort', () => c.error(new Error('aborted'))); } }));
  e = null; try { await io.downloadToFile('u', path.join(dir, 'd'), { maxBytes: 100, deadlineMs: 150 }, stall); } catch (x) { e = x; }
  check('a download that stalls mid-body → the TOTAL deadline aborts it', e instanceof io.DeadlineError, e?.message);
  e = null; try { await io.downloadToFile('u', path.join(dir, 'e'), { maxBytes: 100, deadlineMs: 1000 }, async () => resp(200, new Uint8Array(0))); } catch (x) { e = x; }
  check('an empty source fails', !!e);
  await writeFile(path.join(dir, 'f'), 'abc');
  e = null; try { await io.uploadFile('u', path.join(dir, 'f'), 'video/mp4', { deadlineMs: 150 }, never); } catch (x) { e = x; }
  check('an upload that never answers → the deadline aborts it', e instanceof io.DeadlineError, e?.message);
  e = null; try { await io.uploadFile('u', path.join(dir, 'f'), 'video/mp4', { deadlineMs: 1000 }, async () => resp(403, 'denied')); } catch (x) { e = x; }
  check('an upload that is refused fails', !!e);
  await rm(dir, { recursive: true, force: true });
  let kept = null;
  e = null; try { await io.withTempDir(async (d) => { kept = d; await writeFile(path.join(d, 'x'), 'x'); throw new Error('job blew up'); }); } catch (x) { e = x; }
  check('temp dir removed in finally, even when the job throws', !!e && !(await readdir(os.tmpdir())).includes(path.basename(kept)));
  check('the shared secret: right passes, wrong/empty/missing fail, unset refuses all', secretOk('s', 's') && !secretOk('x', 's') && !secretOk('', 's') && !secretOk(undefined, 's') && !secretOk('s', undefined));
}

async function endpoints() {
  console.log('\nThe real endpoints (inject), Storage stubbed at fetch');
  process.env.SUPABASE_URL = env.SUPABASE_URL;
  process.env.MEDIA_WORKER_SECRET = 'test-secret-for-the-suite';
  const app = require('../index.js');
  await app.ready();
  const realFetch = global.fetch;
  const H = { [SECRET_HEADER]: 'test-secret-for-the-suite' };
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'wt-src-'));
  // a WAV and a webm that carry metadata (title / comment tags)
  const wav = path.join(tmp, 'tagged.wav');
  await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-metadata', 'title=Fixtureville', '-metadata', 'comment=0.5,0.5', wav]);
  const webm = path.join(tmp, 'tagged.webm');
  await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-f', 'lavfi', '-i', 'sine=duration=1', '-shortest', '-metadata', 'title=Fixtureville', '-c:v', 'libvpx', '-c:a', 'libopus', webm]);

  // POST with the source served from `src` (bytes, or a Response factory) → { r, json, uploaded, logs }
  const call = async (endpoint, src, opts = {}) => {
    let uploaded = null, uploadHeaders = null, uploadInit = null;
    global.fetch = async (url, o = {}) => {
      if (o.redirect !== 'manual') throw new Error('a request without redirect: manual');
      const u = String(url);
      if (u.startsWith(`${S}/sign/`)) return typeof src === 'function' ? src() : new Response(src, { status: 200, headers: { 'content-length': String(src.length), 'content-type': opts.type || 'application/octet-stream' } });
      if (u.startsWith(`${S}/upload/sign/`)) { uploaded = Buffer.from(await new Response(o.body).arrayBuffer()); uploadHeaders = o.headers; uploadInit = o; return opts.upload ? opts.upload() : new Response('{"Key":"x"}', { status: 200 }); }
      throw new Error(`unexpected fetch ${u}`);
    };
    // everything the worker logs, as it logs it (pino writes asynchronously, so capture at app.log)
    const logs = [];
    const realInfo = app.log.info, realError = app.log.error;
    app.log.info = (...a) => { logs.push(JSON.stringify(a)); };
    app.log.error = (...a) => { logs.push(JSON.stringify(a)); };
    try {
      const r = await app.inject({ method: 'POST', url: endpoint, headers: H, payload: { sourceUrl: opts.sourceUrl || readUrl(), uploadUrl: opts.uploadUrl || upUrl(), ...(opts.body || {}) } });
      let json = null; try { json = JSON.parse(r.body); } catch { /* */ }
      return { r, json, uploaded, uploadHeaders, uploadInit, logs: logs.join('') };
    } finally {
      app.log.info = realInfo;
      app.log.error = realError;
      global.fetch = realFetch;
    }
  };
  // the ONE success shape: exactly { success: true, stripped: true, jobId }
  const exact = (j) => !!j && JSON.stringify(Object.keys(j).sort()) === '["jobId","stripped","success"]' && j.success === true && j.stripped === true && typeof j.jobId === 'string' && j.jobId.length > 0;
  const writtenReport = async (buf, kind) => { const f = path.join(tmp, `w-${Date.now()}`); await writeFile(f, buf); const rep = await media.metadataReport(f, kind); const brand = kind === 'iso' ? await media.containerBrand(f) : null; await rm(f, { force: true }); return { ...rep, brand }; };
  const allLogs = [];

  for (const [fx, brand] of [['gps-video-free-first.mov', 'qt'], ['gps-audio-free-first.m4a', 'qt'], ['gps-video.mp4', 'isom'], ['gps-video.mov', 'qt'], ['gps-video-xyz.mov', 'qt'], ['gps-audio.m4a', 'isom']]) {
    const c = await call('/strip-metadata', await readFile(FIX(fx)));
    allLogs.push(c.logs);
    const rep = c.uploaded && await writtenReport(c.uploaded, 'iso');
    check(`strip ${fx} (key without an extension): 200, written back in place clean, brand ${brand} kept`,
      c.r.statusCode === 200 && exact(c.json) && rep?.clean && rep.brand === brand && media.locationMarkers(c.uploaded).length === 0,
      `${c.r.statusCode} ${c.r.body.slice(0, 160)} ${JSON.stringify(rep)}`);
  }
  {
    // Astra's P2-1 on #646: every audio format is cleaned too — tags, comments
    // and attached pictures (album art whose JPEG carries GPS EXIF) — never
    // published as-is.
    const art = FIX('gps-art.jpg');
    const base = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
    const tag = ['-metadata', 'title=Fixtureville', '-metadata', 'comment=GPS 0.5 0.5'];
    const make = async (name, args) => { const f = path.join(tmp, name); await sh('ffmpeg', [...base, ...args, f]); return f; };
    const audio = [
      ['mp3 with GPS-EXIF album art + ID3', await make('p2-art.mp3', ['-i', art, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-id3v2_version', '3', ...tag]), 'mp3'],
      ['wav with a LIST/INFO chunk', await make('p2-tagged.wav', [...tag]), 'wav'],
      ['flac with a picture block + comments', await make('p2-art.flac', ['-i', art, '-map', '0:a', '-map', '1:v', '-c:a', 'flac', '-c:v', 'copy', '-disposition:v', 'attached_pic', ...tag]), 'flac'],
      ['ogg/opus with comments', await make('p2-tagged.ogg', ['-c:a', 'libopus', ...tag]), 'ogg'],
      ['webm audio with tags', await make('p2-tagged-audio.webm', ['-c:a', 'libopus', ...tag]), 'matroska'],
    ];
    for (const [label, file, family] of audio) {
      const src = await readFile(file);
      const before = await media.metadataReport(file, family);
      const c = await call('/strip-metadata', src);
      const rep = c.uploaded && await writtenReport(c.uploaded, family);
      const sum = c.uploaded && await (async () => { const f = path.join(tmp, `s-${Date.now()}`); await writeFile(f, c.uploaded); const r = await media.streamSummary(f); await rm(f, { force: true }); return r; })();
      check(`audio — ${label}: dirty before, 200 (exact shape), written back clean: no tags, no picture, no EXIF/GPS bytes; decoded PCM IDENTICAL`,
        !before.clean && src.includes(Buffer.from('Fixtureville')) && c.r.statusCode === 200 && exact(c.json) && rep?.clean
          && !c.uploaded.includes(Buffer.from('Fixtureville')) && !c.uploaded.includes(Buffer.from('GPS 0.5')) && !c.uploaded.includes(Buffer.from('Exif\0\0', 'latin1'))
          && sum?.audio === 1 && sum?.video === 0
          && (await pcmHash(file)) === (await (async () => { const f = path.join(tmp, `pcm-${Date.now()}`); await writeFile(f, c.uploaded); const h = await pcmHash(f); await rm(f, { force: true }); return h; })()),
        `${c.r.statusCode} ${c.r.body.slice(0, 140)} before=${JSON.stringify(before)} after=${JSON.stringify(rep)} streams=${JSON.stringify(sum)}`);
    }
  }
  // ── Astra's 2nd HOLD on worker #3: independent cases ──────────────────────
  const writeTmp = async (buf, ext = '') => { const f = path.join(tmp, `u-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`); await writeFile(f, buf); return f; };
  const samePcm = async (inFile, outBuf) => { const f = await writeTmp(outBuf); const ok = (await pcmHash(inFile)) === (await pcmHash(f)); await rm(f, { force: true }); return ok; };
  const tone = ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
  {
    // ffmpeg writes ID3v1 only beside ID3v2: write both, then cut the ID3v2 tag off
    const both = path.join(tmp, 'id3both.mp3'), f = path.join(tmp, 'id3v1.mp3');
    await sh('ffmpeg', [...tone, '-c:a', 'libmp3lame', '-write_id3v1', '1', '-metadata', 'title=Fixtureville', both]);
    const b0 = await readFile(both);
    const v2 = 10 + (((b0[6] & 0x7f) << 21) | ((b0[7] & 0x7f) << 14) | ((b0[8] & 0x7f) << 7) | (b0[9] & 0x7f));
    await writeFile(f, b0.subarray(v2));
    const before = await media.metadataReport(f, 'mp3');
    const c = await call('/strip-metadata', await readFile(f));
    const tailTag = c.uploaded && c.uploaded.subarray(c.uploaded.length - 128, c.uploaded.length - 125).toString('latin1');
    check('ID3v1 alone (no ID3v2): found before; 200, no TAG trailer after; PCM identical', before.leftovers.includes('id3v1') && !before.leftovers.includes('id3v2') && c.r.statusCode === 200 && tailTag !== 'TAG' && !c.uploaded.includes(Buffer.from('Fixtureville')) && (await samePcm(f, c.uploaded)), `${JSON.stringify(before.leftovers)} ${c.r.statusCode}`);
  }
  {
    // an APEv2 tag (footer + item) appended to a plain mp3
    const plain = path.join(tmp, 'plain-ape.mp3');
    await sh('ffmpeg', [...tone, '-c:a', 'libmp3lame', '-id3v2_version', '0', '-write_id3v1', '0', plain]);
    const item = Buffer.concat([Buffer.alloc(4), Buffer.alloc(4), Buffer.from('Title\0Fixtureville', 'latin1')]); item.writeUInt32LE('Fixtureville'.length, 0);
    const footer = Buffer.alloc(32); footer.write('APETAGEX', 0, 'latin1'); footer.writeUInt32LE(2000, 8); footer.writeUInt32LE(item.length + 32, 12); footer.writeUInt32LE(1, 16);
    const f = path.join(tmp, 'ape.mp3');
    await writeFile(f, Buffer.concat([await readFile(plain), item, footer]));
    const before = await media.metadataReport(f, 'mp3');
    const c = await call('/strip-metadata', await readFile(f));
    check('an APE tag: found before; 200, no APETAGEX after; PCM identical', before.leftovers.includes('ape') && c.r.statusCode === 200 && !c.uploaded.includes(Buffer.from('APETAGEX')) && !c.uploaded.includes(Buffer.from('Fixtureville')) && (await samePcm(plain, c.uploaded)), `${JSON.stringify(before.leftovers)} ${c.r.statusCode} ${c.r.body.slice(0, 100)}`);
  }
  {
    // Logic Pro's exports (Comma, 2026-10-29: two of Sandy's MP3s were refused while WAVs of the same audio passed).
    // Logic writes STEREO CBR 320 at 44.1 kHz with no Xing/Info frame and an ID3 v2.2 tag (three-letter frames: TSS,
    // COM iTunSMPB…). Every STEREO MP3 was refused: the remux's own Info frame reads back as a stream tag (encoder=Lavf),
    // which mono files never show — and every MP3 case above is mono. Each shape here: 200, clean, stereo kept, PCM identical.
    const logicBase = path.join(tmp, 'logic-none.mp3');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-filter_complex', '[0][1]amerge=inputs=2', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '320k', '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0', logicBase]);
    // ID3 v2.2 by hand (ffmpeg writes only 2.3 / 2.4): 3-letter ids, 3-byte sizes, the size of the whole tag syncsafe
    const f22 = (id, body) => { const h = Buffer.alloc(6); h.write(id, 0, 'latin1'); h.writeUIntBE(body.length, 3, 3); return Buffer.concat([h, body]); };
    const txt = (s) => Buffer.from(`\0${s}`, 'latin1');
    const frames = Buffer.concat([
      f22('TT2', txt('Fixtureville')), f22('TP1', txt('Fixtureville Artist')), f22('TSS', txt('Logic Pro 12.3.1')), f22('TBP', txt('120')),
      f22('COM', Buffer.from('\0engiTunSMPB\0 00000000 00000210 0000095E 0000000000300C92', 'latin1')), Buffer.alloc(64),
    ]);
    const id3hdr = Buffer.from([0x49, 0x44, 0x33, 2, 0, 0, (frames.length >> 21) & 0x7f, (frames.length >> 14) & 0x7f, (frames.length >> 7) & 0x7f, frames.length & 0x7f]);
    const logic22 = path.join(tmp, 'logic-id3v22.mp3');
    await writeFile(logic22, Buffer.concat([id3hdr, frames, await readFile(logicBase)]));
    const tagged = async (v) => { const f = path.join(tmp, `logic-id3v2${v}.mp3`); await sh('ffmpeg', ['-v', 'error', '-i', logicBase, '-c', 'copy', '-write_xing', '0', '-id3v2_version', String(v), '-metadata', 'title=Fixtureville', '-metadata', 'artist=Fixtureville Artist', '-metadata', 'encoded_by=Logic Pro 12.3.1', '-metadata', 'comment=iTunSMPB 00000210', f]); return f; };
    const xing = path.join(tmp, 'stereo-xing.mp3'); // a stereo MP3 WITH an Info frame (LAME / ffmpeg-made), the other shape
    await sh('ffmpeg', ['-v', 'error', '-i', logicBase, '-c:a', 'libmp3lame', '-b:a', '320k', '-metadata', 'title=Fixtureville', xing]);
    const logicWav = path.join(tmp, 'logic.wav');
    await sh('ffmpeg', ['-v', 'error', '-i', logicBase, '-c:a', 'pcm_s24le', '-metadata', 'title=Fixtureville', '-metadata', 'encoded_by=Logic Pro 12.3.1', logicWav]);
    const shapes = [
      ['Logic MP3, stereo CBR 320, no Info frame, ID3 v2.2', logic22, 'mp3', true],
      ['Logic MP3, ID3 v2.3', await tagged(3), 'mp3', true],
      ['Logic MP3, ID3 v2.4', await tagged(4), 'mp3', true],
      ['Logic MP3, no tags', logicBase, 'mp3', false],
      ['stereo MP3 with an Info frame (LAME)', xing, 'mp3', true],
      ['Logic WAV, stereo 24-bit, tagged', logicWav, 'wav', true],
    ];
    for (const [label, file, family, dirty] of shapes) {
      const before = await media.metadataReport(file, family);
      const c = await call('/strip-metadata', await readFile(file));
      const out = c.uploaded && await writeTmp(c.uploaded, `.${family}`);
      const rep = out && await media.metadataReport(out, family);
      const chans = out && Number((await sh('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', out])).trim());
      // MP3: every audio packet byte-identical (a stream copy). Not PCM: the remux's Info frame makes a decoder skip the
      // encoder's 529-sample start delay, which a file without one (Logic's) is decoded with. WAV: PCM identical.
      const pcm = out && (family === 'mp3' ? (await packetHash(file)) === (await packetHash(out)) : await samePcm(file, c.uploaded));
      if (out) await rm(out, { force: true });
      check(`${label}: ${dirty ? 'dirty before; ' : ''}200 (exact shape), written back clean, still stereo, ${family === 'mp3' ? 'audio packets' : 'PCM'} identical, no tag text left`,
        before.clean === !dirty && c.r.statusCode === 200 && exact(c.json) && rep?.clean && chans === 2 && pcm
          && !['Fixtureville', 'Logic Pro', 'iTunSMPB'].some((s) => c.uploaded.includes(Buffer.from(s, 'latin1'))),
        `${c.r.statusCode} ${c.r.body.slice(0, 140)} before=${JSON.stringify(before)} after=${JSON.stringify(rep)} channels=${chans}`);
    }
    // the allowance's two edges (the Reviewer on worker #4): exactly `Lavf`, and only for MP3. The positive control first.
    check('positive control: an MP3 stream tagged encoder=Lavf (the remux\'s own, bitexact) is structural', media.badStreamTags({ encoder: 'Lavf' }, 'mp3').length === 0);
    const otherValues = ['Lavf62.3.100', 'LAME3.100', 'Lavf Fixtureville', 'lavf', ' Lavf', 'Lavf\n', ''];
    check(`an MP3 stream whose encoder is anything else (${otherValues.map((v) => JSON.stringify(v)).join(', ')}) → reported`, otherValues.every((v) => JSON.stringify(media.badStreamTags({ encoder: v }, 'mp3')) === '["encoder"]'));
    const families = ['wav', 'flac', 'ogg', 'matroska', 'iso'];
    check(`encoder=Lavf on a stream of any other family (${families.join(', ')}) → reported`, families.every((f) => JSON.stringify(media.badStreamTags({ encoder: 'Lavf' }, f)) === '["encoder"]'));
    // Comma's item 4, on its own: the ID3 v2.2 tag is seen, and then it's gone — no tag header, none of its frames' text
    const before22 = await media.metadataReport(logic22, 'mp3');
    const c22 = await call('/strip-metadata', await readFile(logic22));
    check('ID3 v2.2 (Logic): found before (the header + its frames read as tags); after, no ID3 header at the start and no frame text anywhere',
      before22.leftovers.includes('id3v2') && before22.formatTags > 0 && c22.r.statusCode === 200 && c22.uploaded.subarray(0, 3).toString('latin1') !== 'ID3'
        && !['Fixtureville', 'Logic Pro 12.3.1', 'iTunSMPB'].some((s) => c22.uploaded.includes(Buffer.from(s, 'latin1'))),
      `${JSON.stringify(before22)} ${c22.r.statusCode}`);
  }
  {
    // Astra's P1 on worker #4 (2026-10-31): ID3v2 tags BETWEEN frames or AFTER the audio — v2.2, v2.3, v2.4 with its
    // footer — in mono and stereo. ffmpeg's demuxer resyncs past them and a lossless copy keeps them, while the old
    // check (an ID3v2 header at byte 0) called the output clean. Now the input is rebuilt from its frames
    // (lib/mp3Frames: tags dropped, anything unaccounted for refused) and the output is walked frame by frame.
    const mp3Frames = require('../lib/mp3Frames');
    const syncsafe4 = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
    const id3 = {
      'v2.2': (text) => { const body = Buffer.concat([Buffer.from('TT2', 'latin1'), Buffer.from([0, 0, text.length + 1, 0]), Buffer.from(text, 'latin1')]); return Buffer.concat([Buffer.from('ID3\x02\x00\x00', 'latin1'), syncsafe4(body.length), body]); },
      'v2.3': (text) => { const body = Buffer.concat([Buffer.from('TIT2', 'latin1'), Buffer.from([0, 0, 0, text.length + 1, 0, 0, 0]), Buffer.from(text, 'latin1')]); return Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'latin1'), syncsafe4(body.length), body]); },
      'v2.4 with a footer': (text) => { const body = Buffer.concat([Buffer.from('TIT2', 'latin1'), syncsafe4(text.length + 1), Buffer.from([0, 0, 3]), Buffer.from(text, 'latin1')]); return Buffer.concat([Buffer.from('ID3\x04\x00\x10', 'latin1'), syncsafe4(body.length), body, Buffer.from('3DI\x04\x00\x10', 'latin1'), syncsafe4(body.length)]); },
    };
    // the other trailers' builders: ID3v1 (genre 255, as taggers write it), APE (footer only, or header and footer), Lyrics3 v2
    const v1 = (text) => { const b = Buffer.alloc(128); b.write('TAG', 0, 'latin1'); b.write(text, 3, 'latin1'); b[127] = 255; return b; };
    const apeItem = (text) => { const item = Buffer.concat([Buffer.alloc(8), Buffer.from(`Title\0${text}`, 'latin1')]); item.writeUInt32LE(text.length, 0); return item; };
    const apeBlock = (size, flags) => { const f = Buffer.alloc(32); f.write('APETAGEX', 0, 'latin1'); f.writeUInt32LE(2000, 8); f.writeUInt32LE(size, 12); f.writeUInt32LE(1, 16); f.writeUInt32LE(flags >>> 0, 20); return f; };
    const ape = (text) => { const item = apeItem(text); return Buffer.concat([item, apeBlock(item.length + 32, 0)]); };
    const apeWithHeader = (text) => { const item = apeItem(text); return Buffer.concat([apeBlock(item.length + 32, 0xa0000000), item, apeBlock(item.length + 32, 0x80000000)]); };
    const lyrics2 = (text) => { const body = Buffer.from(`LYRICSBEGINLYR${String(text.length).padStart(5, '0')}${text}`, 'latin1'); return Buffer.concat([body, Buffer.from(`${String(body.length).padStart(6, '0')}LYRICS200`, 'latin1')]); };
    const remuxPlain = async (f) => { const o = `${f}.plain.mp3`; await sh('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', '-id3v2_version', '0', '-write_id3v1', '0', '-fflags', '+bitexact', o]); const b = await readFile(o); await rm(o, { force: true }); return b; };
    const channels = async (f) => Number((await sh('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', f])).trim());
    const SECRET = 'Fixtureville GPS 51.5 -0.1';
    for (const ch of [1, 2]) {
      const who = ch === 1 ? 'mono' : 'stereo';
      const plain = path.join(tmp, `placed-${who}.mp3`);
      await sh('ffmpeg', [...tone, '-ac', String(ch), '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_id3v1', '0', plain]);
      const pb = await readFile(plain);
      const at = Number((await sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pos', '-of', 'csv=p=0', plain])).trim().split('\n')[20]);
      const positive = await call('/strip-metadata', pb);
      const posOut = positive.uploaded && await writeTmp(positive.uploaded, '.mp3');
      check(`clean ${who} MP3 (positive control): frames only before (the walk finds nothing), 200, clean after, ${who}, audio packets identical`,
        (await media.metadataReport(plain, 'mp3')).leftovers.length === 0 && positive.r.statusCode === 200 && exact(positive.json) && (await media.metadataReport(posOut, 'mp3')).clean && (await channels(posOut)) === ch && (await packetHash(plain)) === (await packetHash(posOut)),
        `${positive.r.statusCode} ${positive.r.body.slice(0, 120)}`);
      if (posOut) await rm(posOut, { force: true });
      for (const [version, make] of Object.entries(id3)) {
        for (const [place, build] of [['between frames', (t) => Buffer.concat([pb.subarray(0, at), t, pb.subarray(at)])], ['after the audio', (t) => Buffer.concat([pb, t])]]) {
          const f = path.join(tmp, `placed-${who}-${version.replace(/\W+/g, '')}-${place.replace(/\W+/g, '')}.mp3`);
          await writeFile(f, build(make(SECRET)));
          const kept = (await remuxPlain(f)).includes(Buffer.from(SECRET, 'latin1')); // the gap, shown on this very file
          const before = await media.metadataReport(f, 'mp3');
          const c = await call('/strip-metadata', await readFile(f));
          const out = c.uploaded && await writeTmp(c.uploaded, '.mp3');
          const after = out && await media.metadataReport(out, 'mp3');
          check(`ID3 ${version} ${place}, ${who}: a plain remux keeps it; seen before (id3v2); 200, written back with no tag and no tag text, clean frame to frame, ${who}, audio packets identical to the untagged file`,
            kept && JSON.stringify(before.leftovers) === '["id3v2"]' && c.r.statusCode === 200 && exact(c.json) && after?.clean && !c.uploaded.includes(Buffer.from('Fixtureville')) && !c.uploaded.includes(Buffer.from('3DI', 'latin1'))
              && (await channels(out)) === ch && (await packetHash(plain)) === (await packetHash(out)),
            `kept=${kept} before=${JSON.stringify(before)} ${c.r.statusCode} ${c.r.body.slice(0, 120)} after=${JSON.stringify(after)}`);
          if (out) await rm(out, { force: true });
        }
      }
      // Astra's P2 on #4 (2026-11-01): /enhance decoded the original input, so a tagged or cut file got 200 there. The
      // MP3 rebuild now runs at the input boundary, before every endpoint's work: each refusal below is checked
      // through /enhance too, with the same code and the same `at`
      const enhanceRefuses = async (bytes, body) => {
        const dirsBefore = (await jobDirs()).length;
        const e = await call('/enhance', bytes, { body: { enhancementType: 'clean' } });
        return e.r.statusCode === 415 && JSON.stringify(e.json) === JSON.stringify(body) && e.uploaded === null && (await jobDirs()).length === dirsBefore ? '' : `${e.r.statusCode} ${e.r.body.slice(0, 120)}`;
      };
      // bytes that are neither a frame nor a tag: REFUSED (415 mp3-structure, with where), nothing written, no temp dir left
      const junk = Buffer.from(`${SECRET} private notes, not a tag`, 'latin1');
      const huge = Buffer.concat([Buffer.from('ID3\x03\x00\x00', 'latin1'), syncsafe4(50 * 1024 * 1024), Buffer.from(SECRET, 'latin1')]); // a tag whose size runs past the end
      const lyrics1 = Buffer.from(`LYRICSBEGIN${SECRET}LYRICSEND`, 'latin1'); // Lyrics3 v1: no size to skip by
      for (const [label, bytes, where] of [['unparsed bytes between frames', Buffer.concat([pb.subarray(0, at), junk, pb.subarray(at)]), at], ['unparsed bytes after the audio', Buffer.concat([pb, junk]), pb.length], ['an ID3 header whose size runs past the end, between frames', Buffer.concat([pb.subarray(0, at), huge, pb.subarray(at)]), at], ['a Lyrics3 v1 block after the audio', Buffer.concat([pb, lyrics1]), pb.length]]) {
        const dirsBefore = (await jobDirs()).length;
        const c = await call('/strip-metadata', bytes);
        check(`${label}, ${who} → REFUSED 415 {error: mp3-structure, detail: {at: ${where}}}, nothing written, no temp dir left`,
          c.r.statusCode === 415 && JSON.stringify(c.json) === JSON.stringify({ error: 'mp3-structure', detail: { at: where } }) && c.uploaded === null && (await jobDirs()).length === dirsBefore,
          `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        const e = await enhanceRefuses(bytes, { error: 'mp3-structure', detail: { at: where } });
        check(`...the same through /enhance: 415 mp3-structure {at: ${where}}, nothing written`, e === '', e);
      }
      // what it drops without refusing: zero padding after a leading tag (not audio)
      const padded = Buffer.concat([id3['v2.3'](SECRET), Buffer.alloc(300), pb]);
      const cp = await call('/strip-metadata', padded);
      const cpOut = cp.uploaded && await writeTmp(cp.uploaded, '.mp3');
      check(`a leading tag, then 300 zero bytes, ${who}: 200, the tag and the zeros gone, clean frame to frame, audio packets identical`,
        cp.r.statusCode === 200 && !cp.uploaded.includes(Buffer.from('Fixtureville')) && (await media.metadataReport(cpOut, 'mp3')).clean && (await packetHash(plain)) === (await packetHash(cpOut)), `${cp.r.statusCode} ${cp.r.body.slice(0, 120)}`);
      if (cpOut) await rm(cpOut, { force: true });
      // a cut-off LAST frame is dropped (Sandy, 2026-11-01, reversing Astra's P2-2: archive files often have no source
      // left to re-export), when nothing but trailers read back from the end follows it; and a trailer that runs into
      // the last frame takes that frame with it. Both cut, nothing of them kept. Each shape: 200, the strict walk
      // clean, the audio packets equal to the input's frames without its last one, none of the cut bytes or tag text
      // in the output
      const packets = (await sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pos,size', '-of', 'csv=p=0', plain])).trim().split('\n')
        .map((l) => { const [size, pos] = l.split(',').filter(Boolean).map(Number); return { pos, size }; }); // ffprobe prints size, then pos
      const lastFrame = packets[packets.length - 1];
      const kept = path.join(tmp, `kept-${who}.mp3`);
      await writeFile(kept, pb.subarray(0, lastFrame.pos)); // the input's frames without the last one
      const keptHash = await packetHash(kept);
      const cut100 = pb.subarray(0, pb.length - 100);
      for (const [label, bytes, remains] of [
        ['the last frame 100 bytes short', cut100],
        ['the last frame 1 byte short', pb.subarray(0, pb.length - 1)],
        ['the last frame its 4-byte header only', pb.subarray(0, lastFrame.pos + 4)],
        ['the last frame 2 bytes of its header only', pb.subarray(0, lastFrame.pos + 2)],
        ['the last frame 2 bytes of its header, then an ID3v1', Buffer.concat([pb.subarray(0, lastFrame.pos + 2), v1(SECRET)])],
        ['the last frame its header, then zeros (as old rips end)', Buffer.concat([pb.subarray(0, lastFrame.pos + 4), Buffer.alloc(lastFrame.size - 130)])],
        ['the last frame cut, its remains carrying text', Buffer.concat([pb.subarray(0, lastFrame.pos + 36), Buffer.from(SECRET, 'latin1')])],
        ['the last frame cut, an ID3v1 after it', Buffer.concat([cut100, v1(SECRET)])],
        ['the last frame cut, an APE tag (items and footer) after it', Buffer.concat([cut100, ape(SECRET)])],
        ['the last frame cut, an APE tag with its header, then an ID3v1', Buffer.concat([cut100, apeWithHeader(SECRET), v1(SECRET)])],
        ['the last frame cut, an ID3 v2.4 tag with its footer after it', Buffer.concat([cut100, id3['v2.4 with a footer'](SECRET)])],
        ['the last frame cut, Lyrics3 v2 then an ID3v1', Buffer.concat([cut100, lyrics2(SECRET), v1(SECRET)])],
        ['the last frame cut, Lyrics3 v1 then an ID3v1', Buffer.concat([cut100, lyrics1, v1(SECRET)])],
      ].map(([l, b]) => [l, b, b.subarray(lastFrame.pos, Math.min(b.length, lastFrame.pos + lastFrame.size))])) {
        const c = await call('/strip-metadata', bytes);
        const out = c.uploaded && await writeTmp(c.uploaded, '.mp3');
        check(`${label}, ${who}: 200, the cut frame and the trailers dropped (clean frame to frame, audio packets equal to the input's frames without its last, none of its ${remains.length} cut bytes, no tag text)`,
          c.r.statusCode === 200 && exact(c.json) && (await media.metadataReport(out, 'mp3')).clean && (await packetHash(out)) === keptHash
            && (remains.length < 16 || !c.uploaded.includes(remains)) && !c.uploaded.includes(Buffer.from('Fixtureville')),
          `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        if (out) await rm(out, { force: true });
      }
      for (const [label, bytes] of [['the last frame cut, an ID3v1 after it', Buffer.concat([cut100, v1(SECRET)])], ['the last frame its header only', pb.subarray(0, lastFrame.pos + 4)]]) {
        const e = await call('/enhance', bytes, { body: { enhancementType: 'clean' } });
        check(`...through /enhance, ${label}, ${who}: 200, a WAV with no tag text`, e.r.statusCode === 200 && exact(e.json) && e.uploaded.subarray(0, 4).toString('latin1') === 'RIFF' && !e.uploaded.includes(Buffer.from('Fixtureville')), `${e.r.statusCode} ${e.r.body.slice(0, 120)}`);
      }
      // ...and only the LAST frame: a cut frame mid-file, or junk after a cut last frame that runs past where that
      // frame would end (not a trailer), leaves the walk on bytes it can't account for: refused. (Junk that ends
      // inside the cut frame's length can't be told from that frame's own bytes: it is dropped with them.)
      const mid = packets[Math.floor(packets.length / 2)];
      const junk3 = Buffer.concat([junk, junk, junk]);
      for (const [label, bytes, where] of [
        ['a middle frame 100 bytes short', Buffer.concat([pb.subarray(0, mid.pos + mid.size - 100), pb.subarray(mid.pos + mid.size)]), mid.pos + mid.size],
        [`the last frame cut, then ${junk3.length} bytes of text`, Buffer.concat([cut100, junk3]), pb.length],
        [`the last frame cut, then ${junk3.length} bytes of text, then an ID3v1`, Buffer.concat([cut100, junk3, v1(SECRET)]), pb.length],
        ['every frame whole, then 3 bytes that don\'t start a header of this stream', Buffer.concat([pb, Buffer.from([0xff, pb[lastFrame.pos + 1] ^ 0x08, 0x90])]), pb.length],
      ]) {
        const dirsBefore = (await jobDirs()).length;
        const c = await call('/strip-metadata', bytes);
        check(`${label}, ${who} → still REFUSED 415 {error: mp3-structure, detail: {at: ${where}}}, nothing written, no temp dir left`,
          c.r.statusCode === 415 && JSON.stringify(c.json) === JSON.stringify({ error: 'mp3-structure', detail: { at: where } }) && c.uploaded === null && (await jobDirs()).length === dirsBefore,
          `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        const e = await enhanceRefuses(bytes, { error: 'mp3-structure', detail: { at: where } });
        check(`...the same through /enhance: 415 mp3-structure {at: ${where}}, nothing written`, e === '', e);
      }
      const tagged1 = await call('/strip-metadata', Buffer.concat([pb, v1(SECRET)]));
      check(`positive control: the whole last frame, then an ID3v1 tag, ${who}: 200, the tag gone`, tagged1.r.statusCode === 200 && exact(tagged1.json) && !tagged1.uploaded.includes(Buffer.from('Fixtureville')), `${tagged1.r.statusCode} ${tagged1.r.body.slice(0, 120)}`);
      // Lyrics3 v1 (the Reviewer, 2026-11-01: a real file had one): it has no size, so it's removed only where it
      // belongs, its LYRICSEND directly before an ID3v1 at the end. Anywhere else it stays refused (above: after the
      // audio with no ID3v1 after it)
      for (const ep of ['/strip-metadata', '/enhance']) {
        const c = await call(ep, Buffer.concat([pb, lyrics1, v1(SECRET)]), ep === '/enhance' ? { body: { enhancementType: 'clean' } } : {});
        const out = ep === '/strip-metadata' && c.uploaded && await writeTmp(c.uploaded, '.mp3');
        check(`Lyrics3 v1 then ID3v1 after the audio, ${who}, ${ep}: 200, both gone (no LYRICS marker, no tag text)${out ? ', clean frame to frame, audio packets identical' : ''}`,
          c.r.statusCode === 200 && exact(c.json) && !c.uploaded.includes(Buffer.from('Fixtureville')) && !c.uploaded.includes(Buffer.from('LYRICS', 'latin1'))
            && (!out || ((await media.metadataReport(out, 'mp3')).clean && (await packetHash(plain)) === (await packetHash(out)))),
          `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        if (out) await rm(out, { force: true });
      }
      for (const [label, bytes, where] of [
        ['Lyrics3 v1, one byte, then ID3v1 (its LYRICSEND not directly before the TAG)', Buffer.concat([pb, lyrics1, Buffer.from('x'), v1(SECRET)]), pb.length],
        ['Lyrics3 v1 between frames, an ID3v1 at the end', Buffer.concat([pb.subarray(0, at), lyrics1, pb.subarray(at), v1(SECRET)]), at],
      ]) {
        const c = await call('/strip-metadata', bytes);
        check(`${label}, ${who} → still REFUSED 415 {error: mp3-structure, detail: {at: ${where}}}, nothing written`,
          c.r.statusCode === 415 && JSON.stringify(c.json) === JSON.stringify({ error: 'mp3-structure', detail: { at: where } }) && c.uploaded === null, `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
      }
      // ...and through /enhance: tags at the start, between frames and at the end are removed, not refused
      const enhTagged = await call('/enhance', Buffer.concat([id3['v2.3'](SECRET), pb.subarray(0, at), id3['v2.2'](SECRET), pb.subarray(at), v1(SECRET)]), { body: { enhancementType: 'clean' } });
      check(`positive control through /enhance, ${who}: ID3v2 at the start and between frames plus an ID3v1 at the end → 200, a WAV with none of their text`,
        enhTagged.r.statusCode === 200 && exact(enhTagged.json) && enhTagged.uploaded.subarray(0, 4).toString('latin1') === 'RIFF' && !enhTagged.uploaded.includes(Buffer.from('Fixtureville')), `${enhTagged.r.statusCode} ${enhTagged.r.body.slice(0, 120)}`);
      // Astra's P2 on #4 (2026-11-01): a corrupt middle frame, its header intact (so the frame walk accepts it), passed:
      // ffmpeg skips it, logs an error and exits 0. The full decode now refuses on any error-level line, as a code only
      {
        const mid = packets[Math.floor(packets.length / 2)];
        const bad = Buffer.from(pb);
        bad.fill(0xff, mid.pos + 4, mid.pos + mid.size); // the header kept, the side info and audio data garbage
        for (const ep of ['/strip-metadata', '/enhance']) {
          const dirsBefore = (await jobDirs()).length;
          const c = await call(ep, bad, ep === '/enhance' ? { body: { enhancementType: 'clean' } } : {});
          check(`a corrupt middle frame (header intact), ${who}, ${ep} → REFUSED 415 {error: audio-decode-error} exactly, nothing written, no decoder text in the reply or the log`,
            c.r.statusCode === 415 && c.r.body === '{"error":"audio-decode-error"}' && c.uploaded === null && (await jobDirs()).length === dirsBefore && !/mp3float|big_values|Error while|Invalid data/i.test(c.logs),
            `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        }
        const f = await writeTmp(bad, '.mp3');
        let walked = null;
        try { await mp3Frames.sanitizeMp3(f, `${f}.frames`); walked = 'accepted'; } catch (e) { walked = e.workerCode; }
        await rm(f, { force: true }); await rm(`${f}.frames`, { force: true });
        check(`...and it is the decode that refuses it: the frame walk alone accepts that file (${walked})`, walked === 'accepted');
      }
      // Astra's P1 (2026-11-01): a tag INSIDE a frame, written over the end of its interior (the frame's length
      // unchanged), in the last frame and a middle one, each kind. Compressed audio is never cut: inside a WHOLE frame
      // the file is refused (415 mp3-tag-in-audio, where the tag is seen), nothing written. In the last frame, the
      // kinds read back from the end as a trailer (ID3v1, APE by its footer, ID3 v2.4 by its footer) end the audio
      // inside that frame: it is the cut last frame, dropped with the tag (Sandy, 2026-11-01), so 200 and none of
      // the tag text kept; ID3 v2.2 and v2.3 there have no footer, the frame stays whole, and they are refused. And
      // the output walk catches each one on its own: given the bytes directly, and through the endpoint with the
      // input rebuild sabotaged into a plain copy.
      const kinds = [...Object.entries(id3).map(([v, make]) => [`ID3 ${v}`, make, 'id3v2']), ['ID3v1', v1, 'id3v1'], ['APE (an item and its footer)', ape, 'ape']];
      for (const [place, frame] of [['the last frame', lastFrame], ['a middle frame', packets[Math.floor(packets.length / 2)]]]) {
        for (const [kind, make, named] of kinds) {
          const t = make(SECRET);
          const bytes = Buffer.from(pb);
          const start = frame.pos + frame.size - t.length;
          t.copy(bytes, start);
          // where it's seen: where the tag starts; an APE tag inside a middle frame by its footer (at the end of the
          // file, a trailer is read back from the end: from its first item)
          const where = start + (named === 'ape' && place === 'a middle frame' ? apeItem(SECRET).length : 0);
          if (place === 'the last frame' && (named !== 'id3v2' || kind.includes('footer'))) {
            for (const ep of ['/strip-metadata', '/enhance']) {
              const c = await call(ep, bytes, ep === '/enhance' ? { body: { enhancementType: 'clean' } } : {});
              const out = ep === '/strip-metadata' && c.uploaded && await writeTmp(c.uploaded, '.mp3');
              check(`${kind} inside ${place}, ${who}, ${ep}: read back as a trailer, the last frame dropped with it: 200, no tag text${out ? ', clean frame to frame, audio packets equal to the input\'s frames without its last' : ''}`,
                c.r.statusCode === 200 && exact(c.json) && !c.uploaded.includes(Buffer.from('Fixtureville')) && (!out || ((await media.metadataReport(out, 'mp3')).clean && (await packetHash(out)) === keptHash)),
                `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
              if (out) await rm(out, { force: true });
            }
          } else {
            const dirsBefore = (await jobDirs()).length;
            const c = await call('/strip-metadata', bytes);
            check(`${kind} inside ${place}, ${who} → REFUSED 415 {error: mp3-tag-in-audio, detail: {at: ${where}}}, nothing written, no temp dir left`,
              c.r.statusCode === 415 && JSON.stringify(c.json) === JSON.stringify({ error: 'mp3-tag-in-audio', detail: { at: where } }) && c.uploaded === null && (await jobDirs()).length === dirsBefore,
              `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
            const e = await enhanceRefuses(bytes, { error: 'mp3-tag-in-audio', detail: { at: where } });
            check(`...the same through /enhance: 415 mp3-tag-in-audio {at: ${where}}, nothing written`, e === '', e);
          }
          const f = await writeTmp(bytes, '.mp3');
          const walked = await mp3Frames.mp3Leftovers(f);
          await rm(f, { force: true });
          const realSanitize = media.sanitizeMp3;
          media.sanitizeMp3 = async (i, o) => { await copyFile(i, o); return { frames: 0, removed: {} }; };
          let s;
          try { s = await call('/strip-metadata', bytes); } finally { media.sanitizeMp3 = realSanitize; }
          check(`${kind} inside ${place}, ${who}, the output walk alone: names it (${named}); with the input rebuild sabotaged, 500 metadata-survived (1 leftover), nothing written`,
            JSON.stringify(walked) === JSON.stringify([named]) && s.r.statusCode === 500 && s.json?.error === 'metadata-survived' && s.json.detail?.leftovers === 1 && s.uploaded === null,
            `walked=${JSON.stringify(walked)} ${s.r.statusCode} ${s.r.body.slice(0, 120)}`);
        }
      }
      // Astra's P1 (2026-11-03): non-Latin text, as a real tagger writes it. ffmpeg's ID3v1 is UTF-8: a Japanese title
      // cut at the field's 30 bytes mid-character, and a Cyrillic one. Inside a middle frame: refused by the input
      // rebuild through both endpoints, and named by the output walk on its own (given the bytes, and with the
      // rebuild sabotaged). After the audio (the positive control): removed, 200, none of its text kept
      // (and, the Reviewer's gap on 6dc4e5c2: an ID3v1.1 tag, its track number in byte 126, as ffmpeg writes it with a
      // track: the v1.1 comment path)
      for (const [lang, title, artist, more, shape] of [
        ['Japanese', 'A東京の夜明けとフィクスチャー村の記録', 'テスト歌手', [], (t) => t[31] === 0xe3 && t[32] === 0x82], // cut mid-character
        ['Cyrillic', 'Фикстурвиль: запись у реки', 'Тестовый Артист', [], () => true],
        ['v1.1 (track 5, a comment)', 'Fixtureville', 'Test Artist', ['-metadata', 'track=5', '-metadata', 'comment=Fixtureville notes'], (t) => t[125] === 0 && t[126] === 5 && t.includes(Buffer.from('Fixtureville notes'))],
      ]) {
        const tf = path.join(tmp, `v1-${lang.replace(/\W+/g, '')}-${who}.mp3`);
        await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, ...more, '-c:a', 'libmp3lame', '-write_id3v1', '1', tf]);
        const t = (await readFile(tf)).subarray(-128);
        const text = Buffer.from(artist, 'utf8');
        const madeByFfmpeg = t.subarray(0, 3).toString('latin1') === 'TAG' && t.includes(text) && shape(t);
        const bytes = Buffer.from(pb);
        const where = mid.pos + mid.size - 128;
        t.copy(bytes, where);
        const dirsBefore = (await jobDirs()).length;
        const c = await call('/strip-metadata', bytes);
        check(`a ${lang} ID3v1 written by ffmpeg inside a middle frame, ${who} → REFUSED 415 {error: mp3-tag-in-audio, detail: {at: ${where}}}, nothing written`,
          madeByFfmpeg && c.r.statusCode === 415 && JSON.stringify(c.json) === JSON.stringify({ error: 'mp3-tag-in-audio', detail: { at: where } }) && c.uploaded === null && (await jobDirs()).length === dirsBefore,
          `made=${madeByFfmpeg} ${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        const e = await enhanceRefuses(bytes, { error: 'mp3-tag-in-audio', detail: { at: where } });
        check(`...the same through /enhance: 415 mp3-tag-in-audio {at: ${where}}, nothing written`, e === '', e);
        const f = await writeTmp(bytes, '.mp3');
        const walked = await mp3Frames.mp3Leftovers(f);
        await rm(f, { force: true });
        const realSanitize = media.sanitizeMp3;
        media.sanitizeMp3 = async (i, o) => { await copyFile(i, o); return { frames: 0, removed: {} }; };
        let sab;
        try { sab = await call('/strip-metadata', bytes); } finally { media.sanitizeMp3 = realSanitize; }
        check(`...the output walk alone names it (id3v1); with the input rebuild sabotaged, 500 metadata-survived (1 leftover), nothing written`,
          JSON.stringify(walked) === '["id3v1"]' && sab.r.statusCode === 500 && sab.json?.error === 'metadata-survived' && sab.json.detail?.leftovers === 1 && sab.uploaded === null,
          `walked=${JSON.stringify(walked)} ${sab.r.statusCode} ${sab.r.body.slice(0, 120)}`);
        const after = await call('/strip-metadata', Buffer.concat([pb, t]));
        check(`positive control: the same ${lang} ID3v1 after the audio, ${who} → 200, removed, none of its text kept`,
          after.r.statusCode === 200 && exact(after.json) && !after.uploaded.includes(text) && !after.uploaded.includes(Buffer.from(title.slice(1, 4), 'utf8')), `${after.r.statusCode} ${after.r.body.slice(0, 120)}`);
      }
    }
    // the OUTPUT walk stands on its own: with the input rebuild sabotaged into a plain copy, a tag between frames
    // reaches the remux, ffmpeg keeps it, and the output walk refuses — 500 metadata-survived, nothing written
    {
      const plain = path.join(tmp, 'placed-stereo.mp3');
      const pb = await readFile(plain);
      const at = Number((await sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pos', '-of', 'csv=p=0', plain])).trim().split('\n')[20]);
      // (the decoder logs an error at the tag, so the full decode, which would refuse it first, is sabotaged too: it
      // measures 1 s and passes)
      const realSanitize = media.sanitizeMp3, realMeasure = limits.trueDuration;
      media.sanitizeMp3 = async (i, o) => { await copyFile(i, o); return { frames: 0, removed: {} }; };
      limits.trueDuration = async () => ({ audioSec: [1], videoFrames: null, spanSec: 1, over: false, why: [] });
      let c;
      try { c = await call('/strip-metadata', Buffer.concat([pb.subarray(0, at), id3['v2.3'](SECRET), pb.subarray(at)])); } finally { media.sanitizeMp3 = realSanitize; limits.trueDuration = realMeasure; }
      check('with the input rebuild and the decode check sabotaged, the OUTPUT walk refuses: 500 metadata-survived (1 leftover), nothing written (fails if the strict walk is removed)',
        c.r.statusCode === 500 && c.json?.error === 'metadata-survived' && c.json.detail?.leftovers === 1 && c.uploaded === null, `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
    }
    // ...and holds it to ONE stream: 44.1 kHz frames then 48 kHz frames, every byte a frame, is refused by the input
    // rebuild (415 at the first 48 kHz frame) and, with that rebuild sabotaged, by the output walk (the Reviewer's P3 on #4)
    {
      const part = async (rate) => { const f = path.join(tmp, `two-${rate}.mp3`); await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '2', '-ar', String(rate), '-c:a', 'libmp3lame', '-b:a', '128k', '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0', f]); return readFile(f); };
      const first = await part(44100);
      const two = Buffer.concat([first, await part(48000)]);
      const refused = await call('/strip-metadata', two);
      check(`two streams (44.1 kHz then 48 kHz frames): 415 {error: mp3-structure, detail {at: ${first.length}}}, nothing written`,
        refused.r.statusCode === 415 && JSON.stringify(refused.json) === JSON.stringify({ error: 'mp3-structure', detail: { at: first.length } }) && refused.uploaded === null, `${refused.r.statusCode} ${refused.r.body.slice(0, 120)}`);
      // (the full decode logs an error at the rate change and would refuse it first: sabotaged too)
      const realSanitize = media.sanitizeMp3, realMeasure = limits.trueDuration;
      media.sanitizeMp3 = async (i, o) => { await copyFile(i, o); return { frames: 0, removed: {} }; };
      limits.trueDuration = async () => ({ audioSec: [1], videoFrames: null, spanSec: 1, over: false, why: [] });
      let c;
      try { c = await call('/strip-metadata', two); } finally { media.sanitizeMp3 = realSanitize; limits.trueDuration = realMeasure; }
      check('two streams with the input rebuild sabotaged: the OUTPUT walk refuses, 500 metadata-survived (1 leftover), nothing written (fails if the walk accepts a second stream)',
        c.r.statusCode === 500 && c.json?.error === 'metadata-survived' && c.json.detail?.leftovers === 1 && c.uploaded === null, `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
    }
    // the output walk's own edges, on bytes: frames only is clean; one extra zero byte, a cut last frame, a trailing tag are not
    {
      const frames = await readFile(path.join(tmp, 'placed-mono.mp3'));
      const walk = async (buf) => { const f = await writeTmp(buf, '.mp3'); const r = await mp3Frames.mp3Leftovers(f); await rm(f, { force: true }); return JSON.stringify(r); };
      const got = [await walk(frames), await walk(Buffer.concat([frames, Buffer.alloc(1)])), await walk(frames.subarray(0, frames.length - 10)), await walk(Buffer.concat([frames, id3['v2.4 with a footer']('x')])), await walk(Buffer.concat([Buffer.alloc(1), frames]))];
      check('the output walk: frames only → []; +1 zero byte → mp3-unparsed; last frame cut → mp3-short-frame; a v2.4 tag after → id3v2; a zero byte first → mp3-unparsed',
        JSON.stringify(got) === JSON.stringify(['[]', '["mp3-unparsed"]', '["mp3-short-frame"]', '["id3v2"]', '["mp3-unparsed"]']), JSON.stringify(got));
    }
    // exactly ONE cut frame is dropped, whatever its duration, by Sandy's three promises (2026-11-03): no complete frame
    // is ever dropped, no byte of the cut frame survives, at most one frame is trimmed. At 8 kHz a frame is 72 ms, at
    // 44.1 kHz 26 ms. A LATER COMPLETE FRAME inside the cut frame's remains refuses the file (415 mp3-structure, at its
    // header): a header of the file's layer (Layer III, any version, rate, bitrate or channel mode) whose frame fits
    // before the audio's end, confirmed by what follows it after any zero bytes (the end, a frame of any stream, any
    // tag, or the start of either). Astra's VBR case is one: a whole 32 kbps frame inside a cut 320 kbps one; her two
    // on 8e107aec are others (a tag after it; free-format frames, refused wherever they start). A header nothing
    // confirms (by chance in the audio, or a cut frame's start running past the end) is the cut frame's own bytes as
    // far as anything can tell: dropped with it, still less than one frame's length
    const pktsOf = async (f) => (await sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pos,size', '-of', 'csv=p=0', f])).trim().split('\n')
      .map((l) => { const [size, pos] = l.split(',').filter(Boolean).map(Number); return { pos, size }; });
    const countOf = async (f) => Number((await sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', f])).trim());
    // the input rebuild on bytes: { code } or { frames, cutFrame, out } (its output's bytes)
    const rebuild = async (bytes) => {
      const f = await writeTmp(bytes, '.mp3'), o = `${f}.frames`;
      try { const r = await mp3Frames.sanitizeMp3(f, o); return { frames: r.frames, cutFrame: r.removed.cutFrame, out: await readFile(o) }; } catch (e) { return { code: `${e.workerCode} ${JSON.stringify(e.workerDetail)}` }; } finally { await rm(f, { force: true }); await rm(o, { force: true }); }
    };
    for (const [rate, hi, lo, keep, ms, otherRate] of [[8000, '64k', '8k', 200, 72, 12000], [44100, '320k', '32k', 250, 26, 48000]]) {
      const enc = async (br, r = rate) => { const f = path.join(tmp, `vbr-${r}-${br}.mp3`); await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=2:sample_rate=${r}`, '-ar', String(r), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', br, '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0', f]); return f; };
      const hiF = await enc(hi), loF = await enc(lo);
      const hb = await readFile(hiF), hp = await pktsOf(hiF), lp = await pktsOf(loF);
      const last = hp[hp.length - 1], mid = hp[Math.floor(hp.length / 2)];
      const loFrame = (await readFile(loF)).subarray(lp[1].pos, lp[1].pos + lp[1].size);
      const whole = hb.subarray(0, last.pos); // every frame but the last, byte for byte
      const cut = hb.subarray(0, last.pos + keep);
      const sameStream = mp3Frames.frameAt(loFrame).stream === mp3Frames.frameAt(hb.subarray(last.pos)).stream && keep + 2 * loFrame.length < last.size;
      const kept = path.join(tmp, `vbr-${rate}-kept.mp3`);
      await writeFile(kept, whole);
      // trimmed: the rebuild's output byte-equal to the whole frames (N−1, the cut one dropped); through the endpoint
      // 200, exactly N−1 packets, theirs equal, clean frame to frame
      const trimmed = async (label, bytes) => {
        const r = await rebuild(bytes);
        const c = await call('/strip-metadata', bytes);
        const out = c.uploaded && await writeTmp(c.uploaded, '.mp3');
        check(`${rate} Hz, ${label}: trimmed, exactly one frame (${ms} ms): the rebuild byte-equal to the ${hp.length - 1} whole frames; 200, ${hp.length - 1} packets, equal, clean frame to frame`,
          sameStream && r.out?.equals(whole) && r.frames === hp.length - 1 && r.cutFrame === 1
            && c.r.statusCode === 200 && exact(c.json) && (await countOf(out)) === hp.length - 1 && (await packetHash(out)) === (await packetHash(kept)) && (await media.metadataReport(out, 'mp3')).clean,
          `${JSON.stringify({ ...r, out: r.out?.length })} ${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        if (out) await rm(out, { force: true });
      };
      const refused = async (label, bytes, where) => {
        for (const ep of ['/strip-metadata', '/enhance']) {
          const dirsBefore = (await jobDirs()).length;
          const c = await call(ep, bytes, ep === '/enhance' ? { body: { enhancementType: 'clean' } } : {});
          check(`${rate} Hz, ${label}, ${ep} → REFUSED 415 {error: mp3-structure, detail: {at: ${where}}}, nothing written, no temp dir left`,
            sameStream && c.r.statusCode === 415 && JSON.stringify(c.json) === JSON.stringify({ error: 'mp3-structure', detail: { at: where } }) && c.uploaded === null && (await jobDirs()).length === dirsBefore,
            `same=${sameStream} ${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        }
      };
      // a chance header inside the cut frame: the remains with a header written into them, its frame fitting but
      // followed by 0x55 filler (as quiet frames have), or running past the end
      const chance = (at, header, fill) => { const b = Buffer.from(cut); header.copy(b, last.pos + at); if (fill !== undefined) b.fill(0x55, fill, fill + 4); return b; };
      const loHeader = loFrame.subarray(0, 4), hiHeader = hb.subarray(last.pos, last.pos + 4);
      await trimmed(`its last ${hi} frame cut to ${keep} bytes (the positive control)`, cut);
      await trimmed(`a chance ${lo} header inside that cut frame, its frame fitting, then filler (nothing confirms it)`, chance(40, loHeader, last.pos + 40 + loFrame.length));
      await trimmed(`a chance ${hi} header inside that cut frame, its frame running past the end`, chance(keep - 40, hiHeader));
      await trimmed(`a cut ${lo} frame's start inside that cut frame (a cut A and a cut B start, dropped together: ${keep + loFrame.length - 10} bytes, under one ${hi} frame)`, Buffer.concat([cut, loFrame.subarray(0, loFrame.length - 10)]));
      await trimmed(`2 bytes of a ${lo} header ending that cut frame`, Buffer.concat([cut, loFrame.subarray(0, 2)]));
      await refused(`its last ${hi} frame cut, a whole ${lo} frame (${loFrame.length} bytes) after it to the end (Astra's VBR case)`, Buffer.concat([cut, loFrame]), cut.length);
      await refused(`its last ${hi} frame cut, a whole ${lo} frame, then zero bytes to the end`, Buffer.concat([cut, loFrame, Buffer.alloc(20)]), cut.length);
      await refused(`two cut frames: its last ${hi} frame cut, a whole ${lo} frame, then a cut one`, Buffer.concat([cut, loFrame, loFrame.subarray(0, loFrame.length - 10)]), cut.length);
      await refused(`two cut frames: one in the middle (50 bytes short), and the last`, Buffer.concat([hb.subarray(0, mid.pos + mid.size - 50), hb.subarray(mid.pos + mid.size, last.pos + keep)]), mid.pos + mid.size);
      // (the Reviewer's gaps on e485bf92) a complete frame confirmed by ONE byte, 0xFF, at the very end (the next
      // header's first byte): refused, promise 1. Its control: the same with a 0x55 byte instead, nothing confirming it: trimmed
      await refused(`its last ${hi} frame cut, a whole ${lo} frame, then one 0xFF byte ending the audio`, Buffer.concat([cut, loFrame, Buffer.from([0xff])]), cut.length);
      await trimmed(`a whole ${lo} frame inside that cut frame, then one 0x55 byte ending the audio (the 0xFF case's control: nothing confirms it)`, Buffer.concat([cut, loFrame, Buffer.from([0x55])]));
      // ...and a whole frame of ANOTHER stream (${otherRate} Hz, still Layer III) inside the cut frame, to the end: a
      // complete frame all the same (Astra's class on 8e107aec: any version, rate, bitrate or channel mode), refused
      const otherF = await enc('32k', otherRate), op = await pktsOf(otherF);
      const otherFrame = (await readFile(otherF)).subarray(op[1].pos, op[1].pos + op[1].size);
      const otherStream = mp3Frames.frameAt(otherFrame).stream !== mp3Frames.frameAt(hb.subarray(last.pos)).stream && keep + otherFrame.length < last.size;
      check(`${rate} Hz, the ${otherRate} Hz frame is another stream and fits inside the cut ${hi} frame (so the next check proves something)`, otherStream);
      await refused(`its last ${hi} frame cut, a whole ${otherRate} Hz frame (another stream, ${otherFrame.length} bytes) after it to the end`, Buffer.concat([cut, otherFrame]), cut.length);
      // Astra's P2s on 8e107aec, (1): a whole frame, then a tag that real tools write with no footer (so nothing reads it
      // back from the end): the tag confirms the frame. ID3 v2.2, v2.3 and v2.4 without its footer; and after zero bytes
      const v24 = (text) => { const body = Buffer.concat([Buffer.from('TIT2', 'latin1'), syncsafe4(text.length + 1), Buffer.from([0, 0, 3]), Buffer.from(text, 'latin1')]); return Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'latin1'), syncsafe4(body.length), body]); };
      for (const [v, make] of [['v2.2', id3['v2.2']], ['v2.3', id3['v2.3']], ['v2.4 (no footer)', v24]]) {
        await refused(`its last ${hi} frame cut, a whole ${lo} frame, then an ID3 ${v} tag`, Buffer.concat([cut, loFrame, make('x')]), cut.length);
      }
      await refused(`its last ${hi} frame cut, a whole ${lo} frame, 20 zero bytes, then an ID3 v2.3 tag`, Buffer.concat([cut, loFrame, Buffer.alloc(20), id3['v2.3']('x')]), cut.length);
      await refused(`its last ${hi} frame cut, a whole ${lo} frame, then the first 2 bytes of an ID3 header ending the audio`, Buffer.concat([cut, loFrame, Buffer.from('ID', 'latin1')]), cut.length);
      // (2): free-format frames (bitrate index 0: no length in the header to confirm one by): refused wherever one
      // starts. Two of them, as LAME writes them: the ${lo} frame with its bitrate index set to 0
      const free = Buffer.from(loFrame); free[2] &= 0x0f;
      await refused(`its last ${hi} frame cut, then two free-format frames`, Buffer.concat([cut, free, free]), cut.length);
      // the boundary: a Layer II frame (MP2, another codec) isn't looked for: inside the cut frame it is dropped with it.
      // But after a whole Layer III frame it confirms that one (a frame of any stream does)
      const l2h = Buffer.from(loFrame.subarray(0, 4)); l2h[1] = (l2h[1] & 0xf9) | 0x04;
      const layer2 = Buffer.concat([l2h, Buffer.alloc(mp3Frames.frameAt(l2h).len - 4, 0x55)]);
      check(`${rate} Hz, the crafted Layer II frame is one (${layer2.length} bytes) and fits inside the cut ${hi} frame after a whole ${lo} one`, mp3Frames.frameAt(l2h).stream.split('.')[1] === '2' && keep + loFrame.length + layer2.length < last.size);
      await trimmed(`a whole Layer II frame (${layer2.length} bytes, not looked for) inside that cut frame, to the end`, Buffer.concat([cut, layer2]));
      await refused(`its last ${hi} frame cut, a whole ${lo} frame, then a whole Layer II frame`, Buffer.concat([cut, loFrame, layer2]), cut.length);
      // the measured cost of refusing free-format outright: quiet and tonal frames' 0xFF filler holds free-format headers
      // by chance (FF F3 03 at the end of a run, here). This sine's last frame holds one: cut past it, the file is
      // refused, at it. Found by the test's own reading of the bytes (Layer III sync and layer bits, bitrate index 0)
      const ffIII = (b, i) => b[i] === 0xff && (b[i + 1] & 0xe6) === 0xe2 && ((b[i + 1] >> 3) & 3) !== 1 && b[i + 2] >> 4 === 0 && ((b[i + 2] >> 2) & 3) !== 3 && (b[i + 3] & 3) !== 2;
      let ffq = -1;
      for (let q = 1; q + 4 <= last.size && ffq < 0; q++) if (ffIII(hb, last.pos + q)) ffq = q;
      if (rate === 44100) {
        check(`${rate} Hz, the sine's last frame holds a chance free-format header (at ${ffq}), past the positive control's ${keep} bytes`, ffq > keep);
        await refused(`its last ${hi} frame cut to ${ffq + 20} bytes, past a chance free-format header in it`, hb.subarray(0, last.pos + ffq + 20), last.pos + ffq);
      } else check(`${rate} Hz, the sine's last frame holds no free-format header before the positive control's ${keep} bytes`, ffq < 0 || ffq + 4 > keep, `at ${ffq}`);
    }
    // fade-to-silence endings (the Reviewer, 2026-11-03): quiet frames' filler holds headers of the stream by chance
    // (two corpus encodes refused 3.8% and 5.9% of their honest cuts by the rule before this one). Tone bursts fading into
    // digital silence, 44.1 kHz stereo 320 kbps; 300 seeded cuts in the last 40% of its frames. Every one trimmed (the
    // rebuild byte-equal to the whole frames before the cut one), except where the cut frame's remains hold a chance
    // free-format header (the price of refusing free-format outright, Astra's P2 on 8e107aec): refused, at it. Which is
    // which is the test's own reading of the bytes. Both are counted (at least one chance header of the layer, or this
    // proves nothing); three of the trimmed cuts with a chance header through the endpoint too
    {
      const f = path.join(tmp, 'fade.mp3');
      await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=exprs=if(lt(mod(t\\,5)\\,2)\\,0.4*sin(2*PI*460*t)*min(1\\,min(mod(t\\,5)\\,2-mod(t\\,5))*2)\\,0):s=44100:d=30', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '320k', '-write_xing', '0', '-id3v2_version', '0', '-write_id3v1', '0', f]);
      const b = await readFile(f), pk = await pktsOf(f);
      let seed = 53;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
      let wrong = [], chanceMet = 0, freeMet = 0;
      const withChance = [];
      const ffIII = (b, i) => b[i] === 0xff && (b[i + 1] & 0xe6) === 0xe2 && ((b[i + 1] >> 3) & 3) !== 1 && b[i + 2] >> 4 === 0 && ((b[i + 2] >> 2) & 3) !== 3 && (b[i + 3] & 3) !== 2;
      for (let k = 0; k < 300; k++) {
        const i = Math.floor(pk.length * 0.6) + Math.floor(rnd() * (pk.length * 0.4 - 1));
        const { pos, size } = pk[i];
        const x = pos + 1 + Math.floor(rnd() * (size - 1));
        const rest = b.subarray(pos, x);
        let met = false, ff = -1;
        for (let q = 1; q + 4 <= rest.length && !met; q++) if (rest[q] === 0xff && mp3Frames.frameAt(rest.subarray(q, q + 4))?.stream.split('.')[1] === '3') met = true;
        for (let q = 1; q + 4 <= rest.length && ff < 0; q++) if (ffIII(rest, q)) ff = q;
        if (met) chanceMet++;
        if (ff >= 0) freeMet++;
        else if (met && withChance.length < 3) withChance.push([i, x]);
        const r = await rebuild(b.subarray(0, x));
        const right = ff >= 0 ? r.code === `mp3-structure {"at":${pos + ff}}` : r.out?.equals(b.subarray(0, pos)) && r.frames === i && r.cutFrame === 1;
        if (!right) wrong.push(`${i}@${x}: ${r.code ?? r.frames}${ff >= 0 ? ` (free-format at ${pos + ff})` : ''}`);
      }
      check(`fade to silence: 300 cuts, ${chanceMet} of them with a chance Layer III header inside the cut frame, ${freeMet} with a chance free-format one: those ${freeMet} refused at it, the other ${300 - freeMet} trimmed, exactly one frame, the rebuild byte-equal to the whole frames before it`,
        wrong.length === 0 && chanceMet >= 1 && withChance.length >= 1, wrong.slice(0, 4).join(' | '));
      for (const [i, x] of withChance) {
        const c = await call('/strip-metadata', b.subarray(0, x));
        const out = c.uploaded && await writeTmp(c.uploaded, '.mp3');
        check(`...through the endpoint, cut inside frame ${i} (a chance header in it): 200, exactly ${i} packets`, c.r.statusCode === 200 && exact(c.json) && (await countOf(out)) === i, `${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
        if (out) await rm(out, { force: true });
      }
    }
    // generated tails (Astra's P2s on 8e107aec, the class): a stream's whole frames, then its cut last frame, then 0 to 3
    // COMPLETE Layer III frames of mixed versions (MPEG 1, 2, 2.5), rates, bitrates (free-format among them), channel
    // modes, padding and CRC, then optional zero bytes, then optional tags of every kind in a random order (ID3 v2.2,
    // v2.3, v2.4 with and without its footer, ID3v1, APE with and without its header, Lyrics3 v2, Lyrics3 v1 and its
    // ID3v1). All of it inside the cut frame's own length, so the audio ends inside it. Frames are built here, by the
    // test's own tables; their bodies are bytes 0x80–0xFE (no 0xFF, no zero byte, no tag's letters), so the only 0xFF
    // bytes are frame headers. Promise 1: with a complete frame there, refused at the first one (mp3-structure). Promise
    // 2: with none, the rebuild byte-equal to the whole frames before the cut one (no byte of it, or of what followed,
    // kept). Every kind of tag, every version and free-format each turn up in enough tails, or this proves nothing
    {
      // (mulberry32, seeded: the LCG above draws too correlated a mix for this many choices per tail)
      let seed = 4;
      const rnd = () => { let x = (seed = (seed + 0x6d2b79f5) >>> 0); x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32; };
      const pick = (a) => a[Math.floor(rnd() * a.length)];
      const L3 = { 3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
      const HZ = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
      // a Layer III frame: version bits (3 MPEG 1, 2 MPEG 2, 0 MPEG 2.5), rate index, bitrate index (0 free-format, `len` given)
      const frame = ({ ver, sri, bri, pad = 0, crc = false, mode = 0, len }) => {
        const n = bri ? Math.floor(((ver === 3 ? 144 : 72) * L3[ver === 3 ? 3 : 2][bri - 1] * 1000) / HZ[ver][sri]) + pad : len;
        const f = Buffer.alloc(n);
        Buffer.from([0xff, 0xe0 | (ver << 3) | 0x02 | (crc ? 0 : 1), (bri << 4) | (sri << 2) | (pad << 1), mode << 6]).copy(f);
        for (let i = 4; i < n; i++) f[i] = 0x80 + Math.floor(rnd() * 0x7f);
        return f;
      };
      const v24 = (text) => { const body = Buffer.concat([Buffer.from('TIT2', 'latin1'), syncsafe4(text.length + 1), Buffer.from([0, 0, 3]), Buffer.from(text, 'latin1')]); return Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'latin1'), syncsafe4(body.length), body]); };
      const TAGS = {
        'ID3 v2.2': () => id3['v2.2']('Lagos'), 'ID3 v2.3': () => id3['v2.3']('Lagos'), 'ID3 v2.4': () => v24('Lagos'), 'ID3 v2.4 with a footer': () => id3['v2.4 with a footer']('Lagos'),
        ID3v1: () => v1('Lagos'), 'APE (footer only)': () => ape('Lagos'), 'APE with its header': () => apeWithHeader('Lagos'), 'Lyrics3 v2': () => lyrics2('Lagos'),
        'Lyrics3 v1 and its ID3v1': () => Buffer.concat([Buffer.from('LYRICSBEGINLagosLYRICSEND', 'latin1'), v1('Lagos')]),
      };
      // the stream: MPEG 1 at 32 kHz, MPEG 2 at 16 kHz, MPEG 2.5 at 8 kHz; its cut frame at 320 / 160 kbps (1440, 720, 1440 bytes)
      const bases = [{ ver: 3, sri: 2, bri: 14 }, { ver: 2, sri: 2, bri: 14 }, { ver: 0, sri: 2, bri: 14 }];
      const seen = { trimmed: 0, refused: 0, free: 0, versions: new Set(), tags: Object.fromEntries(Object.keys(TAGS).map((k) => [k, 0])), zeros: 0 };
      const wrong = [];
      for (let t = 0; t < 900; t++) {
        const base = bases[t % 3];
        const whole = Buffer.concat(Array.from({ length: 4 }, () => frame({ ver: base.ver, sri: base.sri, bri: 1 + Math.floor(rnd() * 14), pad: rnd() < 0.5 ? 1 : 0, mode: Math.floor(rnd() * 4) })));
        const cutFrame = frame({ ...base, mode: Math.floor(rnd() * 4) });
        const tags = Object.keys(TAGS).filter(() => rnd() < 0.25).sort(() => rnd() - 0.5);
        const tagBytes = Buffer.concat(tags.map((k) => TAGS[k]()));
        const zeros = Buffer.alloc(rnd() < 0.3 ? 1 + Math.floor(rnd() * 24) : 0);
        let room = cutFrame.length - 1 - tagBytes.length - zeros.length; // what the tail may take, the audio ending inside the cut frame
        const k = Math.floor(rnd() * Math.min(300, Math.max(0, room - 4)));
        room -= 4 + k;
        const complete = [];
        for (let want = Math.floor(rnd() * 4), tries = 0; complete.length < want && tries < 40; tries++) {
          const ver = pick([3, 2, 0]), free = rnd() < 0.2;
          const f = frame({ ver, sri: Math.floor(rnd() * 3), bri: free ? 0 : 1 + Math.floor(rnd() * 14), pad: rnd() < 0.5 ? 1 : 0, crc: rnd() < 0.3, mode: Math.floor(rnd() * 4), len: 40 + Math.floor(rnd() * 160) });
          if (f.length <= room) { complete.push({ f, ver, free }); room -= f.length; }
        }
        if (room < 0) continue;
        const cutAt = whole.length, firstAt = cutAt + 4 + k;
        const bytes = Buffer.concat([whole, cutFrame.subarray(0, 4 + k), ...complete.map((c) => c.f), zeros, tagBytes]);
        const r = await rebuild(bytes);
        if (complete.length) {
          seen.refused++;
          if (complete[0].free) seen.free++;
          complete.forEach((c) => seen.versions.add(c.ver));
          if (r.code !== `mp3-structure {"at":${firstAt}}`) wrong.push(`#${t} ${complete.length} complete (first ${complete[0].free ? 'free-format' : 'measured'}) at ${firstAt}: ${r.code ?? `trimmed, ${r.frames} frames`}`);
        } else {
          seen.trimmed++;
          if (!(r.out?.equals(whole) && r.frames === 4 && r.cutFrame === 1)) wrong.push(`#${t} no complete frame: ${r.code ?? `${r.frames} frames, ${r.out?.length} bytes`}`);
        }
        tags.forEach((k2) => seen.tags[k2]++);
        if (zeros.length) seen.zeros++;
      }
      const enough = seen.trimmed >= 100 && seen.refused >= 300 && seen.free >= 30 && seen.versions.size === 3 && seen.zeros >= 100 && Object.values(seen.tags).every((n) => n >= 100);
      check(`generated tails, ${seen.trimmed + seen.refused}: ${seen.refused} with 1–3 complete frames after the cut one (${seen.free} free-format first; MPEG ${[...seen.versions].map((v) => ({ 3: '1', 2: '2', 0: '2.5' })[v]).join(', ')}), each refused at the first; ${seen.trimmed} with none, each trimmed byte-equal to the whole frames before it. Tags per kind: ${Object.entries(seen.tags).map(([k2, n]) => `${k2} ${n}`).join(', ')}; zero bytes in ${seen.zeros}`,
        wrong.length === 0 && enough, `${wrong.length} wrong: ${wrong.slice(0, 4).join(' | ')}${enough ? '' : ' (and too few of some kind)'}`);
    }
    // near misses from real audio (Sandy's 94-minute set, 2026-11-01, refused at byte 45,522,714 by this check's
    // first version): quiet frames are mostly zero bytes, so a chance "ID3" there reads as a well-formed EMPTY tag.
    // Each written over a middle frame's end: accepted by the input rebuild and clean to the output walk. Then the
    // shapes that count: refused. An ID3v1 counts by rule A (Sandy, 2026-11-01): every text field printable ASCII or
    // Latin-1, or NUL, at any length and empty included; so a "TAG" counts unless a byte in its text fields is a
    // control character
    {
      const plainM = path.join(tmp, 'placed-mono.mp3');
      const pm = await readFile(plainM);
      const pk = (await sh('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pos,size', '-of', 'csv=p=0', plainM])).trim().split('\n')
        .map((l) => { const [size, pos] = l.split(',').filter(Boolean).map(Number); return { pos, size }; });
      const mid = pk[Math.floor(pk.length / 2)];
      const over = (t) => { const b = Buffer.from(pm); t.copy(b, mid.pos + mid.size - t.length); return b; };
      const pad = (head, n = 128) => Buffer.concat([head, Buffer.alloc(n - head.length)]);
      const twice = async (bytes) => {
        const f = await writeTmp(bytes, '.mp3'), o = `${f}.frames`;
        let got;
        try { await mp3Frames.sanitizeMp3(f, o); got = JSON.stringify(await mp3Frames.mp3Leftovers(o)); } catch (e) { got = `${e.workerCode} ${JSON.stringify(e.workerDetail)}`; }
        await rm(f, { force: true }); await rm(o, { force: true });
        return got;
      };
      const misses = [
        ['TAG, a title with a control byte (0x01) in it, zeros', pad(Buffer.from('TAGTrack\x011', 'latin1'))],
        ['TAG, an album with a C1 byte (0x85) in it, zeros', pad(Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.alloc(60), Buffer.from([0x41, 0x85])]))],
        ['TAG, a comment with DEL (0x7f) in it, zeros', pad(Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.alloc(94), Buffer.from([0x7f])]))],
        ['TAG, a title with a lone UTF-8 continuation byte (A, 0x80)', pad(Buffer.from('TAGA\x80', 'latin1'))],
        ['TAG, a title with an encoded surrogate (ED A0 80, not UTF-8)', pad(Buffer.from('544147eda080', 'hex'))],
        ['TAG, a title with UTF-8 for a C1 control (C2 85)', pad(Buffer.from('544147c285', 'hex'))],
        ['TAG, a title with a 3-byte overlong (E0 82 A0, U+00A0 written long: not UTF-8; 0x82 isn\'t Latin-1)', pad(Buffer.from('544147e082a0', 'hex'))],
        ['TAG, a title with a lead byte then a non-continuation byte (E3 41 42), and ぁ (E3 81 81, so not Latin-1)', pad(Buffer.from('544147e34142e38181', 'hex'))],
        ['TAG, a v1.1 comment that isn\'t text (0x01 in it), a NUL and track 5', pad(Buffer.concat([Buffer.from('TAGFixtureville', 'latin1'), Buffer.alloc(82), Buffer.from('notes\x01', 'latin1'), Buffer.alloc(22), Buffer.from([0, 5])]))],
        ['ID3 v2.3 of size 0, then zeros', pad(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'))],
        ['ID3 v2.4 whose body is zeros (padding only)', pad(Buffer.concat([Buffer.from('ID3\x04\x00\x00', 'latin1'), Buffer.from([0, 0, 0, 60])]))],
      ];
      const got = [];
      for (const [, t] of misses) got.push(await twice(over(t)));
      check(`near misses, ${misses.length} (${misses.map(([l]) => l).join('; ')}): each accepted by the input rebuild and clean to the output walk`, got.every((g) => g === '[]'), JSON.stringify(got));
      const counting = [
        ['Sandy\'s set\'s own bytes: TAG ßG}2oô, then zeros (rule A refuses that file)', pad(Buffer.from('544147df477d326ff4', 'hex')), 'id3v1'],
        ['TAG with a five-character title ("Lagos")', pad(Buffer.from('TAGLagos', 'latin1')), 'id3v1'],
        ['TAG with a non-ASCII Latin-1 title ("Café Ñandú")', pad(Buffer.from('TAGCafé Ñandú', 'latin1')), 'id3v1'],
        ['TAG with a UTF-8 title ("東京", "Москва"), a C1-range continuation byte in it', pad(Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.from('東京 Москва', 'utf8')])), 'id3v1'],
        ['TAG with a UTF-8 title cut mid-character by a NUL', pad(Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.from('東京', 'utf8').subarray(0, 5)])), 'id3v1'],
        ['TAG with a title E0 A0 80 (U+0800, the smallest 3-byte character: the overlong near miss\'s partner)', pad(Buffer.from('544147e0a080', 'hex')), 'id3v1'],
        ['TAG with a title E3 81 82 E3 81 81 (あぁ: the bad-continuation near miss\'s partner)', pad(Buffer.from('544147e38182e38181', 'hex')), 'id3v1'],
        ['TAG v1.1, a text comment, a NUL and track 5 (the non-text comment\'s partner)', pad(Buffer.concat([Buffer.from('TAGFixtureville', 'latin1'), Buffer.alloc(82), Buffer.from('notes', 'latin1'), Buffer.alloc(23), Buffer.from([0, 5])])), 'id3v1'],
        ['TAG with every text field empty (her refinement, measured and not kept)', pad(Buffer.from('TAG', 'latin1')), 'id3v1'],
        ['TAG with a shortened title (its text, a NUL, the old text\'s tail)', pad(Buffer.from('TAGLagos\x00Fixtureville', 'latin1')), 'id3v1'],
        ['TAG with a title of 8 letters and digits ("Track 123")', pad(Buffer.from('TAGTrack 123', 'latin1')), 'id3v1'],
        ['ID3 v2.3 with a TIT2 frame', id3['v2.3']('x'), 'id3v2'],
      ];
      for (const [label, t, named] of counting) {
        const where = mid.pos + mid.size - t.length;
        check(`...counting: ${label} → refused at ${where} (mp3-tag-in-audio), the output walk names it (${named})`,
          (await twice(over(t))) === `mp3-tag-in-audio {"at":${where}}` && JSON.stringify(await (async () => { const f = await writeTmp(over(t), '.mp3'); const r = await mp3Frames.mp3Leftovers(f); await rm(f, { force: true }); return r; })()) === JSON.stringify([named]));
      }
      const nick = await call('/strip-metadata', over(counting[0][1]));
      const where = mid.pos + mid.size - 128;
      check(`...and Sandy's set's bytes through the endpoint: 415 {error: mp3-tag-in-audio, detail: {at: ${where}}}, nothing written`,
        nick.r.statusCode === 415 && JSON.stringify(nick.json) === JSON.stringify({ error: 'mp3-tag-in-audio', detail: { at: where } }) && nick.uploaded === null, `${nick.r.statusCode} ${nick.r.body.slice(0, 120)}`);
    }
    // false refusals (the Reviewer, 2026-11-01): compressed audio is close to random bytes, so "TAG" and "ID3" turn up
    // inside real frames by chance (about once per 16 MB each). A corpus of clean encodes, noise and tone, mono and
    // stereo, 32 to 48 kHz, CBR 32k–320k and VBR: every one accepted by the input rebuild and clean to the output walk,
    // and through the endpoint for a sample of them. The signatures that DO turn up in it are counted, so it's the
    // validation that lets them through, not luck (a "TAG"-alone ID3v1 fails here).
    {
      const count = (b, m) => { let n = 0; for (let i = b.indexOf(m); i >= 0; i = b.indexOf(m, i + 1)) n++; return n; };
      let files = 0, bytes = 0, rawTag = 0, rawId3 = 0, through = 0;
      const refused = [];
      // noise and tone throughout, at every rate and mode; and (as real music has, and the noise never does) quiet:
      // tone bursts with fades into digital silence, at the common rates
      const cases = [];
      for (const rate of [32000, 44100, 48000]) for (const ch of [1, 2]) for (const mode of [['-b:a', '32k'], ['-b:a', '64k'], ['-b:a', '128k'], ['-b:a', '192k'], ['-b:a', '256k'], ['-b:a', '320k'], ['-q:a', '0'], ['-q:a', '5']]) cases.push([rate, ch, mode, false]);
      for (const rate of [44100, 48000]) for (const ch of [1, 2]) for (const mode of [['-b:a', '128k'], ['-b:a', '320k'], ['-q:a', '0']]) cases.push([rate, ch, mode, true]);
      for (const [rate, ch, mode, quiet] of cases) {
        {
          {
            const seed = ++files;
            const f = path.join(tmp, `corpus-${seed}.mp3`), o = `${f}.frames`;
            const source = quiet
              ? ['-f', 'lavfi', '-i', `aevalsrc=exprs=if(lt(mod(t\\,5)\\,2)\\,0.4*sin(2*PI*${220 + 30 * (seed % 9)}*t)*min(1\\,min(mod(t\\,5)\\,2-mod(t\\,5))*2)\\,0):s=${rate}:d=150`]
              : ['-f', 'lavfi', '-i', `anoisesrc=d=150:c=${seed % 2 ? 'pink' : 'white'}:a=0.25:seed=${seed}:r=${rate}`, '-f', 'lavfi', '-i', `sine=frequency=${220 + 55 * (seed % 7)}:duration=150:sample_rate=${rate}`, '-filter_complex', '[0][1]amix=inputs=2'];
            await sh('ffmpeg', ['-v', 'error', ...source, '-ac', String(ch), '-ar', String(rate), '-c:a', 'libmp3lame', ...mode, '-id3v2_version', '0', '-write_id3v1', '0', f]);
            const b = await readFile(f);
            bytes += b.length; rawTag += count(b, Buffer.from('TAG')); rawId3 += count(b, Buffer.from('ID3'));
            try {
              await mp3Frames.sanitizeMp3(f, o);
              const left = await mp3Frames.mp3Leftovers(o);
              if (left.length) refused.push(`${path.basename(f)}: output walk ${left}`);
            } catch (e) { refused.push(`${path.basename(f)}: ${e.workerCode} ${JSON.stringify(e.workerDetail)}`); }
            if (seed % 6 === 0) {
              const c = await call('/strip-metadata', b);
              if (c.r.statusCode === 200 && exact(c.json)) through++; else refused.push(`${path.basename(f)}: endpoint ${c.r.statusCode} ${c.r.body.slice(0, 80)}`);
            }
            await rm(f, { force: true }); await rm(o, { force: true });
          }
        }
      }
      check(`no false refusals: ${files} clean encodes (${(bytes / 1e6).toFixed(1)} MB, ${cases.filter((c) => c[3]).length} of them with fades into silence) all accepted by the input rebuild and clean to the output walk, ${through} of them 200 through the endpoint; the validation ignored ${rawTag} raw "TAG" and ${rawId3} raw "ID3" inside their frames (at least one of each, or this proves nothing)`,
        files >= 40 && refused.length === 0 && through === Math.floor(files / 6) && rawTag >= 1 && rawId3 >= 1, refused.slice(0, 5).join(' | '));
    }
  }
  {
    // Ogg/Opus whose comment-header vendor is free text (same length as "ffmpeg", so the file stays valid)
    const f = path.join(tmp, 'vendor.ogg');
    await sh('ffmpeg', [...tone, '-c:a', 'libopus', f]);
    const buf = await readFile(f);
    const at = buf.indexOf(Buffer.from('OpusTags')) + 12;
    if (buf.subarray(at, at + 6).toString() !== 'ffmpeg' && !buf.subarray(at - 4, at + 40).includes(Buffer.from('Lav'))) throw new Error('unexpected Opus vendor in the fixture');
    const vlen = buf.readUInt32LE(at - 4);
    const dirty = Buffer.from(buf); dirty.write('GPS 0.5 0.5 Fixtureville'.padEnd(vlen, '.').slice(0, vlen), at, 'latin1');
    oggFixCrcs(dirty); // keep the pages valid, so the file is read as the real thing
    const df = await writeTmp(dirty, '.ogg');
    const before = await media.metadataReport(df, 'ogg');
    const c = await call('/strip-metadata', dirty);
    const after = c.uploaded && await (async () => { const o = await writeTmp(c.uploaded, '.ogg'); const r = await media.metadataReport(o, 'ogg'); await rm(o, { force: true }); return r; })();
    check('Vorbis-comment vendor off the allowlist: flagged before; 200 — the remux writes the fixed vendor; the free text is gone; PCM identical', before.leftovers.includes('ogg-vendor') && c.r.statusCode === 200 && after?.clean && !c.uploaded.includes(Buffer.from('Fixtureville')) && (await samePcm(df, c.uploaded)), `${JSON.stringify(before.leftovers)} ${c.r.statusCode} ${JSON.stringify(after)}`);
    check('vendor identities are EXACT and anchored — known encoders pass; anything appended, or free text, does not',
      ['ffmpeg', 'Xiph.Org libVorbis I 20200704 (Reducing Environment)', 'Xiph.Org libVorbis I 20200704', 'libopus 1.5.2', 'libopus 1.4', 'Lavf61.7.100', 'Lavc62.28.100 vorbis', 'reference libFLAC 1.4.3 20230623'].every(media.vendorOk)
        && !['GPS 0.5 0.5', 'Xiph.Org libVorbis I 20200704 (lat 51.5)', 'libopus 1.5.2 GPS', 'libopus 1.5.2-gps', 'Lavf61.7.100 x', 'ffmpeg ', ' ffmpeg', 'Lavc62.28.100 vorbis GPS', ''].some(media.vendorOk));
  }
  {
    // WebM with Vorbis: the comment header lives in CodecPrivate, which a remux copies untouched
    const og = path.join(tmp, 'v.ogg'), wm = path.join(tmp, 'vorbis.webm');
    await sh('ffmpeg', [...tone, '-c:a', 'vorbis', '-strict', '-2', '-ac', '2', '-metadata', 'title=Fixtureville', og]);
    await sh('ffmpeg', ['-v', 'error', '-i', og, '-c', 'copy', wm]);
    const okc = await call('/strip-metadata', await readFile(wm));
    check('WebM/Vorbis with an encoder vendor in CodecPrivate: 200, the title (Matroska Tags) gone, PCM identical', okc.r.statusCode === 200 && !okc.uploaded.includes(Buffer.from('Fixtureville')) && (await samePcm(wm, okc.uploaded)), `${okc.r.statusCode} ${okc.r.body.slice(0, 120)}`);
    // the same file with free text in that vendor field (same length — the file stays valid)
    const b = Buffer.from(await readFile(wm));
    const at = b.indexOf(Buffer.from('\x03vorbis', 'latin1')) + 7;
    const vlen = b.readUInt32LE(at);
    b.write('GPS 0.5 0.5 Fixtureville'.padEnd(vlen, '.').slice(0, vlen), at + 4, 'latin1');
    const dirty = await writeTmp(b, '.webm');
    const before = await media.metadataReport(dirty, 'matroska');
    const c = await call('/strip-metadata', b);
    check('WebM/Vorbis whose CodecPrivate vendor is free text: flagged; the remux can\'t change it → REFUSED, nothing written (fail closed)', before.leftovers.includes('mkv-vorbis-vendor') && c.r.statusCode >= 400 && c.uploaded === null, `${JSON.stringify(before.leftovers)} ${c.r.statusCode} ${c.r.body.slice(0, 120)}`);
  }
  {
    // Matroska attachment (the GPS photo) beside the sound
    const mk = path.join(tmp, 'att.mkv');
    await sh('ffmpeg', [...tone, '-c:a', 'libopus', '-attach', FIX('gps-art.jpg'), '-metadata:s:t', 'mimetype=image/jpeg', mk]);
    const before = await media.metadataReport(mk, 'matroska');
    const c = await call('/strip-metadata', await readFile(mk));
    const after = c.uploaded && await (async () => { const o = await writeTmp(c.uploaded, '.webm'); const r = await media.metadataReport(o, 'matroska'); await rm(o, { force: true }); return r; })();
    check('a Matroska attachment (a GPS photo): present before; 200, dropped (no attachment, no EXIF bytes); PCM identical', before.leftovers.includes('mkv-attachments') && before.otherStreams > 0 && c.r.statusCode === 200 && after?.clean && !c.uploaded.includes(Buffer.from('Exif\0\0', 'latin1')) && (await samePcm(mk, c.uploaded)), `${JSON.stringify(before)} ${c.r.statusCode} ${JSON.stringify(after)}`);
  }
  {
    // H.264 / HEVC SEI (Astra's 2nd round): every type-5 message goes; per NAL
    const plain = path.join(tmp, 'sei-plain.mp4'), ud = path.join(tmp, 'sei-ud.mp4'), orient = path.join(tmp, 'sei-orient.mp4'), hevc = path.join(tmp, 'sei.hevc.mp4');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10', '-f', 'lavfi', '-i', 'sine=duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', plain]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', plain, '-c', 'copy', '-bsf:v', 'h264_metadata=sei_user_data=086f3693-b7b3-4f2c-9653-21492feee5b8+GPS 0.5 0.5 Fixtureville', ud]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', ud, '-c', 'copy', '-bsf:v', 'h264_metadata=display_orientation=insert:rotate=90', orient]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=none', hevc]);
    const inUd = await sei.seiReport(ud, 'h264', tmp);
    const c = await call('/strip-metadata', await readFile(ud));
    const out = c.uploaded && await writeTmp(c.uploaded, '.mp4');
    const outSei = out && await sei.seiReport(out, 'h264', tmp);
    check('H.264 user-data SEI ("GPS … Fixtureville" + x264\'s settings): found before; 200, NEUTRALIZED in place — the re-scan finds no private message; frames and PCM IDENTICAL',
      inUd.private === 2 && c.r.statusCode === 200 && outSei?.private === 0 && !c.uploaded.includes(Buffer.from('Fixtureville')) && !c.uploaded.includes(Buffer.from('x264 - core')) && (await frameHash(ud)) === (await frameHash(out)) && (await pcmHash(ud)) === (await pcmHash(out)),
      `${JSON.stringify(inUd)} ${c.r.statusCode} ${c.r.body.slice(0, 100)} ${JSON.stringify(outSei)}`);
    if (out) await rm(out, { force: true });
    const cp = await call('/strip-metadata', await readFile(plain));
    const pOut = cp.uploaded && await writeTmp(cp.uploaded, '.mp4');
    check('x264\'s own settings string is removed too (no allowlist): 200, no private message left, frames identical', cp.r.statusCode === 200 && (await sei.seiReport(pOut, 'h264', tmp)).private === 0 && !cp.uploaded.includes(Buffer.from('x264 - core')) && (await frameHash(plain)) === (await frameHash(pOut)), `${cp.r.statusCode} ${cp.r.body.slice(0, 100)}`);
    if (pOut) await rm(pOut, { force: true });
    // the independent output re-scan is what stops a miss: sabotage the neutralizer into a no-op
    const realNeutralize = sei.neutralizeSeiInIso;
    sei.neutralizeSeiInIso = async () => ({ neutralized: 0, refused: null });
    let sab;
    try { sab = await call('/strip-metadata', await readFile(ud)); } finally { sei.neutralizeSeiInIso = realNeutralize; }
    check('with the neutralizer sabotaged, the OUTPUT re-scan refuses: 500 private-sei-survived, nothing written (fails if verifySei is removed)', sab.r.statusCode === 500 && sab.uploaded === null && sab.json?.error === 'private-sei-survived', `${sab.r.statusCode} ${sab.r.body.slice(0, 120)}`);
    const co = await call('/strip-metadata', await readFile(orient));
    check('private data in the SAME SEI NAL as picture-relevant SEI (display orientation) → REFUSED (415), nothing written', co.r.statusCode === 415 && co.uploaded === null, `${co.r.statusCode} ${co.r.body.slice(0, 120)}`);
    const ch = await call('/strip-metadata', await readFile(hevc));
    const hOut = ch.uploaded && await writeTmp(ch.uploaded, '.mp4');
    check('HEVC (x265 writes its own settings SEI): 200, no private message left, frames identical', ch.r.statusCode === 200 && (await sei.seiReport(hOut, 'hevc', tmp)).private === 0 && (await frameHash(hevc)) === (await frameHash(hOut)), `${ch.r.statusCode} ${ch.r.body.slice(0, 120)}`);
    if (hOut) await rm(hOut, { force: true });
    // T.35 (type 4), end to end: the injected payload's type byte 5 → 4 (a T.35 payload that is NOT HDR10+)
    const udBuf = Buffer.from(await readFile(ud));
    const uuidAt = udBuf.indexOf(Buffer.from('086f3693b7b34f2c965321492feee5b8', 'hex'));
    if (uuidAt < 2 || udBuf[uuidAt - 2] !== 5) throw new Error('fixture: payload type byte not where expected');
    udBuf[uuidAt - 2] = 4;
    const t35 = await writeTmp(udBuf, '.mp4');
    const t35In = await sei.seiReport(t35, 'h264', tmp);
    const ct = await call('/strip-metadata', udBuf);
    const tOut = ct.uploaded && await writeTmp(ct.uploaded, '.mp4');
    check('a T.35 (type 4) payload that is not HDR10+: counted private; 200, neutralized; no private message left', t35In.types['4'] === 1 && t35In.private === 2 && ct.r.statusCode === 200 && (await sei.seiReport(tOut, 'h264', tmp)).private === 0 && !ct.uploaded.includes(Buffer.from('Fixtureville')), `${JSON.stringify(t35In)} ${ct.r.statusCode} ${ct.r.body.slice(0, 100)}`);
    if (tOut) await rm(tOut, { force: true });
  }
  {
    // the per-NAL policy, by structure (unit level): HDR10+ kept; captions / other T.35 private; sharing → refused
    const escape = (b) => { const o = []; let z = 0; for (const x of b) { if (z >= 2 && x <= 3) { o.push(3); z = 0; } o.push(x); z = x === 0 ? z + 1 : 0; } return Buffer.from(o); };
    const sei1 = (msgs) => { const parts = []; for (const [t, p] of msgs) parts.push(Buffer.from([t, p.length]), p); parts.push(Buffer.from([0x80])); return Buffer.concat([Buffer.from([0x06]), escape(Buffer.concat(parts))]); };
    const hdr10p = await hdr10PlusFromFixture();
    const captions = Buffer.concat([Buffer.from([0xb5, 0x00, 0x31]), Buffer.from('GA94'), Buffer.from([0x03, 0x40, 0x00])]);
    const ud5 = Buffer.concat([Buffer.alloc(16, 7), Buffer.from('GPS')]);
    const v = (msgs) => sei.nalVerdict(sei1(msgs), 'h264').verdict;
    check('per NAL, CLOSED: HDR10+ alone → keep · captions (T.35 GA94) alone → neutralize · user data + filler → neutralize · user data + buffering period → REFUSE · user data + picture_timing → REFUSE · user data + recovery point → REFUSE · user data + HDR10+ → REFUSE · captions + mastering display → REFUSE · user data + an unknown type (200) → REFUSE · timing alone → keep',
      v([[4, hdr10p]]) === 'keep' && v([[4, captions]]) === 'neutralize' && v([[5, ud5], [3, Buffer.from([0xff, 0xff])]]) === 'neutralize' && v([[5, ud5], [0, Buffer.from([0x80])]]) === 'refuse'
        && v([[5, ud5], [1, Buffer.from([0x10])]]) === 'refuse' && v([[5, ud5], [6, Buffer.from([0x84])]]) === 'refuse' && v([[5, ud5], [4, hdr10p]]) === 'refuse'
        && v([[4, captions], [137, Buffer.alloc(24)]]) === 'refuse' && v([[5, ud5], [200, Buffer.from([1])]]) === 'refuse' && v([[1, Buffer.from([0x10])]]) === 'keep');
    // P3: the WHOLE structure is parsed, nothing after it (the payload is x265's own, which ffmpeg reads as SMPTE 2094-40)
    const flipLast = Buffer.from(hdr10p); flipLast[flipLast.length - 1] ^= 1;
    check('HDR10+ = the whole ST 2094-40 structure: x265\'s real payload passes; one trailing byte (even 0x00), trailing text, one byte short, a wrong header, zero windows, or a flipped final bit → NOT HDR10+',
      sei.isHdr10Plus(hdr10p) && !sei.isHdr10Plus(Buffer.concat([hdr10p, Buffer.from([0])])) && !sei.isHdr10Plus(Buffer.concat([hdr10p, Buffer.from('GPS')])) && !sei.isHdr10Plus(hdr10p.subarray(0, -1))
        && !sei.isHdr10Plus(Buffer.concat([Buffer.from([0xb5, 0x00, 0x3c, 0x00, 0x01, 0x05]), hdr10p.subarray(6)])) && !sei.isHdr10Plus(Buffer.concat([hdr10p.subarray(0, 7), Buffer.from([hdr10p[7] & 0x3f]), hdr10p.subarray(8)])) && !sei.isHdr10Plus(flipLast) && !sei.isHdr10Plus(captions),
      `len ${hdr10p.length}`);
  }
  {
    // 1 — presentation flags survive; private data beside picture_timing is refused
    const ps = path.join(tmp, 'ps.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-flags', '+ilme+ildct', '-x264-params', 'tff=1:pic-struct=1', ps]);
    // the three presentation fields only (csv would also print a frame's side data — e.g. the very user data removed)
    const flags = async (f) => JSON.stringify(JSON.parse(await sh('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=interlaced_frame,top_field_first,repeat_pict', '-of', 'json', f])).frames.map((x) => [x.interlaced_frame, x.top_field_first, x.repeat_pict]));
    const traced = async (f) => { const o = await new Promise((res) => execFile('ffmpeg', ['-nostdin', '-v', 'trace', '-i', f, '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { maxBuffer: 64 << 20 }, (e, so, se) => res(se))); return (o.match(/\b(pic_struct|ct_type|nuit_field_based_flag|counting_type|full_timestamp_flag)\s+\S+\s*=\s*\d+/g) || []).join('|'); };
    const psIn = await sei.seiReport(ps, 'h264', tmp);
    const c = await call('/strip-metadata', await readFile(ps));
    const out = c.uploaded && await writeTmp(c.uploaded, '.mp4');
    const [fIn, fOut, tIn, tOut] = out ? await Promise.all([flags(ps), flags(out), traced(ps), traced(out)]) : [];
    const psOut = out && await sei.seiReport(out, 'h264', tmp);
    check(`interlaced x264 with picture_timing in EVERY frame (${psIn.types['1']} messages, their own NALs) + x264's user data in a NAL of its own: 200; private gone; every picture_timing message and every frame's presentation flags (interlaced, top_field_first, repeat_pict) IDENTICAL`,
      psIn.types['1'] === 50 && c.r.statusCode === 200 && psOut?.private === 0 && psOut?.types['1'] === 50 && !!fIn && fIn === fOut && /pic_struct/.test(tIn) && tIn === tOut && (await frameHash(ps)) === (await frameHash(out)),
      `${c.r.statusCode} ${c.r.body.slice(0, 100)} ${JSON.stringify(psOut)} flags ${fIn === fOut} timing ${tIn === tOut} ${tIn.slice(0, 60)}`);
    if (out) await rm(out, { force: true });
    // the mixed NAL, built by hand: a user-data message put INTO the first picture_timing SEI NAL
    const es = path.join(tmp, 'ps.h264');
    await sh('ffmpeg', ['-v', 'error', '-i', ps, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', es]);
    const raw = await readFile(es);
    let at = -1;
    for (let i = 0; i + 5 < raw.length; i++) if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1 && (raw[i + 3] & 0x1f) === 6 && raw[i + 4] === 1) { at = i + 4; break; } // SEI NAL whose first message is type 1
    if (at < 0) throw new Error('fixture: no picture_timing SEI NAL');
    const udMsg = Buffer.concat([Buffer.from([5, 16 + 20]), Buffer.from('086f3693b7b34f2c965321492feee5b8', 'hex'), Buffer.from('GPS 0.5 Fixtureville')]);
    const mixedEs = path.join(tmp, 'mixed.h264'), mixed = path.join(tmp, 'mixed.mp4');
    await writeFile(mixedEs, Buffer.concat([raw.subarray(0, at), udMsg, raw.subarray(at)]));
    await sh('ffmpeg', ['-v', 'error', '-framerate', '25', '-f', 'h264', '-i', mixedEs, '-c', 'copy', mixed]);
    const mIn = await sei.seiReport(mixed, 'h264', tmp);
    const cm = await call('/strip-metadata', await readFile(mixed));
    check('private user data in the SAME SEI NAL as picture_timing → REFUSED (415), nothing written', mIn.refuseNals === 1 && cm.r.statusCode === 415 && cm.uploaded === null && cm.json?.error === 'private-sei-refused', `${JSON.stringify(mIn)} ${cm.r.statusCode} ${cm.r.body.slice(0, 120)}`);
    // HDR10+ (x265's own, read by ffmpeg as SMPTE 2094-40): kept; x265's private settings message gone
    const ch = await call('/strip-metadata', await readFile(FIX('hdr.mp4')));
    const hOut = ch.uploaded && await writeTmp(ch.uploaded, '.mp4');
    const side = hOut && (await sh('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_frames', hOut])).match(/HDR Dynamic Metadata SMPTE2094-40/g)?.length;
    check('HDR10+ video (x265): 200; the HDR10+ metadata survives on every frame (2 of 2); no private message left; frames identical', ch.r.statusCode === 200 && side === 2 && (await sei.seiReport(hOut, 'hevc', tmp)).private === 0 && (await frameHash(FIX('hdr.mp4'))) === (await frameHash(hOut)), `${ch.r.statusCode} ${ch.r.body.slice(0, 100)} side ${side}`);
    if (hOut) await rm(hOut, { force: true });
  }
  {
    // 2 — TRUE length, by counting, on every path; timestamps and declared durations are never trusted
    const squeezedAudio = path.join(tmp, 'squeezed.webm'), squeezedVideo = path.join(tmp, 'squeezed.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=30', '-af', 'asetpts=PTS/10', '-c:a', 'libopus', squeezedAudio]);
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=60:size=64x48:rate=30', '-vf', 'setpts=PTS/10', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', squeezedVideo]);
    const declared = async (f) => Number((await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim());
    const [dA, dV] = [await declared(squeezedAudio), await declared(squeezedVideo)];
    const withEnv = async (k, v, fn) => { process.env[k] = v; try { return await fn(); } finally { delete process.env[k]; } };
    const e1 = await withEnv('ENHANCE_MAX_DURATION_SEC', '10', () => call('/enhance', fs.readFileSync(squeezedAudio), { body: { enhancementType: 'clean' } }));
    check(`enhance: 30 s of audio with timestamps squeezed ×10 (declares ${dA.toFixed(1)} s), cap 10 s → 413 measured by SAMPLES (~11 s counted, then stopped)`, dA < 4 && e1.r.statusCode === 413 && e1.json?.error === 'duration-over-cap' && e1.json.detail.audioSec >= 10 && e1.json.detail.audioSec < 12 && e1.json.detail.frames === undefined && e1.uploaded === null, `${e1.r.statusCode} ${e1.r.body.slice(0, 140)}`);
    const s1 = await withEnv('STRIP_MAX_DURATION_SEC', '10', () => call('/strip-metadata', fs.readFileSync(squeezedAudio)));
    check('strip: the same squeezed audio, cap 10 s → 413 measured by samples', s1.r.statusCode === 413 && s1.json?.error === 'duration-over-cap' && s1.json.detail.audioSec > 10 && s1.uploaded === null, `${s1.r.statusCode} ${s1.r.body.slice(0, 140)}`);
    const t1 = await withEnv('TRANSCODE_MAX_DURATION_SEC', '20', () => call('/transcode-video', fs.readFileSync(squeezedVideo)));
    check(`transcode: 1800 frames with timestamps squeezed ×10 (declares ${dV.toFixed(1)} s), cap 20 s → 413 by FRAME COUNT (budget 20 × 60)`, dV < 7 && t1.r.statusCode === 413 && t1.json?.error === 'duration-over-cap' && t1.json.detail.frames >= 1000 && t1.uploaded === null, `${t1.r.statusCode} ${t1.r.body.slice(0, 140)}`);
    // 601 s, duration-less live WebM (ordinary MediaRecorder output) through transcode — with audio, and picture-only
    const live = path.join(tmp, 'live601.webm'), liveV = path.join(tmp, 'live601v.webm');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=601:size=32x32:rate=5', '-f', 'lavfi', '-i', 'sine=duration=601', '-c:v', 'libvpx', '-b:v', '20k', '-c:a', 'libopus', '-b:a', '16k', '-live', '1', '-f', 'webm', live]);
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=601:size=32x32:rate=5', '-c:v', 'libvpx', '-b:v', '20k', '-live', '1', '-f', 'webm', liveV]);
    const noDur = async (f) => { const d = (await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim(); return d === '' || d === 'N/A'; };
    const t2 = await call('/transcode-video', fs.readFileSync(live), { type: 'video/webm' });
    check('transcode: a 601 s live WebM with NO declared duration (video + audio), cap 600 s → 413 — over by samples AND by timestamp span, nothing written', (await noDur(live)) && t2.r.statusCode === 413 && t2.json?.error === 'duration-over-cap' && t2.json.detail.audioSec >= 601 && t2.json.detail.audioSec < 603 && t2.json.detail.spanSec >= 601 && t2.json.detail.spanSec < 602 && t2.uploaded === null, `${t2.r.statusCode} ${t2.r.body.slice(0, 140)}`);
    const t3 = await call('/transcode-video', fs.readFileSync(liveV), { type: 'video/webm' });
    check('transcode: a picture-only 5-fps live WebM, 601 s with NO declared duration (3005 frames — far under the frame budget) → 413 BEFORE any transcoding, by its timestamp span; nothing written', (await noDur(liveV)) && t3.r.statusCode === 413 && t3.json?.error === 'duration-over-cap' && t3.json.detail.spanSec >= 601 && t3.json.detail.spanSec < 602 && t3.json.detail.audioSec === undefined && t3.json.detail.frames === undefined && t3.uploaded === null, `${t3.r.statusCode} ${t3.r.body.slice(0, 140)}`);
    // strip: hard byte limit (-fs) and exact packet counts
    const song = path.join(tmp, 'song.mp3');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=30', '-c:a', 'libmp3lame', '-b:a', '128k', song]);
    const s2 = await withEnv('STRIP_MAX_OUTPUT_BYTES', '100000', () => call('/strip-metadata', fs.readFileSync(song)));
    const stopped = s2.json?.error === 'output-over-cap' ? s2.json.detail?.bytes : NaN;
    check(`strip: output over its byte cap (30 s mp3 ≈ 480 KB, cap 100 KB) → 413, -fs STOPPED it at ${stopped} bytes (≤ cap + 64 KB; fails if -fs is removed)`, s2.r.statusCode === 413 && stopped >= 100000 && stopped <= 100000 + 65536 && s2.uploaded === null, `${s2.r.statusCode} ${s2.r.body.slice(0, 140)}`);
    const src = await readFile(require.resolve('../index.js'), 'utf8');
    check('no ffmpeg run trusts a timestamp limit or a declared duration (no -t, no format.duration)', !/'-t'|-t \$\{|format\?\.duration|format\.duration/.test(src));
  }
  {
    // 3 — buffering_period (type 0) is presentation-relevant: real x264 HRD payloads
    const hrd = path.join(tmp, 'hrd.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '200k', '-maxrate', '200k', '-bufsize', '400k', '-x264-params', 'nal-hrd=vbr', hrd]);
    const hIn = await sei.seiReport(hrd, 'h264', tmp);
    const es = path.join(tmp, 'hrd.h264');
    await sh('ffmpeg', ['-v', 'error', '-i', hrd, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', es]);
    const raw = await readFile(es);
    let at = -1;
    for (let i = 0; i + 5 < raw.length; i++) if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1 && (raw[i + 3] & 0x1f) === 6 && raw[i + 4] === 0) { at = i + 4; break; } // an SEI NAL whose first message is buffering_period
    if (at < 0) throw new Error('fixture: x264 wrote no buffering_period SEI NAL');
    let end = at; while (end + 2 < raw.length && !(raw[end] === 0 && raw[end + 1] === 0 && raw[end + 2] <= 1)) end++;
    const bpMsgs = sei.seiMessages(sei.unescape(raw.subarray(at, end)));
    const realBp = bpMsgs.find((m) => m.type === 0);
    const udMsg = Buffer.concat([Buffer.from([5, 16 + 20]), Buffer.from('086f3693b7b34f2c965321492feee5b8', 'hex'), Buffer.from('GPS 0.5 Fixtureville')]);
    check(`real x264 HRD: buffering_period in ${hIn.types['0']} SEI messages; a NAL with private data + that REAL buffering_period payload → refuse; the payload alone → keep`,
      hIn.types['0'] > 0 && !!realBp && sei.nalVerdict(Buffer.concat([Buffer.from([0x06]), udMsg, raw.subarray(at, end)]), 'h264').verdict === 'refuse' && sei.nalVerdict(Buffer.concat([Buffer.from([0x06]), raw.subarray(at, end)]), 'h264').verdict === 'keep', JSON.stringify(hIn));
    const c = await call('/strip-metadata', await readFile(hrd));
    const out = c.uploaded && await writeTmp(c.uploaded, '.mp4');
    const hOut = out && await sei.seiReport(out, 'h264', tmp);
    check('x264 HRD file (buffering_period + picture_timing in their own NALs): 200; every buffering_period kept; no private message left; frames identical', c.r.statusCode === 200 && hOut?.types['0'] === hIn.types['0'] && hOut?.types['1'] === hIn.types['1'] && hOut?.private === 0 && (await frameHash(hrd)) === (await frameHash(out)), `${c.r.statusCode} ${c.r.body.slice(0, 100)} ${JSON.stringify(hOut)}`);
    if (out) await rm(out, { force: true });
    const mixedEs = path.join(tmp, 'hrdmix.h264'), mixed = path.join(tmp, 'hrdmix.mp4');
    await writeFile(mixedEs, Buffer.concat([raw.subarray(0, at), udMsg, raw.subarray(at)]));
    await sh('ffmpeg', ['-v', 'error', '-framerate', '25', '-f', 'h264', '-i', mixedEs, '-c', 'copy', mixed]);
    const cm = await call('/strip-metadata', await readFile(mixed));
    check('private user data put INTO x264\'s buffering_period SEI NAL → REFUSED (415), nothing written', cm.r.statusCode === 415 && cm.uploaded === null, `${cm.r.statusCode} ${cm.r.body.slice(0, 120)}`);
  }
  {
    // 2 — EVERY stream is measured: a short first audio stream can't hide a long second one
    const two = path.join(tmp, 'twoaudio.webm');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', '-f', 'lavfi', '-i', 'sine=duration=30:frequency=880', '-map', '0', '-map', '1', '-c:a', 'libopus', two]);
    process.env.STRIP_MAX_DURATION_SEC = '10';
    let c; try { c = await call('/strip-metadata', fs.readFileSync(two)); } finally { delete process.env.STRIP_MAX_DURATION_SEC; }
    check('strip: first audio stream 2 s, SECOND 30 s, cap 10 s → 413, the second stream measured', c.r.statusCode === 413 && c.json?.error === 'duration-over-cap' && c.json.detail.stream === 2 && c.uploaded === null, `${c.r.statusCode} ${c.r.body.slice(0, 160)}`);
  }
  {
    // each HARD limit on its own: the real command line (lib/commands) on an input over its cap — the measuring that normally refuses such input first is bypassed
    const commands = require('../lib/commands');
    const proc = require('../lib/proc');
    const ten = path.join(tmp, 'ten.wav'), tenV = path.join(tmp, 'ten.mp4'), noisy = path.join(tmp, 'noisy.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=10', ten]);
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tenV]);
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=320x240:rate=30,noise=alls=40:allf=t', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', noisy]);
    const big = { maxDurationSec: 2, maxOutputBytes: 1e9 };
    const eOut = path.join(tmp, 'lim-enh.wav');
    await proc.run('ffmpeg', commands.enhanceArgs(ten, eOut, 'anull', big), { fsizeBytes: 1e9, cwd: tmp });
    const eSec = await limits.audioSeconds(eOut, 100, 60_000);
    check(`enhance hard limit (atrim, by sample count): 10 s in, cap 2 s → exactly ${eSec} s out (cap + 1)`, Math.abs(eSec - 3) < 0.001, `${eSec}`);
    const tOut = path.join(tmp, 'lim-tr.mp4');
    await proc.run('ffmpeg', commands.transcodeArgs(tenV, tOut, { hasAudio: true, caps: big }), { fsizeBytes: 1e9, cwd: tmp });
    const tFrames = (await limits.packetCounts(tOut, ['-map', '0:v:0'], Infinity, 60_000)).counts[0];
    const tSec = await limits.audioSeconds(tOut, 100, 60_000);
    check(`transcode hard limit (trim end_frame, by frame count): 10 s in, cap 2 s → exactly ${tFrames} frames ((cap + 1) × 30)`, tFrames === 90, `${tFrames}`);
    // the audio limit on its own: a 1 s picture with 10 s of sound — the picture ends by itself, so only atrim can stop the audio
    const longAudio = path.join(tmp, 'longaudio.mp4'), aOut = path.join(tmp, 'lim-tr-a.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', longAudio]);
    await proc.run('ffmpeg', commands.transcodeArgs(longAudio, aOut, { hasAudio: true, caps: big }), { fsizeBytes: 1e9, cwd: tmp });
    const aSec = await limits.audioSeconds(aOut, 100, 60_000);
    check(`transcode hard limit (audio atrim, by sample count): 1 s of picture + 10 s of sound, cap 2 s → ${aSec.toFixed(3)} s of audio (≤ cap + 1 + one AAC frame)`, aSec <= 3 + 1024 / 48000 + 0.001 && aSec >= 2.9, `${aSec}`);
    const sk = await call('/strip-metadata', await readFile(longAudio));
    const skOut = sk.uploaded && await writeTmp(sk.uploaded, '.mp4');
    const skPk = skOut && (await limits.packetCounts(skOut, ['-map', '0:V?', '-map', '0:a?'], Infinity, 60_000)).counts;
    const inLa = (await limits.packetCounts(longAudio, ['-map', '0:V?', '-map', '0:a?'], Infinity, 60_000)).counts;
    check(`strip of a two-stream file whose picture (1 s) ends long before its sound (10 s): 200, every packet of both streams kept (${JSON.stringify(skPk)} = ${JSON.stringify(inLa)}) — no limit ends one stream with the other`, sk.r.statusCode === 200 && JSON.stringify(skPk) === JSON.stringify(inLa), `${sk.r.statusCode} ${sk.r.body.slice(0, 140)}`);
    if (skOut) await rm(skOut, { force: true });
    const keepOut = path.join(tmp, 'lim-tr-keep.mp4');
    await proc.run('ffmpeg', commands.transcodeArgs(longAudio, keepOut, { hasAudio: true, caps: { maxDurationSec: 100, maxOutputBytes: 1e9 } }), { fsizeBytes: 1e9, cwd: tmp });
    const keepSec = await limits.audioSeconds(keepOut, 100, 60_000);
    check(`transcode within the caps keeps ALL the sound when the picture is shorter (1 s picture, 10 s sound → ${keepSec.toFixed(2)} s: no limit ends one stream with another)`, keepSec >= 9.9, `${keepSec}`);
    const fsOut = path.join(tmp, 'lim-fs.mp4'), fullOut = path.join(tmp, 'lim-full.mp4');
    await proc.run('ffmpeg', commands.transcodeArgs(noisy, fsOut, { hasAudio: false, caps: { maxDurationSec: 100, maxOutputBytes: 30000 } }), { fsizeBytes: 1e9, cwd: tmp });
    await proc.run('ffmpeg', commands.transcodeArgs(noisy, fullOut, { hasAudio: false, caps: { maxDurationSec: 100, maxOutputBytes: 1e9 } }), { fsizeBytes: 1e9, cwd: tmp });
    const fsBytes = (await stat(fsOut)).size, fullBytes = (await stat(fullOut)).size;
    // -fs stops the muxing at the cap; x264 still flushes the frames in its lookahead, so the file ends somewhat past it — the OS limit is the backstop above that
    check(`transcode hard limit (-fs): a noisy 5 s video (${fullBytes} bytes uncapped), cap 30000 → stopped at ${fsBytes} bytes (past the cap, far short of the whole)`, fsBytes >= 30000 && fsBytes < fullBytes / 3, `${fsBytes}/${fullBytes}`);
    const sOut = path.join(tmp, 'lim-strip.wav');
    await proc.run('ffmpeg', commands.stripArgs(ten, sOut, { family: 'wav', muxer: 'wav' }, { frames: [7] }), { fsizeBytes: 1e9, cwd: tmp });
    const sPk = (await limits.packetCounts(sOut, ['-map', '0:a'], Infinity, 60_000)).counts[0];
    const inPk = (await limits.packetCounts(ten, ['-map', '0:a'], Infinity, 60_000)).counts[0];
    check(`strip hard limit (-frames, a single-stream file): ${inPk} packets in, limit 7 → exactly ${sPk} out`, sPk === 7 && inPk > 7, `${sPk}/${inPk}`);
    // the OS limits (lib/proc): a run with NO -fs writes past its OS file-size limit → killed, the job's error
    const osOut = path.join(tmp, 'os-fsize.wav');
    const { inputArgs } = require('../lib/inputs');
    let osErr = null; try { await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...inputArgs(ten), '-c:a', 'pcm_s16le', osOut], { fsizeBytes: 100000, cwd: tmp }); } catch (e) { osErr = e; }
    const osBytes = (await stat(osOut)).size;
    check(`OS file-size limit: an ffmpeg with no -fs, writing ~880 KB under a 100000-byte limit → stopped (SIGXFSZ, OsLimitError) at ${osBytes} bytes`, osErr instanceof proc.OsLimitError && osBytes <= 100000, String(osErr));
    let zErr = null; try { await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...inputArgs(ten), path.join(tmp, 'os-zero.wav')], { fsizeBytes: 0, cwd: tmp }); } catch (e) { zErr = e; }
    check('OS file-size limit 0 (probes and counting): any file write is stopped', zErr instanceof proc.OsLimitError, String(zErr));
    process.env.WORKER_CPU_LIMIT_SEC = '1';
    const t0 = Date.now();
    // a local source looped forever: only a limit ends it (the wall clock at 30 s, or — first — the CPU limit)
    const hd = path.join(tmp, 'hd.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', hd]);
    let cpuErr = null; try { await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-stream_loop', '-1', ...inputArgs(hd), '-c:v', 'libx264', '-preset', 'veryslow', '-threads', '1', path.join(tmp, 'os-cpu.mp4')], { fsizeBytes: 1e9, cwd: tmp, timeoutMs: 30_000 }); } catch (e) { cpuErr = e; } finally { delete process.env.WORKER_CPU_LIMIT_SEC; }
    check(`OS CPU limit: a 1 s limit stops an endless single-thread encode (after ${((Date.now() - t0) / 1000).toFixed(1)} s, not the 30 s deadline) → the run fails`, !!cpuErr && !cpuErr.deadline && Date.now() - t0 < 15_000, String(cpuErr));
    check(`the OS file-size block unit is measured for this shell (${proc.blockUnit()} bytes)`, [512, 1024].includes(proc.blockUnit()));
  }
  {
    // 1 — the Annex-B expansion: a LARGE prefix SEI in hvcC (a camera's 240 KB blob), repeated before EVERY keyframe, hits the extraction's OS limit and fails cleanly
    const base = path.join(tmp, 'expand-base.mp4');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=16x16:rate=25:duration=8', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=none:keyint=1:min-keyint=1', base]);
    const mp4 = Buffer.from(await readFile(base));
    // walk to hvcC, remembering every ancestor box (the moov is at the END here, so no sample offset moves)
    const kids = (o, end) => { const out = []; while (o + 8 <= end) { const len = mp4.readUInt32BE(o); out.push({ type: mp4.toString('latin1', o + 4, o + 8), off: o, len }); o += len; } return out; };
    const chain = [];
    let lvl = kids(0, mp4.length);
    for (const [t, skip] of [['moov', 8], ['trak', 8], ['mdia', 8], ['minf', 8], ['stbl', 8], ['stsd', 16], ['hev1|hvc1', 8 + 78], ['hvcC', 0]]) {
      const box = lvl.find((x) => new RegExp(`^(${t})$`).test(x.type)) || (t === 'trak' ? null : null);
      if (!box) throw new Error(`fixture: no ${t}`);
      chain.push(box);
      if (t !== 'hvcC') lvl = kids(box.off + skip, box.off + box.len);
    }
    const hvcc = chain[chain.length - 1];
    const sei1 = () => { const n = 60000; const p = Buffer.concat([Buffer.from('086f3693b7b34f2c965321492feee5b8', 'hex'), Buffer.alloc(n - 16, 0x41)]); return Buffer.concat([Buffer.from([39 << 1, 1, 5]), Buffer.alloc(Math.floor(n / 255), 0xff), Buffer.from([n % 255]), p, Buffer.from([0x80])]); };
    const nals = [sei1(), sei1(), sei1(), sei1()];
    const arr = Buffer.concat([Buffer.from([39]), Buffer.from([0, nals.length]), ...nals.flatMap((n) => [Buffer.from([n.length >> 8, n.length & 0xff]), n])]);
    const end = hvcc.off + hvcc.len;
    const grown = Buffer.concat([mp4.subarray(0, end), arr, mp4.subarray(end)]);
    grown[hvcc.off + 8 + 22] += 1; // numOfArrays
    for (const box of chain) grown.writeUInt32BE(box.len + arr.length, box.off);
    const exp = await writeTmp(grown, '.mp4');
    const size = grown.length, budget = sei.annexBBudget(size);
    const frames = (await require('../lib/limits').packetCounts(exp, ['-map', '0:v:0'], Infinity, 60_000)).counts[0];
    const before = await jobDirs();
    const c = await call('/strip-metadata', grown);
    const after = await jobDirs();
    check(`Annex-B expansion: a ${(size / 1024).toFixed(0)} KB HEVC MP4, ${frames} keyframes, a 240 KB user-data SEI in hvcC — repeated before every keyframe, it expands past the ${(budget / 1048576).toFixed(2)} MB OS file-size budget → 413, cleanly: nothing written, no temp dir left`,
      frames === 200 && c.r.statusCode === 413 && c.json?.error === 'sei-expands' && c.uploaded === null && after.length === before.length, `${frames} ${c.r.statusCode} ${c.r.body.slice(0, 140)}`);
    await rm(exp, { force: true });
  }
  {
    // 1 — the COMBINED span: earliest start to latest end across all streams
    const far = path.join(tmp, 'far-apart.webm');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-itsoffset', '15000', '-f', 'lavfi', '-i', 'sine=duration=1:frequency=880', '-map', '0', '-map', '1', '-c:a', 'libopus', far]);
    const pk = await require('../lib/limits').packetCounts(far, ['-map', '0:a'], Infinity, 60_000);
    const c = await call('/strip-metadata', fs.readFileSync(far));
    check(`two ONE-second audio tracks, starting at 0 and 15000 s (each track's own span ${pk.spans.map((x) => x.toFixed(1)).join(' / ')} s; combined ${pk.spanSec?.toFixed(0)} s) → refused by the combined span (cap 4 h), nothing written`,
      pk.spans.every((x) => x < 2) && pk.spanSec > 15000 && c.r.statusCode === 413 && c.json?.error === 'duration-over-cap' && c.json.detail.spanSec >= 15000 && c.json.detail.spanSec < 15010 && c.uploaded === null, `${c.r.statusCode} ${c.r.body.slice(0, 160)}`);
  }
  {
    // 2 — the closed input rule: playlists and indirection lists are refused BEFORE ffmpeg runs (no process, so no network and no out-of-directory read)
    const proc = require('../lib/proc');
    const inputs = require('../lib/inputs');
    const hls = Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://evil.example/seg0.ts\n#EXTINF:10,\n../0xother/5f1e\n#EXTINF:10,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
    const ffconcat = Buffer.from("ffconcat version 1.0\nfile 'http://evil.example/a.mp3'\nfile '../0xother/5f1e'\nfile '/etc/hosts'\n");
    const concat = Buffer.from("file 'file:///etc/passwd'\nfile 'http://evil.example/b.mp3'\n");
    const sdp = Buffer.from('v=0\no=- 0 0 IN IP4 203.0.113.1\ns=x\nc=IN IP4 203.0.113.1\nt=0 0\nm=audio 5004 RTP/AVP 0\n');
    const hlsBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), hls]); // with a byte-order mark
    const realRun = proc.run;
    const spawned = [];
    proc.run = (...a) => { spawned.push(a); return realRun(...a); };
    const results = [];
    try {
      for (const [name, bytes] of [['an HLS playlist (http://, another object, file:///etc/passwd)', hls], ['an HLS playlist with a BOM', hlsBom], ['an ffconcat list', ffconcat], ['a concat list', concat], ['an SDP description', sdp]]) {
        for (const ep of ['/strip-metadata', '/transcode-video', '/enhance']) {
          const before = spawned.length;
          const r = await call(ep, bytes, ep === '/enhance' ? { body: { enhancementType: 'clean' } } : {});
          results.push({ name, ep, status: r.r.statusCode, ran: spawned.length - before, uploaded: r.uploaded !== null, error: r.json?.error });
        }
      }
    } finally {
      proc.run = realRun;
    }
    const bad = results.filter((x) => x.status !== 415 || x.ran !== 0 || x.uploaded || x.error !== 'input-refused');
    check(`playlists and indirection lists (HLS ×2, ffconcat, concat, SDP) on all three endpoints → 415 input-refused, and NO ffmpeg / ffprobe process started (${results.length} cases)`, bad.length === 0 && results.length === 15, JSON.stringify(bad.slice(0, 2)));
    // the guard itself (lib/proc): every input shape that isn't exactly ours is refused before a process starts
    const jd = await mkdtemp(path.join(os.tmpdir(), 'wt-guard-'));
    const ok = path.join(jd, 'in.wav');
    await copyFile(wav, ok);
    const tries = [
      ['a bare -i', ['-v', 'error', '-i', ok, '-f', 'null', '-']],
      ['no protocol whitelist', ['-f', 'wav', '-i', ok, '-f', 'null', '-']],
      ['-f hls', ['-protocol_whitelist', 'file', '-f', 'hls', '-i', ok, '-f', 'null', '-']],
      ['-f concat', ['-protocol_whitelist', 'file', '-f', 'concat', '-i', ok, '-f', 'null', '-']],
      ['a whitelist with http', ['-protocol_whitelist', 'file,http,tcp', '-f', 'wav', '-i', ok, '-f', 'null', '-']],
      ['an http:// input', ['-protocol_whitelist', 'file', '-f', 'wav', '-i', 'http://evil.example/x.wav', '-f', 'null', '-']],
      ['a file outside the job directory', ['-protocol_whitelist', 'file', '-f', 'wav', '-i', '/etc/hosts', '-f', 'null', '-']],
      ['a path that climbs out', ['-protocol_whitelist', 'file', '-f', 'wav', '-i', path.join(jd, '..', 'x.wav'), '-f', 'null', '-']],
      ['a relative path', ['-protocol_whitelist', 'file', '-f', 'wav', '-i', 'in.wav', '-f', 'null', '-']],
      ['no input at all', ['-f', 'lavfi', 'sine', '-f', 'null', '-']],
    ];
    const guardBad = [];
    for (const [label, args] of tries) {
      let e = null; try { await proc.run('ffmpeg', args, { cwd: jd }); } catch (x) { e = x; }
      if (!(e instanceof inputs.InputRefused)) guardBad.push(`${label}: ${e ? e.message : 'RAN'}`);
    }
    let pe = null; try { await proc.run('ffprobe', ['-v', 'error', '-show_format', ok], { cwd: jd }); } catch (x) { pe = x; }
    const good = await proc.run('ffmpeg', ['-v', 'error', ...inputs.inputArgs(ok), '-f', 'null', '-'], { cwd: jd }).then(() => true, () => false);
    check(`lib/proc refuses every input shape but ours (${tries.length} ffmpeg cases + a positional ffprobe input), and runs ours (positive control)`, guardBad.length === 0 && pe instanceof inputs.InputRefused && good, guardBad.join(' | ') + String(pe));
    check('inputs: the allowlist is mov / mp3 / wav / flac / ogg / matroska, by magic bytes; playlist text, SDP and unknown bytes → null', ['mov', 'mp3', 'wav', 'flac', 'ogg', 'matroska'].every((f) => inputs.ALLOWED.has(f)) && inputs.ALLOWED.size === 6 && [hls, hlsBom, ffconcat, concat, sdp, Buffer.alloc(64)].every((b) => inputs.containerOf(b) === null) && inputs.containerOfFile(ok) === 'wav');
    await rm(jd, { recursive: true, force: true });
    // 3 — the block-size calibration runs under the same kind of limits
    const src = await readFile(require.resolve('../lib/proc.js'), 'utf8');
    check('the ulimit calibration child has a CPU limit (ulimit -t) and a wall-clock deadline (timeout, SIGKILL)', /ulimit -t 5 && ulimit -f 1/.test(src) && /timeout: 5000, killSignal: 'SIGKILL'/.test(src));
  }
  {
    // 1a — the scanner at EVERY offset around a chunk edge: H.264 and both HEVC SEI layouts, 3- and 4-byte start codes
    const CH = 64;
    const layouts = [['h264', [0x06], [0x0c]], ['hevc', [39 << 1, 0x01], [38 << 1, 0x01]], ['hevc', [40 << 1, 0x01], [38 << 1, 0x01]]];
    let cases = 0; const misses = [];
    for (const [codec, seiHdr, fillHdr] of layouts) {
      for (const sc of [[0, 0, 1], [0, 0, 0, 1]]) {
        const payload = Buffer.concat([Buffer.alloc(16, 9), Buffer.from('GPS')]);
        const seiNal = Buffer.concat([Buffer.from(sc), Buffer.from(seiHdr), Buffer.from([5, payload.length]), payload, Buffer.from([0x80])]);
        for (let k = CH - 16; k <= 2 * CH + 16; k++) {
          // a filler NAL of exactly k bytes, so the SEI's start code begins at offset k; then the SEI; then (half the time) another filler
          const filler = Buffer.concat([Buffer.from(sc), Buffer.from(fillHdr), Buffer.alloc(Math.max(1, k - sc.length - fillHdr.length - 1), 0xff), Buffer.from([0x80])]).subarray(0, k);
          if (filler.length !== k) continue;
          const tail = k % 2 ? Buffer.concat([Buffer.from(sc), Buffer.from(fillHdr), Buffer.alloc(30, 0xff), Buffer.from([0x80])]) : Buffer.alloc(0);
          const es = await writeTmp(Buffer.concat([filler, seiNal, tail]), '.es');
          const r = await sei.scanAnnexB(es, codec, CH);
          cases++;
          if (r.private !== 1 || r.seiNals !== 1) misses.push(`${codec}/${seiHdr[0]}/sc${sc.length}/k${k}: ${JSON.stringify(r)}`);
          await rm(es, { force: true });
        }
      }
    }
    check(`SEI scan finds the private message at every offset around 64-byte chunk edges (${cases} cases: H.264, HEVC prefix + suffix, 3- and 4-byte start codes)`, misses.length === 0 && cases > 400, misses.slice(0, 3).join(' | '));
  }
  {
    // data and subtitle tracks (timecode data track, mov_text subtitles) beside the picture
    const dt = path.join(tmp, 'tracks.mov'), srt = path.join(tmp, 's.srt');
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nGPS 0.5 0.5 Fixtureville\n');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10', '-i', srt, '-map', '0:v', '-map', '1:s', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:s', 'mov_text', '-timecode', '01:00:00:00', dt]);
    const before = await media.metadataReport(dt, 'iso');
    const c = await call('/strip-metadata', await readFile(dt));
    const out = c.uploaded && await writeTmp(c.uploaded, '.mov');
    const types = out && JSON.parse(await sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', out])).streams.map((x) => x.codec_type);
    check('data + subtitle tracks (timecode, mov_text "GPS …"): present before; 200, DROPPED — only the picture remains', before.otherStreams >= 2 && c.r.statusCode === 200 && JSON.stringify(types) === '["video"]' && !c.uploaded.includes(Buffer.from('Fixtureville')), `${JSON.stringify(before)} ${c.r.statusCode} ${JSON.stringify(types)}`);
    if (out) await rm(out, { force: true });
  }
  {
    // a codec off the picture allowlist (Motion-JPEG frames can carry EXIF) → refused
    const mj = path.join(tmp, 'mjpeg.mov');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=5', '-c:v', 'mjpeg', mj]);
    const c = await call('/strip-metadata', await readFile(mj));
    check('a picture codec off the allowlist (Motion-JPEG) → REFUSED (415)', c.r.statusCode === 415 && c.uploaded === null, `${c.r.statusCode}`);
  }
  {
    // enhancement caps (P2-3): a declared duration over the cap, and an output over the cap
    const long = path.join(tmp, 'long.mp3'), short = path.join(tmp, 'short.mp3');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=10', '-c:a', 'libmp3lame', '-b:a', '8k', long]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'libmp3lame', '-b:a', '8k', short]);
    process.env.ENHANCE_MAX_DURATION_SEC = '5';
    const d = await call('/enhance', await readFile(long), { body: { enhancementType: 'clean' } });
    delete process.env.ENHANCE_MAX_DURATION_SEC;
    check('enhance: a 10 s input with a 5 s cap → 413 (measured) before any processing, nothing written', d.r.statusCode === 413 && d.json?.error === 'duration-over-cap' && d.json.detail.audioSec > 5 && d.uploaded === null, `${d.r.statusCode} ${d.r.body.slice(0, 100)}`);
    // a container that declares NO duration (live WebM, like MediaRecorder's): measured, not trusted
    const live = path.join(tmp, 'live.webm');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=10', '-c:a', 'libopus', '-live', '1', '-f', 'webm', live]);
    const declared = JSON.parse(await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', live])).format?.duration;
    process.env.ENHANCE_MAX_DURATION_SEC = '5';
    const lv = await call('/enhance', await readFile(live), { body: { enhancementType: 'clean' } });
    delete process.env.ENHANCE_MAX_DURATION_SEC;
    check(`enhance: 10 s of audio whose container declares ${declared === undefined ? 'NO' : declared + ' s of'} duration → MEASURED, 413 (measured), nothing written`, (declared === undefined || declared === 'N/A') && lv.r.statusCode === 413 && lv.json?.error === 'duration-over-cap' && lv.uploaded === null, `${declared} ${lv.r.statusCode} ${lv.r.body.slice(0, 100)}`);
    // 30 s → ~2.9 MB of WAV; cap 1 MB. (Longer than loudnorm's 3 s look-ahead, so output streams and -fs can act.)
    const thirty = path.join(tmp, 'thirty.mp3');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=30', '-c:a', 'libmp3lame', '-b:a', '8k', thirty]);
    process.env.ENHANCE_MAX_OUTPUT_BYTES = '1000000';
    const o = await call('/enhance', await readFile(thirty), { body: { enhancementType: 'clean' } });
    delete process.env.ENHANCE_MAX_OUTPUT_BYTES;
    const stopped = o.json?.error === 'output-over-cap' ? o.json.detail?.bytes : NaN;
    check(`enhance: an output over the byte cap (30 s → ~2.9 MB, cap 1 MB) → 413, and ffmpeg's -fs STOPPED writing at ${stopped} bytes (≤ cap + 64 KB — without -fs it would be ~2.9 MB), nothing written`, o.r.statusCode === 413 && o.uploaded === null && stopped >= 1000000 && stopped <= 1000000 + 65536, `${o.r.statusCode} ${o.r.body.slice(0, 120)}`);
    const ok = await call('/enhance', await readFile(short), { body: { enhancementType: 'clean' } });
    check('enhance within the caps: 200, and the upload is STREAMED (a ReadableStream body, duplex half, exact Content-Length)', ok.r.statusCode === 200 && ok.uploadInit?.duplex === 'half' && !Buffer.isBuffer(ok.uploadInit?.body) && typeof ok.uploadInit?.body?.getReader === 'function' && Number(ok.uploadHeaders?.['Content-Length']) === ok.uploaded?.length, `${ok.r.statusCode} ${JSON.stringify(ok.uploadHeaders)}`);
  }
  {
    // 1b — backpressure in BYTES: a slow consumer; the file is read at most ~2 chunks ahead of what was consumed
    const f = path.join(tmp, 'bp.bin');
    await writeFile(f, crypto.randomBytes(4 << 20));
    const { stream, bytesRead } = io.fileStream(f, 64 * 1024);
    const reader = stream.getReader();
    let consumed = 0, worstAhead = 0, n = 0;
    const want = await readFile(f), got = [];
    for (;;) {
      await new Promise((r) => setTimeout(r, n++ < 20 ? 15 : 0)); // slow for the first 20 reads
      worstAhead = Math.max(worstAhead, bytesRead() - consumed);
      const { done, value } = await reader.read();
      if (done) break;
      consumed += value.length; got.push(Buffer.from(value));
    }
    check(`backpressure in bytes: a slow consumer never lets reading run more than 2 chunks ahead (worst ${(worstAhead / 1024).toFixed(0)} KB), and every byte arrives intact`, worstAhead <= 2 * 64 * 1024 && Buffer.concat(got).equals(want), `${worstAhead}`);
    const src = await readFile(require.resolve('../lib/storageIO.js'), 'utf8');
    check('uploads use that stream (no Readable.toWeb, which queues by chunk count)', /const body = fileStream\(file\)\.stream/.test(src) && !/toWeb\(/.test(src));
    await rm(f, { force: true });
  }
  {
    // memory: a 256 MB upload streamed from disk does not land in memory
    const big = path.join(tmp, 'big.bin');
    const fh = await require('fs/promises').open(big, 'w'); await fh.truncate(256 * 1024 * 1024); await fh.close();
    global.gc?.();
    const base = process.memoryUsage();
    let peak = 0, got = 0;
    const consume = async (u, init) => {
      const reader = init.body.getReader();
      let sinceGc = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length; sinceGc += value.length;
        // measure what is actually RETAINED (collect first), every 8 MB
        if (sinceGc >= 8 << 20) { sinceGc = 0; global.gc?.(); const m = process.memoryUsage(); peak = Math.max(peak, m.arrayBuffers + m.external); }
      }
      return new Response('{}', { status: 200 });
    };
    await io.uploadFile(upUrl(), big, 'application/octet-stream', { deadlineMs: 60_000 }, consume);
    const growth = peak - (base.arrayBuffers + base.external);
    check(`a 256 MB output is streamed, not buffered: all bytes sent, retained memory grew ${(growth / 1048576).toFixed(1)} MB (< 48 MB; buffering would hold ≥ 256 MB)`, typeof global.gc === 'function' && got === 256 * 1024 * 1024 && growth < 48 * 1024 * 1024);
    await rm(big, { force: true });
  }
  {
    // finding 1: an input with NO tags anything checks by name still gets remuxed (no "already clean" shortcut)
    const bare = path.join(tmp, 'bare.mp4');
    await sh('ffmpeg', ['-v', 'error', '-i', FIX('gps-video.mp4'), '-map', '0:v', '-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', bare]);
    const c = await call('/strip-metadata', await readFile(bare));
    check('strip is unconditional: a file with no tags is still remuxed and written back (stripped: true)', c.r.statusCode === 200 && c.json?.stripped === true && !!c.uploaded, c.r.body.slice(0, 160));
  }
  {
    // the output verification is what stops a dirty file: replace the strip with a plain copy
    const realStrip = media.stripMedia, realBlank = media.blankMetadataBoxes;
    media.stripMedia = async (input, output) => copyFile(input, output);
    media.blankMetadataBoxes = async () => 0;
    try {
      const c = await call('/strip-metadata', await readFile(FIX('gps-video.mov')));
      check('with the strip sabotaged, the OUTPUT VERIFICATION refuses: 500 and nothing written back (fails if verifyClean is removed)', c.r.statusCode === 500 && c.uploaded === null && c.json?.error === 'metadata-survived', `${c.r.statusCode} ${c.r.body.slice(0, 160)}`);
    } finally {
      media.stripMedia = realStrip;
      media.blankMetadataBoxes = realBlank;
    }
  }
  {
    const c = await call('/strip-metadata', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.mp4' } }));
    check('the source redirects (302) → refused (500), nothing written', c.r.statusCode === 500 && c.uploaded === null && c.json?.error === 'redirect-refused' && c.json.detail?.status === 302, c.r.body.slice(0, 120));
  }
  {
    const c = await call('/strip-metadata', await readFile(FIX('gps-video.mp4')), { upload: () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }) });
    check('the upload redirects (307) → refused (500)', c.r.statusCode === 500, c.r.body.slice(0, 120));
  }
  {
    const c = await call('/strip-metadata', await readFile(FIX('gps-video.mp4')), { upload: () => new Response('denied', { status: 403 }) });
    check('the write-back is refused (403) → 500, never a success', c.r.statusCode === 500 && c.json?.success !== true);
  }
  {
    const c = await call('/strip-metadata', () => new Response('x', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } }));
    check('a source over the cap by Content-Length → 413, nothing written', c.r.statusCode === 413 && c.uploaded === null);
  }
  {
    const c = await call('/strip-metadata', () => new Response('nope', { status: 404 }));
    check('the source can\'t be read (404) → 500, nothing written', c.r.statusCode === 500 && c.uploaded === null);
  }
  {
    const c = await call('/strip-metadata', Buffer.from('ID3 not a container at all, just bytes, padding padding'));
    check('bytes that are not ISO media → 415, nothing written', c.r.statusCode === 415 && c.uploaded === null);
  }
  for (const [label, opts] of [
    ['another key as the destination (finding 7)', { uploadUrl: upUrl('0xabc/other') }],
    ['a public object as the source', { sourceUrl: `${S}/public/video-clips/0xabc/a.mp4` }],
    ['a public bucket as the destination', { uploadUrl: upUrl('0xabc/5f1e', 'video-clips') }],
    ['another host', { sourceUrl: readUrl().replace(HOST, 'evil.example') }],
  ]) {
    for (const ep of ['/strip-metadata', '/transcode-video', '/enhance']) {
      const c = await call(ep, Buffer.from('x'), opts);
      if (c.r.statusCode !== 400 || c.uploaded !== null) { check(`${ep}: ${label} → 400`, false, `${c.r.statusCode}`); }
    }
    check(`every endpoint: ${label} → 400 before any download`, true);
  }

  {
    const c = await call('/transcode-video', await readFile(webm), { type: 'video/webm' });
    allLogs.push(c.logs);
    const rep = c.uploaded && await writtenReport(c.uploaded, 'iso');
    check('transcode: tagged webm → 200 (exact success shape), an mp4 written back IN PLACE with no metadata (title and encoder name gone)', c.r.statusCode === 200 && exact(c.json) && rep?.clean && !c.uploaded.includes(Buffer.from('Lavc')) && rep.brand === 'isom' && !c.uploaded.includes(Buffer.from('Fixtureville')) && c.uploadHeaders?.['Content-Type'] === 'video/mp4', `${c.r.statusCode} ${c.r.body.slice(0, 160)} ${JSON.stringify(rep)}`);
  }
  {
    const c = await call('/transcode-video', () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }));
    check('transcode: a redirecting source → refused', c.r.statusCode === 500 && c.uploaded === null);
  }
  {
    const c = await call('/enhance', await readFile(wav), { type: 'audio/wav', body: { enhancementType: 'clean' } });
    allLogs.push(c.logs);
    const rep = c.uploaded && await writtenReport(c.uploaded, 'wav');
    check('enhance: tagged WAV → 200 (exact success shape), an enhanced WAV written back IN PLACE with only fmt/data chunks (title gone)', c.r.statusCode === 200 && exact(c.json) && rep?.clean && !c.uploaded.includes(Buffer.from('Fixtureville')), `${c.r.statusCode} ${c.r.body.slice(0, 160)} ${JSON.stringify(rep)}`);
  }
  {
    const c = await call('/enhance', await readFile(wav), { body: { enhancementType: 'nope' } });
    check('enhance: an invalid enhancementType → 400, nothing downloaded or written', c.r.statusCode === 400 && c.uploaded === null);
  }
  {
    const c = await call('/enhance', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), { body: { enhancementType: 'clean' } });
    check('enhance: a redirecting source → refused', c.r.statusCode === 500 && c.uploaded === null);
  }

  {
    // Astra's P2 on #781 (2026-10-31): a failure leaves the worker as ONE listed code and numbers only — never an
    // error's text, which can carry ffmpeg's stderr, storage's reply, a person's path or a credential. Synthetic
    // sensitive markers are put INSIDE each failure; none may reach the reply or the log.
    const errors = require('../lib/errors');
    const proc = require('../lib/proc');
    const MARKERS = ['/Users/Jane Doe/Music/private demo.mp3', 'sk_live_FIXTURE0000', 'eyJhbGciOiJIUzI1NiJ9.FIXTURE', 'Fixtureville', 'token=SECRETTOKEN'];
    const loud = MARKERS.join(' ');
    const shapeOk = (j) => !!j && typeof j.error === 'string' && Object.prototype.hasOwnProperty.call(errors.CODES, j.error)
      && Object.keys(j).every((k) => k === 'error' || k === 'detail')
      && (j.detail === undefined || Object.entries(j.detail).every(([k, v]) => errors.DETAIL_KEYS.has(k) && typeof v === 'number' && Number.isFinite(v)));
    const clean = (c) => !MARKERS.some((m) => c.r.body.includes(m) || c.logs.includes(m));
    const cases = [];
    cases.push(['storage refuses the write-back with a reply full of private text', 'upload-failed', await call('/strip-metadata', await readFile(wav), { upload: () => new Response(loud, { status: 400 }) }), (j) => j.detail?.status === 400]);
    cases.push(['the source download fails (404) with private text in the body', 'download-failed', await call('/strip-metadata', () => new Response(loud, { status: 404 })), (j) => j.detail?.status === 404]);
    const sabotage = async (label, code, err) => {
      const real = media.stripMedia;
      media.stripMedia = async () => { throw err; };
      try { cases.push([label, code, await call('/strip-metadata', await readFile(wav)), () => true]); } finally { media.stripMedia = real; }
    };
    await sabotage('ffmpeg fails with private text on its stderr (a real ProcError, tagged by proc.run)', 'ffmpeg-failed', errors.tag(new proc.ProcError(`ffmpeg failed (exit 1): ${loud}`), 'ffmpeg-failed', { exit: 1 }));
    await sabotage('an untagged ProcError carrying private text', 'ffmpeg-failed', new proc.ProcError(`ffmpeg failed: ${loud}`));
    await sabotage('an unexpected error carrying private text', 'internal', new Error(loud));
    await sabotage('an error tagged with a string and an unlisted name in its detail', 'ffmpeg-failed', errors.tag(new Error(loud), 'ffmpeg-failed', { exit: 1, path: loud, status: loud, capBytes: Infinity }));
    for (const [label, code, c, more] of cases) {
      check(`${label} → ${c.r.statusCode} {error: ${code}${c.json?.detail ? `, detail ${JSON.stringify(c.json.detail)}` : ''}}: a listed code, numbers only, no marker in the reply or the log${code === 'upload-failed' ? '' : ', nothing written'}`,
        c.json?.error === code && c.r.statusCode === errors.CODES[code] && shapeOk(c.json) && more(c.json) && clean(c) && (code === 'upload-failed' || c.uploaded === null), `${c.r.statusCode} ${c.r.body.slice(0, 200)}`);
    }
    const strings = cases.find(([l]) => l.startsWith('an error tagged with a string'))[2].json;
    check('a detail keeps only listed names with finite numbers ({exit: 1}; the path, a string status and Infinity dropped)', JSON.stringify(strings) === JSON.stringify({ error: 'ffmpeg-failed', detail: { exit: 1 } }), JSON.stringify(strings));
    let unknown = null; try { errors.tag(new Error('x'), 'made-up-code'); } catch (e) { unknown = e; }
    check('tagging with a code that isn\'t listed throws (a typo can\'t send an unlisted code)', unknown !== null);
    check('every code is lowercase words and dashes, and goes out with a 4xx or 5xx status', Object.entries(errors.CODES).every(([k, v]) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(k) && v >= 400 && v < 600));
    // the secret gate's own replies are codes too
    const noSecret = await app.inject({ method: 'POST', url: '/strip-metadata', payload: {} });
    check('no secret → 401 {error: unauthorized}', noSecret.statusCode === 401 && noSecret.body === '{"error":"unauthorized"}', noSecret.body);
    const badBody = await app.inject({ method: 'POST', url: '/strip-metadata', headers: H, payload: { sourceUrl: `https://evil.example/${MARKERS[0]}`, uploadUrl: 'x' } });
    check('a refused request body → 400 {error: bad-request}, the URL not echoed', badBody.statusCode === 400 && badBody.body === '{"error":"bad-request"}', badBody.body);
    // Astra's P2-3 (2026-11-01, after the Reviewer's P3): Fastify's own replies and log lines hold no request text
    // either: a body that isn't JSON (its parse error quotes the body), an unknown content type, a body over the
    // limit, routes the worker doesn't have (markers in the path and the query), and a hook that throws before any
    // handler runs. The log is captured where pino WRITES it, so Fastify's own request lines are seen as written.
    const guards = require('../lib/guards');
    const logging = require('../lib/logging');
    const pino = require('pino');
    const stream = app.log[pino.symbols.streamSym];
    const written = [];
    const realWrite = stream.write;
    const realSecretOk = guards.secretOk;
    const json = { ...H, 'content-type': 'application/json' };
    const asked = {};
    // the HTTP parser's own refusals happen before Fastify has a request, so they need a real socket (inject skips
    // the parser): raw bytes in, the raw reply back
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = app.server.address().port;
    const raw = (bytes) => new Promise((resolve, reject) => {
      const sock = require('net').connect(port, '127.0.0.1', () => sock.end(bytes));
      const got = [];
      sock.on('data', (c) => got.push(c));
      sock.on('error', reject);
      sock.on('close', () => resolve(Buffer.concat(got).toString('latin1')));
    });
    const rawAsked = {};
    stream.write = function (line) { written.push(String(line)); return true; };
    try {
      asked.notJson = await app.inject({ method: 'POST', url: '/strip-metadata?token=SECRETTOKEN', headers: json, payload: `{"sourceUrl": "${loud}", oops` });
      asked.oddType = await app.inject({ method: 'POST', url: '/strip-metadata', headers: { ...H, 'content-type': 'text/x-fixture' }, payload: loud });
      asked.oversized = await app.inject({ method: 'POST', url: '/strip-metadata', headers: json, payload: JSON.stringify({ sourceUrl: loud.repeat(Math.ceil(1.2e6 / loud.length)) }) });
      asked.unknown = await app.inject({ method: 'POST', url: `/no-such-route/${encodeURIComponent(MARKERS[0])}?token=SECRETTOKEN&k=sk_live_FIXTURE0000`, headers: json, payload: { sourceUrl: loud } });
      asked.unknownNoSecret = await app.inject({ method: 'GET', url: `/Fixtureville/${encodeURIComponent(MARKERS[0])}?token=SECRETTOKEN` });
      // Astra's P2 on #4 (2026-11-01): a path Fastify can't decode got its default FST_ERR_BAD_URL body, path and all
      asked.badUrl = await app.inject({ method: 'POST', url: `/strip-metadata/${encodeURIComponent(MARKERS[0])}%zz?token=SECRETTOKEN`, headers: json, payload: { sourceUrl: loud } });
      rawAsked.badHeader = await raw(`POST /strip-metadata?token=SECRETTOKEN HTTP/1.1\r\nHost: x\r\nX ${MARKERS[0]}: ${loud}\r\n\r\n`);
      rawAsked.badRequestLine = await raw(`${loud} /${MARKERS[0]}?token=SECRETTOKEN HTTP/1.1\r\nHost: x\r\n\r\n`);
      rawAsked.headerOverflow = await raw(`POST /strip-metadata?token=SECRETTOKEN HTTP/1.1\r\nHost: x\r\nX-Fixture: ${loud.repeat(Math.ceil(20000 / loud.length))}\r\n\r\n`);
      guards.secretOk = () => { throw new Error(`hook failed: ${loud}`); };
      asked.hookThrows = await app.inject({ method: 'POST', url: '/strip-metadata?token=SECRETTOKEN', headers: json, payload: { sourceUrl: loud } });
      await new Promise((r) => setImmediate(r)); // the "request completed" lines
    } finally {
      guards.secretOk = realSecretOk;
      stream.write = realWrite;
    }
    // the markers as they'd appear in a URL, too (encoded)
    const LOGMARKS = [...MARKERS, 'Jane', 'SECRETTOKEN', 'sk_live_FIXTURE0000', 'eyJhbGci'];
    const leaks = (text) => LOGMARKS.filter((m) => text.includes(m) || text.includes(encodeURIComponent(m)));
    const w = written.join('');
    const parsed = written.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    for (const [label, key, status, body] of [
      ['a body that isn\'t JSON (its parse error quotes the body)', 'notJson', 400, '{"error":"bad-request"}'],
      ['an unknown content type (Fastify\'s 415)', 'oddType', 400, '{"error":"bad-request"}'],
      ['a body over the 1 MB limit (Fastify\'s 413)', 'oversized', 400, '{"error":"bad-request"}'],
      ['a route the worker doesn\'t have, markers in its path and query', 'unknown', 404, '{"error":"not-found"}'],
      ['an unknown route without the secret (the secret is checked before routing)', 'unknownNoSecret', 401, '{"error":"unauthorized"}'],
      ['the secret check throwing before any handler (a pre-handler failure)', 'hookThrows', 500, '{"error":"internal"}'],
      ['a path Fastify can\'t decode (a malformed percent-escape), a marker in it', 'badUrl', 400, '{"error":"bad-request"}'],
    ]) {
      const res = asked[key];
      check(`${label} → ${status} ${body} exactly, no marker in the reply`, res.statusCode === status && res.body === body && leaks(res.body).length === 0, `${res.statusCode} ${res.body.slice(0, 160)}`);
    }
    const RAW_REPLY = 'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: 23\r\nConnection: close\r\n\r\n{"error":"bad-request"}';
    for (const [label, key] of [['a malformed header line', 'badHeader'], ['a malformed request line', 'badRequestLine'], ['headers over the parser\'s limit (20 KB)', 'headerOverflow']]) {
      check(`raw HTTP, ${label}, markers in it → exactly a 400 {error: bad-request} reply, no marker`, rawAsked[key] === RAW_REPLY, JSON.stringify(rawAsked[key].slice(0, 200)));
    }
    check(`what pino wrote for those ${Object.keys(asked).length + Object.keys(rawAsked).length} requests (${written.length} lines): no marker, plain or URL-encoded, anywhere`, written.length >= 17 && leaks(w).length === 0, `${leaks(w).join(', ')} ${w.slice(0, 300)}`);
    check('...every line a listed message, every request as {method, route} only (route "unmatched" for the unknown ones), no err text',
      parsed.every((l) => l && logging.MESSAGES.has(l.msg) && (!l.req || JSON.stringify(Object.keys(l.req)) === '["method","route"]') && (!l.err || JSON.stringify(Object.keys(l.err)) === '["code"]'))
        && parsed.filter((l) => l.msg === 'incoming request' && l.req.route === 'unmatched').length === 3,
      written.slice(0, 4).join(''));
    check('...each refusal logged by its handler, as route, status and code (the parser\'s three and the bad URL as "unmatched")', ['"route":"/strip-metadata","status":400,"error":"bad-request"', '"route":"unmatched","status":404,"error":"not-found"', '"route":"/strip-metadata","status":500,"error":"internal"'].every((s) => w.includes(s))
      && written.filter((l) => l.includes('"route":"unmatched","status":400,"error":"bad-request"')).length === 4, w.slice(0, 300));
    // the logger on its own, for the lines Fastify writes that a test can't easily provoke: an Error as the message
    // (its hooks' failures), a message with the URL in it ("Reply was already sent…"), a request with a query and
    // headers, an err with a stack and a listed code, and the startup line
    {
      const lines = [];
      const lg = pino(logging.loggerOptions(), { write: (l) => lines.push(JSON.parse(l)) });
      lg.error(new Error(loud));
      lg.warn(`Reply was already sent, did you forget to "return reply" in the "/strip-metadata?${loud}" (POST) route?`);
      lg.info({ req: { method: 'POST', url: `/strip-metadata?${loud}`, headers: { cookie: loud }, hostname: loud } }, 'incoming request');
      lg.error({ err: Object.assign(new Error(loud), { workerCode: 'internal', stack: loud }) }, loud);
      lg.info('Server listening at http://0.0.0.0:3001');
      const got = lines.map((l) => [l.msg, l.req ?? l.err ?? null]);
      check('the logger: an Error, a URL in a message, a request with a query and headers, an err with a stack → message withheld, {method, route}, {code}; the startup line kept; no marker',
        JSON.stringify(got) === JSON.stringify([[logging.WITHHELD, { code: null }], [logging.WITHHELD, null], ['incoming request', { method: 'POST', route: '/strip-metadata' }], [logging.WITHHELD, { code: 'internal' }], ['Server listening at http://0.0.0.0:3001', null]])
          && leaks(JSON.stringify(lines)).length === 0, JSON.stringify(got));
    }
  }
  const logs = allLogs.join('');
  check('logs carry bucket/key only — no URL, no token (finding 8)', logs.length > 0 && !/READTOKEN|WRITETOKEN|token=|https?:\/\//.test(logs) && logs.includes('media-incoming/0xabc/5f1e'), logs.slice(0, 200));
  check('no temp files left behind by any endpoint run (finding 6)', (await jobDirs()).length === 0, (await jobDirs()).join(','));

  console.log('\nThe secret, at the HTTP level');
  delete process.env.MEDIA_WORKER_SECRET;
  const r0 = await app.inject({ method: 'POST', url: '/strip-metadata', payload: {} });
  check('no secret configured on the worker → every work endpoint refuses (503)', r0.statusCode === 503);
  process.env.MEDIA_WORKER_SECRET = 'test-secret-for-the-suite';
  for (const url of ['/strip-metadata', '/transcode-video', '/enhance']) {
    const none = await app.inject({ method: 'POST', url, payload: {} });
    const wrong = await app.inject({ method: 'POST', url, payload: {}, headers: { [SECRET_HEADER]: 'wrong' } });
    check(`${url}: without the secret 401, with a wrong one 401`, none.statusCode === 401 && wrong.statusCode === 401, `${none.statusCode}/${wrong.statusCode}`);
  }
  const health = await app.inject({ method: 'GET', url: '/health' });
  check('GET /health stays open (static status, no work)', health.statusCode === 200);
  // CORS preflight (Astra's P3 on #4): a malformed one (no Origin, or no Access-Control-Request-Method) got
  // @fastify/cors's plain-text "400 Invalid Preflight Request", outside the codes. Now exactly 400 {error: bad-request};
  // the positive control, a real preflight from mixmi's origin, is still 204 with its CORS headers and no body
  const pre = (headers) => app.inject({ method: 'OPTIONS', url: '/strip-metadata', headers });
  for (const [label, headers] of [['no headers', {}], ['an Origin but no Access-Control-Request-Method', { origin: 'https://mixmi.io' }], ['a method but no Origin', { 'access-control-request-method': 'POST' }]]) {
    const r = await pre(headers);
    check(`a malformed CORS preflight (${label}) → 400 {"error":"bad-request"} exactly, as JSON`, r.statusCode === 400 && r.body === '{"error":"bad-request"}' && /^application\/json/.test(r.headers['content-type']), `${r.statusCode} ${r.body.slice(0, 80)}`);
  }
  const good = await pre({ origin: 'https://mixmi.io', 'access-control-request-method': 'POST' });
  check('positive control: a real preflight from https://mixmi.io → 204, its origin allowed, POST allowed, no body', good.statusCode === 204 && good.headers['access-control-allow-origin'] === 'https://mixmi.io' && /POST/.test(good.headers['access-control-allow-methods']) && good.body === '', `${good.statusCode} ${JSON.stringify(good.headers)}`);
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}

(async () => {
  const stale = await jobDirs();
  for (const d of stale) await rm(path.join(os.tmpdir(), d), { recursive: true, force: true });
  await library();
  await storage();
  await endpoints();
  console.log(`\n${fail ? `❌ FAILURES — ${pass}/${pass + fail}` : `✅ ALL PASS — ${pass}/${pass + fail}`} checks`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
