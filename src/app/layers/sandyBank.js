import { createSandyBankLayer } from '../../layers/sandyBank/index.js';
import { overlayHost } from './overlayHost.js';
import sandyBankData from '../../data/local_data/sandy_bank/sandy_bank.json' with { type: 'json' };
/** Wire the Sandy Bank house layer; `fallout` is the application fallout layer instance. */
export function createApplicationSandyBank({ fallout, ...options } = {}) {
  return createSandyBankLayer({
    data: sandyBankData,
    fallout,
    overlayHost,
    ...options,
  });
}
