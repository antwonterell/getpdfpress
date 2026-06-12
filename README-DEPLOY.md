# getPDFpress — Production Handoff

## 0. Tool audit (Phase 1 findings)

| Tool | Status | Engine | Notes |
|---|---|---|---|
| Compress to 500KB | ✅ WORKS | pdf-lib + GM/Ghostscript + sharp (open-source, in Docker image) | Verified: targets hit; honest miss-reporting; Gentle/Balanced/Strong wired; retry pass added |
| Compress to 200KB | ✅ WORKS | same | Verified end-to-end |
| Compress to 100KB / Auto | ✅ WORKS | same | "auto" previously crashed the math (NaN); fixed |
| Merge PDF | ✅ WORKS | pdf-lib (open-source) | Verified |
| Split PDF | ✅ WORKS | pdf-lib + archiver (open-source) | Verified; returns ZIP |
| JPG → PDF | ✅ WORKS | sharp + pdf-lib (open-source) | Verified |
| PDF → JPG | ✅ WORKS | pdf2pic/GM (open-source) | Was a memory risk on 100+ page PDFs; now capped at 50 pages with a clear message |
| PDF → Word | ⏸ GATED | ConvertAPI (paid) | Cannot be done well open-source. Now shows "Coming soon" automatically when CONVERTAPI_SECRET is absent; activates itself when you add the key |
| Word → PDF | ⏸ GATED | ConvertAPI (paid) | Same gating. (Free alternative is LibreOffice-in-Docker, but it ~doubles image size and RAM — wrong trade for Starter) |
| Protect / Unlock | 💀 DEAD CODE | — | Frontend functions exist, no server endpoints, no UI entry point. Harmless; remove in a future cleanup |

**Before the fixes**, status was: compressor produced CORRUPT downloads whenever the
target was missed (Express JSON-stringified the bytes), the size/level dropdowns did
nothing, "auto" was broken, Docker healthchecks were failing, and Word tools errored
on upload. All of that is in the "files changed" section below.

## 1. Summary of files changed

### server.js
- **Fixed corrupted downloads**: `res.send()` was passed raw `Uint8Array`s on the
  target-miss and image-compression paths, so Express JSON-stringified them —
  users downloaded broken ~13x-larger files labeled as PDFs. Now wrapped in `Buffer.from()`.
- **"auto" target handled**: `parseInt("auto")` = NaN previously poisoned all size math.
- **Compression Level wired up**: `gentle/balanced/strong` from the UI now biases JPEG
  quality (±10) in the image-compression path. Verified: same file → 1400/988/760KB.
- **Retry pass on miss**: if the first image-compression pass misses the target by >15%,
  one retry runs at proportionally lower quality/scale. Verified targets now hit.
- **Healthcheck fix**: the HTTPS/www canonical redirect no longer fires for localhost,
  `/api/health`, or any request without `x-forwarded-proto` — previously the Docker
  HEALTHCHECK got a 301 and Render would mark the service unhealthy.
