import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { CONFIG } from './config.js';
import { StoryStore } from './storyStore.js';
import { registerSocketHandlers } from './socketHandlers.js';
import { startTunnel } from './tunnel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA_DIR = path.join(ROOT, 'media');
const UPLOAD_DIR = path.join(MEDIA_DIR, 'uploads');
const DIST_DIR = path.join(ROOT, 'dist');
const STORY_FILE = process.env.STORY_FILE || path.join(ROOT, 'story', 'story-graph.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const store = new StoryStore(STORY_FILE);
await store.load();

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    // prefer typical home/venue LAN ranges first
    .sort((a, b) => Number(!/^192\.168\./.test(a)) - Number(!/^192\.168\./.test(b)));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

app.get('/api/story', (_req, res) => res.json(store.get()));

app.post('/api/story', async (req, res) => {
  try {
    const result = await store.save(req.body);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [String(err.message || err)], warnings: [] });
  }
});

// Event mode: `npm run event` (or --tunnel / TUNNEL=1) opens a public link for phones on mobile data.
const wantTunnel = process.argv.includes('--tunnel') || process.env.TUNNEL === '1';
let tunnel = null;

app.get('/api/network', (_req, res) => {
  res.json({
    publicUrl: CONFIG.publicUrl || tunnel?.url || null,
    tunnel: tunnel ? { status: tunnel.status, error: tunnel.error } : null,
    addresses: lanAddresses(),
    serverPort: CONFIG.port,
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
      const base =
        path
          .basename(file.originalname, path.extname(file.originalname))
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40) || 'clip';
      cb(null, `${base}-${Date.now().toString(36)}${ext}`);
    },
  }),
  limits: { fileSize: 4 * 1024 ** 3 },
  fileFilter: (_req, file, cb) => cb(null, /^video\//.test(file.mimetype)),
});

app.post('/api/upload', upload.array('files', 24), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'No video files received' });
  res.json({
    files: req.files.map((f) => ({ name: f.originalname, url: `/media/uploads/${f.filename}`, size: f.size })),
  });
});

// Custom sound cues: media/sfx/<cue>.(mp3|wav|ogg|m4a) override the generated sounds.
app.get('/api/sfx', (_req, res) => {
  const dir = path.join(MEDIA_DIR, 'sfx');
  const out = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^([a-z]+)\.(mp3|wav|ogg|m4a)$/i);
      if (m) out[m[1].toLowerCase()] = `/media/sfx/${encodeURIComponent(f)}`;
    }
  }
  res.json(out);
});

// Video files (supports HTTP range requests, needed for seeking / Safari playback)
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1h' }));

// Production: serve the built client. In dev, Vite (port 5173) serves it and proxies here.
if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(express.static(DIST_DIR));
  app.get(/^\/(?!api\/|media\/|socket\.io\/).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });
registerSocketHandlers(io, store);

server.listen(CONFIG.port, '0.0.0.0', () => {
  if (wantTunnel && !CONFIG.publicUrl) {
    if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
      console.warn('  [tunnel] no build found: run "npm run event" (builds first) so phones get the app on this port');
    }
    tunnel = startTunnel(CONFIG.port);
    console.log(`  Host screen: http://localhost:${CONFIG.port}/host   (opening public link…)`);
  }
  const ips = lanAddresses();
  console.log(`\n  SENTIENT server on :${CONFIG.port}`);
  console.log(`  story: ${path.relative(ROOT, STORY_FILE)}`);
  for (const ip of ips) console.log(`  LAN:   http://${ip}:${CONFIG.port}`);
  console.log('');
});
