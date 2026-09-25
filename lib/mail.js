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

// E-mail HTML is old-school on purpose: tables and inline styles are what
// mail apps understand. Two tricks keep the yellow from being "darkened" by
// phone mail apps in dark mode: the color-scheme meta tags, and painting the
// yellow as a background-image gradient (Gmail does not recolor images).
const YELLOW = '#eeff7c';
const yellowBg = `background-color:${YELLOW};background-image:linear-gradient(${YELLOW},${YELLOW});`;

function ticketHtml(o) {
  const cell = (label, value) =>
    `<td width="50%" style="padding:0 12px 16px 0;vertical-align:top">` +
    `<div style="font-size:11px;letter-spacing:1px;color:#333333;text-transform:uppercase">${label}</div>` +
    `<div style="font-size:24px;font-weight:bold;color:#0a0a0a;white-space:nowrap">${value}</div></td>`;
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<style>:root{color-scheme:light only;supported-color-schemes:light only}</style>
</head>
<body style="margin:0;padding:0;background-color:#08080a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#08080a">
<tr><td style="padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;${yellowBg}">
  <tr><td style="padding:24px;color:#0a0a0a;${yellowBg}">
    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#0a0a0a">YoWif live · European tour 2026/27</div>
    <div style="font-size:34px;line-height:1.1;font-weight:bold;text-transform:uppercase;margin-top:12px;color:#0a0a0a;word-break:break-word">${escapeHtml(o.city)}</div>
    <div style="color:#333333;margin-bottom:20px">${escapeHtml(o.venue)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>${cell('Date', formatDate(o.date))}${cell('Doors', '19:00')}</tr>
      <tr>${cell('Tickets', o.qty)}${cell('Paid', '€' + o.total)}</tr>
    </table>
    <div style="border-top:2px dashed #0a0a0a;margin-top:8px;padding-top:16px;color:#0a0a0a">
      Order <b style="font-size:20px;white-space:nowrap">${escapeHtml(o.code)}</b><br>
      ${escapeHtml(o.name)}
    </div>
  </td></tr>
  </table>
  <p style="max-width:520px;margin:16px auto 0;color:#8a8a8a;font-size:13px">
    Show this e-mail at the entrance. This is a demo purchase, no money was charged.
  </p>
</td></tr>
</table>
</body></html>`;
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
