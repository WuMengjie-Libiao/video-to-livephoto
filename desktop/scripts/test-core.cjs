'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const core = require('../electron/core');

test("Windows 后台线程通过 Path 查找 ffprobe", { skip: process.platform !== "win32" }, async () => {
  const { Worker } = require("node:worker_threads");
  const expected = core.need("ffprobe");
  const worker = new Worker(`(${function () {
    const { parentPort, workerData } = require("node:worker_threads");
    parentPort.postMessage(require(workerData).need("ffprobe"));
  }})()`, { eval: true, workerData: require.resolve("../electron/core"), env: { Path: path.dirname(expected) } });
  const found = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  assert.equal(found, expected);
});

test('截取范围必须落在素材内，短于请求的素材使用实际余长', () => {
  assert.deepEqual(core.clipRange(2, { start: 1.8, duration: 3, stillAt: 'end' }), { start: 1.8, duration: 2 - 1.8, stillTime: (2 - 1.8) / 2 });
  for (const opts of [{ start: 2 }, { start: 5 }, { start: -1 }, { duration: -1 }, { start: Infinity }, { duration: 'bad' }]) {
    assert.throws(() => core.clipRange(2, opts));
  }
  assert.throws(() => core.clipRange(5, { start: 1, duration: 2, cover: 4 }));
  assert.equal(core.clipRange(5, { start: 1, duration: 2, cover: 1.8 }).stillTime, 0.8);
  assert.deepEqual(core.clipRange(5, { start: 1, duration: 3 }), { start: 1, duration: 3, stillTime: 1.5 });
});

