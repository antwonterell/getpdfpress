// server.js - PRODUCTION VERSION for getPDFpress
// Professional setup with ConvertAPI integration
// No hacks, no crashes, just reliable PDF processing

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");
const { fromPath } = require("pdf2pic");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;
app.disable("x-powered-by");

// ============================================
// PRODUCTION CONFIGURATION
// ============================================
const MAX_CONCURRENT_REQUESTS = 2; // 512MB instance: >2 heavy PDF jobs at once risks OOM restarts
const REQUEST_TIMEOUT = 90000; // 90 seconds (must exceed ConvertAPI's 60s axios timeout)
const CONVERTAPI_SECRET = process.env.CONVERTAPI_SECRET || "";

let activeRequests = 0;
let requestQueue = [];

// Memory monitoring
setInterval(() => {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  
  console.log(`📊 Memory: RSS ${rssMB}MB / Heap ${heapUsedMB}MB`);
  
  if (rssMB > 400 && global.gc) {
    global.gc();
    console.log("🗑️ GC triggered");
  }
}, 30000);

// Create directories
const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

try {
  if (!fsSync.existsSync(uploadsDir)) {
    fsSync.mkdirSync(uploadsDir, { recursive: true });
  }
  if (!fsSync.existsSync(outputDir)) {
    fsSync.mkdirSync(outputDir, { recursive: true });
  }
} catch (err) {
  console.error("❌ Error creating directories:", err);
}

// File cleanup every 30 minutes (as requested)
setInterval(async () => {
  try {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    
    for (const dir of [uploadsDir, outputDir]) {
      const files = await fs.readdir(dir);
      let cleanedCount = 0;
      
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stats = await fs.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.unlink(filePath);
            cleanedCount++;
          }
        } catch (err) {
          // File already deleted or permission error
        }
      }
      
      if (cleanedCount > 0) {
        console.log(`🗑️ Cleaned ${cleanedCount} files from ${dir}`);
      }
    }
  } catch (err) {
    console.error("❌ Cleanup error:", err);
  }
}, 30 * 60 * 1000); // Every 30 minutes

// ============================================
// REQUEST QUEUE MIDDLEWARE
// ============================================
function requestQueueMiddleware(req, res, next) {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    console.log(`⏳ Queued (${requestQueue.length + 1} waiting)`);
    
    requestQueue.push({ req, res, next });
    
    const timeout = setTimeout(() => {
      const index = requestQueue.findIndex(item => item.req === req);
      if (index !== -1) {
        requestQueue.splice(index, 1);
        res.status(503).json({
          error: "Server busy",
          message: "Please try again in a moment.",
        });
      }
    }, 30000);
    
    req.on('close', () => clearTimeout(timeout));
    return;
  }
  
  activeRequests++;
  console.log(`▶️ Processing (${activeRequests}/${MAX_CONCURRENT_REQUESTS})`);
  
  const timeout = setTimeout(() => {
    console.error("⏱️ Timeout");
    if (!res.headersSent) {
      res.status(504).json({ error: "Request timeout" });
    }
  }, REQUEST_TIMEOUT);
  
  const originalEnd = res.end;
  res.end = function(...args) {
    clearTimeout(timeout);
    activeRequests--;
    console.log(`✅ Done (${activeRequests} active, ${requestQueue.length} queued)`);
    
    if (requestQueue.length > 0) {
      const nextRequest = requestQueue.shift();
      setImmediate(() => requestQueueMiddleware(nextRequest.req, nextRequest.res, nextRequest.next));
    }
    
    originalEnd.apply(this, args);
  };
  
  next();
}

// ============================================
// MULTER CONFIGURATION
// ============================================
const sanitize = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "_");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext);
    cb(null, `${Date.now()}-${sanitize(base)}${ext.toLowerCase()}`);
  },
});

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB: larger files get base64-expanded ~3x in RAM on a 512MB instance
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(
  cors({
    // Same-origin requests bypass CORS entirely; this only stops other
    // websites from calling our processing API from their visitors' browsers.
    origin: ["https://getpdfpress.com", "http://localhost:3000", "http://localhost:3456"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
app.use(express.json({ limit: '10mb' }));

// Basic security and cache headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

// ============================================
// RATE LIMITING (in-memory, per client IP)
// ============================================
const rateBuckets = new Map();
function rateLimit(max, windowMs, label) {
  return (req, res, next) => {
    const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
    const key = `${label}:${ip}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return res.status(429).json({
        error: "Too many requests",
        message: "You have reached the usage limit. Please wait a few minutes and try again.",
      });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 30 * 60 * 1000) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000);

// Processing endpoints: generous for humans, hostile to scripts.
app.use("/api/", rateLimit(60, 10 * 60 * 1000, "api"));
// ConvertAPI-backed conversions burn paid quota: stricter.
app.use("/api/word-to-pdf", rateLimit(10, 10 * 60 * 1000, "convert"));
app.use("/api/pdf-to-word", rateLimit(10, 10 * 60 * 1000, "convert"));

// ============================================
// UPLOAD CONTENT VALIDATION (magic bytes, not just filenames)
// ============================================
async function fileStartsWith(filePath, signatures) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const { buffer } = await handle.read(Buffer.alloc(1024), 0, 1024, 0);
    return signatures.some((sig) => buffer.includes(sig));
  } catch (_) {
    return false;
  } finally {
    if (handle) await handle.close();
  }
}
const isRealPdf = (p) => fileStartsWith(p, [Buffer.from("%PDF-")]);
const isRealImage = (p) => fileStartsWith(p, [Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
const isRealOffice = (p) => fileStartsWith(p, [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0xd0, 0xcf, 0x11, 0xe0])]);

function requireFileType(checker, label) {
  return async (req, res, next) => {
    const files = req.files || (req.file ? [req.file] : []);
    for (const f of files) {
      if (!(await checker(f.path))) {
        await cleanupFiles(...files.map((x) => x.path));
        return res.status(400).json({
          error: "Wrong file type",
          message: `${headerSafeName(f.originalname)} is not a valid ${label} file. Please upload a real ${label}.`,
        });
      }
    }
    next();
  };
}
const requirePdf = () => requireFileType(isRealPdf, "PDF");
const requireImages = () => requireFileType(isRealImage, "JPG or PNG image");
const requireOffice = () => requireFileType(isRealOffice, "Word document");

// Filenames echoed into headers must never carry header-breaking characters.
const headerSafeName = (name) => String(name || "file").replace(/[\r\n"'\\;]/g, "_").slice(0, 120);

// Canonical domain enforcement only in production.
// This keeps local development on http://localhost:3000 from redirecting to https://localhost.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") return next();

  const host = req.headers.host || '';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const isLocal = host.includes('localhost') || host.startsWith('127.');
  const isWWW = host.startsWith('www.');
  const isHTTP = protocol === 'http';
  
  if (!isLocal && (isWWW || isHTTP)) {
    const canonicalHost = host.replace(/^www\./, '');
    const canonicalURL = `https://${canonicalHost}${req.originalUrl}`;
    return res.redirect(301, canonicalURL);
  }
  next();
});

app.use(express.static("public", {
  maxAge: process.env.NODE_ENV === "production" ? "30d" : 0,
  etag: true,
  redirect: false, // don't 301 /learn -> /learn/; the explicit route serves it directly

  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// ============================================
// PAGE ROUTES (for clean URLs)
// ============================================
// Main tool pages
app.get("/compress-pdf-500kb", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "compress-pdf-500kb.html"));
});

app.get("/compress-pdf-200kb", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "compress-pdf-200kb.html"));
});

