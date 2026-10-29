// Lokalt webbgränssnitt för Local-Automation. Inga beroenden, bara Node.
// Startas med: node ui/server.mjs   (eller automatiskt via ui/install-ui.sh)
//
// All åtkomst till uppgifter går via API:t under /api. Webbsidan i ui/public
// pratar bara med det API:t, så att det senare kan bytas mot en molntjänst.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = path.join(ROOT, 'tasks');
const LOGS = path.join(ROOT, 'logs');
const WORK = path.join(ROOT, 'work');
const PUBLIC = path.join(ROOT, 'ui', 'public');
const MCP = path.join(ROOT, 'mcp');
const DATA = path.join(ROOT, 'data');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4777);
const ENV_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const RUN_RE = /^\d{4}-\d{2}-\d{2}_\d{6}$/;
const MAX_FILE = 1024 * 1024;

// ---------- uppgiftsfiler ----------

function parseTask(text) {
  const lines = text.split('\n');
  const fields = {};
  let body = text;
  if (lines[0].trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        if (/^\s*#/.test(l)) continue;
        const i = l.indexOf(':');
        if (i > 0) fields[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
      body = lines.slice(end + 1).join('\n');
    }
  }
  return { schedule: fields.schedule || '', enabled: fields.enabled === 'true', mcp: parseMcp(fields.mcp), prompt: body.trim() };
}

// "github, slack:write" -> [{ name: 'github', level: 'read' }, { name: 'slack', level: 'write' }]
function parseMcp(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => ({ name: x.split(':')[0], level: x.endsWith(':write') ? 'write' : 'read' }));
}

function serializeTask({ schedule, enabled, mcp, prompt }) {
  const mcpLine = mcp.length ? `mcp: ${mcp.map(m => m.level === 'write' ? `${m.name}:write` : m.name).join(', ')}\n` : '';
  return `---\nschedule: ${schedule}\nenabled: ${enabled ? 'true' : 'false'}\n${mcpLine}---\n${prompt.trim()}\n`;
}

