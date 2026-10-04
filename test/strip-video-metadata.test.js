// node test/strip-video-metadata.test.js — needs ffmpeg/ffprobe on PATH.
// Each fixture carries a location (a made-up point in open ocean): the strip
// must leave none, keep the picture (and sound), and keep the container.
const path = require('path');
const { readFile, unlink } = require('fs/promises');
const { videoHasMetadata, stripVideoMetadata, locationMarkers } = require('../lib/stripVideoMetadata');
const ffmpeg = require('fluent-ffmpeg');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => { if (ok) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); } };
const probe = (f) => new Promise((res, rej) => ffmpeg.ffprobe(f, (e, d) => (e ? rej(e) : res(d))));

(async () => {
  for (const [file, format, expect] of [['gps-video.mp4', 'mp4', 'loci'], ['gps-video.mov', 'mov', 'ISO6709'], ['gps-video-xyz.mov', 'mov', '©xyz']]) {
    console.log(`\n${file}`);
    const input = path.join(__dirname, 'fixtures', file);
    const output = path.join('/tmp', `strip-test-${Date.now()}-${file}`);
    const before = await videoHasMetadata(input);
    check(`carries location (${expect}) before`, before.location && locationMarkers(await readFile(input)).includes(expect), JSON.stringify(before));
    await stripVideoMetadata(input, output, format);
    const after = await videoHasMetadata(output);
    const out = await readFile(output);
    check('after: no location markers, no format tags, no data tracks', !after.location && after.formatTags === 0 && after.dataStreams === 0 && locationMarkers(out).length === 0, JSON.stringify(after));
    const pi = await probe(input), po = await probe(output);
    const v = (p) => (p.streams || []).filter((s) => s.codec_type === 'video').map((s) => `${s.codec_name} ${s.width}x${s.height}`).join(',');
    const a = (p) => (p.streams || []).filter((s) => s.codec_type === 'audio').length;
    check('picture kept (same codec and size, no re-encode)', v(pi) === v(po) && v(po) !== '', `${v(pi)} → ${v(po)}`);
    check('sound kept (same number of audio tracks)', a(pi) === a(po), `${a(pi)} → ${a(po)}`);
    check(`container kept (${format})`, (format === 'mov' ? /mov/ : /mp4/).test(po.format.format_name), po.format.format_name);
    check('duration kept', Math.abs(Number(pi.format.duration) - Number(po.format.duration)) < 0.3, `${pi.format.duration} → ${po.format.duration}`);
    await unlink(output).catch(() => {});
  }
  console.log(`\n${fail ? `❌ FAILURES — ${pass}/${pass + fail}` : `✅ ALL PASS — ${pass}/${pass + fail}`} checks`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
