// Data storage with two modes:
//
//  - DATABASE_URL is set (hosting): a real PostgreSQL database (e.g. Supabase).
//    Data survives restarts and redeploys.
//  - DATABASE_URL is not set (developer's computer): plain JSON files in data/.
//    No database to install, and the developer never needs the production
//    database password.
//
// Both modes have the same functions, so server.js does not care which one runs.
// All functions are async (they return a Promise), because a real database
// answers over the network.

const fs = require('fs');
const path = require('path');

// Only these tables and columns can be written. Column names are never taken
// from user input, only from this list — that is what keeps the SQL safe.
const SCHEMA = {
  messages: ['name', 'email', 'topic', 'message'],
  subscribers: ['email'],
  orders: ['code', 'date', 'city', 'venue', 'qty', 'price', 'total', 'name', 'email', 'status', 'stripe_session'],
};

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL, email TEXT NOT NULL, topic TEXT NOT NULL, message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  code TEXT NOT NULL UNIQUE, date TEXT NOT NULL, city TEXT NOT NULL, venue TEXT NOT NULL,
  qty INTEGER NOT NULL, price INTEGER NOT NULL, total INTEGER NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL
);
-- added with Stripe payments; existing databases get the columns here
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session TEXT;`;

function checkTable(name) {
  if (!SCHEMA[name]) throw new Error('Unknown table: ' + name);
}

function checkColumns(name, cols) {
  for (const c of cols) {
    if (c !== 'id' && !SCHEMA[name].includes(c)) throw new Error('Unknown column: ' + c);
  }
}

// ---------- PostgreSQL ----------

function postgresStore(client) {
  // Dates come back from Postgres as Date objects; the admin page expects text.
  const clean = row => row && Object.assign({}, row, { created_at: new Date(row.created_at).toISOString() });

  return {
    kind: 'postgres',
    async init() {
      await client.query(CREATE_TABLES);
    },
    // A tiny real query: proves the database answers (used by /health).
    async ping() {
      await client.query('SELECT id FROM orders LIMIT 1', []);
    },
    async insert(name, row) {
      checkTable(name);
      // only the columns we got; missing ones get the database default
      const cols = SCHEMA[name].filter(c => row[c] !== undefined);
      const placeholders = cols.map((_, i) => '$' + (i + 1));
      const { rows } = await client.query(
        `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        cols.map(c => row[c])
      );
      return clean(rows[0]);
    },
    async all(name) {
      checkTable(name);
      const { rows } = await client.query(`SELECT * FROM ${name} ORDER BY id DESC`);
      return rows.map(clean);
    },
    async remove(name, id) {
      checkTable(name);
      await client.query(`DELETE FROM ${name} WHERE id = $1`, [Number(id)]);
    },
    async findOne(name, field, value) {
      checkTable(name);
      if (!SCHEMA[name].includes(field)) throw new Error('Unknown column: ' + field);
      const { rows } = await client.query(`SELECT * FROM ${name} WHERE ${field} = $1 LIMIT 1`, [value]);
      return clean(rows[0]);
    },
    // Changes `fields` only in rows matching ALL of `where`, in one step.
    // Returns the updated row, or undefined if nothing matched. Used e.g. as
    // "pending -> paid": if two confirmations arrive at once, only one wins.
    async updateWhere(name, where, fields) {
      checkTable(name);
      const setCols = Object.keys(fields), whereCols = Object.keys(where);
      checkColumns(name, setCols.concat(whereCols));
      const params = setCols.map(c => fields[c]).concat(whereCols.map(c => where[c]));
      const set = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const cond = whereCols.map((c, i) => `${c} = $${setCols.length + i + 1}`).join(' AND ');
      const { rows } = await client.query(`UPDATE ${name} SET ${set} WHERE ${cond} RETURNING *`, params);
      return clean(rows[0]);
    },
  };
}

// ---------- JSON files ----------

function jsonStore(dataDir) {
  const filePath = name => path.join(dataDir, name + '.json');

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
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath(name), JSON.stringify(rows, null, 2), 'utf8');
  }

  return {
    kind: 'json',
    async init() {},
    async ping() {}, // files on local disk: nothing to wake up
    async insert(name, row) {
      checkTable(name);
      const rows = readAll(name);
      const id = rows.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
      const record = { id, created_at: new Date().toISOString() };
      for (const c of SCHEMA[name]) if (row[c] !== undefined) record[c] = row[c];
      rows.push(record);
      writeAll(name, rows);
      return record;
    },
    async all(name) {
      checkTable(name);
      return readAll(name).sort((a, b) => b.id - a.id);
    },
    async remove(name, id) {
      checkTable(name);
      writeAll(name, readAll(name).filter(r => String(r.id) !== String(id)));
    },
    async findOne(name, field, value) {
      checkTable(name);
      return readAll(name).find(r => r[field] === value);
    },
    async updateWhere(name, where, fields) {
      checkTable(name);
      checkColumns(name, Object.keys(fields).concat(Object.keys(where)));
      const rows = readAll(name);
      const row = rows.find(r => Object.keys(where).every(c => r[c] === where[c]));
      if (!row) return undefined;
      Object.assign(row, fields);
      writeAll(name, rows);
      return row;
    },
  };
}

// ---------- pick one ----------

function createStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Hosted databases (Supabase etc.) require an encrypted connection.
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    return postgresStore(pool);
  }
  // DATA_DIR lets the tests use a temporary folder instead of the real data/
  return jsonStore(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { createStore, postgresStore, jsonStore };
