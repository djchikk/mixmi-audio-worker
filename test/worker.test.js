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
const media = require('../lib/stripVideoMetadata');
const io = require('../lib/storageIO');
const { secretOk, SECRET_HEADER } = require('../lib/guards');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); } };
const FIX = (f) => path.join(__dirname, 'fixtures', f);
const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
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
    check(`${file}: carries metadata before (boxes ${before.boxes.join(',')})`, !before.clean && media.locationMarkers(await readFile(input)).length > 0);
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
    check('verification is structural: a bare remux still has the muxer\'s udta/meta — caught', !raw.clean && raw.boxes.includes('udta'), JSON.stringify(raw));
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
    let uploaded = null, uploadHeaders = null;
    global.fetch = async (url, o = {}) => {
      if (o.redirect !== 'manual') throw new Error('a request without redirect: manual');
      const u = String(url);
      if (u.startsWith(`${S}/sign/`)) return typeof src === 'function' ? src() : new Response(src, { status: 200, headers: { 'content-length': String(src.length), 'content-type': opts.type || 'application/octet-stream' } });
      if (u.startsWith(`${S}/upload/sign/`)) { uploaded = Buffer.from(o.body); uploadHeaders = o.headers; return opts.upload ? opts.upload() : new Response('{"Key":"x"}', { status: 200 }); }
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
      return { r, json, uploaded, uploadHeaders, logs: logs.join('') };
    } finally {
      app.log.info = realInfo;
      app.log.error = realError;
      global.fetch = realFetch;
    }
  };
  const writtenReport = async (buf, kind) => { const f = path.join(tmp, `w-${Date.now()}`); await writeFile(f, buf); const rep = await media.metadataReport(f, kind); const brand = kind === 'iso' ? await media.containerBrand(f) : null; await rm(f, { force: true }); return { ...rep, brand }; };
  const allLogs = [];

  for (const [fx, brand] of [['gps-video-free-first.mov', 'qt'], ['gps-audio-free-first.m4a', 'qt'], ['gps-video.mp4', 'isom'], ['gps-video.mov', 'qt'], ['gps-video-xyz.mov', 'qt'], ['gps-audio.m4a', 'isom']]) {
    const c = await call('/strip-video-metadata', await readFile(FIX(fx)));
    allLogs.push(c.logs);
    const rep = c.uploaded && await writtenReport(c.uploaded, 'iso');
    check(`strip ${fx} (key without an extension): 200, written back in place clean, brand ${brand} kept`,
      c.r.statusCode === 200 && c.json?.success === true && c.json?.stripped === true && typeof c.json?.jobId === 'string' && rep?.clean && rep.brand === brand && media.locationMarkers(c.uploaded).length === 0,
      `${c.r.statusCode} ${c.r.body.slice(0, 160)} ${JSON.stringify(rep)}`);
  }
  {
    // finding 1: an input with NO tags anything checks by name still gets remuxed (no "already clean" shortcut)
    const bare = path.join(tmp, 'bare.mp4');
    await sh('ffmpeg', ['-v', 'error', '-i', FIX('gps-video.mp4'), '-map', '0:v', '-c', 'copy', '-map_metadata', '-1', '-fflags', '+bitexact', bare]);
    const c = await call('/strip-video-metadata', await readFile(bare));
    check('strip is unconditional: a file with no tags is still remuxed and written back (stripped: true)', c.r.statusCode === 200 && c.json?.stripped === true && !!c.uploaded, c.r.body.slice(0, 160));
  }
  {
    // the output verification is what stops a dirty file: replace the strip with a plain copy
    const realStrip = media.stripVideoMetadata, realBlank = media.blankMetadataBoxes;
    media.stripVideoMetadata = async (input, output) => copyFile(input, output);
    media.blankMetadataBoxes = async () => 0;
    try {
      const c = await call('/strip-video-metadata', await readFile(FIX('gps-video.mov')));
      check('with the strip sabotaged, the OUTPUT VERIFICATION refuses: 500 and nothing written back (fails if verifyClean is removed)', c.r.statusCode === 500 && c.uploaded === null && /metadata survived/.test(c.json?.error || ''), `${c.r.statusCode} ${c.r.body.slice(0, 160)}`);
    } finally {
      media.stripVideoMetadata = realStrip;
      media.blankMetadataBoxes = realBlank;
    }
  }
  {
    const c = await call('/strip-video-metadata', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.mp4' } }));
    check('the source redirects (302) → refused (500), nothing written', c.r.statusCode === 500 && c.uploaded === null && /redirect/.test(c.json?.error || ''), c.r.body.slice(0, 120));
  }
  {
    const c = await call('/strip-video-metadata', await readFile(FIX('gps-video.mp4')), { upload: () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }) });
    check('the upload redirects (307) → refused (500)', c.r.statusCode === 500, c.r.body.slice(0, 120));
  }
  {
    const c = await call('/strip-video-metadata', await readFile(FIX('gps-video.mp4')), { upload: () => new Response('denied', { status: 403 }) });
    check('the write-back is refused (403) → 500, never a success', c.r.statusCode === 500 && c.json?.success !== true);
  }
  {
    const c = await call('/strip-video-metadata', () => new Response('x', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } }));
    check('a source over the cap by Content-Length → 413, nothing written', c.r.statusCode === 413 && c.uploaded === null);
  }
  {
    const c = await call('/strip-video-metadata', () => new Response('nope', { status: 404 }));
    check('the source can\'t be read (404) → 500, nothing written', c.r.statusCode === 500 && c.uploaded === null);
  }
  {
    const c = await call('/strip-video-metadata', Buffer.from('ID3 not a container at all, just bytes, padding padding'));
    check('bytes that are not ISO media → 415, nothing written', c.r.statusCode === 415 && c.uploaded === null);
  }
  for (const [label, opts] of [
    ['another key as the destination (finding 7)', { uploadUrl: upUrl('0xabc/other') }],
    ['a public object as the source', { sourceUrl: `${S}/public/video-clips/0xabc/a.mp4` }],
    ['a public bucket as the destination', { uploadUrl: upUrl('0xabc/5f1e', 'video-clips') }],
    ['another host', { sourceUrl: readUrl().replace(HOST, 'evil.example') }],
  ]) {
    for (const ep of ['/strip-video-metadata', '/transcode-video', '/enhance']) {
      const c = await call(ep, Buffer.from('x'), opts);
      if (c.r.statusCode !== 400 || c.uploaded !== null) { check(`${ep}: ${label} → 400`, false, `${c.r.statusCode}`); }
    }
    check(`every endpoint: ${label} → 400 before any download`, true);
  }

  {
    const c = await call('/transcode-video', await readFile(webm), { type: 'video/webm' });
    allLogs.push(c.logs);
    const rep = c.uploaded && await writtenReport(c.uploaded, 'iso');
    check('transcode: tagged webm → 200, an mp4 written back IN PLACE with no metadata (title and encoder name gone)', c.r.statusCode === 200 && c.json?.success === true && rep?.clean && !c.uploaded.includes(Buffer.from('Lavc')) && rep.brand === 'isom' && !c.uploaded.includes(Buffer.from('Fixtureville')) && c.uploadHeaders?.['Content-Type'] === 'video/mp4', `${c.r.statusCode} ${c.r.body.slice(0, 160)} ${JSON.stringify(rep)}`);
  }
  {
    const c = await call('/transcode-video', () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } }));
    check('transcode: a redirecting source → refused', c.r.statusCode === 500 && c.uploaded === null);
  }
  {
    const c = await call('/enhance', await readFile(wav), { type: 'audio/wav', body: { enhancementType: 'clean' } });
    allLogs.push(c.logs);
    const rep = c.uploaded && await writtenReport(c.uploaded, 'wav');
    check('enhance: tagged WAV → 200, an enhanced WAV written back IN PLACE with only fmt/data chunks (title gone)', c.r.statusCode === 200 && c.json?.success === true && rep?.clean && !c.uploaded.includes(Buffer.from('Fixtureville')), `${c.r.statusCode} ${c.r.body.slice(0, 160)} ${JSON.stringify(rep)}`);
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
  const r0 = await app.inject({ method: 'POST', url: '/strip-video-metadata', payload: {} });
  check('no secret configured on the worker → every work endpoint refuses (503)', r0.statusCode === 503);
  process.env.MEDIA_WORKER_SECRET = 'test-secret-for-the-suite';
  for (const url of ['/strip-video-metadata', '/transcode-video', '/enhance']) {
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
