# LearnGuage — offline Italian vocabulary trainer (PWA)

Live: **https://danz-best.github.io/learnguage/**

A fully client-side Progressive Web App. All logic runs in the browser; progress
is saved in `localStorage`. Works offline once added to the home screen.

This is a client-side port of the original Flask app (`../app.py`). See
`../APP_LOGIC_SPEC.md` for the full behavior spec — this PWA mirrors it exactly.

## Install on iPhone
1. Open the live URL in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Launch from the home screen. It now works with WiFi/data off.

## Structure
- `index.html` / `js/home.js` — set menu + progress + backup (export/import)
- `session.html` / `js/app.js` — the learning session UI
- `js/engine.js` — ported backend logic (word selection, answer checking, storage)
- `data/words/italian_set_*.json` — the 2,500 words (5 sets of 500)
- `data/seed_progress.json` — initial progress seed (first launch only)
- `manifest.json`, `service-worker.js`, `js/register-sw.js`, `icons/` — PWA plumbing

## Updating the app
1. Edit files here.
2. **Bump the cache version** in `service-worker.js` (e.g. `learnguage-v1` → `v2`).
   This is required — the service worker is cache-first, so installed phones only
   pick up changes when the cache name changes.
3. `git add -A && git commit -m "…" && git push`
4. GitHub Pages redeploys in ~1 minute. Installed phones update on next launch
   (may take one extra launch for the new service worker to activate).

## Progress backup
The home screen has **Export / Import** buttons. Export saves a JSON file of all
progress; Import restores it. Use this to move progress between devices or guard
against iOS clearing site storage.
