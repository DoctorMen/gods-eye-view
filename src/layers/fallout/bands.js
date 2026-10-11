/** Dose bands, option lists and target selection: no Cesium, so unit-testable. */

/** Accumulated dose bands, R, outdoors on level ground (before PF). */
export const DOSE_BANDS = Object.freeze([
  Object.freeze({
    r: 3000,
    color: '#5b0a1a',
    label: '3,000 R · lethal in hours outdoors',
  }),
  Object.freeze({
    r: 1000,
    color: '#b3121f',
    label: '1,000 R · lethal outdoors',
  }),
  Object.freeze({
    r: 450,
    color: '#e8541c',
    label: '450 R · half die without care',
  }),
  Object.freeze({ r: 100, color: '#f2a93b', label: '100 R · sickness begins' }),
  Object.freeze({ r: 25, color: '#f7d774', label: '25 R · stay inside' }),
]);

export const YIELD_OPTIONS = Object.freeze([100, 250, 500, 800]);
export const HOUR_OPTIONS = Object.freeze([1, 6, 24, 48, 168, 336]);
export const PF_OPTIONS = Object.freeze([1, 2.5, 10, 40]);
export const WIND_MODES = Object.freeze(['live', 'climate', 'manual']);
export const TARGET_SETS = Object.freeze({
  likely: 'Likely (cities and bases, within 150 mi)',
  military: 'Military only',
  atlanta: 'Atlanta and Dobbins only',
  all: 'Every listed target',
});

export function selectTargets(targets, set) {
  switch (set) {
    case 'military':
      return targets.filter((t) => t.cls === 'mil');
    case 'atlanta':
      return targets.filter((t) => /atlanta|dobbins|hartsfield/i.test(t.name));
    case 'all':
      return targets;
    default:
      return targets.filter(
        (t) =>
          t.dist_mi <= 150 &&
          Math.max(t.p_cities ?? 0, t.p_counterforce ?? 0) >= 0.5,
      );
  }
}

/** Validate and merge a params patch; returns true when anything changed. */
export function applyParams(params, next = {}) {
  let changed = false;
  const pick = (key, allowed) => {
    if (
      next[key] !== undefined &&
      allowed(next[key]) &&
      next[key] !== params[key]
    ) {
      params[key] = next[key];
      changed = true;
    }
  };
  pick('yieldKt', (v) => YIELD_OPTIONS.includes(v));
  pick('hours', (v) => HOUR_OPTIONS.includes(v));
  pick('pf', (v) => PF_OPTIONS.includes(v));
  pick('windMode', (v) => WIND_MODES.includes(v));
  pick('manualDir', (v) => Number.isFinite(v) && v >= 0 && v < 360);
  pick('manualSpeed', (v) => Number.isFinite(v) && v >= 5 && v <= 150);
  pick('targets', (v) => Object.hasOwn(TARGET_SETS, v));
  return changed;
}

export function defaultParams() {
  return {
    yieldKt: 500,
    hours: 336,
    pf: 10,
    windMode: 'live',
    manualDir: 264,
    manualSpeed: 60,
    targets: 'likely',
  };
}
