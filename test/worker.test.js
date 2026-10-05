// The worker's safety tests (Astra's HOLDs on worker #3). Every breaking input
// goes through the REAL endpoints (Fastify inject) with Storage stubbed at
// fetch, plus the library pieces underneath.
//
// Fixtures carry a location (a made-up point in open ocean); *-free-first are
// the same files with the ftyp retyped to `free` (no ftyp: legacy QuickTime).
// Run: npm test  (needs ffmpeg + ffprobe on PATH)
const path = require('path');
const os = require('os');
const { readFile, writeFile, copyFile, readdir, mkdtemp, rm } = require('fs/promises');
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
    check('the vendor allowlist: encoder identities pass, free text does not', media.vendorOk('ffmpeg') && media.vendorOk('Xiph.Org libVorbis I 20200704 (Reducing Environment)') && media.vendorOk('libopus 1.5.2') && media.vendorOk('Lavf61.7.100') && !media.vendorOk('GPS 0.5 0.5') && !media.vendorOk('Xiph.Org libVorbis I 20200704 (lat 51.5)') && !media.vendorOk(''));
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
    // H.264 user_data_unregistered SEI
    const plain = path.join(tmp, 'sei-plain.mp4'), ud = path.join(tmp, 'sei-ud.mp4'), orient = path.join(tmp, 'sei-orient.mp4'), hevc = path.join(tmp, 'sei.hevc.mp4');
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10', '-f', 'lavfi', '-i', 'sine=duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', plain]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', plain, '-c', 'copy', '-bsf:v', 'h264_metadata=sei_user_data=086f3693-b7b3-4f2c-9653-21492feee5b8+GPS 0.5 0.5 Fixtureville', ud]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', ud, '-c', 'copy', '-bsf:v', 'h264_metadata=display_orientation=insert:rotate=90', orient]);
    await sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=128x96:rate=10', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=none', hevc]);
    const inUd = await sei.seiReport(ud, 'h264', tmp);
    const c = await call('/strip-metadata', await readFile(ud));
    const out = c.uploaded && await writeTmp(c.uploaded, '.mp4');
    const outSei = out && await sei.seiReport(out, 'h264', tmp);
    check('H.264 user-data SEI ("GPS … Fixtureville"): found before; 200, gone from the bitstream (re-scan: no private payload), picture frames and PCM IDENTICAL',
      inUd.disallowed === 1 && c.r.statusCode === 200 && outSei?.disallowed === 0 && !c.uploaded.includes(Buffer.from('Fixtureville')) && (await frameHash(ud)) === (await frameHash(out)) && (await pcmHash(ud)) === (await pcmHash(out)),
      `${JSON.stringify(inUd)} ${c.r.statusCode} ${c.r.body.slice(0, 100)} ${JSON.stringify(outSei)}`);
    if (out) await rm(out, { force: true });
    const cp = await call('/strip-metadata', await readFile(plain));
    const pOut = cp.uploaded && await writeTmp(cp.uploaded, '.mp4');
    check('only the allowlisted x264 settings SEI: kept as it is (no SEI dropped), 200', cp.r.statusCode === 200 && (await sei.seiReport(pOut, 'h264', tmp)).allowed === 1 && (await frameHash(plain)) === (await frameHash(pOut)));
    if (pOut) await rm(pOut, { force: true });
    // the output SEI scan is what stops a miss: sabotage the drop filter into a no-op
    const realDrop = sei.dropSeiFilter;
    sei.dropSeiFilter = () => 'null';
    let sab;
    try { sab = await call('/strip-metadata', await readFile(ud)); } finally { sei.dropSeiFilter = realDrop; }
    check('with the SEI drop sabotaged, the OUTPUT bitstream scan refuses: 500 "private user data survived", nothing written (fails if verifySei is removed)', sab.r.statusCode === 500 && sab.uploaded === null && /private user data survived/.test(sab.json?.error || ''), `${sab.r.statusCode} ${sab.r.body.slice(0, 120)}`);
    const co = await call('/strip-metadata', await readFile(orient));
    check('private user data BESIDE picture-relevant SEI (display orientation) → REFUSED (415), nothing written', co.r.statusCode === 415 && co.uploaded === null, `${co.r.statusCode} ${co.r.body.slice(0, 120)}`);
    const ch = await call('/strip-metadata', await readFile(hevc));
    check('HEVC with only x265\'s allowlisted settings SEI: 200', ch.r.statusCode === 200, `${ch.r.statusCode} ${ch.r.body.slice(0, 120)}`);
  }
  {
    // the scanner across chunk boundaries: SEI NALs straddling the 1 MB reads
    const sc = (b) => Buffer.from([0, 0, 0, 1, ...b]);
    const udSei = (text) => { const payload = Buffer.concat([Buffer.from('086f3693b7b34f2c965321492feee5b8', 'hex'), Buffer.from(text)]); return sc([0x06, 5, payload.length, ...payload, 0x80]); };
    const filler = (n) => sc([0x0c, ...Buffer.alloc(n, 0xff)]); // filler NAL (type 12)
    const parts = [filler((1 << 20) - 30), udSei('GPS 1'), filler((1 << 20) - 10), udSei('GPS 2'), filler(5000), udSei('GPS 3')];
    const es = await writeTmp(Buffer.concat(parts), '.h264');
    const r = await sei.scanAnnexB(es, 'h264');
    check('SEI scan: payloads straddling the 1 MB chunk boundaries are all found (3)', r.disallowed === 3, JSON.stringify({ types: Object.fromEntries(r.types), disallowed: r.disallowed }));
    await rm(es, { force: true });
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
    check('enhance: a 10 s input with a 5 s cap → 413 before any processing, nothing written', d.r.statusCode === 413 && d.uploaded === null, `${d.r.statusCode} ${d.r.body.slice(0, 100)}`);
    process.env.ENHANCE_MAX_OUTPUT_BYTES = '100000';
    const o = await call('/enhance', await readFile(short), { body: { enhancementType: 'clean' } });
    delete process.env.ENHANCE_MAX_OUTPUT_BYTES;
    check('enhance: an output over the byte cap (3 s → ~290 KB, cap 100 KB) → 413, cut off by -fs, nothing written', o.r.statusCode === 413 && o.uploaded === null, `${o.r.statusCode} ${o.r.body.slice(0, 100)}`);
    const ok = await call('/enhance', await readFile(short), { body: { enhancementType: 'clean' } });
    check('enhance within the caps: 200, and the upload is STREAMED (a ReadableStream body, duplex half, exact Content-Length)', ok.r.statusCode === 200 && ok.uploadInit?.duplex === 'half' && !Buffer.isBuffer(ok.uploadInit?.body) && typeof ok.uploadInit?.body?.getReader === 'function' && Number(ok.uploadHeaders?.['Content-Length']) === ok.uploaded?.length, `${ok.r.statusCode} ${JSON.stringify(ok.uploadHeaders)}`);
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
