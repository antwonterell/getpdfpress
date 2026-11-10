# Synthetic PDF compression tests, 10 November 2026

These are six measured production API results, not typical savings or a quality guarantee. No personal files were used. The active production backend commit were not independently verified. Reported methods do not independently verify every processing step. ConvertAPI was not independently tested. The source inspected was commit 1dd1d3e0f981ada21d27590f0beed4c5edba4342. Requests ran between 02:16:36 and 02:17:15 UTC. The application reports KB targets using 1,024 bytes: 200KB means 204,800 bytes; 500KB means 512,000 bytes. A receiving portal may count differently.

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

## Generate the public synthetic inputs offline

No application checkout is needed for input generation. Create an empty scratch folder with a scripts/ subfolder. Save generate-compression-fixtures.py from this directory into scripts/. Install Python with reportlab 4.4.9 and Pillow 13.0.0, then run from that scratch folder:

`python scripts/generate-compression-fixtures.py`

It creates output/compression-benchmark/ with three synthetic inputs. A fixed random seed and invariant PDF metadata make the two large inputs reproducible. Both were regenerated independently and matched the input SHA-256 hashes in results.json exactly. The small measured input was normalized through the application; use the published born-digital.pdf for its exact bytes. Running the generator alone does not reproduce that normalization.

## Inspect the publicly available output files

Save results.json, born-digital.pdf, image-heavy-200kb.pdf, image-heavy-500kb.pdf and inspect-published.py together in one local folder. With pypdf 6.10.0 installed, run:

`python inspect-published.py`

This offline check verifies exact bytes, SHA-256, page counts, extracted-text counts, image counts and first-page dimensions for the three published PDFs. It does not rerun compression. The two born-digital results were identical, so one copy is supplied. The large 101-page input can be generated, but its two measured outputs are not published; the public files alone cannot independently verify their reported output hashes or contents.

For a visual check with Poppler on PATH, render any available PDF:

`pdftoppm -f 1 -l 1 -singlefile -scale-to-x 816 -scale-to-y -1 -png image-heavy-200kb.pdf review-200`

Repeat for the 500KB output. To reconstruct the published comparison, also render the generated original image-heavy.pdf at the same width, then compare the top 260 pixels of each first page. Equal pixel width is not equal physical print size. Inspection used Poppler 26.07.0; native production renderer versions were not independently queried.

## Maintainer-only full application rerun

The following steps require the application source, server.js, its package lock and scripts/check-compression-evidence.cjs. Those files are not provided by this public evidence directory. Copy the three benchmark scripts into the matching checkout's scripts/ directory and run from its root, not from public/test-results/.

1. Generate the inputs as above.
2. Run `node scripts/measure-compression.cjs` for the small local case. It starts the actual server on port 3179 with CONVERTAPI_SECRET empty and checks that provider processing is disabled.
3. With GraphicsMagick and Ghostscript installed locally, use `node scripts/measure-compression.cjs --all-local` for all fixtures. This workstation lacked those renderers; published results used no substituted or mocked renderer. Local results may differ. Client Node was 24.18.0 and pdf-lib 1.17.1.
4. After producing all six output files, put pdftoppm on PATH and run `python scripts/inspect-compression.py`. This full-run script expects all six named outputs, their inputs and results.json under output/compression-benchmark. It cannot run against only the three published PDFs.
5. Run `node scripts/check-compression-evidence.cjs` for repository-only publication checks.

The optional live runner mode requires --live-large and --verified-live-free-routes. Recheck the deployed source and authorization before using it. In the inspected source, an already-under-target file uses basicCompress, while inputs strictly larger than 10 MiB skip ConvertAPI. The runner cannot verify a future server's routing. The active backend revision was not independently verified, and reported methods alone do not establish every processing step. ConvertAPI and Word conversion were not independently tested.

PDF timestamps and renderer/dependency versions can change output hashes and byte counts. This records one run, not a promise of future byte-identical results or universal savings. Python verification used 3.12.14.