app.get("/merge-pdf", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "merge-pdf.html"));
});

app.get("/split-pdf", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "split-pdf.html"));
});

app.get("/jpg-to-pdf", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "jpg-to-pdf.html"));
});

app.get("/pdf-to-jpg", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pdf-to-jpg.html"));
});

app.get("/pdf-to-word", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pdf-to-word.html"));
});

app.get("/word-to-pdf", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "word-to-pdf.html"));
});

// Info pages
app.get("/contact", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "contact.html"));
});

app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

// Learn section
app.get("/learn", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "index.html"));
});

app.get("/learn/best-free-pdf-compressor", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "best-free-pdf-compressor.html"));
});

app.get("/learn/compress-pdf-for-job-application", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "compress-pdf-for-job-application.html"));
});

app.get("/learn/compress-pdf-without-losing-quality", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "compress-pdf-without-losing-quality.html"));
});

app.get("/learn/how-to-compress-pdf-to-200kb", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "how-to-compress-pdf-to-200kb.html"));
});

app.get("/learn/how-to-compress-pdf-to-500kb", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "how-to-compress-pdf-to-500kb.html"));
});

app.get("/learn/how-to-merge-multiple-pdfs", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "how-to-merge-multiple-pdfs.html"));
});

app.get("/learn/how-to-split-pdf-pages", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "how-to-split-pdf-pages.html"));
});

app.get("/learn/jpg-to-pdf-converter-guide", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "jpg-to-pdf-converter-guide.html"));
});

app.get("/learn/pdf-compression-for-mobile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "pdf-compression-for-mobile.html"));
});

app.get("/learn/pdf-file-size-limits-2026", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "pdf-file-size-limits-2026.html"));
});

app.get("/learn/pdf-to-word-conversion-guide", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "pdf-to-word-conversion-guide.html"));
});

app.get("/learn/why-is-my-pdf-so-large", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "learn", "why-is-my-pdf-so-large.html"));
});

// Retired duplicate article URLs -> canonical versions (301 so search engines consolidate)
const RETIRED_ARTICLE_REDIRECTS = {
  "/learn/best-pdf-size-for-email-attachments": "/learn/best-pdf-size-for-email",
  "/learn/compress-pdf-for-uscis-or-immigration-forms": "/learn/compress-pdf-for-uscis-immigration",
  "/learn/pdf-compression-vs-pdf-quality": "/learn/pdf-compression-vs-quality",
  "/learn/reduce-pdf-file-size-on-iphone": "/learn/reduce-pdf-size-iphone",
  "/learn/reduce-pdf-file-size-on-android": "/learn/reduce-pdf-size-android",
};

app.use((req, res, next) => {
  const target = RETIRED_ARTICLE_REDIRECTS[req.path];
  if (target) return res.redirect(301, target);
  next();
});

// Apply queue to processing endpoints
app.use('/api/compress', requestQueueMiddleware);
app.use('/api/merge', requestQueueMiddleware);
app.use('/api/split', requestQueueMiddleware);
app.use('/api/pdf-to-images', requestQueueMiddleware);
app.use('/api/images-to-pdf', requestQueueMiddleware);
app.use('/api/word-to-pdf', requestQueueMiddleware);
app.use('/api/pdf-to-word', requestQueueMiddleware);

// ============================================
// HELPER FUNCTIONS
// ============================================
async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (_) {}
}

async function cleanupFiles(...filePaths) {
  for (const filePath of filePaths) {
    await safeUnlink(filePath);
  }
}

// ============================================
// PDF COMPRESSION - Smart compression with fallback
// ============================================
app.post("/api/compress", upload.single("file"), requirePdf(), async (req, res) => {
  let inputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const targetSize = req.body.targetSize; // "500" or "200" (in KB)
    const originalSizeKB = Math.round(req.file.size / 1024);

    console.log(`📄 Compress request: ${originalSizeKB}KB → Target: ${targetSize || 'auto'}KB`);

    // If no target size, use basic compression
    if (!targetSize) {
      console.log("ℹ️ No target size - using basic compression");
      return await basicCompress(req, res, inputPath);
    }

    const targetSizeKB = parseInt(targetSize);
    const targetBytes = targetSizeKB * 1024;

    // If file is already under target, just optimize it
    if (req.file.size <= targetBytes) {
      console.log(`✅ File already under ${targetSizeKB}KB - light optimization`);
      return await basicCompress(req, res, inputPath);
    }

    // Try to compress to target (COLOR ONLY - no grayscale)
    await compressToTargetColorOnly(req, res, inputPath, targetBytes, req.file.originalname, originalSizeKB);
    
  } catch (error) {
    console.error("❌ Compress error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Compression failed",
        details: error.message,
      });
    }
  } finally {
    await cleanupFiles(inputPath);
  }
});

