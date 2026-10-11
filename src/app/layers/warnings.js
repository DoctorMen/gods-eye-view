import {
  createEmergencyAlertsLayer,
  createAirspaceAlertsLayer,
  createGlobalDisastersLayer,
  createRadiationWatchLayer,
  createSurvivalResourcesLayer,
} from '../../layers/warnings/index.js';
import { overlayHost } from './overlayHost.js';
import sandyBankData from '../../data/local_data/sandy_bank/sandy_bank.json' with { type: 'json' };
import nuclearPlants from '../../data/local_data/nuclear_plants/nuclear_plants.json' with { type: 'json' };

/** Wire the Sandy Bank warning layers to the application overlay host. */
export function createApplicationWarningLayers(options = {}) {
  const house = sandyBankData.house;
  return [
    createEmergencyAlertsLayer({ overlayHost, house, ...options }),
    createAirspaceAlertsLayer({ overlayHost, ...options }),
    createGlobalDisastersLayer({ overlayHost, ...options }),
    createRadiationWatchLayer({
      overlayHost,
      plants: nuclearPlants,
      ...options,
    }),
    createSurvivalResourcesLayer({ overlayHost, house, ...options }),
  ];
}
