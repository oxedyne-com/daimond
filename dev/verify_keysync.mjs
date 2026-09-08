// verify_keysync.mjs — provider keys and model config travel between linked
// devices, so a user never re-enters a key per device; and a device that CANNOT
// read a synced key is never left silently broken and never loses a working one.
//
// THE FEATURE. Provider config (name, URL, model list, published rates, manual
// credit base) and the SEALED provider key (`keyEnc`, never a plaintext key) ride
// the E2E sync parcel as a stamped, sorted `models` section — see
// `DaimondModels.exportSync` / `applySync` and daimond.js `collectSync` (the
// `models:` field) / `applySync` (the `models` section). Linked devices share one
// identity (salt + wrapping key travel in the pairing bundle), so a `keyEnc`
// sealed on one device OPENS on the other; the parcel is sealed again over the top,
// so the gateway in the middle can read neither. The merge is a per-provider
// freshest-wins union with tombstones: two devices editing different providers keep
// both, the same provider edited on both resolves on the later `touched` stamp.
//
// WHAT THIS PROVES, one section per property the task named:
//   (a) SHARED IDENTITY: device A enters an OpenRouter key; after a sync round
//       device B holds it and `resolve()` succeeds on B WITHOUT re-entry. And the
//       exported section carries the SEALED key only — never a plaintext one.
//   (b) STAMPED MERGE: A and B edit DIFFERENT providers → both survive; the SAME
//       provider edited on both → the fresher `touched` wins, the older never
//       clobbers.
//   (c) LOCKED DEVICE: a locked identity publishes NO models section (exportSync
//       and the real collectSync both answer null), so it cannot publish or clobber.
//   (d) DIVERGENT IDENTITY: a re-minted device (fresh salt) that receives a `keyEnc`
//       it cannot unseal lands in the compose-resilience "this device can't read
//       your keys" prompt — not a silent dead end — and a synced UNREADABLE key
//       never overwrites a LOCALLY-READABLE one (proven across a simulated reload).
//   (e) FIXED POINT: an unchanged config yields a byte-identical models section on
//       two successive collects, so a quiet device does not storm sync.
//
// NEGATIVE CONTROL (`--break nokey`): applySync is served with its key adoption
// neutered (a provider is adopted with an EMPTY keyEnc). Section (a) must then FAIL
// — B receives the provider but no key, and resolve() goes null. A green (a) under
// the break would mean the transport was not load-bearing and the rest proves
// nothing. The break asserts its anchor lands exactly once; a drifted anchor is a
// break that quietly stopped applying.
//
// Drives the REAL client end to end on WebKit — the engine the owner's iPhone runs,
// and the one the divergent-identity SEV-1 was reported on. Needs dev/serve.mjs
// (DAIMOND_PORT) and, for the compose-resilience UI in (d), a connected mock
// (DAIMOND_MOCK_PORT); like verify_composeresilience.
//
//   node dev/verify_keysync.mjs
//   node dev/verify_keysync.mjs --break nokey
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, connectMock, PASS, MODEL as MOCK_MODEL } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = 'js/models.js';

// ── The one source break ─────────────────────────────────────────────
// The key adoption is inside applySync's merge, unreachable from the page, so the
// only honest way to disable it is to serve a different file. `nokey` adopts every
// provider with an empty keyEnc — the transport carries the row but drops the key.
const SRC_BREAKS = {
	nokey: {
		find: "\t\t\t\t\tkeyEnc:  r.keyEnc || '',",
		with: "\t\t\t\t\tkeyEnc:  '',",
	},
};
const BI  = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

let patched = null;
if (SRC_BREAKS[BREAK]) {
	const spec = SRC_BREAKS[BREAK];
	patched = fs.readFileSync(path.join(HERE, '..', 'www', SRC), 'utf8');
	const n = patched.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${SRC}; the file has `
			+ 'moved on and the run below would prove nothing. Move the anchor with it.\n  '
			+ spec.find.trim());
		process.exit(2);
	}
	patched = patched.replace(spec.find, spec.with);
} else if (BREAK) {
	console.error(`unknown --break '${BREAK}'. Known: ${Object.keys(SRC_BREAKS).join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// A model that resolve() will accept. resolve() needs only provider + key + model
// set on the row; it does not consult the catalogue, so any id works.
const MODEL = 'accounts/fireworks/models/glm-5p2';
const URL   = 'https://openrouter.ai/api/v1/chat/completions';

const s = await open({
	name: 'keysync', browser: 'webkit',
	route: patched ? async (page) => {
		await page.route('**/' + SRC, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body: patched,
		}));
	} : null,
});
const p = s.page;

