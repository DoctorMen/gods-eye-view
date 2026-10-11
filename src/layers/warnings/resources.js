import * as Cesium from 'cesium';
import {
  createFeedLayer,
  createWarningOverlayEntry,
  warningPoint,
} from './feedLayer.js';

/** How far from the house to look (m). 40 km ≈ 25 miles, a day's walk out and back. */
export const RESOURCE_RADIUS_M = 40_000;

/** Resource kinds in priority order: what to reach first in a crisis. */
export const RESOURCE_KINDS = Object.freeze([
  Object.freeze({
    kind: 'hospital',
    label: 'Hospital',
    color: '#ff3b30',
    tags: [['amenity', 'hospital']],
  }),
  Object.freeze({
    kind: 'clinic',
    label: 'Clinic',
    color: '#ff6b6b',
    tags: [
      ['amenity', 'clinic'],
      ['amenity', 'doctors'],
    ],
  }),
  Object.freeze({
    kind: 'pharmacy',
    label: 'Pharmacy',
    color: '#ff9f0a',
    tags: [['amenity', 'pharmacy']],
  }),
  Object.freeze({
    kind: 'fire',
    label: 'Fire station',
    color: '#ff453a',
    tags: [['amenity', 'fire_station']],
  }),
  Object.freeze({
    kind: 'police',
    label: 'Police',
    color: '#0a84ff',
    tags: [['amenity', 'police']],
  }),
  Object.freeze({
    kind: 'shelter',
    label: 'Shelter',
    color: '#30d158',
    tags: [
      ['emergency', 'assembly_point'],
      ['social_facility', 'shelter'],
      ['amenity', 'shelter'],
    ],
  }),
  Object.freeze({
    kind: 'water',
    label: 'Water',
    color: '#64d2ff',
    tags: [
      ['amenity', 'drinking_water'],
      ['natural', 'spring'],
      ['man_made', 'water_well'],
      ['man_made', 'water_tower'],
    ],
  }),
  Object.freeze({
    kind: 'food',
    label: 'Grocery',
    color: '#ffd60a',
    tags: [['shop', 'supermarket']],
  }),
  Object.freeze({
    kind: 'fuel',
    label: 'Fuel',
    color: '#bf5af2',
    tags: [['amenity', 'fuel']],
  }),
  Object.freeze({
    kind: 'hardware',
    label: 'Hardware',
    color: '#ac8e68',
    tags: [
      ['shop', 'hardware'],
      ['shop', 'doityourself'],
    ],
  }),
]);

