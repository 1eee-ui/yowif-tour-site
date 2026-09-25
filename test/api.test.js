// API tests: start the real server (JSON storage in a temporary folder)
// and talk to it over HTTP, like a browser would.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');

const ROOT = path.join(__dirname, '..');
const ADMIN = 'test:pass:with-colons';
const WEBHOOK_SECRET = 'whsec_test_secret';

// Starts server.js with its own port and data folder; resolves when it listens.
function startServer(port, env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yowif-api-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), ADMIN_PASSWORD: ADMIN, DATA_DIR: dataDir,
      DATABASE_URL: '', RESEND_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
    }, env),
  });
  child.log = '';
  child.stderr.on('data', d => { child.log += d; });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', d => { child.log += d; if (child.log.includes('Payments:')) resolve({ child, dataDir, url: `http://localhost:${port}` }); });
    child.on('exit', code => reject(new Error('server exited with ' + code + '\n' + child.log)));
  });
}
function stopServer(s) { s.child.removeAllListeners('exit'); s.child.kill(); fs.rmSync(s.dataDir, { recursive: true, force: true }); }

const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const basic = pass => ({ Authorization: 'Basic ' + Buffer.from('admin:' + pass).toString('base64') });
const ORDER = { date: '2026-11-13', qty: 2, name: 'Test', email: 't@example.com' };

describe('demo mode (no Stripe key)', () => {
  let s;
  before(async () => { s = await startServer(3101); });
  after(() => stopServer(s));

  test('site pages and tour are served', async () => {
    assert.equal((await fetch(s.url + '/')).status, 200);
    const tour = await (await fetch(s.url + '/api/tour')).json();
    assert.equal(tour.length, 8);
  });

  test('unknown pages give the 404 page, unknown API gives JSON 404', async () => {
    const page = await fetch(s.url + '/no-such-page');
    assert.equal(page.status, 404);
    assert.match(await page.text(), /not on the setlist/);
    assert.deepEqual(await (await fetch(s.url + '/api/nope')).json(), { ok: false, error: 'Not found.' });
  });

  test('/health answers ok', async () => {
    assert.deepEqual(await (await fetch(s.url + '/health')).json(), { status: 'ok' });
  });

  test('order is paid at once and the server calculates the price', async () => {
    const r = await (await fetch(s.url + '/api/orders', json(Object.assign({}, ORDER, { total: 1, price: 0 })))).json();
    assert.equal(r.order.status, 'paid');
    assert.equal(r.order.total, 90); // 2 x 45, the fake price is ignored
    assert.equal(r.emailSent, false); // no Resend key in tests
  });

  test('bad orders are refused', async () => {
    const post = body => fetch(s.url + '/api/orders', json(Object.assign({}, ORDER, body)));
    assert.equal((await post({ date: '2026-11-17' })).status, 409); // sold out
    assert.equal((await post({ date: '2030-01-01' })).status, 404);
    assert.equal((await post({ qty: 50 })).status, 400);
    assert.equal((await post({ qty: 1.5 })).status, 400);
    assert.equal((await post({ email: 'nope' })).status, 400);
  });

  test('contact form and newsletter validate and save', async () => {
    assert.equal((await fetch(s.url + '/api/contact', json({ name: '', email: 'x@y.z', message: 'hello' }))).status, 400);
    assert.equal((await fetch(s.url + '/api/contact', json({ name: 'A', email: 'a@b.cd', topic: 'Press', message: 'hello there' }))).status, 200);
    await fetch(s.url + '/api/subscribe', json({ email: 'same@b.cd' }));
    await fetch(s.url + '/api/subscribe', json({ email: 'same@b.cd' }));
    const subs = await (await fetch(s.url + '/api/admin/subscribers', { headers: basic(ADMIN) })).json();
    assert.equal(subs.filter(x => x.email === 'same@b.cd').length, 1);
  });

  test('admin needs the right password (even with ":" inside)', async () => {
    assert.equal((await fetch(s.url + '/admin')).status, 401);
    assert.equal((await fetch(s.url + '/api/admin/orders', { headers: basic('wrong') })).status, 401);
    assert.equal((await fetch(s.url + '/api/admin/orders', { headers: basic(ADMIN) })).status, 200);
  });

  test('payment confirmation is disabled in demo mode', async () => {
    assert.equal((await fetch(s.url + '/api/orders/confirm?session_id=cs_test_x')).status, 400);
  });
});

describe('Stripe webhook', () => {
  let s;
  const stripe = new Stripe('sk_test_for_signing_only');
  const event = JSON.stringify({
    id: 'evt_1', object: 'event', type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_abc', payment_status: 'paid', metadata: { order_code: 'YW-WEBHK1' } } },
  });
  const send = (body, signature) => fetch(s.url + '/api/stripe/webhook',
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body });
  const orderStatus = () => JSON.parse(fs.readFileSync(path.join(s.dataDir, 'orders.json'), 'utf8'))[0].status;

  before(async () => {
    // Stripe mode with a fake key: nothing here calls Stripe's servers.
    s = await startServer(3102, { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET });
    fs.writeFileSync(path.join(s.dataDir, 'orders.json'), JSON.stringify([{
      id: 1, created_at: new Date().toISOString(), code: 'YW-WEBHK1', date: '2026-11-13', city: 'Berlin', venue: 'C',
      qty: 1, price: 45, total: 45, name: 'W', email: 'w@w.com', status: 'pending', stripe_session: 'cs_test_abc',
    }]));
  });
  after(() => stopServer(s));

  test('forged or wrongly signed webhooks are rejected', async () => {
    assert.equal((await send(event, 't=1,v1=forged')).status, 400);
    assert.equal((await send(event, stripe.webhooks.generateTestHeaderString({ payload: event, secret: 'whsec_other' }))).status, 400);
    const signed = stripe.webhooks.generateTestHeaderString({ payload: event, secret: WEBHOOK_SECRET });
    assert.equal((await send(event.replace('"paid"', '"paid" '), signed)).status, 400); // body changed after signing
    assert.equal(orderStatus(), 'pending');
  });

  test('a valid webhook marks the order paid, a repeat sends no second e-mail', async () => {
    assert.equal((await send(event, stripe.webhooks.generateTestHeaderString({ payload: event, secret: WEBHOOK_SECRET }))).status, 200);
    assert.equal(orderStatus(), 'paid');
    await send(event, stripe.webhooks.generateTestHeaderString({ payload: event, secret: WEBHOOK_SECRET }));
    assert.equal((s.child.log.match(/e-mail skipped for order YW-WEBHK1/g) || []).length, 1);
  });

  test('malformed session ids are refused before asking Stripe', async () => {
    assert.equal((await fetch(s.url + '/api/orders/confirm?session_id=abc;drop')).status, 400);
  });
});

test('server refuses to start with a weak admin password', async () => {
  await assert.rejects(startServer(3103, { ADMIN_PASSWORD: 'changeme123' }), /exited with 1/);
});
