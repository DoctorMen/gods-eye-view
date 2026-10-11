/**
 * Upper-level wind at one point from the public GFS 0.25° files.
 *
 * Fallout rides the winds between about 10,000 and 30,000 ft, not the 10 m wind
 * the Wind layer shows. This module reads the UGRD/VGRD messages at the
 * 700, 500 and 300 mb levels (about 10,000, 18,000 and 30,000 ft) for the
 * forecast step valid closest to now, samples the grid at the requested point,
 * and reports each level plus a layer-mean vector that the fallout layer uses as
 * its "effective fallout wind" (Glasstone & Dolan 1977 par. 9.96).
 *
 * The GRIB fetch reuses the Wind layer's catalog, index, range and decode helpers
 * so no new upstream host is introduced.
 */
import {
  GFS_BUCKET,
  gfsObjectKey,
  selectLatestGfsCycle,
  nearestGfsStep,
} from '../wind/catalog.js';
import { parseGfsIdx, fetchText, fetchRange } from '../wind/gfs.js';
import { decodeWindGribMessage } from '../wind/decode.js';

export const FALLOUT_LEVELS = Object.freeze([
  Object.freeze({ mb: 700, label: '700 mb', feet: 10000 }),
  Object.freeze({ mb: 500, label: '500 mb', feet: 18000 }),
  Object.freeze({ mb: 300, label: '300 mb', feet: 30000 }),
]);

const MS_TO_MPH = 2.236936;

/** Byte ranges of UGRD and VGRD at the given isobaric levels. */
export function upperWindRanges(parsed, levels = FALLOUT_LEVELS) {
  const find = (variable, level) => {
    const index = parsed.messages.findIndex(
      (m) => m.variable === variable && m.level === level,
    );
    const message = parsed.messages[index];
    const next = parsed.messages[index + 1];
    if (!message || !next) throw new Error(`missing ${variable} at ${level}`);
    return { start: message.offset, end: next.offset - 1 };
  };
  return levels.map(({ mb, label }) => ({
    mb,
    label,
    u: find('UGRD', label),
    v: find('VGRD', label),
  }));
}

/**
 * Nearest-grid-point sample of one decoded GFS message.
 * GFS 0.25° is global, lo1 = 0, la1 = 90, rows run north to south.
 */
export function sampleGrid(decoded, lat, lon) {
  const { ni, nj, lo1, la1, di, dj, values } = decoded;
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    throw new TypeError('lat and lon are required');
  let x = (((lon - lo1) % 360) + 360) % 360;
  let i = Math.round(x / di) % ni;
  let j = Math.round((la1 - lat) / dj);
  j = Math.max(0, Math.min(nj - 1, j));
  const value = values[j * ni + i];
  if (!Number.isFinite(value)) throw new Error('grid sample is not finite');
  return value;
}

/** Meteorological direction (degrees the wind blows FROM) and speed in mph. */
export function vectorToWind(u, v) {
  const speedMs = Math.hypot(u, v);
  let dir = (270 - (Math.atan2(v, u) * 180) / Math.PI) % 360;
  if (dir < 0) dir += 360;
  return { dir: Math.round(dir), speedMph: speedMs * MS_TO_MPH, u, v };
}

/** Vector mean of the sampled levels: the effective fallout wind. */
export function layerMeanWind(levels) {
  if (!levels.length) throw new Error('no levels');
  const u = levels.reduce((s, l) => s + l.u, 0) / levels.length;
  const v = levels.reduce((s, l) => s + l.v, 0) / levels.length;
  const mean = vectorToWind(u, v);
  // Crosswind shear across the column, mph per kilofoot: the component of the
  // wind change with height that lies across the mean wind. It widens the
  // fallout pattern (WSEG-10 uses it directly); the along-wind component only
  // stretches it, which the model's L term already covers.
  const low = levels[0];
  const high = levels[levels.length - 1];
  const du = high.u - low.u;
  const dv = high.v - low.v;
  const speed = Math.hypot(u, v) || 1;
  const cross = Math.abs((u * dv - v * du) / speed);
  const kft = Math.max(1, (high.feet - low.feet) / 1000);
  const shearMphPerKft = (cross * MS_TO_MPH) / kft;
  return { ...mean, shearMphPerKft };
}

/** Fetch and sample the upper winds for one point. */
export async function fetchUpperWind({
  lat,
  lon,
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  levels = FALLOUT_LEVELS,
  signal,
} = {}) {
  const nowMs = now();
  const cycle = selectLatestGfsCycle(nowMs);
  const runMs = Date.UTC(
    Number(cycle.date.slice(0, 4)),
    Number(cycle.date.slice(4, 6)) - 1,
    Number(cycle.date.slice(6, 8)),
    cycle.hour,
  );
  const forecastHour = nearestGfsStep((nowMs - runMs) / 3600_000);
  const base = `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey({ ...cycle, forecastHour })}`;
  const index = await fetchText({ url: `${base}.idx`, fetchImpl, signal });
  const ranges = upperWindRanges(parseGfsIdx(index.toString()), levels);
  const load = async (range) =>
    decodeImpl(await fetchRange({ url: base, ...range, fetchImpl, signal }));
  const sampled = await Promise.all(
    ranges.map(async ({ mb, label, u, v }, k) => {
      const [du, dv] = await Promise.all([load(u), load(v)]);
      const us = sampleGrid(du, lat, lon);
      const vs = sampleGrid(dv, lat, lon);
      return { mb, label, feet: levels[k].feet, ...vectorToWind(us, vs) };
    }),
  );
  signal?.throwIfAborted();
  return {
    schemaVersion: 1,
    point: { lat, lon },
    cycle: {
      ...cycle,
      forecastHour,
      runIso: new Date(runMs).toISOString(),
      validIso: new Date(runMs + forecastHour * 3600_000).toISOString(),
    },
    levels: sampled.map(({ u, v, ...rest }) => rest),
    layer: (({ u, v, ...rest }) => rest)(layerMeanWind(sampled)),
    source: 'NOAA GFS 0.25° via noaa-gfs-bdp-pds',
  };
}
