"""
Android launcher icons + splash screens for the NUMMAT app.

    python scripts/make_android_icons.py

Writes into mobile/android/app/src/main/res/:
  mipmap-*/ic_launcher.png, ic_launcher_round.png   classic icons (older Android)
  mipmap-*/ic_launcher_foreground.png               adaptive icon foreground (Android 8+)
  drawable/ic_launcher_background.xml               adaptive icon background (blue -> violet)
  drawable*/splash.png                              splash screens, portrait + landscape
Uses the same artwork as the desktop icon (scripts/make_icon.py).
"""
from __future__ import annotations

import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import make_icon as mk  # noqa: E402

RES = os.path.join(ROOT, "mobile", "android", "app", "src", "main", "res")
DENSITY = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
BG = (244, 247, 251)


def foreground(size: int = 1024) -> Image.Image:
    """Just the tile grid + sparkle, sized for the adaptive-icon safe zone (inner 61%)."""
    S = 2048
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ts, gap = int(S * 0.215), int(S * 0.033)
    grid_w = ts * 2 + gap
    ox, oy = (S - grid_w) // 2, (S - grid_w) // 2 + int(S * 0.01)
    gold = ((255, 226, 110, 255), (255, 170, 30, 255), (110, 55, 0, 255), (255, 200, 60, 150))
    white = ((255, 255, 255, 255), (222, 230, 250, 255), (32, 42, 90, 255), None)
    for label, (top, bottom, text, glow), cx, cy in [("3", gold, 0, 0), ("7", gold, 1, 0), ("5", white, 0, 1), ("5", white, 1, 1)]:
        t, pad = mk.tile(ts, label, top, bottom, text, glow)
        img.alpha_composite(t, (ox + cx * (ts + gap) - pad, oy + cy * (ts + gap) - pad))
    d = ImageDraw.Draw(img)
    sx, sy = ox + ts + gap // 2, oy - int(ts * 0.02)
    img.alpha_composite(mk.soft_layer((S, S), (255, 236, 160, 230), lambda dd: mk.sparkle(dd, sx, sy, ts * 0.36, 255), ts * 0.06))
    mk.sparkle(d, sx, sy, ts * 0.26, (255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)


def adaptive_preview(fg: Image.Image, px: int, shape: str = "circle") -> Image.Image:
    """What Android draws for the adaptive icon: gradient + foreground, visible centre 72/108, masked."""
    n = fg.size[0]
    bg = Image.new("RGBA", (n, n))
    d = ImageDraw.Draw(bg)
    for y in range(n):
        t = y / (n - 1)
        d.line([(0, y), (n, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip((74, 163, 255), (88, 52, 214))) + (255,))
    bg.alpha_composite(fg)
    m = int(n * 18 / 108)
    vis = bg.crop((m, m, n - m, n - m))
    mask = Image.new("L", vis.size, 0)
    if shape == "circle":
        ImageDraw.Draw(mask).ellipse((0, 0, vis.size[0] - 1, vis.size[1] - 1), fill=255)
    else:
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, vis.size[0] - 1, vis.size[1] - 1), radius=vis.size[0] // 4, fill=255)
    out = Image.new("RGBA", vis.size, (0, 0, 0, 0))
    out.paste(vis, (0, 0), mask)
    return out.resize((px, px), Image.LANCZOS)


def splash(w: int, h: int, master: Image.Image) -> Image.Image:
    img = Image.new("RGB", (w, h), BG)
    icon_px = int(min(w, h) * 0.34)
    icon = master.resize((icon_px, icon_px), Image.LANCZOS)
    x, y = (w - icon_px) // 2, int(h * 0.5 - icon_px * 0.72)
    img.paste(icon, (x, y), icon)
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(os.path.join(ROOT, "assets", "Alice-Regular.ttf"), int(icon_px * 0.30))
    except OSError:
        font = mk.font(int(icon_px * 0.26))
    text = "NUMMAT"
    tw = d.textbbox((0, 0), text, font=font)[2]
    d.text(((w - tw) / 2, y + icon_px + icon_px * 0.08), text, font=font, fill=(58, 141, 222))
    small = mk.font(max(10, int(icon_px * 0.075)))
    tag = "THINK.  MATCH.  CLEAR."
    tw2 = d.textbbox((0, 0), tag, font=small)[2]
    d.text(((w - tw2) / 2, y + icon_px * 1.52), tag, font=small, fill=(91, 107, 130))
    return img


def main() -> int:
    if not os.path.isdir(RES):
        print("Android project not found - run `npx cap add android` in mobile/ first", file=sys.stderr)
        return 1
    master = mk.draw_icon()
    fg = foreground()
    for name, k in DENSITY.items():
        folder = os.path.join(RES, f"mipmap-{name}")
        os.makedirs(folder, exist_ok=True)
        mk.small_variant(master, int(48 * k)).save(os.path.join(folder, "ic_launcher.png"))
        adaptive_preview(fg, int(48 * k), "circle").save(os.path.join(folder, "ic_launcher_round.png"))
        fg.resize((int(108 * k), int(108 * k)), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_foreground.png"))

    with open(os.path.join(RES, "drawable", "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                '<!-- NUMMAT adaptive icon background: blue -> violet, like the desktop icon -->\n'
                '<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n'
                '    <gradient android:angle="270" android:startColor="#4AA3FF" android:endColor="#5834D6" android:type="linear" />\n'
                '</shape>\n')
    for xml in ("ic_launcher.xml", "ic_launcher_round.xml"):
        with open(os.path.join(RES, "mipmap-anydpi-v26", xml), "w", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
                    '    <background android:drawable="@drawable/ic_launcher_background"/>\n'
                    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
                    '</adaptive-icon>\n')
    stale = os.path.join(RES, "drawable-v24", "ic_launcher_foreground.xml")   # Capacitor's placeholder logo
    if os.path.exists(stale):
        os.remove(stale)

    for path in glob.glob(os.path.join(RES, "drawable*", "splash.png")):
        w, h = Image.open(path).size
        splash(w, h, master).save(path, optimize=True)
    print("Android icons and splash screens written to", RES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
