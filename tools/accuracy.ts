import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accuracyStats, quantile, statsByRange, type AccuracyFrame, type AccuracyStats } from '../src/core/accuracy';
import type { Vec3 } from '../src/core/types';

/**
 * Accuracy report for FTX recordings. The observer appends one "point" line per recorded point to
 * .local/reports/accuracy.jsonl, plus an "undo" line naming a point's id when that point is withdrawn, and
 * the viewer one "check" line per tap to viewercheck.jsonl next to it; this prints per-point and overall
 * error tables for one recording session (the latest by default).
 *
 *   npm run accuracy -- [file] [--all] [--session <id>]
 */

const USAGE = 'usage: npm run accuracy -- [accuracy.jsonl] [--all] [--session <id>]';

/** Upper edges of the by-range table, metres. */
export const RANGE_EDGES = [2, 3, 4, 5, 6, Infinity];

export interface ReportOptions {
  /** Every session instead of only the latest. */
  all?: boolean;
  /** One session by its id (the ISO time it started); applies to both files. */
  session?: string;
  /** Lines of viewercheck.jsonl, when that file exists. */
  checkLines?: string[];
}

interface PointRecord {
  session: string;
  label: string;
  setup: string; // one-line description of source, field of view, marker sizes and DATUM
  frames: AccuracyFrame[];
}

interface CheckRecord {
  session: string;
  kind: string;
  err2d: number;
}

// ---- parsing ----------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isVec3 = (x: unknown): x is Vec3 => Array.isArray(x) && x.length === 3 && x.every(isNum);
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);

/** JSON objects of the given event, plus how many lines were not JSON objects at all. Other events are ignored. */
function parseEvents(lines: string[], event: string): { objs: Obj[]; bad: number } {
  const objs: Obj[] = [];
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      bad++;
      continue;
    }
    if (!isObj(o)) bad++;
    else if (o.event === event) objs.push(o);
  }
  return { objs, bad };
}

/** A frame needs est, truth (its own or the record's), range and sigma; anything else drops it. */
function parseFrame(f: unknown, truth: Vec3 | null): AccuracyFrame | null {
  if (!isObj(f)) return null;
  const t = isVec3(f.truth) ? f.truth : truth;
  if (!isVec3(f.est) || !t || !isNum(f.range) || !isNum(f.sigma)) return null;
  return { est: f.est, truth: t, sigma: f.sigma, range: f.range, floor: isVec3(f.floor) ? f.floor : null };
}

function describeSetup(o: Obj): string {
  const parts = [`source ${typeof o.source === 'string' ? o.source : '?'}`];
  if (isNum(o.hfov)) parts.push(`hfov ${o.hfov.toFixed(1)} deg`);
  const s = isObj(o.sizes) ? o.sizes : {};
  if (isNum(s.origin) || isNum(s.target)) parts.push(`markers origin ${cm(s.origin)} / target ${cm(s.target)} cm`);
  const d = isObj(o.datum) ? o.datum : null;
  if (d?.locked === false) parts.push('DATUM not locked');
  else if (d) {
    const angle = isNum(d.angleSigma) ? `, ${((d.angleSigma * 180) / Math.PI).toFixed(2)} deg` : '';
    parts.push(`DATUM ${isNum(d.frames) ? d.frames : '?'} frames, sigma ${cm(d.sigma)} cm${angle}`);
  }
  return parts.join(', ');
}

function parsePoints(lines: string[]): { records: PointRecord[]; badLines: number; badFrames: number } {
  const { objs, bad } = parseEvents(lines, 'point');
  // An undo line names the withdrawn point by its id, so it counts wherever it lands in the file.
  const undone = new Set(parseEvents(lines, 'undo').objs.map((o) => o.id));
  const records: PointRecord[] = [];
  let badLines = bad;
  let badFrames = 0;
  for (const o of objs) {
    if (typeof o.session !== 'string' || !Array.isArray(o.frames)) {
      badLines++;
      continue;
    }
    if (typeof o.id === 'string' && undone.has(o.id)) continue;
    const truth = isVec3(o.truth) ? o.truth : null;
    const frames: AccuracyFrame[] = [];
    for (const raw of o.frames) {
      const f = parseFrame(raw, truth);
      if (f) frames.push(f);
      else badFrames++;
    }
    records.push({ session: o.session, label: typeof o.label === 'string' ? o.label : '?', setup: describeSetup(o), frames });
  }
  return { records, badLines, badFrames };
}