// ============================================
// HELPER: PDF → Images → PDF (NUCLEAR OPTION - Always works!)
// ============================================
async function compressViaImages(inputPath, targetBytes, originalFilename, originalSize) {
  console.log(`🎨 PDF→Images→PDF method (closed-loop)`);

  try {
    const pdfDoc = await PDFDocument.load(await fs.readFile(inputPath));
    const pageCount = pdfDoc.getPageCount();

    console.log(`   📄 ${pageCount} pages to process`);

    const bytesPerPage = targetBytes / pageCount;
    const targetKB = Math.round(targetBytes / 1024);

    // Starting parameters predicted from the per-page byte budget
    let dpi, quality, resize = 1.0;
    if (bytesPerPage > 150000)      { dpi = 150; quality = 80; }
    else if (bytesPerPage > 80000)  { dpi = 120; quality = 70; }
    else if (bytesPerPage > 40000)  { dpi = 96;  quality = 60; }
    else if (bytesPerPage > 20000)  { dpi = 72;  quality = 50; }
    else if (bytesPerPage > 10000)  { dpi = 72;  quality = 35; }
    else if (bytesPerPage > 5000)   { dpi = 60;  quality = 25; resize = 0.85; }
    else                            { dpi = 48;  quality = 15; resize = 0.7; }

    // Never silently drop pages. If the document is too long for this method
    // at the requested target, bail out and let the caller fall back honestly.
    const maxPages = bytesPerPage < 5000 ? 20 : 100;
    if (pageCount > maxPages) {
      console.log(`   ⚠️ ${pageCount} pages exceeds the ${maxPages}-page cap for this target - skipping image method (no truncated output).`);
      return null;
    }

    const firstPage = pdfDoc.getPage(0);
    const { width: pageWidth, height: pageHeight } = firstPage.getSize();
    const pageWidthInches = pageWidth / 72;
    const pageHeightInches = pageHeight / 72;

    async function renderPass(passDpi, passQuality, passResize) {
      const converter = fromPath(inputPath, {
        density: passDpi,
        format: "png",
        width: Math.floor(passDpi * pageWidthInches * passResize),
        height: Math.floor(passDpi * pageHeightInches * passResize),
      });

      const newPdfDoc = await PDFDocument.create();
      let totalSize = 0;
      let processedPages = 0;
      let q = passQuality;
      let rs = passResize;

      for (let i = 1; i <= pageCount; i++) {
        try {
          const result = await converter(i, { responseType: "buffer" });

          const compressedImage = await sharp(result.buffer)
            .resize({ width: Math.floor(passDpi * pageWidthInches * rs), fit: "inside" })
            .jpeg({ quality: q, progressive: true, mozjpeg: true })
            .toBuffer();

          const img = await newPdfDoc.embedJpg(compressedImage);
          const page = newPdfDoc.addPage([img.width, img.height]);
          page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

          totalSize += compressedImage.length;
          processedPages++;

          // Mid-pass adjustment when the budget is running out
          if (totalSize > targetBytes * 0.7 && i < pageCount) {
            const budgetPerPage = (targetBytes - totalSize) / (pageCount - i);
            if (budgetPerPage < bytesPerPage * 0.6) {
              q = Math.max(10, q - 5);
              rs = Math.max(0.6, rs - 0.05);
            }
          }
        } catch (pageError) {
          console.error(`      ⚠️ Page ${i} failed, skipping`);
          continue;
        }
      }

      if (processedPages === 0) {
        throw new Error("No pages could be processed");
      }

      const bytes = await newPdfDoc.save({ useObjectStreams: true });
      return { bytes, processedPages, finalQuality: q };
    }

    // Closed loop: render, measure, and retry with scaled-down parameters
    // when the result overshoots the target. Bounded to protect the server.
    const maxAttempts = pageCount <= 30 ? 3 : 1;
    let best = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`   🎯 Attempt ${attempt}/${maxAttempts}: ${dpi} DPI, Q${quality}, resize ${resize}`);
      const pass = await renderPass(dpi, quality, resize);
      const sizeKB = Math.round(pass.bytes.length / 1024);
      console.log(`   Result: ${sizeKB}KB (${pass.processedPages} pages)`);

      if (!best || pass.bytes.length < best.bytes.length) {
        best = { bytes: pass.bytes, processedPages: pass.processedPages, dpi, quality };
      }

      if (pass.bytes.length <= targetBytes * 1.05) break;

      // Scale parameters toward the target for the next attempt
      const factor = targetBytes / pass.bytes.length;
      const nextQuality = Math.max(10, Math.round(quality * Math.pow(factor, 0.6)));
      const nextDpi = Math.max(48, Math.round(dpi * Math.pow(factor, 0.35)));
      const nextResize = Math.max(0.55, Number((resize * Math.pow(factor, 0.2)).toFixed(2)));
      if (nextQuality === quality && nextDpi === dpi && nextResize === resize) break;
      quality = nextQuality; dpi = nextDpi; resize = nextResize;
    }

    console.log(`   ✅ Best: ${Math.round(best.bytes.length / 1024)}KB (target ${targetKB}KB)`);

    return {
      bytes: best.bytes,
      method: 'pdf-to-images',
      dpi: best.dpi,
      quality: best.quality,
      pagesProcessed: best.processedPages
    };

  } catch (error) {
    console.error(`   ❌ PDF→Images failed:`, error.message);
    return null;
  }
}

