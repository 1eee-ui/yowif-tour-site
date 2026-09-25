// YoWif backend — a small, real, local server.
// No external services, no real payments. Data is stored in plain JSON
// files on disk (data/messages.json, data/subscribers.json) — no native
// compilation, no database server to install.
//
// What it does:
//  - serves the site (public/) as static files
//  - POST /api/contact    -> saves a contact-form message
//  - POST /api/subscribe  -> saves a newsletter e-mail
//  - GET  /api/tour       -> returns the tour dates (with prices) as JSON
//  - POST /api/orders     -> demo ticket purchase, saved to data/orders.json,
//                            ticket e-mailed via Resend if RESEND_API_KEY is set
//  - an /admin panel, protected by a password from .env, to read messages, subscribers and orders
//
// Everything here is written to be read and understood, not to be clever.

require('dotenv').config();
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./lib/db');
const mail = require('./lib/mail');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// No default password: the code is public on GitHub, so a default
// would be a password everyone knows. Refuse to start without one.
if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'changeme123' || ADMIN_PASSWORD.length < 10) {
  console.error('ADMIN_PASSWORD is missing or too weak.');
  console.error('Set a password of at least 10 characters in .env (locally) or in the hosting settings.');
  process.exit(1);
}

// ---------- tour data ----------
// In a bigger project this would live in the database too. Here a plain
// array is enough, and it is easy to read and edit by hand.
// price is in euros per ticket.
const TOUR = [
  { date: '2026-11-13', city: 'Berlin', country: 'Germany', venue: 'Columbiahalle', price: 45, soldOut: false },
  { date: '2026-11-15', city: 'Prague', country: 'Czech Republic', venue: 'Lucerna Music Bar', price: 39, soldOut: false },
  { date: '2026-11-17', city: 'Vienna', country: 'Austria', venue: 'Gasometer', price: 42, soldOut: true },
  { date: '2026-11-20', city: 'Amsterdam', country: 'Netherlands', venue: 'Melkweg', price: 44, soldOut: false },
  { date: '2026-11-22', city: 'Paris', country: 'France', venue: 'La Cigale', price: 48, soldOut: false },
  { date: '2026-11-25', city: 'Barcelona', country: 'Spain', venue: 'Razzmatazz', price: 40, soldOut: false },
  { date: '2026-11-28', city: 'Milan', country: 'Italy', venue: 'Alcatraz', price: 42, soldOut: true },
  { date: '2026-12-01', city: 'Warsaw', country: 'Poland', venue: 'Progresja', price: 35, soldOut: false },
];
const MAX_TICKETS = 6;

// ---------- app ----------
const app = express();
// On hosting (Render etc.) requests come through one proxy. Trust it, so the
// rate limiter sees each visitor's real IP instead of the proxy's.
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Basic protection against someone spamming the form or the API.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

function isValidEmail(v) {
  return typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

// ----- public API -----

app.get('/api/tour', (req, res) => {
  res.json(TOUR);
});

app.post('/api/contact', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const topic = String(req.body.topic || 'Fan message').trim();
  const message = String(req.body.message || '').trim();

  if (!name || !isValidEmail(email) || message.length < 5) {
    return res.status(400).json({ ok: false, error: 'Please fill in your name, a valid email and a message.' });
  }
  if (name.length > 200 || topic.length > 100 || message.length > 4000) {
    return res.status(400).json({ ok: false, error: 'One of the fields is too long.' });
  }

  db.insert('messages', { name, email, topic, message });
  res.json({ ok: true });
});

app.post('/api/subscribe', (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
  }
  if (!db.findOne('subscribers', 'email', email)) {
    db.insert('subscribers', { email });
  }
  res.json({ ok: true });
});

// Demo ticket purchase. No money moves: card fields never leave the browser.
// The important lesson here: the browser only says WHICH show and HOW MANY.
// Price, total and "is it sold out?" are always decided by the server,
// because anything sent from a browser can be faked.
function orderCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'YW-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/orders', async (req, res) => {
  const show = TOUR.find(t => t.date === req.body.date);
  const qty = Number(req.body.qty);
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();

  if (!show) {
    return res.status(404).json({ ok: false, error: 'This show does not exist.' });
  }
  if (show.soldOut) {
    return res.status(409).json({ ok: false, error: `Sorry, ${show.city} is sold out.` });
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_TICKETS) {
    return res.status(400).json({ ok: false, error: `You can buy from 1 to ${MAX_TICKETS} tickets.` });
  }
  if (!name || name.length > 200 || !isValidEmail(email)) {
    return res.status(400).json({ ok: false, error: 'Please fill in your name and a valid email.' });
  }

  const order = db.insert('orders', {
    code: orderCode(),
    date: show.date,
    city: show.city,
    venue: show.venue,
    qty,
    price: show.price,
    total: show.price * qty,
    name,
    email,
  });
  // The order is already saved; if the e-mail fails, the buyer still has the
  // ticket on screen and the page tells them the e-mail did not go out.
  const emailSent = await mail.sendTicket(order);
  res.json({ ok: true, order, emailSent });
});

// ----- admin panel (password-protected) -----
// This is intentionally simple HTTP Basic Auth: the browser itself asks
// for a username/password and remembers it for the session. Good enough
// for a one-person admin panel that is not on a real production server.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="YoWif admin"');
  return res.status(401).send('Authentication required.');
}

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  res.json(db.all('messages'));
});

app.get('/api/admin/subscribers', requireAdmin, (req, res) => {
  res.json(db.all('subscribers'));
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(db.all('orders'));
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  db.remove('orders', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/messages/:id', requireAdmin, (req, res) => {
  db.remove('messages', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/subscribers/:id', requireAdmin, (req, res) => {
  db.remove('subscribers', req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`YoWif server running: http://localhost:${PORT}`);
  console.log(`Admin panel:          http://localhost:${PORT}/admin`);
});
