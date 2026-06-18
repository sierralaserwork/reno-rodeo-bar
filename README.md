# Bar Count + Fill the Boot

Offline, phone-first web app for running the Reno Rodeo bar: count drinks + people served,
track liquor inventory/orders, tally tips for the Special Kids Rodeo, see analytics + fun stats,
and follow "Fill the Boot" progress. Runs fully offline after first load; data stays on each phone.

Built as a static Progressive Web App — no build step, no backend, no runtime network calls.
See `CLAUDE.md` (build guide) and `SPEC.md` (full spec). `reference/wireframe.html` shows the
intended screens.

## What it does
- **Bartender phone** — start/move/end shift (station + mixer, timestamped), sticky People-Served
  +/- counter, add-only 9-drink grid with a +1/+2/+3 combo badge, fat-finger-safe Undo, kiosk lock.
- **Door phone** — one big +/- line counter.
- **Show QR** — each phone shows a compact QR of its night for handoff (no internet, no typing).
- **Manager** — photo-scan each QR and merge by station; inventory, orders + review (photo),
  receiving; PIN-verified tips; analytics (funnel, busy/slow, mixer speed, shrinkage, revenue);
  fun stats; rate-based leaderboard + awards; Fill-the-Boot tracker; year-over-year.
- **Exports & sharing** — one-tap **Excel export** (multi-sheet `.xlsx`, regenerated each tap),
  past-years spreadsheet **import**, **Email** + **SMS** + **Copy** team recap, and a full
  JSON **Backup/Restore**.

All three libraries are **vendored locally** in `lib/` (no CDN): `qrcode.js` (QR encoder),
`jsqr.js` (QR decoder), `xlsx.min.js` (SheetJS, Excel in/out).

## Run locally
Open a terminal in this folder (the one with `index.html`) and serve it:

```
python -m http.server 8000
# then visit http://localhost:8000
```

Service workers + Add to Home Screen need https (or localhost), so use a server, not `file://`,
when testing install/offline.

> Tip while developing: the service worker caches aggressively (that's the offline feature). After
> editing a file, bump `CACHE` in `service-worker.js`, or in DevTools → Application → Service
> Workers click **Unregister** + **Clear storage**, then hard-reload.

## Deploy to GitHub Pages (the hosted link people visit)
GitHub Pages "Deploy from a branch" serves the **repo root** (or `/docs`). The deployable files are
the ones next to `index.html` (this folder), so make this folder the repo root:

1. In **this** folder (the one containing `index.html`), run:
   ```
   git init && git add . && git commit -m "Bar Count app"
   git branch -M main
   git remote add origin https://github.com/<your-user>/<repo>.git
   git push -u origin main
   ```
2. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder:
   `/ (root)`. Save.
3. Wait ~1 minute; your link is `https://<your-user>.github.io/<repo>/`.
4. On each phone, open that link once (with signal), then **Add to Home Screen**. After that it
   runs fully offline.

All asset paths are **relative**, so the app works under the `/<repo>/` subpath.

Alternatives: Netlify or Cloudflare Pages (drag-and-drop this folder, get an https link).
**Do not** use Google Apps Script — its sandboxed iframe breaks the service worker, Add to Home
Screen, and camera/QR scanning. This app needs no backend.

## Project layout
```
index.html              app shell (loads libs + registers the service worker)
styles.css              design tokens + all component styles
app.js                  the whole SPA: storage, router, every screen, exports
manifest.webmanifest    PWA manifest (installable)
service-worker.js       offline cache (precaches app + libs)
lib/qrcode.js           vendored QR encoder (qrcode-generator)
lib/jsqr.js             vendored QR decoder (jsQR)
lib/xlsx.min.js         vendored SheetJS (Excel export/import)
icons/                  icon-192.png, icon-512.png
reference/wireframe.html  visual reference for all 18 screens
CLAUDE.md               build notes
SPEC.md                 full functional spec (§7 = exports & sharing)
```

## Still to provide (enter in Settings)
- Drink/liquor catalog + prices, number of stations, pour & bottle sizes, admin PIN.
- Team phone numbers (SMS recap) and team emails (Email recap).
- The external boot graphic file (the app only tracks the numbers).
- Past-years tip totals spreadsheet (sets the goal + year-over-year) — import on the YoY screen.
