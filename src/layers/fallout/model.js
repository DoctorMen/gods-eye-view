/**
 * WSEG-10 fallout model (Pugh & Galiano 1959) as checked against Hanifen 1980
 * (AFIT/GNE/PH/80M-2, DTIC ADA083515) and Glasstone & Dolan 1977 chapter IX.
 *
 * This is a line-for-line port of simulations/research/wseg10_checked.py from
 * the Sandy Bank work. Units: yield in megatons, distances in statute miles,
 * wind in mph, shear in mph per kilofoot. rateH1 returns the unit-time (H+1)
 * reference dose rate in R/h over open smooth ground, before the terrain
 * factor (about 0.7 on level ground) and before t^-1.2 decay.
 *
 * Pure functions only: no Cesium, no DOM, so the unit tests can pin it to the
 * Python reference values.
 */

export const SNC = 2.0e6; // R/h per MT fission per square mile (Hanifen)
export const TERRAIN_FACTOR = 0.7; // Glasstone 9.95, level ground
export const MI_PER_DEG_LAT = 69.09;

const SQRT2 = Math.SQRT2;
const SQRT2PI = Math.sqrt(2 * Math.PI);

/** erf, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

export function ncdf(x) {
  return 0.5 * (1 + erf(x / SQRT2));
}

/** Gamma function, Lanczos approximation (g = 7, n = 9). */
export function gamma(z) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return SQRT2PI * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/** Cloud and pattern geometry (Hanifen Eq. 1-10). */
export function geometry(Y, wind) {
  const lnY = Math.log(Y);
  const d = lnY + 2.42;
  const Hc = 44 + 6.1 * lnY - 0.205 * Math.abs(d) * d; // kft
  const s0 = Math.exp(0.7 + lnY / 3 - 3.25 / (4.0 + (lnY + 5.4) ** 2)); // mi
  const sh = 0.18 * Hc; // kft
  const h = Hc / 60;
  const Tc =
    1.0573203 *
    (12 * h - 2.5 * h * h) *
    (1 - 0.5 * Math.exp(-((Hc / 25) ** 2)));
  const L0 = wind * Tc;
  const sx2 = (s0 * s0 * (L0 * L0 + 8 * s0 * s0)) / (L0 * L0 + 2 * s0 * s0);
  const L = Math.sqrt(L0 * L0 + 2 * sx2);
  return { Hc, s0, sh, Tc, L0, sx2, sx: Math.sqrt(sx2), L };
}

/**
 * Downwind axis terms at one distance: the crosswind-integrated activity fx,
 * the crosswind sigma sy and the near-ground-zero factor a2, so that
 * rate(dx, dy) = fx * exp(-0.5 (dy / (a2 sy))^2) / (sqrt(2 pi) sy).
 */
export function axisTerms(Y, ff, wind, shear, dx, { capGrowth = true } = {}) {
  const { Hc, s0, sh, Tc, L0, sx2, sx, L } = geometry(Y, wind);
  let n = (L0 * L0 + sx2) / (L0 * L0 + 0.5 * sx2); // Eq. 15 with F = 1
  if (n <= 1.002) n = 1.0;
  const a1 = 1 / (1 + (0.001 * Hc * wind) / s0); // Eq. 21
  const g = Math.exp(-Math.pow(Math.abs(dx) / L, n)) / (L * gamma(1 + 1 / n));
  const phi = ncdf(((L0 / L) * dx) / (sx * a1)); // upwind cutoff
  const fx = Y * SNC * ff * phi * g; // Eq. 22
  let grow = 1 + (8 * Math.abs(dx + 2 * sx)) / L; // toroidal growth, Eq. 9
  if (capGrowth) grow = Math.min(grow, 4.0);
  const k = Tc * sh * shear;
  const sy = Math.sqrt(
    s0 * s0 * grow +
      (2 * (sx * k) ** 2) / (L * L) +
      ((dx + 2 * sx) * L0 * k) ** 2 / L ** 4,
  );
  const a2 = 1 / (1 + ((0.001 * Hc * wind) / s0) * (1 - ncdf((2 * dx) / wind)));
  return { fx, sy, a2, s0 };
}

/** H+1 reference dose rate, R/h, at dx downwind (negative = upwind), dy crosswind. */
export function rateH1(Y, ff, wind, shear, dx, dy, options) {
  const { fx, sy, a2 } = axisTerms(Y, ff, wind, shear, dx, options);
  const fy = Math.exp(-0.5 * (dy / (a2 * sy)) ** 2) / (SQRT2PI * sy);
  return fx * fy;
}

/** Fallout arrival time, h (Glasstone 9.91; Hanifen Eq. 26; 0.5 h floor). */
export function arrivalTimeH(Y, wind, dx) {
  const { s0 } = geometry(Y, wind);
  return Math.max(0.5, (dx - 2 * s0) / wind);
}

/** Accumulated dose, R, from ta to tb hours for an H+1 rate R1 (t^-1.2 decay). */
export function doseR(R1, ta, tb) {
  if (!(tb > ta)) return 0;
  return 5 * R1 * (Math.pow(ta, -0.2) - Math.pow(tb, -0.2));
}