// ============================================
// HELPER: 3-METHOD HYBRID COMPRESSION (FIXED)
// ============================================
async function compressToTargetColorOnly(req, res, inputPath, targetBytes, originalFilename, originalSizeKB) {
  const targetKB = Math.round(targetBytes / 1024);
  const originalSize = req.file.size;
  
  console.log(`🎯 Hybrid 3-method compression: ${originalSizeKB}KB → ${targetKB}KB`);
  
  // Check if target is realistic
  const pdfDoc = await PDFDocument.load(await fs.readFile(inputPath));
  const pageCount = pdfDoc.getPageCount();
  const bytesPerPage = targetBytes / pageCount;
  const kbPerPage = Math.round(bytesPerPage / 1024);
  
  if (kbPerPage < 3) {
    console.log(`⚠️ UNREALISTIC TARGET: ${pageCount} pages → ${targetKB}KB = ${kbPerPage}KB/page (thumbnail quality!)`);
  }
  
  let method1Result = null; // pdf-lib
  let method2Result = null; // ConvertAPI
  let method3Result = null; // PDF→Images→PDF
  
  // METHOD 1: pdf-lib (Fast, works on all PDFs, modest compression)
  console.log(`📊 Method 1: pdf-lib optimization...`);
  try {
    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');

    const compressedBytes = await pdfDoc.save({ 
      useObjectStreams: true,
      addDefaultPage: false,
    });

    method1Result = compressedBytes;
    const sizeKB = Math.round(compressedBytes.length / 1024);
    console.log(`   Result: ${sizeKB}KB`);

    if (compressedBytes.length <= targetBytes * 1.05) {
      const reduction = Math.round(((originalSize - compressedBytes.length) / originalSize) * 100);
      console.log(`✅ pdf-lib hit target! (-${reduction}%)`);
      
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="compressed-${headerSafeName(originalFilename)}"`,
        "Content-Length": compressedBytes.length,
        "X-Original-Size": originalSize,
        "X-Compressed-Size": compressedBytes.length,
        "X-Compression-Method": "pdf-lib",
      });

      return res.send(Buffer.from(compressedBytes));
    }
  } catch (error) {
    console.log(`   ⚠️ pdf-lib failed:`, error.message);
  }
  
  // METHOD 2: ConvertAPI (Good for image PDFs, BUT can make files bigger!)
  // Skip for files over 10MB: base64-encoding the upload roughly triples its RAM footprint.
  if (CONVERTAPI_SECRET && method1Result && originalSize <= 10 * 1024 * 1024) {
    console.log(`📊 Method 2: ConvertAPI...`);
    method2Result = await tryConvertAPICompression(inputPath, originalFilename, targetBytes, originalSize);
    
    if (method2Result) {
      const method2KB = Math.round(method2Result.length / 1024);
      const method1KB = Math.round(method1Result.length / 1024);
      
      // IMPORTANT: Only use ConvertAPI result if it's SMALLER than pdf-lib!
      if (method2Result.length >= method1Result.length) {
        console.log(`   ⚠️ ConvertAPI made it bigger (${method2KB}KB vs ${method1KB}KB) - skipping!`);
        method2Result = null; // Discard this result
      } else {
        console.log(`   Result: ${method2KB}KB`);
        
        if (method2Result.length <= targetBytes * 1.05) {
          const reduction = Math.round(((originalSize - method2Result.length) / originalSize) * 100);
          console.log(`✅ ConvertAPI hit target! ${method2KB}KB (-${reduction}%)`);
          
          res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="compressed-${headerSafeName(originalFilename)}"`,
            "Content-Length": method2Result.length,
            "X-Original-Size": originalSize,
            "X-Compressed-Size": method2Result.length,
            "X-Compression-Method": "convertapi",
          });

          return res.send(method2Result);
        }
      }
    }
  }
  
  // METHOD 3: PDF→Images→PDF (Nuclear option - works but slow)
  // Only use if target is reasonable (>3KB per page) OR if user really wants it
  if (kbPerPage >= 3 || targetKB <= 500) {
    console.log(`📊 Method 3: PDF→Images→PDF (extreme compression)...`);
    const imageResult = await compressViaImages(inputPath, targetBytes, originalFilename, originalSize);
    
    if (imageResult) {
      method3Result = imageResult.bytes;
      const method3KB = Math.round(imageResult.bytes.length / 1024);
      
      if (imageResult.bytes.length <= targetBytes * 1.15) {
        const reduction = Math.round(((originalSize - imageResult.bytes.length) / originalSize) * 100);
        console.log(`✅ PDF→Images hit target! ${method3KB}KB (-${reduction}%)`);
        
        res.set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="compressed-${headerSafeName(originalFilename)}"`,
          "Content-Length": imageResult.bytes.length,
          "X-Original-Size": originalSize,
          "X-Compressed-Size": imageResult.bytes.length,
          "X-Compression-Method": "pdf-to-images",
          "X-Compression-DPI": imageResult.dpi,
          "X-Compression-Quality": imageResult.quality,
        });

        // Must be a Buffer: express serializes a raw Uint8Array as JSON text
        return res.send(Buffer.from(imageResult.bytes));
      }
      
      console.log(`   Result: ${method3KB}KB (close but not quite)`);
    }
  } else {
    console.log(`📊 Method 3: Skipped (${kbPerPage}KB/page too aggressive for ${pageCount} pages)`);
  }
  
  // Return best result from all 3 methods
  console.log(`📦 Returning best result from all methods...`);
  
  const results = [];
  if (method1Result) results.push({ bytes: method1Result, method: 'pdf-lib' });
  if (method2Result) results.push({ bytes: method2Result, method: 'convertapi' });
  if (method3Result) results.push({ bytes: method3Result, method: 'pdf-to-images' });
  
  if (results.length === 0) {
    throw new Error("All compression methods failed");
  }
  
  const bestResult = results.reduce((best, current) => {
    return current.bytes.length < best.bytes.length ? current : best;
  });
  
  // GUARANTEE: a compressor must never return more bytes than it was given.
  // If every method produced a larger file, return the original with an honest message.
  if (bestResult.bytes.length >= originalSize) {
    const originalBytes = await fs.readFile(inputPath);
    console.log(`↩️ All methods produced larger files - returning the original (${originalSizeKB}KB)`);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed-${headerSafeName(originalFilename)}"`,
      "Content-Length": originalBytes.length,
      "X-Original-Size": originalSize,
      "X-Compressed-Size": originalBytes.length,
      "X-Compression-Method": "original",
      "X-Target-Miss": "true",
      "X-Warning-Message": `This PDF is already efficiently compressed - no method could make it smaller than ${originalSizeKB}KB without losing pages or readability. Your original file is returned unchanged. For a ${targetKB}KB target, try splitting the document and compressing each part.`,
    });
    return res.send(originalBytes);
  }

  const bestSizeKB = Math.round(bestResult.bytes.length / 1024);
  const reduction = Math.round(((originalSize - bestResult.bytes.length) / originalSize) * 100);

  console.log(`⚠️ Best: ${bestSizeKB}KB via ${bestResult.method} (-${reduction}%) - Target was ${targetKB}KB`);
  
  // Add warning message if target was unrealistic
  let warningMessage = '';
  if (kbPerPage < 3) {
    warningMessage = `This ${pageCount}-page PDF compressed to ${bestSizeKB}KB (best possible). Target of ${targetKB}KB (${kbPerPage}KB/page) would make pages unreadable. Consider splitting into multiple files or increasing target size.`;
  } else if (bestSizeKB > targetKB * 1.5) {
    warningMessage = `Compressed to ${bestSizeKB}KB (best possible while maintaining readability). For ${targetKB}KB target with ${pageCount} pages, consider removing unnecessary pages or splitting the document.`;
  }
  
  const finalHeaders = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="compressed-${headerSafeName(originalFilename)}"`,
    "Content-Length": bestResult.bytes.length,
    "X-Original-Size": originalSize,
    "X-Compressed-Size": bestResult.bytes.length,
    "X-Compression-Method": bestResult.method,
    "X-Target-Size": targetBytes,
    "X-Target-Miss": "true",
  };
  // Only set when present; res.set with undefined emits the literal string "undefined"
  if (warningMessage) finalHeaders["X-Warning-Message"] = warningMessage;
  res.set(finalHeaders);

  // Must be a Buffer: express serializes a raw Uint8Array as JSON text
  return res.send(Buffer.from(bestResult.bytes));
}

// ============================================
// HELPER: Try ConvertAPI compression (color only, limited attempts)
// ============================================
async function tryConvertAPICompression(inputPath, originalFilename, targetBytes, originalSize) {
  // Fewer quality levels for speed
  const qualityLevels = [55, 40, 25];
  
  let bestResult = null;
  let bestSize = Infinity;
  
  for (const quality of qualityLevels) {
    try {
      const fileBuffer = await fs.readFile(inputPath);
      const base64File = fileBuffer.toString('base64');

      const response = await axios.post(
        `https://v2.convertapi.com/convert/pdf/to/pdf?Secret=${CONVERTAPI_SECRET}`,
        {
          Parameters: [
            {
              Name: "File",
              FileValue: {
                Name: originalFilename,
                Data: base64File
              }
            },
            {
              Name: "ImageQuality",
              Value: quality
            },
            {
              Name: "ImageResolution",
              Value: quality > 30 ? "150" : "120"
            }
          ]
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000  // 30 second timeout
        }
      );

      if (response.data && response.data.Files && response.data.Files[0]) {
        const fileInfo = response.data.Files[0];
        let pdfBytes;
        
        if (fileInfo.FileData) {
          pdfBytes = Buffer.from(fileInfo.FileData, 'base64');
        } else if (fileInfo.Url) {
          const pdfResponse = await axios.get(fileInfo.Url, { 
            responseType: 'arraybuffer',
            timeout: 20000
          });
          pdfBytes = Buffer.from(pdfResponse.data);
        }

        if (pdfBytes) {
          const resultSizeKB = Math.round(pdfBytes.length / 1024);

          if (pdfBytes.length < bestSize) {
            bestSize = pdfBytes.length;
            bestResult = pdfBytes;
          }

          // If we hit target, return immediately
          if (pdfBytes.length <= targetBytes * 1.05) {
            return pdfBytes;
          }
        }
      }
    } catch (error) {
      // Silently continue to next quality level
    }
  }

  return bestResult;
}

