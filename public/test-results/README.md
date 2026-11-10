# Synthetic PDF compression tests, 10 November 2026

These are six measured production API results, not typical savings or a quality guarantee. No personal files were used. The active production backend commit and provider billing telemetry were not independently verified. Response methods alone do not prove that no provider request occurred. No purchase or credit top-up was initiated. The source inspected was commit 1dd1d3e0f981ada21d27590f0beed4c5edba4342. Requests ran between 02:16:36 and 02:17:15 UTC. The application reports KB targets using 1,024 bytes: 200KB means 204,800 bytes; 500KB means 512,000 bytes. A receiving portal may count differently.

## Fixtures and measured results

- Born-digital, 1 page: 1,151 bytes in and 1,151 out at both targets. Returned bytes were identical; all 283 extracted text characters remained.
- Image-heavy, 2 pages: 14,698,148 bytes in; 66,963 bytes at 200KB and 178,842 bytes at 500KB. Both pages remained, but 566 extracted text characters became zero: pages were rasterized. Page dimensions changed from 612 x 792 PDF points to 465 x 602 (200KB) or 664 x 860 (500KB).
- Long document, 101 pages: 14,770,858 bytes in; 14,741,758 out at each target. Both targets were missed and reported as misses. All 101 pages and all 28,959 extracted text characters remained. The image method's page cap was exceeded, so this is a genuine limit case, not a claim that every long file fails.

The image-heavy fixture uses deterministic random color pixels with a white text area, plus selectable text at 12, 10, 8 and 6 points. It is deliberately difficult and is not a real scan or representative photograph. The long fixture reuses the same image on 101 pages, with page-specific text. The tiny fixture is normalized once through the real local optimizer before measuring unchanged-original behavior.

## Inspect the evidence

- results.json contains byte sizes, hashes, target flags, page counts, extracted text counts and page dimensions.
- born-digital.pdf is the exact small input.
- image-heavy-200kb.pdf and image-heavy-500kb.pdf are the actual downloaded results.
- readability-comparison.png shows the first-page top area at equal 816-pixel full-page width: original, 200KB, then 500KB. Each page was rendered independently before cropping. This is a relative page-width comparison, not equal physical print size. The 200KB fine 6-point line is not reliably readable; the 500KB result has clearer 10/12-point lines but softened fine text. Size success is not readability success.

All pages were checked for count, extractable text and image count. Representative first pages and the last page of the long file were visually inspected with Poppler. There was no all-page visual audit, objective readability score, OCR test, accessibility test, digital-signature test, form test, or print-fidelity test. Poppler emitted missing Symbol/ArialUnicode display-font warnings; these Latin Helvetica fixture pages rendered and were visually checked.

## Reproduce safely

Use the matching project checkout and its package lock. Run commands from the repository root. If downloading the three scripts from this directory, place them in that checkout's scripts/ directory with their existing filenames, replacing only the matching benchmark scripts. They resolve output/compression-benchmark relative to scripts/, so do not run them directly from public/test-results/. The offline check script is supplied in the repository's scripts/ directory. The generator needs Python with reportlab 4.4.9 and Pillow 13.0.0. Inspection used pypdf 6.10.0 and Poppler 26.07.0. Client Node was 24.18.0 and pdf-lib 1.17.1. Production native renderer versions were not independently queried.

1. Run `python scripts/generate-compression-fixtures.py`. It writes three synthetic inputs under output/compression-benchmark. Input hashes for the two large fixtures are in results.json. Both were independently regenerated in a separate scratch directory and matched those SHA-256 hashes exactly. The small normalized input is also available above; its timestamp metadata can vary on regeneration.
2. Run `node scripts/measure-compression.cjs` for the small local test. This starts the actual server on port 3179 with CONVERTAPI_SECRET explicitly empty, checks the provider is disabled, performs the calls and stops its child server. It does not call a paid provider.
3. With GraphicsMagick and Ghostscript available locally, use `node scripts/measure-compression.cjs --all-local` to measure all fixtures through the full free local pipeline. Local results may differ from this production run. This workstation lacked those two renderers; no substituted/mocked renderer was used for the published results.
4. Put pdftoppm on PATH and run `python scripts/inspect-compression.py` to inspect results and render representative pages. The equal-width comparison can be reproduced with `pdftoppm -f 1 -l 1 -singlefile -scale-to-x 816 -scale-to-y -1 -png INPUT.pdf OUTPUT_PREFIX`, then compare the top 260 pixels of each image.
5. Run `node scripts/check-compression-evidence.cjs` in the repository for offline assertions on the published results, hashes, page counts and copies of these scripts.

The optional live mode requires both `--live-large` and `--verified-live-free-routes`. Do not use it without rechecking the deployed source and permission to send six synthetic requests. At the tested revision, a file already under target goes directly to basicCompress; files strictly larger than 10 MiB skip the ConvertAPI branch. The runner enforces these input sizes, but cannot verify that a future server keeps the same routing. Run sequentially and never substitute private documents. No dedicated Word or ConvertAPI conversion tests were run. Inputs were selected to avoid ConvertAPI under the inspected source, but the active backend revision and provider billing telemetry were not independently verified.

PDF timestamps and renderer/dependency versions can change output hashes and byte counts. This publication records one run; it does not promise future byte-identical results or universal compression savings. Large fixture binaries are intentionally not duplicated publicly; their deterministic generator and input hashes are provided instead.

