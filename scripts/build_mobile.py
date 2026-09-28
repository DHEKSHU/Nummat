"""
Assemble the Android app's web files.

    python scripts/build_mobile.py

Copies the same game UI the desktop app uses (templates/index.html + static/)
into mobile/www/, adds the JavaScript engine (mobile/src/engine.js) and the
on-device API (mobile/src/localapi.js), and turns the Flask template into a
plain HTML page. Capacitor then packages mobile/www into the APK.

Run it again whenever you change the game UI - GitHub Actions runs it
automatically before every APK build.
"""
from __future__ import annotations

import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, "mobile", "www")
SKIP_STATIC = {"default.png", "default.jpg"}   # large originals not used by the UI


def main() -> int:
    if os.path.exists(WWW):
        shutil.rmtree(WWW)
    os.makedirs(WWW)

    # static assets (same files as desktop)
    shutil.copytree(os.path.join(ROOT, "static"), os.path.join(WWW, "static"),
                    ignore=lambda d, names: [n for n in names if n in SKIP_STATIC])
    mob = os.path.join(WWW, "static", "mobile")
    os.makedirs(mob, exist_ok=True)
    for name in ("engine.js", "localapi.js"):
        shutil.copy2(os.path.join(ROOT, "mobile", "src", name), os.path.join(mob, name))

    # index.html: Jinja url_for(...) -> plain paths
    with open(os.path.join(ROOT, "templates", "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = re.sub(r"\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}", r"/static/\1", html)
    if "{{" in html or "{%" in html:
        print("index.html still contains template tags - update build_mobile.py", file=sys.stderr)
        return 1
    # phone-friendly viewport: no pinch/double-tap zoom while playing
    html = html.replace('content="width=device-width, initial-scale=1, viewport-fit=cover"',
                        'content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"')
    # the game engine + local API load before the UI script
    engine_tags = ('  <script src="/static/mobile/engine.js"></script>\n'
                   '  <script src="/static/mobile/localapi.js"></script>\n')
    marker = '  <script src="/static/js/charts.js"></script>'
    if marker not in html:
        print("could not find the script block in index.html", file=sys.stderr)
        return 1
    html = html.replace(marker, engine_tags + marker)
    html = html.replace("<body>", '<body class="mobile-app">', 1)
    with open(os.path.join(WWW, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

    size = sum(os.path.getsize(os.path.join(d, n)) for d, _, ns in os.walk(WWW) for n in ns)
    print(f"mobile/www ready ({size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
