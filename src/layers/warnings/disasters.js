import * as Cesium from 'cesium';
import {
  createFeedLayer,
  createFeedSource,
  createWarningOverlayEntry,
  warningPoint,
} from './feedLayer.js';

export const GDACS_COLORS = Object.freeze({
  Red: '#ff3b30',
  Orange: '#ff9500',
  Green: '#34c759',
});

/** Build the disaster picture: every event a dot, Orange and Red events labelled. */
export function drawDisasters(snapshot) {
  const rows = snapshot?.rows ?? [];
  const entities = [];
  const overlay = [];
  for (const r of rows) {
    const color = GDACS_COLORS[r.level] ?? '#8e8e93';
    entities.push(
      warningPoint({
        id: `global-disasters:${r.id}`,
        name: `${r.typeName}: ${r.name ?? r.country ?? ''}`,
        lon: r.lon,
        lat: r.lat,
        color,
        size: 6 + 4 * r.rank,
        properties: { type: r.type, level: r.level, link: r.link },
      }),
    );
    if (r.rank >= 2)
      overlay.push(
        createWarningOverlayEntry({
          id: r.id,
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat),
          title: `${r.typeName}${r.country ? ` · ${r.country}` : ''}`,
          accent: color,
          priority: 1000 * r.rank,
        }),
      );
  }
  const red = rows.filter((r) => r.level === 'Red').length;
  const orange = rows.filter((r) => r.level === 'Orange').length;
  return {
    entities,
    overlay,
    count: rows.length,
    summary: `${rows.length} current disasters · ${red} red · ${orange} orange`,
  };
}

export function disasterRecords(snapshot) {
  return (snapshot?.rows ?? []).map((r) => ({
    type: r.typeName,
    level: r.level,
    name: r.name,
    country: r.country,
    severity: r.severity,
    from: r.from,
    lat: r.lat,
    lon: r.lon,
  }));
}

/** GDACS (UN/EU) current earthquakes, cyclones, floods, volcanoes, droughts and fires. */
export function createGlobalDisastersLayer({
  overlayHost,
  fetchImpl,
  source,
} = {}) {
  return createFeedLayer({
    id: 'global-disasters',
    name: 'World Disaster Alerts',
    icon: '🌐',
    sourceLabel: 'GDACS',
    updateInterval: 600_000,
    source: source ?? createFeedSource('disasters', { fetchImpl }),
    overlayHost,
    draw: drawDisasters,
    records: disasterRecords,
  });
}
