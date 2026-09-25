// YoWif backend — a small, real server. No real payments.
// Storage (see lib/db.js): PostgreSQL when DATABASE_URL is set (hosting),
// otherwise plain JSON files in data/ (developer's computer).
//
// What it does:
//  - serves the site (public/) as static files
//  - POST /api/contact    -> saves a contact-form message
//  - POST /api/subscribe  -> saves a newsletter e-mail
//  - GET  /api/tour       -> returns the tour dates (with prices) as JSON
//  - POST /api/orders     -> ticket purchase: payment on Stripe's page (lib/payments.js),
//                            or instant demo order without STRIPE_SECRET_KEY;
//                            ticket e-mailed via Resend if RESEND_API_KEY is set
//  - POST /api/stripe/webhook, GET /api/orders/confirm -> payment confirmation
//  - an /admin panel, protected by a password from .env, to read messages, subscribers and orders
//
// Everything here is written to be read and understood, not to be clever.

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('./lib/db').createStore();
const mail = require('./lib/mail');
const payments = require('./lib/payments');

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

// Express 4 does not catch errors thrown inside async handlers. This wrapper
// does, so a database problem returns a clear error instead of a hung request.
const handle = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Stripe webhook: Stripe calls this address when a payment is completed.
// It must get the body exactly as sent (raw), because the signature check
// is done over those exact bytes — so it is registered BEFORE express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handle(async (req, res) => {
  let event;
  try {
    event = payments.verifyWebhook(req.body, req.headers['stripe-signature']);
  } catch (e) {
    console.error('Rejected webhook:', e.message);
    return res.status(400).send('Invalid signature');
  }
  if (event.type === 'checkout.session.completed' && event.data.object.payment_status === 'paid') {
    const code = event.data.object.metadata && event.data.object.metadata.order_code;
    if (code) await fulfillOrder(code);
  }
  res.json({ received: true });
}));

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

app.post('/api/contact', handle(async (req, res) => {
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

  await db.insert('messages', { name, email, topic, message });
  res.json({ ok: true });
}));

app.post('/api/subscribe', handle(async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!isValidEmail(email) || email.length > 200) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
  }
  if (!(await db.findOne('subscribers', 'email', email))) {
    await db.insert('subscribers', { email });
  }
  res.json({ ok: true });
}));

// Ticket purchase.
// The browser only says WHICH show and HOW MANY. Price, total and
// "is it sold out?" are always decided by the server, because anything
// sent from a browser can be faked.
//
// With Stripe: order is saved as "pending" -> buyer pays on Stripe's page ->
// the order becomes "paid" (confirmed by Stripe) -> ticket e-mail is sent.
// Without Stripe (demo mode): the order is "paid" at once, no money involved.
function orderCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'YW-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/orders', handle(async (req, res) => {
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
  if (!name || name.length > 200 || !isValidEmail(email) || email.length > 200) {
    return res.status(400).json({ ok: false, error: 'Please fill in your name and a valid email.' });
  }

  const order = await db.insert('orders', {
    code: orderCode(),
    date: show.date,
    city: show.city,
    venue: show.venue,
    qty,
    price: show.price,
    total: show.price * qty,
    name,
    email,
    status: 'pending',
  });

  if (payments.mode === 'demo') {
    return res.json(Object.assign({ ok: true }, await fulfillOrder(order.code)));
  }

  try {
    const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
    const checkout = await payments.createCheckout(order, siteUrl);
    await db.updateWhere('orders', { code: order.code }, { stripe_session: checkout.sessionId });
    res.json({ ok: true, redirect: checkout.url });
  } catch (e) {
    console.error('Stripe could not create a payment for order ' + order.code + ':', e.message);
    await db.updateWhere('orders', { code: order.code }, { status: 'failed' });
    res.status(502).json({ ok: false, error: 'Payment is not available right now. Please try again later.' });
  }
}));

// Marks an order as paid and sends the ticket e-mail — exactly once.
// Both the webhook and the buyer's return to the site call this; whichever
// comes first switches "pending" to "paid", the other one changes nothing.
async function fulfillOrder(code) {
  const justPaid = await db.updateWhere('orders', { code, status: 'pending' }, { status: 'paid' });
  if (justPaid) {
    const emailSent = await mail.sendTicket(justPaid);
    return { order: justPaid, emailSent };
  }
  return { order: await db.findOne('orders', 'code', code), emailSent: null };
}

// The buyer comes back from Stripe with ?session_id=... We ask Stripe
// ourselves whether that payment really went through.
app.get('/api/orders/confirm', handle(async (req, res) => {
  const sessionId = String(req.query.session_id || '');
  if (payments.mode === 'demo' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Unknown payment.' });
  }
  const code = await payments.paidOrderCode(sessionId);
  if (!code) {
    return res.status(402).json({ ok: false, error: 'The payment has not been completed.' });
  }
  const result = await fulfillOrder(code);
  if (!result.order || result.order.stripe_session !== sessionId) {
    return res.status(404).json({ ok: false, error: 'Order not found.' });
  }
  res.json(Object.assign({ ok: true }, result));
}));

app.get('/api/payment-mode', (req, res) => {
  res.json({ mode: payments.mode });
});

// ----- admin panel (password-protected) -----
// This is intentionally simple HTTP Basic Auth: the browser itself asks
// for a username/password and remembers it for the session. Good enough
// for a one-person admin panel.
function samePassword(given) {
  // Compare in constant time, so the answer time does not leak how many
  // characters were right.
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    // "user:password" — the password itself may contain ":" too
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (samePassword(pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="YoWif admin"');
  return res.status(401).send('Authentication required.');
}

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

for (const table of ['messages', 'subscribers', 'orders']) {
  app.get(`/api/admin/${table}`, requireAdmin, handle(async (req, res) => {
    res.json(await db.all(table));
  }));
  app.delete(`/api/admin/${table}/:id`, requireAdmin, handle(async (req, res) => {
    await db.remove(table, req.params.id);
    res.json({ ok: true });
  }));
}

// ----- errors -----
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Not found.' });
});
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});
app.use((err, req, res, next) => {
  console.error('Server error on ' + req.method + ' ' + req.path + ':', err.message);
  res.status(500).json({ ok: false, error: 'Something went wrong on our side. Please try again.' });
});

// ----- start -----
// Prepare the storage first (create tables if needed), then accept visitors.
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`YoWif server running: http://localhost:${PORT}`);
      console.log(`Admin panel:          http://localhost:${PORT}/admin`);
      console.log(`Storage:              ${db.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'JSON files in data/'}`);
      console.log(`Payments:             ${{ demo: 'DEMO (no STRIPE_SECRET_KEY, no money)', test: 'Stripe TEST mode', live: 'Stripe LIVE mode (real money)' }[payments.mode]}`);
    });
  })
  .catch(err => {
    console.error('Could not connect to the database:', err.message);
    // Show where we tried to connect (never the password), to make
    // a wrong DATABASE_URL easy to spot in the hosting logs.
    try {
      const u = new URL(process.env.DATABASE_URL);
      console.error(`Tried: user "${decodeURIComponent(u.username)}" at ${u.hostname}:${u.port || 5432}${u.pathname}` +
        ` (password length ${decodeURIComponent(u.password).length})`);
    } catch (e) {
      console.error('DATABASE_URL is not a valid URL. It should look like postgresql://user:password@host:5432/postgres');
    }
    process.exit(1);
  });
