import { AR, type Dictionary, type ImageLike } from '../vendor/js-aruco2/aruco.js';
import type { Vec2 } from '../core/camera';
import { refineQuad } from './refine';

/**
 * Printed markers for FTX. ARUCO_MIP_36h12 (6 x 6 data bits, minimum Hamming distance 12, also in
 * OpenCV as DICT_ARUCO_MIP_36h12), so other tools can detect the very same sheets.
 * "Size" always means the side of the BLACK square in metres, not the paper.
 */
export const DICTIONARY = 'ARUCO_MIP_36h12';
export const ORIGIN_ID = 0;
export const TARGET_ID = 1;

let dict: Dictionary | null = null;
const dictionary = (): Dictionary => (dict ??= new AR.Dictionary(DICTIONARY));

/**
 * The marker as a grid of cells including a one-cell white quiet zone around the black border:
 * grid[row][col], row 0 is the printed top, true means white. 10 x 10 for this dictionary, of
 * which the inner 8 x 8 is the black square.
 */
export function markerGrid(id: number): boolean[][] {
  const d = dictionary();
  const code = d.codeList[id];
  if (code === undefined) throw new Error(`marker id ${id} is not in ${DICTIONARY}`);
  const bits = d.markSize - 2;
  const n = d.markSize + 2;
  const grid: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) {
      if (r === 0 || c === 0 || r === n - 1 || c === n - 1) row.push(true);
      else if (r === 1 || c === 1 || r === n - 2 || c === n - 2) row.push(false);
      else row.push(code[(r - 2) * bits + (c - 2)] === '1');
    }
    grid.push(row);
  }
  return grid;
}

/** Cells across the black square (8 for this dictionary). */
export const blackCells = () => dictionary().markSize;

/** SVG of the marker with its quiet zone, one unit per cell. Scale it with CSS width in mm to print. */
export function markerSvg(id: number): string {
  const g = markerGrid(id);
  const n = g.length;
  let rects = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!g[r][c]) rects += `<rect x="${c}" y="${r}" width="1" height="1"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><g fill="#000">${rects}</g></svg>`
  );
}

export interface Detection {
  id: number;
  /**
   * As printed: top-left, top-right, bottom-right, bottom-left. Continuous image coordinates
   * (pixel centres at +0.5), refined to sub-pixel accuracy.
   */
  corners: Vec2[];
  /** Bits that had to be corrected to match the dictionary. */
  bitErrors: number;
}

export class MarkerDetector {
  private readonly det;

  /**
   * `maxBitErrors`: accept a code this many bits away from a dictionary entry (entries are 12 apart).
   * `refine`: sub-pixel corners (recommended; off only to compare).
   */
  constructor(
    maxBitErrors = 2,
    public refine = true,
  ) {
    this.det = new AR.Detector({ dictionaryName: DICTIONARY, maxHammingDistance: maxBitErrors + 1 });
    // A white sheet on a darker floor gives two nested squares: the paper margin and the black
    // border. The stock "too near" filter keeps the larger (the margin, which never decodes) and
    // drops the marker. Keep every candidate instead; the decoder rejects the margin by its border.
    (this.det as unknown as { notTooNear: (c: unknown[]) => unknown[] }).notTooNear = (c) => c;
  }

  /** RGBA image (ImageData or the like). One detection per id: the cleanest if it shows up twice. */
  detect(img: ImageLike): Detection[] {
    const best = new Map<number, Detection>();
    for (const m of this.det.detect(img)) {
      const raw = m.corners.map((p): Vec2 => [p.x, p.y]);
      const d: Detection = { id: m.id, corners: this.refine ? refineQuad(img, raw) : raw.map(([x, y]): Vec2 => [x + 0.5, y + 0.5]), bitErrors: m.hammingDistance };
      const prev = best.get(d.id);
      if (!prev || d.bitErrors < prev.bitErrors) best.set(d.id, d);
    }
    return [...best.values()];
  }
}
