// verify_firstparcel.mjs — THE FIRST PARCEL AFTER A BOOT, which on the owner's
// iPhone carried the whole workspace inline and was refused by the front door.
//
// HIS SHAPE, from build 7da684216e4e. A phone with ~9.8 MB of small text files in
// the workspace and 25 Diamonds. After every boot the first collect packed
// f = 9,860,533 bytes of inline files — 13.6 MB on the wire against an 8 MiB door —
// so the push was refused locally; and in that same collect the Diamonds were
// handed a budget of ZERO (the parcel ceiling less the files that had already
// spent past it), so all 25 took the offload arm, reused their stored manifests,
// and were then NAMED in the "did not fit" banner because even a few hundred bytes
// of reference would not fit in nothing. The second collect ~17 s later rode
// 266 KB and landed. Nothing was lost; a refused parcel and a false banner
// happened on every boot.
//
// TWO FAULTS, AND THIS FILE SEPARATES THEM.
//
//   1. `collectFiles` queued a file past the SOFT cap for offload and then fell
//      through to carrying it inline anyway, with no test of the HARD budget. The
//      hard budget was tested only on the arm where there was nowhere to offload
//      to. So `total` was bounded by nothing at all, and a workspace of any size
//      rode inline in full. Case B isolates this: with the presence sweep
//      unanswered NOTHING can be confirmed, so the fix that binds is this one.
//   2. `_offloadConfirmed` is per-sitting memory, empty at boot, and was filled
//      only by `collectChunked` — which runs AFTER `collectFiles` in the same
//      round. So the first collect of every sitting knew nothing about the
//      manifests the cloud index was already holding, and carried inline what was
//      already in chunk storage. The presence sweep had just asked the gateway
//      about every one of those addresses and thrown the answer away. Case D
//      isolates this: same profile, same index, after a reload.
//
// Case A is the honest first-boot-ever answer and it is NOT the small parcel: a
// workspace this size cannot be confirmed held by a store that has never seen it,
// so what cannot ride is HELD and the census says it is incomplete. What case A
// asserts is that the parcel fits the door and the Diamonds travel. The 256 KB
// parcel arrives on the round after (case C) and on every boot after that (case D),
// which is the owner's case.
//
// MEASURED, on the build this was written against and on the fix, under Chromium:
// 8 of 26 checks pass before and 26 after. A, B, D and E all packed f = 10,456,018
// bytes into a 5,242,880-byte parcel and 13,993,422 onto an 8,388,608-byte wire,
// with 0 of 25 Diamonds travelling and all 25 named; afterwards A, B and E ride
// 5,238,259 with all 25 Diamonds carried, and C and D ride 261,854.
//
//   node dev/verify_firstparcel.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_firstparcel.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT). No gateway and no mock LLM: the chunk store
// is stubbed at `DaimondGateway.gwFetch`, the same late-bound hook
// verify_contentoffload uses, so the real offload path runs inside one page.
//
// ON THE iOS ENGINE, half of it. Playwright's WebKit build exposes no OPFS, so a
// workspace can be stood up at the two doors the collectors use but no manifest can
// be RECORDED (`DaimondCloud.put` reads the file off disk) -- which means nothing
// can ever be confirmed and no round can demote a file to a reference. The budget
// half, which is the fault that refused the parcel, runs on both engines; the
// confirmation half runs where a workspace can exist. Real iOS Safari has OPFS: the
// limitation is the test engine's, not the app's.
import { open, scratch, signInAs, BROWSER } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP  = fs.readFileSync(path.join(ROOT, 'www', 'js', 'daimond.js'), 'utf8');

/// A `var NAME = a * b;` ceiling, read out of the app rather than restated here,
/// so a change to either number cannot leave this file asserting the old one.
const constOf = (name) => {
	const m = new RegExp('var\\s+' + name + '\\s*=\\s*([0-9*\\s]+);').exec(APP);
	if (!m) throw new Error('verify_firstparcel: ' + name + ' not found in www/js/daimond.js');
	return m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1);
};
const PARCEL_MAX = constOf('SYNC_PARCEL_MAX');
const SOFT_MOB   = constOf('SYNC_INLINE_SOFT_MOBILE_MAX');
const FILE_MAX   = constOf('SYNC_FILE_MAX');

