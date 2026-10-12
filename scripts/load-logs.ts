// Counts the function calls of a load run from Vercel's runtime logs (read only). See scripts/lib/load-logs.ts.
//   node scripts/load-logs.ts --deployment dpl_... --report load-results/<run>.json
//   node scripts/load-logs.ts --deployment dpl_... --since <iso time> --until <iso time>
import { runLoadLogs } from './lib/load-logs.ts';
import { realExec } from './lib/vercel.ts';

runLoadLogs(process.argv.slice(2), { exec: realExec(process.cwd()), now: Date.now, log: console.log }).then((code) => process.exit(code));
