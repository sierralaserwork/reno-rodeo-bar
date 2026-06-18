# lib/ — vendor these locally (no CDN, must work offline)

The app needs no internet at runtime, so do NOT load these from a CDN. Download the files and
drop them here, then uncomment the `<script>` tags in `index.html` and add them to `PRECACHE`
in `service-worker.js`.

1. **QR encoder** (to display a phone's QR on the Show-QR screen)
   - e.g. `qrcode-generator` — save the single JS file as `lib/qrcode.js`.

2. **QR decoder** (Manager scans by photographing another phone's QR)
   - `jsQR` — save the built file as `lib/jsqr.js`.
   - Decode flow: `<input type="file" accept="image/*" capture="environment">` → draw the chosen
     image to a `<canvas>` → `jsQR(imageData.data, width, height)` → parse the JSON payload.
   - Render the QR large with a wide quiet zone so a photo of a phone screen decodes reliably.

Keep the payload small (15-minute buckets, no per-tap timestamps) so it fits in one QR.
