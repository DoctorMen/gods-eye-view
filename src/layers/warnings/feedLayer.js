import * as Cesium from 'cesium';

/** World-overlay label; layer text never goes through Cesium labels. */
export function createWarningOverlayEntry({
  id,
  position,
  title,
  accent,
  priority,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** GET one Sandy Bank feed from the local server. */
export function createFeedSource(
  name,
  { fetchImpl = (...args) => globalThis.fetch(...args) } = {},
) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/sandy-bank/feeds/${name}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`${name} feed HTTP ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      return body;
    },
  };
}

/**
 * Shared lifecycle for the Sandy Bank warning layers.
 *
 * `draw(snapshot)` returns `{ entities, overlay, count, summary }` built from a
 * complete snapshot; the old picture is only replaced after a good snapshot.
 * `records(snapshot)` returns analyst rows (plain JSON objects).
 */
export function createFeedLayer({
  id,
  name,
  icon,
  sourceLabel,
  updateInterval,
  source,
  overlayHost,
  draw,
  records = () => [],
  cohortLimit = 96,
}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(`${id} requires a snapshot source`);
  if (!overlayHost) throw new TypeError(`${id} requires an overlay host`);
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _snapshot = null;
  let _count = 0;
  let _summary = null;
  let _lastUpdate = null;
  let _lastError = null;

  return {
    id,
    name,
    icon,
    source: sourceLabel,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${id} layer is already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(id, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(id, true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const picture = draw(snapshot);
        _dataSource.entities.removeAll();
        for (const entity of picture.entities) _dataSource.entities.add(entity);
        overlayHost.setEntries(id, picture.overlay.slice(0, cohortLimit), {
          cohortLimit,
          collisionCapacity: Math.min(64, cohortLimit),
          moving: false,
        });
        _snapshot = snapshot;
        _count = picture.count;
        _summary = picture.summary ?? null;
        _lastUpdate = Date.now();
        _lastError = snapshot?.stale ? 'showing last good data' : null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(`[Data:${id}] Fetch error:`, e);
        _lastError = e?.message || `${name} unavailable`;
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
      if (_dataSource && viewer) viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
      _snapshot = null;
      _count = 0;
      _summary = null;
      _lastUpdate = null;
      _lastError = null;
    },

    /** Plain-text one-liner of what the layer currently shows. */
    getSummary() {
      return _summary;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_snapshot) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      return records(_snapshot).slice(0, limit);
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        summary: _summary,
      };
    },
  };
}

/** Ground-clamped dot used by every warning layer. */
export function warningPoint({ id, name, lon, lat, color, size, properties }) {
  return new Cesium.Entity({
    id,
    name,
    position: Cesium.Cartesian3.fromDegrees(lon, lat),
    point: {
      pixelSize: size,
      color: Cesium.Color.fromCssColorString(color),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    properties,
  });
}

/** Ground-clamped ring (circle) in metres. */
export function warningRing({
  id,
  name,
  lon,
  lat,
  radiusM,
  color,
  fill = 0.06,
}) {
  const c = Cesium.Color.fromCssColorString(color);
  return new Cesium.Entity({
    id,
    name,
    position: Cesium.Cartesian3.fromDegrees(lon, lat),
    ellipse: {
      semiMajorAxis: radiusM,
      semiMinorAxis: radiusM,
      material: c.withAlpha(fill),
      outline: true,
      outlineColor: c.withAlpha(0.9),
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  });
}

/** Ground-clamped polygon from a [[lon,lat],...] ring. */
export function warningPolygon({
  id,
  name,
  ring,
  color,
  fill = 0.25,
  properties,
}) {
  const c = Cesium.Color.fromCssColorString(color);
  return new Cesium.Entity({
    id,
    name,
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray(ring.flat()),
      material: c.withAlpha(fill),
      outline: false,
      classificationType: Cesium.ClassificationType.BOTH,
    },
    properties,
  });
}

/** Ground-clamped rectangle from degree bounds. */
export function warningRectangle({
  id,
  name,
  west,
  south,
  east,
  north,
  color,
  fill,
  properties,
}) {
  return new Cesium.Entity({
    id,
    name,
    rectangle: {
      coordinates: Cesium.Rectangle.fromDegrees(west, south, east, north),
      material: Cesium.Color.fromCssColorString(color).withAlpha(fill),
      classificationType: Cesium.ClassificationType.BOTH,
    },
    properties,
  });
}
