const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const bot = require('./bot');

const PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = Number(process.env.PORT) || 3000;
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('nf:' + PASSWORD).digest('hex');

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const safeEq = (a, b) => {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};

function makeToken() {
  const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  return !!sig && safeEq(sig, sign(exp)) && Number(exp) > Date.now();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: store.MEDIA_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!store.typeFromMime(file.mimetype)),
});

function start() {
  if (!PASSWORD) throw new Error('ADMIN_PASSWORD must be set');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // login (unauthenticated)
  app.post('/api/login', (req, res) => {
    if (typeof req.body.password === 'string' && safeEq(sign(req.body.password), sign(PASSWORD))) {
      res.cookie('nf', makeToken(), { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 3600 * 1000 });
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Wrong password' });
  });
  app.post('/api/logout', (req, res) => {
    res.clearCookie('nf');
    res.json({ ok: true });
  });
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));

  // everything below requires auth
  app.use((req, res, next) => {
    if (validToken(req.cookies.nf)) return next();
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return res.status(401).json({ error: 'Unauthorized' });
    res.redirect('/login');
  });

  app.use('/media', express.static(store.MEDIA_DIR));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/items', (req, res) => res.json({ items: store.list(), status: bot.status }));

  app.post('/api/items', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: `Unsupported file (png/jpg/webp/gif/mp4/webm/mov, max ${MAX_MB}MB)` });
    try {
      const base = req.body.name || path.parse(req.file.originalname).name;
      const item = store.add({
        name: store.sanitizeName(base),
        file: req.file.filename,
        original: req.file.originalname,
        type: store.typeFromMime(req.file.mimetype),
        mode: req.body.mode === 'file' ? 'file' : 'embed',
        size: req.file.size,
      });
      await bot.syncCommands().catch(() => {});
      res.json({ item });
    } catch (e) {
      require('fs').unlink(req.file.path, () => {});
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/items/:name', async (req, res) => {
    try {
      const item = store.update(req.params.name, req.body);
      await bot.syncCommands().catch(() => {});
      res.json({ item });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/items/:name', async (req, res) => {
    try {
      store.remove(req.params.name);
      await bot.syncCommands().catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  app.post('/api/sync', async (req, res) => {
    try {
      await bot.syncCommands();
      res.json({ ok: true, status: bot.status });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.use((err, req, res, next) => res.status(400).json({ error: err.message }));

  app.listen(PORT, () => console.log(`Web UI on :${PORT}`));
}

module.exports = { start };
