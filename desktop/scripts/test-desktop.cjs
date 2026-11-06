// Real preload, IPC and background worker; never writes to the personal Photos library.
'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../electron/core');
require('../electron/main');
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-ui-'));
  let exitCode = 0;
  try {
    const source = path.join(dir, 'clip.mp4');
    execFileSync(core.need('ffmpeg'), ['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30:duration=4','-c:v','libx264',source]);
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    const run = code => win.webContents.executeJavaScript(code);
    const environment = await run('window.api.envCheck()');
    assert.equal(environment.ok, true);
    assert.equal(environment.canSavePhotos, process.platform === 'darwin');
    const probed = await run(`window.api.probeVideos(${JSON.stringify([source])})`);
    const files = probed.map(f => ({ ...f, clip: { start: 0, end: 1, cover: 0.5 } }));
    assert.equal(files[0].ok, true);
    await run('window.probeProgress = []; window.api.onProgress(p => window.probeProgress.push(p)); true');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    let result;
    try {
      const stale = { path: path.join(dir, 'missing.mp4'), name: 'missing.mp4', clip: files[0].clip };
      const batch = await run(`window.api.prepareDelivery(${JSON.stringify({ files: [...files, stale], opts: {}, destination: 'file', outdir: dir })})`);
      assert.equal(batch.items[1].ok, false);
      assert.equal(fs.existsSync(path.join(dir, 'clip.MP.JPG')), false, '预览阶段不能输出文件');
      result = await run(`window.api.saveDelivery(${JSON.stringify(batch.id)})`);
      assert.equal(result[1].ok, false);
      await run(`window.api.releaseDelivery(${JSON.stringify(batch.id)})`);
      assert.equal(await run(`window.api.saveDelivery(${JSON.stringify(batch.id)}).then(() => false, () => true)`), true);
    } finally { clearInterval(timer); }
    assert.equal(result[0].ok, true);
    assert.equal(result[0].name, files[0].name);
    assert.ok(ticks > 0, '主进程应在转换期间继续处理事件');
    const progress = await run('window.probeProgress');
    assert.equal(progress[0].phase, 'start');
    assert.equal(progress.at(-1).phase, 'done');
    const other = path.join(dir, 'other.avi');
    execFileSync(core.need('ffmpeg'), ['-v','error','-i',source,'-c:v','mpeg4',other]);
    dialog.showOpenDialog = async (_win, options) => ({ canceled: false, filePaths: options.properties.includes('openDirectory') ? [dir] : [source, other] });
    await run(`document.querySelector('[aria-label="添加视频"]').click()`);
    for (let i = 0; i < 100; i++) {
      if ((await run('document.body.innerText')).includes('clip.mp4')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    for (let i = 0; i < 300; i++) {
      if (await run('document.querySelector("video")?.readyState >= 2')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await run('document.querySelector("video")?.readyState >= 2'), true,
      await run('JSON.stringify({error:document.querySelector("video")?.error?.message, text:document.body.innerText})'));
    await run(`document.querySelector('.soundButton').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await run('document.querySelector("video").muted'), true);
    await run(`document.querySelector('.soundButton').click()`);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await run('document.querySelector("video").muted'), false);
    // Drag both trim handles in the actual renderer, then choose a cover on the playhead.
    const pause = () => new Promise(resolve => setTimeout(resolve, 60));
    const slider = label => `[role="slider"][aria-label="${label}"]`;
    const readSlider = label => run(`Number(document.querySelector('${slider(label)}').getAttribute('aria-valuenow'))`);
    const dragHandle = async (label, fraction) => {
      const position = await run(`(() => {
        const handle = document.querySelector('${slider(label)}').getBoundingClientRect();
        const rail = document.querySelector('.timelineRail').getBoundingClientRect();
        return { x: Math.round(handle.x + handle.width / 2), y: Math.round(handle.y + handle.height / 2), target: Math.round(rail.x + rail.width * ${fraction}) };
      })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: position.x, y: position.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: position.target, y: position.y, button: 'left' });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: position.target, y: position.y, button: 'left', clickCount: 1 });
      await pause();
    };
    await dragHandle('片段起点', 0.2);
    await dragHandle('片段终点', 0.6);
    assert.ok(Math.abs(await readSlider('片段起点') - 0.8) < 0.02);
    assert.ok(Math.abs(await readSlider('片段终点') - 2.4) < 0.02);
    for (let i = 0; i < 300; i++) {
      if (await run(`document.querySelector('video')?.readyState >= 2 && document.querySelector('[aria-label="播放位置"]').tabIndex === 0`)) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await run('document.querySelector("video")?.readyState >= 2'), true,
      await run('JSON.stringify({src:document.querySelector("video").currentSrc, error:document.querySelector("video").error?.message,text:document.body.innerText})'));
    assert.ok(await run('document.querySelector("video").seekable.end(0) > 3.9'));
    win.focus(); win.webContents.focus();
    await run(`document.querySelector('${slider('播放位置')}').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' });
    for (let i = 0; i < 12; i++) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await pause();
    await run("[...document.querySelectorAll('button')].find(b => b.textContent === '设为封面').click()");
    assert.ok((await run("document.querySelector('.coverMarker').title")).includes('00:01.20'), await run("JSON.stringify({cover:document.querySelector('.coverMarker').title,time:document.querySelector('video').currentTime,src:document.querySelector('video').currentSrc,ready:document.querySelector('video').readyState, text:document.body.innerText})"));
    await run(`document.querySelector('[aria-label="播放所选片段"]').click()`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(await run('document.querySelector("video").paused'), true);
    assert.ok(Math.abs(await run('document.querySelector("video").currentTime') - 2.4) < 0.04);
    await run(`document.querySelector('[aria-label="编辑 other.avi"]').click()`);
    for (let i = 0; i < 300; i++) {
      if (await run('document.querySelector("video")?.readyState >= 2')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await run('document.querySelector("video").readyState >= 2'), true, 'AVI 应生成可播放预览');
    assert.ok((await run('document.querySelector("video").currentSrc')).includes('?preview=1'));
    assert.equal(await readSlider('片段起点'), 0);
    assert.equal(await readSlider('片段终点'), 3);
    await run(`document.querySelector('[aria-label="编辑 clip.mp4"]').click()`);
    await pause();
    assert.ok(Math.abs(await readSlider('片段起点') - 0.8) < 0.02, '切换素材应保留每个视频自己的选段');
    assert.ok(Math.abs(await readSlider('片段终点') - 2.4) < 0.02);
    assert.equal(await run('document.querySelectorAll("input[type=number]").length'), 0);
    await run(`(() => { const select = document.querySelector('select[aria-label="保存位置"]'); select.value = 'file'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await run("[...document.querySelectorAll('button')].find(b => b.textContent === '更改').click()");
    await new Promise(resolve => setTimeout(resolve, 50));
    await run(`document.querySelector('.saveDock .btnPrimary').click()`);
    await run(`document.querySelector('[aria-label="关闭成片预览"]').click()`);
    for (let i = 0; i < 300; i++) {
      if (await run('document.querySelector(".saveDock .btnPrimary").disabled === false')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(await run('document.querySelector("dialog")'), null, '关闭生成中的预览后不能再次弹出旧结果');
    assert.equal(fs.existsSync(path.join(dir, 'clip (2).MP.JPG')), false);
    const waitReview = async expectedDuration => {
      for (let i = 0; i < 300; i++) {
        if (await run('document.querySelector(".confirmSave")?.disabled === false')) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(await run('document.querySelector(".deliveryDialog").open'), true);
      assert.equal(await run('document.querySelector(".confirmSave")?.disabled'), false, await run('document.body.innerText'));
      assert.ok(Math.abs(await run('document.querySelector(".deliveryCanvas video").duration') - expectedDuration) < 0.08);
      assert.ok(await run('document.querySelector(".deliveryCover").naturalWidth > 0'));
    };
    await run(`document.querySelector('.saveDock .btnPrimary').click()`);
    await waitReview(1.6);
    assert.equal(fs.existsSync(path.join(dir, 'clip (2).MP.JPG')), false);
    await run(`document.querySelector('.deliveryCanvas').click()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(await run('document.querySelector(".deliveryCanvas video").currentTime > 0'));
    await run(`document.querySelector('.deliveryCanvas').click()`);
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent === '下一张').click()`);
    await waitReview(3);
    await run(`[...document.querySelectorAll('button')].find(b => b.textContent === '返回调整').click()`);
    await pause();
    assert.equal(await run('document.querySelector("dialog")'), null);
    assert.equal(fs.existsSync(path.join(dir, 'clip (2).MP.JPG')), false, '返回调整不应导出文件');
    await dragHandle('片段终点', 0.55);
    await run(`(() => { const select = document.querySelector('[aria-label="画面比例"]'); select.value = '1:1'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause();
    const frame = await run(`(() => { const r = document.querySelector('.cropFrame').getBoundingClientRect(); return { width:r.width, height:r.height }; })()`);
    assert.ok(Math.abs(frame.width - frame.height) < 1, '编辑预览应呈现选中的比例');
    await run(`document.querySelector('.saveDock .btnPrimary').click()`);
    await waitReview(1.4);
    assert.equal(await run('document.querySelector(".deliveryCover").naturalWidth === document.querySelector(".deliveryCover").naturalHeight'), true, '成片封面应采用选中的比例');
    await pause();
    fs.writeFileSync(path.join(os.tmpdir(), 'photolive-delivery.png'), (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.confirmSave').click()`);
    for (let i = 0; i < 200; i++) {
      if ((await run('document.body.innerText')).includes('已导出')) break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const text = await run('document.body.innerText');
    assert.ok(text.includes('clip.mp4'));
    assert.ok(text.includes('已导出'));
    assert.ok(fs.existsSync(path.join(dir, 'clip (2).MP.JPG')));
    const output = path.join(dir, 'clip (2).MP.JPG');
    const structure = core.verifyMotionPhoto(output);
    const embedded = path.join(dir, 'selection.mp4');
    fs.writeFileSync(embedded, fs.readFileSync(output).subarray(structure.stillLen));
    assert.ok(Math.abs(core.videoInfo(embedded).duration - 1.4) < 0.08, '导出时长应与拖出的范围相符');
    assert.equal(core.videoInfo(embedded).width, core.videoInfo(embedded).height, '导出画面应与预览比例一致');
    assert.ok(!text.includes('静图模板'));
    assert.equal(await run('document.querySelector(".thumb img")?.naturalWidth > 0'), true, '素材缩略图必须实际解码显示');
    win.setSize(900, 640);
    await new Promise(resolve => setTimeout(resolve, 100));
    const layout = await run(`({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      cta: document.querySelector('.btnPrimary').getBoundingClientRect().bottom, height: innerHeight,
      videoHeight: document.querySelector('video').getBoundingClientRect().height, canvasHeight: document.querySelector('.previewCanvas').getBoundingClientRect().height })`);
    assert.ok(layout.scroll <= layout.width);
    assert.ok(layout.cta <= layout.height);
    assert.ok(layout.videoHeight <= layout.canvasHeight + 1, '视频应完整缩放在预览区域内');
    fs.writeFileSync(path.join(os.tmpdir(), 'photolive-loaded.png'), (await win.webContents.capturePage()).toPNG());
    win.webContents.debugger.attach('1.3');
    const cdp = (command, args) => win.webContents.debugger.sendCommand(command, args);
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const viewport = async (width, height) => {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await pause();
    };
    for (const [width, height] of [[320, 568], [393, 852], [740, 360], [768, 1024]]) {
      await viewport(width, height);
      const compact = await run(`(() => {
        const dock = document.querySelector('.saveDock .btnPrimary').getBoundingClientRect();
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, bottom: dock.bottom, height: innerHeight };
      })()`);
      assert.ok(compact.scroll <= compact.width, `布局不应横向溢出：${width}×${height}`);
      assert.ok(compact.bottom <= compact.height, '保存按钮应在视口内');
    }
    await viewport(393, 852);
    const touch = async (from, to) => {
      await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
      for (let step = 1; step <= 8; step++) {
        await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8, id: 1 }] });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pause();
    };
    await run(`document.querySelector('.workspace').scrollTop = 0`);
    const rail = await run(`(() => { const r = document.querySelector('.timelineRail').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const handle = await run(`(() => { const r = document.querySelector('[aria-label="片段起点"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await touch(handle, { x: rail.x + rail.width * 0.3, y: handle.y });
    assert.ok(Math.abs(await readSlider('片段起点') - 1.2) < 0.04, '触屏拖柄应改变选段');
    const previousTime = await readSlider('播放位置');
    const previousScroll = await run(`document.querySelector('.workspace').scrollTop`);
    await touch({ x: rail.x + rail.width * 0.9, y: rail.y + 30 }, { x: rail.x + rail.width * 0.9, y: rail.y - 75 });
    assert.ok(await run(`document.querySelector('.workspace').scrollTop`) > previousScroll, '跨过时间线的纵向滑动应滚动页面');
    assert.ok(Math.abs(await readSlider('播放位置') - previousTime) < 0.04, '纵向滚动不应改变播放位置');
    await run(`document.querySelector('.workspace').scrollTop = 0`);
    fs.writeFileSync(path.join(os.tmpdir(), 'photolive-mobile-editor.png'), (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.saveDock .btnPrimary').click()`);
    await waitReview(1);
    for (const [width, height] of [[320, 568], [393, 852], [740, 360]]) {
      await viewport(width, height);
      const modal = await run(`(() => {
        const d = document.querySelector('dialog'), b = document.querySelector('.confirmSave').getBoundingClientRect();
        d.scrollTop = d.scrollHeight;
        return { scroll: d.scrollWidth, width: d.clientWidth, buttonWidth: b.width };
      })()`);
      assert.ok(modal.scroll <= modal.width + 1, '手机预览不应横向溢出');
      assert.ok(modal.buttonWidth >= 44, '确认按钮应保留可触控宽度');
    }
    await viewport(393, 852);
    await run(`document.querySelector('dialog').scrollTop = 0`);
    fs.writeFileSync(path.join(os.tmpdir(), 'photolive-mobile-preview.png'), (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('[aria-label="关闭成片预览"]').click()`);
    win.webContents.debugger.detach();
    console.log('DESKTOP_OK: original editor/export, compact portrait/landscape, synthesized Chromium touch trim/vertical scroll, responsive delivery preview');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { fs.rmSync(dir, { recursive: true, force: true }); app.exit(exitCode); }
});
