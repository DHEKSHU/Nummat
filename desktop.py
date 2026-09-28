"""
NUMMAT desktop launcher - runs the game in its own window.

    python desktop.py          (while developing)
    NUMMAT.exe                 (the built game - see build.bat)

Portable saves, like classic PopCap games: the built game keeps its saves in a
"saves" folder right next to NUMMAT.exe, so copying the game folder (to another
PC, a pen drive...) copies your players and progress too. If that folder is not
writable (for example inside C:\\Program Files) it falls back to %APPDATA%\\NUMMAT.

Robust start-up on any Windows PC:
  1. Files that came from a downloaded zip carry a Windows "downloaded from the
     internet" mark, and .NET refuses to load such DLLs - that is what breaks
     pywebview ("Failed to resolve Python.Runtime.Loader.Initialize"). The
     launcher removes that mark from its own files before starting.
  2. If the native window still can't open, NUMMAT opens in a Microsoft Edge
     (or Chrome) app window instead - no address bar, looks like an app.
  3. Last resort: the default browser.
Any start-up problem is written to saves\\nummat.log.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser

FROZEN = getattr(sys, "frozen", False)
WINDOWS = sys.platform.startswith("win")
BASE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
GAME_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
TITLE = "NUMMAT - Think. Match. Clear."


# ----------------------------------------------------------------- saves --
def _writable(folder: str) -> bool:
    try:
        os.makedirs(folder, exist_ok=True)
        probe = os.path.join(folder, ".write_test")
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def _appdata_dir() -> str:
    if WINDOWS:
        return os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "NUMMAT")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/NUMMAT")
    return os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "NUMMAT")


def choose_save_dir() -> str:
    if os.environ.get("NUMMAT_INSTANCE_DIR"):
        return os.environ["NUMMAT_INSTANCE_DIR"]
    # built game: <game folder>\saves ; developing: <project>\instance (same as `python app.py`)
    preferred = os.path.join(GAME_DIR, "saves" if FROZEN else "instance")
    folder = preferred if _writable(preferred) else _appdata_dir()
    os.makedirs(folder, exist_ok=True)
    # One-time move: bring over progress from the earlier %APPDATA% location if this folder is new.
    old = _appdata_dir()
    if folder != old and not os.path.exists(os.path.join(folder, "nummat.db")) \
            and os.path.exists(os.path.join(old, "nummat.db")):
        for name in ("nummat.db", "secret_key", "last_player.txt"):
            if os.path.exists(os.path.join(old, name)):
                shutil.copy2(os.path.join(old, name), os.path.join(folder, name))
    return folder


SAVE_DIR = choose_save_dir()
os.environ["NUMMAT_INSTANCE_DIR"] = SAVE_DIR
os.environ["NUMMAT_DESKTOP"] = "1"          # local players + remember the last one
LOG = os.path.join(SAVE_DIR, "nummat.log")


def log(msg: str) -> None:
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg.rstrip() + "\n")
    except OSError:
        pass


# ------------------------------------------------ unblock downloaded files --
def unblock_files(folder: str) -> int:
    """Remove the 'downloaded from the internet' mark (Zone.Identifier) from our own files.

    Windows adds it to everything extracted from a downloaded zip; .NET then refuses to
    load the DLLs pywebview needs. Deleting the hidden Zone.Identifier stream is exactly
    what Properties -> Unblock does.
    """
    if not WINDOWS:
        return 0
    count = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            if name.lower().endswith((".dll", ".exe", ".pyd")):
                try:
                    os.remove(os.path.join(root, name) + ":Zone.Identifier")
                    count += 1
                except OSError:
                    pass       # not marked (or no permission) - fine
    return count


if FROZEN:
    n = unblock_files(GAME_DIR)
    if n:
        log(f"unblocked {n} downloaded file(s)")

os.chdir(BASE_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

# Windows: own taskbar identity so the NUMMAT icon shows (not Python's) and pinning works.
if WINDOWS:
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Nummat.Game.Desktop")
    except Exception:
        pass

from app import create_app  # noqa: E402

ICON = os.path.join(BASE_DIR, "assets", "nummat.ico" if WINDOWS else "nummat_1024.png")


# ---------------------------------------------------------------- server --
def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_until_up(url: str, timeout: float = 15.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(url + "/healthz", timeout=1)
            return
        except OSError:
            time.sleep(0.1)


# ---------------------------------------------------------------- window --
def open_native_window(url: str) -> bool:
    """pywebview window (best look). Returns False if it can't start on this PC."""
    try:
        import webview
        webview.create_window(TITLE, url, width=1280, height=860, min_size=(420, 640),
                              background_color="#f4f7fb")
        try:
            webview.start(icon=ICON)
        except TypeError:          # older pywebview without the icon argument
            webview.start()
        return True
    except Exception:
        log("native window failed, trying Edge/Chrome app window:\n" + traceback.format_exc())
        return False


def find_app_browser() -> str | None:
    """Microsoft Edge ships with every Windows 10/11 PC; Chrome as a backup."""
    candidates = []
    if WINDOWS:
        for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                candidates += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                               os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    candidates += [shutil.which(n) for n in ("msedge", "microsoft-edge", "google-chrome", "chrome", "chromium")]
    return next((c for c in candidates if c and os.path.exists(c)), None)


def open_app_window(url: str) -> bool:
    """Edge/Chrome in app mode: its own window, no tabs or address bar. Blocks until closed."""
    exe = find_app_browser()
    if not exe:
        return False
    profile = os.path.join(SAVE_DIR, "window")      # separate profile -> separate process we can wait on
    try:
        proc = subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}", "--no-first-run",
                                 "--no-default-browser-check", "--window-size=1280,860",
                                 "--disable-features=Translate"])
        started = time.time()
        code = proc.wait()
        if code != 0 and time.time() - started < 5:     # crashed straight away - not a normal close
            log(f"app window exited immediately (code {code})")
            return False
        return True
    except OSError:
        log("app window failed:\n" + traceback.format_exc())
        return False


def main() -> None:
    port = free_port()
    url = f"http://127.0.0.1:{port}"
    try:
        flask_app = create_app()
    except Exception:
        log("could not start the game:\n" + traceback.format_exc())
        raise
    threading.Thread(target=lambda: flask_app.run(host="127.0.0.1", port=port, use_reloader=False, debug=False),
                     daemon=True).start()
    wait_until_up(url)

    if open_native_window(url):
        return
    if open_app_window(url):
        return
    # Last resort: the normal browser. Keep the game running until this window is closed.
    log("opening in the default browser")
    webbrowser.open(url)
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
