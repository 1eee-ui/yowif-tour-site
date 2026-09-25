// A tiny file-based "database". No native compilation, no external
// database server — just two JSON files on disk. Good enough for a
// single-person local project; a real production app with many users
// at once would use a proper database instead.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function readAll(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw.trim() ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Could not read ' + p + ':', e.message);
    return [];
  }
}

function writeAll(name, rows) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(rows, null, 2), 'utf8');
}

function nextId(rows) {
  return rows.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
}

function insert(name, row) {
  const rows = readAll(name);
  const record = Object.assign({ id: nextId(rows), created_at: new Date().toISOString() }, row);
  rows.push(record);
  writeAll(name, rows);
  return record;
}

function all(name) {
  // newest first
  return readAll(name).slice().sort((a, b) => b.id - a.id);
}

function remove(name, id) {
  const rows = readAll(name).filter(r => String(r.id) !== String(id));
  writeAll(name, rows);
}

function findOne(name, field, value) {
  return readAll(name).find(r => r[field] === value);
}

module.exports = { insert, all, remove, findOne };
