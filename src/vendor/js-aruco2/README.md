# js-aruco2 (vendored)

`cv.js` and `aruco.js` from [js-aruco2](https://github.com/damianofalcioni/js-aruco2) 2.0.0 by Damiano
Falcioni and Juan Mellado, MIT licence (`LICENSE.txt`).

Why vendored: the npm package is a classic script that assigns to top-level `this`, which Vite's
bundler turns into `(void 0).CV = ...` and crashes in the browser. The only changes are at the top and
bottom of each file, turning them into ES modules:

- `cv.js`: `var CV = CV || {}; this.CV = CV;` became `var CV = {};`, plus `export { CV };` at the end.
- `aruco.js`: `var CV = this.CV || require('./cv').CV; this.AR = AR;` became `import { CV } from './cv.js';`,
  plus `export { AR };` at the end.

`aruco.d.ts` holds the typings CROSSCUE uses. Detection behaviour changes (keeping nested candidates,
sub-pixel corners) live in `src/live/aruco.ts` and `src/live/refine.ts`, not here.