test('导出保留源文件及已有结果，同名自动编号，内嵌视频可解码', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-test-'));
  try {
    const src = path.join(dir, 'sample.MOV');
    execFileSync(core.need('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
    const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const original = hash(src);
    const opts = { destination: 'file', outdir: dir, duration: 1, mute: true };
    const first = core.processVideo(src, opts);
    const firstHash = hash(first.path);
    const second = core.processVideo(src, opts);
    assert.notEqual(first.path, second.path);
    assert.equal(hash(first.path), firstHash);
    assert.equal(hash(src), original);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['sample (2).MP.JPG', 'sample.MOV', 'sample.MP.JPG'].sort());
    const check = core.verifyMotionPhoto(first.path);
    assert.equal(check.ok, true);
    assert.equal(/Semantic="Primary"\s+Item:Length="0"/.test(fs.readFileSync(first.path).toString('latin1')), true);
    const embedded = path.join(dir, 'embedded.mp4');
    fs.writeFileSync(embedded, fs.readFileSync(first.path).subarray(check.stillLen));
    const info = JSON.parse(execFileSync(core.need('ffprobe'), ['-v','error','-show_streams','-of','json',embedded]));
    assert.equal(info.streams.some(s => s.codec_type === 'audio'), false);
    execFileSync(core.need('ffmpeg'), ['-v','error','-i',embedded,'-f','null','-']);
    assert.throws(() => core.processVideo(src, { ...opts, start: 9 }));
    assert.equal(fs.readdirSync(dir).length, 4);
    if (process.platform === 'darwin') {
      const pair = core.prepareDelivery(src, { destination: 'photos', duration: 1, cover: 0.5 });
      try {
        assert.equal(pair.validated, true);
        assert.throws(() => require('../electron/native').runSync(['validate', pair.still, src]));
        const movie = JSON.parse(execFileSync(core.need('ffprobe'), ['-v','error','-show_streams','-show_format','-of','json',pair.movie]));
        assert.equal(movie.format.tags['com.apple.quicktime.content.identifier'], pair.identifier);
        assert.ok(movie.streams.some(s => s.codec_type === 'data'));
        assert.ok(movie.streams.some(s => s.codec_type === 'audio'));
      } finally { fs.rmSync(pair.directory, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('本地视频支持精确分段读取、尾部读取与非法范围拒绝', async () => {
  const { mediaResponse } = require('../electron/media-response');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-range-'));
  const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, '0123456789');
  try {
    for (const [range, expected] of [['bytes=2-5', '2345'], ['bytes=7-', '789'], ['bytes=-3', '789']]) {
      const response = mediaResponse(file, range);
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-length'), String(expected.length));
      assert.equal(await response.text(), expected);
    }
    for (const range of ['bytes=20-', 'bytes=5-2', 'bytes=-0', 'bytes=']) {
      assert.equal(mediaResponse(file, range).status, 416);
    }
    assert.equal(mediaResponse(file, null, 'HEAD').headers.get('content-length'), '10');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('成片先在临时目录生成，确认后交付同一份字节', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-staged-'));
  let prepared;
  try {
    const src = path.join(dir, 'original.mp4');
    const outdir = path.join(dir, 'exports');
    execFileSync(core.need('ffmpeg'), ['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=2',
      '-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac','-shortest',src]);
    prepared = core.prepareDelivery(src, { destination: 'file', start: 0.4, duration: 1, cover: 0.8, mute: true });
    assert.equal(fs.existsSync(outdir), false);
    assert.ok(Math.abs(core.videoInfo(prepared.video).duration - 1) < 0.05);
    const metadata = JSON.parse(execFileSync(core.need('ffprobe'), ['-v','error','-show_streams','-of','json',prepared.video]));
    assert.equal(metadata.streams.some(s => s.codec_type === 'audio'), false);
    const expectedStill = path.join(dir, 'expected.jpg');
    core.extractStill(prepared.video, 0.4, expectedStill, 0);
    assert.deepEqual(fs.readFileSync(prepared.still), fs.readFileSync(expectedStill));
    const saved = core.savePrepared(prepared, outdir);
    assert.deepEqual(fs.readFileSync(saved.path), fs.readFileSync(prepared.output));
    const motion = core.verifyMotionPhoto(saved.path);
    assert.deepEqual(fs.readFileSync(saved.path).subarray(motion.stillLen), fs.readFileSync(prepared.video));
  } finally {
    if (prepared) fs.rmSync(prepared.directory, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('默认保留方向和比例，指定比例时成片与封面一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-aspect-'));
  try {
    const src = path.join(dir, 'source.mp4');
    execFileSync(core.need('ffmpeg'), ['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=12:duration=1', '-c:v','libx264',src]);
    for (const [aspect, expected] of [['original', 4 / 3], ['1:1', 1], ['9:16', 9 / 16], ['16:9', 16 / 9], ['3:4', 3 / 4]]) {
      const prepared = core.prepareDelivery(src, { destination:'file', duration:0.6, aspect });
      try {
        const video = core.videoInfo(prepared.video);
        const still = JSON.parse(execFileSync(core.need('ffprobe'), ['-v','error','-show_streams','-of','json',prepared.still])).streams[0];
        assert.ok(Math.abs(video.width / video.height - expected) < 0.025, `${aspect}: ${video.width}x${video.height}`);
        assert.equal(still.width, video.width); assert.equal(still.height, video.height);
      } finally { fs.rmSync(prepared.directory, { recursive:true, force:true }); }
    }
    const rotated = path.join(dir, 'portrait.mov');
    // FFmpeg 6+ removed the old rotate metadata override; use its input
    // display-rotation option when available, retaining support for FFmpeg 4.
    const ffmpeg = core.need('ffmpeg');
    const help = execFileSync(ffmpeg, ['-hide_banner', '-h', 'full'], { encoding:'utf8', maxBuffer: 8 * 1024 * 1024 });
    const rotateArgs = help.includes('-display_rotation')
      ? ['-display_rotation:v:0','90','-i',src,'-c','copy']
      : ['-i',src,'-c','copy','-metadata:s:v:0','rotate=90'];
    execFileSync(ffmpeg, ['-v','error',...rotateArgs,rotated]);
    const sourceInfo = core.videoInfo(rotated);
    assert.ok(Math.abs(sourceInfo.width / sourceInfo.height - 3 / 4) < 0.025,
      `旋转测试素材应为竖屏，实际 ${sourceInfo.width}x${sourceInfo.height}`);
    for (const [aspect, ratio] of [['original', 3 / 4], ['16:9', 16 / 9]]) {
      const item = core.prepareDelivery(rotated, { destination:'file', duration:0.6, aspect });
      try {
        const video = core.videoInfo(item.video);
        const still = JSON.parse(execFileSync(core.need('ffprobe'), ['-v','error','-show_streams','-of','json',item.still])).streams[0];
        assert.ok(Math.abs(video.width / video.height - ratio) < 0.025, `${aspect} rotated: ${video.width}x${video.height}`);
        assert.equal(still.width, video.width); assert.equal(still.height, video.height);
      } finally { fs.rmSync(item.directory, { recursive:true, force:true }); }
    }
    assert.throws(() => core.prepareDelivery(src, { destination:'file', aspect:'invalid' }), /比例/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
