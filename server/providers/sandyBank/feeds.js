/**
 * Sandy Bank Watch warning feeds.
 *
 * Each feed reads one free, keyless public source on the server (so the browser
 * needs no CORS allowance and no key) and reduces it to the small row shape the
 * matching map layer draws. Normalizers are pure and exported for tests.
 *
 *   alerts     NWS active alerts (US) + alerts at the house + NOAA SWPC Kp
 *   airspace   adsb.lol emergency squawks (7500/7600/7700) + GPS-interference
 *              cells estimated from aircraft position accuracy (NACp)
 *   disasters  GDACS current disaster events (world)
 *   radiation  Safecast dose-rate readings within 200 km of the house
 *   resources  the saved offline list of places near the house, built once by
 *              scripts/build-survival-resources.mjs (no upstream at all)
 */

import { readFile } from 'node:fs/promises';

/** Where scripts/build-survival-resources.mjs writes the saved place list. */
export const SURVIVAL_RESOURCES_PATH = new URL(
  '../../../src/data/local_data/survival_resources/survival_resources.json',
  import.meta.url,
);

export const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
export const SWPC_KP_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
export const GDACS_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
export const ADSB_LOL_BASE = 'https://api.adsb.lol/v2';
export const SAFECAST_URL = 'https://api.safecast.org/measurements.json';

/** NWS event names that mean "act now" for a household in a war or a reactor accident. */
export const CRITICAL_EVENTS = Object.freeze([
  'Nuclear Power Plant Warning',
  'Radiological Hazard Warning',
  'Civil Danger Warning',
  'Civil Emergency Message',
  'Shelter In Place Warning',
  'Evacuation Immediate',
  'Hazardous Materials Warning',
  'Law Enforcement Warning',
  'Local Area Emergency',
  'Child Abduction Emergency',
  'Blue Alert',
  'Extreme Wind Warning',
  'Tornado Warning',
]);
const CRITICAL = new Set(CRITICAL_EVENTS);
const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

/** Emergency squawk codes and what each means. */
export const SQUAWKS = Object.freeze({
  7500: 'Hijack',
  7600: 'Radio failure',
  7700: 'General emergency',
});

/**
 * Sample centers for the GPS-interference estimate (adsb.lol point queries are
 * limited to 250 nm). The house region first, then the regions where jamming is
 * reported most often; a war would show up there before it reaches Georgia.
 */
export const GPS_SAMPLE_CENTERS = Object.freeze([
  Object.freeze({ name: 'Georgia (home)', lat: 34.0, lon: -84.0 }),
  Object.freeze({ name: 'Washington DC', lat: 38.9, lon: -77.0 }),
  Object.freeze({ name: 'Baltic', lat: 56.0, lon: 21.0 }),
  Object.freeze({ name: 'Black Sea', lat: 45.0, lon: 34.0 }),
  Object.freeze({ name: 'Eastern Mediterranean', lat: 34.5, lon: 34.0 }),
  Object.freeze({ name: 'Persian Gulf', lat: 26.5, lon: 52.0 }),
  Object.freeze({ name: 'Korea', lat: 37.5, lon: 127.0 }),
]);

/** Cell size (degrees) for the GPS-interference grid. */
export const GPS_CELL_DEG = 1;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const text = (x, max = 400) =>
  typeof x === 'string' ? x.trim().slice(0, max) : null;

/** Average of a ring's vertices (closing point excluded); enough to hang a label on. */
function ringCentroid(ring) {
  const points = ring.length > 1 ? ring.slice(0, -1) : ring;
  let lon = 0;
  let lat = 0;
  for (const [x, y] of points) {
    lon += x;
    lat += y;
  }
  const round = (v) => Math.round((v / points.length) * 1e5) / 1e5;
  return [round(lon), round(lat)];
}

/** Outer rings of a GeoJSON Polygon or MultiPolygon, validated. */
function outerRings(geometry) {
  if (!geometry) return [];
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const rings = [];
  for (const poly of polys) {
    const ring = Array.isArray(poly) ? poly[0] : null;
    if (
      Array.isArray(ring) &&
      ring.length >= 4 &&
      ring.every(
        (p) =>
          Array.isArray(p) &&
          finite(p[0]) &&
          finite(p[1]) &&
          Math.abs(p[0]) <= 180 &&
          Math.abs(p[1]) <= 90,
      )
    )
      rings.push(ring.map(([x, y]) => [x, y]));
  }
  return rings;
}

