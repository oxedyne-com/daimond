/* ============================================================
   Test — a write made after seeing a value outranks it, whatever the two
   devices' clocks say (the D-28 state review, A1: CLK-1..5, D112).
   ------------------------------------------------------------
   THE BUG. Every register was stamped `Date.now()`. A device whose clock
   is behind the device that wrote the value it replaces stamps its own
   write BELOW that value, so the next exchange puts the old value back on
   both. Measured in the review with the real modules and one clock five
   minutes fast: the owner tightened the permission rung to `ask` on the
   phone and both devices went on running `bypass` (CLK-2, high); turning
   debug-share off on the phone left it on everywhere (CLK-3); a chat
   rename reverted (D112).

   THE FIX. Every local stamp is `DaimondStamp.next(prev)` =
   `max(now, prev + 1)`, where `prev` is the stamp being replaced
   (www/js/stamp.js), and a Diamond edit that moved its stamp in EITHER
   direction since the fork point is kept as a version (daimond.js
   `applyDiamonds`; the wasm store's own floor is A2, not here).

   WHAT IS CHECKED, per register, with the real module (or the real
   daimond.js closure, lifted): two devices, one clock SKEW ahead; the
   fast one writes, the slow one adopts it and writes 60 s later in real
   time; the two exchange twice; the slow write must stand on both. At
   skews of -300 s, -1 s, 0, +1 s and +300 s.

   Run:  node www/js/stampfloor.test.mjs [--tree <checkout>]
   ============================================================ */
import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BASE = 1_000_000_000;
const SKEWS = [-300_000, -1000, 0, 1000, 300_000];

/// Two devices of one register. `make(now)` answers a device with `write(v)`,
/// `snap()`, `adopt(rec)` and `read()`; the fast device is `skew` ahead.
async function skewCase(name, make, first, second) {
	for (const skew of SKEWS) {
		const F = await make(BASE + skew), S = await make(BASE);
		await F.write(first);
		await S.adopt(await F.snap());
		S.w._setNow(BASE + 60_000); F.w._setNow(BASE + skew + 60_000);	// a minute later, in real time
		await S.write(second);
		for (let i = 0; i < 2; i++) { await F.adopt(await S.snap()); await S.adopt(await F.snap()); }
		const f = await F.read(), s = await S.read();
		check(name + ' at skew ' + (skew / 1000) + ' s: the later write stands on both',
			f === second && s === second, 'fast ' + JSON.stringify(f) + ', slow ' + JSON.stringify(s));
	}
}

console.log('stampfloor: the permission rung, a scope and debug-share (real modules)');
await skewCase('permission rung: bypass, then ask', async (now) => {
	const w = makeWindow({ now }); loadScript(w, 'handmode.js');
	const H = w.DaimondHandMode;
	H.init({ apply: () => true, confirm: async () => true, notice: () => {} });
	return { w, write: (m) => H.set(m), snap: () => H.snapshotPolicy(), adopt: (r) => H.adoptPolicy(r), read: () => H.get() };
}, 'bypass', 'ask');
await skewCase('reading scope: granted, then withheld', async (now) => {
	const w = makeWindow({ now }); loadScript(w, 'handmode.js');
	const H = w.DaimondHandMode;
	H.init({ apply: () => true, confirm: async () => true, notice: () => {} });
	return { w, write: (on) => H.grantScope('reading', on), snap: () => H.snapshotPolicy(), adopt: (r) => H.adoptPolicy(r),
		read: () => H.scopeGranted('reading') };
}, true, false);
await skewCase('debug-share: on, then off', async (now) => {
	const w = makeWindow({ now }); loadScript(w, 'debugshare.js');
	const D = w.DEBUG_SHARE;
	return { w, write: (on) => D.setEnabled(on), snap: () => D.syncSnapshot(), adopt: (r) => D.adoptSync(r), read: () => D.isOn() };
}, true, false);

console.log('\nstampfloor: the chat default model and drafting model (real models.js)');
for (const [label, set, get] of [['default model', 'setDefault', 'getDefault'], ['drafting model', 'setDraft', 'getDraft']]) {
	await skewCase(label + ': m1, then m2', async (now) => {
		const w = makeWindow({ now });
		w.DaimondIdentity = { isUnlocked: () => true, wrap: async (s) => s, unwrap: async (s) => s };
		const c = sliceDaimond(w, ['mergeTombMap', 'loadTombMap'], { ChatStore: { putTombs: () => Promise.resolve(true) },
			storageAlarm: () => {}, tOr: (k, f) => f }).fns;
		w.DaimondCore = { mergeTombs: c.mergeTombMap, loadTombMap: c.loadTombMap, tombs: c.loadTombMap };
		loadScript(w, 'models.js');
		const M = w.DaimondModels;
		M.init({});
		M.applySync({ v: 2, providers: { openai: { name: 'OpenAI', url: 'https://x', models: ['m1', 'm2'], fetched: 1, touched: 1 } }, tombs: {} });
		return { w, write: (m) => M[set]('openai', m), snap: () => M.exportSync(), adopt: (r) => M.applySync(r),
			read: () => M[get]().model };
	}, 'm1', 'm2');
}

