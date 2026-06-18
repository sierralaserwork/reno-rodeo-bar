# SPEC.md — Bar Count + Fill the Boot

Functional spec (v2.2). Pair with `reference/wireframe.html` for the visual layout of every
screen (numbered 00–18). All money raised goes to the **Special Kids Rodeo**; the tip "contest"
is for bragging rights, not payout.

## 1. Roles (one per phone)
- **Bartender** — counts their own shift: people served + drinks. Records their mixer's name.
- **Door** — one big +/- counter for people entering the line.
- **Manager** — full app: import everyone's QRs, inventory, orders, receiving, tips, analytics,
  fun stats, leaderboard, boot tracker, recap, backup, settings.

Mixers do **not** run the app; the bartender types the mixer's name for each shift. (A mixer's
"speed" is derived from the station's drinks during the segment that mixer was paired.)

## 2. Data model
- **Event**: name (e.g. "Reno Rodeo '26"), number of nights (default 10).
- **Day/Night**: date + day number; contains shifts, door counts, inventory, order, tips, boot entry.
- **Person**: name + role (set once per phone, remembered).
- **Shift (segment)**: `{ person, role, stationNumber, mixerName, startTime, endTime }`.
  A person can have multiple shifts (if they move stations). Created on Start/Move, closed on
  Move/End.
- **Counts (per shift)**:
  - `peopleServed`: integer, adjustable +1/-1, **each +1 timestamped** (bucketed to 15-min for
    storage/QR). Used for the funnel, line capacity, busy/slow curve, and the tip denominator.
  - `drinks`: tally per drink in the fixed 9-drink grid (add-only). Track the longest rapid-tap
    streak for the "Longest streak" fun stat.
- **Door count**: integer +/- with timestamps (15-min buckets).
- **Inventory item (liquor only)**: `{ name, openingBottles, closingBottles }`; `used = opening -
  closing`. Beer is excluded entirely (kegs, auto-restocked, never ordered) — beer still appears
  on the drink grid, just not in inventory/orders.
- **Order item (catalog)**: `{ name, unitPrice, recommendedQty, orderedQty }`; recommended =
  last night's `used` × attendance trend multiplier (placeholder until past-years data arrives).
  Order also stores `previousOnHand`, `projectedTomorrow = closing + ordered`, `total$`, and a
  `photo` (the paper order sheet).
- **Receiving (next morning)**: per item `receivedQty`; flag if `received < ordered`. Show the
  prior night's order-sheet photo.
- **Tips (per station)**: `{ stationNumber, bucketTotal$ (typed), peopleServed (from merge),
    scorePerPerson = bucketTotal / peopleServed, verified (bool), verifiedBy }`. One bucket per
  station; verifying requires the admin PIN.
