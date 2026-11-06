#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
livephoto.py — 视频转「实况照片」本地工具（离线，无广告，无账号）

两种输出：
  --target android   单个 .MP.JPG（Google Motion Photo，内嵌视频）→ 安卓相册 / 小红书 / 微信
  --target apple     成对文件 IMG_xxxx.JPG + IMG_xxxx.MOV（同一个 ContentIdentifier）→ iPhone 相册

依赖：ffmpeg / ffprobe（必需）；exiftool（可选，用于把 UUID 写进静图）

示例：
  python livephoto.py clip.mp4 --target android
  python livephoto.py clip.mp4 --target apple --start 1.2 --duration 2.8 --wallpaper
  python livephoto.py a.mp4 b.mp4 --target android --outdir out
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

# 打包成窗口程序后 sys.stdout 可能是 None，print 会炸；给它一个黑洞
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = sys.stdout

# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------


def die(msg: str) -> "NoReturn":  # noqa: F821
    print(f"[x] {msg}", file=sys.stderr)
    sys.exit(1)


def run(cmd: list[str], quiet: bool = True) -> subprocess.CompletedProcess:
    """执行命令，失败时把 stderr 回显出来。"""
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        tail = (p.stderr or "").strip().splitlines()[-8:]
        die("命令失败：\n  " + " ".join(cmd) + "\n  " + "\n  ".join(tail))
    return p


_BIN_CACHE: dict[str, str | None] = {}


def _search_paths(name: str) -> list[Path]:
    """按优先级列出可能的二进制位置（打包后可执行文件同目录 / _MEIPASS / PATH）。"""
    exe = f"{name}.exe" if sys.platform == "win32" else name
    here = Path(__file__).resolve().parent
    out: list[Path] = []

    env_key = f"LP_{name.upper()}"
    if os.environ.get(env_key):
        out.append(Path(os.environ[env_key]))

    if getattr(sys, "frozen", False):  # PyInstaller 打包后
        out.append(Path(sys.executable).parent / exe)
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            out += [Path(meipass) / exe, Path(meipass) / "bin" / exe]

    out += [here / exe, here / "bin" / exe]

    found = shutil.which(name)
    if found:
        out.append(Path(found))

    out += [Path("/opt/homebrew/bin") / name, Path("/usr/local/bin") / name]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        out.append(Path(local) / "Microsoft/WinGet/Links" / exe)
    return out


def resolve_bin(name: str) -> str | None:
    if name in _BIN_CACHE:
        return _BIN_CACHE[name]
    for p in _search_paths(name):
        try:
            if p.is_file():
                _BIN_CACHE[name] = str(p)
                return str(p)
        except OSError:
            continue
    _BIN_CACHE[name] = None
    return None


def need(binary: str) -> str:
    path = resolve_bin(binary)
    if not path:
        hint = ("winget install Gyan.FFmpeg" if sys.platform == "win32"
                else "brew install ffmpeg")
        die(f"找不到 {binary}。装一下（{hint}），"
            f"或把它放到本程序同目录。")
    return path


def find_exiftool() -> str | None:
    """exiftool 在 Windows 上常装成 ExifTool.exe，且不一定在 PATH 里。"""
    for name in ("exiftool", "ExifTool"):
        p = resolve_bin(name)
        if p:
            return p
    cands = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/ExifTool/ExifTool.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "ExifTool/ExifTool.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "ExifTool/ExifTool.exe",
        Path("/opt/homebrew/bin/exiftool"),
        Path("/usr/local/bin/exiftool"),
    ]
    return next((str(c) for c in cands if c.is_file()), None)


def probe(path: Path) -> dict:
    out = run([need("ffprobe"), "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", str(path)]).stdout
    return json.loads(out)


