# CLAUDE.md — Bar Count + Fill the Boot

Read this first, then build to `SPEC.md`. `reference/wireframe.html` shows the
intended screens and visual style — open it in a browser to see the target.

## What we're building
A phone-first web app for running the bar at the Reno Rodeo (10 nights). It does two jobs:
1. **Count** drinks + people served per bartender, and people into the line at the door.
2. **Track** liquor inventory/orders, tip totals (a friendly contest; all money goes to the
   Special Kids Rodeo), analytics, fun stats, and "Fill the Boot" fundraising progress.

## Hard constraints (do not violate)
- **Offline-first.** The venue has little/no internet. After first load the app MUST run
  with zero network. No external runtime requests — no CDNs, no Google Fonts, no API calls.
  Everything (including the QR libraries) is vendored locally.
- **Phone-first.** Design for a ~380px portrait screen. Big tap targets. The count screen
  must not require scrolling past half a page; the "People Served" header stays pinned.
- **One person per phone.** Each phone is a single person (Bartender / Door / Manager).
  No phone switching. Handoffs are reconciled by the Manager (see SPEC "Merge by station").
- **Data lives on-device** (localStorage for state, IndexedDB for photos) PLUS an explicit
  Export/Import backup file so a count can never be lost. Wrap all storage in try/catch with
  an in-memory fallback so it never crashes (e.g. when opened in a sandbox/preview).
- **Static site, relative paths.** Must deploy as static files to GitHub Pages. No server,
  no build step required to run. If you add a bundler, output static files to `/docs` and
  keep all asset paths relative (so it works under `/repo-name/`).

## Tech
- Vanilla HTML/CSS/JS. No framework needed; a tiny hash router is enough. Keep it dependency-free.
- Single-page app, hash routes per screen. State in a single store module persisted to localStorage.
- Vendor these into `/lib` (no CDN): a QR **encoder** (`qrcode-generator` → `lib/qrcode.js`) for
  the Show-QR screens, `jsQR` (→ `lib/jsqr.js`) for the Manager's photo-based QR **decoder**, and
  the **SheetJS** community build (`xlsx` → `lib/xlsx.min.js`) for Excel export/import. All three
  are loaded as classic `<script>`s before `app.js` and listed in the service-worker PRECACHE.
- Design tokens are in `styles.css` (warm ink + saddle-tan accent, mono for labels). Match the
  wireframe's feel; spend visual boldness only where it helps (the count screen, the boot/recap).

## QR handoff (critical)
- Each Bartender/Door phone shows a QR encoding that person's night (see SPEC "QR payload").
- The Manager imports by **taking a photo** of the QR via `<input type="file" accept="image/*"
  capture="environment">`, then decoding the still image with jsQR. Do this rather than live
  `getUserMedia` so it also works from a plain file. If served over HTTPS (Pages), you MAY add
  optional live-camera scanning as an enhancement, but photo-decode is the required baseline.
- Keep the payload small: people-served times are bucketed to 15-minute blocks, not per-tap.

## Build order (the user chose "all in one go" — build the whole thing, but in this order)
1. App shell + role picker + storage layer + hash router.
2. Bartender count screen (sticky People Served +/- with timestamps; add-only 9-drink grid with
   +1/+2/+3 corner combo badge; safe Undo-last in the top bar w/ confirm; kiosk lock w/ PIN;
   Start/End/Move shift with timestamps). Door counter screen. Show-QR screen.
3. Manager: Import (photo-scan QR) + merge-by-station; night totals.
4. Inventory (typed Opening/Closing bottles, liquor only — no beer); Orders (catalog + prices +
   recommended qty); Order review (projected tomorrow, total $, attach photo); Receiving (verify
   vs ordered, show yesterday's photo, flag shortfalls).
5. Tips (typed bucket total ÷ people served, PIN-verified); Analytics (funnel, 15-min busy/slow,
   per-bartender tips, mixer speed, line capacity, liquor shrinkage, revenue); Fun Stats;
   rate-based Leaderboard + awards (qualifier + Overall Champion).
6. Fill the Boot tracker (numbers only — no boot graphic; that's an external file); Team Recap
   text (compose + `sms:` open in Messages + Copy fallback); Backup export/import; past-years
   spreadsheet import to set the goal.
7. Exports & sharing (see SPEC §7): **Excel export** — a manager button that rebuilds a complete
   `.xlsx` (Summary, Drinks, Tips, Inventory, Boot, People sheets) with SheetJS on every tap and
   downloads it as `bar-count-<event>-<YYYY-MM-DD>.xlsx`; on desktop Chrome/Edge, optional
   "save back to the same file" via the File System Access API. **Email by button** — in the recap
   area, an `mailto:` Email button to the saved team email list with subject+body prefilled, using
   the Web Share API to attach the `.xlsx` where supported (else download for manual attach); note
   in the UI that sending needs internet. Keep the existing SMS recap; add Email + Copy alongside.

## Test before the rodeo (real devices, iOS + Android)
- Loads and fully works with airplane mode on (after first online load).
- Add to Home Screen launches standalone; icon present.
- State survives fully closing the app; Backup export + Import round-trips.
- Manager can photo-scan a QR shown on another phone and merge it correctly.
- Count screen never needs more than a half-page scroll; header stays pinned.

## Deploy
Push the repo to GitHub → Settings → Pages → deploy from `main` (root or `/docs`). Share the
`https://<user>.github.io/<repo>/` link. See `README.md`. (Do NOT use Google Apps Script — its
sandboxed iframe breaks service workers, Add-to-Home-Screen, and camera.)