// ============================================
// HELPER: Basic ConvertAPI compression
// ============================================
async function compressWithConvertAPI(req, res, inputPath, quality = 60) {
  try {
    const fileBuffer = await fs.readFile(inputPath);
    const base64File = fileBuffer.toString('base64');

    console.log(`📤 ConvertAPI compress (quality: ${quality})`);

    const response = await axios.post(
      `https://v2.convertapi.com/convert/pdf/to/pdf?Secret=${CONVERTAPI_SECRET}`,
      {
        Parameters: [
          {
            Name: "File",
            FileValue: {
              Name: req.file.originalname,
              Data: base64File
            }
          },
          {
            Name: "ImageQuality",
            Value: quality
          }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 45000
      }
    );

    if (response.data && response.data.Files && response.data.Files[0]) {
      const fileInfo = response.data.Files[0];
      let pdfBytes;
      
      if (fileInfo.FileData) {
        pdfBytes = Buffer.from(fileInfo.FileData, 'base64');
      } else if (fileInfo.Url) {
        const pdfResponse = await axios.get(fileInfo.Url, { 
          responseType: 'arraybuffer',
          timeout: 30000
        });
        pdfBytes = Buffer.from(pdfResponse.data);
      } else {
        throw new Error("No FileData or Url in ConvertAPI response");
      }

      const originalSizeKB = Math.round(req.file.size / 1024);
      const compressedSizeKB = Math.round(pdfBytes.length / 1024);
      const reduction = Math.round(((req.file.size - pdfBytes.length) / req.file.size) * 100);

      console.log(`✅ Compressed: ${originalSizeKB}KB → ${compressedSizeKB}KB (-${reduction}%)`);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="compressed-${headerSafeName(req.file.originalname)}"`,
        "Content-Length": pdfBytes.length,
        "X-Original-Size": req.file.size,
        "X-Compressed-Size": pdfBytes.length,
      });

      return res.send(pdfBytes);
    }

    throw new Error("ConvertAPI returned invalid response");
  } catch (error) {
    console.error("❌ ConvertAPI failed:", error.message);
    // Fall back to basic compression
    return await basicCompress(req, res, inputPath);
  }
}

// ============================================
// HELPER: Fallback basic compression
// ============================================
async function basicCompress(req, res, inputPath) {
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Remove metadata to reduce size
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setSubject('');
  pdfDoc.setKeywords([]);
  pdfDoc.setProducer('');
  pdfDoc.setCreator('');

  // Compress with native pdf-lib
  const compressedBytes = await pdfDoc.save({ 
    useObjectStreams: true,
    addDefaultPage: false
  });

  const originalSizeKB = Math.round(req.file.size / 1024);
  const compressedSizeKB = Math.round(compressedBytes.length / 1024);
  const reduction = Math.round(((req.file.size - compressedBytes.length) / req.file.size) * 100);

  // Rewriting an already-efficient PDF can inflate it; never return a larger file.
  if (compressedBytes.length >= req.file.size) {
    const originalBytes = pdfBytes;
    console.log(`↩️ Optimization would grow the file (${compressedSizeKB}KB > ${originalSizeKB}KB) - returning original`);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed-${headerSafeName(req.file.originalname)}"`,
      "Content-Length": originalBytes.length,
      "X-Original-Size": req.file.size,
      "X-Compressed-Size": originalBytes.length,
      "X-Compression-Method": "original",
      "X-Warning-Message": "This PDF is already efficiently compressed - optimization could not reduce it further, so your original file is returned unchanged.",
    });
    return res.send(Buffer.from(originalBytes));
  }

  console.log(`✅ Basic compressed: ${originalSizeKB}KB → ${compressedSizeKB}KB (-${reduction}%)`);

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="compressed-${headerSafeName(req.file.originalname)}"`,
    "Content-Length": compressedBytes.length,
    "X-Original-Size": req.file.size,
    "X-Compressed-Size": compressedBytes.length,
  });

  return res.send(Buffer.from(compressedBytes));
}

// ============================================
// MERGE PDFs - Native pdf-lib
// ============================================
app.post("/api/merge", upload.array("files", 20), requirePdf(), async (req, res) => {
  let inputPaths = [];
  let outputPath;

  try {
    if (!req.files || req.files.length < 2) {
      return res.status(400).json({
        error: "Need at least 2 PDFs",
        message: "Upload 2 or more PDF files to merge",
      });
    }

    inputPaths = req.files.map((f) => f.path);
    outputPath = path.join(outputDir, `merged-${Date.now()}.pdf`);

    const mergedPdf = await PDFDocument.create();

    for (const inputPath of inputPaths) {
      const pdfBytes = await fs.readFile(inputPath);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save({ useObjectStreams: true });
    await fs.writeFile(outputPath, mergedBytes);

    const mergedSizeKB = Math.round(mergedBytes.length / 1024);
    console.log(`✅ Merged ${req.files.length} PDFs → ${mergedSizeKB}KB`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="merged.pdf"',
      "Content-Length": mergedBytes.length,
    });

    res.send(Buffer.from(mergedBytes));
  } catch (error) {
    console.error("❌ Merge error:", error.message);
    res.status(500).json({
      error: "Merge failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(...inputPaths, outputPath);
  }
});

// ============================================
// SPLIT PDF - Native pdf-lib + archiver
// ============================================
app.post("/api/split", upload.single("file"), requirePdf(), async (req, res) => {
  let inputPath, outputPaths = [];
  const archiver = require('archiver');

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    const pageCount = pdfDoc.getPageCount();
    
    if (pageCount === 1) {
      return res.status(400).json({
        error: "Cannot split",
        message: "PDF has only 1 page",
      });
    }

    console.log(`📄 Splitting ${pageCount} pages...`);

    // Create individual PDF files for each page
    for (let i = 0; i < pageCount; i++) {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(pdfDoc, [i]);
      singlePagePdf.addPage(copiedPage);
      
      const singlePageBytes = await singlePagePdf.save({ useObjectStreams: true });
      const outputPath = path.join(outputDir, `page-${i + 1}-${Date.now()}.pdf`);
      
      await fs.writeFile(outputPath, singlePageBytes);
      outputPaths.push(outputPath);
    }

    console.log(`✅ Created ${pageCount} PDF files`);

    // Create ZIP archive (direct download)
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="split-pages.zip"`,
    });

    archive.pipe(res);

    // Add all PDFs to the archive
    for (let i = 0; i < outputPaths.length; i++) {
      archive.file(outputPaths[i], { name: `page-${i + 1}.pdf` });
    }

    await archive.finalize();
    console.log(`✅ Split complete: ${pageCount} pages in ZIP`);

  } catch (error) {
    console.error("❌ Split error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Split failed",
        details: error.message,
      });
    }
  } finally {
    await cleanupFiles(inputPath, ...outputPaths);
  }
});