const KiB = 1024;
// His shape, scaled to the figures in the defect: 84 files of 120 KiB is
// 10,321,920 bytes of inline text — each file UNDER the per-file offload ceiling,
// so every one of them is a candidate to ride inline and the total is what
// overflows. 25 Diamonds of 100 KiB, as he has.
const N_FILES = 84, PER_FILE = 120 * KiB, N_DIAMONDS = 25, D_SIZE = 100 * KiB;
// What `f` may weigh on a round where the confirmed files have left the parcel. The
// soft ceiling bounds the CONTENT bytes; `f` is the JSON of the whole section, so it
// carries a path, two quotes and a comma per file on top. 8 KiB of framing is far
// more than a few dozen paths need and far less than one 120 KiB file, so the check
// cannot be passed by carrying one more file than it should.
const SMALL = SOFT_MOB + 8 * KiB;
if (PER_FILE >= FILE_MAX) throw new Error('verify_firstparcel: the seeded files must stay under SYNC_FILE_MAX');

const files = { nFiles: N_FILES, perFile: PER_FILE };

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

const dir = scratch('pw', 'firstparcel-' + process.pid);
fs.rmSync(dir, { recursive: true, force: true });
const s = await open({ name: 'firstparcel', profile: dir, defaults: false, connect: false });
const page = s.page;

