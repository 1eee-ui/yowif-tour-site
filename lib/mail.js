// Sends the ticket e-mail through Resend (resend.com).
// The API key belongs to the site owner and is set in the hosting settings
// as RESEND_API_KEY — it is never written in the code.
// Without a key the site still works, it just does not send e-mails.

const API_KEY = process.env.RESEND_API_KEY;
// Without their own domain Resend only allows this test sender, and only
// delivers to the e-mail of the Resend account owner.
const FROM = process.env.MAIL_FROM || 'YoWif <onboarding@resend.dev>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function ticketHtml(o) {
  const row = (label, value) =>
    `<td style="padding:0 24px 0 0"><div style="font-size:11px;letter-spacing:1px;color:#444;text-transform:uppercase">${label}</div>` +
    `<div style="font-size:22px;font-weight:bold">${value}</div></td>`;
  return `<div style="background:#08080a;padding:32px;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#eeff7c;color:#0a0a0a;padding:28px">
    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase">YoWif live · European tour 2026/27</div>
    <div style="font-size:44px;font-weight:bold;text-transform:uppercase;margin:12px 0 0">${escapeHtml(o.city)}</div>
    <div style="color:#333;margin-bottom:20px">${escapeHtml(o.venue)}</div>
    <table cellpadding="0" cellspacing="0"><tr>
      ${row('Date', formatDate(o.date))}${row('Doors', '19:00')}${row('Tickets', o.qty)}${row('Paid', '€' + o.total)}
    </tr></table>
    <div style="border-top:2px dashed #0a0a0a;margin-top:24px;padding-top:16px">
      Order <b style="font-size:20px">${escapeHtml(o.code)}</b><br>
      ${escapeHtml(o.name)}
    </div>
  </div>
  <p style="max-width:560px;margin:16px auto 0;color:#8a8a8a;font-size:13px">
    Show this e-mail at the entrance. This is a demo purchase, no money was charged.
  </p>
</div>`;
}

async function sendTicket(order) {
  if (!API_KEY) {
    console.log('RESEND_API_KEY is not set, ticket e-mail skipped for order ' + order.code);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [order.email],
        subject: `Your YoWif ticket: ${order.city}, ${formatDate(order.date)} (${order.code})`,
        html: ticketHtml(order),
        text: `YoWif live in ${order.city}, ${order.venue}\nDate: ${formatDate(order.date)}, doors 19:00\n` +
              `Tickets: ${order.qty}, paid €${order.total}\nOrder: ${order.code}\n\nDemo purchase, no money was charged.`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // Log the reason (e.g. "you can only send testing emails to your own email address"),
      // but never the API key.
      console.error('Resend refused the e-mail for order ' + order.code + ':', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('Could not reach Resend for order ' + order.code + ':', e.message);
    return false;
  }
}

module.exports = { sendTicket };