function parseChecks(lines: string[]): { records: CheckRecord[]; badLines: number } {
  const { objs, bad } = parseEvents(lines, 'check');
  const records: CheckRecord[] = [];
  let badLines = bad;
  for (const o of objs) {
    const err2d = isNum(o.err2d) ? o.err2d : isNum(o.dx) && isNum(o.dz) ? Math.hypot(o.dx, o.dz) : NaN;
    if (typeof o.session !== 'string' || !Number.isFinite(err2d)) {
      badLines++;
      continue;
    }
    records.push({ session: o.session, kind: typeof o.kind === 'string' ? o.kind : '?', err2d });
  }
  return { records, badLines };
}

// ---- sessions ---------------------------------------------------------------------------------

/**
 * Session ids oldest first. They are the ISO times the sessions started, so they sort by time; if any id is
 * not a date, file order is kept instead.
 */
function sessionIds(records: { session: string }[]): string[] {
  const ids = [...new Set(records.map((r) => r.session))];
  return ids.every((id) => Number.isFinite(Date.parse(id))) ? ids.sort((a, b) => Date.parse(a) - Date.parse(b)) : ids;
}

/** The sessions to print under the options, or a line explaining why there are none. */
function chooseSessions(ids: string[], opts: ReportOptions, what: string): string[] | string {
  if (!ids.length) return `No ${what} in the file.`;
  if (opts.session !== undefined) {
    return ids.includes(opts.session) ? [opts.session] : `No ${what} for session ${opts.session}. Sessions: ${ids.join(', ')}`;
  }
  return opts.all ? ids : [ids[ids.length - 1]];
}

// ---- formatting -------------------------------------------------------------------------------

/** Metres as centimetres with one decimal; '-' for anything not a finite number. */
function cm(m: unknown): string {
  if (!isNum(m)) return '-';
  const s = (m * 100).toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

const ratio = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '-');
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const rangeLabel = (from: number, to: number): string => (Number.isFinite(to) ? `${from}-${to}` : `${from}+`);

/** Plain-text table: first column left-aligned, the others right-aligned, two spaces between columns. */
function table(head: string[], rows: string[][]): string {
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === 0 ? c.padEnd(width[i]) : c.padStart(width[i])))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

function statsRow(name: string, s: AccuracyStats): string[] {
  const bias = `${cm(s.bias[0])}, ${cm(s.bias[1])}, ${cm(s.bias[2])}`;
  return [name, String(s.n), cm(s.cep50), cm(s.cep95), cm(s.rms2d), cm(s.rms3d), cm(s.max2d), bias, ratio(s.sigmaRatio)];
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

function formatSession(id: string, records: PointRecord[]): string {
  const out: string[] = [`== Session ${id} ==`];
  const setups = [...new Set(records.map((r) => r.setup))];
  out.push(setups[0] + (setups.length > 1 ? ' (settings changed during the session)' : ''));

  // Points in the order they were first recorded; a label recorded twice is merged.
  const byLabel = new Map<string, AccuracyFrame[]>();
  for (const r of records) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), ...r.frames]);
  const all = records.flatMap((r) => r.frames);
  out.push(`${plural(byLabel.size, 'point')}, ${plural(all.length, 'frame')}`, '');

  const pointRows = [...byLabel].map(([label, frames]) => {
    const s = accuracyStats(frames);
    const sigma = mean(frames.map((f) => f.sigma).filter((x) => x > 0));
    const range = mean(frames.map((f) => f.range));
    return [
      label,
      String(frames.length),
      Number.isFinite(range) ? range.toFixed(2) : '-',
      s ? cm(Math.hypot(s.bias[0], s.bias[2])) : '-',
      s ? cm(s.spread) : '-',
      cm(sigma),
    ];
  });
  out.push(table(['point', 'n', 'range m', 'err of mean 2D', 'spread', 'exp sigma'], pointRows), '');

  const full = accuracyStats(all);
  if (!full) {
    out.push('No usable frames.');
    return out.join('\n');
  }
  const floorPick = (f: AccuracyFrame) => f.floor;
  const floor = accuracyStats(all, floorPick);
  const summary = [statsRow('full pose', full)];
  // the expected sigma belongs to the full pose; the floor ray has no error model of its own
  if (floor) summary.push([...statsRow('floor ray', floor).slice(0, -1), '-']);
  out.push(table(['estimate', 'n', 'CEP50', 'CEP95', 'RMS 2D', 'RMS 3D', 'max 2D', 'bias x, y, z', 'sigma ratio'], summary), '');

  const floorBins = new Map(statsByRange(all, RANGE_EDGES, floorPick).map((b) => [b.from, b.stats]));
  const rangeRows = statsByRange(all, RANGE_EDGES).map(({ from, to, stats: s }) => {
    const row = [rangeLabel(from, to), String(s.n), cm(s.cep50), cm(s.cep95), cm(s.rms2d), cm(s.rms3d), ratio(s.sigmaRatio)];
    const fl = floorBins.get(from);
    return floor ? [...row, fl ? String(fl.n) : '0', cm(fl?.cep50), cm(fl?.cep95)] : row;
  });
  const rangeHead = ['range m', 'n', 'CEP50', 'CEP95', 'RMS 2D', 'RMS 3D', 'sigma ratio'];
  out.push(table(floor ? [...rangeHead, 'floor n', 'floor CEP50', 'floor CEP95'] : rangeHead, rangeRows));
  return out.join('\n');
}

