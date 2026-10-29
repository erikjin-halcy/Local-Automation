// Gemensam logik för den lokala servern (ui/server.mjs) och molnagenten
// (agent/agent.mjs): uppgiftsfiler, körningar, MCP och skripten.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS = path.join(ROOT, 'tasks');
export const LOGS = path.join(ROOT, 'logs');
export const WORK = path.join(ROOT, 'work');
export const MCP = path.join(ROOT, 'mcp');
export const DATA = path.join(ROOT, 'data');
export const ENV_PATH = `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

export const NAME_RE = /^[A-Za-z0-9_-]+$/;
export const RUN_RE = /^\d{4}-\d{2}-\d{2}_\d{6}$/;
export const MAX_FILE = 1024 * 1024;

// ---------- uppgiftsfiler ----------

export function parseTask(text) {
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
export function parseMcp(s) {
  return (s || '').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => ({ name: x.split(':')[0], level: x.endsWith(':write') ? 'write' : 'read' }));
}

export function serializeTask({ schedule, enabled, mcp, prompt }) {
  const mcpLine = mcp.length ? `mcp: ${mcp.map(m => m.level === 'write' ? `${m.name}:write` : m.name).join(', ')}\n` : '';
  return `---\nschedule: ${schedule}\nenabled: ${enabled ? 'true' : 'false'}\n${mcpLine}---\n${prompt.trim()}\n`;
}

// Tillgängliga MCP-servrar i mcp/ och vilka variabler i .env de behöver
export async function listMcp() {
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

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function isRunning(name) {
  try {
    const pid = Number((await fs.readFile(path.join(LOGS, name, '.lock', 'pid'), 'utf8')).trim());
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export async function listRuns(name, limit = 50) {
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

export function idToIso(id) {
  const [d, t] = id.split('_');
  return `${d}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

export async function readTask(name) {
  const text = await fs.readFile(path.join(TASKS, `${name}.md`), 'utf8');
  const [runs, running] = await Promise.all([listRuns(name, 1), isRunning(name)]);
  return { name, ...parseTask(text), running, lastRun: runs[0] || null };
}

export async function listTasks() {
  const files = (await fs.readdir(TASKS)).filter(f => f.endsWith('.md'));
  const names = files.map(f => f.slice(0, -3)).filter(n => NAME_RE.test(n)).sort();
  return Promise.all(names.map(readTask));
}

// ---------- skript ----------

export function sh(args, timeout = 30_000) {
  return new Promise(resolve => {
    execFile('/bin/zsh', args, { cwd: ROOT, timeout, env: { ...process.env, PATH: ENV_PATH } },
      (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + stderr).trim() }));
  });
}

export const checkSchedule = s => sh([path.join(ROOT, 'install.sh'), '--check', s]);
export const syncSchedules = () => sh([path.join(ROOT, 'install.sh')]);

export async function startRun(name) {
  if (await isRunning(name)) return false;
  spawn('/bin/zsh', [path.join(ROOT, 'run.sh'), name], {
    cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, PATH: ENV_PATH },
  }).unref();
  return true;
}

// Kör docker direkt (inte via zsh) så att timeouten avslutar själva processen
export function docker(args) {
  return new Promise(resolve => {
    execFile('docker', args, { timeout: 4000, killSignal: 'SIGKILL', env: { ...process.env, PATH: ENV_PATH } },
      err => resolve(!err));
  });
}

// docker kan hänga när Docker Desktop startar eller har fastnat, så anropen
// har en kort timeout och resultatet delas mellan samtidiga förfrågningar.
let dockerStatus = null;
let dockerStatusAt = 0;

export function checkDocker() {
  if (!dockerStatus || Date.now() - dockerStatusAt > 10_000) {
    dockerStatusAt = Date.now();
    dockerStatus = Promise.all([
      docker(['info', '--format', '{{.ServerVersion}}']),
      docker(['image', 'inspect', 'claude-runner', '--format', '{{.Id}}']),
    ]).then(([d, i]) => ({ docker: d, image: i }));
  }
  return dockerStatus;
}

export async function status() {
  const [docker, env] = await Promise.all([
    checkDocker(),
    fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => ''),
  ]);
  return { ...docker, token: /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=\S+/m.test(env) };
}

// ---------- arbetsfiler ----------

