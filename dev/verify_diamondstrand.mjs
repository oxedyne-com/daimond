// verify_diamondstrand.mjs — a small Diamond must not be NAMED as stranded when a
// large one only rode inline because offload was unavailable this round.
//
// THE DEFECT THIS PINS. `collectDiamonds` (www/js/daimond.js) spends a ~4 MiB
// Diamonds budget freshest-first. A large Diamond normally offloads to `@d/` chunks
// and costs the parcel a ~200-byte reference; but when offload is unavailable — the
// chunk store not ready / identity re-locked (`canOffload` false), OR the gateway
// refusing the upload so `offloadBytes` returns null — it falls back to riding
// INLINE and spends real budget. The small Diamonds behind it then overflow and used
// to be NAMED to the user ("N Diamonds did not fit … until there is room"), a false
// alarm: once offload works the large payload leaves the parcel and the room comes
// back. seq 212 held the large Diamond itself but still named the small ones in its
// wake; the fix holds the whole stalled round (nothing named, all retried) and lets
// the chunk store's own `standRefused` be the notice the user sees.
//
// Four counted scenarios plus the standRefused surfacing, all headless on the real
// collectSync. Scenario D — more small diamonds than the inline budget holds, with
// offload working — is the owner's real "did not fit" bug: since the diamond-fit fix
// the overflow leaves as `@d/` references and EVERY diamond travels (see
// verify_diamondfit.mjs for that failure reproduced against his files-fill-the-parcel
// shape). Nothing is named while offload can carry it.
//
//   node dev/verify_diamondstrand.mjs
import { open, scratch } from './harness.mjs';
import fs from 'node:fs';

const KiB = 1024, MiB = 1024 * 1024;
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Install a synthetic Diamond store on the live wasm class and capture the
/// collector's "sync collected" trail line. `diamonds` = [{id,name,size,stamp}].
async function seed(page, diamonds) {
	return page.evaluate(async (diamonds) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const P = m.DaimondApp.prototype;
		P.list_diamonds       = function () {
			return JSON.stringify(diamonds.map(d => ({
				id: d.id, name: d.name, updated: d.stamp, touched: d.stamp })));
		};
		P.export_diamond_size = function (id) { const d = diamonds.find(x => x.id === id); return d ? d.size : 0; };
		P.export_diamond      = function (id) { const d = diamonds.find(x => x.id === id); return 'x'.repeat(d ? d.size : 0); };
		window.__trail = [];
		if (window.DaimondTrail && DaimondTrail.note && !DaimondTrail.__wrapped) {
			const real = DaimondTrail.note.bind(DaimondTrail);
			DaimondTrail.note = function (w, d) {
				try { if (w === 'sync collected') window.__trail.push(String(d)); } catch (e) {}
				return real(w, d);
			};
			DaimondTrail.__wrapped = true;
		}
		return true;
	}, diamonds);
}

/// Run one classifier scenario against a MOCKED offloadBytes, and read the counts.
/// `available` gates canOffload; `offloadOk` decides whether the mocked offload
/// returns a manifest (true) or null (false).
async function run(page, { available, offloadOk }) {
	return page.evaluate(async ({ available, offloadOk }) => {
		DaimondCloud.available = () => available;
		DaimondChunks.offloadBytes = async function (label, bytes) {
			if (!offloadOk) return null;
			return { v: 2, size: bytes.length, key: 'k', chunks: [{ addr: 'a', n: bytes.length }] };
		};
		window.__store = window.__store || {};
		DaimondCloud.contentGet    = (k) => window.__store[k] || null;
		DaimondCloud.contentSet    = (k, v) => { window.__store[k] = v; };
		DaimondCloud.contentForget = (k) => { delete window.__store[k]; };
		DaimondCloud.contentReap   = () => {};
		window.__trail = [];
		const parcel = await DaimondCore.collectSync();
		const t = window.__trail.slice(-1)[0] || '';
		const named = (t.match(/(\d+) left behind/)  || [])[1];
		const held  = (t.match(/(\d+) held for offload/) || [])[1];
		const b = document.querySelector('.left-banner');
		const bannerShown = !!(b && !b.hidden && b.querySelector('.left-banner-msg'));
		return { sent: (parcel.diamonds || []).length, named: +named, held: +held, bannerShown, trail: t };
	}, { available, offloadOk });
}

