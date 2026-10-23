# -*- coding: utf-8 -*-
"""聴のアイコン生成（緑地・白の「聴」）

出力: docs/icon-180.png / icon-192.png / icon-512.png
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DOCS = Path(__file__).parent / "docs"
BG = (15, 118, 110)     # アプリのアクセント色 #0f766e
FG = (255, 255, 255)
FONT = r"C:\Windows\Fonts\YuGothB.ttc"  # 游ゴシック Bold
CHAR = "聴"


def make_icon(size, path, rounded):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * 0.22) if rounded else 0
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    font = ImageFont.truetype(FONT, int(size * 0.62))
    left, top, right, bottom = draw.textbbox((0, 0), CHAR, font=font)
    x = (size - (right - left)) / 2 - left
    y = (size - (bottom - top)) / 2 - top
    draw.text((x, y), CHAR, font=font, fill=FG)
    img.save(path)
    print(f"{path.name}: {size}x{size}")


def main():
    # iOS の apple-touch-icon は OS 側で角を丸めるので角丸なし
    make_icon(180, DOCS / "icon-180.png", rounded=False)
    make_icon(192, DOCS / "icon-192.png", rounded=True)
    make_icon(512, DOCS / "icon-512.png", rounded=True)


if __name__ == "__main__":
    main()
