import * as Cesium from 'cesium';
import {
  createFeedLayer,
  createFeedSource,
  createWarningOverlayEntry,
  warningPoint,
  warningRectangle,
} from './feedLayer.js';

/** Squawk colours: hijack red, emergency orange, radio failure yellow. */
export const SQUAWK_COLORS = Object.freeze({
  7500: '#ff3b30',
  7700: '#ff9500',
  7600: '#ffd60a',
});

/** One-line state of the airspace feed. */
export function airspaceSummary(snapshot) {
  const squawks = snapshot?.squawks ?? [];
  const cells = snapshot?.cells ?? [];
  const high = cells.filter((c) => c.level === 'high').length;
  const home = (snapshot?.sampled ?? []).find((s) => /home/i.test(s.name));
  return [
    `${squawks.length} emergency squawks`,
    `${cells.length} GPS-interference cells (${high} strong)`,
    home
      ? `${home.aircraft} aircraft sampled near home`
      : 'home region not sampled',
  ].join(' · ');
}

/** Build the airspace picture from a feed snapshot. */
export function drawAirspace(snapshot) {
  const entities = [];
  const overlay = [];
  for (const cell of snapshot?.cells ?? []) {
    entities.push(
      warningRectangle({
        id: `airspace-alerts:${cell.id}`,
        name: `GPS interference ${Math.round(100 * cell.share)}% of ${cell.total} aircraft`,
        west: cell.west,
        south: cell.south,
        east: cell.east,
        north: cell.north,
        color: cell.level === 'high' ? '#ff3b30' : '#ffcc00',
        fill: cell.level === 'high' ? 0.35 : 0.2,
        properties: { kind: 'gps', share: cell.share, total: cell.total },
      }),
    );
    if (cell.level === 'high')
      overlay.push(
        createWarningOverlayEntry({
          id: cell.id,
          position: Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat),
          title: `GPS jam ${Math.round(100 * cell.share)}%`,
          accent: '#ff3b30',
          priority: Math.round(100 * cell.share),
        }),
      );
  }
  for (const s of snapshot?.squawks ?? []) {
    const color = SQUAWK_COLORS[s.code] ?? '#ff9500';
    entities.push(
      warningPoint({
        id: `airspace-alerts:${s.id}`,
        name: `${s.code} ${s.meaning} ${s.flight ?? s.reg ?? ''}`.trim(),
        lon: s.lon,
        lat: s.lat,
        color,
        size: 12,
        properties: { kind: 'squawk', code: s.code, altFt: s.altFt },
      }),
    );
    overlay.unshift(
      createWarningOverlayEntry({
        id: s.id,
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
        title: `${s.code} ${s.flight ?? s.reg ?? ''}`.trim(),
        accent: color,
        priority: 10_000 + Number(s.code === '7500') * 1000,
      }),
    );
  }
  return {
    entities,
    overlay,
    count: (snapshot?.squawks?.length ?? 0) + (snapshot?.cells?.length ?? 0),
    summary: airspaceSummary(snapshot),
  };
}

/** Analyst rows for squawks and interference cells. */
export function airspaceRecords(snapshot) {
  return [
    ...(snapshot?.squawks ?? []).map((s) => ({
      kind: 'squawk',
      code: s.code,
      meaning: s.meaning,
      flight: s.flight,
      altFt: s.altFt,
      lat: s.lat,
      lon: s.lon,
    })),
    ...(snapshot?.cells ?? []).map((c) => ({
      kind: 'gps-interference',
      share: Math.round(100 * c.share) / 100,
      aircraft: c.total,
      lat: c.lat,
      lon: c.lon,
    })),
  ];
}

/** Aircraft squawking emergencies, and estimated GPS jamming from aircraft accuracy. */
export function createAirspaceAlertsLayer({
  overlayHost,
  fetchImpl,
  source,
} = {}) {
  return createFeedLayer({
    id: 'airspace-alerts',
    name: 'Airspace Emergencies & GPS Jamming',
    icon: '📡',
    sourceLabel: 'adsb.lol',
    updateInterval: 60_000,
    source: source ?? createFeedSource('airspace', { fetchImpl }),
    overlayHost,
    draw: drawAirspace,
    records: airspaceRecords,
  });
}
