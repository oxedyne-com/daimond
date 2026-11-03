// gateway: none
// probe_u97coldstart.mjs -- UNBLOCK-97: a cold start on an iPhone-sized standalone
// WebKit page holds the app's path tests whatever the document loaded.
//
// 2 Nov 2026, 18:46:26, his phone (build 892c3ad90a85): `ReferenceError: Can't find
// variable: DaimondAppPaths`, and 35 chats refused as naming no Diamond. The page modules
// read the global from the classic script `js/apppaths.js`; a document that did not run
// it (the 31 Oct index.html, or a script that failed to load) broke them for the page's
// life.
//
// Two cold starts, each a fresh profile at 393x852 in WebKit with `display-mode:
// standalone` and `navigator.standalone` as an installed iPhone app reads them:
//   shipped  the document as served;
//   stale    the document as the 31 Oct build served it (`markshere.js` where
//            `apppaths.js` stands, so no `apppaths.js` runs) beside this tree's modules.
// Each asks the page's own module instances (`js/page/all.js`, the instance the page
// booted) the three questions that failed on his phone, and counts every DaimondAppPaths
// error the page raised, its trail's unhandled rejections included. Zero, and the right
// answers, in both.
//
// Run in a world of its own:  eval "$(bash dev/world.sh N --up)"; DAIMOND_BROWSER=webkit node dev/probe_u97coldstart.mjs

import { open, errors } from './harness.mjs';

const STANDALONE = () => {
	const mm = window.matchMedia.bind(window);
	window.matchMedia = (q) => {
		if (/display-mode:\s*standalone/.test(q)) return { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, onchange: null, dispatchEvent() { return false; } };
		return mm(q);
	};
	try { Object.defineProperty(navigator, 'standalone', { get: () => true }); } catch (e) { /* read-only here */ }
};

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function stale(page) {
	await page.route(/\/(index\.html)?(\?.*)?$/, async (r) => {
		if (r.request().resourceType() !== 'document') return r.fallback();
		const res = await r.fetch();
		const body = (await res.text()).replace(/<script src="js\/apppaths\.js"><\/script>/, '<script src="js/markshere.js"></script>');
		await r.fulfill({ response: res, body });
	});
	await page.route(/\/js\/(apppaths|markshere)\.js$/, (r) => r.fulfill({ status: 404, body: '' }));
}

async function run(label, route) {
	// Before the first `goto`, so the one load is the cold start.
	const before = async (page) => { await page.addInitScript(STANDALONE); if (route) await route(page); };
	const s = await open({ browser: 'webkit', viewport: { width: 393, height: 852 }, touch: true, ua: UA, route: before, serviceWorkers: 'block' });
	await s.page.waitForFunction(() => window.DaimondTrail && window.DaimondTrail.rows().some((r) => /boot/.test(r.w || '')), null, { timeout: 60000 });
	await s.page.waitForTimeout(4000);
	const got = await s.page.evaluate(async () => {
		const out = { standalone: matchMedia('(display-mode: standalone)').matches };
		const m = await import('/js/page/all.js');
		const ask = (f) => { try { return f(); } catch (e) { return 'threw ' + e.name + ': ' + e.message; } };
		out.chatDiamondOk = ask(() => m.chatDiamondOk({ id: 'c19', diamondId: '19fbb77697a3' }));
		out.refReachable = ask(() => m.refReachable('file:[machine:usr@x#1]diamonds/19fbb77697a3/transcript.md'));
		out.trail = window.DaimondTrail.rows().filter((r) => /DaimondAppPaths/.test(String(r.d || '') + String(r.w || ''))).map((r) => r.w + ' ' + r.d);
		return out;
	});
	const errs = errors(s).filter((e) => /DaimondAppPaths/.test(e));
	await s.close();
	const ok = got.standalone && got.chatDiamondOk === true && got.refReachable === true && !got.trail.length && !errs.length;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: standalone=${got.standalone} chatDiamondOk=${got.chatDiamondOk} refReachable=${got.refReachable} trail=${JSON.stringify(got.trail)} errors=${JSON.stringify(errs)}`);
	return ok;
}

const a = await run('shipped document', null);
const b = await run('stale document (no apppaths.js runs)', stale);
console.log(a && b ? 'u97coldstart: PASS' : 'u97coldstart: FAIL');
process.exit(a && b ? 0 : 1);