export async function listFiles(dir, base = dir, out = []) {
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
export function safeWorkPath(name, rel) {
  const base = path.join(WORK, name);
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

export function validInput(b) {
  if (typeof b.schedule !== 'string' || !b.schedule.trim()) return 'schema saknas';
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) return 'prompt saknas';
  if (/\n/.test(b.schedule)) return 'ogiltigt schema';
  if (b.mcp != null && !Array.isArray(b.mcp)) return 'ogiltig mcp-lista';
  return null;
}

export async function validMcp(list) {
  const available = await listMcp();
  for (const m of list) {
    const s = available.find(x => x.name === m?.name);
    if (!s) return `okänd MCP-server: ${m?.name}`;
    if (!['read', 'write'].includes(m.level) || !s.levels.includes(m.level)) return `${m.name} saknar nivån ${m.level}`;
  }
  return null;
}

// Byter namn på en uppgift och flyttar med dess loggar och arbetsfiler
export async function renameTask(from, to) {
  if (await isRunning(from)) throw Object.assign(new Error('kan inte byta namn medan uppgiften körs'), { code: 409 });
  if (await exists(path.join(TASKS, `${to}.md`))) throw Object.assign(new Error(`uppgiften ${to} finns redan`), { code: 409 });
  for (const dir of [LOGS, WORK]) {
    if (await exists(path.join(dir, from)) && !await exists(path.join(dir, to))) {
      await fs.rename(path.join(dir, from), path.join(dir, to));
    }
  }
  await fs.rename(path.join(TASKS, `${from}.md`), path.join(TASKS, `${to}.md`));
}

// Uppgifter hanteras i molnet när agenten är konfigurerad i .env
export async function cloudManaged() {
  const env = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  return /^FIREBASE_AGENT_EMAIL=\S+/m.test(env);
}

// ---------- profil: vem Claude arbetar åt ----------
// profile.json är källan, profile.md är texten som run.sh lägger först i varje prompt.
// Båda innehåller personuppgifter och ligger därför i .gitignore.

export const PROFILE_JSON = path.join(ROOT, 'profile.json');
export const PROFILE_MD = path.join(ROOT, 'profile.md');

export function cleanProfile(p = {}) {
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    name: str(p.name),
    emails: (Array.isArray(p.emails) ? p.emails : []).map(e => str(e)).filter(Boolean).slice(0, 10),
    slack: { id: str(p.slack?.id, 40), name: str(p.slack?.name), workspace: str(p.slack?.workspace) },
    github: str(p.github, 100),
    timezone: str(p.timezone, 60),
    notes: str(p.notes, 4000),
  };
}

export function profileText(p) {
  const lines = [];
  if (p.name) lines.push(`- Namn: ${p.name}`);
  if (p.emails.length) lines.push(`- E-post: ${p.emails.join(', ')}`);
  if (p.slack.id || p.slack.name) {
    const ws = p.slack.workspace ? ` i workspacen ${p.slack.workspace}` : '';
    const id = p.slack.id ? `, användar-ID ${p.slack.id} (omnämnanden ser ut som <@${p.slack.id}>)` : '';
    lines.push(`- Slack: ${p.slack.name || 'okänt namn'}${ws}${id}`);
  }
  if (p.github) lines.push(`- GitHub: ${p.github}`);
  if (p.timezone) lines.push(`- Tidszon: ${p.timezone}. Ange tider i den tidszonen.`);
  if (p.notes) lines.push(`- Övrigt: ${p.notes}`);
  if (!lines.length) return '';
  return `Du arbetar åt den här personen. "Jag", "mig" och "min" i uppgiften syftar på hen:\n${lines.join('\n')}\n`;
}

export async function readProfile() {
  try { return cleanProfile(JSON.parse(await fs.readFile(PROFILE_JSON, 'utf8'))); } catch { return null; }
}

export async function writeProfile(p) {
  const clean = cleanProfile(p);
  await fs.writeFile(PROFILE_JSON, JSON.stringify(clean, null, 2) + '\n');
  await fs.writeFile(PROFILE_MD, profileText(clean));
  return clean;
}

// Hämtar identiteten från de tokens som finns i .env (GitHub, Slack, Google)
let detected = null;
let detectedAt = 0;

export async function detectIdentity() {
  if (detected && Date.now() - detectedAt < 10 * 60_000) return detected;
  const text = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  const env = Object.fromEntries(text.split('\n').map(l => l.match(/^([A-Z0-9_]+)=(.+)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
  const get = async (url, token) => {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
      return await r.json();
    } catch { return {}; }
  };
  const out = { name: '', emails: [], slack: { id: '', name: '', workspace: '' }, github: '', timezone: '' };
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  for (const k of ['GOOGLE_EMAIL', 'GOOGLE_WORK_EMAIL']) if (env[k]) out.emails.push(env[k]);
  if (env.GITHUB_PAT) {
    const u = await get('https://api.github.com/user', env.GITHUB_PAT);
    if (u.login) { out.github = u.login; out.name ||= u.name || ''; }
  }
  if (env.SLACK_XOXP) {
    const a = await get('https://slack.com/api/auth.test', env.SLACK_XOXP);
    if (a.ok) {
      const u = await get(`https://slack.com/api/users.info?user=${encodeURIComponent(a.user_id)}`, env.SLACK_XOXP);
      const pr = u.user?.profile || {};
      out.slack = { id: a.user_id, name: pr.real_name || pr.display_name || a.user || '', workspace: a.team || '' };
      out.name ||= out.slack.name;
      if (pr.email && !out.emails.includes(pr.email)) out.emails.push(pr.email);
    }
  }
  detected = cleanProfile(out);
  detectedAt = Date.now();
  return detected;
}
