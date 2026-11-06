// Electron 主进程：窗口 + IPC + 转换调度
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Worker } = require('worker_threads');
const { randomUUID } = require('crypto');
const batches = new Map();
const execAsync = promisify(execFile);
const native = require('./native');
if (app.isPackaged) process.lpResourcesDir = process.resourcesPath;
let converting = false;
const core = require('./core');
const preview = require('./preview');

const DEV = process.env.VITE_DEV === '1';
let win = null;

function createWindow({ demo = false } = {}) {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#f5f5f0',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const query = demo ? { demo: '1' } : {};
  if (DEV) win.loadURL('http://localhost:5173' + (demo ? '/?demo=1' : ''));
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });

  win.on('closed', () => { win = null; });
  return win;
}

// ------------------------------------------------------------------ 工具函数

function runWorker(command, src, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'convert-worker.js'), {
      workerData: { command, src, opts, resourcesPath: app.isPackaged ? process.resourcesPath : null },
    });
    let settled = false;
    worker.on('message', message => {
      settled = true;
      if (message.type === 'error') reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (!settled) reject(new Error(`转换进程提前退出（${code}）`));
    });
  });
}

async function probeFile(p) {
  try {
    const info = await runWorker('probe', p);
    if (!Number.isFinite(info.duration) || info.duration <= 0) throw new Error('无法确定视频时长，不能截取此素材');
    return { path: p, name: path.basename(p), ok: true, ...info, previewUrl: preview.register(p, info.duration) };
  } catch (e) {
    return { path: p, name: path.basename(p), ok: false, error: e.message };
  }
}

function defaultOutdir() {
  let base;
  try {
    base = app.getPath('pictures');
  } catch {
    base = app.getPath('home');
  }
  return path.join(base, 'LivePhoto');
}

// ---------------------------------------------------------------------- IPC

ipcMain.handle('env:check', async () => {
  let error = null;
  let photosError = null;
  try {
    for (const name of ['ffmpeg', 'ffprobe']) {
      await execAsync(core.need(name), ['-version'], { timeout: 5000, windowsHide: true });
    }
  } catch (e) { error = `视频组件不可用：${e.message}`; }
  if (process.platform === 'darwin') {
    try { native.needNative(); } catch (e) { photosError = e.message; }
  }
  return {
    ok: !error, error, photosError,
    canSavePhotos: process.platform === 'darwin' && !photosError,
    platform: process.platform, version: app.getVersion(), outdir: defaultOutdir(),
  };
});

ipcMain.handle('video:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择视频',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'flv', 'wmv'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(probeFile));
});

ipcMain.handle('video:probe', (_e, paths) => Promise.all(paths.map(probeFile)));
ipcMain.handle('video:frames', (_e, url) => preview.frames(url));
ipcMain.handle('video:preview', (_e, url) => preview.transcode(url));
ipcMain.handle('video:release', (_e, url) => preview.release(url));

