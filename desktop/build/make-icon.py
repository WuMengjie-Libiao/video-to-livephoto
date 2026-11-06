"""生成应用图标（dev 用，需要 Pillow）。产物：build/icon.png、build/icon.ico
用法：python make-icon.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 4096  # 超采样后缩小，边缘才平滑
OUT = Path(__file__).resolve().parent

TOP = (86, 118, 255)
BOTTOM = (146, 88, 255)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = (
            round(TOP[0] + (BOTTOM[0] - TOP[0]) * t),
            round(TOP[1] + (BOTTOM[1] - TOP[1]) * t),
            round(TOP[2] + (BOTTOM[2] - TOP[2]) * t),
        )
    return img.resize((size, size), Image.Resampling.BILINEAR)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius, fill=255)
    return mask


def triangle_mask(size: int, cx: float, cy: float, w: float) -> Image.Image:
    """圆角三角：画满再高斯模糊后二值化，圆角半径≈模糊半径，不会出现接缝缺口。"""
    h = w * 0.98
    left, right = cx - w * 0.32, cx + w * 0.44
    top, bottom = cy - h / 2, cy + h / 2
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon([(left, top), (right, cy), (left, bottom)], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w * 0.055))
    return mask.point(lambda v: 255 if v > 128 else 0)


def main() -> None:
    base = gradient(S).convert("RGBA")
    base.putalpha(rounded_mask(S, radius=int(S * 0.225)))

    mask = triangle_mask(S, cx=S * 0.52, cy=S * 0.5, w=S * 0.40)
    base.paste(Image.new("RGBA", (S, S), (255, 255, 255, 255)), mask=mask)

    icon = base.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon.save(OUT / "icon.png")
    icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                                       (64, 64), (128, 128), (256, 256)])
    print("saved", OUT / "icon.png", OUT / "icon.ico")


if __name__ == "__main__":
    main()