// ============================================
// PDF TO IMAGES
// ============================================
app.post("/api/pdf-to-images", upload.single("file"), requirePdf(), async (req, res) => {
  let inputPath, outputPaths = [];
  const archiver = require('archiver');

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;

    // Get page count
    const pdfBytes = await fs.readFile(inputPath);
    const { PDFDocument } = require("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    // This endpoint returns every page as base64 JSON, which lives entirely in RAM.
    // Cap it hard; the ZIP endpoint streams from disk and handles longer documents.
    if (pageCount > 20) {
      return res.status(413).json({
        error: "Too many pages",
        message: `This PDF has ${pageCount} pages. Preview conversion supports up to 20 pages - use the ZIP download for longer documents.`,
      });
    }

    console.log(`📄 Converting ${pageCount} page(s) to images...`);

    // pdf2pic defaults to 768x512 unless given explicit dimensions, which
    // squishes pages. Derive real pixel size from the PDF page at 200 DPI.
    const dims0 = pdfDoc.getPage(0).getSize();
    const converter = fromPath(inputPath, {
      density: 200,
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
      width: Math.round((dims0.width / 72) * 200),
      height: Math.round((dims0.height / 72) * 200),
    });

    // Convert all pages
    for (let i = 1; i <= pageCount; i++) {
      const result = await converter(i, { responseType: "image" });
      
      if (!result || !result.path) {
        throw new Error(`Failed to convert page ${i}`);
      }
      
      outputPaths.push(result.path);
      console.log(`✅ Converted page ${i}/${pageCount}`);
    }

    // Return JSON with image data for frontend display
    const images = [];
    for (let i = 0; i < outputPaths.length; i++) {
      const imageBytes = await fs.readFile(outputPaths[i]);
      const base64 = imageBytes.toString('base64');
      
      images.push({
        pageNumber: i + 1,
        filename: `page-${i + 1}.png`,
        data: `data:image/png;base64,${base64}`,
        size: imageBytes.length,
      });
    }

    // Return JSON response with all images
    res.json({
      success: true,
      pageCount,
      images,
      message: `Converted ${pageCount} page(s) to images`,
    });

    console.log(`✅ PDF to Images complete: ${pageCount} images generated`);

  } catch (error) {
    console.error("❌ PDF to Images error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Conversion failed",
        details: error.message,
      });
    }
  } finally {
    // Keep files for 5 minutes for download links
    setTimeout(async () => {
      await cleanupFiles(inputPath, ...outputPaths);
    }, 5 * 60 * 1000);
  }
});