// 生成缩略图（base64 data URL），给列表用
ipcMain.handle('video:thumb', async (_e, p) => {
  try {
    const ffmpeg = core.resolveBin('ffmpeg');
    if (!ffmpeg) return null;
    const out = await new Promise((resolve, reject) => {
      const proc = execFile(ffmpeg, [
        '-v', 'error', '-ss', '0', '-i', p, '-frames:v', '1',
        '-vf', 'scale=160:-2', '-q:v', '7', '-f', 'mjpeg', 'pipe:1',
      ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
      proc.stdin?.end();
    });
    return out && out.length ? `data:image/jpeg;base64,${out.toString('base64')}` : null;
  } catch {
    return null;
  }
});

ipcMain.handle('outdir:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择输出目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:open', async (_e, p) => {
  const error = await shell.openPath(p);
  if (error) throw new Error(error);
});

ipcMain.handle('photos:open', () => shell.openExternal('photos://'));
function batchFor(id, sender) {
  const batch = batches.get(id);
  if (!batch || batch.owner !== sender) throw new Error('成片预览已失效，请重新预览');
  return batch;
}
function discardBatch(batch) {
  if (!batches.delete(batch.id)) return;
  batch.owner.removeListener('destroyed', batch.onDestroyed);
  for (const item of batch.items) {
    if (!item.ok) continue;
    preview.release(item.videoUrl);
    preview.release(item.stillUrl);
    fs.rmSync(item.prepared.directory, { recursive: true, force: true });
  }
}
function validateJob(job) {
  if (!job || !Array.isArray(job.files) || !job.files.length ||
      !job.files.every(f => typeof f.path === 'string' && f.clip &&
        [f.clip.start, f.clip.end, f.clip.cover].every(Number.isFinite)) ||
      !['photos', 'file'].includes(job.destination)) throw new Error('转换任务不合法');
  if (job.destination === 'file' && (typeof job.outdir !== 'string' || !job.outdir)) throw new Error('请选择导出位置');
  if (job.destination === 'photos') native.needNative();
}
ipcMain.handle('delivery:prepare', async (event, job) => {
  if (converting) throw new Error('已有一批素材正在处理');
  validateJob(job);
  const batch = { id: randomUUID(), owner: event.sender, state: 'preparing',
    destination: job.destination, outdir: job.outdir, items: [], orphaned: false };
  batch.onDestroyed = () => {
    batch.orphaned = true;
    if (!['preparing', 'saving'].includes(batch.state)) discardBatch(batch);
  };
  event.sender.once('destroyed', batch.onDestroyed);
  batches.set(batch.id, batch);
  converting = true;
  try {
    for (const file of job.files) {
      if (batch.orphaned) throw new Error('预览已关闭');
      try {
        const prepared = await runWorker('prepare', file.path, {
          ...job.opts, start: file.clip.start, duration: file.clip.end - file.clip.start,
          cover: file.clip.cover, aspect: file.aspect ?? 'original', destination: job.destination,
        });
        batch.items.push({ name: file.name, ok: true, prepared,
          videoUrl: preview.registerAsset(prepared.video), stillUrl: preview.registerAsset(prepared.still) });
      } catch (error) { batch.items.push({ name: file.name, ok: false, error: error.message }); }
    }
    if (batch.orphaned) throw new Error('预览已关闭');
    batch.state = 'ready';
    return { id: batch.id, destination: batch.destination, items: batch.items.map(item => item.ok
      ? { name: item.name, ok: true, videoUrl: item.videoUrl, stillUrl: item.stillUrl,
        duration: item.prepared.duration, mute: item.prepared.mute }
      : item) };
  } catch (error) {
    discardBatch(batch);
    throw error;
  } finally { converting = false; }
});
ipcMain.handle('delivery:release', (event, id) => {
  if (!batches.has(id)) return;
  const batch = batchFor(id, event.sender);
  if (['preparing', 'saving'].includes(batch.state)) throw new Error('成片正在处理，请稍候');
  discardBatch(batch);
});
ipcMain.handle('delivery:save', async (event, id) => {
  if (converting) throw new Error('已有一批素材正在处理');
  const batch = batchFor(id, event.sender);
  if (batch.state !== 'ready') throw new Error('这份预览已处理，请重新预览');
  batch.state = 'saving';
  converting = true;
  const send = payload => {
    if (!event.sender.isDestroyed()) event.sender.send('convert:progress', payload);
  };
  try {
    const results = [];
    for (const [index, item] of batch.items.entries()) {
      const progress = { index, total: batch.items.length, name: item.name };
      send({ ...progress, phase: 'start' });
      if (!item.ok) results.push({ name: item.name, ok: false, error: item.error });
      else {
        try {
          const saved = await runWorker('save', null, { prepared: item.prepared, outdir: batch.outdir });
          results.push({ ...saved, name: item.name, outputName: saved.name, ok: true });
        } catch (error) { results.push({ name: item.name, ok: false, error: error.message }); }
      }
      send({ ...progress, phase: 'done' });
    }
    return results;
  } finally {
    converting = false;
    batch.state = 'committed';
    if (batch.orphaned) discardBatch(batch);
  }
});

// ------------------------------------------------------------------ 启动

app.on('will-quit', () => {
  for (const batch of batches.values()) {
    if (!['preparing', 'saving'].includes(batch.state)) discardBatch(batch);
  }
  preview.cleanup();
});
app.whenReady().then(() => {
  preview.install();
  if (process.argv.includes('--probe-ui')) return runUiProbe();
  const shotArg = process.argv.find((a) => a.startsWith('--screenshot'));
  if (shotArg) {
    const empty = shotArg.startsWith('--screenshot-empty');
    const out = shotArg.includes('=') ? shotArg.split('=')[1]
      : path.join(app.getPath('temp'), 'livephoto-ui.png');
    return runScreenshot(out, !empty);
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 截图模式：给开发时看界面用（--screenshot[=path]）
function runScreenshot(outPath, demo = true) {
  const w = createWindow({ demo });
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const img = await w.webContents.capturePage();
        fs.writeFileSync(outPath, img.toPNG());
        console.log('SCREENSHOT_OK', outPath);
        app.exit(0);
      } catch (e) {
        console.error('SCREENSHOT_FAIL', e.message || e);
        app.exit(1);
      }
    }, 1800);
  });
}

// 无界面自检 UI：加载页面后把可见文本打出来，确认 React 真的渲染了
function runUiProbe() {
  const w = createWindow();
  w.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg));
  w.webContents.once('did-finish-load', async () => {
    try {
      const text = await w.webContents.executeJavaScript('document.body.innerText');
      console.log('UI_TEXT_START');
      console.log(String(text).slice(0, 800));
      console.log('UI_TEXT_END');
      app.exit(0);
    } catch (e) {
      console.error('UI_PROBE_FAIL', e.message || e);
      app.exit(1);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
