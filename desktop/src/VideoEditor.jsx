import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export function timecode(seconds) {
  const ticks = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(ticks / 6000).toString().padStart(2, '0');
  const remainder = ((ticks % 6000) / 100).toFixed(2).padStart(5, '0');
  return `${minutes}:${remainder}`;
}
const displayTime = value => { const [minutes, seconds] = timecode(value).split(':'); return `${Number(minutes)}:${seconds.slice(0, -1)}`; };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export default function VideoEditor({ file, disabled, muted, aspect, onAspectChange, onChange, limits }) {
  const { start, end, cover } = file.clip;
  const duration = file.duration;
  const [src, setSrc] = useState(file.previewUrl);
  const [proxyNeeded, setProxyNeeded] = useState(false);
  const [proxyAnchor, setProxyAnchor] = useState(start);
  const proxyRange = useRef({offset:0,end:duration});
  const wantedTime = useRef(start);
  const serial = useRef(0);
  const [localStart, setLocalStart] = useState(Math.max(0,start-5));
  const [frames, setFrames] = useState([]);
  const [time, setTime] = useState(start);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [frameError, setFrameError] = useState('');
  const videoRef = useRef(null);
  const railRef = useRef(null);
  const active = useRef(true);
  const proxyAttempted = useRef(false);
  const drag = useRef(null);
  const maxSpan = limits.maxDuration;
  const minSpan = Math.min(limits.minDuration, duration);
  const viewSpan = Math.min(duration,40);
  const viewStart = clamp(localStart,0,duration-viewSpan);
  const percent = value => 100 * (value-viewStart) / viewSpan;
  useEffect(() => { if (!drag.current) setLocalStart(Math.max(0,start-5)); }, [start,end]);
  useEffect(() => {
    if (!proxyNeeded) return;
    const request = ++serial.current;
    const timer = setTimeout(async () => {
      setReady(false); setPreparing(true);
      const from = proxyAnchor >= start && proxyAnchor <= end ? start : Math.min(proxyAnchor,Math.max(0,duration-(end-start)));
      try {
        const proxy = await window.api.preparePreview(file.previewUrl,{start:from,end:Math.min(duration,from+(end-start)),width:file.width,height:file.height});
        if (request !== serial.current || !active.current) return;
        proxyRange.current = {offset:proxy.offset,end:proxy.end}; setSrc(proxy.url); setError('');
      } catch(e) { if (request === serial.current && active.current) setError(e.message); }
      finally { if (request === serial.current && active.current) setPreparing(false); }
    },250);
    return () => { clearTimeout(timer); serial.current++; };
  },[proxyNeeded,proxyAnchor,start,end,file.previewUrl,file.width,file.height,duration]);

  useEffect(() => {
    let current = true;
    window.api.timelineFrames(file.previewUrl,{start:viewStart,end:viewStart+viewSpan}).then(images => {
      if (current) {setFrames(images);setFrameError('');}
    }).catch(e => { if (current) setFrameError(`时间线缩略图不可用：${e.message}`); });
    return () => {current = false;};
  }, [file.previewUrl,viewStart,viewSpan]);
  useEffect(() => () => { active.current = false; serial.current++; window.api.pauseVideo(file.previewUrl).catch(() => {}); },[file.previewUrl]);

  useEffect(() => {
    if (!playing) return;
    let frame;
    const update = () => {
      const video = videoRef.current;
      if (video.currentTime + proxyRange.current.offset >= end) {
        video.pause(); video.currentTime = end - proxyRange.current.offset; setTime(end); return;
      }
      setTime(video.currentTime + proxyRange.current.offset);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [playing, end]);
  useEffect(() => { if (disabled) videoRef.current?.pause(); }, [disabled]);

  const seek = value => {
    const next = clamp(value, 0, duration);
    wantedTime.current = next;
    if (proxyNeeded && (next < proxyRange.current.offset || next > proxyRange.current.end)) {setReady(false);setPreparing(true);setProxyAnchor(next);}
    else if (ready) videoRef.current.currentTime = next - proxyRange.current.offset;
    setTime(next);
  };
  const updateRange = (edge, value) => {
    videoRef.current.pause();
    const nextStart = edge === 'start' ? clamp(value, Math.max(0,end-maxSpan), end - minSpan) : start;
    const nextEnd = edge === 'end' ? clamp(value, start + minSpan, Math.min(duration,start+maxSpan)) : end;
    onChange({ start: nextStart, end: nextEnd, cover: clamp(cover, nextStart, nextEnd) });
    if (proxyNeeded) {setReady(false);setPreparing(true);}
    setProxyAnchor(edge === 'start' ? nextStart : nextEnd);
    seek(edge === 'start' ? nextStart : nextEnd);
  };
  const shiftRange = value => {
    const next = clamp(value,0,duration-(end-start)), delta = next-start;
    if (proxyNeeded) {setReady(false);setPreparing(true);}
    onChange({start:next,end:end+delta,cover:cover+delta}); setProxyAnchor(next); seek(next);
  };
  const move = (kind,value) => kind === 'playhead' ? seek(value) : kind === 'selection' ? shiftRange(value) : updateRange(kind,value);
  const timeAt = event => {
    const rect = railRef.current.getBoundingClientRect();
    return viewStart + clamp((event.clientX - rect.left) / rect.width, 0, 1) * viewSpan;
  };
  const begin = (event, kind) => {
    if (disabled || !event.isPrimary) return;
    event.stopPropagation();
    const pending = event.pointerType === 'touch' && event.currentTarget === railRef.current;
    if (!pending) {
      event.preventDefault(); videoRef.current.pause();
    }
    if (event.pointerType === 'touch' && kind !== 'playhead' && kind !== 'selection') {
      const value = timeAt(event);
      kind = Math.abs(value - start) <= Math.abs(value - end) ? 'start' : 'end';
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, pending, pointerId: event.pointerId, x: event.clientX, y: event.clientY, start, at:timeAt(event) };
    if (kind === 'playhead' && !pending) seek(timeAt(event));
  };
  const dragMove = event => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.pending) {
      const x = Math.abs(event.clientX - gesture.x), y = Math.abs(event.clientY - gesture.y);
      if (Math.max(x, y) < 8) return;
      if (y > x) { drag.current = null; return; }
      gesture.pending = false; videoRef.current.pause();
    }
    move(gesture.kind, gesture.kind === 'selection' ? gesture.start + timeAt(event)-gesture.at : timeAt(event));
  };
  const dragEnd = event => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (drag.current.pending) { videoRef.current.pause(); seek(timeAt(event)); }
    drag.current = null; setLocalStart(Math.max(0,start-5));
  };
  const key = (event, kind, value) => {
    if (disabled) return;
    const step = event.shiftKey ? 1 : 0.1;
    const change = { ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step, ArrowUp: value + step, Home: 0, End: duration }[event.key];
    if (change !== undefined) { event.preventDefault(); move(kind, change); }
  };
  const togglePlay = async () => {
    if (!ready || disabled) return;
    const video = videoRef.current;
    if (!video.paused) { video.pause(); return; }
    if (video.currentTime + proxyRange.current.offset < start || video.currentTime + proxyRange.current.offset >= end - 0.02) seek(start);
    try { await video.play(); } catch (e) { setError(`无法播放预览：${e.message}`); }
  };
  const playbackError = () => {
    setReady(false);
    if (proxyAttempted.current) { setError('预览无法播放，请重新添加视频。'); return; }
    proxyAttempted.current = true; setProxyNeeded(true); setPreparing(true);
  };
  const handles = [
    { kind: 'start', value: start, label: '片段起点', min: Math.max(0,end-maxSpan), max: end - minSpan },
    { kind: 'end', value: end, label: '片段终点', min: start + minSpan, max: Math.min(duration,start+maxSpan) },
  ];

  return <section className="videoEditor" aria-label={`剪辑 ${file.name}`}>
    <div className="editorHeading"><span title={file.name}>{file.name}</span></div>
    <div className="previewCanvas">
      <div className="cropFrame" style={{ '--ratio': ({ '1:1': 1, '9:16': 9 / 16, '16:9': 16 / 9, '3:4': 3 / 4 })[aspect] || file.width / file.height }}>
      <video ref={videoRef} src={src} muted={muted} preload="auto" playsInline
        aria-label="视频预览" onError={playbackError}
        onLoadedData={() => { setReady(true); setError(''); videoRef.current.currentTime = clamp(wantedTime.current-proxyRange.current.offset,0,proxyRange.current.end-proxyRange.current.offset); setTime(wantedTime.current); }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onTimeUpdate={() => setTime(videoRef.current.currentTime+proxyRange.current.offset)} onClick={togglePlay} />
      </div>
      {(!ready || error) && <div className="previewStatus" role="status">{error || (preparing ? '正在准备可播放的预览…' : '正在加载视频…')}</div>}
    </div>
    <div className="playerToolbar">
      <button className="playButton" disabled={!ready || disabled} onClick={togglePlay} aria-label={playing ? '暂停预览' : '播放所选片段'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playing ? <path d="M6 4h4v16H6zm8 0h4v16h-4z" /> : <path d="m7 3 15 9-15 9z" />}</svg>
        <span>{playing ? '暂停' : '播放选段'}</span>
      </button>
      <span className="playerTime">{displayTime(time)}<span> / {displayTime(duration)}</span></span>
      <label className="aspectPicker">比例 <select aria-label="画面比例" value={aspect} disabled={disabled} onChange={e => onAspectChange(e.target.value)}>
        <option value="original">原比例</option><option>1:1</option><option>9:16</option><option>16:9</option><option>3:4</option>
      </select></label>
      <button className="btn coverButton" disabled={!ready || disabled || time < start || time > end} onClick={() => onChange({ ...file.clip, cover: time })}><Icon name="photo" size={16} />设为封面</button>
    </div>
    <div className={`timelineEditor ${disabled ? 'timelineDisabled' : ''}`}>
      <div className="timelineRail" ref={railRef} onPointerDown={event => begin(event, 'playhead')}
        onPointerMove={dragMove} onPointerUp={dragEnd}
        onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
        <div className="filmstrip" aria-hidden="true">{frames.map((image, i) => <img key={i} src={image} alt="" draggable="false" />)}</div>
        <div className="trimShade" style={{ width: `${percent(start)}%` }} />
        <div className="trimShade rightShade" style={{ left: `${percent(end)}%` }} />
        <div className="trimSelection" onPointerDown={event => begin(event, 'selection')} style={{ left: `${percent(start)}%`, width: `${percent(end - start)}%` }} />
        {handles.map(({ kind, value, label, min, max }) => <div key={kind}
          role="slider" tabIndex={disabled ? -1 : 0} aria-label={label} aria-describedby="timelineKeys"
          aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={timecode(value)}
          className={`trimHandle ${kind}`} style={{ left: `${percent(value)}%` }}
          onPointerDown={event => begin(event, kind)} onKeyDown={event => key(event, kind, value)}><span /></div>)}
        <div role="slider" tabIndex={disabled ? -1 : 0} aria-label="播放位置" aria-valuemin={0} aria-valuemax={duration}
          aria-valuenow={time} aria-valuetext={timecode(time)} className="playhead" style={{ left: `${percent(time)}%` }}
          onPointerDown={event => begin(event, 'playhead')} onKeyDown={event => key(event, 'playhead', time)} />
        <div className="coverMarker" style={{ left: `${percent(cover)}%` }} title={`封面 ${timecode(cover)}`} aria-hidden="true" />
      </div>
      <div className="timelineTicks" aria-hidden="true">{[0, 1].map(fraction => <span key={fraction}>{displayTime(viewStart + viewSpan * fraction)}</span>)}</div>
    </div>
    {duration > 40 && <label className="sourceOverview">整段定位<input aria-label="在原视频中移动选段" type="range" min="0" max={duration-(end-start)} step="0.1" value={start} disabled={disabled} onChange={e => shiftRange(Number(e.target.value))} /></label>}
    <div className="trimSummary"><span>拖动两端截取，拖动选区移动 · 最长 30 秒</span><strong>{(end - start).toFixed(1)} 秒</strong></div>
    <span className="srOnly" id="timelineKeys">拖柄支持方向键微调，按住 Shift 加快调整。</span>
    {frameError && <p className="resultErr">{frameError}</p>}
  </section>;
}
