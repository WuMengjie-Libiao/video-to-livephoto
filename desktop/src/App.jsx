import { useCallback, useEffect, useRef, useState } from 'react';
import VideoEditor from './VideoEditor.jsx';
import Icon from './Icon.jsx';
import DeliveryPreview from './DeliveryPreview.jsx';

const ACCEPT = /\.(mp4|mov|m4v|mkv|webm|avi|flv|wmv)$/i;
const fmtDur = s => `${Number(s).toFixed(1)} 秒`;

export default function App() {
  const demo = new URLSearchParams(location.search).has('demo');
  const [env, setEnv] = useState(null);
  const [files, setFiles] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [activePath, setActivePath] = useState(null);
  const [destination, setDestination] = useState('photos');
  const [outdir, setOutdir] = useState('');
  const [opts, setOpts] = useState({ mute: false });
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState(null);
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const reviewRequest = useRef(null);
  const validFiles = files.filter(f => f.ok);
  const activeFile = validFiles.find(f => f.path === activePath) || validFiles[0];

  useEffect(() => {
    if (demo) { setEnv({ ok: true, canSavePhotos: true, platform: 'darwin', version: '0.1.0' }); return; }
    let active = true;
    window.api.envCheck().then(e => {
      if (!active) return;
      setEnv(e);
      setOutdir(e.outdir);
      setDestination(e.platform === 'darwin' ? 'photos' : 'file');
    }).catch(e => { if (active) setError(e.message); });
    const offProgress = window.api.onProgress(setProgress);
    return () => { active = false; offProgress(); };
  }, [demo]);

  const perform = async action => {
    try { setError(''); await action(); } catch (e) { setError(e.message || String(e)); }
  };
  const addFiles = useCallback(items => {
    setFiles(prev => {
      const unique = new Map(prev.map(f => [f.path, f]));
      items.forEach(f => {
        if (!unique.has(f.path)) unique.set(f.path, { ...f, aspect: 'original', clip: f.ok
          ? { start: 0, end: Math.min(3, f.duration), cover: Math.min(3, f.duration) / 2 } : null });
      });
      return [...unique.values()];
    });
    items.filter(f => f.ok).forEach(async f => {
      const data = await window.api.thumb(f.path);
      if (data) setThumbs(prev => ({ ...prev, [f.path]: data }));
    });
  }, []);
  const pick = () => perform(async () => {
    if (demo || running || loading) return;
    setLoading(true);
    try { addFiles(await window.api.pickVideos()); } finally { setLoading(false); }
  });
  const drop = e => {
    e.preventDefault(); setDragging(false);
    if (demo || running || loading) return;
    const paths = [...e.dataTransfer.files].map(window.api.pathForFile).filter(p => ACCEPT.test(p));
    if (!paths.length) { setError('请添加视频文件，例如 MP4、MOV 或 MKV。'); return; }
    perform(async () => {
      setLoading(true);
      try { addFiles(await window.api.probeVideos(paths)); } finally { setLoading(false); }
    });
  };
  const releaseReview = batch => window.api.releaseDelivery(batch.id).catch(e => setError(`预览清理失败：${e.message}`));
  const openReview = async () => {
    if (demo || running || preparing || !validFiles.length) return;
    setError(''); setPreparing(true); setReview({ status: 'loading' });
    const request = {};
    reviewRequest.current = request;
    try {
      const batch = await window.api.prepareDelivery({ files: validFiles, opts, destination, outdir });
      if (reviewRequest.current !== request) await releaseReview(batch);
      else setReview({ status: 'ready', batch });
    } catch (e) {
      if (reviewRequest.current === request) setReview({ status: 'error', error: e.message });
    } finally { setPreparing(false); }
  };
  const closeReview = () => {
    if (running) return;
    reviewRequest.current = null;
    if (review?.batch) releaseReview(review.batch);
    setReview(null);
  };
  const confirmSave = () => perform(async () => {
    if (!review?.batch || running) return;
    const batch = review.batch;
    setRunning(true); setResults([]); setProgress(null);
    try { setResults(await window.api.saveDelivery(batch.id)); }
    finally {
      setRunning(false); setReview(null); reviewRequest.current = null;
      await releaseReview(batch);
    }
  });
  const canRun = env?.ok && (destination !== 'photos' || env.canSavePhotos) &&
    (destination !== 'file' || outdir) && validFiles.length && !loading && !preparing;
  const done = progress ? progress.index + (progress.phase === 'done' ? 1 : 0) : 0;

  const remove = file => {
    setFiles(prev => prev.filter(f => f.path !== file.path));
    if (file.previewUrl) window.api.releaseVideo(file.previewUrl).catch(e => setError(e.message));
  };
  const clear = () => {
    files.forEach(remove);
    setActivePath(null); setThumbs({}); setResults([]); setError('');
  };

  return <div className={`app ${env?.platform === 'darwin' ? 'appMac' : ''}`}
    onDragOver={e => { e.preventDefault(); if (!running) setDragging(true); }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }} onDrop={drop}>
    <header className="titlebar">
      <div className="brand"><Icon name="live" size={24} /><h1>实况照片</h1></div>
      <span className="localNote">{demo ? '演示预览' : '只在本机处理'}</span>
    </header>
    {(error || env?.error) && <div role="alert" className="banner">
      {error || '视频组件暂时无法使用。'}
      {env?.error && <details><summary>查看详情</summary><p>{env.error}</p></details>}
    </div>}
    <main className={`workspace ${files.length ? '' : 'workspaceEmpty'}`} aria-label="视频素材与结果">
      {files.length > 0 && <div className="workspaceTools">
        <span>{files.length > 1 ? `${files.length} 段视频` : '选一段喜欢的画面'}</span>
        <div className="sectionActions"><button className="btn addButton" disabled={running || loading} onClick={pick}><Icon name="plus" size={15} />添加视频</button>
          <button className="textButton" disabled={running || loading} onClick={clear}>清空</button>
        </div>
      </div>}
      {activeFile && <VideoEditor key={activeFile.path} file={activeFile} disabled={running || !!review} muted={opts.mute} aspect={activeFile.aspect}
        onAspectChange={aspect => setFiles(prev => prev.map(f => f.path === activeFile.path ? { ...f, aspect } : f))}
        onChange={clip => setFiles(prev => prev.map(f => f.path === activeFile.path ? { ...f, clip } : f))} />}
      {!files.length ? <button className={`dropzone ${dragging ? 'dropzoneActive' : ''}`} onClick={pick} disabled={loading || running} aria-label="添加视频">
        <span className="dropIcon"><Icon name="live" size={58} /></span>
        <span className="dropTitle">{loading ? '正在打开视频…' : '留住喜欢的那一刻'}</span>
        <span className="dropHint">拖入视频，选一小段，变成实况照片。</span>
        <span className="dropAction"><Icon name="plus" size={17} />选择视频</span>
        <span className="dropFootnote">也可以一次放入多个视频</span>
      </button> : <div className="fileSection"><ul className="fileList" aria-label="已添加的视频">
        {files.map(f => <li key={f.path} className={`fileRow ${f.ok ? '' : 'fileRowBad'} ${f.path === activeFile?.path ? 'fileRowActive' : ''}`}>
          <button className="fileSelect" disabled={!f.ok || running} aria-pressed={f.path === activeFile?.path} aria-label={`编辑 ${f.name}`} onClick={() => setActivePath(f.path)}>
            <span className="thumb">{thumbs[f.path] && <img src={thumbs[f.path]} alt="" />}</span>
            <span className="fileMain"><span className="fileName" title={f.path}>{f.name}</span><span className="fileMeta">{f.ok ? fmtDur(f.clip.end - f.clip.start) : f.error}</span></span>
          </button>
          <button className="iconBtn" aria-label={`移除 ${f.name}`} disabled={running} onClick={() => remove(f)}><Icon name="close" size={14} /></button>
        </li>)}
      </ul></div>}
      {results.length > 0 && <section className="resultsSection" aria-label="处理结果" aria-live="polite">
        {results.map((r, i) => <div key={i} className={`resultRow ${r.ok ? '' : 'resultRowBad'}`}>
          {r.ok && <Icon name="check" size={17} />}<span className="resultName">{r.name}</span>
          {r.ok ? <><span>{r.destination === 'photos' ? '已保存' : '已导出'}</span>
            <button className="textButton" onClick={() => perform(() => r.destination === 'photos' ? window.api.openPhotos() : window.api.openPath(r.path))}>{r.destination === 'photos' ? '打开照片' : '查看'}</button></>
            : <p className="resultErr">{r.error}</p>}
        </div>)}
      </section>}

    </main>
    {files.length > 0 && <footer className="saveDock" aria-label="保存设置">
      <fieldset className="dockOptions" disabled={running}>
        <button className="soundButton" aria-pressed={!opts.mute} onClick={() => setOpts({ ...opts, mute: !opts.mute })}><Icon name={opts.mute ? 'mute' : 'sound'} size={17} />保留声音</button>
        <span className="dockDivider" />
        <label className="destinationLabel">保存到<select aria-label="保存位置" value={destination} onChange={e => setDestination(e.target.value)}>
          {env?.platform === 'darwin' && <option value="photos">照片</option>}<option value="file">文件夹</option>
        </select></label>
        {destination === 'file' && <div className="exportFolder"><Icon name="folder" size={16} /><span title={outdir}>{outdir.split(/[\\/]/).filter(Boolean).pop() || '选择文件夹'}</span><button className="textButton" onClick={() => perform(async () => { if (demo) return; const dir = await window.api.pickOutdir(); if (dir) setOutdir(dir); })}>更改</button></div>}
        <details className="saveHelp"><summary aria-label="保存说明"><Icon name="help" size={16} /></summary><div>
          {destination === 'photos' ? '首次保存需要允许添加照片。开启 iCloud 照片后，可同步到同一 Apple 账户的 iPhone。' : '每段视频导出一个动态照片文件，重名会自动编号。接收方的相册或应用需要支持动态照片。'}
        </div></details>
      </fieldset>
      {destination === 'photos' && env?.photosError && <p role="alert" className="resultErr dockError">{env.photosError}</p>}
      <button className="btnPrimary" disabled={running || !canRun} onClick={openReview}>{preparing ? '正在准备预览…' : running ? '正在保存…' : `预览并${destination === 'photos' ? '保存' : '导出'}${validFiles.length > 1 ? ` ${validFiles.length} 张` : ''}`}</button>
      {!running && results.length > 0 && <div className="saveStatus" role="status">
        {results.some(r => r.ok) && <span>{results.find(r => r.ok).destination === 'photos' ? '已保存' : '已导出'} {results.filter(r => r.ok).length} 张实况照片</span>}
        {results.some(r => !r.ok) && <span className="resultErr">{results.filter(r => !r.ok).length} 项未完成，请查看详情</span>}
      </div>}
      {running && <div className="saveProgress" aria-live="polite"><span>{done} / {progress?.total || validFiles.length} 已完成</span><div className="progressBar" role="progressbar" aria-label="保存进度" aria-valuenow={done} aria-valuemin={0} aria-valuemax={progress?.total || validFiles.length}><div className="progressFill" style={{ width: `${100 * done / (progress?.total || validFiles.length)}%` }} /></div></div>}
    </footer>}
    {review && <DeliveryPreview review={review} initialIndex={Math.max(0, validFiles.findIndex(f => f.path === activeFile?.path))}
      saving={running} progress={progress} onClose={closeReview} onSave={confirmSave} />}
    {dragging && <div className="dropOverlay"><div>松开，添加视频</div></div>}
  </div>;
}
