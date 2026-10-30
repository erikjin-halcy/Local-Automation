// Lokalt webbgränssnitt för Local-Automation. Inga beroenden, bara Node.
// Startas med: node ui/server.mjs   (eller automatiskt via ui/install-ui.sh)
//
// All åtkomst till uppgifter går via API:t under /api. Webbsidan i ui/public
// pratar antingen med det API:t eller, i molnversionen, med Firestore. När molnet
// används (FIREBASE_AGENT_EMAIL i .env) går /api här också mot Firestore, via
// cloud-backend.mjs, så att gränssnittet fungerar lokalt och inbäddat i devctl.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ROOT, TASKS, LOGS, WORK, NAME_RE, RUN_RE, MAX_FILE,
  parseTask, serializeTask, listMcp, exists, isRunning, listRuns, readTask, listTasks,
  checkSchedule, syncSchedules, startRun, status, listFiles, safeWorkPath,
  validInput, validMcp, renameTask, cloudManaged, readProfile, writeProfile, detectIdentity,
} from './lib.mjs';
// Laddas bara i molnläget (kräver .firebaserc och gcloud)
const cloud = () => import('./cloud-backend.mjs');

const PUBLIC = path.join(ROOT, 'ui', 'public');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4777);

// ---------- HTTP ----------

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

const fail = (res, code, error) => send(res, code, { error });

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error('för stor förfrågan');
  }
  return JSON.parse(raw || '{}');
}

// "- [ ] text" eller "1. [x] text": prefix, bock, avslut, text
const TODO_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[ xX](\]\s+)(.*)$/;

async function saveTask(res, name, body, isNew) {
  const err = validInput(body);
  if (err) return fail(res, 400, err);
  const check = await checkSchedule(body.schedule.trim());
  if (!check.ok) return fail(res, 400, check.out || 'ogiltigt schema');
  const mcp = (body.mcp || []).map(m => ({ name: m?.name, level: m?.level }));
  const mcpErr = await validMcp(mcp);
  if (mcpErr) return fail(res, 400, mcpErr);
  if (isNew && await exists(path.join(TASKS, `${name}.md`))) return fail(res, 409, `uppgiften ${name} finns redan`);
  if (!isNew && !await exists(path.join(TASKS, `${name}.md`))) return fail(res, 404, 'uppgiften finns inte');
  if (!isNew && body.name && body.name !== name) {
    if (!NAME_RE.test(body.name)) return fail(res, 400, 'namnet får bara innehålla A–Z, 0–9, - och _');
    try { await renameTask(name, body.name); } catch (e) { return fail(res, e.code || 500, e.message); }
    name = body.name;
  }
  await fs.writeFile(path.join(TASKS, `${name}.md`), serializeTask({ schedule: body.schedule.trim(), enabled: !!body.enabled, digest: !!body.digest, mcp, prompt: body.prompt }));
  const sync = await syncSchedules();
  send(res, isNew ? 201 : 200, { task: await readTask(name), sync: sync.out });
}