/// Everything that has to be put back after a reload: the phone's own answer about
/// itself, the Diamond store, the chunk-store stub, and the two doors the sync
/// engine would otherwise collect through behind the measurement.
///
/// The OPFS files and the cloud index are NOT here: they are on disk and in
/// localStorage, which is exactly what makes case D a boot rather than a rerun.
async function arm(page, { diamonds, files }) {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync
		&& window.DaimondChunks && DaimondChunks.offloadBytes && window.DaimondCloud
		&& DaimondCloud.contentGet && window.DaimondGateway && window.DaimondSync
		&& window.DaimondSync.forTest && window.DaimondIdentity), null, { timeout: 20000 });
	// `__DAIMOND_READY` and an UNLOCKED identity, not merely the modules: the wasm
	// `init()` runs during the boot, and `tools()` / `diamondApp()` both construct a
	// `DaimondApp` the moment a collect asks for one. Construct it too early and both
	// throw, so `collectFiles` returns an empty census and `collectDiamonds` returns
	// before it ever writes its trail -- which is what a reload looked like here
	// before this wait, and it looked like a passing case B.
	await page.waitForFunction(() => !!window.__DAIMOND_READY, null, { timeout: 20000 });
	await page.evaluate(async ({ diamonds, files }) => {
		// THE PHONE'S OWN ANSWER ABOUT ITSELF. `isMobileDeviceSelf` asks this first and
		// treats it as final, and the soft inline ceiling is a quarter of a desktop's on
		// a phone — which is the ceiling the defect was measured against.
		window.DaimondShell = window.DaimondShell || {};
		window.DaimondShell.isMobileDevice = () => true;

		const m = await import('/pkg/oxedyne_daimond.js');
		const P = m.DaimondApp.prototype;
		// A synthetic Diamond store on the live wasm class, so `collectSync` walks,
		// sizes and exports 25 Diamonds of his size without 2.5 MB of real crystal
		// writes. Sizes and stamps are fixed, so the exported bytes — and therefore
		// every `@d/` manifest — are the same before and after a reload, which is what
		// lets case D measure a BOOT rather than a changed store.
		P.list_diamonds = function () {
			return JSON.stringify(diamonds.map((d) => ({
				id: d.id, name: d.name, updated: d.stamp, touched: d.stamp })));
		};
		P.export_diamond_size = function (id) { const d = diamonds.find((x) => x.id === id); return d ? d.size : 0; };
		P.export_diamond      = function (id) { const d = diamonds.find((x) => x.id === id); return 'x'.repeat(d ? d.size : 0); };

		// A GATEWAY THAT REMEMBERS ACROSS A RELOAD, reached through the late-bound hook
		// so what runs is the real offload path and not a shim around it.
		//
		// `__known` is the store's whole memory -- the addresses it holds -- and it is
		// kept in localStorage because that is what makes case D a BOOT: a page-global
		// set would be empty after the reload, the presence sweep would be told every
		// address is missing, and the case would test a swept store instead of a
		// restarted tab. The CIPHERTEXT is kept only for the sitting, in `__store`:
		// nothing in a collect fetches a chunk back, so the bytes are needed for
		// nothing and 14 MB of base64 would not fit in localStorage anyway.
		const KNOWN = '__fp_known';
		window.__store = {};
		try { window.__known = JSON.parse(localStorage.getItem(KNOWN) || '{}'); }
		catch (e) { window.__known = {}; }
		window.__forgetAll = () => {
			window.__store = {}; window.__known = {};
			try { localStorage.removeItem(KNOWN); } catch (e) {}
		};
		window.__mode  = 'ok';
		window.__puts  = 0; window.__haves = 0;
		window.DaimondGateway.gwFetch = async function (path_, opts) {
			let body = {}; try { body = JSON.parse(opts.body); } catch (e) {}
			const reply = (status, json) => ({ status, json: async () => json });
			if (body.op === 'have') {
				window.__haves++;
				if (window.__mode === 'have500') return reply(500, { error: 'no' });
				return reply(200, { missing: (body.addrs || []).filter((a) => !(a in window.__known)) });
			}
			if (body.op === 'put') {
				if (window.__mode === 'put507') {
					return reply(507, { error: 'This account has reached its cloud storage limit.'
						+ ' Delete something, or ask for more room.' });
				}
				window.__puts++;
				(body.chunks || []).forEach((c) => { window.__store[c.addr] = c.blob; window.__known[c.addr] = 1; });
				try { localStorage.setItem(KNOWN, JSON.stringify(window.__known)); } catch (e) {}
				return reply(200, { ok: true });
			}
			if (body.op === 'get') {
				const b = window.__store[body.addr];
				return reply(200, b ? { present: true, blob: b } : { present: false });
			}
			if (body.op === 'commit') return reply(200, { ok: true, swept: 0, free_allowance: 0 });
			return reply(200, { ok: true });
		};

		// NOTHING COLLECTS BEHIND THE MEASUREMENT. A round that holds files nudges the
		// engine so the next round carries them, and a nudge packs a parcel of its own —
		// which would move `_offloadConfirmed` between the collect under test and the
		// reading of it. Both doors are shut for the run; what each case wants is the
		// collect it asks for and no other.
		window.DaimondSync.nudge = function () {};
		window.DaimondSync.push  = function () { return Promise.resolve(false); };

		// A WORKSPACE WITHOUT OPFS, for the iOS engine as Playwright ships it.
		//
		// Playwright's WebKit build exposes no `navigator.storage.getDirectory`, so that
		// context cannot hold a workspace at all -- `file_write` answers "this browser
		// exposes no getDirectory" (the same limitation dev/measure_handoff_latency.mjs
		// is written around). The collectors do not reach OPFS directly: they reach
		// `file_list` through the wasm app and `DaimondCloud.fileAt` for the bytes, so a
		// workspace of the right shape can be stood up at those two doors and every line
		// of the budget arithmetic under test runs unchanged.
		//
		// `lastModified: 0` is load-bearing. `DaimondCloud.put` records the mtime from
		// the file it finds on DISK, which on this engine is nothing, so it writes 0 --
		// and `collectChunked` skips a re-offload only when the recorded mtime equals the
		// file's. A File dated anything else would be re-offloaded every round, the index
		// would take a fresh `at` stamp each time, and the fixed point in case C would
		// fail on a difference that is the stub's and not the app's.
		if (files && !(navigator.storage && navigator.storage.getDirectory)) {
			window.__files = {};
			for (let i = 0; i < files.nFiles; i++) window.__files['bulk/f' + i + '.txt'] = files.perFile;
			P.run_tool_outcome = async function (tool, argsJson) {
				if (tool !== 'file_list') return { outcome: 'done', text: '' };
				let at = '.';
				try { at = (JSON.parse(argsJson).path) || '.'; } catch (e) {}
				// A TRAILING SLASH AND NOTHING ELSE is how `parseSyncListing` knows a
				// directory: anything after it reads as a FILE whose name ends in ')'.
				if (at === '.' || at === '') return { outcome: 'done', text: 'bulk/' };
				if (at === 'bulk') {
					return { outcome: 'done', text: Object.keys(window.__files)
						.map((n) => n.slice(5) + '  (' + window.__files[n] + ' bytes)').join('\n') };
				}
				return { outcome: 'done', text: at + ' is empty.' };
			};
			window.DaimondCloud.fileAt = async function (full) {
				const n = window.__files[full];
				if (!n) return null;
				return new File(['x'.repeat(n)], full, { type: 'text/plain', lastModified: 0 });
			};
		}

		// The trail line `collectDiamonds` ends on, and the diag line `collectSync`
		// reports the held and pending files on: the two places the counts are said.
		window.__trail = []; window.__diag = [];
		if (window.DaimondTrail && DaimondTrail.note && !DaimondTrail.__fpWrapped) {
			const real = DaimondTrail.note.bind(DaimondTrail);
			DaimondTrail.note = function (w, d) {
				try { if (w === 'sync collected') window.__trail.push(String(d)); } catch (e) {}
				return real(w, d);
			};
			DaimondTrail.__fpWrapped = true;
		}
		if (window.DaimondDiag && DaimondDiag.log && !DaimondDiag.__fpWrapped) {
			const real = DaimondDiag.log.bind(DaimondDiag);
			DaimondDiag.log = function (tag, d) {
				try { window.__diag.push(String(tag) + ' ' + String(d)); } catch (e) {}
				return real(tag, d);
			};
			DaimondDiag.__fpWrapped = true;
		}
	}, { diamonds, files });
}