function formatChecks(id: string, records: CheckRecord[]): string {
  const kinds = [...new Set(records.map((r) => r.kind))].sort();
  const row = (name: string, errs: number[]) => [
    name,
    String(errs.length),
    cm(quantile(errs, 0.5)),
    cm(quantile(errs, 0.95)),
    cm(errs.reduce((m, x) => Math.max(m, x), 0)),
  ];
  const rows = kinds.map((k) => row(k, records.filter((r) => r.kind === k).map((r) => r.err2d)));
  if (kinds.length > 1) rows.push(row('all', records.map((r) => r.err2d)));
  return [`== Viewer checks, session ${id} ==`, table(['kind', 'n', 'CEP50', 'CEP95', 'max 2D'], rows)].join('\n');
}

const skipped = (what: string, lines: number, frames = 0): string[] => {
  const parts = [lines ? plural(lines, 'malformed line') : '', frames ? plural(frames, 'malformed frame') : ''].filter(Boolean);
  return parts.length ? [`${what}: skipped ${parts.join(' and ')}.`] : [];
};

/**
 * The whole report as text. `lines` are the lines of accuracy.jsonl. Errors are in cm with one decimal;
 * CEP50 / CEP95 are horizontal radii around the truth holding 50% / 95% of the estimates.
 */
export function formatReport(lines: string[], opts: ReportOptions = {}): string {
  const out: string[] = [];
  const points = parsePoints(lines);
  out.push(...skipped('accuracy log', points.badLines, points.badFrames));
  const chosen = chooseSessions(sessionIds(points.records), opts, 'recorded points');
  if (typeof chosen === 'string') out.push(chosen);
  else {
    for (const id of chosen) {
      out.push(formatSession(id, points.records.filter((r) => r.session === id)), '');
    }
    out.push('Errors in cm. Sigma ratio: RMS of (3D error / expected sigma), about 1 when the expected error is honest.');
  }

  if (opts.checkLines) {
    const checks = parseChecks(opts.checkLines);
    out.push('', ...skipped('viewer checks', checks.badLines));
    const ids = chooseSessions(sessionIds(checks.records), opts, 'viewer checks');
    if (typeof ids === 'string') out.push(ids);
    else out.push(ids.map((id) => formatChecks(id, checks.records.filter((r) => r.session === id))).join('\n\n'));
  }
  return out.join('\n').trimEnd() + '\n';
}

// ---- command line -----------------------------------------------------------------------------

interface CliArgs {
  file?: string;
  opts: ReportOptions;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { opts: {}, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.opts.all = true;
    else if (a === '--session') {
      const id = argv[++i];
      if (id === undefined) throw new Error('--session needs an id');
      args.opts.session = id;
    } else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (args.file === undefined) args.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

const readLines = (path: string): string[] => readFileSync(path, 'utf8').split(/\r?\n/);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const file = resolve(args.file ?? resolve(import.meta.dirname, '../.local/reports/accuracy.jsonl'));
  const checkFile = resolve(dirname(file), 'viewercheck.jsonl');
  const checkLines = existsSync(checkFile) ? readLines(checkFile) : undefined;
  if (!existsSync(file)) {
    if (!checkLines) {
      console.error(`No accuracy log at ${file}\n${USAGE}`);
      process.exit(1);
    }
    // the viewer's known-point checks need no recording, so report them on their own
    process.stdout.write(`No accuracy log at ${file}\n` + formatReport([], { ...args.opts, checkLines }));
  } else process.stdout.write(formatReport(readLines(file), { ...args.opts, checkLines }));
}
