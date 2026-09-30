# NUMMAT

**Think. Match. Clear.**

NUMMAT is a number-matching puzzle with an **adaptive procedural puzzle-generation system**. It watches how you play, estimates your skill, and generates each new board to fit you. Every board comes from a seeded pipeline that validates it, solves it and scores its difficulty before you see it.

Match two tiles when they're **equal** (5 ↔ 5) or **sum to 10** (3 + 7). The tiles also need a clear line between them: same row, same column, a diagonal, or a **row wrap** (the end of one row joins the start of the next).

---

## Architecture

```
                ┌───────────────┐
                │ Player Input  │   tap-tap or drag-to-match (touch friendly)
                └───────┬───────┘
                        ↓
                ┌───────────────┐
                │ Game Engine   │   engine/session.py  - modes, scoring, streaks, chains, items
                └───────┬───────┘
                        ↓
              ┌─────────┴─────────┐
              ↓                   ↓
       Match Detection       Difficulty AI          engine/rules.py · engine/difficulty.py
              ↓                   ↓                  (+ optional engine/predictor.py)
          Solver  ←────── Level Generator           engine/solver.py · engine/generator.py
              ↓
        Progress System                             services.py - stats, coins, XP, achievements
              ↓
           Database                                 models.py - SQLite via SQLAlchemy
```

```
Frontend (templates/index.html, static/js, static/css)
   ↓  JSON over fetch
Flask REST API (api.py)
   ↓
Service layer (services.py)  ──  Game engine (engine/, pure Python, no Flask)
   ↓
SQLite + SQLAlchemy (models.py)
```

The engine has no Flask imports. Each game's state is a JSON document stored on its row in the `games` table, so any number of players can play at once and nothing lives in a global variable.

## Features

### Game modes
| Mode | Rules |
|---|---|
| 🎯 **Classic** | The original game, plus 6 themed level packs (106 levels). |
| 🔗 **Chain** | Play a pair that your last match opened up to grow the chain. Each link multiplies your score. |
| ⏱️ **Time Attack** | 02:00 on the clock. A cleared board is replaced right away. |
| 📅 **Daily Challenge** | One board per day for everyone, seeded by the date. 20 moves (every attempt counts), no hints or items, global scoreboard. |
| 🧘 **Zen** | No timer, no score, unlimited undo and hints. |
| 💀 **Expert** | Blocked cells, frozen tiles and wildcards, with 1 undo and 1 hint. A deadlock ends the run. |

### Adaptive Difficulty Engine (`engine/difficulty.py`)
After every game NUMMAT scores six things: accuracy, speed (seconds per pair), hint and undo usage, streak quality, deadlocks and completion. It weights that result by how hard the board was, then blends it into your running skill (0-10) with an exponential moving average. The skill sets the next board's grid size, pair count, complexity tier, par time, hint allowance and special tiles:

```
Current skill → 7.4 / 10
Next level:  Grid 7 × 7 · Pairs 20 · Complexity HIGH · Time 75 sec · Hints 1
```

Level packs use the same engine. A pack's difficulty curve moves up or down by one tier to match your skill.

### Level Generation Pipeline (`engine/generator.py`)
```
Generate candidate board   → reverse construction (see below)
Validate constraints       → even tiles, values can be perfectly paired, an opening move exists
Solve board                → engine/solver.py
Calculate difficulty       → tiles, valid pairs, first moves, min moves, branching factor,
                             deadlock probability (random playouts), average solution depth, solver effort
Reject / accept            → keep the candidate closest to the target tier
Deliver level
```
**Reverse construction:** the generator starts with an empty grid and repeatedly places a matching pair on two cells that are connected at that moment. Playing those pairs back in reverse order always clears the board, so every candidate is solvable by construction. Boards with frozen tiles are re-checked by the solver. Everything runs from `random.Random(seed)`, so a seed always gives the same board.

### Puzzle Solver (`engine/solver.py`)
The solver is a depth-first search with three speed-ups:
- It tries first the moves that leave the most options open.
- It remembers every position already proven to be a dead end, so it never searches one twice.
- It prunes a position when its numbers can no longer all be paired, whatever the layout.

It reports **solvable / unsolvable / unknown** with a reason (for example, "Odd number of tiles (15)"), the full-clear path, and the longest partial line it found. In the game, **🧠 Solve** answers "Can this board be solved?", and **Show solution** plays the solution back move by move. The **Solver Lab** does the same for any board you type in.