/** Overpass QL for every resource kind around the house; each selector bounded. */
export function resourceQuery({ lat, lon }, radiusM = RESOURCE_RADIUS_M) {
  const around = `(around:${radiusM},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const selectors = RESOURCE_KINDS.flatMap((k) =>
    k.tags.map(([key, value]) => `nwr["${key}"="${value}"]${around};`),
  );
  return `[out:json][timeout:30];(${selectors.join('')});out center 3000;`;
}

/** Which resource kind an OSM element is. */
export function resourceKind(tags) {
  for (const k of RESOURCE_KINDS)
    if (k.tags.some(([key, value]) => tags?.[key] === value)) return k;
  return null;
}

/** Distance in miles between two points. */
export function milesBetween(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Overpass JSON → resource rows sorted by distance from the house. */
export function normalizeResources(payload, house) {
  if (!Array.isArray(payload?.elements))
    throw new Error('Overpass payload invalid');
  const rows = [];
  const seen = new Set();
  for (const el of payload.elements) {
    const lat = Number(el?.lat ?? el?.center?.lat);
    const lon = Number(el?.lon ?? el?.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const kind = resourceKind(el.tags);
    if (!kind) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      kind: kind.kind,
      label: kind.label,
      color: kind.color,
      name:
        typeof el.tags?.name === 'string' ? el.tags.name.slice(0, 120) : null,
      emergency: el.tags?.emergency === 'yes',
      lat,
      lon,
      miles: Math.round(milesBetween(house, { lat, lon }) * 10) / 10,
    });
  }
  return rows.sort((a, b) => a.miles - b.miles);
}

/** Nearest resource of each kind, for the summary and labels. */
export function nearestByKind(rows) {
  const nearest = new Map();
  for (const r of rows) if (!nearest.has(r.kind)) nearest.set(r.kind, r);
  return nearest;
}

/** Overpass statuses that mean "busy, try again shortly". */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Wait `ms`, or reject at once when `signal` aborts. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * POST the query to the app's bounded Overpass proxy. The public Overpass
 * servers often answer "too busy" (429/503/504) at peak hours, so a busy reply
 * is retried after `retryDelaysMs` before the refresh is reported as failed.
 */
export function createResourceSource({
  house,
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = '/api/overpass',
  retryDelaysMs = [5_000, 15_000, 45_000],
  wait = pause,
}) {
  return {
    async getSnapshot({ signal } = {}) {
      const body = new URLSearchParams({
        data: resourceQuery(house),
      }).toString();
      for (let attempt = 0; ; attempt++) {
        const response = await fetchImpl(url, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (response.ok) {
          const payload = await response.json();
          signal?.throwIfAborted();
          return { rows: normalizeResources(payload, house) };
        }
        if (
          !RETRYABLE_STATUS.has(response.status) ||
          attempt >= retryDelaysMs.length
        )
          throw new Error(`Overpass HTTP ${response.status}`);
        await wait(retryDelaysMs[attempt], signal);
      }
    },
  };
}

export function drawResources(snapshot) {
  const rows = snapshot?.rows ?? [];
  const nearest = nearestByKind(rows);
  const entities = [];
  const overlay = [];
  for (const r of rows) {
    const isNearest = nearest.get(r.kind) === r;
    entities.push(
      warningPoint({
        id: `survival-resources:${r.id}`,
        name: `${r.label}${r.name ? `: ${r.name}` : ''} · ${r.miles} mi`,
        lon: r.lon,
        lat: r.lat,
        color: r.color,
        size: isNearest ? 12 : 7,
        properties: { kind: r.kind, miles: r.miles },
      }),
    );
    if (isNearest)
      overlay.push(
        createWarningOverlayEntry({
          id: r.id,
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
          title: `Nearest ${r.label.toLowerCase()} · ${r.miles} mi`,
          accent: r.color,
          priority: 10_000 - RESOURCE_KINDS.findIndex((k) => k.kind === r.kind),
        }),
      );
  }
  const parts = RESOURCE_KINDS.filter((k) => nearest.has(k.kind))
    .slice(0, 5)
    .map((k) => `${k.label.toLowerCase()} ${nearest.get(k.kind).miles} mi`);
  return {
    entities,
    overlay,
    count: rows.length,
    summary: `${rows.length} places within 25 mi · nearest ${parts.join(', ') || 'none found'}`,
  };
}

export function resourceRecords(snapshot) {
  return (snapshot?.rows ?? []).map((r) => ({
    kind: r.kind,
    name: r.name,
    miles: r.miles,
    lat: r.lat,
    lon: r.lon,
  }));
}

/** Hospitals, pharmacies, fire, police, shelters, water, food, fuel and hardware near the house (OpenStreetMap). */
export function createSurvivalResourcesLayer({
  overlayHost,
  house,
  fetchImpl,
  source,
} = {}) {
  if (!source && !(Number.isFinite(house?.lat) && Number.isFinite(house?.lon)))
    throw new TypeError('Survival resources require the house point');
  return createFeedLayer({
    id: 'survival-resources',
    name: 'Survival Resources Near Home',
    icon: '🏥',
    sourceLabel: 'OpenStreetMap',
    // Places change slowly; one fetch an hour is plenty and kind to Overpass.
    updateInterval: 3_600_000,
    source: source ?? createResourceSource({ house, fetchImpl }),
    overlayHost,
    draw: drawResources,
    records: resourceRecords,
    cohortLimit: 32,
  });
}
