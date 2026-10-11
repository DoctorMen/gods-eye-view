import * as Cesium from 'cesium';
import {
  createFeedLayer,
  createFeedSource,
  createWarningOverlayEntry,
  warningPoint,
  warningPolygon,
} from './feedLayer.js';

/** Fill colour for one alert: "act now" events stand apart from weather. */
export function alertColor(row) {
  if (row.critical) return '#ff2bd6';
  return (
    {
      Extreme: '#ff3b30',
      Severe: '#ff9500',
      Moderate: '#ffd60a',
      Minor: '#5ac8fa',
    }[row.severity] ?? '#8e8e93'
  );
}

/** One-line state of the alert feed for the house. */
export function alertSummary(snapshot) {
  const rows = snapshot?.rows ?? [];
  const home = rows.filter((r) => r.atHouse);
  const critical = rows.filter((r) => r.critical);
  const parts = [`${rows.length} active US alerts`];
  if (critical.length) parts.push(`${critical.length} act-now`);
  parts.push(
    snapshot?.houseChecked === false
      ? 'house check unavailable'
      : home.length
        ? `AT THE HOUSE: ${home.map((r) => r.event).join(', ')}`
        : 'none at the house',
  );
  const space = snapshot?.space;
  if (space)
    parts.push(
      `space weather Kp ${space.kp}${space.gScale ? ` (G${space.gScale} storm)` : ''}`,
    );
  return parts.join(' · ');
}

/** Build the alert picture from a feed snapshot. */
export function drawAlerts(snapshot, { house }) {
  const rows = snapshot?.rows ?? [];
  const entities = [];
  const overlay = [];
  for (const row of rows) {
    const color = alertColor(row);
    row.rings.forEach((ring, k) =>
      entities.push(
        warningPolygon({
          id: `emergency-alerts:${row.id}:${k}`,
          name: row.headline ?? row.event,
          ring,
          color,
          fill: row.critical ? 0.4 : 0.22,
          properties: { event: row.event, severity: row.severity },
        }),
      ),
    );
    if (row.center && (row.critical || row.severity === 'Extreme'))
      overlay.push(
        createWarningOverlayEntry({
          id: row.id,
          position: Cesium.Cartesian3.fromDegrees(row.center[0], row.center[1]),
          title: row.event,
          accent: color,
          priority: 1000 * row.rank,
        }),
      );
  }
  const home = rows.filter((r) => r.atHouse);
  const space = snapshot?.space;
  const homeTitle = home.length
    ? `HOME: ${home[0].event}${home.length > 1 ? ` +${home.length - 1}` : ''}`
    : space?.gScale >= 3
      ? `HOME: G${space.gScale} geomagnetic storm`
      : null;
  if (homeTitle && house) {
    const color = home.length ? alertColor(home[0]) : '#ff9500';
    entities.push(
      warningPoint({
        id: 'emergency-alerts:house',
        name: homeTitle,
        lon: house.lon,
        lat: house.lat,
        color,
        size: 14,
      }),
    );
    overlay.unshift(
      createWarningOverlayEntry({
        id: 'house',
        position: Cesium.Cartesian3.fromDegrees(house.lon, house.lat),
        title: homeTitle,
        accent: color,
        priority: 1_000_000,
      }),
    );
  }
  return {
    entities,
    overlay,
    count: rows.length,
    summary: alertSummary(snapshot),
  };
}

/** Analyst rows for the alert feed. */
export function alertRecords(snapshot) {
  return (snapshot?.rows ?? []).map((r) => ({
    event: r.event,
    severity: r.severity,
    actNow: r.critical,
    atHouse: Boolean(r.atHouse),
    area: r.area,
    expires: r.expires,
    lat: r.center?.[1] ?? null,
    lon: r.center?.[0] ?? null,
  }));
}

/** NWS emergency and weather alerts, alerts at the house, and space weather. */
export function createEmergencyAlertsLayer({
  overlayHost,
  house,
  fetchImpl,
  source,
} = {}) {
  return createFeedLayer({
    id: 'emergency-alerts',
    name: 'Emergency Alerts (US)',
    icon: '🚨',
    sourceLabel: 'NWS / NOAA SWPC',
    updateInterval: 120_000,
    source: source ?? createFeedSource('alerts', { fetchImpl }),
    overlayHost,
    draw: (snapshot) => drawAlerts(snapshot, { house }),
    records: alertRecords,
  });
}
