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

// ============================================
// PRODUCTION CONFIGURATION
// ============================================
const MAX_CONCURRENT_REQUESTS = 5; // Starter plan can handle 5 concurrent
const REQUEST_TIMEOUT = 45000; // 45 seconds
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

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);
app.use(express.json({ limit: '10mb' }));

// Canonical domain enforcement
app.use((req, res, next) => {
  const host = req.headers.host || '';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  
  const isWWW = host.startsWith('www.');
  const isHTTP = protocol === 'http';
  
  if (isWWW || isHTTP) {
    const canonicalHost = host.replace(/^www\./, '');
    const canonicalURL = `https://${canonicalHost}${req.originalUrl}`;
    
    console.log(`🔀 Redirect: ${protocol}://${host}${req.originalUrl} → ${canonicalURL}`);
    return res.redirect(301, canonicalURL);
  }
  
  next();
});

app.use(express.static("public"));

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
app.post("/api/compress", upload.single("file"), async (req, res) => {
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
// HELPER: Color-only compression to target
// ============================================
async function compressToTargetColorOnly(req, res, inputPath, targetBytes, originalFilename, originalSizeKB) {
  const targetKB = Math.round(targetBytes / 1024);
  
  console.log(`🎯 Attempting to compress ${originalSizeKB}KB → ${targetKB}KB (color only)`);
  
  // First, try pdf-lib compression (works for all PDFs)
  try {
    const pdfBytes = await fs.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    // Remove all metadata
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('');
    pdfDoc.setCreator('');
    pdfDoc.setCreationDate(undefined);
    pdfDoc.setModificationDate(undefined);

    // Aggressive compression with pdf-lib
    const compressedBytes = await pdfDoc.save({ 
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 50
    });

    const compressedSizeKB = Math.round(compressedBytes.length / 1024);
    console.log(`📦 pdf-lib result: ${compressedSizeKB}KB`);

    // Check if we hit target
    if (compressedBytes.length <= targetBytes * 1.05) {
      const reduction = Math.round(((req.file.size - compressedBytes.length) / req.file.size) * 100);
      console.log(`✅ Target hit! ${compressedSizeKB}KB ≤ ${targetKB}KB (-${reduction}%)`);
      
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="compressed-${originalFilename}"`,
        "Content-Length": compressedBytes.length,
        "X-Original-Size": req.file.size,
        "X-Compressed-Size": compressedBytes.length,
        "X-Compression-Method": "pdf-lib",
      });

      return res.send(Buffer.from(compressedBytes));
    }

    // If pdf-lib didn't hit target, try ConvertAPI (if available and file has images)
    if (CONVERTAPI_SECRET) {
      console.log(`📊 pdf-lib not enough, trying ConvertAPI...`);
      
      const result = await tryConvertAPICompression(inputPath, originalFilename, targetBytes, req.file.size);
      
      if (result && result.length <= targetBytes * 1.05) {
        const resultKB = Math.round(result.length / 1024);
        const reduction = Math.round(((req.file.size - result.length) / req.file.size) * 100);
        console.log(`✅ ConvertAPI hit target! ${resultKB}KB ≤ ${targetKB}KB (-${reduction}%)`);
        
        res.set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="compressed-${originalFilename}"`,
          "Content-Length": result.length,
          "X-Original-Size": req.file.size,
          "X-Compressed-Size": result.length,
          "X-Compression-Method": "convertapi",
        });

        return res.send(result);
      }
      
      // Return best result (ConvertAPI or pdf-lib, whichever is smaller)
      const bestResult = result && result.length < compressedBytes.length ? result : compressedBytes;
      const bestSizeKB = Math.round(bestResult.length / 1024);
      const reduction = Math.round(((req.file.size - bestResult.length) / req.file.size) * 100);
      
      console.log(`⚠️ Best effort: ${bestSizeKB}KB (target was ${targetKB}KB, -${reduction}%)`);
      
      // Add helpful message for user
      const message = originalSizeKB > targetKB * 3 
        ? `This PDF compressed to ${bestSizeKB}KB. For files this large, reaching ${targetKB}KB may require removing content or using lower quality settings.`
        : `Compressed to ${bestSizeKB}KB (best possible while maintaining quality and color).`;
      
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="compressed-${originalFilename}"`,
        "Content-Length": bestResult.length,
        "X-Original-Size": req.file.size,
        "X-Compressed-Size": bestResult.length,
        "X-Target-Size": targetBytes,
        "X-Target-Miss": "true",
        "X-Compression-Message": message,
      });

      return res.send(bestResult);
    }

    // No ConvertAPI, return pdf-lib result
    const reduction = Math.round(((req.file.size - compressedBytes.length) / req.file.size) * 100);
    console.log(`⚠️ Best effort (pdf-lib only): ${compressedSizeKB}KB (target was ${targetKB}KB, -${reduction}%)`);
    
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed-${originalFilename}"`,
      "Content-Length": compressedBytes.length,
      "X-Original-Size": req.file.size,
      "X-Compressed-Size": compressedBytes.length,
      "X-Target-Miss": "true",
    });

    return res.send(Buffer.from(compressedBytes));

  } catch (error) {
    console.error("❌ Compression failed:", error.message);
    throw error;
  }
}

