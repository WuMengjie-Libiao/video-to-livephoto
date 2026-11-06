import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export default function DeliveryPreview({ review, initialIndex, saving, progress, onClose, onSave }) {
  const dialogRef = useRef(null);
  const videoRef = useRef(null);
  const [index, setIndex] = useState(initialIndex);
  const [playing, setPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [imageReady, setImageReady] = useState(false);
  const [error, setError] = useState('');
  const batch = review.batch;
  const item = batch?.items[index];
  const successful = batch?.items.filter(i => i.ok).length || 0;
  const failed = batch ? batch.items.length - successful : 0;
  const action = batch?.destination === 'photos' ? '保存' : '导出';

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  useEffect(() => { if (saving) videoRef.current?.pause(); }, [saving]);

  const play = async () => {
    const video = videoRef.current;
    if (!videoReady || saving) return;
    if (playing) { video.pause(); setPlaying(false); return; }
    video.currentTime = 0;
    try { await video.play(); if (videoRef.current === video) setPlaying(true); }
    catch (e) { if (videoRef.current === video) setError(`无法播放成片：${e.message}`); }
  };
  const navigate = delta => {
    videoRef.current?.pause(); setPlaying(false); setVideoReady(false); setImageReady(false); setError('');
    setIndex(i => i + delta);
  };
  const canSave = successful > 0 && !saving && (!item?.ok || (videoReady && imageReady && !error));
  const done = progress ? progress.index + (progress.phase === 'done' ? 1 : 0) : 0;

  return <dialog ref={dialogRef} className="deliveryDialog" aria-labelledby="deliveryTitle"
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <div className="deliveryHeading"><h2 id="deliveryTitle">预览效果</h2><button className="iconBtn" aria-label="关闭成片预览" disabled={saving} onClick={onClose}><Icon name="close" /></button></div>
    {review.status === 'loading' ? <div className="deliveryLoading" role="status"><Icon name="live" size={38} /><p>正在准备成片…</p><span>生成后就能查看实际效果</span></div>
      : review.status === 'error' ? <div className="deliveryFailure" role="alert"><p>预览没有生成成功</p><details className="deliveryError"><summary>查看原因</summary><p className="resultErr">{review.error}</p></details></div>
      : <>
        <button className="deliveryCanvas" disabled={!item?.ok || !videoReady || saving} onClick={play}
          aria-label={playing ? '暂停成片预览' : '播放成片'}>
          {item?.ok ? <>
            <video key={item.videoUrl} ref={videoRef} src={item.videoUrl} playsInline preload="auto"
              onLoadedData={() => setVideoReady(true)} onError={() => setError('成片暂时无法播放，请返回后重试。')}
              onEnded={() => { setPlaying(false); videoRef.current.currentTime = 0; }} />
            <img key={item.stillUrl} className={`deliveryCover ${playing ? 'coverHidden' : ''}`} src={item.stillUrl} alt="成片封面"
              onLoad={() => setImageReady(true)} onError={() => setError('成片封面未能加载，请返回后重试。')} />
            {!playing && videoReady && imageReady && !error && <span className="deliveryPlay"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 4 13 8-13 8z" /></svg></span>}
          </> : <span className="deliveryItemError">这段视频未能生成成片</span>}
        </button>
        <div className="deliveryCaption"><span title={item?.name}>{item?.name}</span>{item?.ok && <span>{item.duration.toFixed(1)} 秒 · {item.mute ? '无声音' : '保留声音'}</span>}</div>
        {error && <p className="resultErr" role="alert">{error}</p>}
        {item?.error && <details className="deliveryError"><summary>查看未生成的原因</summary><p className="resultErr">{item.error}</p></details>}
        <p className="deliveryHint">{item?.ok ? '先看封面，点击画面播放。确认满意后再保存。' : '可以返回调整，或只保存已生成的成片。'}</p>
        {batch.items.length > 1 && <nav className="deliveryNavigation" aria-label="浏览成片">
          <button className="textButton" disabled={index === 0 || saving} onClick={() => navigate(-1)}>上一张</button>
          <span>{index + 1} / {batch.items.length}</span>
          <button className="textButton" disabled={index === batch.items.length - 1 || saving} onClick={() => navigate(1)}>下一张</button>
        </nav>}
        {failed > 0 && <p className="resultErr">{failed} 段视频未生成，仅{action}成功生成的 {successful} 张。</p>}
      </>}
    <div className="deliveryActions"><button className="textButton" disabled={saving} onClick={onClose}>返回调整</button>
      {review.status === 'ready' && <button className="btnPrimary confirmSave" disabled={!canSave} onClick={onSave}>{saving ? '正在保存…' : `确认${action}${successful > 1 ? ` ${successful} 张` : ''}`}</button>}
    </div>
    {saving && <p role="status" className="deliveryHint">{done} / {batch.items.length} 已完成</p>}
  </dialog>;
}
