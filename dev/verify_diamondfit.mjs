// verify_diamondfit.mjs — the owner's real "N diamonds did not fit" failure, and
// its fix.  Distinct from verify_diamondstrand, which is about offload being
// UNAVAILABLE (canOffload false, or the gateway refusing).  This one is the case
// that survived that fix: canOffload TRUE and the gateway offloading WITHOUT ERROR,
// and the diamonds STILL named because they rode inline and the inline budget was
// already spent by the workspace files ahead of them.
//
// HIS SHAPE. A heavy workspace of inline text files fills nearly the whole parcel,
// so `collectDiamonds` is handed a Diamonds budget of a few tens of kB. Twelve
// small diamonds (each under SYNC_FILE_MAX, so each rode inline) then have nowhere
// to sit and were NAMED "did not fit … until there is room" — a banner that stood
// on his phone though his identity was unlocked and offload was working perfectly.
// A small diamond used to ride inline for old-receiver back-compat; the owner runs
// latest on every device, so it may leave as an `@d/` reference like a large one —
// a few hundred bytes — and then it fits in any budget at all.
//
// PRE-FIX  → all 12 are NAMED (reproduces the banner) with offload WORKING.
// POST-FIX → all 12 TRAVEL as `@d/` references, 0 named, parcel under the ceiling.
// REFUSED  → the gateway 507s the chunk upload: 0 named, all HELD, and the chunk
//            store's own standRefused ("cloud storage limit") is what the user sees.
// FIXED PT → collect twice on an unchanged store: the diamond section is byte-equal.
//
//   node dev/verify_diamondfit.mjs
import { open, scratch } from './harness.mjs';
import fs from 'node:fs';

const KiB = 1024, MiB = 1024 * 1024;
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Seed a synthetic Diamond store AND a synthetic heavy workspace on the live wasm
/// class, so `collectSync` sees a real files-fill-the-parcel shape.  `diamonds` =
/// [{id,name,size,stamp}]; the workspace is `nFiles` text files of `perFile` bytes
/// each (kept under the per-file offload ceiling so they count as INLINE bytes and
/// squeeze the Diamonds' share of the 5 MiB parcel, which is his real shape).
async function seed(page, diamonds, { nFiles, perFile }) {
	return page.evaluate(async ({ diamonds, nFiles, perFile }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const P = m.DaimondApp.prototype;
		P.list_diamonds       = function () {
			return JSON.stringify(diamonds.map(d => ({
				id: d.id, name: d.name, updated: d.stamp, touched: d.stamp })));
		};
		P.export_diamond_size = function (id) { const d = diamonds.find(x => x.id === id); return d ? d.size : 0; };
		P.export_diamond      = function (id) { const d = diamonds.find(x => x.id === id); return 'x'.repeat(d ? d.size : 0); };

		// A workspace of many text files, so collectFiles reports ~fileBytes of INLINE
		// bytes and the Diamonds are budgeted against what is left of the parcel.  Each
		// file must stay UNDER SYNC_FILE_MAX (128 KiB) — a larger file offloads to chunks
		// and does NOT count against the inline budget the diamonds share — so the total
		// is spread across many small files.  file_list is answered from this map; fileAt
		// returns a decodable-as-text blob per path.
		window.__files = {};
		for (let i = 0; i < nFiles; i++) window.__files['w' + i + '.txt'] = perFile;
		P.run_tool_outcome = async function (tool, argsJson) {
			if (tool !== 'file_list') return { outcome: 'done', text: '' };
			let path = '.';
			try { path = (JSON.parse(argsJson).path) || '.'; } catch (e) {}
			if (path === '.' || path === '') {
				const lines = Object.keys(window.__files).map(n => n + '  (' + window.__files[n] + ' bytes)');
				return { outcome: 'done', text: lines.join('\n') };
			}
			return { outcome: 'done', text: (path || '.') + ' is empty.' };
		};
		if (window.DaimondCloud) {
			DaimondCloud.fileAt = async function (full) {
				const n = window.__files[full];
				if (!n) return null;
				return new Blob(['a'.repeat(n)], { type: 'text/plain' });
			};
		}

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
	}, { diamonds, nFiles, perFile });
}