def video_info(path: Path) -> tuple[float, int, int]:
    """返回 (时长秒, 宽, 高)。"""
    meta = probe(path)
    streams = meta.get("streams", [])
    vs = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not vs:
        die(f"{path} 里没有视频流")
    dur = float(meta.get("format", {}).get("duration") or vs.get("duration") or 0)
    # 处理旋转
    w, h = int(vs["width"]), int(vs["height"])
    rot = 0
    for sd in vs.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = abs(int(sd["rotation"]))
    if rot % 180 == 90:
        w, h = h, w
    return dur, w, h


# ----------------------------------------------------------------------------
# 1. 抽静帧
# ----------------------------------------------------------------------------


def extract_still(video: Path, ts: float, out: Path, height: int) -> None:
    vf = f"scale=-2:{height}:flags=lanczos" if height else "null"
    run([need("ffmpeg"), "-y", "-v", "error", "-ss", f"{ts:.3f}", "-i", str(video),
         "-frames:v", "1", "-vf", vf, "-pix_fmt", "yuvj420p", "-q:v", "2", str(out)])
    if not out.exists() or out.stat().st_size < 1024:
        die("抽帧失败（时间点可能超出视频长度）")


# ----------------------------------------------------------------------------
# 2. 编码视频
# ----------------------------------------------------------------------------


def encode_video(video: Path, start: float, duration: float, out: Path,
                 height: int, fps: int, mute: bool, wallpaper: bool,
                 crf: int) -> None:
    vf = []
    if height:
        vf.append(f"scale=-2:{height}:flags=lanczos")
    if wallpaper:
        # 壁纸要求 H.264 + 60fps
        vf.append(f"fps={fps}")
    vf_s = ",".join(vf) if vf else "null"

    if wallpaper:
        # 壁纸形态：H.264 / 60fps / 无音轨（与真机实况一致）。
        # 注意不要加 +faststart：moov 放尾部，注入元数据时不会移动 mdat。
        cmd = [need("ffmpeg"), "-y", "-v", "error",
               "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(video),
               "-an", "-vf", vf_s, "-c:v", "libx264", "-profile:v", "high",
               "-preset", "medium", "-crf", str(crf),
               "-pix_fmt", "yuv420p", str(out)]
    else:
        # 社交形态：H.264 + AAC（保留原声）
        audio = ["-an"] if mute else ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]
        cmd = [need("ffmpeg"), "-y", "-v", "error",
               "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(video),
               *audio, "-vf", vf_s, "-c:v", "libx264", "-profile:v", "high",
               "-preset", "medium", "-crf", str(crf),
               "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", str(out)]
    run(cmd)


# ----------------------------------------------------------------------------
# 3. Motion Photo（单文件 JPEG + 尾部 MP4）
# ----------------------------------------------------------------------------