/** Great-circle initial bearing (degrees) and distance (statute miles). */
export function bearingDistance(fromLat, fromLon, toLat, toLon) {
  const toRad = Math.PI / 180;
  const p1 = fromLat * toRad;
  const p2 = toLat * toRad;
  const dl = (toLon - fromLon) * toRad;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  let bearing = (Math.atan2(y, x) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  const a =
    Math.sin(((toLat - fromLat) * toRad) / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const distanceMi = 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return { bearing, distanceMi };
}

/**
 * Downwind and crosswind miles from a burst point to a receptor, given the
 * direction the wind blows FROM in degrees. Fallout travels toward from + 180.
 */
export function downwindCrosswind(target, point, windFromDeg) {
  const { bearing, distanceMi } = bearingDistance(
    target.lat,
    target.lon,
    point.lat,
    point.lon,
  );
  const travel = (windFromDeg + 180) % 360;
  const rel = ((bearing - travel) * Math.PI) / 180;
  return {
    dx: distanceMi * Math.cos(rel),
    dy: distanceMi * Math.sin(rel),
    distanceMi,
    bearing,
  };
}

/** Lat/lon of a point dx miles downwind and dy miles crosswind of a target. */
export function offsetLatLon(target, windFromDeg, dx, dy) {
  const travel = ((windFromDeg + 180) % 360) * (Math.PI / 180);
  const north = dx * Math.cos(travel) - dy * Math.sin(travel);
  const east = dx * Math.sin(travel) + dy * Math.cos(travel);
  const lat = target.lat + north / MI_PER_DEG_LAT;
  const lon =
    target.lon +
    east / (MI_PER_DEG_LAT * Math.cos((target.lat * Math.PI) / 180));
  return { lat, lon };
}

/**
 * Dose at one receptor from one burst.
 * @returns {{dx, dy, r1, arrivalH, outdoorR, shelterR}} doses in R from arrival
 *   to `hours` after the burst, outdoors (terrain factor applied) and behind
 *   protection factor `pf`.
 */
export function receptorDose({
  target,
  point,
  windFromDeg,
  windMph,
  shearMphPerKft = 0.1,
  yieldMt,
  fissionFraction = 0.5,
  hours = 336,
  pf = 1,
  terrain = TERRAIN_FACTOR,
}) {
  const { dx, dy, distanceMi } = downwindCrosswind(target, point, windFromDeg);
  const r1 = rateH1(yieldMt, fissionFraction, windMph, shearMphPerKft, dx, dy);
  const arrivalH = arrivalTimeH(yieldMt, windMph, dx);
  const outdoorR = terrain * doseR(r1, arrivalH, hours);
  return {
    dx,
    dy,
    distanceMi,
    r1,
    arrivalH,
    outdoorR,
    shelterR: outdoorR / pf,
  };
}

/**
 * Closed outline, in downwind/crosswind miles, of the area whose accumulated
 * dose from arrival to `hours` exceeds `thresholdR` (outdoors, terrain factor
 * applied, divided by pf). Uses the exact Gaussian crosswind half-width so no
 * marching squares is needed. Returns [] when the threshold is never reached.
 */
export function doseContour({
  yieldMt,
  fissionFraction = 0.5,
  windMph,
  shearMphPerKft = 0.1,
  hours = 336,
  pf = 1,
  thresholdR,
  terrain = TERRAIN_FACTOR,
  steps = 160,
  maxMi = 600,
}) {
  const { s0 } = geometry(yieldMt, windMph);
  const upper = [];
  const lower = [];
  const start = -3 * s0;
  // Log-spaced downwind steps for detail near ground zero and reach far out.
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const dx = start + (Math.exp(f * Math.log(1 + maxMi - start)) - 1);
    const { fx, sy, a2 } = axisTerms(
      yieldMt,
      fissionFraction,
      windMph,
      shearMphPerKft,
      dx,
    );
    const ta = arrivalTimeH(yieldMt, windMph, dx);
    const axisRate = fx / (SQRT2PI * sy);
    const axisDose = (terrain * doseR(axisRate, ta, hours)) / pf;
    if (!(axisDose > thresholdR)) {
      if (upper.length && dx > 0) break;
      continue;
    }
    const halfWidth = a2 * sy * Math.sqrt(2 * Math.log(axisDose / thresholdR));
    upper.push([dx, halfWidth]);
    lower.push([dx, -halfWidth]);
  }
  if (upper.length < 2) return [];
  return [...upper, ...lower.reverse()];
}

/** Contour as lat/lon pairs around a target for the given wind. */
export function doseContourLatLon(target, windFromDeg, options) {
  return doseContour(options).map(([dx, dy]) =>
    offsetLatLon(target, windFromDeg, dx, dy),
  );
}

/** Minutes until fallout arrives at a receptor, or null when it misses. */
export function arrivalMinutes(dose) {
  if (!dose || !(dose.outdoorR > 1)) return null;
  return Math.round(dose.arrivalH * 60);
}