async function api(req, res, parts, url) {
  const m = req.method;

  if (parts.length === 1 && parts[0] === 'status' && m === 'GET') return send(res, 200, await status());

  if (parts.length === 1 && parts[0] === 'mcp' && m === 'GET') return send(res, 200, await listMcp());

  if (parts.length === 1 && parts[0] === 'check-schedule' && m === 'GET') {
    const r = await checkSchedule(url.searchParams.get('s') || '');
    return send(res, 200, { ok: r.ok, error: r.ok ? null : r.out });
  }

  if (parts.length === 1 && parts[0] === 'profile') {
    if (m === 'GET') return send(res, 200, { profile: await readProfile(), detected: await detectIdentity() });
    if (m === 'PUT') return send(res, 200, { profile: await writeProfile(await readJson(req)) });
  }

  if (parts[0] !== 'tasks') return fail(res, 404, 'okänd adress');

  if (parts.length === 1) {
    if (m === 'GET') return send(res, 200, await listTasks());
    if (m === 'POST') {
      const body = await readJson(req);
      if (!NAME_RE.test(body.name || '')) return fail(res, 400, 'namnet får bara innehålla A–Z, 0–9, - och _');
      return saveTask(res, body.name, body, true);
    }
  }

  const name = parts[1];
  if (!NAME_RE.test(name || '')) return fail(res, 400, 'ogiltigt namn');
  const file = path.join(TASKS, `${name}.md`);
  if (!await exists(file)) return fail(res, 404, 'uppgiften finns inte');

  if (parts.length === 2) {
    if (m === 'GET') return send(res, 200, await readTask(name));
    if (m === 'PUT') return saveTask(res, name, await readJson(req), false);
    if (m === 'DELETE') {
      await fs.unlink(file);
      const sync = await syncSchedules();
      return send(res, 200, { deleted: name, sync: sync.out });
    }
  }

  if (parts[2] === 'run' && parts.length === 3 && m === 'POST') {
    return (await startRun(name)) ? send(res, 202, { started: true }) : fail(res, 409, 'uppgiften körs redan');
  }

  if (parts[2] === 'runs' && m === 'GET') {
    if (parts.length === 3) return send(res, 200, await listRuns(name));
    if (parts.length === 4 && RUN_RE.test(parts[3])) {
      try {
        const log = await fs.readFile(path.join(LOGS, name, `${parts[3]}.log`), 'utf8');
        return send(res, 200, { id: parts[3], log });
      } catch { return fail(res, 404, 'körningen finns inte'); }
    }
  }

  // Bockar av eller i en punkt i en checklista ("- [ ] ...") i en markdown-fil
  if (parts[2] === 'files' && m === 'PATCH' && parts.length > 3) {
    const full = safeWorkPath(name, parts.slice(3).join('/'));
    if (!full || !/\.(md|markdown)$/i.test(full)) return fail(res, 400, 'ogiltig sökväg');
    const { line, checked, text } = await readJson(req);
    let content;
    try { content = await fs.readFile(full, 'utf8'); } catch { return fail(res, 404, 'filen finns inte'); }
    const lines = content.split('\n');
    const todo = Number.isInteger(line) ? TODO_RE.exec(lines[line] ?? '') : null;
    if (!todo || todo[3] !== text) return fail(res, 409, 'filen har ändrats, ladda om sidan');
    lines[line] = todo[1] + (checked ? 'x' : ' ') + todo[2] + todo[3];
    await fs.writeFile(full, lines.join('\n'));
    return send(res, 200, { line, checked: !!checked });
  }

  if (parts[2] === 'files' && m === 'GET') {
    if (parts.length === 3) return send(res, 200, await listFiles(path.join(WORK, name)));
    const full = safeWorkPath(name, parts.slice(3).join('/'));
    if (!full) return fail(res, 400, 'ogiltig sökväg');
    try {
      const st = await fs.stat(full);
      if (st.size > MAX_FILE) return fail(res, 413, 'filen är för stor för att visas');
      return send(res, 200, await fs.readFile(full, 'utf8'), 'text/plain; charset=utf-8');
    } catch { return fail(res, 404, 'filen finns inte'); }
  }

  fail(res, 405, 'metoden stöds inte');
}

const STATIC = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.resolve(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep) || !STATIC[path.extname(full)]) return fail(res, 404, 'finns inte');
  try { send(res, 200, await fs.readFile(full), STATIC[path.extname(full)]); }
  catch { fail(res, 404, 'finns inte'); }
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

http.createServer(async (req, res) => {
  try {
    // Stoppar DNS-rebinding och anrop från andra webbsidor
    if (!ALLOWED_HOSTS.has(req.headers.host)) return fail(res, 403, 'otillåten värd');
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))) return fail(res, 403, 'otillåten origin');
    if (req.method !== 'GET' && req.headers['x-local-ui'] !== '1') return fail(res, 403, 'saknar x-local-ui');

    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'api' && await cloudManaged()) {
      // Molnläget: uppgifterna finns i Firestore, se cloud-backend.mjs
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      try {
        const r = await (await cloud()).cloudApi(req.method, parts.slice(1), url, body);
        return r && '__text' in r ? send(res, 200, r.__text, 'text/plain; charset=utf-8') : send(res, 200, r);
      } catch (e) { return fail(res, Number.isInteger(e.code) ? e.code : 500, e.message); }
    }
    if (parts[0] === 'api') return await api(req, res, parts.slice(1), url);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    fail(res, 405, 'metoden stöds inte');
  } catch (e) {
    fail(res, e instanceof SyntaxError ? 400 : 500, e.message);
  }
}).listen(PORT, HOST, () => console.log(`Local-Automation: http://localhost:${PORT}`));
