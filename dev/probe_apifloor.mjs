// probe_apifloor.mjs -- API-FLOOR (2026-10-26). The version header every page module
// ACTUALLY sends is at or above the gateway's floor.
//
// ccp6 raised `MIN_CLIENT_API` to 3 while four modules still sent their own `2`, and every
// post they made was answered 426. `www/js/apiversion.test.mjs` refuses a second copy in
// the source; this watches the wire, in a world, so a copy the scan cannot read (built,
// injected, a worker's) is caught too. Every request to `/api/*` from the app and the
// console -- pages and service workers alike, through the context's request event -- has
// its `x-daimond-api` collected, and the run fails if any is missing or below
// `MIN_CLIENT_API` read from gateway/src/handlers/common.rs.
//
// The page is driven through each sender: the diagnostics share, the problem report, the
// debug share's drain, the Lens shot poll, then the operator console. A refusal from the
// gateway does not matter here; what the page sent does.
//
//   eval "$(bash dev/world.sh N --env)"; node dev/probe_apifloor.mjs
//
// Exit 0 when every request carried a version at the floor or above, 1 otherwise.
import { MIN_CLIENT_API, CLIENT_API } from './clientapi.mjs';
import { open, APP } from './harness.mjs';

const seen = [];			// { url, api, from }
function watch(ctx) {
	ctx.on('request', (req) => {
		let p = '';
		try { p = new URL(req.url()).pathname; } catch (e) { return; }
		if (p.indexOf('/api/') !== 0) return;
		const h = req.headers();
		let from = 'page';
		try { if (req.serviceWorker()) from = 'sw'; } catch (e) { /* older Playwright */ }
		seen.push({ url: req.method() + ' ' + p, api: h['x-daimond-api'], from });
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, detail) => {
	if (!ok) fails++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};

console.log('  floor ' + MIN_CLIENT_API + ' (common.rs), build ' + CLIENT_API + ' (gateway.js), app ' + APP);
check('gateway.js speaks at or above the gateway floor', CLIENT_API >= MIN_CLIENT_API,
	'CLIENT_API ' + CLIENT_API + ', MIN_CLIENT_API ' + MIN_CLIENT_API);

const s = await open({ name: 'apifloor', route: (page) => watch(page.context()) });
const page = s.page;

// Each sender, driven the way its own caller drives it. Each is guarded: a sender that
// throws is reported by the endpoint it then never reached, below.
const drove = await page.evaluate(async () => {
	const out = {};
	const go = async (k, f) => { try { await f(); out[k] = 'ok'; } catch (e) { out[k] = String(e && e.message || e); } };
	await go('diag', async () => { DaimondDiag.set(true); DaimondDiag.log('apifloor', 'probe'); await DaimondDiag.flush(); });
	await go('support', async () => { await DaimondSupport.post('apifloor probe'); });
	await go('debugshare', async () => { DEBUG_SHARE.setEnabled(true); DEBUG_SHARE._noteError(new Error('apifloor probe')); DEBUG_SHARE._drain(); });
	await go('lensshot', async () => { DaimondLensShot.setEnabled(true); });
	return out;
});
console.log('  drove ' + JSON.stringify(drove));
await sleep(8000);			// the Lens poll is 5 s; the drain posts on its own clock

// The console, in the same context: its every view is an /api/admin request, signed in
// as an owner or not.
const con = await s.page.context().newPage();
try { await con.goto(APP + '/console/', { waitUntil: 'load' }); } catch (e) { check('the console opens', false, String(e.message || e)); }
await sleep(3000);

const want = ['/api/debug-trace', '/api/lens-shot', '/api/admin'];
for (const w of want) check('a request reached ' + w, seen.some((r) => r.url.endsWith(' ' + w)));
check('the page made /api requests at all (' + seen.length + ')', seen.length > 0);

const bad = seen.filter((r) => !(Number(r.api) >= MIN_CLIENT_API));
const byUrl = new Map();
for (const r of bad) byUrl.set(r.url + ' [' + r.from + '] api=' + (r.api === undefined ? 'MISSING' : r.api), true);
check('every /api request carries x-daimond-api >= ' + MIN_CLIENT_API, bad.length === 0,
	bad.length + ' of ' + seen.length + ': ' + [...byUrl.keys()].slice(0, 20).join('; '));

await s.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall apifloor checks passed');
process.exit(fails ? 1 : 0);
