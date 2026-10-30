// Engångsinloggning mot Google med minsta möjliga behörigheter. Körs på Macen
// eftersom Google skickar tillbaka webbläsaren till http://127.0.0.1.
//   node mcp/google-login.mjs          privat konto: läsa Gmail och kalendern   -> data/google
//   node mcp/google-login.mjs work     jobbkonto: läsa Gmail, ändra kalendern  -> data/google-work
//   node mcp/google-login.mjs send     privat konto: bara skicka (morgonmejlet) -> data/gmail-send
// Filen får samma format som workspace-mcp använder. Har den gamla token fler
// behörigheter än de nya återkallas den först.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const G = 'https://www.googleapis.com/auth/';
const BASE = [`${G}userinfo.email`, `${G}userinfo.profile`, 'openid'];
const PROFILES = {
  google: { emailVar: 'GOOGLE_EMAIL', dir: 'google', scopes: [...BASE, `${G}gmail.readonly`, `${G}calendar.readonly`] },
  work: {
    emailVar: 'GOOGLE_WORK_EMAIL', dir: 'google-work',
    scopes: [...BASE, `${G}gmail.readonly`, `${G}calendar.readonly`, `${G}calendar`, `${G}calendar.events`],
  },
  send: { emailVar: 'GOOGLE_EMAIL', dir: 'gmail-send', scopes: [`${G}userinfo.email`, 'openid', `${G}gmail.send`] },
};

const profile = PROFILES[process.argv[2] || 'google'];
if (!profile) { console.error('Användning: node mcp/google-login.mjs [work|send]'); process.exit(1); }

const env = Object.fromEntries((await fs.readFile(path.join(ROOT, '.env'), 'utf8')).split('\n')
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const clientId = env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET, email = env[profile.emailVar];
for (const [k, v] of [['GOOGLE_OAUTH_CLIENT_ID', clientId], ['GOOGLE_OAUTH_CLIENT_SECRET', clientSecret], [profile.emailVar, email]]) {
  if (!v) { console.error(`Fyll i ${k} i .env först`); process.exit(1); }
}
const dir = path.join(ROOT, 'data', profile.dir);
const file = path.join(dir, `${email}.json`);

// Återkalla en gammal token som har fler behörigheter än vi nu ber om
const old = await fs.readFile(file, 'utf8').then(JSON.parse, () => null);
const extra = (old?.scopes || []).filter(s => !profile.scopes.includes(s));
if (old?.refresh_token && extra.length) {
  const r = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: old.refresh_token }),
  });
  console.log(`Återkallade den gamla token (${extra.length} behörigheter för mycket): ${r.ok ? 'ok' : `svar ${r.status}`}`);
}

// Inloggning med PKCE via en tillfällig server på 127.0.0.1
const verifier = crypto.randomBytes(32).toString('base64url');
const state = crypto.randomBytes(16).toString('hex');
const { code, redirect } = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(ok ? '<p>Klart, du kan stänga fliken.</p>' : `<p>Inloggningen misslyckades: ${u.searchParams.get('error') || 'fel state'}</p>`);
    server.close();
    ok ? resolve({ code: u.searchParams.get('code'), redirect }) : reject(new Error(u.searchParams.get('error') || 'fel state'));
  });
  let redirect;
  server.listen(0, '127.0.0.1', () => {
    redirect = `http://127.0.0.1:${server.address().port}/`;
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: profile.scopes.join(' '),
      access_type: 'offline', prompt: 'consent', login_hint: email, state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    console.log(`Logga in som ${email} i webbläsaren som öppnas. Länken om den inte öppnas:\n${url}\n`);
    execFile('open', [url], () => {});
  });
  setTimeout(() => { server.close(); reject(new Error('ingen inloggning inom 5 minuter')); }, 300_000).unref();
});

const tok = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret, code_verifier: verifier }),
}).then(r => r.json());
if (!tok.refresh_token) { console.error(`Fick ingen token: ${tok.error_description || tok.error || 'okänt fel'}`); process.exit(1); }

// Rätt konto och inga fler behörigheter än vi bad om
const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tok.id_token}`).then(r => r.json());
if ((info.email || '').toLowerCase() !== email.toLowerCase()) {
  console.error(`Fel konto: inloggad som ${info.email}, förväntade ${email}. Inget sparades.`);
  process.exit(1);
}
const granted = tok.scope.split(' ');
const tooMuch = granted.filter(s => !profile.scopes.includes(s));
if (tooMuch.length) {
  console.error(`Google gav fler behörigheter än begärt (${tooMuch.join(', ')}). Inget sparades. ` +
    'Ta bort appens åtkomst på https://myaccount.google.com/permissions och kör igen.');
  process.exit(1);
}

await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const expiry = new Date(Date.now() + tok.expires_in * 1000).toISOString().slice(0, 19);
await fs.writeFile(file, JSON.stringify({
  token: tok.access_token, refresh_token: tok.refresh_token, token_uri: 'https://oauth2.googleapis.com/token',
  client_id: clientId, client_secret: clientSecret, scopes: granted, expiry,
}, null, 2), { mode: 0o600 });
console.log(`Sparat i data/${profile.dir}/${email}.json med behörigheterna:\n  ${granted.map(s => s.replace(G, '')).join('\n  ')}`);
