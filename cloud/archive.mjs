// Veckoarkivets molndel (MODE=archive, schemat la-archive måndagar 00:30). Arkiverar rapporter (files)
// och körningar (runs) i Firestore från avslutade veckor till bucketen och tar sedan bort dem, så att
// webbappen bara visar innevarande vecka även när Macen är avstängd. Macens del (sync/archive.mjs)
// arkiverar de lokala filerna och skriver pekaranteckningarna i valvet för båda delarna.
//
//   gs://<NOTES_BUCKET>/archive/<vecka>/<tid>-moln.tar.gz   filer/molnet/{files,runs}/<uppgift>/…
//   gs://<NOTES_BUCKET>/archive/<vecka>/<tid>-moln.json     manifest
//
// DRY_RUN=1 visar bara vad som skulle arkiveras. ARCHIVE_NOW=ÅÅÅÅ-MM-DD låtsas att det är en annan dag.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Storage } from '@google-cloud/storage';
import { ARCHIVE_PREFIX, isoWeek, itemDate, openTodos, period, stamp, weekStart } from './weeks.mjs';

const exec = promisify(execFile);
const BUCKET = process.env.NOTES_BUCKET;
const DRY_RUN = process.env.DRY_RUN === '1';
const TEXT_RE = /\.(md|markdown|txt|log|csv)$/i;
const log = (...a) => console.log(...a);

if (!BUCKET) { console.error('NOTES_BUCKET saknas'); process.exit(2); }
if (!getApps().length) initializeApp();
const db = getFirestore();
const bucket = new Storage().bucket(BUCKET);

// Veckorna räknas i användarens tidszon, som körningarnas id
process.env.TZ = (await db.doc('profile/me').get()).data()?.timezone || 'UTC';
const cutoff = weekStart(process.env.ARCHIVE_NOW ? new Date(process.env.ARCHIVE_NOW) : new Date());

// Uppgifter som körs just nu lämnas orörda; deras filer kan skrivas om när körningen sparar
const running = new Set((await db.collection('taskState').where('running', '==', true).get()).docs.map(d => d.id));
const items = [];
for (const d of (await db.collection('files').get()).docs) {
  const f = d.data();
  // Filer utan innehåll (binära, för stora) och sådant som inte är text, t.ex. state.json, lämnas kvar
  if (running.has(f.task) || f.content == null || !TEXT_RE.test(f.path || '')) continue;
  items.push({ ref: d.ref, updateTime: d.updateTime, path: `molnet/files/${f.task}/${f.path}`, content: f.content, date: itemDate(f.path, f.modified) });
}
for (const d of (await db.collection('runs').get()).docs) {
  const r = d.data();
  if (running.has(r.task) || r.running) continue;
  items.push({ ref: d.ref, updateTime: d.updateTime, path: `molnet/runs/${r.task}/${r.id}.log`, content: r.log || '', exit: r.exit, date: itemDate(r.id, r.start) });
}
const weeks = Object.groupBy(items.filter(i => i.date < cutoff), i => isoWeek(i.date));
if (!Object.keys(weeks).length) { log('inget att arkivera'); process.exit(0); }

for (const [week, list] of Object.entries(weeks).sort()) {
  log(`${week}: ${list.length} filer${DRY_RUN ? ' (provkörning)' : ''}`);
  if (DRY_RUN) { for (const i of list) log(`  ${i.path}`); continue; }

  const name = `${ARCHIVE_PREFIX}/${week}/${stamp()}-moln`;
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `archive-${week}-`));
  try {
    const files = [];
    for (const i of list) {
      const full = path.join(stage, 'filer', i.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, i.content);
      files.push({ path: i.path, size: Buffer.byteLength(i.content), date: i.date.toLocaleDateString('sv-SE'),
        ...(i.exit != null && { exit: i.exit }), todos: openTodos(i.path, i.content) });
    }
    const manifest = { week, period: period(weekStart(list[0].date)), createdAt: new Date().toISOString(),
      source: 'moln', object: `gs://${BUCKET}/${name}.tar.gz`, files };
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const tgz = `${stage}.tar.gz`;
    await exec('tar', ['-czf', tgz, '-C', stage, '.']);
    const local = crypto.createHash('md5').update(await fs.readFile(tgz)).digest('base64');
    await bucket.upload(tgz, { destination: `${name}.tar.gz`, validation: 'md5' });
    await bucket.file(`${name}.json`).save(JSON.stringify(manifest, null, 2), { contentType: 'application/json' });
    await fs.rm(tgz, { force: true });
    // Kontrollera uppladdningen innan något tas bort
    const [meta] = await bucket.file(`${name}.tar.gz`).getMetadata();
    if (meta.md5Hash !== local) throw new Error(`${week}: kontrollsumman stämmer inte, inget tas bort`);
    log(`  uppladdat och kontrollerat: ${manifest.object}`);

    let removed = 0, kept = 0;
    for (const i of list) {
      // Bara om dokumentet inte ändrats sedan det lästes (t.ex. en bock i webbappen)
      try { await i.ref.delete({ lastUpdateTime: i.updateTime }); removed++; }
      catch (e) { if (e.code === 9 || e.code === 5) kept++; else throw e; }  // FAILED_PRECONDITION, NOT_FOUND
    }
    log(`  ${removed} borttagna i Firestore${kept ? `, ${kept} ändrade under tiden och kvar till nästa vecka` : ''}`);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
