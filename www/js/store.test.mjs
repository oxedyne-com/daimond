/* ============================================================
   Test — DaimondStore: a write the box refuses never counts as done.
   ------------------------------------------------------------
   P3's convergence simulator found four faces of one fault (SIM-10, 11, 13,
   16; P1b STO-1, A5): every module that keeps a synced record swallowed a
   refused `setItem`. `store.js` is the one checked write they all go through
   now. This drives the REAL modules over a Map-backed localStorage that can be
   filled, and asserts, per kind:

     (a) the mechanism: a refused write is held owed, read back merged by the
         kind's law, retried when there is room, said to a subscriber, and a
         merge's refused write THROWS (so its sync section is re-pulled);
     (b) a pause pressed on a full device stands in its tab through a sibling
         tab's write, and lands when there is room (SIM-11);
     (c) a restore from the trash likewise (SIM-11);
     (d) support consent is one record, so a full box cannot tear it (SIM-13),
         and a refused merge of it throws (SIM-16);
     (e) voice and the handle copy: a refused merge throws and is held (SIM-16);
     (f) the nomination is held owed at the source (SIM-10b), and a refused
         merge of it throws (SIM-16) -- lifted from daimond.js;
     (g) the roster merge is the same in either order (SIM-17) -- lifted;
     (h) the default merges the same in either order, and a deletion made after
         it was chosen clears it on every device (SIM-18);
     (i) a second conflict on a file keeps the fresh conflict copy (SIM-5).

   Each is proven able to fail:
     node www/js/store.test.mjs --break swallow    # put swallows: nothing held, merges never throw
     node www/js/store.test.mjs --break nolaw      # the retry ignores the law: a sibling's write is lost
     node www/js/store.test.mjs                    # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? String(process.argv[i + 1] || '') : ''; })();
const KNOWN = ['swallow', 'nolaw'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + BREAK + '; known: ' + KNOWN.join(', ')); process.exit(2); }

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function storeSrc() {
	let s = readFileSync(join(HERE, 'store.js'), 'utf8');
	if (BREAK === 'swallow') {
		const n = 'catch (e) { hold(key, value, law); return false; }';
		if (!s.includes(n)) throw new Error('break target not found: ' + n);
		s = s.replace(n, 'catch (e) { return true; /* BROKEN: swallowed */ }');
	}
	if (BREAK === 'nolaw') {
		const n = 'var v = o.law ? o.law(stored(k), clone(o.value)) : o.value;';
		if (!s.includes(n)) throw new Error('break target not found: ' + n);
		s = s.replace(n, 'var v = o.value; // BROKEN: no law');
	}
	return s;
}

/// One device's box: a Map, a switch that fills it, and the tabs that share it.
function box() {
	const map = new Map();
	const b = { map, full: false, tabs: [] };
	b.ls = {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => {
			if (b.full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
			const old = map.has(k) ? map.get(k) : null;
			map.set(k, String(v));
			// The other tabs hear it, as a browser tells them.
			for (const t of b.tabs) if (t !== b.writer) t.fire('storage', { key: k, oldValue: old, newValue: String(v) });
		},
		removeItem: (k) => { map.delete(k); },
	};
	return b;
}

/// A tab over `b`: its own window, DaimondStore and the named modules.
function tab(b, files, extra) {
	const on = {};
	const win = Object.assign({
		addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); },
		dispatchEvent: () => true,
		DaimondIdentity: { deviceId: () => 'dev', isUnlocked: () => true },
	}, extra || {});
	win.window = win;
	const t = { win, fire: (type, ev) => (on[type] || []).forEach((fn) => fn(Object.assign({ type }, ev || {}))) };
	// Writes from this tab are not echoed back to it.
	const ls = {
		getItem: b.ls.getItem,
		setItem: (k, v) => { b.writer = t; try { b.ls.setItem(k, v); } finally { b.writer = null; } },
		removeItem: b.ls.removeItem,
	};
	win.localStorage = ls;
	new Function('window', 'localStorage', storeSrc())(win, ls);
	new Function('window', 'localStorage', readFileSync(join(HERE, 'stamp.js'), 'utf8'))(win, ls);
	for (const f of files || []) {
		new Function('window', 'localStorage', 'CustomEvent', 'Event', 'document',
			'with (window) {\n' + readFileSync(join(HERE, f), 'utf8') + '\n}')(win, ls, function CustomEvent(type) { this.type = type; },
			function Event(type) { this.type = type; }, { getElementById: () => null, addEventListener: () => {} });
	}
	b.tabs.push(t);
	return t;
}

