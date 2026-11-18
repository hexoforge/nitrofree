const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'items.json');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

let items = [];
try {
  items = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch {
  items = [];
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Discord command names: lowercase, 1-32 chars, [a-z0-9_-]
function sanitizeName(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

const RESERVED = new Set(['nitro', 'nf']);

function typeFromMime(mime) {
  if (mime === 'image/gif') return 'gif';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

module.exports = {
  MEDIA_DIR,
  sanitizeName,
  typeFromMime,
  list: () => items.slice().sort((a, b) => a.name.localeCompare(b.name)),
  get: (name) => items.find((i) => i.name === name),
  add({ name, file, original, type, mode, size }) {
    if (!name) throw new Error('Invalid name (use a-z, 0-9, - or _)');
    if (RESERVED.has(name)) throw new Error(`"${name}" is reserved`);
    if (items.some((i) => i.name === name)) throw new Error(`"${name}" already exists`);
    const item = { name, file, original, type, mode, size, createdAt: Date.now() };
    items.push(item);
    save();
    return item;
  },
  update(name, patch) {
    const item = items.find((i) => i.name === name);
    if (!item) throw new Error('Not found');
    if (patch.mode && ['embed', 'file'].includes(patch.mode)) item.mode = patch.mode;
    if (patch.newName !== undefined) {
      const n = sanitizeName(patch.newName);
      if (!n || RESERVED.has(n)) throw new Error('Invalid name');
      if (n !== name && items.some((i) => i.name === n)) throw new Error(`"${n}" already exists`);
      item.name = n;
    }
    save();
    return item;
  },
  remove(name) {
    const idx = items.findIndex((i) => i.name === name);
    if (idx === -1) throw new Error('Not found');
    const [item] = items.splice(idx, 1);
    try {
      fs.unlinkSync(path.join(MEDIA_DIR, item.file));
    } catch {}
    save();
    return item;
  },
};
