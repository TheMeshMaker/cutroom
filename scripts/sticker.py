"""Render a sticker to a transparent PNG for Cutroom.

usage: sticker.py OUT.png emoji <character>
       sticker.py OUT.png shape <arrow|circle|bubble|burst|subscribe> [text]

Emoji come from the Windows color emoji font; shapes are drawn here.
"""
import math
import sys

from PIL import Image, ImageDraw, ImageFont

SIZE = 512
FONTS = "C:/Windows/Fonts/"


def font(name, size):
    try:
        return ImageFont.truetype(FONTS + name, size)
    except OSError:
        return ImageFont.load_default(size)


def emoji(ch):
    im = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((SIZE / 2, SIZE / 2), ch, font=font("seguiemj.ttf", 360), embedded_color=True, anchor="mm")
    return im


def outlined_text(d, xy, text, size, fill, stroke=(0, 0, 0, 255)):
    d.text(xy, text, font=font("seguibl.ttf", size), fill=fill, anchor="mm", stroke_width=max(2, size // 12), stroke_fill=stroke)


def shape(kind, text):
    # Drawn at 2x and scaled down for smooth edges.
    S = SIZE * 2
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    red, white, yellow = (229, 57, 53, 255), (255, 255, 255, 255), (255, 212, 0, 255)
    if kind == "arrow":
        pts = [(80, 430), (620, 430), (620, 250), (960, 512), (620, 774), (620, 594), (80, 594)]
        d.polygon(pts, fill=red, outline=white, width=24)
    elif kind == "circle":
        d.ellipse((90, 90, S - 90, S - 90), outline=red, width=56)
    elif kind == "bubble":
        d.rounded_rectangle((70, 140, S - 70, 700), radius=110, fill=white, outline=(0, 0, 0, 255), width=18)
        d.polygon([(260, 680), (420, 690), (230, 900)], fill=white, outline=(0, 0, 0, 255), width=18)
        d.rectangle((262, 660, 418, 700), fill=white)
        d.text((S / 2, 420), text or "...", font=font("seguibl.ttf", 150), fill=(20, 20, 20, 255), anchor="mm")
    elif kind == "burst":
        pts = []
        for i in range(32):
            r = 480 if i % 2 == 0 else 330
            a = math.pi * 2 * i / 32
            pts.append((S / 2 + r * math.cos(a), S / 2 + r * math.sin(a)))
        d.polygon(pts, fill=yellow, outline=red, width=20)
        outlined_text(d, (S / 2, S / 2), text or "WOW!", 210, red, white)
    elif kind == "subscribe":
        d.rounded_rectangle((60, 360, S - 60, 664), radius=90, fill=red)
        d.text((S / 2, 512), text or "SUBSCRIBE", font=font("seguibl.ttf", 150), fill=white, anchor="mm")
    else:
        raise SystemExit(f"unknown shape {kind}")
    return im.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    out, kind, value = sys.argv[1], sys.argv[2], sys.argv[3]
    im = emoji(value) if kind == "emoji" else shape(value, sys.argv[4] if len(sys.argv) > 4 else "")
    im.save(out)
    print(out)


if __name__ == "__main__":
    main()
