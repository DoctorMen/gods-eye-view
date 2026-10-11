import { createFalloutLayer } from '../../layers/fallout/index.js';
import sandyBankData from '../../data/local_data/sandy_bank/sandy_bank.json' with { type: 'json' };
/** Wire the Sandy Bank fallout layer to the bundled house data and the local upper-wind route. */
export function createApplicationFallout(options = {}) {
  return createFalloutLayer({ data: sandyBankData, ...options });
}
