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
    const out = path.join(os.tmpdir(), `wt-${Date.now()}-${file}.${format}`);
    await media.stripVideoMetadata(input, out, format);
    await media.blankMetadataBoxes(out);
    const after = await media.metadataReport(out, 'iso');
    check(`${file}: after — no metadata boxes, tags or data streams; no location bytes`, after.clean && media.locationMarkers(await readFile(out)).length === 0, JSON.stringify(after));
    check(`${file}: container kept — output brand ${brand}`, (await media.containerBrand(out)) === brand);
    check(`${file}: same streams and duration`, media.sameContent(await media.streamSummary(input), await media.streamSummary(out)));
    await rm(out, { force: true });
  }
  {
    // the mp4 muxer's own empty udta/meta: the verifier sees it; blanking removes it
    const out = path.join(os.tmpdir(), `wt-${Date.now()}-muxer.mp4`);
    await media.stripVideoMetadata(FIX('gps-video.mp4'), out, 'mp4');
    const raw = await media.metadataReport(out, 'iso');
    check('verification is structural: a bare remux still has the muxer\'s udta/meta — caught', !raw.clean && raw.leftovers.includes('box:udta'), JSON.stringify(raw));
    await rm(out, { force: true });
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
    check('with the neutralizer sabotaged, the OUTPUT re-scan refuses: 500 "private data survived", nothing written (fails if verifySei is removed)', sab.r.statusCode === 500 && sab.uploaded === null && /private data survived/.test(sab.json?.error || ''), `${sab.r.statusCode} ${sab.r.body.slice(0, 120)}`);
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
    check('private user data in the SAME SEI NAL as picture_timing → REFUSED (415), nothing written', mIn.refuseNals === 1 && cm.r.statusCode === 415 && cm.uploaded === null && /picture-relevant|shares/.test(cm.json?.error || ''), `${JSON.stringify(mIn)} ${cm.r.statusCode} ${cm.r.body.slice(0, 120)}`);
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
    check(`enhance: 30 s of audio with timestamps squeezed ×10 (declares ${dA.toFixed(1)} s), cap 10 s → 413 measured by SAMPLES (~11 s counted, then stopped)`, dA < 4 && e1.r.statusCode === 413 && /measured: 1[01]\.\d\+ s of audio/.test(e1.json?.error || '') && e1.uploaded === null, `${e1.r.statusCode} ${e1.r.body.slice(0, 140)}`);
    const s1 = await withEnv('STRIP_MAX_DURATION_SEC', '10', () => call('/strip-metadata', fs.readFileSync(squeezedAudio)));
    check('strip: the same squeezed audio, cap 10 s → 413 measured by samples', s1.r.statusCode === 413 && /measured/.test(s1.json?.error || '') && s1.uploaded === null, `${s1.r.statusCode} ${s1.r.body.slice(0, 140)}`);
    const t1 = await withEnv('TRANSCODE_MAX_DURATION_SEC', '20', () => call('/transcode-video', fs.readFileSync(squeezedVideo)));
    check(`transcode: 1800 frames with timestamps squeezed ×10 (declares ${dV.toFixed(1)} s), cap 20 s → 413 by FRAME COUNT (budget 20 × 60)`, dV < 7 && t1.r.statusCode === 413 && /measured: \d{4}\+ frames/.test(t1.json?.error || '') && t1.uploaded === null, `${t1.r.statusCode} ${t1.r.body.slice(0, 140)}`);
    // 601 s, duration-less live WebM (ordinary MediaRecorder output) through transcode — with audio, and picture-only
    const live = path.join(tmp, 'live601.webm'), liveV = path.join(tmp, 'live601v.webm');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=601:size=32x32:rate=5', '-f', 'lavfi', '-i', 'sine=duration=601', '-c:v', 'libvpx', '-b:v', '20k', '-c:a', 'libopus', '-b:a', '16k', '-live', '1', '-f', 'webm', live]);
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=601:size=32x32:rate=5', '-c:v', 'libvpx', '-b:v', '20k', '-live', '1', '-f', 'webm', liveV]);
    const noDur = async (f) => { const d = (await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).trim(); return d === '' || d === 'N/A'; };
    const t2 = await call('/transcode-video', fs.readFileSync(live), { type: 'video/webm' });
    check('transcode: a 601 s live WebM with NO declared duration (video + audio), cap 600 s → 413 — over by samples AND by timestamp span, nothing written', (await noDur(live)) && t2.r.statusCode === 413 && /601\.\d\+ s of audio/.test(t2.json?.error || '') && /timestamps span 601\.\d s/.test(t2.json?.error || '') && t2.uploaded === null, `${t2.r.statusCode} ${t2.r.body.slice(0, 140)}`);
    const t3 = await call('/transcode-video', fs.readFileSync(liveV), { type: 'video/webm' });
    check('transcode: a picture-only 5-fps live WebM, 601 s with NO declared duration (3005 frames — far under the frame budget) → 413 BEFORE any transcoding, by its timestamp span; nothing written', (await noDur(liveV)) && t3.r.statusCode === 413 && /Source exceeds the 600s cap \(measured: timestamps span 601\.\d s\)/.test(t3.json?.error || '') && t3.uploaded === null, `${t3.r.statusCode} ${t3.r.body.slice(0, 140)}`);
    // strip: hard byte limit (-fs) and exact packet counts
    const song = path.join(tmp, 'song.mp3');
    await sh('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=30', '-c:a', 'libmp3lame', '-b:a', '128k', song]);
    const s2 = await withEnv('STRIP_MAX_OUTPUT_BYTES', '100000', () => call('/strip-metadata', fs.readFileSync(song)));
    const stopped = Number(/stopped at (\d+) bytes/.exec(s2.json?.error || '')?.[1]);
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
    check('strip: first audio stream 2 s, SECOND 30 s, cap 10 s → 413, the second stream measured', c.r.statusCode === 413 && /audio stream 2/.test(c.json?.error || '') && c.uploaded === null, `${c.r.statusCode} ${c.r.body.slice(0, 160)}`);
  }
  {
    // each HARD limit on its own: the real command line (lib/commands) on an input over its cap — the measuring that normally refuses such input first is bypassed
    const commands = require('../lib/commands');
    const proc = require('../lib/proc');
    const limits = require('../lib/limits');
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
    let osErr = null; try { await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', ten, '-c:a', 'pcm_s16le', osOut], { fsizeBytes: 100000, cwd: tmp }); } catch (e) { osErr = e; }
    const osBytes = (await stat(osOut)).size;
    check(`OS file-size limit: an ffmpeg with no -fs, writing ~880 KB under a 100000-byte limit → stopped (SIGXFSZ, OsLimitError) at ${osBytes} bytes`, osErr instanceof proc.OsLimitError && osBytes <= 100000, String(osErr));
    let zErr = null; try { await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', ten, path.join(tmp, 'os-zero.wav')], { fsizeBytes: 0, cwd: tmp }); } catch (e) { zErr = e; }
    check('OS file-size limit 0 (probes and counting): any file write is stopped', zErr instanceof proc.OsLimitError, String(zErr));
    process.env.WORKER_CPU_LIMIT_SEC = '1';
    const t0 = Date.now();
    let cpuErr = null; try { await proc.run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '20', '-c:v', 'libx264', '-preset', 'veryslow', '-threads', '1', path.join(tmp, 'os-cpu.mp4')], { fsizeBytes: 1e9, cwd: tmp }); } catch (e) { cpuErr = e; } finally { delete process.env.WORKER_CPU_LIMIT_SEC; }
    check(`OS CPU limit: a 1 s limit stops a long single-thread encode (after ${((Date.now() - t0) / 1000).toFixed(1)} s) → the run fails`, !!cpuErr && Date.now() - t0 < 15_000, String(cpuErr));
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
      frames === 200 && c.r.statusCode === 413 && /expands past/.test(c.json?.error || '') && c.uploaded === null && after.length === before.length, `${frames} ${c.r.statusCode} ${c.r.body.slice(0, 140)}`);
    await rm(exp, { force: true });
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
    check('enhance: a 10 s input with a 5 s cap → 413 (measured) before any processing, nothing written', d.r.statusCode === 413 && /measured/.test(d.json?.error || '') && d.uploaded === null, `${d.r.statusCode} ${d.r.body.slice(0, 100)}`);
    // a container that declares NO duration (live WebM, like MediaRecorder's): measured, not trusted
    const live = path.join(tmp, 'live.webm');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=10', '-c:a', 'libopus', '-live', '1', '-f', 'webm', live]);
    const declared = JSON.parse(await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', live])).format?.duration;
    process.env.ENHANCE_MAX_DURATION_SEC = '5';
    const lv = await call('/enhance', await readFile(live), { body: { enhancementType: 'clean' } });
    delete process.env.ENHANCE_MAX_DURATION_SEC;
    check(`enhance: 10 s of audio whose container declares ${declared === undefined ? 'NO' : declared + ' s of'} duration → MEASURED, 413 (measured), nothing written`, (declared === undefined || declared === 'N/A') && lv.r.statusCode === 413 && /measured/.test(lv.json?.error || '') && lv.uploaded === null, `${declared} ${lv.r.statusCode} ${lv.r.body.slice(0, 100)}`);
    // 30 s → ~2.9 MB of WAV; cap 1 MB. (Longer than loudnorm's 3 s look-ahead, so output streams and -fs can act.)
    const thirty = path.join(tmp, 'thirty.mp3');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=30', '-c:a', 'libmp3lame', '-b:a', '8k', thirty]);
    process.env.ENHANCE_MAX_OUTPUT_BYTES = '1000000';
    const o = await call('/enhance', await readFile(thirty), { body: { enhancementType: 'clean' } });
    delete process.env.ENHANCE_MAX_OUTPUT_BYTES;
    const stopped = Number(/stopped at (\d+) bytes/.exec(o.json?.error || '')?.[1]);
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
      check('with the strip sabotaged, the OUTPUT VERIFICATION refuses: 500 and nothing written back (fails if verifyClean is removed)', c.r.statusCode === 500 && c.uploaded === null && /metadata survived/.test(c.json?.error || ''), `${c.r.statusCode} ${c.r.body.slice(0, 160)}`);
    } finally {
      media.stripMedia = realStrip;
      media.blankMetadataBoxes = realBlank;
    }
  }
  {
    const c = await call('/strip-metadata', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.mp4' } }));
    check('the source redirects (302) → refused (500), nothing written', c.r.statusCode === 500 && c.uploaded === null && /redirect/.test(c.json?.error || ''), c.r.body.slice(0, 120));
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
