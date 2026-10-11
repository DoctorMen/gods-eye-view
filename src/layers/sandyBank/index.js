import * as Cesium from 'cesium';

const MI_TO_M = 1609.344;
export const SANDY_BANK_OVERLAY_SOURCE_ID = 'sandy-bank';

/** Format a share of wars as a percentage string. */
export function pct(x, digits = 0) {
  return Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : '—';
}

/** World-overlay label for the house or a target; text never goes through Cesium labels. */
export function createSandyBankOverlayEntry({
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

/**
 * Sandy Bank house layer: the house, its two-mile ring, the target pins with
 * their chance of being hit, and the shelter verdict that repeats what the
 * fallout layer computed for this house. Enabling it flies the camera home.
 */
export function createSandyBankLayer({ data, fallout, overlayHost } = {}) {
  if (!data?.house || !Array.isArray(data?.targets))
    throw new TypeError('Sandy Bank layer requires sandy_bank.json');
  if (!overlayHost)
    throw new TypeError('Sandy Bank layer requires an overlay host');
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _flown = false;
  let _overlayEntries = [];
  const house = data.house;
  const odds = data.odds ?? {};

  function build() {
    _dataSource.entities.removeAll();
    _overlayEntries = [];
    const position = Cesium.Cartesian3.fromDegrees(house.lon, house.lat);
    const homeColor = Cesium.Color.fromCssColorString('#2ec4b6');
    _overlayEntries.push(
      createSandyBankOverlayEntry({
        id: 'house',
        position,
        title: 'HOME',
        accent: '#2ec4b6',
        priority: 1_000_000,
      }),
    );
    _dataSource.entities.add(
      new Cesium.Entity({
        id: 'sandy-bank:house',
        name: house.address,
        position,
        point: {
          pixelSize: 12,
          color: homeColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { kind: 'house', elevFt: house.elev_ft },
      }),
    );
    _dataSource.entities.add(
      new Cesium.Entity({
        id: 'sandy-bank:ring',
        name: 'Two-mile ring',
        position,
        ellipse: {
          semiMajorAxis: 2 * MI_TO_M,
          semiMinorAxis: 2 * MI_TO_M,
          material: homeColor.withAlpha(0.08),
          outline: true,
          outlineColor: homeColor.withAlpha(0.9),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      }),
    );
    for (const t of data.targets) {
      const p = Math.max(t.p_cities ?? 0, t.p_counterforce ?? 0);
      const color = t.cls === 'mil' ? '#ff5d5d' : '#ffb347';
      const targetPosition = Cesium.Cartesian3.fromDegrees(t.lon, t.lat);
      _overlayEntries.push(
        createSandyBankOverlayEntry({
          id: `target:${t.name}`,
          position: targetPosition,
          title: `${t.name} · ${Math.round(100 * p)}%`,
          accent: color,
          priority: Math.round(1000 * p),
        }),
      );
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `sandy-bank:target:${t.name}`,
          name: t.name,
          position: targetPosition,
          point: {
            pixelSize: 6 + 8 * p,
            color: Cesium.Color.fromCssColorString(color),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            kind: 'target',
            cls: t.cls,
            distanceMi: t.dist_mi,
            bearing: t.bearing,
            pCities: t.p_cities,
            pCounterforce: t.p_counterforce,
          },
        }),
      );
    }
  }

  function publishOverlay() {
    overlayHost.setEntries(SANDY_BANK_OVERLAY_SOURCE_ID, _overlayEntries, {
      cohortLimit: 64,
      collisionCapacity: 64,
      moving: false,
    });
    overlayHost.setVisible(SANDY_BANK_OVERLAY_SOURCE_ID, true);
  }

  function flyHome() {
    const camera = _viewer?.camera;
    if (!camera?.flyTo || _flown) return;
    _flown = true;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        house.lon - 0.25,
        house.lat - 0.45,
        70_000,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(20),
        pitch: Cesium.Math.toRadians(-40),
        roll: 0,
      },
      duration: 3,
    });
  }

  const layer = {
    id: 'sandy-bank',
    name: 'Sandy Bank house',
    icon: '⌂',
    source: 'Sandy Bank Monte Carlo v3',
    updateInterval: 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Sandy Bank layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sandy-bank');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost.setVisible(SANDY_BANK_OVERLAY_SOURCE_ID, false);
      build();
      console.log('[Data:SandyBank] Initialized');
    },
    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      publishOverlay();
      flyHome();
      _viewer?.scene?.requestRender?.();
    },
    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(SANDY_BANK_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(SANDY_BANK_OVERLAY_SOURCE_ID, false);
    },
    async update() {
      // Nothing to fetch; the verdict is read live from the fallout layer.
      return _enabled;
    },
    destroy(viewer) {
      this.disable();
      if (_dataSource && viewer?.dataSources)
        viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
    },
    setParams(next = {}) {
      if (next.flyHome === true) {
        _flown = false;
        flyHome();
        return true;
      }
      return false;
    },
    getParams() {
      return {};
    },
    getRowControls() {
      const v = fallout?.getVerdict?.() ?? null;
      const plans = odds.plans ?? {};
      const guide = plans['Guide plan as written'];
      const full = plans['Full plan'];
      const rule = v
        ? v.arrivalMinutes === null
          ? 'This wind carries fallout away from the house. Still shelter: the wind can turn.'
          : `Be in the shelter corner within ${Math.max(10, v.arrivalMinutes - 10)} min. ${Math.round(v.shelterR).toLocaleString()} R behind PF ${v.pf} over ${v.hours} h.`
        : 'Turn on Fallout for the shelter clock.';
      return {
        readout: true,
        summary: {
          label: house.address,
          coverage: `${house.elev_ft} ft · ${data.targets.length} targets listed`,
          detail: `Dangerous fallout in ${pct(odds.p_heavy)} of 1,000,000 wars · whole family alive at two years: guide plan ${pct(guide?.two)}, full plan ${pct(full?.two)}`,
          status: rule,
        },
        chips: [
          {
            id: 'fly-home',
            label: 'Fly home',
            active: false,
            params: { flyHome: true },
            title: 'Return the camera to the house',
          },
        ],
      };
    },
    getAnalystRecords(maxCount = 100) {
      if (!_dataSource?.show) return [];
      const v = fallout?.getVerdict?.();
      return [
        {
          layer: 'sandy-bank',
          id: 'sandy-bank:house',
          name: house.address,
          lat: house.lat,
          lon: house.lon,
          elevFt: house.elev_ft,
          falloutArrivalMinutes: v?.arrivalMinutes ?? null,
          outdoorR: v ? Math.round(v.outdoorR) : null,
          shelterR: v ? Math.round(v.shelterR) : null,
          pHeavyFallout: odds.p_heavy ?? null,
        },
      ].slice(0, maxCount);
    },
    getStats() {
      return {
        count: _dataSource?.entities?.values?.length ?? 0,
        lastUpdate: null,
        error: null,
      };
    },
  };
  return layer;
}