// Tillgängliga MCP-servrar i mcp/ och vilka variabler i .env de behöver
async function listMcp() {
  const env = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  const isSet = v => new RegExp(`^${v}=\\S+`, 'm').test(env);
  const servers = {};
  for (const f of (await fs.readdir(MCP).catch(() => [])).sort()) {
    const m = f.match(/^([a-z0-9_-]+)\.(read|write)\.json$/);
    if (!m) continue;
    const s = servers[m[1]] ||= { name: m[1], levels: [], vars: new Set() };
    s.levels.push(m[2]);
    for (const [, v] of (await fs.readFile(path.join(MCP, f), 'utf8')).matchAll(/\$\{([A-Z0-9_]+)/g)) s.vars.add(v);
  }
  return Promise.all(Object.values(servers).map(async s => ({
    name: s.name,
    levels: s.levels,
    missing: [...s.vars].filter(v => !isSet(v)),
    // Google kräver en engångsinloggning som sparar en token i data/<namn>
    needsLogin: s.name.startsWith('google') && !(await fs.readdir(path.join(DATA, s.name)).catch(() => [])).some(f => !f.startsWith('.')),
  })));
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function isRunning(name) {
  try {
    const pid = Number((await fs.readFile(path.join(LOGS, name, '.lock', 'pid'), 'utf8')).trim());
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function listRuns(name, limit = 50) {
  let files = [];
  try { files = await fs.readdir(path.join(LOGS, name)); } catch { return []; }
  const ids = files.filter(f => f.endsWith('.log')).map(f => f.slice(0, -4)).filter(id => RUN_RE.test(id));
  ids.sort().reverse();
  const running = await isRunning(name);
  return Promise.all(ids.slice(0, limit).map(async (id, i) => {
    const log = await fs.readFile(path.join(LOGS, name, `${id}.log`), 'utf8');
    const m = log.match(/=== exit (\d+) ===\s*$/);
    return { id, start: idToIso(id), exit: m ? Number(m[1]) : null, running: i === 0 && !m && running };
  }));
}

function idToIso(id) {
  const [d, t] = id.split('_');
  return `${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

async function readTask(name) {
  const text = await fs.readFile(path.join(TASKS, `${name}.md`), 'utf8');
  const [runs, running] = await Promise.all([listRuns(name, 1), isRunning(name)]);
  return { name, ...parseTask(text), running, lastRun: runs[0] || null };
}

async function listTasks() {
  const files = (await fs.readdir(TASKS)).filter(f => f.endsWith('.md'));
  const names = files.map(f => f.slice(0, -3)).filter(n => NAME_RE.test(n)).sort();
  return Promise.all(names.map(readTask));
}

// ---------- skript ----------

function sh(args, timeout = 30_000) {
  return new Promise(resolve => {
    execFile('/bin/zsh', args, { cwd: ROOT, timeout, env: { ...process.env, PATH: ENV_PATH } },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + stderr).trim() }));
  });
}

const checkSchedule = s => sh([path.join(ROOT, 'install.sh'), '--check', s]);
const syncSchedules = () => sh([path.join(ROOT, 'install.sh')]);

async function startRun(name) {
  if (await isRunning(name)) return false;
  spawn('/bin/zsh', [path.join(ROOT, 'run.sh'), name], {
    cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, PATH: ENV_PATH },
  }).unref();
  return true;
}

// Kör docker direkt (inte via zsh) så att timeouten avslutar själva processen
function docker(args) {
  return new Promise(resolve => {
    execFile('docker', args, { timeout: 4000, killSignal: 'SIGKILL', env: { ...process.env, PATH: ENV_PATH } },
      err => resolve(!err));
  });
}

// docker kan hänga när Docker Desktop startar eller har fastnat, så anropen
// har en kort timeout och resultatet delas mellan samtidiga förfrågningar.
let dockerStatus = null;
let dockerStatusAt = 0;

function checkDocker() {
  if (!dockerStatus || Date.now() - dockerStatusAt > 10_000) {
    dockerStatusAt = Date.now();
    dockerStatus = Promise.all([
      docker(['info', '--format', '{{.ServerVersion}}']),
      docker(['image', 'inspect', 'claude-runner', '--format', '{{.Id}}']),
    ]).then(([d, i]) => ({ docker: d, image: i }));
  }
  return dockerStatus;
}

async function status() {
  const [docker, env] = await Promise.all([
    checkDocker(),
    fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => ''),
  ]);
  return { ...docker, token: /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=\S+/m.test(env) };
}

// ---------- arbetsfiler ----------

async function listFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, base, out);
    else if (e.isFile()) {
      const st = await fs.stat(full);
      out.push({ path: path.relative(base, full), size: st.size, modified: st.mtime.toISOString() });
    }
    if (out.length >= 500) break;
  }
  return out;
}

// Ger en absolut sökväg inom work/<namn>, eller null om den pekar utanför
function safeWorkPath(name, rel) {
  const base = path.join(WORK, name);
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

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

function validInput(b) {
  if (typeof b.schedule !== 'string' || !b.schedule.trim()) return 'schema saknas';
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) return 'prompt saknas';
  if (/\n/.test(b.schedule)) return 'ogiltigt schema';
  if (b.mcp != null && !Array.isArray(b.mcp)) return 'ogiltig mcp-lista';
  return null;
}

async function validMcp(list) {
  const available = await listMcp();
  for (const m of list) {
    const s = available.find(x => x.name === m?.name);
    if (!s) return `okänd MCP-server: ${m?.name}`;
    if (!['read', 'write'].includes(m.level) || !s.levels.includes(m.level)) return `${m.name} saknar nivån ${m.level}`;
  }
  return null;
}

// Byter namn på en uppgift och flyttar med dess loggar och arbetsfiler
async function renameTask(from, to) {
  if (await isRunning(from)) throw Object.assign(new Error('kan inte byta namn medan uppgiften körs'), { code: 409 });
  if (await exists(path.join(TASKS, `${to}.md`))) throw Object.assign(new Error(`uppgiften ${to} finns redan`), { code: 409 });
  for (const dir of [LOGS, WORK]) {
    if (await exists(path.join(dir, from)) && !await exists(path.join(dir, to))) {
      await fs.rename(path.join(dir, from), path.join(dir, to));
    }
  }
  await fs.rename(path.join(TASKS, `${from}.md`), path.join(TASKS, `${to}.md`));
}

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
  await fs.writeFile(path.join(TASKS, `${name}.md`), serializeTask({ schedule: body.schedule.trim(), enabled: !!body.enabled, mcp, prompt: body.prompt }));
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

const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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
    if (parts[0] === 'api') return await api(req, res, parts.slice(1), url);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    fail(res, 405, 'metoden stöds inte');
  } catch (e) {
    fail(res, e instanceof SyntaxError ? 400 : 500, e.message);
  }
}).listen(PORT, HOST, () => console.log(`Local-Automation: http://localhost:${PORT}`));
