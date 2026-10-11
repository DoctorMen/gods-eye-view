/**
 * Effective fallout wind for the fallout layer.
 *
 * Live: the local server's /api/sandy-bank/upper-wind reading (700/500/300 mb
 * GFS, vector mean). Climatology: the 32-year ERA5 winter layer wind bundled in
 * sandy_bank.json, used before the live reading arrives, when the server has
 * no upstream, or when the user asks for the planning wind.
 */
export function createFalloutWindSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  data,
} = {}) {
  if (!data?.house || !data?.winds?.DJF_layer)
    throw new TypeError('Fallout wind source requires sandy_bank.json');

  function climatology(now = new Date()) {
    const month = String(now.getMonth() + 1);
    const monthly = data.winds.monthly?.[month];
    const layer = data.winds.DJF_layer;
    return {
      mode: 'climate',
      dir: Math.round(layer.vdir),
      speedMph: Number(monthly?.p50 ?? layer.p50),
      shearMphPerKft: 0.1,
      detail: `ERA5 1990-2021 winter layer wind · ${layer.sw}% of days from 225-285°`,
      validIso: null,
    };
  }

  async function live({ signal } = {}) {
    const { lat, lon } = data.house;
    const query = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    const response = await fetchImpl(`/api/sandy-bank/upper-wind?${query}`, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`upper wind ${response.status}`);
    const body = await response.json();
    if (!body?.layer || !Number.isFinite(body.layer.speedMph))
      throw new Error('upper wind payload invalid');
    return {
      mode: 'live',
      dir: body.layer.dir,
      speedMph: body.layer.speedMph,
      shearMphPerKft: Math.min(
        0.5,
        Math.max(0.03, body.layer.shearMphPerKft ?? 0.1),
      ),
      levels: body.levels,
      validIso: body.cycle?.validIso ?? null,
      stale: body.stale === true,
      detail: `GFS ${body.cycle?.date ?? ''} ${String(body.cycle?.hour ?? '').padStart(2, '0')}Z +${body.cycle?.forecastHour ?? 0} h · 700/500/300 mb mean`,
    };
  }

  return { climatology, live };
}
