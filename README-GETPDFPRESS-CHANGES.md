# getPDFpress production cleanup

## What changed
- Rebuilt the public pages with a cohesive getPDFpress brand system, responsive layout, cleaner navigation, and safer ad placeholder zones.
- Removed Tailwind CDN from production pages.
- Added a local CSS build step: `npm run build:css` copies/minifies `src/site.css` to `public/output.css`.
- Removed placeholder credibility killers: no “being wired up” banner, no fake “10,000+ users” claim, no fake success state.
- Added a shared frontend script at `public/app.js` for upload, progress, error handling, before/after sizes, and real downloads.
- Kept backend PDF processing routes and added safer production behavior.
- Added clean URL fallback for new `.html` pages, including new Learn articles.
- Updated Privacy, Terms, Contact, 404, robots.txt, and sitemap.xml.
- Added safe future AdSense comments but did not enable ads.

## How to run locally
```bash
npm install
npm run build:css
npm start
```
Then open `http://localhost:3000`.

## How to deploy on Render
This project still supports the Docker-based Render setup.

1. Push the updated project to GitHub.
2. In Render, create or update the web service using the included `render.yaml`.
3. Set environment variables in the Render dashboard.
4. Deploy.

## Required environment variables
- `NODE_ENV=production`
- `CONVERTAPI_SECRET` only if you want PDF-to-Word and Word-to-PDF conversion, and optional ConvertAPI compression support.

## Known limitations
- PDF compression is best-effort. Exact 500KB, 200KB, or 100KB targets are not always realistic, especially for long scanned documents.
- PDF-to-Word and Word-to-PDF require `CONVERTAPI_SECRET`.
- Server-side processing means files temporarily upload to your server. Do not claim “files never leave your device.”
- The public email addresses are placeholders until you create the inboxes at your domain/email host.

## Before applying to AdSense
- Confirm the compressor works on Render with several real PDFs.
- Create the domain email inboxes.
- Verify privacy policy matches the final analytics/ad setup.
- Keep ads away from upload, compress, and download buttons.
- Add more real screenshots or examples only after you have real outputs.
