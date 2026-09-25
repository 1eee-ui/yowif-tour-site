// Storage tests. The PostgreSQL code runs against PGlite: a real Postgres
// compiled to WebAssembly, so no database server is needed on the test machine.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { postgresStore, jsonStore } = require('../lib/db');

async function newPostgres() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  // PGlite runs several statements only through exec(), pg's Pool through query()
  const client = { query: (text, params) => params ? pg.query(text, params) : pg.exec(text).then(r => r[r.length - 1]) };
  return { pg, db: postgresStore(client) };
}

const order = code => ({ code, date: '2026-11-13', city: 'Berlin', venue: 'Columbiahalle', qty: 2, price: 45, total: 90, name: 'A', email: 'a@x.com', status: 'pending' });

describe('PostgreSQL storage', () => {
  let db;
  before(async () => { ({ db } = await newPostgres()); await db.init(); });

  test('init can run on every start', async () => {
    await db.init();
  });

  test('insert returns id, ISO date and real numbers', async () => {
    const o = await db.insert('orders', order('YW-AAA001'));
    assert.equal(typeof o.id, 'number');
    assert.match(o.created_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(o.total, 90);
  });

  test('all() is newest first, remove() deletes', async () => {
    const o = await db.insert('orders', order('YW-AAA002'));
    assert.equal((await db.all('orders'))[0].code, 'YW-AAA002');
    await db.remove('orders', o.id);
    assert.equal(await db.findOne('orders', 'code', 'YW-AAA002'), undefined);
  });

  test('duplicate subscriber is refused by the database', async () => {
    await db.insert('subscribers', { email: 's@x.com' });
    await assert.rejects(db.insert('subscribers', { email: 's@x.com' }));
  });

  test('SQL injection in values is stored as plain text', async () => {
    const evil = "x'); DROP TABLE orders; --";
    await db.insert('messages', { name: evil, email: 'e@x.com', topic: 'T', message: evil });
    assert.equal((await db.all('messages'))[0].name, evil);
    assert.ok(Array.isArray(await db.all('orders')));
  });

  test('unknown table and column names are refused', async () => {
    await assert.rejects(db.all('orders; DROP TABLE orders'));
    await assert.rejects(db.findOne('subscribers', 'email = email OR 1=1 --', 'x'));
    await assert.rejects(db.updateWhere('orders', { 'code; --': 'x' }, { status: 'paid' }));
  });

  test('pending -> paid happens only once for simultaneous confirmations', async () => {
    await db.insert('orders', order('YW-RACE01'));
    const results = await Promise.all([1, 2, 3].map(() =>
      db.updateWhere('orders', { code: 'YW-RACE01', status: 'pending' }, { status: 'paid' })));
    assert.equal(results.filter(Boolean).length, 1);
  });

  test('ping() answers', async () => {
    await db.ping();
  });
});

test('old orders table (before payments) is upgraded without losing orders', async () => {
  const { pg, db } = await newPostgres();
  await pg.exec(`CREATE TABLE orders (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    code TEXT NOT NULL UNIQUE, date TEXT NOT NULL, city TEXT NOT NULL, venue TEXT NOT NULL, qty INTEGER NOT NULL,
    price INTEGER NOT NULL, total INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL);
    INSERT INTO orders (code,date,city,venue,qty,price,total,name,email) VALUES ('YW-OLD001','2026-11-13','Berlin','C',1,45,45,'O','o@o.com');`);
  await db.init();
  const old = await db.findOne('orders', 'code', 'YW-OLD001');
  assert.equal(old.status, 'paid');
});

test('ping() fails when the database is down', async () => {
  const down = postgresStore({ query: () => Promise.reject(new Error('connection refused')) });
  await assert.rejects(down.ping());
});

test('JSON storage: insert, find, update, remove', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yowif-'));
  const db = jsonStore(dir);
  const o = await db.insert('orders', order('YW-JSON01'));
  assert.equal((await db.findOne('orders', 'code', 'YW-JSON01')).id, o.id);
  assert.ok(await db.updateWhere('orders', { code: 'YW-JSON01', status: 'pending' }, { status: 'paid' }));
  assert.equal(await db.updateWhere('orders', { code: 'YW-JSON01', status: 'pending' }, { status: 'paid' }), undefined);
  await db.remove('orders', o.id);
  assert.deepEqual(await db.all('orders'), []);
  fs.rmSync(dir, { recursive: true });
});
