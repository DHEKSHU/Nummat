# NUMMAT for Android (phones & tablets)

The Android app is the **same game** as the desktop version: same screens, modes, packs, tour, players, PIN, achievements and store. It runs **completely offline**: the game engine is a JavaScript port of the Python engine, and saves stay on the phone.

```
templates/ + static/        the game UI (shared with desktop)
mobile/src/engine.js        JavaScript port of engine/ (rules, solver, generator, adaptive difficulty, hints…)
mobile/src/localapi.js      the Flask API re-implemented on the phone (players, saves, stats, store)
scripts/build_mobile.py     puts UI + engine together into mobile/www
mobile/android/             the Android app project (Capacitor)
mobile/tests/               tests for the JavaScript engine (node --test mobile/tests/*.test.js)
.github/workflows/android.yml   builds the APK on GitHub
```

## Get the APK: easiest way (GitHub builds it for you)

1. Push the project to GitHub (see the main README).
2. On your repo page, open the **Actions** tab. The **Build Android APK** workflow starts by itself after each push. You can also start it yourself: click *Build Android APK* → **Run workflow**.
3. Wait about 5-8 minutes for the green ✓, then open the run and download **NUMMAT-android** under *Artifacts*. It's a zip; `NUMMAT.apk` is inside.
4. To publish a version: create a tag such as `v2.1` (Releases → *Draft a new release* → new tag `v2.1` → Publish). The workflow attaches `NUMMAT.apk` to that release, so anyone can download it from your repo page.

## Install it on a phone or tablet

1. Copy `NUMMAT.apk` to the phone, or open the Release link on the phone.
2. Tap it. Android asks to allow installing from this source (Chrome, Files, WhatsApp…). Tap **Settings → Allow**, then **Install**.
3. If Play Protect says "unknown developer", tap **More details → Install anyway**. That's normal for apps that aren't from the Play Store.

Newer APKs from the same workflow install over older ones and keep your progress, because they share the signing key in `android/app/debug.keystore`.

Requires Android 7.0 or newer. Works in portrait and landscape.

## Build it on your own PC instead (Android Studio)

1. Install [Android Studio](https://developer.android.com/studio) and [Node.js 22](https://nodejs.org).
2. In the project folder:
   ```bat
   python scripts\build_mobile.py
   cd mobile
   npm install
   npx cap sync android
   npx cap open android
   ```
3. In Android Studio: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. Or press ▶ with your phone plugged in (USB debugging on) to install and run it directly.

After changing the game, run `python scripts\build_mobile.py` and `npx cap sync android` again.

## Changing the icon or splash screen
`python scripts/make_icon.py` (desktop icon) and `python scripts/make_android_icons.py` (Android launcher icons + splash).

## Differences from the desktop version
- **Leaderboards and the Daily scoreboard** list the players on *this device*, since there's no server. The daily puzzle is the same on every phone that runs the same version, because it's generated from the date.
- The board generator uses a JavaScript random-number generator, so a given seed gives a different (but equally valid) board than on desktop.
- The Android **Back** button closes dialogs, steps back through the tour, leaves a game, then returns to the home screen.

## Play Store (optional, later)
The Play Store needs your own private signing key, and an `.aab` instead of an `.apk`:
1. Create a key: `keytool -genkeypair -v -keystore nummat-release.jks -alias nummat -keyalg RSA -keysize 2048 -validity 10000`. **Keep this file and its passwords safe forever.**
2. Build with `NUMMAT_KEYSTORE`, `NUMMAT_KEYSTORE_PASSWORD`, `NUMMAT_KEY_ALIAS` and `NUMMAT_KEY_PASSWORD` set (for example as GitHub secrets passed into the workflow), then run `./gradlew bundleRelease`.
3. Upload the `.aab` in the Google Play Console (one-time US$25 developer fee).
