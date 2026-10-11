import { DICTIONARY, ORIGIN_ID, TARGET_ID, markerSvg } from './aruco';
import { loadSetting, saveSetting } from './settings';

/**
 * Printable sheets for the two FTX markers. Only the black square is drawn; the paper around it is
 * the white margin the detector needs (at least one cell, i.e. 1/8 of the square, on every side).
 */

const PAPER: Record<string, [number, number]> = { A4: [210, 297], Letter: [215.9, 279.4], A3: [297, 420] };
const MARGIN = 10; // mm, print margin

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const paperSel = $<HTMLSelectElement>('paper');
const size0 = $<HTMLInputElement>('size0');
const size1 = $<HTMLInputElement>('size1');

const saved = loadSetting('markers', { paper: 'A4', size0: 160, size1: 160 });
paperSel.value = saved.paper;
size0.value = String(saved.size0);
size1.value = String(saved.size1);

/** Small drawing of the world axes the origin marker defines, seen from above. */
const AXES_SVG = `
<svg viewBox="0 0 74 42" width="44mm" height="25mm" fill="none" stroke="#000" stroke-width="0.6" font-size="4.2" font-family="sans-serif">
  <rect x="28" y="9" width="18" height="18" stroke-dasharray="1.5 1"/>
  <text x="37" y="6" text-anchor="middle" fill="#000" stroke="none">printed top edge</text>
  <circle cx="37" cy="18" r="1.2" fill="#000"/>
  <line x1="37" y1="18" x2="58" y2="18"/><path d="M58 16.5 L61 18 L58 19.5 Z" fill="#000"/>
  <text x="63" y="19.5" fill="#000" stroke="none">+X</text>
  <line x1="37" y1="18" x2="37" y2="36"/><path d="M35.5 36 L37 39 L38.5 36 Z" fill="#000"/>
  <text x="40" y="39" fill="#000" stroke="none">+Z</text>
  <text x="0" y="16" fill="#000" stroke="none">+Y: up, out</text>
  <text x="0" y="21" fill="#000" stroke="none">of the page</text>
</svg>`;

function sheet(id: number, sizeMm: number, paperW: number, paperH: number): string {
  const origin = id === ORIGIN_ID;
  const svg = markerSvg(id).replace(/viewBox="[^"]*"/, 'viewBox="1 1 8 8"'); // crop off the quiet zone
  const cell = sizeMm / 8;
  const title = origin ? `CROSSCUE DATUM ORIGIN (ID ${id})` : `CROSSCUE TARGET (ID ${id})`;
  const note = origin
    ? 'Lay it flat on the floor of room A where the webcam sees it, and tape it down: it defines the shared world ' +
      'frame for the whole session. The centre of the black square is the origin, its right-hand edge points to +X and ' +
      'its printed top edge points to -Z (heading 0). The phone aligns by tapping the centre, then the middle of the right edge.'
    : 'Stand it upright facing the webcam (tape it to a box or a chair back) and keep the sheet flat. For the accuracy ' +
      'rig, measure the floor point straight below the centre of the black square, and the height of that centre.';
  return `
  <section class="sheet" style="width:${paperW}mm;min-height:${paperH}mm">
    <h3>${title}</h3>
    <div style="margin:${cell.toFixed(1)}mm 0">${svg.replace('<svg ', `<svg style="display:block;width:${sizeMm}mm;height:${sizeMm}mm" `)}</div>
    <div class="info">${origin ? AXES_SVG : ''}<div class="note">${note}</div></div>
    <div class="meta">${DICTIONARY}, id ${id}. Black square printed at ${sizeMm} mm: measure it and enter the real size in the observer.</div>
    <div class="ruler" style="width:100mm"><span>this line should be exactly 100 mm</span></div>
  </section>`;
}

function render(): void {
  const [w, h] = PAPER[paperSel.value] ?? PAPER.A4;
  const s0 = Number(size0.value) || 160;
  const s1 = Number(size1.value) || 160;
  document.getElementById('page-size')!.textContent = `@page { size: ${paperSel.value} portrait; margin: ${MARGIN}mm; }`;
  // the sheet already includes the print margin as padding on screen; in print the @page margin takes over
  $('sheets').innerHTML = sheet(ORIGIN_ID, s0, w, h) + sheet(TARGET_ID, s1, w, h);
  const maxSide = (w * 8) / 10; // leaves one cell of white on each side across the paper width
  const tooBig = [s0, s1].filter((s) => s > maxSide);
  $('warn').textContent = tooBig.length
    ? `A ${Math.max(...tooBig)} mm square leaves less than one cell of white margin on ${paperSel.value}. Keep it at ${Math.floor(maxSide)} mm or less.`
    : '';
  saveSetting('markers', { paper: paperSel.value, size0: s0, size1: s1 });
}

for (const el of [paperSel, size0, size1]) el.addEventListener('input', render);
$('print').addEventListener('click', () => window.print());
render();