const dir = scratch('pw', 'diamondstrand-' + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
const s = await open({ name: 'strand', profile: dir, defaults: false, connect: false });
const page = s.page;

// The genuine offloadBytes / available, saved before any scenario overwrites them,
// so the standRefused case below can drive the REAL offload path.
await page.evaluate(() => {
	window.__realOffload = DaimondChunks.offloadBytes;
	window.__realAvail   = DaimondCloud.available;
});

// 1 large (needs offload) freshest + 8 small behind it, ~4 MiB budget, no files.
const wake = [{ id: 'big1', name: 'Big One', size: Math.floor(3.9 * MiB), stamp: 9000 }];
for (let i = 0; i < 8; i++) wake.push({ id: 'sm' + i, name: 'Small ' + i, size: 50 * KiB, stamp: 8000 - i });

// A — canOffload FALSE: the large rides inline, eats budget. Nothing NAMED; all HELD.
await seed(page, wake);
const A = await run(page, { available: false, offloadOk: true });
check('A canOffload=false: no small Diamond is NAMED', A.named === 0, A.trail);
check('A canOffload=false: they are HELD and retried, banner stays away', A.held > 0 && !A.bannerShown, `held=${A.held} banner=${A.bannerShown}`);

// B — canOffload TRUE but the per-Diamond offload FAILS (mani=null). Same outcome.
const B = await run(page, { available: true, offloadOk: false });
check('B offload fails: no small Diamond is NAMED (the reported bug)', B.named === 0, B.trail);
check('B offload fails: they are HELD not named, banner stays away', B.held > 0 && !B.bannerShown, `held=${B.held} banner=${B.bannerShown}`);

// C — offload WORKS: the large one becomes a ref, budget freed, all travel.
const C = await run(page, { available: true, offloadOk: true });
check('C offload works: every Diamond travels, none named or held', C.sent === 9 && C.named === 0 && C.held === 0, C.trail);
check('C offload works: no banner', !C.bannerShown);

// D — MORE SMALL DIAMONDS THAN THE INLINE BUDGET HOLDS, offload working. Before the
// diamond-fit fix these rode inline, overflowed the ~4 MiB Diamonds budget and were
// NAMED "did not fit" — the owner's bug. Now the freshest fill the inline cap and the
// rest leave as `@d/` references, so EVERY diamond travels and nothing is named.
const many = [];
for (let i = 0; i < 45; i++) many.push({ id: 'm' + i, name: 'Mini ' + i, size: 100 * KiB, stamp: 7000 - i });
await seed(page, many);
const D = await run(page, { available: true, offloadOk: true });
check('D over-inline-budget: every diamond travels, none named (offload carries the overflow)', D.sent === 45 && D.named === 0, D.trail);
check('D over-inline-budget: nothing named and nothing silently held', D.bannerShown === false && D.held === 0, `named=${D.named} held=${D.held} banner=${D.bannerShown}`);

// ── standRefused surfacing ────────────────────────────────────────────────
// The REAL offload path (canOffload true, identity unlocked), with the gateway made
// to REFUSE the chunk upload (507). The large Diamond falls back to inline and spends
// budget; the small ones behind it must be HELD (not named); AND the chunk store's own
// honest notice must stand — its words name the remedy the banner never could.
await seed(page, wake);
const R = await page.evaluate(async () => {
	// Restore the genuine offload path saved at boot.
	DaimondChunks.offloadBytes = window.__realOffload;
	DaimondCloud.available     = window.__realAvail;
	// Empty the manifest cache: a stored `@d/` ref from an earlier scenario would be
	// reused on the stamp match and no offload would be attempted, so the 507 below
	// would never be reached.
	window.__store = {};
	DaimondCloud.contentGet    = (k) => window.__store[k] || null;
	DaimondCloud.contentSet    = (k, v) => { window.__store[k] = v; };
	DaimondCloud.contentForget = (k) => { delete window.__store[k]; };
	DaimondCloud.contentReap   = () => {};
	// Make the gateway REFUSE every chunk put with a 507 and its own sentence.
	const MSG = 'This account has reached its cloud storage limit. Delete something, or ask for more room.';
	DaimondGateway.gwFetch = async function (path, opts) {
		let body = {}; try { body = JSON.parse(opts.body); } catch (e) {}
		if (body.op === 'put') return { status: 507, json: async () => ({ error: MSG }) };
		return { status: 200, json: async () => ({ missing: body.addrs || [], ok: true }) };
	};
	window.__trail = [];
	const parcel = await DaimondCore.collectSync();
	const t = window.__trail.slice(-1)[0] || '';
	return {
		sent:    (parcel.diamonds || []).length,
		named:   +((t.match(/(\d+) left behind/)     || [])[1]),
		held:    +((t.match(/(\d+) held for offload/) || [])[1]),
		refused: (DaimondChunks.state && DaimondChunks.state().refused) || '',
		trail:   t,
	};
});
check('B-real: the small Diamonds in a refused round are HELD, nothing NAMED', R.named === 0 && R.held > 0, R.trail);
check('B-real: the chunk store surfaces its own standRefused notice', /storage limit/i.test(R.refused), JSON.stringify(R.refused).slice(0, 80));

console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404|502|ERR_/.test(e)).slice(0, 4));
await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