// NEW ENDPOINT: Download single image by page number
app.post("/api/pdf-to-images-download", upload.single("file"), requirePdf(), async (req, res) => {
  let inputPath, outputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const pageNumber = parseInt(req.body.pageNumber) || 1;
    inputPath = req.file.path;

    console.log(`📄 Converting page ${pageNumber} to image...`);

    const singleDoc = await PDFDocument.load(await fs.readFile(inputPath));
    const sDims = singleDoc.getPage(0).getSize();
    const converter = fromPath(inputPath, {
      density: 200,
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
      width: Math.round((sDims.width / 72) * 200),
      height: Math.round((sDims.height / 72) * 200),
    });

    const result = await converter(pageNumber, { responseType: "image" });
    
    if (!result || !result.path) {
      throw new Error(`Failed to convert page ${pageNumber}`);
    }
    
    outputPath = result.path;
    const imageBytes = await fs.readFile(outputPath);
    
    res.set({
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="page-${pageNumber}.png"`,
      "Content-Length": imageBytes.length,
    });
    
    res.send(imageBytes);
    console.log(`✅ Downloaded page ${pageNumber} as image`);

  } catch (error) {
    console.error("❌ PDF to single image error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Conversion failed",
        details: error.message,
      });
    }
  } finally {
    await cleanupFiles(inputPath, outputPath);
  }
});

// NEW ENDPOINT: Download all images as ZIP
app.post("/api/pdf-to-images-zip", upload.single("file"), requirePdf(), async (req, res) => {
  let inputPath, outputPaths = [];
  const archiver = require('archiver');

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;

    // Get page count
    const pdfBytes = await fs.readFile(inputPath);
    const { PDFDocument } = require("pdf-lib");
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pageCount = pdfDoc.getPageCount();

    if (pageCount > 60) {
      return res.status(413).json({
        error: "Too many pages",
        message: `This PDF has ${pageCount} pages. PDF to JPG supports up to 60 pages - split the PDF first for longer documents.`,
      });
    }

    console.log(`📦 Creating ZIP with ${pageCount} images...`);

    const zDims = pdfDoc.getPage(0).getSize();
    const converter = fromPath(inputPath, {
      density: 200,
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
      width: Math.round((zDims.width / 72) * 200),
      height: Math.round((zDims.height / 72) * 200),
    });

    // Convert all pages
    for (let i = 1; i <= pageCount; i++) {
      const result = await converter(i, { responseType: "image" });
      
      if (!result || !result.path) {
        throw new Error(`Failed to convert page ${i}`);
      }
      
      outputPaths.push(result.path);
    }

    // Create ZIP
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="pdf-pages.zip"`,
    });

    archive.pipe(res);

    // Add all images to archive
    for (let i = 0; i < outputPaths.length; i++) {
      archive.file(outputPaths[i], { name: `page-${i + 1}.png` });
    }

    await archive.finalize();
    console.log(`✅ ZIP download complete: ${pageCount} images`);

  } catch (error) {
    console.error("❌ PDF to ZIP error:", error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Conversion failed",
        details: error.message,
      });
    }
  } finally {
    await cleanupFiles(inputPath, ...outputPaths);
  }
});

// ============================================
// IMAGES TO PDF - Native pdf-lib + Sharp
// ============================================
app.post("/api/images-to-pdf", upload.array("files", 50), requireImages(), async (req, res) => {
  let inputPaths = [];
  let outputPath;

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No images uploaded" });
    }

    inputPaths = req.files.map((f) => f.path);
    outputPath = path.join(outputDir, `images-${Date.now()}.pdf`);

    const pdfDoc = await PDFDocument.create();

    for (const imagePath of inputPaths) {
      const imageBytes = await fs.readFile(imagePath);
      
      // Optimize image with Sharp
      const optimizedBuffer = await sharp(imageBytes)
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();

      const image = await pdfDoc.embedJpg(optimizedBuffer);
      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }

    const pdfBytes = await pdfDoc.save({ useObjectStreams: true });
    await fs.writeFile(outputPath, pdfBytes);

    const pdfSizeKB = Math.round(pdfBytes.length / 1024);
    console.log(`✅ Images → PDF: ${req.files.length} images → ${pdfSizeKB}KB`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="images.pdf"',
      "Content-Length": pdfBytes.length,
    });

    res.send(Buffer.from(pdfBytes));
  } catch (error) {
    console.error("❌ Images to PDF error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(...inputPaths, outputPath);
  }
});

// ConvertAPI quota/auth failures should read as "temporarily unavailable", not a crash.
function convertApiFriendlyError(error) {
  const status = error.response?.status;
  const apiMessage = error.response?.data?.Message || "";
  const quotaHit =
    status === 401 || status === 402 || status === 403 ||
    /credit|quota|limit|payment|subscription/i.test(apiMessage);

  if (quotaHit) {
    return {
      status: 503,
      body: {
        error: "Tool temporarily unavailable",
        message: "Document conversion is temporarily unavailable while we upgrade capacity. Compress, merge, split, and image tools all still work.",
      },
    };
  }
  return null;
}

// ============================================
// WORD TO PDF - ConvertAPI
// ============================================
app.post("/api/word-to-pdf", upload.single("file"), requireOffice(), async (req, res) => {
  let inputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!CONVERTAPI_SECRET) {
      return res.status(501).json({
        error: "Feature not configured",
        message: "Word to PDF conversion requires ConvertAPI setup.",
        setup: "Add CONVERTAPI_SECRET to environment variables"
      });
    }

    inputPath = req.file.path;
    const fileBuffer = await fs.readFile(inputPath);
    const base64File = fileBuffer.toString('base64');

    console.log(`📤 Calling ConvertAPI for Word → PDF (${req.file.originalname})`);

    // Call ConvertAPI
    const response = await axios.post(
      `https://v2.convertapi.com/convert/docx/to/pdf?Secret=${CONVERTAPI_SECRET}`,
      {
        Parameters: [
          {
            Name: "File",
            FileValue: {
              Name: req.file.originalname,
              Data: base64File
            }
          }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      }
    );

    // Log the full response for debugging
    console.log('🔍 ConvertAPI Response:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.Files && response.data.Files[0]) {
      const fileInfo = response.data.Files[0];
      
      // ConvertAPI returns FileData (base64) instead of Url
      let pdfBytes;
      
      if (fileInfo.FileData) {
        // Decode base64 data directly
        console.log('📦 Decoding FileData (base64)...');
        pdfBytes = Buffer.from(fileInfo.FileData, 'base64');
      } else if (fileInfo.Url) {
        // Fallback to URL download if available
        console.log('📥 Download URL:', fileInfo.Url);
        console.log('⬇️ Downloading converted file...');
        const pdfResponse = await axios.get(fileInfo.Url, { 
          responseType: 'arraybuffer',
          timeout: 60000
        });
        pdfBytes = Buffer.from(pdfResponse.data);
      } else {
        throw new Error(`No FileData or Url in ConvertAPI response: ${JSON.stringify(fileInfo)}`);
      }

      console.log(`✅ Word → PDF via ConvertAPI: ${Math.round(pdfBytes.length / 1024)}KB`);

      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${headerSafeName(path.basename(req.file.originalname, path.extname(req.file.originalname)))}.pdf"`,
        "Content-Length": pdfBytes.length,
      });

      res.send(pdfBytes);
    } else {
      console.error('❌ Invalid ConvertAPI response structure:', response.data);
      throw new Error("ConvertAPI returned invalid response");
    }
  } catch (error) {
    console.error("❌ Word to PDF error:", error.message);
    console.error("❌ Error details:", error.response?.data || error);
    const friendly = convertApiFriendlyError(error);
    if (friendly) {
      return res.status(friendly.status).json(friendly.body);
    }
    res.status(500).json({
      error: "Conversion failed",
      details: error.response?.data?.Message || error.message,
    });
  } finally {
    await cleanupFiles(inputPath);
  }
});

