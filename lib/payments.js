// Payments through Stripe Checkout.
//
// The buyer types the card on Stripe's own page, never on ours: card numbers
// never reach this server, the database or the logs.
//
// Keys live only in the hosting settings:
//   STRIPE_SECRET_KEY     — sk_test_... while testing, sk_live_... for real money
//   STRIPE_WEBHOOK_SECRET — whsec_..., proves that a webhook really comes from Stripe
//
// Without STRIPE_SECRET_KEY the site runs in DEMO mode: orders are confirmed
// immediately and no money is involved.

const Stripe = require('stripe');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = SECRET_KEY ? new Stripe(SECRET_KEY) : null;

const mode = !stripe ? 'demo' : SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Creates a Stripe payment page for the order and returns its address.
// The amount comes from the order that the server calculated, not from the browser.
async function createCheckout(order, siteUrl) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: order.email,
    line_items: [{
      quantity: order.qty,
      price_data: {
        currency: 'eur',
        unit_amount: order.price * 100, // Stripe counts in cents
        product_data: { name: `YoWif live in ${order.city}, ${formatDate(order.date)}`, description: order.venue },
      },
    }],
    metadata: { order_code: order.code },
    success_url: `${siteUrl}/checkout.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/checkout.html?date=${order.date}&cancelled=1`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // the payment page is valid for 30 minutes
  });
  return { url: session.url, sessionId: session.id };
}

// Asks Stripe directly whether a checkout session was paid.
// Never trust the browser saying "I paid": only Stripe's answer counts.
async function paidOrderCode(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') return null;
  return session.metadata && session.metadata.order_code;
}

// Checks the webhook signature. Throws if the request was not sent by Stripe.
function verifyWebhook(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

module.exports = { mode, createCheckout, paidOrderCode, verifyWebhook };
