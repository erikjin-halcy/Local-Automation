// Gmail-utskick för morgonmejlet. Används bara av API-tjänsten (api.mjs), som är den
// enda som har token med behörigheten gmail.send. Mottagaren bestäms av anroparen.

import fs from 'node:fs/promises';
import { marked } from 'marked';

const CREDS = '/secrets/gmail-send/creds.json';

export function toHtml(md) {
  // Rå HTML visas som text; checklistor blir rutor som syns i alla mejlprogram
  const text = md.replace(/<(?!https?:)(?=[A-Za-z/!])/g, '&lt;').replace(/^(\s*[-*] )\[ \]/gm, '$1☐').replace(/^(\s*[-*] )\[[xX]\]/gm, '$1☑');
  return '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:680px">' +
    marked.parse(text, { gfm: true, breaks: false }) + '</div>';
}

export async function sendMail(to, subject, md) {
  const c = JSON.parse(await fs.readFile(CREDS, 'utf8'));
  const tok = await fetch(c.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh_token, client_id: c.client_id, client_secret: c.client_secret }),
  }).then(r => r.json());
  if (!tok.access_token) throw new Error(`Google-token: ${tok.error_description || tok.error || 'okänt fel'}`);

  const b64 = s => Buffer.from(s, 'utf8').toString('base64');
  const part = s => b64(s).replace(/.{76}/g, '$&\r\n');
  const boundary = `la-${Date.now().toString(36)}`;
  const raw = [
    `From: Local Automation <${to}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    part(md),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    part(toHtml(md)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
  });
  if (!res.ok) throw new Error(`Gmail: ${res.status} ${(await res.json().catch(() => ({})))?.error?.message || ''}`);
}
