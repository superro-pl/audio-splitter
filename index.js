const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const archiver = require("archiver");
const ffmpegPath = require("ffmpeg-static");

const app = express();

// Prosty token, żeby nikt Ci nie spamował endpointu
const API_TOKEN = process.env.API_TOKEN || "";

// Multer: upload do /tmp
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 200 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (!API_TOKEN) return next(); // jeśli nie ustawisz tokenu, auth off
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== API_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/split", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });

    const segmentSeconds = Math.max(
      60,
      Math.min(3600, parseInt(req.query.segmentSeconds || "900", 10))
    );

    const inPath = req.file.path;
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "segments-"));
    const outPattern = path.join(outDir, "part_%03d.m4a");

    // Segmentacja: re-encode na AAC (stabilniej do pocięcia)
    // Uwaga: -c:a aac + bitrate sensowny do mowy, żeby segmenty były mniejsze
    const args = [
      "-i", inPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "aac",
      "-b:a", "48k",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-reset_timestamps", "1",
      outPattern
    ];

    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, args);
      let err = "";
      p.stderr.on("data", d => (err += d.toString()));
      p.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed: ${code}\n${err}`));
      });
    });

    const files = fs.readdirSync(outDir)
      .filter(f => f.startsWith("part_") && f.endsWith(".m4a"))
      .sort();

    if (!files.length) {
      return res.status(500).json({ error: "No segments produced" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="segments.zip"');

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", err => { throw err; });
    archive.pipe(res);

    for (const f of files) {
      archive.file(path.join(outDir, f), { name: f });
    }

    await archive.finalize();

    // sprzątanie (best effort)
    setTimeout(() => {
      try { fs.unlinkSync(inPath); } catch {}
      try {
        for (const f of files) fs.unlinkSync(path.join(outDir, f));
        fs.rmdirSync(outDir);
      } catch {}
    }, 5000);

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