// ============================================
// PDF TO WORD - ConvertAPI
// ============================================
app.post("/api/pdf-to-word", upload.single("file"), requirePdf(), async (req, res) => {
  let inputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!CONVERTAPI_SECRET) {
      return res.status(501).json({
        error: "Feature not configured",
        message: "PDF to Word conversion requires ConvertAPI setup.",
        setup: "Add CONVERTAPI_SECRET to environment variables"
      });
    }

    inputPath = req.file.path;
    const fileBuffer = await fs.readFile(inputPath);
    const base64File = fileBuffer.toString('base64');

    console.log(`📤 Calling ConvertAPI for PDF → Word (${req.file.originalname})`);

    const response = await axios.post(
      `https://v2.convertapi.com/convert/pdf/to/docx?Secret=${CONVERTAPI_SECRET}`,
      {
        Parameters: [
          {
            Name: "File",
            FileValue: {
              Name: req.file.originalname,
              Data: base64File
            }
          }
        ]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000
      }
    );

    // Log the full response for debugging
    console.log('🔍 ConvertAPI Response:', JSON.stringify(response.data, null, 2));

    if (response.data && response.data.Files && response.data.Files[0]) {
      const fileInfo = response.data.Files[0];
      
      // ConvertAPI returns FileData (base64) instead of Url
      let docxBytes;
      
      if (fileInfo.FileData) {
        // Decode base64 data directly
        console.log('📦 Decoding FileData (base64)...');
        docxBytes = Buffer.from(fileInfo.FileData, 'base64');
      } else if (fileInfo.Url) {
        // Fallback to URL download if available
        console.log('📥 Download URL:', fileInfo.Url);
        console.log('⬇️ Downloading converted file...');
        const docxResponse = await axios.get(fileInfo.Url, { 
          responseType: 'arraybuffer',
          timeout: 60000
        });
        docxBytes = Buffer.from(docxResponse.data);
      } else {
        throw new Error(`No FileData or Url in ConvertAPI response: ${JSON.stringify(fileInfo)}`);
      }

      console.log(`✅ PDF → Word via ConvertAPI: ${Math.round(docxBytes.length / 1024)}KB`);

      res.set({
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${headerSafeName(path.basename(req.file.originalname, '.pdf'))}.docx"`,
        "Content-Length": docxBytes.length,
      });

      res.send(docxBytes);
    } else {
      console.error('❌ Invalid ConvertAPI response structure:', response.data);
      throw new Error("ConvertAPI returned invalid response");
    }
  } catch (error) {
    console.error("❌ PDF to Word error:", error.message);
    console.error("❌ Error details:", error.response?.data || error);
    const friendly = convertApiFriendlyError(error);
    if (friendly) {
      return res.status(friendly.status).json(friendly.body);
    }
    res.status(500).json({
      error: "Conversion failed",
      details: error.response?.data?.Message || error.message,
    });
  } finally {
    await cleanupFiles(inputPath);
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/api/health", (req, res) => {
  const usage = process.memoryUsage();
  
  res.json({
    status: "OK",
    version: "2.0-production",
    timestamp: new Date().toISOString(),
    memory: {
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
      rssMB: Math.round(usage.rss / 1024 / 1024),
    },
    requests: {
      active: activeRequests,
      queued: requestQueue.length,
      maxConcurrent: MAX_CONCURRENT_REQUESTS,
    },
    features: {
      compression: CONVERTAPI_SECRET ? "native pdf-lib + ConvertAPI fallback + image recompression" : "native pdf-lib + image recompression fallback",
      merge: "native pdf-lib",
      split: "native pdf-lib",
      office: CONVERTAPI_SECRET ? "ConvertAPI" : "not configured",
    },
  });
});

// ============================================
// ERROR HANDLERS
// ============================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File too large",
        message: "Max file size is 25MB. Try splitting the PDF first, then compressing each part.",
      });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// Clean URL fallback for static HTML pages and new Learn articles.
app.get("*", async (req, res, next) => {
  if (req.path.includes(".") || req.path.startsWith("/api/")) return next();
  const candidate = path.join(__dirname, "public", `${req.path}.html`);
  try {
    await fs.access(candidate);
    return res.sendFile(candidate);
  } catch (_) {
    return next();
  }
});

// ============================================
// 404 HANDLER (must be after all routes)
// ============================================
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(PORT, () => {
  console.log(`🚀 getPDFpress Production v2.0`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`💾 Max concurrent: ${MAX_CONCURRENT_REQUESTS}`);
  console.log(`🔧 ConvertAPI: ${CONVERTAPI_SECRET ? 'Configured ✅' : 'Not configured ⚠️'}`);
  console.log(`🌐 Health: http://localhost:${PORT}/api/health`);
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on("SIGTERM", () => {
  console.log("📴 SIGTERM - shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("⚠️ Forced shutdown");
    process.exit(1);
  }, 10000);
});

process.on("SIGINT", () => {
  console.log("📴 SIGINT - shutting down...");
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});
