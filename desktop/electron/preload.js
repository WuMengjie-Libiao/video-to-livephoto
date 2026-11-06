// 预加载脚本：只暴露必要的接口给渲染进程
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  envCheck: () => ipcRenderer.invoke('env:check'),
  pickVideos: (id=crypto.randomUUID()) => ipcRenderer.invoke('video:pick',id),
  probeVideos: (paths,id=crypto.randomUUID()) => ipcRenderer.invoke('video:probe',paths,id),
  timelineFrames: (url,range) => ipcRenderer.invoke('video:frames',url,range),
  preparePreview: (url,range) => ipcRenderer.invoke('video:preview',url,range),
  pauseVideo: url => ipcRenderer.invoke('video:pause',url),
  releaseVideo: (url) => ipcRenderer.invoke('video:release', url),
  thumb: (p) => ipcRenderer.invoke('video:thumb', p),
  pickOutdir: () => ipcRenderer.invoke('outdir:pick'),
  openPhotos: () => ipcRenderer.invoke('photos:open'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),
  prepareDelivery: job => ipcRenderer.invoke('delivery:prepare',{...job,taskId:job.taskId || crypto.randomUUID()}),
  cancelDelivery: id => ipcRenderer.invoke('delivery:cancel',id),
  saveDelivery: (id) => ipcRenderer.invoke('delivery:save', id),
  releaseDelivery: (id) => ipcRenderer.invoke('delivery:release', id),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('convert:progress', handler);
    return () => ipcRenderer.removeListener('convert:progress', handler);
  },
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file.path; }
  },
});
