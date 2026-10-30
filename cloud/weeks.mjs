// Veckor för veckoarkivet (ISO 8601, i processens tidszon). Används både av cloud/archive.mjs
// (molnet) och sync/archive.mjs (Macen), så att en fil hamnar i samma vecka oavsett var den arkiveras.

export const WEEK_RE = /^\d{4}-V\d{2}$/;
// Arkiven i bucketen: archive/<vecka>/<tid>[-moln].tar.gz med ett manifest <tid>[-moln].json bredvid
export const ARCHIVE_PREFIX = 'archive';
export const TODO_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.*)$/;
const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;

const dayOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function weekStart(d) {
  const t = dayOf(d);
  t.setDate(t.getDate() - (t.getDay() + 6) % 7);
  return t;
}

export function isoWeek(d) {
  const t = dayOf(d);
  t.setDate(t.getDate() - (t.getDay() + 6) % 7 + 3);  // veckans torsdag avgör året
  const jan4 = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t - weekStart(jan4)) / 864e5 - 3) / 7);
  return `${t.getFullYear()}-V${String(week).padStart(2, '0')}`;
}

// Datum i filnamnet (dagsplan-2026-10-30.md, 2026-10-30_070008) går före ändringstiden
export function itemDate(name, fallback) {
  const m = DATE_RE.exec(name.split('/').pop());
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(fallback);
}

export const period = start => {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.toLocaleDateString('sv-SE')}–${end.toLocaleDateString('sv-SE')}`;
};

export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

// Öppna att göra-punkter i en markdown-fil, för pekaranteckningen i valvet
export const openTodos = (file, text) => /\.(md|markdown)$/i.test(file)
  ? text.split('\n').map(l => TODO_RE.exec(l)?.[1]).filter(Boolean) : [];