/** One NWS alert feature → row, or null when it is unusable. */
export function normalizeNwsAlert(feature) {
  const p = feature?.properties;
  if (!p || typeof p !== 'object') return null;
  const event = text(p.event, 120);
  if (!event) return null;
  const rings = outerRings(feature.geometry);
  return {
    id: text(p.id ?? feature.id, 200) ?? event,
    event,
    severity: text(p.severity, 20) ?? 'Unknown',
    urgency: text(p.urgency, 20),
    certainty: text(p.certainty, 20),
    headline: text(p.headline, 300),
    area: text(p.areaDesc, 300),
    sent: text(p.sent, 40),
    expires: text(p.expires ?? p.ends, 40),
    instruction: text(p.instruction, 600),
    critical: CRITICAL.has(event),
    rank: (CRITICAL.has(event) ? 10 : 0) + (SEVERITY_RANK[p.severity] ?? 0),
    rings,
    center: rings.length ? ringCentroid(rings[0]) : null,
  };
}

/** NWS FeatureCollection → rows sorted most serious first. */
export function normalizeNwsAlerts(payload) {
  if (!Array.isArray(payload?.features)) throw new Error('NWS payload invalid');
  const rows = [];
  const seen = new Set();
  for (const feature of payload.features) {
    const row = normalizeNwsAlert(feature);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows.sort((a, b) => b.rank - a.rank);
}

/** Planetary Kp list → latest reading with its NOAA G-scale storm level. */
export function normalizeKp(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  let latest = null;
  for (const row of rows) {
    // Newer SWPC files are objects; the older format is arrays with a header row.
    const kp = Array.isArray(row) ? Number(row[1]) : Number(row?.Kp);
    const time = Array.isArray(row) ? row[0] : row?.time_tag;
    if (!Number.isFinite(kp) || typeof time !== 'string') continue;
    if (!latest || time > latest.time) latest = { time, kp };
  }
  if (!latest) return null;
  const g = latest.kp >= 9 ? 5 : latest.kp >= 5 ? Math.floor(latest.kp) - 4 : 0;
  const maxKp24h = rows
    .filter((r) => {
      const t = Array.isArray(r) ? r[0] : r?.time_tag;
      return (
        typeof t === 'string' &&
        Date.parse(`${t}Z`) >= Date.parse(`${latest.time}Z`) - 24 * 3600_000
      );
    })
    .reduce(
      (m, r) =>
        Math.max(m, Array.isArray(r) ? Number(r[1]) : Number(r?.Kp) || 0),
      0,
    );
  return {
    time: latest.time,
    kp: latest.kp,
    maxKp24h,
    gScale: g,
    note:
      g >= 3
        ? 'Strong geomagnetic storm: power grid and long-distance radio can fail'
        : g >= 1
          ? 'Geomagnetic storm: radio and GPS may be degraded'
          : 'Quiet',
  };
}

/** GDACS event feature → row, or null. */
export function normalizeGdacsEvent(feature) {
  const p = feature?.properties;
  const c = feature?.geometry?.coordinates;
  if (!p || feature?.geometry?.type !== 'Point' || !Array.isArray(c))
    return null;
  const [lon, lat] = c;
  if (!finite(lon) || !finite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  const type = text(p.eventtype, 4);
  if (!type) return null;
  const level = text(p.alertlevel, 10) ?? 'Green';
  const url = p.url && typeof p.url === 'object' ? p.url : {};
  return {
    id: `${type}-${p.eventid ?? `${lat},${lon}`}-${p.episodeid ?? 0}`,
    type,
    typeName:
      {
        EQ: 'Earthquake',
        TC: 'Tropical cyclone',
        FL: 'Flood',
        VO: 'Volcano',
        DR: 'Drought',
        WF: 'Wildfire',
        TS: 'Tsunami',
      }[type] ?? type,
    name: text(p.name ?? p.eventname, 200),
    level,
    rank: { Red: 3, Orange: 2, Green: 1 }[level] ?? 0,
    country: text(p.country, 200),
    from: text(p.fromdate, 40),
    to: text(p.todate, 40),
    severity: text(p.severitydata?.severitytext, 200),
    link: text(url.report ?? url.details, 400),
    lat,
    lon,
  };
}

/** GDACS FeatureCollection → point rows, worst first. */
export function normalizeGdacs(payload) {
  if (!Array.isArray(payload?.features))
    throw new Error('GDACS payload invalid');
  const seen = new Set();
  const rows = [];
  for (const feature of payload.features) {
    const row = normalizeGdacsEvent(feature);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows.sort((a, b) => b.rank - a.rank);
}

/** One adsb.lol aircraft → squawk row, or null when not squawking an emergency. */
export function normalizeSquawk(ac) {
  const code = String(ac?.squawk ?? '').trim();
  if (!SQUAWKS[code]) return null;
  if (!finite(ac.lat) || !finite(ac.lon)) return null;
  return {
    id: `sqk-${text(ac.hex, 12) ?? `${ac.lat},${ac.lon}`}`,
    code,
    meaning: SQUAWKS[code],
    flight: text(ac.flight, 12),
    reg: text(ac.r, 16),
    type: text(ac.t, 8),
    altFt: finite(ac.alt_baro) ? ac.alt_baro : null,
    lat: ac.lat,
    lon: ac.lon,
  };
}

/**
 * Aircraft lists → GPS-interference cells.
 *
 * An airliner whose own GPS is healthy reports navigation accuracy NACp 8 or
 * better; jamming or spoofing drops it to 0-7. Following the method used by
 * public jamming maps, a cell is shown when at least `minAircraft` aircraft
 * report NACp and at least `minShare` of them are degraded. This is an
 * estimate: one faulty receiver can colour a cell with few aircraft.
 */
export function gpsInterferenceCells(
  aircraft,
  { cellDeg = GPS_CELL_DEG, minAircraft = 3, minShare = 0.1 } = {},
) {
  const cells = new Map();
  const seen = new Set();
  for (const ac of aircraft ?? []) {
    if (!finite(ac?.lat) || !finite(ac?.lon) || !finite(ac?.nac_p)) continue;
    const hex = text(ac.hex, 12);
    if (hex && seen.has(hex)) continue;
    if (hex) seen.add(hex);
    const i = Math.floor(ac.lat / cellDeg);
    const j = Math.floor(ac.lon / cellDeg);
    const key = `${i}:${j}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        id: `gps-${key}`,
        south: i * cellDeg,
        west: j * cellDeg,
        north: (i + 1) * cellDeg,
        east: (j + 1) * cellDeg,
        total: 0,
        bad: 0,
      };
      cells.set(key, cell);
    }
    cell.total += 1;
    if (ac.nac_p < 8) cell.bad += 1;
  }
  const rows = [];
  for (const cell of cells.values()) {
    const share = cell.bad / cell.total;
    if (cell.total < minAircraft || share < minShare) continue;
    rows.push({
      ...cell,
      share,
      level: share >= 0.3 ? 'high' : 'medium',
      lat: (cell.south + cell.north) / 2,
      lon: (cell.west + cell.east) / 2,
    });
  }
  return rows.sort((a, b) => b.share - a.share);
}

/** Convert one Safecast reading to µSv/h; null when the unit is unknown. */
export function safecastMicroSv(row) {
  const value = Number(row?.value);
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = String(row?.unit ?? '').toLowerCase();
  // bGeigie / LND 7317 pancake tube: 334 cpm ≈ 1 µSv/h (Safecast's own factor).
  if (unit === 'cpm') return value / 334;
  if (unit === 'usv' || unit === 'µsv/h' || unit === 'usv/h') return value;
  return null;
}

/** Safecast measurement list → readings, newest per device/location first. */
export function normalizeSafecast(payload) {
  if (!Array.isArray(payload)) throw new Error('Safecast payload invalid');
  const byPlace = new Map();
  for (const row of payload) {
    const lat = Number(row?.latitude);
    const lon = Number(row?.longitude);
    const usv = safecastMicroSv(row);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || usv == null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const place = `${row.device_id ?? ''}@${lat.toFixed(3)},${lon.toFixed(3)}`;
    const captured = text(row.captured_at, 40);
    const prior = byPlace.get(place);
    if (prior && (prior.captured ?? '') >= (captured ?? '')) continue;
    byPlace.set(place, {
      id: `sc-${row.id ?? place}`,
      lat,
      lon,
      usvh: Math.round(usv * 1000) / 1000,
      level:
        usv >= 10
          ? 'danger'
          : usv >= 1
            ? 'high'
            : usv >= 0.3
              ? 'raised'
              : 'normal',
      captured,
      device: row.device_id ?? null,
    });
  }
  return [...byPlace.values()].sort((a, b) => b.usvh - a.usvh);
}

async function getJson(fetchImpl, url, { signal, headers } = {}) {
  const response = await fetchImpl(url, {
    signal,
    headers: {
      Accept: 'application/geo+json, application/json',
      // api.weather.gov requires an identifying User-Agent.
      'User-Agent': 'sandy-bank-watch (gods-eye-view fork; personal use)',
      ...headers,
    },
  });
  if (!response.ok)
    throw new Error(`${new URL(url).host} HTTP ${response.status}`);
  return response.json();
}

/** Run a loader but keep going when it fails; the error becomes a note. */
async function soft(load, notes, label) {
  try {
    return await load();
  } catch (error) {
    notes.push(`${label}: ${error?.message ?? 'unavailable'}`);
    return null;
  }
}

/** The house the feeds centre on (Census geocoder, 3587 Sandy Bank Dr). */
export const SANDY_BANK_HOUSE = Object.freeze({ lat: 34.0205, lon: -83.8805 });

/** Feed definitions keyed by route name. `ttlMs` is the server cache life. */
export function createSandyBankFeeds({
  house = SANDY_BANK_HOUSE,
  readSaved = () => readFile(SURVIVAL_RESOURCES_PATH, 'utf8'),
} = {}) {
  if (!finite(house?.lat) || !finite(house?.lon))
    throw new TypeError('Sandy Bank feeds need the house point');
  return {
    alerts: {
      ttlMs: 120_000,
      async load({ fetchImpl, signal }) {
        const notes = [];
        const all = await getJson(fetchImpl, NWS_ALERTS_URL, { signal });
        const rows = normalizeNwsAlerts(all);
        const atHouse = await soft(
          async () =>
            normalizeNwsAlerts(
              await getJson(
                fetchImpl,
                `https://api.weather.gov/alerts/active?point=${house.lat.toFixed(4)},${house.lon.toFixed(4)}`,
                { signal },
              ),
            ).map((r) => r.id),
          notes,
          'house alerts',
        );
        const space = await soft(
          async () =>
            normalizeKp(await getJson(fetchImpl, SWPC_KP_URL, { signal })),
          notes,
          'space weather',
        );
        const houseIds = new Set(atHouse ?? []);
        for (const row of rows) row.atHouse = houseIds.has(row.id);
        return { rows, space, houseChecked: atHouse != null, notes };
      },
    },
    airspace: {
      ttlMs: 60_000,
      async load({ fetchImpl, signal }) {
        const notes = [];
        const squawks = [];
        for (const code of Object.keys(SQUAWKS)) {
          const body = await soft(
            () =>
              getJson(fetchImpl, `${ADSB_LOL_BASE}/sqk/${code}`, { signal }),
            notes,
            `squawk ${code}`,
          );
          for (const ac of body?.ac ?? []) {
            const row = normalizeSquawk(ac);
            if (row) squawks.push(row);
          }
        }
        const reached = notes.length < Object.keys(SQUAWKS).length;
        const aircraft = [];
        const sampled = [];
        // Sequential on purpose: adsb.lol is a free community service.
        for (const c of GPS_SAMPLE_CENTERS) {
          const body = await soft(
            () =>
              getJson(
                fetchImpl,
                `${ADSB_LOL_BASE}/point/${c.lat}/${c.lon}/250`,
                {
                  signal,
                },
              ),
            notes,
            c.name,
          );
          if (body?.ac) {
            aircraft.push(...body.ac);
            sampled.push({ name: c.name, aircraft: body.ac.length });
          }
        }
        if (!reached && !sampled.length)
          throw new Error('adsb.lol unavailable');
        return {
          squawks,
          cells: gpsInterferenceCells(aircraft),
          sampled,
          notes,
        };
      },
    },
    disasters: {
      ttlMs: 600_000,
      async load({ fetchImpl, signal }) {
        return {
          rows: normalizeGdacs(await getJson(fetchImpl, GDACS_URL, { signal })),
        };
      },
    },
    radiation: {
      ttlMs: 900_000,
      async load({ fetchImpl, signal, now }) {
        const since = new Date(now() - 30 * 86400_000)
          .toISOString()
          .slice(0, 10);
        const query = new URLSearchParams({
          latitude: String(house.lat),
          longitude: String(house.lon),
          distance: '200000',
          captured_after: since,
          per_page: '200',
        });
        return {
          rows: normalizeSafecast(
            await getJson(fetchImpl, `${SAFECAST_URL}?${query}`, { signal }),
          ),
          since,
        };
      },
    },
    resources: {
      ttlMs: 3_600_000,
      async load() {
        let text;
        try {
          text = await readSaved();
        } catch {
          throw new Error('saved list not built');
        }
        const body = JSON.parse(text);
        if (!Array.isArray(body?.rows)) throw new Error('saved list invalid');
        return {
          rows: body.rows,
          builtAt: body.builtAt ?? null,
          source: body.source ?? null,
        };
      },
    },
  };
}
