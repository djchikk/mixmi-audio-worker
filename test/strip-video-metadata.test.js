// node test/strip-video-metadata.test.js — needs ffmpeg/ffprobe on PATH.
// Each fixture carries a location (a made-up point in open ocean): the strip
// must leave none, keep the picture and sound, and keep the container. Then
// the guards: the shared secret, the Storage-only URLs, the size cap, and the
// before/after match.
const path = require('path');
const { readFile, unlink } = require('fs/promises');
const { videoHasMetadata, stripVideoMetadata, locationMarkers, streamSummary, sameContent, containerBrand } = require('../lib/stripVideoMetadata');
const { secretOk, allowedStorageUrl, downloadCapped, TooLargeError, SECRET_HEADER } = require('../lib/guards');
const ffmpeg = require('fluent-ffmpeg');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); } };
const probe = (f) => new Promise((res, rej) => ffmpeg.ffprobe(f, (e, d) => (e ? rej(e) : res(d))));

async function strips() {
  // [file, the container the probe must choose, the location atom it carries]
  // *-free-first: the file opens with a `free` box and has no ftyp (Astra's
  // finding 4) — the container is still decided by probing, never the first box.
  for (const [file, format, expect] of [['gps-video.mp4', 'mp4', 'loci'], ['gps-video.mov', 'mov', 'ISO6709'], ['gps-video-xyz.mov', 'mov', '©xyz'], ['gps-audio.m4a', 'mp4', 'loci'], ['gps-video-free-first.mov', 'mov', 'ISO6709'], ['gps-audio-free-first.m4a', 'mov', 'loci']]) {
    console.log(`\n${file}`);
    const input = path.join(__dirname, 'fixtures', file);
    const brand = await containerBrand(input);
    check(`container decided by probing: ${format}`, brand !== null && (brand === 'qt' ? 'mov' : 'mp4') === format, String(brand));
    const output = path.join('/tmp', `strip-test-${Date.now()}-${file}`);
    const before = await videoHasMetadata(input);
    check(`carries location (${expect}) before`, before.location && locationMarkers(await readFile(input)).includes(expect), JSON.stringify(before));
    await stripVideoMetadata(input, output, format);
    const after = await videoHasMetadata(output);
    const out = await readFile(output);
    check('after: no location markers, no format tags, no data tracks', !after.location && after.formatTags === 0 && after.dataStreams === 0 && locationMarkers(out).length === 0, JSON.stringify(after));
    const pi = await probe(input), po = await probe(output);
    const v = (p) => (p.streams || []).filter((s) => s.codec_type === 'video').map((s) => `${s.codec_name} ${s.width}x${s.height}`).join(',');
    check('picture kept (same codec and size, or none for audio), no re-encode', v(pi) === v(po), `${v(pi)} → ${v(po)}`);
    check(`container kept (${format})`, (format === 'mov' ? /mov/ : /mp4/).test(po.format.format_name), po.format.format_name);
    const [si, so] = await Promise.all([streamSummary(input), streamSummary(output)]);
    check('same streams and duration (the check the endpoint makes before uploading)', sameContent(si, so), JSON.stringify({ si, so }));
    await unlink(output).catch(() => {});
  }
  const notIso = path.join('/tmp', `strip-test-${Date.now()}-not-iso`);
  await require('fs/promises').writeFile(notIso, Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00 just some bytes, not a container'));
  check('a file that is not ISO media → no container (the endpoint refuses it, 415)', (await containerBrand(notIso)) === null);
  await unlink(notIso).catch(() => {});
  check('a lost stream fails the match', !sameContent({ video: 1, audio: 1, duration: 1 }, { video: 1, audio: 0, duration: 1 }));
  check('a changed duration fails the match', !sameContent({ video: 1, audio: 0, duration: 10 }, { video: 1, audio: 0, duration: 8 }));
}

async function guards() {
  console.log('\nGuards');
  check('the right secret passes', secretOk('s3cret-value', 's3cret-value'));
  check('a wrong, empty or missing secret fails', !secretOk('nope', 's3cret-value') && !secretOk('', 's3cret-value') && !secretOk(undefined, 's3cret-value'));
  check('no secret configured → nothing passes (fail closed)', !secretOk('anything', undefined) && !secretOk('', ''));
  const env = { SUPABASE_URL: 'https://abc.supabase.co' };
  const S = 'https://abc.supabase.co/storage/v1/object';
  check('reads: only signed URLs into the private incoming bucket on our Storage host', allowedStorageUrl(`${S}/sign/media-incoming/0xabc/5f1e.mov?token=t`, 'read', env));
  check('reads: public objects, other buckets, unsigned, another host, plain http, other APIs — all refused',
    !allowedStorageUrl(`${S}/public/video-clips/a.mp4`, 'read', env) &&
    !allowedStorageUrl(`${S}/public/media-incoming/0xabc/a`, 'read', env) &&
    !allowedStorageUrl(`${S}/sign/video-clips/a.mp4?token=t`, 'read', env) &&
    !allowedStorageUrl(`${S}/sign/media-incoming/0xabc/a`, 'read', env) &&
    !allowedStorageUrl(`${S}/sign/media-incoming/../video-clips/a?token=t`, 'read', env) &&
    !allowedStorageUrl('https://evil.example/storage/v1/object/sign/media-incoming/a?token=t', 'read', env) &&
    !allowedStorageUrl('http://abc.supabase.co/storage/v1/object/sign/media-incoming/a?token=t', 'read', env) &&
    !allowedStorageUrl(`${S}/authenticated/media-incoming/a`, 'read', env) &&
    !allowedStorageUrl('https://abc.supabase.co/rest/v1/personas', 'read', env));
  check('uploads: only signed upload URLs into the private incoming bucket',
    allowedStorageUrl(`${S}/upload/sign/media-incoming/0xabc/5f1e.mov.clean?token=t`, 'upload', env) &&
    !allowedStorageUrl(`${S}/upload/sign/video-clips/a.mp4?token=t`, 'upload', env) &&
    !allowedStorageUrl(`${S}/sign/media-incoming/a?token=t`, 'upload', env) &&
    !allowedStorageUrl('https://evil.example/storage/v1/object/upload/sign/media-incoming/a?token=t', 'upload', env));
  let gotBody = false;
  // a body that records whether it was ever read
  const fakeFetch = (len, actual) => async () => {
    const body = new ReadableStream({ pull(c) { gotBody = true; c.enqueue(new Uint8Array(actual)); c.close(); } }, { highWaterMark: 0 });
    return new Response(body, { status: 200, headers: len === null ? {} : { 'content-length': String(len) } });
  };
  gotBody = false;
  let e1 = null; try { await downloadCapped('u', 100, fakeFetch(1000, 1000)); } catch (e) { e1 = e; }
  check('too large by Content-Length → refused BEFORE the body is read', e1 instanceof TooLargeError && !gotBody);
  let e2 = null; try { await downloadCapped('u', 100, fakeFetch(null, 500)); } catch (e) { e2 = e; }
  check('no Content-Length but too large while streaming → refused', e2 instanceof TooLargeError);
  const ok = await downloadCapped('u', 100, fakeFetch(50, 50));
  check('within the cap → downloaded', ok.buffer.length === 50);
}

async function http() {
  console.log('\nThe secret, at the HTTP level');
  const app = require('../index.js');
  await app.ready();
  const body = { sourceUrl: 'https://evil.example/x.mp4', uploadUrl: 'https://evil.example/up' };
  delete process.env.MEDIA_WORKER_SECRET;
  const r0 = await app.inject({ method: 'POST', url: '/strip-video-metadata', payload: body });
  check('no secret configured on the worker → every work endpoint refuses (503)', r0.statusCode === 503);
  process.env.MEDIA_WORKER_SECRET = 'test-secret-for-the-suite';
  for (const url of ['/strip-video-metadata', '/transcode-video', '/enhance']) {
    const none = await app.inject({ method: 'POST', url, payload: body });
    const wrong = await app.inject({ method: 'POST', url, payload: body, headers: { [SECRET_HEADER]: 'wrong' } });
    check(`${url}: without the secret 401, with a wrong one 401`, none.statusCode === 401 && wrong.statusCode === 401, `${none.statusCode}/${wrong.statusCode}`);
  }
  const right = await app.inject({ method: 'POST', url: '/strip-video-metadata', payload: body, headers: { [SECRET_HEADER]: 'test-secret-for-the-suite' } });
  check('with the secret, a source outside our Storage is still refused (400)', right.statusCode === 400, right.body);

  console.log('\nThe endpoint, end to end (signed incoming URLs, stubbed Storage)');
  process.env.SUPABASE_URL = 'https://abc.supabase.co';
  const S = 'https://abc.supabase.co/storage/v1/object';
  const realFetch = global.fetch;
  const run = async (fixture, storage = {}) => {
    const src = await readFile(path.join(__dirname, 'fixtures', fixture));
    let uploaded = null;
    global.fetch = async (url, opts = {}) => {
      if (String(url).startsWith(`${S}/sign/`)) return storage.read ? storage.read() : new Response(src, { status: 200, headers: { 'content-length': String(src.length) } });
      if (String(url).startsWith(`${S}/upload/sign/`)) { uploaded = Buffer.from(opts.body); return storage.upload ? storage.upload() : new Response('{}', { status: 200 }); }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const r = await app.inject({ method: 'POST', url: '/strip-video-metadata', headers: { [SECRET_HEADER]: 'test-secret-for-the-suite' },
        payload: { sourceUrl: `${S}/sign/media-incoming/0xabc/1.bin?token=r`, uploadUrl: `${S}/upload/sign/media-incoming/0xabc/1.bin.clean?token=w` } });
      return { r, json: (() => { try { return JSON.parse(r.body); } catch { return null; } })(), uploaded };
    } finally { global.fetch = realFetch; }
  };
  for (const fx of ['gps-video-free-first.mov', 'gps-audio-free-first.m4a', 'gps-video.mp4']) {
    const { r, json, uploaded } = await run(fx);
    check(`${fx} (named 1.bin in incoming): stripped, and the clean copy written back carries no location`,
      r.statusCode === 200 && json?.success === true && json?.stripped === true && typeof json?.jobId === 'string' && uploaded && locationMarkers(uploaded).length === 0,
      `${r.statusCode} ${r.body.slice(0, 160)}`);
  }
  {
    const { r, uploaded } = await run('gps-video.mp4', { read: () => new Response('nope', { status: 404 }) });
    check('the signed read fails → 500, nothing written', r.statusCode === 500 && uploaded === null, `${r.statusCode}`);
  }
  {
    const { r } = await run('gps-video.mp4', { upload: () => new Response('denied', { status: 403 }) });
    check('the write-back fails → 500 (never a success)', r.statusCode === 500, `${r.statusCode}`);
  }
  {
    global.fetch = async () => new Response(Buffer.from('ID3 not a container at all, just bytes'), { status: 200 });
    const r = await app.inject({ method: 'POST', url: '/strip-video-metadata', headers: { [SECRET_HEADER]: 'test-secret-for-the-suite' },
      payload: { sourceUrl: `${S}/sign/media-incoming/0xabc/2?token=r`, uploadUrl: `${S}/upload/sign/media-incoming/0xabc/2.clean?token=w` } });
    global.fetch = realFetch;
    check('bytes that are not ISO media → 415', r.statusCode === 415, `${r.statusCode}`);
  }
  {
    const r = await app.inject({ method: 'POST', url: '/strip-video-metadata', headers: { [SECRET_HEADER]: 'test-secret-for-the-suite' },
      payload: { sourceUrl: `${S}/public/video-clips/0xabc/a.mp4`, uploadUrl: `${S}/upload/sign/media-incoming/0xabc/2.clean?token=w` } });
    check('a public object as the source → 400 (only the private incoming bucket)', r.statusCode === 400, `${r.statusCode}`);
  }
  const health = await app.inject({ method: 'GET', url: '/health' });
  check('GET /health stays open (static status, no work)', health.statusCode === 200);
  await app.close();
}

(async () => {
  await strips();
  await guards();
  await http();
  console.log(`\n${fail ? `❌ FAILURES — ${pass}/${pass + fail}` : `✅ ALL PASS — ${pass}/${pass + fail}`} checks`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
