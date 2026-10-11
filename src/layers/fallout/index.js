import * as Cesium from 'cesium';
import { doseContourLatLon, receptorDose, arrivalMinutes } from './model.js';
import { createFalloutWindSource } from './source.js';
export * from './model.js';
export { createFalloutWindSource } from './source.js';

import {
  DOSE_BANDS,
  YIELD_OPTIONS,
  HOUR_OPTIONS,
  PF_OPTIONS,
  WIND_MODES,
  TARGET_SETS,
  selectTargets,
  applyParams,
  defaultParams,
} from './bands.js';
export * from './bands.js';

/** Fallout layer: WSEG-10 dose bands draped on the globe for the chosen wind, yield and time. */
export function createFalloutLayer({
  data,
  fetchImpl,
  windSource = createFalloutWindSource({ fetchImpl, data }),
  now = () => new Date(),
} = {}) {
  if (!data?.house || !Array.isArray(data?.targets))
    throw new TypeError('Fallout layer requires sandy_bank.json');
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  let _wind = windSource.climatology(now());
  let _liveWind = null;
  let _liveError = null;
  let _loading = false;
  let _verdict = null;
  let _lastUpdate = null;
  const params = defaultParams();

  function effectiveWind() {
    if (params.windMode === 'manual')
      return {
        mode: 'manual',
        dir: params.manualDir,
        speedMph: params.manualSpeed,
        shearMphPerKft: 0.1,
        detail: 'Wind set by hand',
      };
    if (params.windMode === 'live' && _liveWind) return _liveWind;
    return windSource.climatology(now());
  }

  function rebuild() {
    if (!_dataSource) return;
    _wind = effectiveWind();
    const wind = _wind;
    const yieldMt = params.yieldKt / 1000;
    const targets = selectTargets(data.targets, params.targets);
    _dataSource.entities.removeAll();
    let outdoorR = 0;
    let firstArrivalH = null;
    let worst = null;
    for (const target of targets) {
      for (const band of DOSE_BANDS) {
        const ring = doseContourLatLon(target, wind.dir, {
          yieldMt,
          windMph: wind.speedMph,
          shearMphPerKft: wind.shearMphPerKft,
          hours: params.hours,
          thresholdR: band.r,
        });
        if (ring.length < 3) continue;
        const color = Cesium.Color.fromCssColorString(band.color);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `fallout:${target.name}:${band.r}`,
            name: `${target.name} · ${band.label}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(
                  ring.flatMap((p) => [p.lon, p.lat]),
                ),
              ),
              material: color.withAlpha(0.35),
              classificationType: Cesium.ClassificationType.BOTH,
            },
            properties: {
              target: target.name,
              thresholdR: band.r,
              hours: params.hours,
              yieldKt: params.yieldKt,
              windDir: wind.dir,
              windMph: wind.speedMph,
            },
          }),
        );
      }
      const dose = receptorDose({
        target,
        point: data.house,
        windFromDeg: wind.dir,
        windMph: wind.speedMph,
        shearMphPerKft: wind.shearMphPerKft,
        yieldMt,
        hours: params.hours,
        pf: params.pf,
      });
      if (dose.outdoorR > 1) {
        outdoorR += dose.outdoorR;
        if (firstArrivalH === null || dose.arrivalH < firstArrivalH)
          firstArrivalH = dose.arrivalH;
        if (!worst || dose.outdoorR > worst.outdoorR)
          worst = { ...dose, target: target.name };
      }
    }
    _verdict = {
      wind,
      yieldKt: params.yieldKt,
      hours: params.hours,
      pf: params.pf,
      targetCount: targets.length,
      outdoorR,
      shelterR: outdoorR / params.pf,
      arrivalMinutes:
        firstArrivalH === null ? null : Math.round(firstArrivalH * 60),
      worstTarget: worst?.target ?? null,
      updatedAt: now().toISOString(),
    };
    _lastUpdate = Date.now();
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'fallout',
    name: 'Fallout (WSEG-10)',
    icon: '☢',
    source: 'WSEG-10 · GFS upper wind',
    updateInterval: 1_800_000,

    init(viewer) {
      if (_viewer) throw new Error('Fallout layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('fallout');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      console.log('[Data:Fallout] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      rebuild();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      if (params.windMode !== 'live') return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      _loading = true;
      try {
        const wind = await windSource.live({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _liveWind = wind;
        _liveError = null;
        rebuild();
        return true;
      } catch (error) {
        if (request.signal.aborted) return false;
        _liveError = 'Upper wind unavailable · using the 32-year winter wind';
        rebuild();
        return false;
      } finally {
        if (_request === request) {
          _request = null;
          _loading = false;
        }
      }
    },

    destroy(viewer) {
      this.disable();
      if (_dataSource && viewer?.dataSources)
        viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
      _viewer = null;
    },

    setParams(next = {}) {
      const changed = applyParams(params, next);
      if (changed && _enabled) {
        rebuild();
        if (params.windMode === 'live' && !_liveWind) void this.update();
      }
      return changed;
    },

    getParams() {
      return { ...params };
    },

    /** The one answer the house layer and the HUD repeat. */
    getVerdict() {
      return _verdict ? { ..._verdict } : null;
    },

    getRowControls() {
      const v = _verdict;
      const windText = `${_wind.dir}° at ${Math.round(_wind.speedMph)} mph (${_wind.mode})`;
      const houseText = v
        ? v.arrivalMinutes === null
          ? 'Fallout misses the house on this wind'
          : `House: arrives in ${v.arrivalMinutes} min · ${Math.round(v.outdoorR).toLocaleString()} R outdoors · ${Math.round(v.shelterR).toLocaleString()} R at PF ${v.pf}`
        : 'Computing';
      return {
        readout: true,
        summary: {
          label: 'Fallout dose bands',
          coverage: `${v?.targetCount ?? 0} targets · ${params.hours} h after burst`,
          validTime: _wind.validIso ?? undefined,
          detail: `${windText} · ${_wind.detail}`,
          status: _loading ? 'Reading upper wind' : _liveError || houseText,
          units: 'R',
        },
        legend: DOSE_BANDS.map((b) => ({
          color: b.color,
          label: `${b.r.toLocaleString()} R`,
        })),
        chips: [
          ...YIELD_OPTIONS.map((kt) => ({
            id: `yield-${kt}`,
            label: `${kt} kt`,
            active: params.yieldKt === kt,
            params: { yieldKt: kt },
            title: 'Warhead yield per target',
          })),
          ...HOUR_OPTIONS.map((h) => ({
            id: `hours-${h}`,
            label: h < 24 ? `${h} h` : h < 168 ? `${h / 24} d` : `${h / 24} d`,
            active: params.hours === h,
            params: { hours: h },
            title: 'Dose accumulated from arrival to this time',
          })),
          ...PF_OPTIONS.map((pf) => ({
            id: `pf-${pf}`,
            label: `PF ${pf}`,
            active: params.pf === pf,
            params: { pf },
            title: data.pf?.[String(pf)] ?? 'Protection factor',
          })),
          ...WIND_MODES.map((mode) => ({
            id: `wind-${mode}`,
            label: {
              live: 'Live wind',
              climate: 'Winter average',
              manual: 'Set wind',
            }[mode],
            active: params.windMode === mode,
            params: { windMode: mode },
            title: {
              live: 'GFS 700/500/300 mb mean at the house, refreshed each 30 min',
              climate: 'ERA5 1990-2021 winter layer wind',
              manual: 'Direction and speed chosen by hand',
            }[mode],
          })),
          ...Object.entries(TARGET_SETS).map(([key, title]) => ({
            id: `targets-${key}`,
            label: {
              likely: 'Likely',
              military: 'Military',
              atlanta: 'Atlanta',
              all: 'All',
            }[key],
            active: params.targets === key,
            params: { targets: key },
            title,
          })),
        ],
      };
    },

    getAnalystRecords(maxCount = 200) {
      if (!_dataSource?.show || !_verdict) return [];
      const wind = _wind;
      const yieldMt = params.yieldKt / 1000;
      return selectTargets(data.targets, params.targets)
        .map((target) => {
          const dose = receptorDose({
            target,
            point: data.house,
            windFromDeg: wind.dir,
            windMph: wind.speedMph,
            shearMphPerKft: wind.shearMphPerKft,
            yieldMt,
            hours: params.hours,
            pf: params.pf,
          });
          return {
            layer: 'fallout',
            id: `fallout:${target.name}`,
            name: target.name,
            lat: target.lat,
            lon: target.lon,
            distanceMi: target.dist_mi,
            bearing: target.bearing,
            pHit: Math.max(target.p_cities ?? 0, target.p_counterforce ?? 0),
            arrivalMinutes: arrivalMinutes(dose),
            outdoorR: Math.round(dose.outdoorR),
            shelterR: Math.round(dose.shelterR),
          };
        })
        .sort((a, b) => b.outdoorR - a.outdoorR)
        .slice(0, maxCount);
    },

    getStats() {
      return {
        count: _dataSource?.entities?.values?.length ?? 0,
        lastUpdate: _lastUpdate,
        error: _liveError,
      };
    },
  };
  return layer;
}
