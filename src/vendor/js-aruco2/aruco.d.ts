// Typings for the vendored js-aruco2 ES module (aruco.js next to this file).

interface Point {
  x: number;
  y: number;
}
interface Marker {
  id: number;
  /** Clockwise in the image, starting at the marker's printed top-left corner. */
  corners: Point[];
  hammingDistance: number;
}
interface ImageLike {
  width: number;
  height: number;
  data: ArrayLike<number>;
}
interface Detector {
  detect(image: ImageLike): Marker[];
}
interface Dictionary {
  markSize: number;
  nBits: number;
  /** One string of '0' and '1' per id, row-major from the printed top-left; '1' is white. */
  codeList: string[];
  tau: number;
  generateSVG(id: number): string;
}
export declare const AR: {
  Detector: new (config?: { dictionaryName?: string; maxHammingDistance?: number }) => Detector;
  Dictionary: new (name: string) => Dictionary;
};
export type { Point, Marker, ImageLike, Detector, Dictionary };