/// Write the heavy workspace into OPFS, once. Real files, not a stubbed
/// `file_list`: the confirmed-offload path turns on a manifest's recorded size and
/// mtime matching the file on disk, and a stub has neither.
async function seedWorkspace(page, { nFiles, perFile }) {
	return page.evaluate(async ({ nFiles, perFile }) => {
		if (!(navigator.storage && navigator.storage.getDirectory)) return 0;	// stubbed in `arm`
		const root = await navigator.storage.getDirectory();
		const d = await root.getDirectoryHandle('bulk', { create: true });
		const body = 'x'.repeat(perFile);
		for (let i = 0; i < nFiles; i++) {
			const fh = await d.getFileHandle('f' + i + '.txt', { create: true });
			const w  = await fh.createWritable();
			await w.write(body);
			await w.close();
		}
		return nFiles;
	}, { nFiles, perFile });
}

/// One collect, and everything about it this file asserts on.
async function collect(page, mode) {
	return page.evaluate(async ({ mode }) => {
		window.__mode = mode;
		window.__trail = []; window.__diag = [];
		const F = window.DaimondSync.forTest;
		const parcel = await window.DaimondCore.collectSync();
		const plain  = JSON.stringify(parcel);
		const pbytes = F.utf8Len(plain);
		const sizes  = F.parcelSizes(parcel, pbytes);
		const t = window.__trail.slice(-1)[0] || '';
		const pend = window.__diag.filter((l) => /^parcel inline pending/.test(l)).slice(-1)[0] || '';
		const b = document.querySelector('.left-banner');
		const diamonds = parcel.diamonds || [];
		return {
			f:        sizes.f | 0,
			pbytes:   pbytes,
			wire:     F.wireBytes(pbytes),
			door:     F.door,
			nFiles:   Object.keys(parcel.files || {}).length,
			complete: parcel.filesComplete,
			diamonds: diamonds.length,
			refs:     diamonds.filter((d) => d.dataRef).length,
			inline:   diamonds.filter((d) => d.data != null).length,
			named:    +((t.match(/(\d+) left behind/) || [])[1]),
			held:     +((t.match(/(\d+) held for offload/) || [])[1]),
			pending:  +((pend.match(/(\d+) file\(s\)/) || [])[1]) || 0,
			fileHeld: +((pend.match(/(\d+) held/) || [])[1]) || 0,
			banner:   !!(b && !b.hidden && b.querySelector('.left-banner-msg')),
			key:      F.compareKey(parcel),
			refused:  (DaimondChunks.state && DaimondChunks.state().refused) || '',
			trail:    t, pend: pend,
		};
	}, { mode });
}

const line = (r) => `f=${r.f} wire=${r.wire} files=${r.nFiles} complete=${r.complete}`
	+ ` diamonds=${r.diamonds}/${N_DIAMONDS} refs=${r.refs} inline=${r.inline}`
	+ ` named=${r.named} held=${r.held}`
	+ ` pending=${r.pending} fileHeld=${r.fileHeld}`;

