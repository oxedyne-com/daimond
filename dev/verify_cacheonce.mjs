// gateway: none
// verify_cacheonce.mjs -- the release arm for D-20261020-11 (r578f, QA r578e C3): past the line the
// prompt is shortened ONCE and then appends until the summary, across a reload.  Runs
// `dev/qa_r578a_probe.mjs reads`, whose run crosses the line, and passes its ok/FAIL lines and exit
// code through, so `dk arms` counts the checks it made.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [path.join(HERE, 'qa_r578a_probe.mjs'), 'reads', ...process.argv.slice(2)],
	{ stdio: 'inherit', env: process.env });
process.exit(r.status === null ? 1 : r.status);
