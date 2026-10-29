// Skriver agent/status i Firestore för molnläget: vilka MCP-servrar som finns och
// vilken identitet som hittades i .env. Körs av cloud/deploy.sh på Macen.
// Användning: TOKEN=$(gcloud auth print-access-token) node cloud/write-status.mjs <projekt>
import { listMcp, detectIdentity } from '../ui/lib.mjs';

const project = process.argv[2];
const value = v => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) } };
};

// I molnet finns alla tokens som hemligheter; Google-inloggningarna laddas upp av deploy.sh
const mcp = (await listMcp()).map(s => ({ ...s, missing: s.missing, needsLogin: s.needsLogin }));
const status = {
  mode: 'cloud', docker: true, image: true, token: true, mcp,
  detected: await detectIdentity(), host: 'Cloud Run (europe-north2)',
};
const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/agent/status`;
const res = await fetch(url, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${process.env.TOKEN}`, 'x-goog-user-project': project, 'Content-Type': 'application/json' },
  body: JSON.stringify({ fields: Object.fromEntries(Object.entries(status).map(([k, v]) => [k, value(v)])) }),
});
if (!res.ok) { console.error(await res.text()); process.exit(1); }
console.log('agent/status: molnläge');