try {
	const diamonds = [];
	for (let i = 0; i < N_DIAMONDS; i++) {
		diamonds.push({ id: 'd' + i, name: 'Diamond ' + i, size: D_SIZE, stamp: 9000 - i });
	}
	await arm(page, { diamonds, files });
	const seeded = await seedWorkspace(page, { nFiles: N_FILES, perFile: PER_FILE });
	// WHETHER A MANIFEST CAN BE RECORDED AT ALL on this engine. `DaimondCloud.put` reads
	// the file off disk to record its true size and mtime, and its path to OPFS starts at
	// `navigator.storage.getDirectory` -- so where that is missing, every offload throws
	// on the index write, `collectChunked` catches it and confirms nothing, and no round
	// can ever demote a file to a reference. That is Playwright's WebKit build, not iOS
	// Safari (which has OPFS) and not the app: the confirmation half of this file is
	// measured where a workspace can exist, and the BUDGET half -- which is the fault
	// that refused the parcel -- is measured on both.
	const persists = seeded > 0;
	note(`engine ${BROWSER}; ${seeded ? seeded + ' files in OPFS' : N_FILES + ' files stubbed (no OPFS on this engine)'}`
		+ ` of ${PER_FILE} B (${N_FILES * PER_FILE} B of inline text)`
		+ ` and ${N_DIAMONDS} Diamonds of ${D_SIZE} B`);
	note(`ceilings: parcel ${PARCEL_MAX}, phone soft inline ${SOFT_MOB}`);

	// ═══ A — the first collect of a fresh sitting, the gateway answering ═══
	//
	// Nothing is in chunk storage and nothing is in the index, so nothing can be
	// confirmed held: the honest answer is a parcel that FITS, with what could not
	// ride held back and the census saying so.
	console.log('\n— A: first collect, fresh page, the store answering —');
	const A = await collect(page, 'ok');
	note(line(A));
	note(A.trail || '(no trail)');
	note(A.pend || '(no pending diag)');
	check('A: the inline files stay inside the parcel ceiling',
		A.f <= PARCEL_MAX, `${A.f} of ${PARCEL_MAX}`);
	check('A: and the whole parcel fits the front door',
		A.wire <= A.door, `${A.wire} of ${A.door}`);
	check('A: all 25 Diamonds travel', A.diamonds === N_DIAMONDS, `${A.diamonds} sent`);
	check('A: and every one as an @d/ reference', A.refs === N_DIAMONDS, `${A.refs} refs`);
	check('A: nothing is NAMED "did not fit"', A.named === 0, `named=${A.named}`);
	check('A: and no banner stands', !A.banner);
	check('A: the files the parcel could not carry are HELD, not named',
		A.fileHeld > 0 && A.nFiles > 0, `${A.fileHeld} held, ${A.nFiles} carried`);
	check('A: and the census says INCOMPLETE, which is what stops a peer deleting them by absence',
		A.complete === false, `filesComplete=${A.complete}`);

	// ═══ C — the round after: the manifests are confirmed, the parcel is small ═══
	console.log('\n— C: the collect after, and the fixed point —');
	const C1 = await collect(page, 'ok');
	note(line(C1));
	if (persists) {
		check('C: the confirmed files have left the parcel',
			C1.f <= SMALL, `${C1.f} of ${SMALL}`);
		check('C: and the census is COMPLETE again', C1.complete === true, `filesComplete=${C1.complete}`);
	} else {
		note('C: no manifest can be recorded on this engine, so no round can demote a file'
			+ ' to a reference; the parcel stays at the budget and is still inside it');
		check('C: the parcel is bounded even where nothing can ever be confirmed',
			C1.f <= PARCEL_MAX && C1.wire <= C1.door, `${C1.f} of ${PARCEL_MAX}, wire ${C1.wire}`);
	}
	check('C: all 25 Diamonds still travel, none named',
		C1.diamonds === N_DIAMONDS && C1.named === 0, `${C1.diamonds} sent, named=${C1.named}`);
	const C2 = await collect(page, 'ok');
	check('C: a third collect of an unchanged device is byte-identical to the second',
		C1.key === C2.key, C1.key === C2.key ? '' : 'the parcel moved between two quiet collects');

	// ═══ D — THE OWNER'S CASE: a boot, same profile, same index ═══
	console.log('\n— D: a reload, which is the boot that was failing —');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	await arm(page, { diamonds, files });
	const D = await collect(page, 'ok');
	note(line(D));
	note(D.pend || '(no pending diag)');
	if (persists) {
		check('D: the FIRST collect after a boot is already the small parcel',
			D.f <= SMALL, `${D.f} of ${SMALL}`);
	} else {
		note('D: and the same here — what a boot can be shown on this engine is that the'
			+ ' budget binds from the first collect, not that the manifests are reused');
		check('D: the first collect after a boot is inside the parcel ceiling',
			D.f <= PARCEL_MAX, `${D.f} of ${PARCEL_MAX}`);
	}
	check('D: and well inside the front door', D.wire <= D.door, `${D.wire} of ${D.door}`);
	// Every one TRAVELS; how many ride inline is a budget question and not this file's.
	// With the files out of the way the Diamonds are handed the whole phone ceiling, so
	// the freshest two are carried in the blob and the rest offload — which is the
	// inline set doing exactly what it is for.
	check('D: all 25 Diamonds travel on that first collect',
		D.diamonds === N_DIAMONDS && D.refs + D.inline === N_DIAMONDS,
		`${D.diamonds} sent, ${D.refs} as references, ${D.inline} inline`);
	check('D: nothing is named and no banner stands', D.named === 0 && !D.banner, `named=${D.named}`);
	if (persists) {
		check('D: and the census is complete — nothing had to be held',
			D.complete === true, `filesComplete=${D.complete}`);
	} else {
		check('D: and what was held is held, not named, and the census says so',
			D.fileHeld > 0 && D.complete === false, `held=${D.fileHeld} complete=${D.complete}`);
	}

	// ═══ B — the sweep unanswered, which is fix 1 standing alone ═══
	//
	// A 500 to `have` means nothing can be confirmed: `_offloadConfirmed` cannot be
	// filled from the index, and `collectChunked` will not fill it either. So the
	// only thing keeping the parcel inside the door is the hard budget.
	console.log('\n— B: the presence sweep unanswered —');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	await arm(page, { diamonds, files });
	const B = await collect(page, 'have500');
	note(line(B));
	note(B.pend || '(no pending diag)');
	check('B: with nothing confirmable, the inline files still stay inside the parcel',
		B.f <= PARCEL_MAX, `${B.f} of ${PARCEL_MAX}`);
	check('B: and the parcel is not refused at the front door',
		B.wire <= B.door, `${B.wire} of ${B.door}`);
	check('B: all 25 Diamonds travel', B.diamonds === N_DIAMONDS, `${B.diamonds} sent`);
	check('B: nothing is NAMED', B.named === 0, `named=${B.named}`);
	check('B: the overflow is HELD and the census says so',
		B.fileHeld > 0 && B.complete === false, `held=${B.fileHeld} complete=${B.complete}`);

	// ═══ E — the store refusing the upload ═══
	console.log('\n— E: the chunk store refusing every put —');
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	await arm(page, { diamonds, files });
	// A fresh index as well as a fresh sitting, so nothing is already confirmed and
	// every offload this round has to be made — and refused.
	await page.evaluate(() => {
		try { localStorage.removeItem('daimond-cloud-index'); } catch (e) {}
		window.__forgetAll();
	});
	const E = await collect(page, 'put507');
	note(line(E));
	note(E.trail || '(no trail)');
	check('E: no file is NAMED when the store refuses', E.named === 0, `named=${E.named}`);
	check('E: the Diamonds are HELD, not named', E.held >= N_DIAMONDS, `held=${E.held}`);
	check('E: and the store\'s own refusal is what the user is shown',
		/storage limit/i.test(E.refused), JSON.stringify(E.refused).slice(0, 70));
	check('E: the parcel still fits the parcel ceiling', E.f <= PARCEL_MAX, `${E.f} of ${PARCEL_MAX}`);

	console.log('\nconsole errors:', s.errs.filter((e) => !/favicon|404|502|500|ERR_/.test(e)).slice(0, 4));
} finally {
	await s.close();
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