XMP_TPL = """<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="livephoto.py">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"
    xmlns:Container="http://ns.google.com/photos/1.0/container/"
    xmlns:Item="http://ns.google.com/photos/1.0/container/item/"
    GCamera:MotionPhoto="1"
    GCamera:MotionPhotoVersion="1"
    GCamera:MotionPhotoPresentationTimestampUs="{ts_us}"
    GCamera:MicroVideo="1"
    GCamera:MicroVideoVersion="1"
    GCamera:MicroVideoOffset="{video_len}"
    GCamera:MicroVideoPresentationTimestampUs="{ts_us}">
   <Container:Directory>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary"
        Item:Length="{still_len}" Item:Padding="0"/>
     </rdf:li>
     <rdf:li rdf:parseType="Resource">
      <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto"
        Item:Length="{video_len}" Item:Padding="0"/>
     </rdf:li>
    </rdf:Seq>
   </Container:Directory>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""

XMP_NS = b"http://ns.adobe.com/xap/1.0/\x00"


def _insert_app1(jpeg: bytes, xml: str) -> bytes:
    """在 APP0(JFIF) 之后插入 APP1(XMP)；没有 APP0 就紧跟 SOI。"""
    if not jpeg.startswith(b"\xff\xd8"):
        die("不是合法 JPEG")
    payload = XMP_NS + xml.encode("utf-8")
    seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    off = 2
    # 跳过 APP0 / 已有的 APP1
    while off + 4 <= len(jpeg) and jpeg[off] == 0xFF:
        marker, size = jpeg[off + 1], struct.unpack(">H", jpeg[off + 2:off + 4])[0]
        if marker in (0xE0, 0xE1) and size >= 2:
            off += 2 + size
        else:
            break
    return jpeg[:off] + seg + jpeg[off:]


def build_motion_photo(still: Path, video: Path, out: Path, ts_us: int) -> None:
    raw = still.read_bytes()
    if raw.startswith(b"\xff\xd8"):
        pass
    else:
        # HEIC 等 → 转 JPEG
        tmp = out.with_suffix(".still.jpg")
        run([need("ffmpeg"), "-y", "-v", "error", "-i", str(still),
             "-frames:v", "1", "-pix_fmt", "yuvj420p", "-q:v", "2", str(tmp)])
        raw = tmp.read_bytes()
        tmp.unlink(missing_ok=True)

    vid = video.read_bytes()
    # 两轮迭代：XMP 里的 still_len 会随 XMP 自身大小变化，收敛后写入
    still_len = len(raw)
    for _ in range(6):
        xml = XMP_TPL.format(ts_us=ts_us, video_len=len(vid), still_len=still_len)
        composed = _insert_app1(raw, xml)
        if len(composed) == still_len:
            break
        still_len = len(composed)
    out.write_bytes(composed + vid)
    return None


def verify_motion_photo(path: Path) -> dict:
    """自检：读 XMP，校验各段长度是否与文件实际一致。"""
    import re

    data = path.read_bytes()
    i = data.find(b"GCamera:MotionPhotoVersion")
    if i < 0:
        return {"ok": False, "reason": "没有找到 XMP MotionPhoto 标记"}
    j0 = data.rfind(b"<x:xmpmeta", 0, i)
    j1 = data.find(b"</x:xmpmeta>", i)
    xml = data[j0:j1].decode("utf-8", "replace")

    def num(tag: str) -> int:
        m = re.search(tag + r'="(\d+)"', xml)
        return int(m.group(1)) if m else -1

    m = re.search(r'Mime="video/mp4"[^>]*Item:Length="(\d+)"', xml, re.S) \
        or re.search(r'Item:Length="(\d+)"[^>]*Mime="video/mp4"', xml, re.S)
    video_len = int(m.group(1)) if m else -1
    still_len = num("Item:Length")
    total = len(data)
    ok = still_len > 0 and video_len > 0 and still_len == total - video_len
    return {"ok": ok, "total": total, "still_len": still_len, "video_len": video_len,
            "ts_us": num("MicroVideoPresentationTimestampUs")}


# ----------------------------------------------------------------------------
# 4. Apple Live Photo（成对文件 + 同一个 UUID）
# ----------------------------------------------------------------------------

# --- 4a. MOV: 注入 com.apple.quicktime.content.identifier -------------------

def _box(btype: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload) + 8) + btype + payload


def _iter_boxes(data: bytes, start: int = 0, end: int | None = None):
    end = len(data) if end is None else end
    i = start
    while i + 8 <= end:
        size = struct.unpack(">I", data[i:i + 4])[0]
        btype = data[i + 4:i + 8]
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
        if size < 8:
            break
        yield btype, i, size
        i += size


def _find_box(data: bytes, path: list[bytes], start: int = 0, end: int | None = None):
    end = len(data) if end is None else end
    for btype, off, size in _iter_boxes(data, start, end):
        if btype == path[0]:
            if len(path) == 1:
                return off, size
            inner_start = off + 8
            if btype in (b"meta",):
                inner_start = off + 12  # meta 是 full box
            return _find_box(data, path[1:], inner_start, off + size)
    return None


def _make_meta_keys(identifier: str) -> bytes:
    """keys + ilst，只放 com.apple.quicktime.content.identifier。"""
    key_name = b"com.apple.quicktime.content.identifier"
    # keys: version/flags(4) + entry_count(4) + key_size(4) + "mdta" + name
    key_entry = struct.pack(">I", 8 + len(key_name)) + b"mdta" + key_name
    keys = b"\x00\x00\x00\x00" + struct.pack(">I", 1) + key_entry

    # ilst: 一个 item，box type = key index(1)
    #   data box: "data" + type(4, 1=UTF-8) + locale(4) + 值
    value = identifier.encode("utf-8")
    data_box = _box(b"data", struct.pack(">I", 1) + struct.pack(">I", 0) + value)
    ilst = _box(struct.pack(">I", 1), data_box)

    hdlr_payload = b"\x00\x00\x00\x00" + b"\x00\x00\x00\x00" + b"mdta" + b"\x00" * 12 + b"\x00"
    meta_payload = (b"\x00\x00\x00\x00" + _box(b"hdlr", hdlr_payload)
                    + _box(b"keys", keys) + _box(b"ilst", ilst))
    return _box(b"meta", meta_payload)


def _walk_boxes(data: bytes, start: int, end: int):
    """递归遍历 box，yield (btype, offset, size)。"""
    for btype, off, size in _iter_boxes(data, start, end):
        yield btype, off, size
        if btype in (b"moov", b"trak", b"mdia", b"minf", b"stbl", b"udta", b"edts"):
            yield from _walk_boxes(data, off + 8, off + size)


def _shift_chunk_offsets(moov: bytes, delta: int) -> bytes:
    """moov 变大后 mdat 会后移，必须同步修正 stco / co64 里的绝对偏移。"""
    if delta == 0:
        return moov
    buf = bytearray(moov)
    for btype, off, size in _walk_boxes(bytes(buf), 0, len(buf)):
        if btype not in (b"stco", b"co64"):
            continue
        count = struct.unpack(">I", buf[off + 12:off + 16])[0]
        ent = off + 16
        wide = btype == b"co64"
        step = 8 if wide else 4
        for i in range(count):
            p = ent + i * step
            if p + step > off + size:
                break
            if wide:
                v = struct.unpack(">Q", buf[p:p + 8])[0]
                buf[p:p + 8] = struct.pack(">Q", v + delta)
            else:
                v = struct.unpack(">I", buf[p:p + 4])[0]
                buf[p:p + 4] = struct.pack(">I", v + delta)
    return bytes(buf)


def inject_mov_identifier(mov: Path, identifier: str) -> None:
    data = mov.read_bytes()
    moov = None
    first_mdat = None
    for btype, off, size in _iter_boxes(data):
        if btype == b"moov" and moov is None:
            moov = (off, size)
        elif btype == b"mdat" and first_mdat is None:
            first_mdat = off
    if not moov:
        die("MOV 缺少 moov box")

    moov_off, moov_size = moov
    moov_body = data[moov_off + 8: moov_off + moov_size]

    # 若已有 udta/meta，整体替换 meta
    meta = _make_meta_keys(identifier)
    existing = _find_box(moov_body, [b"udta"])
    if existing:
        u_off, u_size = existing
        udta_body = moov_body[u_off + 8: u_off + u_size]
        hit = _find_box(udta_body, [b"meta"])
        if hit:
            m_off, m_size = hit
            udta_new = udta_body[:m_off] + meta + udta_body[m_off + m_size:]
        else:
            udta_new = udta_body + meta
        moov_new = moov_body[:u_off] + _box(b"udta", udta_new) + moov_body[u_off + u_size:]
    else:
        moov_new = moov_body + _box(b"udta", meta)

    new_moov = _box(b"moov", moov_new)
    delta = len(new_moov) - moov_size

    # moov 在 mdat 之前时，插入会让 mdat 后移 → 修正 chunk 偏移
    if first_mdat is not None and moov_off < first_mdat and delta:
        new_moov = _shift_chunk_offsets(new_moov, delta)

    mov.write_bytes(data[:moov_off] + new_moov + data[moov_off + moov_size:])


# --- 4b. 静图：把同一个 UUID 写进去 -----------------------------------------
#
# 说明：iOS 是靠静图里的 Apple MakerNote（tag 0x0011）认领视频的。
# 这个 MakerNote 的二进制布局很挑 exiftool 的解析，手搓容易写坏（实测会报
# "Bad MakerNotes directory"）。稳妥做法是拿一张你自己的真机实况静图当模板，
# 把里面那串 UUID 原地替换掉 —— 长度不变，布局天然正确。

UUID_RE = re.compile(rb"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
                     rb"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")


def read_tag(path: Path, tag: str, group: str = "") -> str:
    exif = find_exiftool()
    if not exif:
        return ""
    name = f"-{group}:{tag}" if group else f"-{tag}"
    p = subprocess.run([exif, "-q", "-q", "-s", name, str(path)],
                       capture_output=True, text=True, errors="replace")
    out = (p.stdout or "").strip()
    if " : " in out:
        return out.split(" : ", 1)[1].strip()
    return out


def makernote_from_donor(donor: Path, identifier: str) -> bytes | None:
    """从真机实况静图里取出 MakerNote，替换 UUID。"""
    exif = find_exiftool()
    if not exif or not donor or not donor.exists():
        return None
    p = subprocess.run([exif, "-q", "-q", "-b", "-MakerNoteApple", str(donor)],
                       capture_output=True)
    block = p.stdout if p.returncode == 0 else b""
    if len(block) < 32:
        return None
    m = UUID_RE.search(block)
    if not m or len(m.group(0)) != len(identifier):
        return None
    return block[:m.start()] + identifier.encode("ascii") + block[m.end():]


def write_still_identifier(still: Path, identifier: str,
                           donor: Path | None) -> tuple[bool, str]:
    """返回 (是否写入成功, 说明)。成功后会用 exiftool 读回校验。"""
    exif = find_exiftool()
    if not exif:
        return False, "没装 exiftool，跳过（不影响下面用 iOS 导入器方案）"

    block = makernote_from_donor(donor, identifier) if donor else None
    if block is None and donor:
        return False, f"模板 {donor.name} 里没有可替换的 UUID（请用真机拍的实况静图）"
    if block is None:
        return False, "未提供 --donor 模板，静图 UUID 未写入"

    tmp = still.with_suffix(".mn.bin")
    tmp.write_bytes(block)
    p = subprocess.run([exif, "-q", "-q", "-overwrite_original",
                        f"-MakerNoteApple<={tmp}", str(still)],
                       capture_output=True, text=True)
    tmp.unlink(missing_ok=True)
    got = read_tag(still, "ContentIdentifier", "MakerNotes").upper()
    if got == identifier.upper():
        return True, "已写入并校验通过"
    return False, f"写入后读回不一致（读到 {got or '空'}）"


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------


def _do_android(src: Path, args, still: Path, tdp: Path, duration: float,
                target_h: int, still_ts: float, outdir: Path) -> list[Path]:
    vid = tdp / "clip.mp4"
    encode_video(src, args.start, duration, vid, target_h,
                 fps=30, mute=args.mute, wallpaper=False, crf=args.crf)
    out = outdir / f"{src.stem}.MP.JPG"
    build_motion_photo(still, vid, out, int(round((still_ts - args.start) * 1e6)))
    chk = verify_motion_photo(out)
    if not chk["ok"]:
        die(f"自检失败：{chk}")
    print(f"[ok] {out.name}  ({out.stat().st_size/1e6:.2f} MB, "
          f"静图 {chk['still_len']/1e3:.0f}KB + 视频 {chk['video_len']/1e6:.2f}MB)")
    return [out]


def _do_apple(src: Path, args, still: Path, tdp: Path, duration: float,
              target_h: int, outdir: Path) -> list[Path]:
    ident = args.identifier or str(uuid.uuid4()).upper()
    fps = 60 if args.wallpaper else 30
    vid = tdp / "clip.mov"
    encode_video(src, args.start, duration, vid, target_h, fps=fps,
                 mute=(True if args.wallpaper else args.mute),
                 wallpaper=args.wallpaper, crf=args.crf)
    inject_mov_identifier(vid, ident)

    still_out = outdir / f"{src.stem}.JPG"
    shutil.copy2(still, still_out)
    ok, msg = write_still_identifier(still_out, ident, args.donor)

    mov_out = outdir / f"{src.stem}.MOV"
    shutil.copy2(vid, mov_out)

    mov_id = read_tag(mov_out, "ContentIdentifier", "Keys")
    kinds = "+".join(sorted({s.get("codec_type", "?")
                             for s in probe(mov_out).get("streams", [])}))
    print(f"[ok] {still_out.name} + {mov_out.name}")
    print(f"     UUID {ident[:8]}…  MOV 标识 {mov_id or '（读不到）'}  "
          f"流 {kinds} / {duration:.2f}s")
    print(f"     静图标识 {msg}")
    if not ok:
        print("     ↳ 静图缺口令，只能走「iOS 导入器」（见 README 3.2 A）")
    if args.wallpaper:
        print("     ↳ 壁纸模式 60fps/无音轨；锁屏动画仍需 mebx 轨")
    return [still_out, mov_out]


def process(src: Path, args) -> list[Path]:
    dur, _w, h = video_info(src)
    duration = min(args.duration or 3.0, max(0.3, dur - args.start))
    if duration <= 0.2:
        die(f"{src.name} 太短（{dur:.2f}s）")

    still_ts = args.start + duration * (1.0 if args.still_at == "end" else 0.5)
    still_ts = max(0.0, min(still_ts, dur - 0.05))
    target_h = min(args.height, h) if args.height else min(1080, h)

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    outputs: list[Path] = []

    with tempfile.TemporaryDirectory(prefix="lp_") as td:
        tdp = Path(td)
        still = tdp / "still.jpg"
        extract_still(src, still_ts, still, target_h)

        if args.target in ("android", "both"):
            outputs += _do_android(src, args, still, tdp, duration, target_h, still_ts, outdir)
        if args.target in ("apple", "both"):
            outputs += _do_apple(src, args, still, tdp, duration, target_h, outdir)

    return outputs


def main() -> None:
    ap = argparse.ArgumentParser(
        description="视频转实况照片（本地离线）。不带参数运行会打开网页界面。")
    ap.add_argument("inputs", nargs="*", type=Path, help="输入视频（可多个）")
    ap.add_argument("--target", choices=["both", "android", "apple"], default="both",
                    help="both=两种都出（默认）；android=单文件；apple=成对文件")
    ap.add_argument("--start", type=float, default=0.0, help="起始秒")
    ap.add_argument("--duration", type=float, default=3.0, help="时长秒（默认 3s）")
    ap.add_argument("--still-at", choices=["mid", "end"], default="mid", help="封面帧位置")
    ap.add_argument("--height", type=int, default=1080, help="输出高度（默认不超过 1080）")
    ap.add_argument("--crf", type=int, default=20, help="H.264 质量，越小越好（默认 20）")
    ap.add_argument("--mute", action="store_true", help="去掉原声")
    ap.add_argument("--wallpaper", action="store_true",
                    help="壁纸形态（60fps / 无音轨）")
    ap.add_argument("--identifier", help="指定 Live Photo UUID（默认随机）")
    ap.add_argument("--donor", type=Path,
                    help="Apple 目标：你自己的真机实况静图（JPG/HEIC），"
                         "用作 MakerNote 模板，UUID 会被替换")
    ap.add_argument("--outdir", type=Path, default=Path("out"))
    ap.add_argument("--app", action="store_true", help="打开桌面窗口")
    args = ap.parse_args()

    for f in ("ffmpeg", "ffprobe"):
        need(f)

    if args.app or not args.inputs:
        import app
        app.main()
        return

    for src in args.inputs:
        if not src.exists():
            die(f"文件不存在：{src}")
        print(f"→ {src.name}")
        process(src, args)


if __name__ == "__main__":
    main()