// ============================================
// HELPER: Try ConvertAPI compression (color only)
// ============================================
async function tryConvertAPICompression(inputPath, originalFilename, targetBytes, originalSize) {
  const targetKB = Math.round(targetBytes / 1024);
  
  // Quality levels to try (color only, no grayscale)
  const qualityLevels = [60, 45, 30, 20, 15];
  
  let bestResult = null;
  let bestSize = Infinity;
  
  for (const quality of qualityLevels) {
    try {
      const fileBuffer = await fs.readFile(inputPath);
      const base64File = fileBuffer.toString('base64');

      console.log(`   🔹 Trying Q${quality}...`);

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
          timeout: 45000  // 45 second timeout per attempt
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
        }

        if (pdfBytes) {
          const resultSizeKB = Math.round(pdfBytes.length / 1024);
          console.log(`      Result: ${resultSizeKB}KB`);

          // Track best result
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
      console.error(`      ❌ Q${quality} failed:`, error.message);
      // Continue to next quality level
    }
  }

  return bestResult; // Return best result even if target not hit
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
        "Content-Disposition": `attachment; filename="compressed-${req.file.originalname}"`,
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

  console.log(`✅ Basic compressed: ${originalSizeKB}KB → ${compressedSizeKB}KB (-${reduction}%)`);

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="compressed-${req.file.originalname}"`,
    "Content-Length": compressedBytes.length,
    "X-Original-Size": req.file.size,
    "X-Compressed-Size": compressedBytes.length,
  });

  return res.send(Buffer.from(compressedBytes));
}

// ============================================
// MERGE PDFs - Native pdf-lib
// ============================================
app.post("/api/merge", upload.array("files", 20), async (req, res) => {
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
app.post("/api/split", upload.single("file"), async (req, res) => {
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
app.post("/api/pdf-to-images", upload.single("file"), async (req, res) => {
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

    console.log(`📄 Converting ${pageCount} page(s) to images...`);

    // FIXED: Remove width/height to preserve aspect ratio
    const converter = fromPath(inputPath, {
      density: 200,  // Higher DPI for better quality
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
      // No width/height = preserves original PDF page dimensions
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
app.post("/api/pdf-to-images-download", upload.single("file"), async (req, res) => {
  let inputPath, outputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const pageNumber = parseInt(req.body.pageNumber) || 1;
    inputPath = req.file.path;

    console.log(`📄 Converting page ${pageNumber} to image...`);

    const converter = fromPath(inputPath, {
      density: 200,
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
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
app.post("/api/pdf-to-images-zip", upload.single("file"), async (req, res) => {
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

    console.log(`📦 Creating ZIP with ${pageCount} images...`);

    const converter = fromPath(inputPath, {
      density: 200,
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
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
app.post("/api/images-to-pdf", upload.array("files", 50), async (req, res) => {
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

// ============================================
// WORD TO PDF - ConvertAPI
// ============================================
app.post("/api/word-to-pdf", upload.single("file"), async (req, res) => {
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
        "Content-Disposition": `attachment; filename="${path.basename(req.file.originalname, path.extname(req.file.originalname))}.pdf"`,
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
app.post("/api/pdf-to-word", upload.single("file"), async (req, res) => {
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
        "Content-Disposition": `attachment; filename="${path.basename(req.file.originalname, '.pdf')}.docx"`,
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
      compression: "native pdf-lib",
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
        message: "Max file size is 50MB",
      });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
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
