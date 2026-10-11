# Sandy Bank Watch

Two layers and one server route that turn God's Eye View into the warning-period
console for one house: 3587 Sandy Bank Dr, Auburn GA. They were built from the
Sandy Bank simulation work (one million simulated US–Russia nuclear wars scored
at that house) and share its data file.

Everything here needs internet and a running dev server. The offline, no-power
version of the same answers is the printed Sandy Bank Command View; this is the
tool for the hours or days of warning before the power goes.

## What you get

| Layer | Share token | What it draws |
| --- | --- | --- |
| **Fallout (WSEG-10)** `fallout` | `3` | Accumulated-dose bands (25, 100, 450, 1,000, 3,000 R) draped on the globe for every likely target, for the chosen warhead yield, time after burst (1 h to 14 days), protection factor and wind. The row readout gives the house verdict: minutes until fallout arrives, dose outdoors and dose behind the chosen PF. |
| **Sandy Bank house** `sandy-bank` | `4` | The house, a two-mile ring, every listed target with its chance of being hit, and the shelter rule ("be in the corner within N minutes"). Enabling it flies the camera home. |

Wind choices in the Fallout row:

- **Live wind**: the local server reads the current GFS forecast at the 700, 500
  and 300 mb levels (about 10,000, 18,000 and 30,000 ft) for the house and
  averages them. Fallout rides these winds, not the 10 m wind the Wind layer
  shows. Refreshes every 30 minutes.
- **Winter average**: the 32-year ERA5 layer wind (264° at about 60 mph, 76% of
  winter days from the south-west quarter).
- **Set wind**: a direction and speed you choose (voice or `setParams`).

## Server route

`GET /api/sandy-bank/upper-wind?lat=34.02&lon=-83.88`

```json
{
  "cycle": { "date": "20261010", "hour": 18, "forecastHour": 8, "validIso": "..." },
  "levels": [
    { "mb": 700, "feet": 10000, "dir": 181, "speedMph": 59.6 },
    { "mb": 500, "feet": 18000, "dir": 193, "speedMph": 69.0 },
    { "mb": 300, "feet": 30000, "dir": 209, "speedMph": 81.1 }
  ],
  "layer": { "dir": 196, "speedMph": 68.5, "shearMphPerKft": 0.21 }
}
```

It reuses the Wind layer's GFS catalog, index, byte-range and ecCodes decode
helpers, so no new upstream host is introduced (public bucket
`noaa-gfs-bdp-pds`). Cached one hour per 0.25° point; rate limited.

## The model

`src/layers/fallout/model.js` is a line-for-line port of the checked WSEG-10
code (Hanifen 1980, DTIC ADA083515; Glasstone & Dolan 1977 ch. IX). Its unit
tests pin it to the Python reference values within 1e-5. Doses are outdoor,
level-ground (terrain factor 0.7), accumulated from arrival to the chosen time
with t^-1.2 decay, divided by the protection factor.

Protection factors offered: 1 (outdoors), 2.5 (ground floor as it stands),
10 (stacked-mass corner), 40 (earth-walled room, 18 in all round).

## Files

```
server/providers/sandyBank.js                 route plugin
server/providers/sandyBank/upperWind.js       GFS upper-wind fetch + sampling
src/layers/fallout/{model,bands,source,index}.js
src/layers/sandyBank/index.js
src/app/layers/{fallout,sandyBank}.js         application wiring
src/data/local_data/sandy_bank/sandy_bank.json house, targets, winds, odds
```

Registered in `src/app/constructCatalog.js`, `src/data/layerState.js`,
`src/data/layerStateTokenReservations.json`, `src/voice/layerManifest.js` and
`server/providers/local.js`.

## Running it

```sh
npm install
npm run dev          # Node 24 required by the project
```

Open the app, turn on **Sandy Bank house** (the camera flies home) and
**Fallout (WSEG-10)**. Pick the yield and time; watch the house readout.
Say "turn on the fallout layer" or "show me the house" if voice is set up.

## Data notice

`sandy_bank.json` holds one private address and model output for one family.
It is here because the fork exists for that family. Replace the `house` and
`targets` entries to use the layers elsewhere.
