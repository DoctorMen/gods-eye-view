import * as Cesium from 'cesium';
import {
  createFeedLayer,
  createFeedSource,
  createWarningOverlayEntry,
  warningPoint,
  warningRing,
} from './feedLayer.js';

const MI_TO_M = 1609.344;

export const READING_COLORS = Object.freeze({
  normal: '#34c759',
  raised: '#ffd60a',
  high: '#ff9500',
  danger: '#ff3b30',
});

/**
 * Plants always draw (bundled data); live readings are added when the server
 * can reach Safecast. A failed reading fetch is reported, not fatal.
 */
export function createRadiationSource({ plants, readings }) {
  return {
    async getSnapshot({ signal } = {}) {
      let live = null;
      let readingError = null;
      try {
        live = await readings.getSnapshot({ signal });
      } catch (e) {
        signal?.throwIfAborted();
        readingError = e?.message ?? 'readings unavailable';
      }
      return {
        plants: plants.plants,
        zones: plants.zones,
        rows: live?.rows ?? [],
        since: live?.since ?? null,
        stale: Boolean(live?.stale),
        readingError,
      };
    },
  };
}

export function radiationSummary(snapshot) {
  const plants = snapshot?.plants ?? [];
  const near = plants.filter((p) => p.homeMi <= 200 && p.status !== 'closed');
  const rows = snapshot?.rows ?? [];
  const worst = rows[0];
  const parts = [
    `${near.length} working plants within 200 mi (nearest ${plants[0]?.name} ${plants[0]?.homeMi} mi)`,
  ];
  if (snapshot?.readingError) parts.push('live readings unavailable');
  else if (!rows.length)
    parts.push('no live readings within 500 km in 30 days');
  else
    parts.push(
      `${rows.length} live readings, highest ${worst.usvh} µSv/h (${worst.level})`,
    );
  return parts.join(' · ');
}

/** Plants with their emergency zones, plus dose-rate readings. */
export function drawRadiation(snapshot) {
  const entities = [];
  const overlay = [];
  const plume = (snapshot?.zones?.plumeMi ?? 10) * MI_TO_M;
  const ingestion = (snapshot?.zones?.ingestionMi ?? 50) * MI_TO_M;
  for (const p of snapshot?.plants ?? []) {
    const closed = p.status === 'closed';
    const color = closed ? '#8e8e93' : '#bf5af2';
    const key = `${p.name}-${p.lat}-${p.lon}`;
    entities.push(
      warningPoint({
        id: `radiation-watch:plant:${key}`,
        name: `${p.name} (${p.country}) ${p.mw} MW${p.note ? ` · ${p.note}` : ''}`,
        lon: p.lon,
        lat: p.lat,
        color,
        size: closed ? 7 : 10,
        properties: {
          kind: 'plant',
          status: p.status,
          mw: p.mw,
          homeMi: p.homeMi,
        },
      }),
    );
    entities.push(
      warningRing({
        id: `radiation-watch:plume:${key}`,
        name: `${p.name} 10-mile plume zone`,
        lon: p.lon,
        lat: p.lat,
        radiusM: plume,
        color,
        fill: closed ? 0.02 : 0.1,
      }),
    );
    if (!closed)
      entities.push(
        warningRing({
          id: `radiation-watch:ingestion:${key}`,
          name: `${p.name} 50-mile food and water zone`,
          lon: p.lon,
          lat: p.lat,
          radiusM: ingestion,
          color,
          fill: 0.02,
        }),
      );
    overlay.push(
      createWarningOverlayEntry({
        id: `plant:${key}`,
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        title: `☢ ${p.name}${Number.isFinite(p.homeMi) && p.homeMi <= 300 ? ` · ${p.homeMi} mi` : ''}`,
        accent: color,
        priority: Math.max(1, 10_000 - (p.homeMi ?? 10_000)),
      }),
    );
  }
  for (const r of snapshot?.rows ?? []) {
    const color = READING_COLORS[r.level] ?? READING_COLORS.normal;
    entities.push(
      warningPoint({
        id: `radiation-watch:reading:${r.id}`,
        name: `${r.usvh} µSv/h · ${r.captured ?? ''}`,
        lon: r.lon,
        lat: r.lat,
        color,
        size: r.level === 'normal' ? 6 : 11,
        properties: { kind: 'reading', usvh: r.usvh, level: r.level },
      }),
    );
    if (r.level !== 'normal')
      overlay.unshift(
        createWarningOverlayEntry({
          id: `reading:${r.id}`,
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
          title: `${r.usvh} µSv/h`,
          accent: color,
          priority: 20_000 + Math.round(r.usvh * 100),
        }),
      );
  }
  return {
    entities,
    overlay,
    count: (snapshot?.plants?.length ?? 0) + (snapshot?.rows?.length ?? 0),
    summary: radiationSummary(snapshot),
  };
}

export function radiationRecords(snapshot) {
  return [
    ...(snapshot?.plants ?? []).map((p) => ({
      kind: 'nuclear-plant',
      name: p.name,
      country: p.country,
      status: p.status,
      mw: p.mw,
      homeMi: p.homeMi,
      lat: p.lat,
      lon: p.lon,
    })),
    ...(snapshot?.rows ?? []).map((r) => ({
      kind: 'reading',
      usvh: r.usvh,
      level: r.level,
      captured: r.captured,
      lat: r.lat,
      lon: r.lon,
    })),
  ];
}

/** Nuclear plants with 10/50-mile zones, and live Safecast dose rates near the house. */
export function createRadiationWatchLayer({
  overlayHost,
  plants,
  fetchImpl,
  source,
} = {}) {
  if (!source && !Array.isArray(plants?.plants))
    throw new TypeError('Radiation watch requires nuclear_plants.json');
  return createFeedLayer({
    id: 'radiation-watch',
    name: 'Radiation Watch',
    icon: '☢️',
    sourceLabel: 'WRI plants / Safecast',
    updateInterval: 900_000,
    source:
      source ??
      createRadiationSource({
        plants,
        readings: createFeedSource('radiation', { fetchImpl }),
      }),
    overlayHost,
    draw: drawRadiation,
    records: radiationRecords,
    cohortLimit: 128,
  });
}
