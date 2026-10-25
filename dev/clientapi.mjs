// dev/clientapi.mjs -- API-FLOOR (2026-10-26). The client API version for a dev tool's
// Node-side request, parsed from `var CLIENT_API = N;` in www/js/gateway.js, the one place
// it is written. A tool's in-page request reads `DaimondGateway.clientApi()` instead; the
// scan in www/js/apiversion.test.mjs refuses any third copy. Also the gateway's floor,
// `MIN_CLIENT_API` in gateway/src/handlers/common.rs, for a check that holds the two apart.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel, re, what) {
	const m = re.exec(readFileSync(join(ROOT, rel), 'utf8'));
	if (!m) throw new Error('clientapi: no ' + what + ' in ' + rel);
	return Number(m[1]);
}

export const CLIENT_API     = read('www/js/gateway.js', /\bvar CLIENT_API\s*=\s*(\d+);/, 'CLIENT_API');
export const MIN_CLIENT_API = read('gateway/src/handlers/common.rs', /pub const MIN_CLIENT_API:\s*u32\s*=\s*(\d+);/, 'MIN_CLIENT_API');