### AI hints and "Explain This Move"
- **Hint level 1** shows a possible pair.
- **Hint level 2** explains why it works and how many new matches it opens (free for the pair you were just shown).
- **Hint level 3** is the optimal move, checked by the solver.
- After every match, the side panel shows the rule (3 + 7 = 10 ✓), the connection (row / column / diagonal / wrap), how the number of options on the board changed, pairs opened, streak before → after, and points.

### Progression
- **Accounts:** register, log in and log out (hashed passwords). You can play as a guest first. Registering upgrades the guest account, so your progress carries over.
- **Analytics dashboard:** a profile table, plus charts for score, solve time, accuracy, skill progression, streak history and hint usage. Also shows results per mode and boards cleared by difficulty.
- **Achievements:** 23 in 5 categories: Skill, Speed, Strategy, Exploration and Extreme.
- **Leaderboards:** daily, weekly and all-time, plus the Daily Challenge board.
- **Store:** Shuffle 100 · Smart Hint 150 · Time Freeze 200 · Streak Shield 250 · Double Coins 300. Coins only come from playing, and items are disabled in the Daily Challenge.

### Design system and themes
- Alice for the logo and headings, Poppins for the UI.
- Every colour is a token in `static/css/nummat.css`: primary, secondary, accent, success, danger, background, surface and tile tokens. Light and dark mode are included.
- Themes change more than the background:
  - ❄️ **Winter:** snow, ice-style tiles, and frozen tiles in its pack.
  - 🍂 **Autumn:** falling leaves, warm UI, leaf-covered wall cells.
  - 🌸 **Spring:** drifting petals, blossom wildcards.
  - ☀️ **Summer:** rising sun sparkles, bright UI, bigger boards against a par time.

### Mobile
- Tiles resize to fit the viewport: large on desktop, medium on tablets, compact on phones.
- Touch feedback includes haptics on supported devices.
- You can drag from one tile to another to match.
- On phones there's a bottom navigation bar, and dialogs open as bottom sheets you can swipe down to close.
- Safe-area insets are respected, and reduced-motion settings are honoured.

---

