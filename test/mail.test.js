const { test } = require('node:test');
const assert = require('node:assert/strict');

test('without RESEND_API_KEY no e-mail is sent, and nothing crashes', async () => {
  delete process.env.RESEND_API_KEY;
  delete require.cache[require.resolve('../lib/mail')];
  const mail = require('../lib/mail');
  const sent = await mail.sendTicket({ code: 'YW-T', email: 'a@b.cd', city: 'Berlin', venue: 'C', date: '2026-11-13', qty: 1, total: 45, name: 'A' });
  assert.equal(sent, false);
});