function throwsRefusal(S, fn) {
	try { fn(); return false; } catch (e) { return S.isRefused(e); }
}

// ── daimond.js lifting, as the other harnesses here do ──────────
const DSRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
function fn(name) {
	const at = DSRC.indexOf('\n\tfunction ' + name + '(');
	if (at < 0) throw new Error('not found in daimond.js: ' + name);
	const end = DSRC.indexOf('\n\t}', at + 1);
	return DSRC.slice(at + 1, end + 3);
}
function v(name) {
	const m = new RegExp('\\n\\tvar ' + name + '\\s*=[^\\n]*;').exec(DSRC);
	if (!m) throw new Error('var not found in daimond.js: ' + name);
	return m[0].trim();
}

async function main() {
	console.log('(a) the mechanism: held owed, read back by the law, retried, said, and a merge throws');
	{
		const b = box(), A = tab(b), B = tab(b), S = A.win.DaimondStore;
		const heard = [];
		S.subscribe((keys) => heard.push(keys.join(',')));
		const union = (x, y) => Array.from(new Set([].concat(x || [], y || []))).sort();
		check('a write with room lands', S.put('k', ['a'], union) === true && b.map.get('k') === '["a"]');
		b.full = true;
		check('a refused write answers false', S.put('k', ['a', 'b'], union) === false);
		check('and is owed, and said', S.owed().join() === 'k' && heard[heard.length - 1] === 'k', S.owed().join() + ' / ' + heard.join('|'));
		check('this tab reads it back', JSON.stringify(S.get('k', [])) === '["a","b"]', JSON.stringify(S.get('k', [])));
		check('the box does not hold it', b.map.get('k') === '["a"]');
		check('a merge the box refuses THROWS', throwsRefusal(S, () => S.putMerged('m', { x: 1 })));
		check('and is held all the same', (S.get('m', null) || {}).x === 1);
		// A sibling tab writes the same key with room to spare: its word and ours both stand.
		b.full = false;
		B.win.DaimondStore.put('k', ['a', 'c'], union);
		check('another tab\'s write is merged under ours by the law', JSON.stringify(S.get('k', [])) === '["a","b","c"]',
			JSON.stringify(S.get('k', [])));
		S.retry();
		check('the retry lands the law\'s answer, losing neither tab\'s', b.map.get('k') === '["a","b","c"]', b.map.get('k'));
		check('nothing is owed once it landed, and that is said', S.owed().length === 0 && heard[heard.length - 1] === '',
			S.owed().join() + ' / ' + heard.join('|'));
		S.remove('k');
		check('remove drops the record', !b.map.has('k'));
	}

	console.log('\n(b) a pause pressed on a full device stands, through a sibling tab\'s write, and lands (SIM-11)');
	{
		const b = box();
		const A = tab(b, ['pause.js']), B = tab(b, ['pause.js']);
		const P = A.win.DaimondPause, Q = B.win.DaimondPause;
		P.pausedIds(); Q.pausedIds();
		b.full = true;
		check('the press is taken', P.set('root/workers', false) === true);
		check('and holds here', P.isPaused('root/workers'));
		b.full = false;
		Q.set('root/chats/c0', false);		// the sibling stores a press of its own; A hears the storage event
		check('a sibling\'s write does not undo it', P.isPaused('root/workers') && P.isPaused('root/chats/c0'));
		A.win.DaimondStore.retry();
		const C = tab(b, ['pause.js']);		// a reload
		check('it landed: a new tab reads both presses', C.win.DaimondPause.isPaused('root/workers') && C.win.DaimondPause.isPaused('root/chats/c0'));
		b.full = true;
		const rec = JSON.parse(JSON.stringify(Q.snapshot()));
		rec.leaves['root/diamonds/d0/self'] = [1, Date.now() + 5, 'peer'];
		check('a merged record the box refuses throws', throwsRefusal(A.win.DaimondStore, () => P.adopt(rec)));
		check('and still holds here', P.isPaused('root/diamonds/d0/self'));
		b.full = false;
	}

	console.log('\n(c) a restore from the trash on a full device stands through a sibling\'s write (SIM-11)');
	{
		const b = box();
		const A = tab(b, ['trash.js']), B = tab(b, ['trash.js']);
		const T = A.win.DaimondTrash;
		T.put('c0', 'chat');
		b.full = true;
		T.back('c0');
		check('the restore holds here', !T.has('c0'));
		b.full = false;
		B.win.DaimondTrash.put('c1', 'chat');		// A drops its cache on the storage event and re-reads
		check('and survives the sibling\'s write', !T.has('c0') && T.has('c1'));
		A.win.DaimondStore.retry();
		check('and landed for a new tab', !tab(b, ['trash.js']).win.DaimondTrash.has('c0'));
	}

	console.log('\n(d) support consent is ONE record, and a refused merge throws (SIM-13, SIM-16)');
	{
		const b = box(), A = tab(b, ['support.js']);
		const Sup = A.win.DaimondSupport;
		b.full = true;
		check('a refused merge throws', throwsRefusal(A.win.DaimondStore, () => Sup.adoptSync({ on: true, at: 5000 })));
		check('the decision holds here, stamp and value together', Sup.consented() === true
			&& JSON.stringify(Sup.syncSnapshot()) === '{"on":true,"at":5000}', JSON.stringify(Sup.syncSnapshot()));
		check('and nothing half-written reached the box', !b.map.has('daimond-support-consent') && !b.map.has('daimond-support-consent-at')
			&& !b.map.has('daimond-support-consent-rec'));
		b.full = false;
		A.win.DaimondStore.retry();
		check('it lands as one record', b.map.get('daimond-support-consent-rec') === '{"on":true,"at":5000}');
		const L = tab(box(), ['support.js']);
		L.win.localStorage.setItem('daimond-support-consent', '1');
		L.win.localStorage.setItem('daimond-support-consent-at', '4000');
		check('a decision stored as the old pair is still read', JSON.stringify(L.win.DaimondSupport.syncSnapshot()) === '{"on":true,"at":4000}');
	}

	console.log('\n(e) voice and the handle copy: a refused merge throws and is held (SIM-16)');
	{
		const b = box(), A = tab(b, ['voice.js']);
		b.full = true;
		check('voice adopt throws', throwsRefusal(A.win.DaimondStore, () => A.win.DaimondVoice.adopt({ v: 1, s: 'wrapped-1', at: 10 })));
		check('and the record is held here', (A.win.DaimondVoice.snapshot() || {}).s === 'wrapped-1');
		const h = box(), H = tab(h, ['vendor/noble-curves.min.js', 'curvefallback.js', 'identity.js'].slice(2), {
			crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob });
		h.full = true;
		check('handle adopt throws', throwsRefusal(H.win.DaimondStore, () => H.win.DaimondIdentity.adoptHandle({ h: 'ada1', t: 20 })));
		check('and the copy is held here', H.win.DaimondIdentity.handleSnapshot().h === 'ada1');
	}

	console.log('\n(f) the nomination: held owed at the source (SIM-10b), and a refused merge throws (SIM-16)');
	{
		const b = box(), A = tab(b);
		const lift = new Function('window', 'localStorage', 'DaimondStore', 'DaimondStamp', [
			v('NOMINATED_KEY'), 'var DEVICE_ID_RE = /^[0-9a-f]{16}$|^[0-9a-f]{32}$/;',
			fn('ms'), fn('nominationSnapshot'), fn('nominateDevice'), fn('adoptNomination'), fn('fresherNomination'),
			fn('nominationRank'),
			'function renderSeatLine() {}',
			'return { nominateDevice: nominateDevice, nominationSnapshot: nominationSnapshot, adoptNomination: adoptNomination };',
		].join('\n'))(A.win, A.win.localStorage, A.win.DaimondStore, A.win.DaimondStamp);
		b.full = true;
		const rec = lift.nominateDevice('00112233445566aa');
		check('the choice is taken', !!rec && (lift.nominationSnapshot() || {}).id === '00112233445566aa');
		check('and owed, not lost', A.win.DaimondStore.owed().join() === 'daimond-nominated');
		check('a fresher merged one the box refuses throws',
			throwsRefusal(A.win.DaimondStore, () => lift.adoptNomination({ id: '8899aabbccddeeff', at: rec.at + 10 })));
		check('and is held', (lift.nominationSnapshot() || {}).id === '8899aabbccddeeff');
		b.full = false;
	}

	console.log('\n(g) the roster merges the same in either order (SIM-17)');
	{
		const L = new Function('DaimondStore', [
			'var DEVICE_ID_RE = /^[0-9a-f]{16}$|^[0-9a-f]{32}$/;', v('DEVICE_NAME_MAX'), v('DEVICE_ROSTER_MAX'),
			fn('ms'), fn('deviceEntry'), fn('rosterRecord'), fn('mergeRosters'), fn('mergeDeviceLine'),
			'function deviceId() { return "ffffffffffffffff"; }',
			'return { mergeRosters: mergeRosters };',
		].join('\n'))(null);
		const id = '00112233445566aa';
		const a = { [id]: { name: 'Chromium on Linux', label: 'Desk', created: 1790294453375, namedAt: 7, seen: 1790294453375, build: '' } };
		const c = { [id]: { name: 'Chromium on Linux', label: 'Lab', created: 1790294525565, namedAt: 7, seen: 1790294525565, build: '' } };
		const d = { [id]: { name: 'Firefox on Linux', label: '', created: 1790294525565, namedAt: 0, seen: 1790294525565, build: 'x' } };
		const j = (x) => JSON.stringify(x);
		check('x ⊔ y = y ⊔ x at an equal `seen`', j(L.mergeRosters(c, d)) === j(L.mergeRosters(d, c)),
			j(L.mergeRosters(c, d)) + ' vs ' + j(L.mergeRosters(d, c)));
		check('x ⊔ y = y ⊔ x at an equal `namedAt`', j(L.mergeRosters(a, c)) === j(L.mergeRosters(c, a)));
		check('(x ⊔ y) ⊔ z = x ⊔ (y ⊔ z)', j(L.mergeRosters(L.mergeRosters(a, c), d)) === j(L.mergeRosters(a, L.mergeRosters(c, d))));
		check('`created` is the earliest either side holds', L.mergeRosters(c, a)[id].created === 1790294453375);
		check('idempotent', j(L.mergeRosters(a, a)) === j(L.mergeRosters(a, {})));
	}

	console.log('\n(h) the default model merges the same in either order, and a deletion clears it (SIM-18)');
	{
		const replica = () => {
			const b = box(), tombs = {};
			const t = tab(b, ['models.js'], {
				DaimondCore: {
					tombs: () => Object.assign({}, tombs),
					tombstone: (k, id) => { tombs[id] = Date.now(); },
					mergeTombs: (k, inc) => { for (const id in (inc || {})) if (!tombs[id] || inc[id] > tombs[id]) tombs[id] = inc[id]; return Object.assign({}, tombs); },
				},
			});
			t.win.DaimondModels.init({});
			return t.win.DaimondModels;
		};
		const pause = () => new Promise((r) => setTimeout(r, 3));
		// x chooses openai/m1; y, which never chose it, deletes openai after that.
		const x = replica();
		x.addProvider('openai', {});
		const shared = JSON.parse(JSON.stringify(x.exportSync()));
		const y = replica();
		await y.applySync(shared);
		await pause();
		x.setDefault('openai', 'm1');
		await pause();
		y.removeProvider('openai');
		const X = JSON.parse(JSON.stringify(x.exportSync())), Y = JSON.parse(JSON.stringify(y.exportSync()));
		const xy = replica(); await xy.applySync(X); await xy.applySync(Y);
		const yx = replica(); await yx.applySync(Y); await yx.applySync(X);
		const raw = (m) => JSON.stringify([m.exportSync().def, m.exportSync().defAt]);
		check('x ⊔ y = y ⊔ x for the stored default', raw(xy) === raw(yx), raw(xy) + ' vs ' + raw(yx));
		check('and on both it reads as cleared: deleted after it was chosen',
			xy.getDefault().model === '' && yx.getDefault().model === '', JSON.stringify([xy.getDefault(), yx.getDefault()]));
		// A choice made AFTER a deletion stands.
		const z = replica();
		await z.applySync(Y);
		z.addProvider('openai', {});
		await pause();
		z.setDefault('openai', 'm2');
		const zy = replica(); await zy.applySync(z.exportSync()); await zy.applySync(Y);
		check('a choice made after the deletion stands', zy.getDefault().model === 'm2', JSON.stringify(zy.getDefault()));
		const t1 = replica(), t2 = replica();
		const tie = (p, m) => ({ v: 2, def: { provider: p, model: m }, defAt: 5000, draft: { provider: '', model: '' }, draftAt: 0, providers: {}, tombs: {} });
		await t1.applySync(tie('a', 'm1')); await t1.applySync(tie('b', 'm2'));
		await t2.applySync(tie('b', 'm2')); await t2.applySync(tie('a', 'm1'));
		check('an equal stamp is broken by the value, the same in either order', raw(t1) === raw(t2), raw(t1) + ' vs ' + raw(t2));
	}

	console.log('\n(i) a second conflict on a file keeps the fresh conflict copy (SIM-5)');
	{
		const b = box();
		const ix = {}, set = (o) => { for (const k of Object.keys(ix)) delete ix[k]; Object.assign(ix, o); };
		const t = tab(b, [], { DaimondDurable: { durable: () => false, ready: async () => {}, get: async () => null, set: async () => true, migrate: async () => false } });
		new Function('window', 'localStorage', 'indexedDB', 'with (window) {\n' + readFileSync(join(HERE, 'cloud.js'), 'utf8') + '\n}')(t.win, t.win.localStorage, undefined);
		const C = t.win.DaimondCloud;
		const m = (h) => ({ v: 2, size: 1, chunks: [{ addr: h.repeat(8), size: 1 }], hash: h });
		// Here: a.md is ours (h2) with an OLD conflict copy (h0) beside it; the fork point
		// was h1. They changed a.md too (h3) and still hold their own old copy (h9).
		t.win.localStorage.setItem('daimond-cloud-index', JSON.stringify({ 'a.md': m('h2'), 'a.md.synced': m('h0') }));
		await C.ready();
		const out = C.merge({ 'a.md': m('h3'), 'a.md.synced': m('h9') }, { 'a.md': 'h1', 'a.md.synced': 'h0' }, 'me', 'them');
		check('ours stands at the path', out['a.md'] && out['a.md'].hash === 'h2');
		check('THEIRS, the newer edit, is the conflict copy -- not a stored one', out['a.md.synced'] && out['a.md.synced'].hash === 'h3',
			out['a.md.synced'] && out['a.md.synced'].hash);
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	process.exit(BREAK ? (failures > 0 ? 0 : 1) : (failures > 0 ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
