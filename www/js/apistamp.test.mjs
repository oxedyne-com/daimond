/* ============================================================
   Test — every /api request leaves the page with its version (API-FLOOR 2).
   ------------------------------------------------------------
   THE FAULT. dev/probe_apifloor.mjs, watching the wire, found GET
   /api/policy (trash.js) and GET /api/tools (tools.js, through gwFetch)
   with no `x-daimond-api` at all, and telemetry.js and web.js's `gw()`
   build theirs the same way. The gateway reads a missing version as
   current, so a tab days behind the floor was never told so on them.

   THE RULE. `guardFetch`, the last point before a request leaves the
   page, stamps `x-daimond-api: CLIENT_API` on every same-origin /api/
   request that does not carry one, and leaves a caller's own value and
   every other path alone. Run it red with MM_SRC_REV=680c7a521.

   Run: node www/js/apistamp.test.mjs
   ============================================================ */
import { source, liftFn } from './testlift.mjs';

let failures = 0;
function check(name, ok, detail) {
	if (ok) { console.log('ok   ' + name); return; }
	failures++;
	console.log('FAIL ' + name + (detail ? '\n     ' + detail : ''));
}

const src = source('gateway.js');
const decl = (n) => (new RegExp('\\n\\t+(var ' + n + '\\s+= [^;]*;)').exec(src) || [])[1] || '';
const sent = [];
const win = {
	fetch: (input, init) => { sent.push({ input, init }); return Promise.resolve({ ok: true, status: 200 }); },
};
const body = [decl('CLIENT_API'), decl('HDR_API'), liftFn(src, 'roadMark'), liftFn(src, 'withApi'),
	liftFn(src, 'guardFetch')].join('\n');
const api = new Function('window', 'location', 'spendRefusal', 'refusedReply', 'Headers',
	body + '\nguardFetch();\nreturn typeof CLIENT_API === "undefined" ? null : CLIENT_API;')(
	win, { origin: 'https://daimond.test' }, () => null, () => ({}), Headers);

check('gateway.js has one CLIENT_API to stamp', api === Number(api) && api > 0, String(api));
const hdr = (i) => {
	const h = sent[i] && sent[i].init && sent[i].init.headers;
	if (!h) return undefined;
	return typeof h.get === 'function' ? (h.get('x-daimond-api') ?? undefined) : h['x-daimond-api'];
};

await win.fetch('/api/policy', { headers: { accept: 'application/json' } });
check('a headerless /api GET carries the version', hdr(0) === String(api), String(hdr(0)));
check('and keeps its own headers',
	sent[0].init.headers && typeof sent[0].init.headers.get === 'function'
	&& sent[0].init.headers.get('accept') === 'application/json');

await win.fetch('/api/tools');
check('a request with no options at all carries it', hdr(1) === String(api), String(hdr(1)));

await win.fetch('https://daimond.test/api/telemetry', { method: 'POST', body: '{}' });
check('a same-origin absolute /api URL carries it', hdr(2) === String(api), String(hdr(2)));
check('and keeps its method and body', sent[2].init.method === 'POST' && sent[2].init.body === '{}');

await win.fetch('/api/version', { headers: { 'x-daimond-api': '99' } });	// fixture: not this build's version
check("a caller's own value is left as it is", hdr(3) === '99', String(hdr(3)));

await win.fetch('/pkg/oxedyne_daimond.wasm');
check('a path that is not /api is untouched', sent[4].init === undefined);

await win.fetch('https://elsewhere.example/api/x', {});
check('another origin is untouched', hdr(5) === undefined);

console.log(failures ? '\n' + failures + ' FAILED' : '\nall apistamp checks passed');
process.exit(failures ? 1 : 0);