/// Run collectSync with a MOCKED offload (working, or refused), and read the counts.
/// `offloadOk` true returns a manifest; false returns null (a store-full round).
async function run(page, { offloadOk }) {
	return page.evaluate(async ({ offloadOk }) => {
		DaimondCloud.available = () => true;
		DaimondChunks.offloadBytes = async function (label, bytes) {
			if (!offloadOk) return null;
			// A stable, content-addressed manifest: the address is the label so a
			// re-collect of an unchanged store produces byte-identical bytes.
			return { v: 2, size: bytes.length, key: 'k:' + label, chunks: [{ addr: 'a:' + label, size: bytes.length }] };
		};
		window.__store = window.__store || {};
		DaimondCloud.contentGet    = (k) => window.__store[k] || null;
		DaimondCloud.contentSet    = (k, v) => { window.__store[k] = v; };
		DaimondCloud.contentForget = (k) => { delete window.__store[k]; };
		DaimondCloud.contentReap   = () => {};
		window.__trail = [];
		const parcel = await DaimondCore.collectSync();
		const t = window.__trail.slice(-1)[0] || '';
		const named = +((t.match(/(\d+) left behind/)     || [])[1]);
		const held  = +((t.match(/(\d+) held for offload/) || [])[1]);
		const diamonds = parcel.diamonds || [];
		const refs   = diamonds.filter(d => d.dataRef).length;
		const inline = diamonds.filter(d => d.data != null).length;
		const b = document.querySelector('.left-banner');
		const bannerShown = !!(b && !b.hidden && b.querySelector('.left-banner-msg'));
		// The bytes of the diamond section only, for the fixed-point compare.
		const sig = JSON.stringify(diamonds.map(d => ({
			id: d.id, ref: d.dataRef || null, inline: d.data != null ? d.data.length : null })));
		return { sent: diamonds.length, refs, inline, named, held, bannerShown, sig, trail: t };
	}, { offloadOk });
}

const dir = scratch('pw', 'diamondfit-' + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
const s = await open({ name: 'fit', profile: dir, defaults: false, connect: false });
const page = s.page;

// The genuine offloadBytes, saved before any scenario overwrites it, so the refused
// case below can drive the REAL offload path into a 507.
await page.evaluate(() => { window.__realOffload = DaimondChunks.offloadBytes; });

// His shape: a workspace that fills nearly the whole 5 MiB parcel, and twelve small
// diamonds behind it.  42 files of 120 KiB = 4.92 MiB of inline text leaves the
// Diamonds budget ~80 kB — under one 100 KiB diamond — so with the OLD code every
// diamond overflows the inline budget and is NAMED, though offload is working.  The
// budget stays > 0 (files do not by themselves exceed the parcel), which is the whole
// point: offload CAN carry these — the fix routes them out as references that fit.
//   budget = SYNC_PARCEL_MAX(5 MiB) - 42*120 KiB = 80 KiB.
const nFiles   = 42, perFile = 120 * KiB;
const diamonds = [];
for (let i = 0; i < 12; i++) diamonds.push({ id: 'd' + i, name: 'Diamond ' + i, size: 100 * KiB, stamp: 9000 - i });

await seed(page, diamonds, { nFiles, perFile });
const W = await run(page, { offloadOk: true });

// The pre/post switch is the code itself: this file is run once against the shipped
// build (reproduces the banner) and once against the fixed build (all travel).  It
// asserts the FIXED behaviour; a run on the shipped build FAILS the first two checks,
// which is the reproduction.
const fixed = W.named === 0 && W.sent === 12;
console.log(`\n  (this build ${fixed ? 'has the fix' : 'is PRE-fix — the two checks below reproduce the banner'})\n`);

check('offload working: all 12 diamonds travel, none named', W.sent === 12 && W.named === 0, W.trail);
check('offload working: they travel as @d/ references (a few hundred bytes each)', W.refs === 12, `refs=${W.refs} inline=${W.inline}`);
check('offload working: no "did not fit" banner', !W.bannerShown);

// Fixed point: collect the same unchanged store again — the diamond section is byte-equal.
const W2 = await run(page, { offloadOk: true });
check('fixed point: a second collect of the unchanged store is byte-identical', W.sig === W2.sig,
	W.sig === W2.sig ? '' : 'section changed between collects');

// Offload REFUSED (store full): 0 named, all HELD, and the honest standRefused stands.
const R = await page.evaluate(async () => {
	DaimondCloud.available = () => true;
	window.__store = {};
	DaimondCloud.contentGet    = (k) => window.__store[k] || null;
	DaimondCloud.contentSet    = (k, v) => { window.__store[k] = v; };
	DaimondCloud.contentForget = (k) => { delete window.__store[k]; };
	DaimondCloud.contentReap   = () => {};
	// Restore the REAL offload path so a real 507 flows through putChunks/standRefused.
	DaimondChunks.offloadBytes = window.__realOffload;
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
		named:   +((t.match(/(\d+) left behind/)     || [])[1]),
		held:    +((t.match(/(\d+) held for offload/) || [])[1]),
		sent:    (parcel.diamonds || []).length,
		refused: (DaimondChunks.state && DaimondChunks.state().refused) || '',
		trail:   t,
	};
});
check('offload refused: nothing is NAMED (no misleading "did not fit")', R.named === 0, R.trail);
check('offload refused: the diamonds are HELD, retried next round', R.held > 0, `held=${R.held} sent=${R.sent}`);
check('offload refused: the chunk store surfaces its own standRefused notice', /storage limit/i.test(R.refused),
	JSON.stringify(R.refused).slice(0, 80));

console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404|502|ERR_/.test(e)).slice(0, 4));
await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