- **Boot**: `goal$` (last year's total / target to beat), `days`, `cause` (default "Special Kids
  Rodeo"), and per-day `amount$` (auto-suggested from that night's tip totals, editable). Tracks
  cumulative raised, % of goal, and pace to beat last year. **No boot graphic in the app** — the
  visual lives in an external file the user provides; the app just exposes the numbers + an export.
- **Settings**: numberOfStations, drink grid (default 9 below), order catalog + prices,
  pour size + bottle size per liquor (for shrinkage), goal/past-year totals import, admin PIN,
  team text list (phone numbers for the recap).

### The 9 drinks (default grid, editable in Settings)
Jack & Coke · Jack & Diet Coke · Specialty Drink · Margaritas · Wine · Coors Regular ·
Coors Light · Blue Moon · Cocktail

## 3. QR handoff & merge
- At close, each Bartender/Door phone shows a QR encoding a compact JSON of that person's night:
  role, name, each shift `{ station, mixer, start, end, drinks{}, servedByBucket[15-min] }`, and
  (door) the door buckets. Keep it small — bucket times to 15 minutes; no per-tap timestamps in
  the payload.
- The Manager scans by **photographing** the QR (file input w/ camera capture) and decoding with
  jsQR, then merges.
- **Merge by station + time**: a station's night = the sum of all bartender shifts tagged to that
  station, even across different phones/people. Example: Jane works Station 1 (7:00–7:55), then Mae
  takes over Station 1 (7:55–9:00) on her own phone — both merge into Station 1's totals. Mixer
  windows align by station+time to compute mixer speed.

## 4. Screens (see wireframe for layout)
- **00 Role picker** — type your name, pick Bartender / Door / Manager. Remembered.
- **01 Start shift** (bartender) — pick station, type mixer name, Start (stamps check-in, clock starts).
- **02 Count (hero)** — pinned People Served counter (+1 big / −1), timestamped. Add-only 3×3 grid
  of the 9 drinks with a +1/+2/+3 corner combo badge on rapid taps (visual only, no vibration).
  Top bar: Undo-last (tap shows "Undo: <drink>", second tap confirms), kiosk lock 🔒. Bottom:
  End/Move station, your shift total, Show QR. No scroll beyond half a page; only the grid moves.
- **03 End / move** — End my shift → Show QR, or Move to another station (closes this shift,
  opens a new one on the same phone). Stamps check-out.
- **04 Show QR** — renders the person's QR + a short text "backup code" fallback.
- **05 Door** — one large +/- counter, timestamped; Show QR at close.
- **06 Import** (manager) — list of people/stations received; "Snap a QR" (photo) to add each;
  merges by station.
- **07 Inventory** — per liquor: type Opening & Closing (bottles); Used auto. Liquor only.
- **08 Orders** — liquor catalog with prices + recommended qty; enter order qty → Review.
- **09 Order review** — on-hand now, ordering, have tomorrow, order total $; attach photo of sheet.
- **10 Receiving** — verify received vs ordered, show yesterday's photo, flag shortfalls ⚠.
- **11 Tips** — per station: type the bucket total $, ÷ people served = score/person; Verify (PIN).
- **12 Analytics** — funnel (Line → Ordered → Drinks), drinks/person, 15-min busy/slow curve
  (15- or 30-min toggle), top bartender by tips, fastest mixer (drinks/min), line capacity
  (high/low), liquor shrinkage, revenue estimate.
- **13 Fill the Boot (tracker)** — per-day + cumulative vs goal/last year, % filled, pace.
  Numbers only; auto-suggested from the night's tips, editable.
- **14 Year-over-year + export** — import past-years spreadsheet to set the goal; export nightly
  totals for the external boot file.
- **15 History + Backup** — every night saved; Export (backup file) / Import (restore).
- **16 Settings** — number of stations, drink grid, order catalog + prices, pour & bottle sizes,
  goal/past-year import, team text list, admin PIN.
- **17 Fun Stats** — Drink of the Night, Power Hour (busiest 15-min bar-wide), Beer vs Cocktail
  split, Longest streak, Fastest fundraising ($/min peak), Best Night Yet, Beat-last-year pace.
- **18 Team Recap** — choose which stats to include; it composes a text; "Open in Messages"
  (`sms:` with prefilled body to the saved team list) + "Copy text" fallback. Nothing auto-sends.

## 5. Leaderboard & awards (equity matters)
Rank by **rates, not totals**, so someone who works 1 night competes fairly with a 10-night regular:
- Marquee metric: **tips per person served**. Toggle to people/hr, drinks/min, total raised.
- **Qualifier**: must have served ~25+ people (one real shift) to place on rate boards — stops a
  tiny-sample fluke from topping the list, but any genuine shift qualifies.
- **Overall Rodeo Champion**: blended percentile across the rate metrics (optional, transparent).
- Awards: Top Tip Magnet, People's Champ, Fastest Hands (mixer), Best Night, Rush Hour Hero,
  The Closer, Best Bar (station), Best Duo (bartender+mixer), Workhorse (most shifts/hours —
  rewards regulars, kept separate from rate boards), Rookie of the Rodeo (best among 1–2 nighters).

## 6. Offline / storage / behavior notes
- localStorage for state; IndexedDB for photos (compress before storing). Always try/catch with an
  in-memory fallback so a sandbox/preview never throws.
- Backup = a single JSON export of the whole event (and optionally photos); Import restores it.
- Recap uses `sms:?&body=...` (and recipients from the team list where the OS allows); Copy as the
  cross-platform fallback. SMS works on weak signal even when data is down.
- All times are device-local; only 15-min buckets travel in QRs.

## 7. Exports & sharing (v2.3)
Two manager features layered on top of the screens above. Both reuse the vendored, offline
SheetJS build (`lib/xlsx.min.js`); they never call the network.

### 7a. Excel export — refreshed on a tap
A manager **Excel Export** screen (reachable from the manager hub) builds a complete `.xlsx`
from the *current* state with SheetJS and downloads it. It is **regenerated on every tap**, so the
file is always current. Sheets:
- **Summary** — per night: line count, served, total drinks, tips $, conversion %, drinks/person.
- **Drinks** — night × station × the 9 drinks (+ row total).
- **Tips** — night × station: bucket $, served, $/person, verified, verified-by.
- **Inventory** — night × liquor: opening, closing, used, ordered, received.
- **Boot** — per day: amount, cumulative, goal, % of goal, vs last year.
- **People** — per person: nights worked, served, tips $, tips/person, drinks/min, people/hr,
  shifts, hours, longest streak (the awards material).

Filename: `bar-count-<event>-<YYYY-MM-DD>.xlsx`. On desktop Chrome/Edge it also offers an optional
**"Save to a file"** + **"Save back to same file"** using the File System Access API
(`showSaveFilePicker`) so repeat exports overwrite the same file in place.

SheetJS is also used to **import** the past-years spreadsheet on the Year-over-year screen
(`.xlsx`/`.csv` with `Year`,`Total` columns) to set the goal.

### 7b. Email by button (Team Recap)
The Team Recap screen (18) keeps **SMS** and **Copy** and adds **Email**:
- **Email recap** opens the device mail app via `mailto:` to the saved **team email list** with the
  subject + the night's recap body prefilled.
- To attach the Excel, it uses the **Web Share API** (`navigator.share` with `files`) where
  supported, so the `.xlsx` can be sent to Mail/Gmail. Where unsupported, it downloads the `.xlsx`
  (for manual attaching) and opens the prefilled mail draft.
- The UI notes that **sending email needs internet** — composing works offline; the mail app sends
  when reconnected. Nothing auto-sends.

### 7c. Data-model additions
- **Settings** gains `teamEmails` (recap email recipients) alongside the team phone list, plus
  `drinkPrices` (revenue estimate), `beer` (which grid drinks are beer), `pourMap`
  (drink → liquor oz, for shrinkage), and `nights`.

## 8. Reliability & game-day enhancements (v2.4)
- **Drink grid order**: row 1 Jack & Coke · Jack & Diet Coke · Cocktail; row 2 Margaritas ·
  Specialty Drink · Wine; row 3 Coors Light · Coors Regular · Blue Moon. Default stations = **5**.
- **Auto-snapshots + self-heal**: every save also writes a throttled ring of recent state snapshots
  (`barcount.snaps`). If the main key is ever unreadable, `load()` recovers the newest valid snapshot
  (and preserves the corrupt bytes) instead of resetting to blank; a banner notes the recovery.
  History lists on-device restore points.
- **Guarded reset**: "Reset this phone" forces a backup download, then requires typing `RESET` and the
  admin PIN before wiping.
- **Import preview + coverage board + undo**: scans show a NEW/UPDATE preview before merging; a grid of
  all stations + Door shows who's still out; one-tap undo of the last import.
- **Payload integrity**: QR payloads carry a checksum (`c`); a garbled/partial scan is rejected. A QR
  whose event name differs prompts before importing.
- **Multi-door merge**: door phones carry a device `id` and are summed (`day.doorPhones`), so a second
  door phone adds to the line count instead of overwriting it; a contributor can be removed.
- **Accurate "−"**: the served and door minus buttons undo the 15-min bucket the last `+1` landed in
  (a `servedTaps`/`taps` stack), not the current clock bucket.
- **Personal boot meter**: the count screen shows estimated $ raised tonight (people served ×
  `settings.tipEst`, default $3), with a milestone toast every $100.
- **Pace banner**: manager hub + boot screen show ahead/behind last year and $/night needed to catch up.
- **Tonight's brief**: a manager-hub card auto-summarizing busiest 15-min, top station, conversion,
  low stock, and pace — each line jumps to its screen.
