import { fetchUpperWind } from './sandyBank/upperWind.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

/**
 * Sandy Bank Watch: bounded, cached upper-wind readings for the fallout layer.
 * GET /api/sandy-bank/upper-wind?lat=34.02&lon=-83.88
 * The point is rounded to 0.25° (the GFS grid) so the cache key is small.
 */
export function sandyBankProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = 3600_000,
  timeoutMs = 40_000,
  fetchWind = fetchUpperWind,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function acquire(key, load) {
    const previous = cache.get(key);
    if (previous && now() - previous.at < ttlMs)
      return { value: previous.value, stale: false };
    if (inFlight.has(key))
      return { value: await inFlight.get(key), stale: false };
    const promise = load();
    inFlight.set(key, promise);
    try {
      const value = await promise;
      cache.set(key, { value, at: now() });
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return { value, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    } finally {
      inFlight.delete(key);
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/upper-wind')
      return json(404, { error: 'unknown_route' });
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180))
      return json(400, { error: 'invalid_point' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const qlat = Math.round(lat * 4) / 4;
    const qlon = Math.round(lon * 4) / 4;
    const key = `${qlat},${qlon}`;
    try {
      const { value, stale } = await acquire(key, () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetchWind({
          lat: qlat,
          lon: qlon,
          fetchImpl,
          now,
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
      });
      json(200, stale ? { ...value, stale: true } : value, stale);
    } catch {
      json(502, { error: 'upper_wind_unavailable' });
    }
  }

  return {
    name: 'sandy-bank',
    configureServer({ middlewares }) {
      middlewares.use('/api/sandy-bank', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sandy-bank', handler);
    },
  };
}