## Getting started

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                                          # http://127.0.0.1:5000
```

The SQLite database is created automatically at `instance/nummat.db`.

**Importing v1 saves.** Old JSON saves from `saves/*.json` can be imported:
```bash
python scripts/import_json_saves.py
```
Each save becomes an account without a password. Registering with that username claims it and keeps the progress. The old `guest.json` becomes `legacy_guest`.

**Tests**
```bash
pytest -q
```
```
tests/
├── test_generator.py    generated boards are solvable, seeds reproduce, metrics & tiers
├── test_solver.py       solvable / unsolvable proofs, frozen tiles, best move
├── test_matching.py     equal & sum-to-10 rules, connections, walls, wrap, duplicates prevented
├── test_progression.py  modes, streak shield, undo, move limits, timers, hints, adaptive skill, achievements
└── test_api.py          accounts, progress saves, locked levels, daily seed, leaderboards, shop, isolation
```

### Configuration (environment variables)
| Variable | Default |
|---|---|
| `NUMMAT_DATABASE_URL` | `sqlite:///instance/nummat.db` |
| `NUMMAT_SECRET_KEY` | generated once into `instance/secret_key` |
| `FLASK_DEBUG` / `HOST` / `PORT` | `1` / `127.0.0.1` / `5000` |

## Android app (phones & tablets)

NUMMAT also runs as an **offline Android app** with the same game and screens. The Python engine has a JavaScript port (`mobile/src/engine.js`), and the Flask API is re-implemented on the device (`mobile/src/localapi.js`), so no server is needed. The APK is built by **GitHub Actions** on every push: open the **Actions** tab, then *Build Android APK*, then download the **NUMMAT-android** artifact. See [`mobile/README.md`](mobile/README.md) for installing on a phone, building with Android Studio, and publishing to the Play Store.

## Players, login and the new-player tour

- **Who's playing?** On first launch the desktop app asks you to **create a player** (a PIN is optional) or **play as Guest**. There is one reusable Guest profile, so no more "Guest 17, Guest 18...".
- **Stays logged in.** The desktop app remembers the last player (`saves/last_player.txt`) and logs them straight in next time. To change, click the avatar (top right) → **Switch player**. From the same menu you can add or change a PIN, or turn the Guest profile into a named player (progress is kept).
- **How to play tour.** New players get a short guided tour: the three rules (equal numbers, sum to 10, a clear line: row / column / diagonal / row wrap), a tiny practice board, the six modes, the help tools and the rewards. It can be skipped and replayed from the avatar menu.
- Web mode (`python app.py` on a server) never lists players or auto-logs anyone in. Those features switch on only in the desktop app (`NUMMAT_DESKTOP=1`, set by `desktop.py`).

## Desktop app (Windows / macOS)

**Like a PopCap game:** double-click `build.bat` once. You get a **`NUMMAT Game`** folder with `NUMMAT.exe`, its `_internal` files, `How to Play.txt` and (after the first launch) a `saves` folder. Copy that whole folder anywhere (desktop, pen drive, another PC) and double-click `NUMMAT.exe`. No Python or install is needed on that PC. Saves travel with the folder, and fonts are bundled, so it looks the same offline. Rebuilding never deletes `saves`.


NUMMAT ships with its own app icon - a glossy tile grid where the gold **3** and **7** make a matched pair (3 + 7 = 10).

| File | Used for |
|---|---|
| `assets/nummat.ico` | Windows exe, taskbar, desktop shortcut, installer (16-256 px) |
| `assets/nummat.icns` | macOS app |
| `static/favicon.png`, `static/icon-192.png`, `static/icon-512.png` | in-game header, browser tab, "install app" |

All of them are generated by `python scripts/make_icon.py` - edit that script to change the design.

**Windows, one click:** double-click `build.bat`. It installs the tools, regenerates the icon, builds
`dist\NUMMAT\NUMMAT.exe` with the icon, and puts a **NUMMAT** shortcut on your desktop.

**Proper installer (Start menu + desktop icon + uninstaller):** after `build.bat`, install the free
[Inno Setup](https://jrsoftware.org/isinfo.php), open `installer.iss` and press *Compile*.
You get `Output\NUMMAT-Setup.exe`, which you can share like any other game installer.

**macOS:**
```bash
python -m PyInstaller desktop.py --name NUMMAT --windowed --noconfirm --icon assets/nummat.icns \
  --add-data "templates:templates" --add-data "static:static" --add-data "engine:engine" --add-data "assets:assets" \
  --hidden-import api --hidden-import services --hidden-import models
```

**Sharing:** delete `NUMMAT Game\saves` (it holds your players), zip the folder and share a Drive/OneDrive link. The launcher removes Windows' "downloaded from the internet" block from its own files automatically (that block otherwise stops pywebview with *"Failed to resolve Python.Runtime.Loader.Initialize"*). If the native window still can't open, it falls back to a Microsoft Edge app window, then to the default browser. Problems are logged to `saves\nummat.log`.

Saves live in `%APPDATA%\NUMMAT` (Windows) or `~/Library/Application Support/NUMMAT` (macOS), so reinstalling keeps progress.

**Icon not updating?** Windows caches icons. Delete the old shortcut and run `ie4uinit.exe -show`
(or sign out and back in) - the new icon appears.

## Database schema
`users` · `player_stats` · `games` · `moves` · `levels` · `achievements` · `user_achievements` · `daily_challenges`

Every attempted move is stored with its coordinates, values, validity, connection type and timestamp. That data feeds the analytics dashboard and is what the ML model below trains on.

## API
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | accounts |
| GET | `/api/me` · `/api/skill` · `/api/stats` · `/api/achievements` | profile, adaptive report, analytics |
| GET | `/api/modes` · `/api/packs` · `/api/packs/<id>/levels` · `/api/daily` | catalogue |
| POST | `/api/games` | start `{mode, pack?, level?}` |
| GET | `/api/games/<id>` | state (finishes timed-out games) |
| POST | `/api/games/<id>/move` · `/undo` · `/hint` · `/solve` · `/item` · `/end` | play |
| POST | `/api/solver` | analyse any board `{board: "text"}` |
| GET | `/api/leaderboard?period=daily\|weekly\|all` | rankings |
| GET/POST | `/api/shop` · `/api/shop/buy` | store |

## Next step: learned difficulty (`engine/predictor.py`)
This is a small ridge-regression model written in pure Python. It predicts a player's next-game performance from `avg_solve_time`, `mistakes`, `hints_used`, `undo_count`, `streak` and `level_completion_rate`.

Once enough games are recorded, train it:
```bash
python scripts/train_model.py
```
After that, the adaptive engine uses 70% of its own heuristic estimate and 30% of the model's prediction. Until then, the heuristic engine runs on its own.

## Project layout
```
app.py            Flask app factory
api.py            REST endpoints
services.py       game lifecycle, stats, coins, achievements, leaderboards
models.py         SQLAlchemy models
engine/           rules · solver · generator · difficulty · predictor · hints · modes · achievements · session
templates/        index.html (single-page UI)
static/css/       nummat.css (design system + themes)
static/js/        app.js · effects.js (seasonal particles) · charts.js (SVG charts)
static/img/       web-optimised theme backgrounds (resized from the original 1-31 MB images)
scripts/          import_json_saves.py · train_model.py
tests/            pytest suite
```