- **Privacy fix**: full ConvertAPI responses (containing the user's document as base64)
  are no longer logged. Logs now show only status + file count.
- **Non-PDF uploads** to `/api/compress` get a clear 400 instead of a cryptic 500.
- **`X-Warning-Message: undefined`** header bug fixed (only set when present).
- **gzip compression** middleware added; **static caching**: HTML `no-cache`,
  assets `max-age=86400, stale-while-revalidate`.
- **Learn routes collapsed**: 12 copy-pasted routes replaced by one whitelisted
  dynamic route (`/learn/:slug([a-z0-9-]+)`) — new articles need no server change.

### All 9 tool pages (index, compress-500kb/200kb, merge, split, jpg↔pdf, pdf↔word)
- Tailwind CDN (unsupported in production) replaced with built `/output.css`.
- Fake "Join 10,000+ people this month" social proof removed.
- "This tool is being wired up" placeholder removed.
- Result UI is now honest: reads `X-Target-Miss` and tells the user when the target
  couldn't be reached and what to try, instead of always claiming success.
- The dropdown's target (incl. 100KB/Auto) is actually sent to the API.
- Post-result ad slot moved BELOW the download buttons with a labeled divider
  (AdSense policy: ads must not sit adjacent to download buttons).
- AdSense Auto Ads placement comment added in `<head>` (see §6).
- `trackToolSuccess()` analytics hook added — fires a GA4 event on real download
  clicks only if `gtag` is loaded; never fakes analytics.

### Learn section
- 7 new search-intent articles (all facts checked; USCIS limit verified at 12MB
  against uscis.gov):
  - `/learn/compress-pdf-for-uscis-immigration`
  - `/learn/pdf-too-large-for-upload`
  - `/learn/compress-scanned-pdf-readable`
  - `/learn/best-pdf-size-for-email`
  - `/learn/reduce-pdf-size-iphone`
  - `/learn/reduce-pdf-size-android`
  - `/learn/pdf-compression-vs-quality`
  Each has: quick answer, TOC, steps, FAQs, related-tool cards, internal links,
  canonical/OG tags, and Article + FAQPage JSON-LD.
- Fake author personas ("Marcus Rivera", "Dr. Sarah Chen", "Elena Rodriguez")
  removed from bylines, bios, and meta-author tags → "getPDFpress Team".
- Templated meta descriptions on the 12 existing articles replaced with real ones.
- Article JSON-LD added to all existing articles.
- `learn/index.html` lists the new guides; `sitemap.xml` includes them (32 URLs).

### Accuracy fix
- Homepage/200KB page claimed USCIS requires ~200KB files. USCIS's official limit
  is 12MB per file (PDF/JPG/JPEG). Copy now says "many e-visa and regional portals
  cap files at 200–300KB" instead, and the USCIS article states the verified limit.

### Legal/contact
- contact/privacy/terms had Cloudflare email-protection links copied from a
  Cloudflare-rendered page — broken on Render (visitors saw literal
  "[email protected]"). Replaced with real mailto: links
  (support@ / privacy@ / legal@getpdfpress.com) + TODO comments: **create these
  inboxes before launch** (registrar email forwarding is enough).
- Privacy policy now discloses ConvertAPI as a processor and no longer claims
  browser-side processing (nothing is processed in-browser).

### Build/deploy
- `public/output.css` built and committed (33KB minified vs ~110KB+ CDN script + runtime JIT).
- `public/og-pdfpress.png` created (was referenced but missing — broken social shares).
- `dockerignore` renamed to `.dockerignore` (it was inert; node_modules/.env were
  being copied into images).
- `package-lock.json` generated; Dockerfile uses `npm ci` when it exists.
- `compression` added to dependencies.


### Phase 3 addition (this revision)
- Word↔PDF tools now self-gate: on load, the frontend checks `/api/health`; when
  ConvertAPI isn't configured the tool shows "Coming soon — we are improving this
  converter," and the process buttons stay disabled. No broken functionality is
  reachable. Adding `CONVERTAPI_SECRET` in Render activates both tools instantly.
- PDF→JPG capped at 50 pages (memory guard for the 450MB container), with a
  helpful message pointing long documents to Split first.

## 2. Run locally
```bash
npm install
npm run build:css        # regenerates public/output.css after HTML/CSS changes
node server.js           # http://localhost:3000
# optional: CONVERTAPI_SECRET=xxx node server.js   (enables PDF↔Word)
```
Local Ghostscript/GraphicsMagick are needed for image-based compression and
PDF→JPG (`apt install graphicsmagick ghostscript` / `brew install graphicsmagick ghostscript`).
Without them, compression falls back to pdf-lib optimization only.

## 3. Deploy on Render — exact settings
- **Service type:** Web Service, **Runtime:** Docker (auto-detected from Dockerfile)
- **Plan:** Starter ($7/mo) — already set in render.yaml; no sleeping, enough RAM
- **Branch:** main, **Auto-deploy:** on (set in render.yaml)
- **Health check path:** `/api/health` (the Docker HEALTHCHECK also uses it — now fixed to not 301)
- **Environment tab:**
  - `NODE_ENV` = `production` (already in render.yaml)
  - `CONVERTAPI_SECRET` = *(leave unset at launch; Word tools show "Coming soon" automatically. Add it later to activate them — no code change needed.)*
- **Custom domain:** add getpdfpress.com; the app 301s www→apex and http→https itself.
- After first deploy, verify: open `/api/health` (expect `"status":"OK"`), run one real
  compression, then submit `https://getpdfpress.com/sitemap.xml` in Search Console.

## 4. Required environment variables (Render dashboard → Environment)
| Var | Required | Purpose |
|---|---|---|
| `NODE_ENV=production` | yes (set in render.yaml) | standard |
| `CONVERTAPI_SECRET` | only for PDF↔Word | Without it those two tools return a clear "not configured" message; compression/merge/split/jpg tools work fully without it. |

**Cost note:** the recommended MVP path (already implemented) is: pdf-lib (free,
in-process) → image-pipeline via GraphicsMagick+Ghostscript+sharp (free, in the
Docker image) → ConvertAPI only as an optional booster and for Word conversions.
You can launch with $0 API spend by leaving `CONVERTAPI_SECRET` unset and hiding
the two Word tools, or keep them visible — they fail gracefully with an honest message.

## 5. Known limitations
- Compression targets are best-effort (the UI says so, and now tells the user when missed).
- Very small targets on long scans (≲3KB/page) produce barely-readable output; the
  server warns and suggests splitting.
- `/api/pdf-to-images` returns all pages as base64 JSON — fine for typical files,
  but a 100+ page PDF could approach the 450MB memory cap. Consider capping pages.
- The 9 tool pages are still near-identical large HTML files; edits must be applied
  to all of them. A templating pass (e.g., EJS or a build script) is the right next
  refactor before further UI work.
- Word↔PDF requires ConvertAPI (LibreOffice-in-Docker is the free alternative but
  roughly doubles image size and memory needs — not recommended on Starter).
- `support@/privacy@/legal@getpdfpress.com` are placeholders until you create them.

## 6. Before applying to AdSense
1. Deploy and confirm tools work in production (run a real compress → download).
2. Create the three contact inboxes (or change the addresses).
3. Add Google Analytics (gtag) — the `trackToolSuccess` hook will start reporting
   real usage automatically.
4. Let the site accumulate some weeks of real traffic/content history; AdSense
   reviewers reject "under construction" or thin sites — yours no longer shows
   placeholders, fake stats, or broken links, which were the main rejection risks.
5. After approval: paste the Auto Ads script where the `ADSENSE` comment sits in
   each page's `<head>`; keep anchor/vignette formats off near the uploader.
6. Then (and only then) update privacy.html to add an Advertising/Cookies section
   for AdSense per Google's required disclosures.