try {
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);
	await p.waitForFunction(
		() => !!(window.DaimondModels && DaimondModels.exportSync && DaimondModels.applySync
			&& window.DaimondCore && DaimondCore.collectSync
			&& window.DaimondIdentity && DaimondIdentity.isUnlocked && DaimondIdentity.isUnlocked()),
		null, { timeout: 15000 });

	// ── (a) shared identity: A's key reaches B, resolve() succeeds, no re-entry ──
	//
	// B builds "A's parcel" the way exportSync would, with keyEnc = wrap(secret)
	// under the SHARED identity — so unwrap on B opens it. B holds no key of its own
	// for this provider first (the check is not trivial), then applies and resolves.
	const a = await p.evaluate(async ({ MODEL, URL }) => {
		const M = window.DaimondModels;
		const secret = 'sk-or-DEVICE-A-secret-9f3';   // allowlist secret — test fixture, not a real key
		const keyEnc = await DaimondIdentity.wrap(secret);
		const now = Date.now();
		// B before: no such provider, nothing resolves on it.
		const before = !!M.resolve('or-a', MODEL);
		const parcelA = {
			v: 2, def: { provider: 'or-a', model: MODEL }, defAt: now,
			draft: { provider: '', model: '' }, draftAt: 0,
			providers: { 'or-a': {
				name: 'OpenRouter', url: URL, models: [MODEL],
				fetched: now, touched: now, keyEnc,
			} },
			tombs: {},
		};
		const res = await M.applySync(parcelA);
		const r = M.resolve('or-a', MODEL);
		return { secret, before, res, apiKey: r ? r.apiKey : null,
			baseUrl: r ? r.baseUrl : null, model: r ? r.model : null };
	}, { MODEL, URL });
	check('(a) B holds no key for the provider before the sync (test is not trivial)', a.before === false);
	check('(a) after applying A\'s parcel, resolve() on B succeeds with A\'s key — no re-entry',
		a.apiKey === a.secret && a.model === MODEL, `apiKey=${a.apiKey} model=${a.model}`);

	// The export side: a device with a key publishes the SEALED key and NO plaintext.
	const sec = await p.evaluate(async ({ MODEL, URL }) => {
		const M = window.DaimondModels;
		const secret = 'sk-PLAINTEXT-must-not-travel-42';   // allowlist secret — test fixture, not a real key
		M.addProvider('or-sec', { name: 'SecProv', url: URL });
		await M.setKey('or-sec', secret);
		M.setDefault('or-sec', MODEL);
		const parcel = await DaimondCore.collectSync();
		const row = (parcel.models && parcel.models.providers && parcel.models.providers['or-sec']) || {};
		const whole = JSON.stringify(parcel);
		return {
			hasKeyEnc:      !!row.keyEnc,
			carriesPlain:   whole.includes(secret),
			rowKeys:        Object.keys(row).sort().join(','),
			readsBack:      (M.resolve('or-sec', MODEL) || {}).apiKey === secret,
		};
	}, { MODEL, URL });
	check('(a) exportSync carries the SEALED key (keyEnc present)', sec.hasKeyEnc, sec.rowKeys);
	check('(a) the parcel carries NO plaintext key anywhere', sec.carriesPlain === false,
		sec.carriesPlain ? 'PLAINTEXT LEAKED' : 'clean');
	check('(a) and the sealed key still reads back locally', sec.readsBack);

	// ── (b) stamped merge: different providers survive; same provider, fresher wins ──
	const b = await p.evaluate(async ({ MODEL, URL }) => {
		const M = window.DaimondModels;
		const now = Date.now();
		const wrap = (s) => DaimondIdentity.wrap(s);
		// B already holds provider 'p-b' (its own edit). A's parcel names a DIFFERENT
		// provider 'p-a'. Both must survive the merge.
		M.addProvider('p-b', { name: 'Bprov', url: URL });
		await M.setKey('p-b', 'key-B-only');
		const parcelDiff = {
			v: 2, def: { provider: '', model: '' }, defAt: 0, draft: { provider: '', model: '' }, draftAt: 0,
			providers: { 'p-a': { name: 'Aprov', url: URL, models: [MODEL],
				fetched: now, touched: now, keyEnc: await wrap('key-A-only') } },
			tombs: {},
		};
		await M.applySync(parcelDiff);
		const bothSurvive = (M.resolve('p-a', MODEL) || {}).apiKey === 'key-A-only'
			&& (M.resolve('p-b', MODEL) || {}).apiKey === 'key-B-only';

		// Same provider edited on both. B set 'p-same' recently (touched ~= now). The
		// adopted key is read at the next unlock (the merge keeps the SESSION key in
		// place mid-turn), so each outcome is observed after a lock()+unseal() that
		// re-derives the plaintext from the STORE — the durable freshest-wins result.
		M.addProvider('p-same', { name: 'Same', url: URL });
		await M.setKey('p-same', 'B-current');            // touched = Tb (now-ish)
		const Tb = Date.now();
		// A's OLDER edit must NOT win.
		await M.applySync({
			v: 2, def: { provider: '', model: '' }, defAt: 0, draft: { provider: '', model: '' }, draftAt: 0,
			providers: { 'p-same': { name: 'Same', url: URL, models: [MODEL],
				fetched: 0, touched: Tb - 60000, keyEnc: await wrap('A-stale') } },
			tombs: {},
		});
		M.lock(); await M.unseal();
		const olderLost = (M.resolve('p-same', MODEL) || {}).apiKey === 'B-current';
		// A's NEWER edit must win.
		await M.applySync({
			v: 2, def: { provider: '', model: '' }, defAt: 0, draft: { provider: '', model: '' }, draftAt: 0,
			providers: { 'p-same': { name: 'Same', url: URL, models: [MODEL],
				fetched: 0, touched: Tb + 60000, keyEnc: await wrap('A-fresher') } },
			tombs: {},
		});
		M.lock(); await M.unseal();
		const newerWon = (M.resolve('p-same', MODEL) || {}).apiKey === 'A-fresher';
		return { bothSurvive, olderLost, newerWon };
	}, { MODEL, URL });
	check('(b) two devices editing DIFFERENT providers keep both', b.bothSurvive);
	check('(b) same provider: an OLDER remote edit does NOT clobber the local one', b.olderLost);
	check('(b) same provider: a FRESHER remote edit wins', b.newerWon);

	// ── (c) a LOCKED device publishes nothing ────────────────────────────────
	const c = await p.evaluate(async (PASS) => {
		const M = window.DaimondModels;
		const unlockedExport   = M.exportSync();
		const unlockedInParcel = (await DaimondCore.collectSync()).models;
		DaimondIdentity.lock();
		const lockedExport   = M.exportSync();
		const lockedInParcel = (await DaimondCore.collectSync()).models;
		await DaimondIdentity.unlock(PASS);   // restore for the rest of the run
		await M.unseal();
		return {
			unlockedNonNull: unlockedExport !== null && unlockedInParcel !== null,
			lockedExportNull: lockedExport === null,
			lockedParcelNull: lockedInParcel === null,
			relockedOk: DaimondIdentity.isUnlocked(),
		};
	}, PASS);
	check('(c) an UNLOCKED device does publish a models section (test is not trivial)', c.unlockedNonNull);
	check('(c) a LOCKED device\'s exportSync answers null — it publishes no section', c.lockedExportNull);
	check('(c) and the real collectSync models field is null while locked', c.lockedParcelNull);
	check('(c) the identity re-unlocks cleanly for the rest of the run', c.relockedOk);

	// ── (d) divergent identity: unreadable synced key → re-enter, never clobber ──
	//
	// (d2) first, on the shared page: B holds a LOCALLY-READABLE key; a FRESHER parcel
	// arrives whose keyEnc will not unseal here (a garbage ciphertext stands in for
	// one sealed under a foreign salt). The readable key must survive — including
	// across a reload, simulated by lock()+unseal() re-deriving plain from the store.
	const d2 = await p.evaluate(async ({ MODEL, URL }) => {
		const M = window.DaimondModels;
		M.addProvider('p-div', { name: 'Div', url: URL });
		await M.setKey('p-div', 'LOCAL-good-key');      // readable, sealed under THIS identity
		M.setDefault('p-div', MODEL);
		const localOk = (M.resolve('p-div', MODEL) || {}).apiKey === 'LOCAL-good-key';
		const foreign = 'Zm9yZWlnbi1zZWFsZWQtdW5yZWFkYWJsZS1jaXBoZXJ0ZXh0';   // will not unwrap here
		const later = Date.now() + 90000;
		await M.applySync({
			v: 2, def: { provider: '', model: '' }, defAt: 0, draft: { provider: '', model: '' }, draftAt: 0,
			providers: { 'p-div': { name: 'Div', url: URL, models: [MODEL],
				fetched: later, touched: later, keyEnc: foreign } },
			tombs: {},
		});
		const sessionOk = (M.resolve('p-div', MODEL) || {}).apiKey === 'LOCAL-good-key';
		// Simulate a reload: plain is dropped and re-derived from the STORE's keyEnc.
		M.lock();
		await M.unseal();
		const afterReload = M.resolve('p-div', MODEL);
		return { localOk, sessionOk,
			afterReloadKey: afterReload ? afterReload.apiKey : null };
	}, { MODEL, URL });
	check('(d) a locally-readable key resolves before the divergent sync (not trivial)', d2.localOk);
	check('(d) a fresher UNREADABLE synced key does not disturb the readable key in-session', d2.sessionOk);
	check('(d) and the readable key SURVIVES a reload — the unreadable one never clobbers it',
		d2.afterReloadKey === 'LOCAL-good-key', `afterReload=${d2.afterReloadKey}`);

	// (d1) a divergent device with NO local key: a synced unreadable keyEnc must land
	// in the compose-resilience path (provider present but sealed → resolve null),
	// which drives the inline "can't read your keys" prompt rather than a dead end.
	const d1 = await p.evaluate(async ({ MODEL, URL }) => {
		const M = window.DaimondModels;
		const foreign = 'Zm9yZWlnbi1zZWFsZWQtbm8tbG9jYWwta2V5LWNpcGhlcg==';
		const now = Date.now();
		await M.applySync({
			v: 2, def: { provider: 'p-div2', model: MODEL }, defAt: now,
			draft: { provider: '', model: '' }, draftAt: 0,
			providers: { 'p-div2': { name: 'Div2', url: URL, models: [MODEL],
				fetched: now, touched: now, keyEnc: foreign } },
			tombs: {},
		});
		const prov = M.providers().find(x => x.id === 'p-div2') || {};
		return {
			resolvesNull: !M.resolve('p-div2', MODEL),
			hasKey: !!prov.hasKey, sealed: !!prov.sealed,
			// The exact condition daimond.js `pendingStartBlock` reads for the prompt.
			composeResilienceTriggers: M.providers().some(x => x.hasKey && x.sealed),
		};
	}, { MODEL, URL });
	check('(d) a divergent device with no local key: the synced key resolves null (no silent run)',
		d1.resolvesNull);
	check('(d) the provider reads present-but-sealed (hasKey && sealed) — the re-enter state',
		d1.hasKey && d1.sealed, `hasKey=${d1.hasKey} sealed=${d1.sealed}`);
	check('(d) which is exactly what the compose-resilience prompt keys on',
		d1.composeResilienceTriggers);

	// ── (e) fixed point: an unchanged config is byte-identical across two collects ──
	const e = await p.evaluate(async () => {
		const m1 = JSON.stringify((await DaimondCore.collectSync()).models);
		const m2 = JSON.stringify((await DaimondCore.collectSync()).models);
		return { equal: m1 === m2, len: m1 ? m1.length : 0 };
	});
	check('(e) two successive collects produce a byte-identical models section', e.equal, `len=${e.len}`);

	// ── (d) the REAL divergent-identity path: re-mint, then RECEIVE via sync ──────
	//
	// The strongest form: a genuine re-mint (fresh random salt, the SEV-1 shape), then
	// a key delivered through the SYNC path lands in the live compose-resilience UI.
	// A separate page/profile, connected to the mock so a real chat UI exists.
	const profile = '/tmp/claude-1000/-home-jason-usr/acd49ac1-d25e-472b-b2d0-48eaaea0c5dc/scratchpad/pw-keysync-remint';
	fs.rmSync(profile, { recursive: true, force: true });
	const s2 = await open({ browser: 'webkit', name: 'keysync-remint', profile,
		route: patched ? async (page) => {
			await page.route('**/' + SRC, r => r.fulfill({
				status: 200, contentType: 'application/javascript', body: patched }));
		} : null,
	});
	try {
		await connectMock(s2, { model: MOCK_MODEL });   // a real sealed key under identity A
		// Re-mint the identity: fresh salt B, same passphrase. The saved keyEnc is now
		// orphaned — unlock still succeeds, but nothing this device holds unwraps.
		await s2.page.evaluate(async (pass) => {
			await window.DaimondIdentity.create('remint', pass);
		}, PASS);
		await s2.page.reload({ waitUntil: 'domcontentloaded' });
		await s2.page.waitForSelector('#id-primary', { timeout: 10000 });
		await s2.page.fill('#id-pass', PASS);
		await s2.page.evaluate(() => document.getElementById('id-primary').click());
		await s2.page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 10000 }).catch(() => {});
		await s2.page.waitForTimeout(500);

		// Now DELIVER a provider key THROUGH THE SYNC PATH. Its keyEnc is sealed under
		// the old salt A (produced before the re-mint would be ideal, but any ciphertext
		// this identity cannot open reproduces the divergent case), so on identity B it
		// will not unseal — the exact thing the parcel must not turn into a silent break.
		const delivered = await s2.page.evaluate(async ({ MODEL, URL }) => {
			const M = window.DaimondModels;
			const foreign = 'Zm9yZWlnbi1zeW5jZWQta2V5LWZvci1kaXZlcmdlbnQtaWRlbnRpdHk=';
			const now = Date.now();
			await M.applySync({
				v: 2, def: { provider: 'synced', model: MODEL }, defAt: now,
				draft: { provider: '', model: '' }, draftAt: 0,
				providers: { synced: { name: 'Synced', url: URL, models: [MODEL],
					fetched: now, touched: now, keyEnc: foreign } },
				tombs: {},
			});
			const prov = M.providers().find(x => x.id === 'synced') || {};
			return { sealed: !!prov.sealed, hasKey: !!prov.hasKey, resolvesNull: !M.resolve('synced', MODEL) };
		}, { MODEL, URL });
		check('(d-real) a re-minted device receives a key it cannot unseal — present but sealed',
			delivered.hasKey && delivered.sealed && delivered.resolvesNull,
			`hasKey=${delivered.hasKey} sealed=${delivered.sealed} null=${delivered.resolvesNull}`);

		// Open a NEW pending chat and read the live centre: the composer must be shown
		// with an inline re-enter message, not a Start button that bounces.
		const drawerClose = s2.page.locator('#admin-close');
		if (await drawerClose.isVisible().catch(() => false)) {
			await drawerClose.click({ force: true });
			await s2.page.waitForTimeout(150);
		}
		await s2.page.click('#new-session-btn', { force: true });
		await s2.page.waitForTimeout(500);
		const centre = await s2.page.evaluate(() => {
			const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
			const bar = document.querySelector('.chat-input-bar');
			const input = document.getElementById('chat-input');
			const btn = document.querySelector('.pending-centre .empty-new-session');
			const para = document.querySelector('.pending-centre p');
			return {
				boxShown: vis(bar) && vis(input),
				pending: !!document.querySelector('.pending-centre'),
				btnText: btn ? (btn.textContent || '').trim() : '',
				message: para ? (para.textContent || '').trim() : '',
			};
		});
		check('(d-real) the composer is REVEALED on a new chat (never a hidden dead end)',
			centre.boxShown, `box=${centre.boxShown} pending=${centre.pending}`);
		check('(d-real) an inline re-enter message shows, not a Start button',
			centre.pending && !!centre.message && !/Start/i.test(centre.btnText),
			`msg="${centre.message.slice(0, 60)}" btn="${centre.btnText}"`);
	} finally {
		await s2.close();
	}

} catch (e) {
	console.error('verify_keysync threw:', e && (e.stack || e.message || e));
	bad.push('run threw: ' + (e && (e.message || e)));
} finally {
	await s.close();
}

console.log(`\nkeysync: ${ok.length}/${ok.length + bad.length} passed`
	+ (bad.length ? `; FAILED: ${bad.join(' | ')}` : ''));

// Under the break, section (a)'s key-adoption checks are EXPECTED to fail; a run
// that stays green would prove the transport was not load-bearing.
if (BREAK) {
	const aFailed = bad.some(n => n.includes("resolve() on B succeeds")) ;
	if (aFailed) {
		console.log(`  ..   --break ${BREAK}: (a) failed as required — the sync path is load-bearing`);
		process.exit(0);
	}
	console.error(`  !!   --break ${BREAK}: (a) did NOT fail — the break proved nothing`);
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
