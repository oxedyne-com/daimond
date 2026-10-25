/* ============================================================
   Test — one copy of the client API version (API-FLOOR).
   ------------------------------------------------------------
   THE FAULT (ccp6, 2026-10-26). The gateway raised MIN_CLIENT_API to 3.
   gateway.js moved to 3 with it, but debugshare.js, diag.js, lensshot.js
   and support.js each carried their own `CLIENT_API = 2`, and the console
   and the dev tools sent a literal '2'. Every post they made was refused
   426, and the lens went blind on every device.

   THE RULE. `var CLIENT_API = N` in www/js/gateway.js is the only place
   the number is written. A page module sends
   `String(DaimondGateway.clientApi())`, read when it sends. A Node-side
   dev tool imports `CLIENT_API` from dev/clientapi.mjs, which parses it
   out of gateway.js. This scans every .js, .mjs and .html under www/ and
   dev/ and fails on any other `x-daimond-api` value and on any second
   CLIENT_API-like constant.

   Run: node www/js/apiversion.test.mjs
   ============================================================ */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, ok, detail) {
	if (ok) { console.log('ok   ' + name); return; }
	failures++;
	console.log('FAIL ' + name + (detail ? '\n     ' + detail : ''));
}

function walk(dir, out) {
	for (const n of readdirSync(dir)) {
		if (n === 'node_modules' || n.startsWith('.')) continue;
		const p = join(dir, n);
		const s = statSync(p);
		if (s.isDirectory()) walk(p, out);
		else if (/\.(js|mjs|html)$/.test(n)) out.push(p);
	}
	return out;
}

const files = walk(join(ROOT, 'www'), []).concat(walk(join(ROOT, 'dev'), []));
const SELF = 'www/js/apiversion.test.mjs';

// The values a header may carry. A page reads the live module; Node reads the
// import from dev/clientapi.mjs; gateway.js reads its own constant.
const PAGE_OK = /^String\((?:window\.)?DaimondGateway\.clientApi\(\)\)/;
const ALIAS_OK = /^String\((\w+)\.clientApi \? \1\.clientApi\(\) : ''\)/;	// `g = window.DaimondGateway`
const CONST_OK = /^String\(CLIENT_API\)/;
const DERIVED = /^String\((\w+)\b/;					// a local read from clientApi()

// `'x-daimond-api': v`, `['x-daimond-api'] = v`, `.set('x-daimond-api', v)`.
const HEADER = /['"`]x-daimond-api['"`]\s*(?:\]\s*=(?!=)|:|,)\s*([^\n]*)/gi;
// A second constant: `CLIENT_API = 2`, `clientApi = '2'`, `API_VERSION: 2`.
const CONST = /\b(\w*(?:CLIENT_?API|clientApi|API_VERSION)\w*)\s*[:=]\s*['"]?\d/g;

let headers = 0;
for (const p of files) {
	const rel = relative(ROOT, p);
	if (rel === SELF) continue;
	const src = readFileSync(p, 'utf8');
	const isGw = rel === 'www/js/gateway.js';
	const imports = /import\s*\{[^}]*\bCLIENT_API\b[^}]*\}\s*from\s*['"]\.\/clientapi\.mjs['"]/.test(src);
	const isLib = rel === 'dev/clientapi.mjs';
	const line = (i) => src.slice(0, i).split('\n').length;

	for (const m of src.matchAll(HEADER)) {
		const lineAt = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index) >>> 0);
		if (/^\s*(?:\/\/|\*|\/\*)/.test(lineAt)) continue;		// prose in a comment
		// A unit test's deliberate foreign value, marked as such on its line.
		if (rel.endsWith('.test.mjs') && /\/\/ fixture: not this build's version/.test(lineAt)) continue;
		headers++;
		const v = m[1].trim();
		let ok = PAGE_OK.test(v) || ALIAS_OK.test(v) || ((isGw || imports) && CONST_OK.test(v));
		if (!ok) {
			// A local that was itself read from clientApi() in this file (a
			// fixture one above the build, say) is still the one number.
			const d = DERIVED.exec(v);
			if (d && d[1] !== 'CLIENT_API'
				&& new RegExp('\\b' + d[1] + '\\s*=\\s*[^;\\n]*clientApi\\(\\)').test(src)) ok = true;
		}
		check(rel + ':' + line(m.index) + ' sends the one version', ok, v.slice(0, 100));
	}

	for (const m of src.matchAll(CONST)) {
		const at = rel + ':' + line(m.index);
		// Prose about an old copy, in a comment, is not a copy.
		const ln = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
		if (/^\s*(?:\/\/|\*|\/\*)/.test(ln) || /`[^`]*$/.test(ln)) continue;
		// A test's stand-in DaimondGateway (`clientApi: () => 9`) is not a copy.
		if (/=>/.test(src.slice(m.index, m.index + m[0].length + 4))) continue;
		const ok = (isGw && m[1] === 'CLIENT_API') || (isLib && m[1] === 'CLIENT_API');
		check(at + ' holds no second ' + m[1], ok, src.slice(m.index, m.index + 60).split('\n')[0]);
	}
}

const gw = readFileSync(join(ROOT, 'www/js/gateway.js'), 'utf8');
check('gateway.js defines CLIENT_API exactly once', (gw.match(/\bvar CLIENT_API\s*=\s*\d+;/g) || []).length === 1);
check('gateway.js exports clientApi()', /clientApi:\s*function \(\) \{ return CLIENT_API; \}/.test(gw));
check('the scan found header sites at all (' + headers + ')', headers > 50);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall apiversion checks passed');
process.exit(failures ? 1 : 0);
