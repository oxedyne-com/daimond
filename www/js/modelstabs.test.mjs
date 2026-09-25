/* ============================================================
   Test: two tabs of one device and the models store (the simulator's SIM-19,
   the release 5 D106 seeds).

   models.js holds the whole store in memory from boot and `save()` writes it
   back whole. With no `storage` listener a sibling tab never saw another
   tab's change: it collected parcels without it, and its next save erased it
   from the disk. A provider added in a tab that closed before its push landed
   was lost with that tab. The simulator's shrunk storm is three steps: the
   device goes offline, tab 1 adds a provider, tab 1 closes.

   The real www/js/models.js runs twice over one shared localStorage; the
   browser's `storage` event (fired in the OTHER tabs only) is fired by hand.

     SIBLING  tab 2 holds tab 1's provider once the event arrives (ab92fb0e: no)
     KEEPS    tab 2's own later change keeps it on the disk (ab92fb0e: erased)
     NUDGE    the event runs onChange, which redraws and nudges sync (ab92fb0e: no)
     KEY      the key a tab opened follows the one the other tab stored since
     [ctl]    another key's event leaves the store and onChange alone
     AWAIT    a sibling's save inside setKey's, applySync's or resealAfterRekey's
              await loses neither tab's change (r52d QA F1; 7ca624dd: all three lost)
     REMOVE   a sibling's removal holds in this tab, and this tab's next save keeps it;
              a removal of a row a faster clock touched holds too
     ERASE    a sibling's Forget empties this tab's copy rather than being written back
     CONVERGE random writes in two tabs, events delivered late and out of order: both
              tabs and the disk end on one store

   Run:  node www/js/modelstabs.test.mjs
         MODELS_JS=<tree>/www/js/models.js node www/js/modelstabs.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(process.env.MODELS_JS || join(HERE, 'models.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

// One device: one box, shared by its tabs.
const box = new Map();
const localStorage = {
	getItem:    (k) => (box.has(k) ? box.get(k) : null),
	setItem:    (k, v) => box.set(k, String(v)),
	removeItem: (k) => box.delete(k),
};
const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };

/// A tab: its own window and its own copy of models.js over the shared box.
function tab(name) {
	const listeners = {};
	const win = {
		addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
		dispatchEvent:    () => true,
		fire:             (type, ev) => { for (const fn of listeners[type] || []) fn(ev); },
	};
	// store.js and stamp.js first, as index.html loads them: models.js keeps its record through
	// DaimondStore and stamps with DaimondStamp, which this loader (no `with (window)`) reaches bare.
	loadStore(win, localStorage);
	globalThis.DaimondStamp = win.DaimondStamp;
	new Function('window', 'document', 'localStorage', 'console', SRC)(win, documentShim, localStorage, console);
	const M = win.DaimondModels;
	const changes = { n: 0 };
	M.init({ onChange: () => { changes.n++; } });
	return { name, win, M, changes };
}

const has = (t, id) => Object.prototype.hasOwnProperty.call(t.M.exportSync().providers, id);
const onDisk = (id) => {
	const raw = JSON.parse(localStorage.getItem('daimond-models-v2') || 'null');
	return !!(raw && raw.providers && Object.prototype.hasOwnProperty.call(raw.providers, id));
};

const A = tab('t1'), B = tab('t2');

console.log('\nSIBLING: tab 1 adds a provider; tab 2 hears the storage event\n');
A.M.addProvider('openai', {});
check('[ctl] tab 1 holds it and wrote it to the disk', has(A, 'openai') && onDisk('openai'));
const before = B.changes.n;
B.win.fire('storage', { key: 'daimond-models-v2' });
check('tab 2 holds the provider tab 1 added (ab92fb0e: no)', has(B, 'openai'), Object.keys(B.M.exportSync().providers));
check('so the parcel tab 2 collects carries it', !!B.M.exportSync().providers.openai);

console.log('\nNUDGE: the event runs onChange (a redraw, and sync nudged)\n');
check('tab 2\'s onChange ran on the event (ab92fb0e: no)', B.changes.n === before + 1, B.changes.n - before);

console.log('\nKEEPS: tab 1 closes; tab 2 makes its own change\n');
B.M.addProvider('anthropic', {});
check('tab 2\'s save keeps tab 1\'s provider on the disk (ab92fb0e: erased)', onDisk('openai') && onDisk('anthropic'),
	JSON.parse(localStorage.getItem('daimond-models-v2') || '{}').providers);

console.log('\nKEY: the opened key follows the stored one\n');
await B.M.setKey('openai', 'key-one');
A.win.fire('storage', { key: 'daimond-models-v2' });
check('tab 1 reads the key tab 2 set (ab92fb0e: none)', A.M.keyFor('openai') === 'key-one', A.M.keyFor('openai'));
await A.M.setKey('openai', 'key-two');
B.win.fire('storage', { key: 'daimond-models-v2' });
check('tab 2 reads the key tab 1 set since, not the one it opened itself (ab92fb0e: key-one)',
	B.M.keyFor('openai') === 'key-two', B.M.keyFor('openai'));

console.log('\n[ctl] another key\'s event\n');
const n0 = B.changes.n;
B.win.fire('storage', { key: 'daimond-pause' });
check('[ctl] leaves onChange alone', B.changes.n === n0, B.changes.n - n0);
check('[ctl] and the store as it was', has(B, 'openai') && has(B, 'anthropic'));

// ── AWAIT: two tabs over a fresh box, an identity whose seal takes D ms, and the
// browser's `storage` event fired in the other tab as a task, as it is delivered.
const D = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let gen = 1;
globalThis.DaimondIdentity = {
	isUnlocked: () => true,
	wrap:   async (k) => { await sleep(D); return 'enc' + gen + ':' + k; },
	unwrap: async (e) => { await sleep(D); const m = /^enc(\d+):(.*)$/.exec(String(e)); if (!m || +m[1] !== gen) throw new Error('sealed under another key'); return m[2]; },
};
function world() {
	const b = new Map(), tabs = [], tombs = {};
	// The provider tombstones daimond.js keeps, one map per box. models.js reads the name
	// bare, and this loader has no `with (window)`, so it is made global as well.
	const core = { tombs: () => Object.assign({}, tombs), tombstone: (k, id, at) => { tombs[id] = at || Date.now(); } };
	globalThis.DaimondCore = core;
	const ls = { getItem: (k) => (b.has(k) ? b.get(k) : null), removeItem: (k) => b.delete(k) };
	let writer = null;
	ls.setItem = (k, v) => {
		const old = b.get(k); b.set(k, String(v)); if (old === String(v)) return;
		for (const t of tabs) if (t !== writer) setTimeout(() => t.win.fire('storage', { key: k, newValue: String(v) }), 0);
	};
	function open(name) {
		const listeners = {};
		const win = { addEventListener: (ty, fn) => { (listeners[ty] = listeners[ty] || []).push(fn); }, dispatchEvent: () => true,
			fire: (ty, ev) => { for (const fn of listeners[ty] || []) fn(ev); }, DaimondIdentity: globalThis.DaimondIdentity, DaimondCore: core };
		loadStore(win, ls);
		globalThis.DaimondStamp = win.DaimondStamp;
		new Function('window', 'document', 'localStorage', 'console', SRC)(win, documentShim, ls, console);
		win.DaimondModels.init({ onChange: () => {} });
		const t = { name, win, M: win.DaimondModels };
		tabs.push(t);
		return t;
	}
	// A write made in a tab's own turn is that tab's; one after an await is nobody's, and
	// its event reaches the writer too, which the merge must take as a no-op.
	const as = (t, fn) => { writer = t; try { return fn(); } finally { writer = null; } };
	const disk = () => JSON.parse(b.get('daimond-models-v2') || 'null');
	return { open, as, disk, erase: () => { b.clear(); for (const t of tabs) setTimeout(() => t.win.fire('storage', { key: null, newValue: null }), 0); } };
}

console.log('\nAWAIT setKey: tab 1 pastes a key; tab 2 saves inside the seal\'s await\n');
{
	const w = world(), X = w.open('t1'), Y = w.open('t2');
	w.as(X, () => X.M.addProvider('openai', {}));
	await w.as(X, () => X.M.setKey('openai', 'k-old'));
	await sleep(5 * D);
	const pr = w.as(X, () => X.M.setKey('openai', 'k-new'));
	await sleep(D / 4); w.as(Y, () => Y.M.addProvider('anthropic', {}));
	await pr; await sleep(6 * D);
	const d = w.disk();
	check('the disk holds the key tab 1 pasted (7ca624dd: enc1:k-old)', d.providers.openai.keyEnc === 'enc1:k-new', d.providers.openai.keyEnc);
	check('both tabs use it', X.M.keyFor('openai') === 'k-new' && Y.M.keyFor('openai') === 'k-new', [X.M.keyFor('openai'), Y.M.keyFor('openai')]);
	check('and tab 2\'s provider is kept', !!d.providers.anthropic, Object.keys(d.providers));
}

console.log('\nAWAIT applySync: tab 1 adopts a parcel\'s key and provider; tab 2 saves inside the adopt\n');
{
	const w = world(), X = w.open('t1'), Y = w.open('t2');
	w.as(X, () => X.M.addProvider('openai', {}));
	await sleep(2 * D);
	const at = Date.now() + 60000;
	const remote = { v: 2, providers: {
		openai:  { name: 'OpenAI',  url: 'https://api.openai.com/v1',  keyEnc: 'enc1:k-remote',  models: [], fetched: 0, touched: at },
		mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1', keyEnc: 'enc1:k-mistral', models: [], fetched: 0, touched: at },
	} };
	const pr = w.as(X, () => X.M.applySync(remote));
	await sleep(D / 4); w.as(Y, () => Y.M.addProvider('groq', {}));
	const res = await pr; await sleep(6 * D);
	const d = w.disk();
	check('applySync reported the merge', res.added === 1 && res.updated === 1, res);
	check('the disk holds the parcel\'s provider and its newer key (7ca624dd: neither)',
		!!d.providers.mistral && d.providers.openai.keyEnc === 'enc1:k-remote', d.providers);
	check('and tab 2\'s provider', !!d.providers.groq, Object.keys(d.providers));
	check('tab 1 can use the parcel\'s provider; tab 2 opened it too', X.M.keyFor('mistral') === 'k-mistral' && Y.M.keyFor('mistral') === 'k-mistral',
		[X.M.keyFor('mistral'), Y.M.keyFor('mistral')]);
}

console.log('\nAWAIT resealAfterRekey: tab 2 saves inside the re-seal\n');
{
	gen = 1;
	const w = world(), X = w.open('t1'), Y = w.open('t2');
	w.as(X, () => { X.M.addProvider('openai', {}); X.M.addProvider('anthropic', {}); });
	await w.as(X, () => X.M.setKey('openai', 'k-o'));
	await w.as(X, () => X.M.setKey('anthropic', 'k-a'));
	await sleep(8 * D);
	gen = 2;
	const pr = w.as(X, () => X.M.resealAfterRekey());
	await sleep(D / 4); w.as(Y, () => Y.M.addProvider('groq', {}));
	const r = await pr; await sleep(8 * D);
	const d = w.disk();
	check('resealAfterRekey said ok', r.ok, r);
	check('every stored key opens under the new passphrase (7ca624dd: enc1:k-o)',
		/^enc2:/.test(d.providers.openai.keyEnc) && /^enc2:/.test(d.providers.anthropic.keyEnc), [d.providers.openai.keyEnc, d.providers.anthropic.keyEnc]);
	check('tab 1 still has its keys, tab 2 opened the new seals', X.M.keyFor('openai') === 'k-o' && Y.M.keyFor('anthropic') === 'k-a',
		[X.M.keyFor('openai'), Y.M.keyFor('anthropic')]);
	check('and tab 2\'s provider is kept', !!d.providers.groq, Object.keys(d.providers));
	gen = 1;
}

console.log('\nREMOVE: tab 2 removes a provider; tab 1 saves after\n');
{
	const w = world(), X = w.open('t1'), Y = w.open('t2');
	w.as(X, () => { X.M.addProvider('openai', {}); X.M.addProvider('groq', {}); });
	await sleep(2 * D);
	w.as(Y, () => Y.M.removeProvider('groq'));
	await sleep(2 * D);
	check('tab 1 drops it', !has(X, 'groq'), Object.keys(X.M.exportSync().providers));
	w.as(X, () => X.M.setDefault('openai', 'm1'));
	check('and tab 1\'s next save does not write it back', !w.disk().providers.groq && !!w.disk().providers.openai, Object.keys(w.disk().providers));
}

console.log('\nREMOVE AHEAD: a row a faster clock touched is removed here, and stays removed\n');
{
	const w = world(), X = w.open('t1');
	const ahead = Date.now() + 60000;			// another device's clock, a minute ahead
	await w.as(X, () => X.M.applySync({ v: 2, providers: { groq: { name: 'Groq', url: 'https://api.groq.com/x', models: [], fetched: 0, touched: ahead } } }));
	w.as(X, () => X.M.removeProvider('groq'));
	w.as(X, () => X.M.setDefault('openai', 'm1'));	// a later save merges the disk
	check('the removal holds through this tab\'s next save (a tomb at now lost to it)', !has(X, 'groq') && !w.disk().providers.groq,
		[Object.keys(X.M.exportSync().providers), Object.keys(w.disk().providers)]);
	check('and its tombstone outranks the row it removed', (X.M.exportSync().tombs.groq || 0) > ahead, X.M.exportSync().tombs);
}

console.log('\nERASE: tab 2 forgets the box; tab 1 follows\n');
{
	const w = world(), X = w.open('t1');
	w.as(X, () => X.M.addProvider('openai', {}));
	await w.as(X, () => X.M.setKey('openai', 'k-x'));
	w.erase();
	await sleep(2 * D);
	check('tab 1 holds no provider and no key', !has(X, 'openai') && X.M.keyFor('openai') === '', [Object.keys(X.M.exportSync().providers), X.M.keyFor('openai')]);
}

console.log('\nCONVERGE: two tabs, random writes, events in any order: one store\n');
{
	// A seeded generator, so a failure names a seed that replays it.
	let seed = 0;
	const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const IDS = ['openai', 'groq', 'anthropic'];
	const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
		? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x);
	let bad = 0, firstBad = '', lost = 0, firstLost = '';
	for (let s = 1; s <= 40; s++) {
		seed = s;
		const b = new Map(), queue = [], tombs = {};
		globalThis.DaimondCore = { tombs: () => Object.assign({}, tombs), tombstone: (k, id, at) => { tombs[id] = at || Date.now(); } };
		const ls = { getItem: (k) => (b.has(k) ? b.get(k) : null), removeItem: (k) => b.delete(k) };
		const tabs = [];
		let writer = null;
		ls.setItem = (k, v) => { const o = b.get(k); b.set(k, String(v)); if (o === String(v)) return;
			for (const t of tabs) if (t !== writer) queue.push([t, { key: k, newValue: String(v) }]); };
		for (const name of ['x', 'y']) {
			const listeners = {};
			const win = { addEventListener: (ty, fn) => { (listeners[ty] = listeners[ty] || []).push(fn); }, dispatchEvent: () => true,
				fire: (ty, ev) => { for (const fn of listeners[ty] || []) fn(ev); }, DaimondCore: globalThis.DaimondCore };
			loadStore(win, ls);
			globalThis.DaimondStamp = win.DaimondStamp;
			new Function('window', 'document', 'localStorage', 'console', SRC)(win, documentShim, ls, console);
			win.DaimondModels.init({ onChange: () => {} });
			tabs.push({ win, M: win.DaimondModels });
		}
		// Each step: one tab writes, and a random share of the queued events is delivered, in
		// a random order: some writes are made before the tab has heard its sibling's.
		// What must survive, by the order the writes were made in (2 ms apart, so no two
		// share a stamp): a row's last add, removal or configuration write decides it, and
		// the last default chosen stands.
		const alive = {};
		let def = null;
		for (let step = 0; step < 14; step++) {
			await new Promise((r) => setTimeout(r, 2));
			const t = pick(tabs), id = pick(IDS), op = rnd();
			writer = t;
			if (op < 0.3) { t.M.addProvider(id, {}); alive[id] = true; }
			else if (op < 0.45) { if (t.M.exportSync().providers[id]) { t.M.removeProvider(id); alive[id] = false; } }
			else if (op < 0.65) { const m = 'm' + Math.floor(rnd() * 3); t.M.setDefault(id, m); def = id + '/' + m; }
			else if (op < 0.8) { if (t.M.exportSync().providers[id]) t.M.setRouting(id, 'm1', rnd() < 0.3 ? '' : 'via-' + step); }
			else { if (t.M.exportSync().providers[id]) { t.M.setCreditBase(id, step); alive[id] = true; } }
			writer = null;
			for (let n = Math.floor(rnd() * (queue.length + 1)); n > 0; n--) { const [tt, ev] = queue.splice(Math.floor(rnd() * queue.length), 1)[0]; tt.win.fire('storage', ev); }
		}
		while (queue.length) { const [tt, ev] = queue.shift(); tt.win.fire('storage', ev); }
		const [x, y] = tabs;
		const X = canon(x.M.exportSync()), Y = canon(y.M.exportSync());
		const disk = JSON.parse(b.get('daimond-models-v2') || '{}');
		const R = canon([x.M.routing('openai', 'm1'), x.M.routing('groq', 'm1'), x.M.routing('anthropic', 'm1')]);
		const RY = canon([y.M.routing('openai', 'm1'), y.M.routing('groq', 'm1'), y.M.routing('anthropic', 'm1')]);
		const same = X === Y && R === RY && Object.keys(disk.providers || {}).sort().join() === Object.keys(JSON.parse(X).providers).sort().join();
		if (!same) { bad++; if (!firstBad) firstBad = 'seed ' + s + ': ' + X + ' vs ' + Y + ' routing ' + R + ' vs ' + RY; }
		const want = IDS.filter((id) => alive[id]).sort().join(), have = Object.keys(JSON.parse(X).providers).sort().join();
		const d = JSON.parse(X).def, haveDef = d.provider ? d.provider + '/' + d.model : null;
		if (want !== have || (def && haveDef !== def)) { lost++; if (!firstLost) firstLost = 'seed ' + s + ': providers ' + have + ' want ' + want + '; default ' + haveDef + ' want ' + def; }
	}
	check('40 seeds: both tabs and the disk hold one store after every event lands', bad === 0, firstBad);
	check('and it lost no write: each row as its last write left it, the last default chosen (7ca624dd: lost)', lost === 0, firstLost);
}

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
if (failures) { console.log('FAILURES: ' + failures); process.exit(1); }
