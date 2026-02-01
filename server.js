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
// PDF COMPRESSION - Native pdf-lib
// ============================================
app.post("/api/compress", upload.single("file"), async (req, res) => {
  let inputPath, outputPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;
    outputPath = path.join(outputDir, `compressed-${Date.now()}.pdf`);

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

    await fs.writeFile(outputPath, compressedBytes);
    
    const originalSizeKB = Math.round(req.file.size / 1024);
    const compressedSizeKB = Math.round(compressedBytes.length / 1024);
    const reduction = Math.round(((req.file.size - compressedBytes.length) / req.file.size) * 100);

    console.log(`✅ Compressed: ${originalSizeKB}KB → ${compressedSizeKB}KB (-${reduction}%)`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed-${req.file.originalname}"`,
      "Content-Length": compressedBytes.length,
      "X-Original-Size": req.file.size,
      "X-Compressed-Size": compressedBytes.length,
    });

    res.send(Buffer.from(compressedBytes));
  } catch (error) {
    console.error("❌ Compress error:", error.message);
    res.status(500).json({
      error: "Compression failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(inputPath, outputPath);
  }
});

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
// SPLIT PDF - Native pdf-lib
// ============================================
app.post("/api/split", upload.single("file"), async (req, res) => {
  let inputPath, outputPaths = [];

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

    // Create ZIP would require additional library
    // For now, return first page and info
    const firstPagePdf = await PDFDocument.create();
    const [copiedPage] = await firstPagePdf.copyPages(pdfDoc, [0]);
    firstPagePdf.addPage(copiedPage);
    
    const firstPageBytes = await firstPagePdf.save({ useObjectStreams: true });

    console.log(`✅ Split PDF - returning page 1 of ${pageCount}`);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="page-1.pdf"`,
      "X-Total-Pages": pageCount,
      "X-Page-Number": 1,
    });

    res.send(Buffer.from(firstPageBytes));
  } catch (error) {
    console.error("❌ Split error:", error.message);
    res.status(500).json({
      error: "Split failed",
      details: error.message,
    });
  } finally {
    await cleanupFiles(inputPath, ...outputPaths);
  }
});

// ============================================
// PDF TO IMAGES
// ============================================
app.post("/api/pdf-to-images", upload.single("file"), async (req, res) => {
  let inputPath, outputPaths = [];

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    inputPath = req.file.path;

    const converter = fromPath(inputPath, {
      density: 150,
      saveFilename: `page-${Date.now()}`,
      savePath: outputDir,
      format: "png",
      width: 1200,
      height: 1800,
    });

    const result = await converter(1, { responseType: "image" });

    if (!result || !result.path) {
      throw new Error("Conversion failed");
    }

    outputPaths.push(result.path);
    const imageBytes = await fs.readFile(result.path);

    console.log(`✅ PDF → Image: ${result.path}`);

    res.set({
      "Content-Type": "image/png",
      "Content-Disposition": `attachment; filename="page-1.png"`,
      "Content-Length": imageBytes.length,
    });

    res.send(imageBytes);
  } catch (error) {
    console.error("❌ PDF to Images error:", error.message);
    res.status(500).json({
      error: "Conversion failed",
      details: error.message,
    });
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
      const pdfUrl = fileInfo.Url;
      
      // Validate URL before downloading
      console.log('📥 Download URL:', pdfUrl);
      console.log('📄 File info:', JSON.stringify(fileInfo, null, 2));
      
      if (!pdfUrl || typeof pdfUrl !== 'string' || !pdfUrl.startsWith('http')) {
        throw new Error(`Invalid download URL from ConvertAPI: ${JSON.stringify(fileInfo)}`);
      }
      
      // Download the converted PDF
      console.log('⬇️ Downloading converted file...');
      const pdfResponse = await axios.get(pdfUrl, { 
        responseType: 'arraybuffer',
        timeout: 60000
      });
      const pdfBytes = Buffer.from(pdfResponse.data);

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
      const docxUrl = fileInfo.Url;
      
      // Validate URL before downloading
      console.log('📥 Download URL:', docxUrl);
      console.log('📄 File info:', JSON.stringify(fileInfo, null, 2));
      
      if (!docxUrl || typeof docxUrl !== 'string' || !docxUrl.startsWith('http')) {
        throw new Error(`Invalid download URL from ConvertAPI: ${JSON.stringify(fileInfo)}`);
      }
      
      console.log('⬇️ Downloading converted file...');
      const docxResponse = await axios.get(docxUrl, { 
        responseType: 'arraybuffer',
        timeout: 60000
      });
      const docxBytes = Buffer.from(docxResponse.data);

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
