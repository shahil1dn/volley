// Preloaded into every test file by `npm test` (--import): stops the run
// before any test can connect if a setting points at production.
import { refuseProduction } from '../scripts/production-guard.ts';

refuseProduction(process.env, 'the tests');