console.log('\nstampfloor: a chat rename and a device name (daimond.js closures, lifted)');
await skewCase('chat rename: Alpha, then Beta', async (now) => {
	const w = makeWindow({ now });
	const f = sliceDaimond(w, ['touchChatMeta', 'mergeChatRecords'], { ChatStore: {} }).fns;
	let c = { id: 'c1', name: 'Untitled', messages: [], updatedAt: 1, metaAt: 1 };
	return { w,
		write: (n) => { c.name = n; f.touchChatMeta(c); },
		snap: () => JSON.parse(JSON.stringify(c)),
		adopt: (r) => { c = f.mergeChatRecords(r, c, { mtombs: {} }); },
		read: () => c.name };
}, 'Alpha', 'Beta');
await skewCase('device name: Desk, then Kitchen', async (now) => {
	const w = makeWindow({ now });
	const f = sliceDaimond(w, ['renameDevice', 'mergeDevices', 'loadDevices'], {
		ChatStore: { putTombs: () => Promise.resolve(true) }, storageAlarm: () => {}, tOr: (k, x) => x, t: (k) => k,
		deviceId: () => 'ffffffffffffffff', renderSeatLine: () => {}, nudgeSync: () => {} }).fns;
	const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
	f.mergeDevices({ [ID]: { name: 'Chrome on Linux', label: '', created: 1, namedAt: 0, seen: 1, build: '' } });
	return { w,
		write: (n) => f.renameDevice(ID, n),
		snap: () => JSON.parse(JSON.stringify(f.loadDevices())),
		adopt: (r) => f.mergeDevices(r),
		read: () => (f.loadDevices()[ID] || {}).label };
}, 'Desk', 'Kitchen');

// ── A Diamond edit on the slow device, as far as the JS side reaches ──────────
// The wasm store stamps an edit `touched = now` with no floor (A2 floors it); what
// the JS side decides is whether the pull that follows keeps the local edit. It
// used to keep it only when its stamp had RISEN past the fork point, and an edit
// on a slow clock after adopting a fast copy is stamped BELOW it: imported over,
// nothing kept (CLK-1). At a skew equal to the gap between adopting and editing
// the two stamps tie, which only the wasm floor can separate.
console.log('\nstampfloor: a Diamond edit made after adopting a faster clock\'s copy (applyDiamonds, lifted)');
async function diamondCase(skew) {
	function device(skewMs) {
		let clock = 1_000_000 + skewMs;
		const w = makeWindow({ now: clock });
		const store = {};
		const app = {
			list_diamonds: async () => JSON.stringify(Object.values(store).map((d) => ({ id: d.id, name: d.name, touched: d.touched, tags: [] }))),
			export_diamond: async (id) => JSON.stringify({ id, files: { 'crystal.json': store[id].body } }),
			import_diamond: async (json, keep) => {
				const p = JSON.parse(json), cur = store[p.id];
				if (cur && keep) cur.versions.push(cur.body);
				store[p.id] = { id: p.id, name: p.name || 'D', touched: p.touched, body: p.body, versions: cur ? cur.versions : [] };
			},
			delete_diamond: async (id) => { delete store[id]; },
			set_tags: async () => {}, union_links: async () => false,
		};
		const f = sliceDaimond(w, ['applyDiamonds'], {
			ChatStore: { putTombs: () => Promise.resolve(true) }, diamondApp: () => app, trail: () => {}, heapNote: () => '',
			DaimondMarksHere: { dropAll: () => false, settle: () => false }, notePeerRef: () => {}, bumpDiamonds: () => {},
			onDiamondsChangedElsewhere: async () => {}, signalLinksChanged: () => {}, setDiamondModel: () => {},
			storageAlarm: () => {}, tOr: (k, x) => x, DaimondCloud: undefined, DaimondChunks: undefined,
		}).fns;
		return { store, f, w,
			advance(ms) { clock += ms; w._setNow(clock); },
			edit(id, body) { store[id].body = body; store[id].touched = clock; },
			parcel() {
				return { diamonds: Object.values(store).map((d) => ({ id: d.id, touched: d.touched, updated: d.touched,
					data: JSON.stringify({ id: d.id, name: d.name, touched: d.touched, body: d.body }) })), diamondTombs: {} };
			} };
	}
	const F = device(skew), S = device(0);
	F.store.d = { id: 'd', name: 'D', touched: 900_000, body: 'v0', versions: [] };
	S.store.d = { id: 'd', name: 'D', touched: 900_000, body: 'v0', versions: [] };
	S.w.localStorage.setItem('daimond-diamond-base', JSON.stringify({ d: 900_000 }));
	F.edit('d', 'v1 fast');
	await S.f.applyDiamonds(F.parcel(), 'fast');
	S.advance(30_000);
	S.edit('d', 'v2 slow, after seeing v1');
	await S.f.applyDiamonds(F.parcel(), 'fast');
	await F.f.applyDiamonds(S.parcel(), 'slow');
	return [S.store.d.body, F.store.d.body, ...S.store.d.versions, ...F.store.d.versions].some((b) => /v2/.test(b));
}
for (const skew of [0, 29_000, 31_000, 120_000, 300_000]) {
	check('a slow edit ' + (skew / 1000) + ' s behind survives the next pull (kept, or kept as a version)', await diamondCase(skew));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall stampfloor checks passed');
process.exit(failures ? 1 : 0);
