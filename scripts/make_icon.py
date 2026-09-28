"""
Draw the NUMMAT app icon and export every size the desktop build needs.

    python scripts/make_icon.py

Writes
    assets/nummat.ico          Windows exe / taskbar icon (16-256 px, multi-size)
    assets/nummat.icns         macOS app icon
    assets/nummat_1024.png     master artwork
    static/icon-192.png, static/icon-512.png, static/favicon.png   in-app / browser icons

Design: a glossy 2 x 2 tile grid on a blue-to-violet badge. The 3 and 7 tiles
glow gold - a matched pair (3 + 7 = 10) - with a sparkle, so the icon shows
the game's core idea even at 16 px.
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 2048  # supersampled canvas; downscaled for smooth edges

FONT_CANDIDATES = [
    os.path.join(ROOT, "assets", "Poppins-Bold.ttf"),
    "/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf",
    "C:/Windows/Fonts/seguibl.ttf",      # Segoe UI Black
    "C:/Windows/Fonts/arialbd.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vertical_gradient(size, top, bottom):
    w, h = size
    g = Image.new("RGBA", (1, h))
    for y in range(h):
        g.putpixel((0, y), lerp(top, bottom, y / (h - 1)))
    return g.resize((w, h))


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m


def soft_layer(size, color, draw_fn, blur):
    """A blurred shape in one colour. Blurring only the alpha channel avoids dark fringes."""
    a = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(a))
    a = a.filter(ImageFilter.GaussianBlur(blur))
    layer = Image.new("RGBA", size, color[:3] + (255,))
    layer.putalpha(ImageChops.multiply(a, Image.new("L", size, color[3])))
    return layer


def tile(size, label, top, bottom, text_color, glow=None):
    """One glossy tile with a number, returned with its drop shadow."""
    pad = int(size * 0.18)
    canvas = Image.new("RGBA", (size + pad * 2, size + pad * 2), (0, 0, 0, 0))
    r = int(size * 0.22)

    # soft shadow (and optional coloured glow)
    canvas.alpha_composite(soft_layer(canvas.size, (20, 10, 70, 140), lambda d: d.rounded_rectangle(
        (pad, pad + size * 0.06, pad + size, pad + size * 1.06), r, fill=255), size * 0.05))
    if glow:
        canvas.alpha_composite(soft_layer(canvas.size, glow, lambda d: d.rounded_rectangle(
            (pad, pad, pad + size, pad + size), r, fill=255), size * 0.10))

    # body
    body = vertical_gradient((size, size), top, bottom)
    mask = rounded_mask((size, size), r)
    face = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    face.paste(body, (0, 0), mask)

    # bottom bevel
    bevel = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(bevel).rounded_rectangle((0, size * 0.80, size - 1, size - 1), r, fill=(0, 0, 0, 28))
    face.alpha_composite(Image.composite(bevel, Image.new("RGBA", (size, size)), mask))

    # gloss: a soft white band across the top (drawn under the number so digits stay crisp)
    gloss = Image.new("L", (size, size), 0)
    ImageDraw.Draw(gloss).ellipse((-size * 0.35, -size * 0.95, size * 1.35, size * 0.42), fill=95)
    gloss = ImageChops.multiply(gloss.filter(ImageFilter.GaussianBlur(size * 0.02)), mask)
    face.alpha_composite(Image.merge("RGBA", (Image.new("L", (size, size), 255),) * 3 + (gloss,)))

    # number
    d = ImageDraw.Draw(face)
    f = font(int(size * 0.66))
    bbox = d.textbbox((0, 0), label, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1] + size * 0.01
    d.text((x, y + size * 0.03), label, font=f, fill=(255, 255, 255, 140))   # light emboss under the digit
    d.text((x, y), label, font=f, fill=text_color)

    canvas.alpha_composite(face, (pad, pad))
    return canvas, pad


def sparkle(draw, cx, cy, r, fill):
    pts = []
    import math
    for k in range(8):
        ang = math.pi / 4 * k - math.pi / 2
        rad = r if k % 2 == 0 else r * 0.28
        pts.append((cx + rad * math.cos(ang), cy + rad * math.sin(ang)))
    draw.polygon(pts, fill=fill)


def draw_icon() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    margin = int(S * 0.04)
    badge = S - margin * 2
    radius = int(badge * 0.23)

    # badge background: blue -> violet with a top highlight
    bg = vertical_gradient((badge, badge), (74, 163, 255, 255), (88, 52, 214, 255))
    hl = Image.new("L", (badge, badge), 0)
    ImageDraw.Draw(hl).ellipse((-badge * 0.3, -badge * 0.75, badge * 1.3, badge * 0.55), fill=70)
    hl = hl.filter(ImageFilter.GaussianBlur(badge * 0.05))  # alpha-only, white RGB: no fringe
    bg.alpha_composite(Image.merge("RGBA", (Image.new("L", (badge, badge), 255),) * 3 + (hl,)))
    mask = rounded_mask((badge, badge), radius)

    # badge drop shadow
    img.alpha_composite(soft_layer((S, S), (20, 10, 60, 110), lambda d: d.rounded_rectangle(
        (margin, margin + S * 0.015, margin + badge, margin + badge + S * 0.015), radius, fill=255), S * 0.012))
    img.paste(bg, (margin, margin), mask)

    # inner rim
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle((margin + 6, margin + 6, margin + badge - 6, margin + badge - 6),
                                          radius - 6, outline=(255, 255, 255, 70), width=int(S * 0.008))
    img.alpha_composite(rim)

    # 2 x 2 tile grid: [3][7] gold (a matched pair), [5][5] white
    ts = int(badge * 0.36)
    gap = int(badge * 0.055)
    grid_w = ts * 2 + gap
    ox = margin + (badge - grid_w) // 2
    oy = margin + (badge - grid_w) // 2 + int(badge * 0.01)
    gold = ((255, 226, 110, 255), (255, 170, 30, 255), (110, 55, 0, 255), (255, 200, 60, 150))
    white = ((255, 255, 255, 255), (222, 230, 250, 255), (32, 42, 90, 255), None)
    layout = [("3", gold, 0, 0), ("7", gold, 1, 0), ("5", white, 0, 1), ("5", white, 1, 1)]
    for label, (top, bottom, text, glow), cx, cy in layout:
        t, pad = tile(ts, label, top, bottom, text, glow)
        img.alpha_composite(t, (ox + cx * (ts + gap) - pad, oy + cy * (ts + gap) - pad))

    # sparkle over the matched pair
    d = ImageDraw.Draw(img)
    sx, sy = ox + ts + gap // 2, oy - int(ts * 0.02)
    img.alpha_composite(soft_layer((S, S), (255, 236, 160, 230),
                                   lambda dd: sparkle(dd, sx, sy, ts * 0.36, 255), ts * 0.06))
    sparkle(d, sx, sy, ts * 0.26, (255, 255, 255, 255))
    sparkle(d, sx + ts * 0.9, sy + ts * 0.02, ts * 0.09, (255, 255, 255, 230))
    return img.resize((1024, 1024), Image.LANCZOS)


def small_variant(master: Image.Image, px: int) -> Image.Image:
    """Tiny sizes get a touch of sharpening so the digits stay legible."""
    im = master.resize((px, px), Image.LANCZOS)
    if px <= 48:
        im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=80, threshold=2))
    return im


def main() -> None:
    assets = os.path.join(ROOT, "assets")
    static = os.path.join(ROOT, "static")
    os.makedirs(assets, exist_ok=True)
    master = draw_icon()
    master.save(os.path.join(assets, "nummat_1024.png"))

    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [small_variant(master, s) for s in sizes]
    frames[-1].save(os.path.join(assets, "nummat.ico"), format="ICO",
                    sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    try:
        master.save(os.path.join(assets, "nummat.icns"), format="ICNS")
    except (OSError, ValueError, KeyError) as e:  # ICNS support varies by Pillow build
        print("  (skipped .icns:", e, ")")

    small_variant(master, 512).save(os.path.join(static, "icon-512.png"))
    small_variant(master, 192).save(os.path.join(static, "icon-192.png"))
    small_variant(master, 64).save(os.path.join(static, "favicon.png"))
    print("Icons written to assets/ and static/")


if __name__ == "__main__":
    sys.exit(main())
