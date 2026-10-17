/* ============================================================
   Test -- ALERTS ON THE PENDING PANEL (www/js/daimond.js `Pending`, kind `alert`; D-20261016-17).
   ------------------------------------------------------------
   `Pending` is LIFTED from daimond.js's own text (dev/syncprobe.mjs liftSource) and run as
   written over the REAL alerts.js, stamp.js and store.js; every other name it reaches is a
   stand-in, and the DOM is a small fake that records what `render` drew.

   Each check is proven able to fail:

     node www/js/alertpending.test.mjs --break count     # a quiet alert counts on the chip
     node www/js/alertpending.test.mjs --break saved     # alerts are written into the Pending list's own record
     node www/js/alertpending.test.mjs --break drop      # ✕ on an alert takes it off this list only, not the record
     node www/js/alertpending.test.mjs --break prio      # an alert tile offers a priority select
     node www/js/alertpending.test.mjs                   # and then, clean
   ============================================================ */
import { makeWindow, loadScript, liftSource } from '../../dev/syncprobe.mjs';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
const SWAPS = {
	count: ["return it.kind !== 'steer' && !(it.kind === 'alert' && !it.needs);", "return it.kind !== 'steer';"],
	saved: ["var mine = this.items.filter(function (it) { return it.kind !== 'alert'; });", "var mine = this.items;"],
	drop:  ["if (String(id).indexOf('a:') === 0) {", "if (false) {"],
	prio:  ["var prio = it.kind === 'alert' ? null : document.createElement('select');", "var prio = document.createElement('select');"],
};
if (BREAK && !SWAPS[BREAK]) { console.error('unknown break ' + BREAK); process.exit(2); }

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
function kase(name, fn) {
	cases++; bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.stack); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

// ── A fake DOM: enough for `render` and `tile` ──
function el(tag) {
	const e = { tagName: String(tag).toUpperCase(), children: [], dataset: {}, style: {}, attrs: {}, className: '', textContent: '', title: '', type: '', value: '',
		listeners: {},
		appendChild(c) { this.children.push(c); return c; },
		setAttribute(k, v) { this.attrs[k] = String(v); },
		addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
		click() { (this.listeners.click || []).forEach((f) => f()); },
	};
	Object.defineProperty(e, 'innerHTML', { set() { e.children = []; }, get() { return ''; } });
	return e;
}
function walk(e, f) { f(e); (e.children || []).forEach((c) => walk(c, f)); }
function all(e, pred) { const out = []; walk(e, (x) => { if (pred(x)) out.push(x); }); return out; }

const T0 = 1_790_000_000_000, H = 3600 * 1000;
const NEED_STUB = ['readJson', 'PENDING_KEY', 'PRIORITIES', 'NOTICED_KEY', 'NOTICED_MAX', 'settleConsent', '_parked', 'nudgeSync',
	't', 'toast', 'relTime', 'selectDiamond', 'diamonds', 'steerTile', 'tombMapNow', 'DIAMOND_TOMBS_KEY', 'trashed'];

function page() {
	const win = makeWindow({ now: T0 });
	loadScript(win, 'alerts.js');
	const list = el('div'), count = el('span');
	win.document = { getElementById: (id) => (id === 'pending-list' ? list : id === 'pending-count' ? count : null), createElement: el };
	const st = { selected: [], toasts: [], tombs: {}, trash: {} };
	const stub = {
		readJson: (k, d) => { try { const v = win.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
		PENDING_KEY: 'daimond-pending', PRIORITIES: ['high', 'normal', 'low'], NOTICED_KEY: 'daimond-pending-noticed', NOTICED_MAX: 64,
		settleConsent: () => false, _parked: {}, nudgeSync: () => {},
		t: (k, v) => k + (v ? '|' + Object.keys(v).sort().map((x) => x + '=' + v[x]).join(',') : ''),
		toast: (m) => { st.toasts.push(m); }, relTime: () => 'now',
		selectDiamond: (f, view) => { st.selected.push([f.id, view]); },
		diamonds: [{ id: 'mail', name: 'Email' }],
		steerTile: () => {},
		DIAMOND_TOMBS_KEY: 'daimond-diamond-tombs',
		tombMapNow: (k) => (k === 'daimond-diamond-tombs' ? st.tombs : {}),
		trashed: (id) => !!st.trash[id],
	};
	// Lift Pending alone: every other declaration it names is stubbed, as undefined unless given.
	const reach = liftSource(['Pending'], NEED_STUB).ordered.filter((n) => n !== 'Pending');
	const names = NEED_STUB.concat(reach);
	let src = liftSource(['Pending'], names).src;
	if (BREAK) {
		const [a, b] = SWAPS[BREAK];
		if (src.split(a).length !== 2) { console.error('break ' + BREAK + ' text matched not once'); process.exit(2); }
		src = src.replace(a, b);
	}
	const body = 'with (window) { return (function (' + names.join(', ') + ') {\n' + src + '\nreturn Pending;\n}).apply(null, stubs); }';
	const P = new Function('window', 'stubs', body)(win, names.map((k) => stub[k]));
	return { win, P, list, count, st };
}
function raise(w, key, headline, needs) { return JSON.parse(w.DaimondPendingTool.raise('mail', JSON.stringify({ key, headline, detail: 'do x', needs }))); }

console.log('Pending, kind alert' + (BREAK ? '  [--break ' + BREAK + ']' : ''));

kase('both alerts are on the panel; only the one that needs the person counts on the chip', () => {
	const { win, P, list, count } = page();
	raise(win, 'imap-login', 'Mail login failing', true);
	win._setNow(T0 + 1);
	raise(win, 'digest', 'Three newsletters filed', false);
	P.fresh(); P.render();
	const cards = list.children.filter((c) => /pend-card/.test(c.className));
	eq(cards.length, 2, 'two tiles');
	eq(count.textContent, '1', 'the chip');
	ok(cards.some((c) => /pend-needs/.test(c.className)) && cards.some((c) => /pend-quiet/.test(c.className)), 'needs and quiet are drawn apart');
	eq(cards[0].dataset.id, 'a:mail:imap-login', 'a needed alert sorts first, by priority');
});

kase('an alert tile has no priority select, no tick and no ?; it opens its Diamond', () => {
	const { win, P, list, st } = page();
	raise(win, 'k', 'h', true);
	P.fresh(); P.render();
	const card = list.children[0];
	eq(all(card, (x) => x.tagName === 'SELECT').length, 0, 'no priority select');
	eq(all(card, (x) => /pend-go/.test(x.className) || x.textContent === '?').length, 0, 'no tick, no ?');
	const open = all(card, (x) => /pend-open/.test(x.className))[0];
	ok(open, 'an open button');
	eq(open.textContent, 'pending.alert.open|name=Email', 'named for the Diamond');
	open.click();
	eq(st.selected, [['mail', 'chat']], 'opens the Diamond');
});

kase('the Pending list\'s own record never holds an alert', () => {
	const { win, P } = page();
	raise(win, 'k', 'h', true);
	P.fresh();
	P.save();
	const stored = JSON.parse(win.localStorage.getItem('daimond-pending') || '[]');
	eq(stored.filter((x) => x.kind === 'alert').length, 0, 'no alert in daimond-pending');
	P.fresh();
	eq(P.items.filter((x) => x.kind === 'alert').length, 1, 'and still exactly one on the panel');
});

kase('✕ on an alert dismisses it in the synced record; the same words raised again stay down', () => {
	const { win, P, count } = page();
	raise(win, 'k', 'h', true);
	P.fresh(); P.render();
	eq(count.textContent, '1', 'counted');
	win._setNow(T0 + 10);
	P.drop('a:mail:k');
	eq(win.DaimondAlerts.live().length, 0, 'dismissed in the record');
	eq(raise(win, 'k', 'h', true).was, 'dismissed', 'stays down');
	P.fresh(); P.render();
	eq(count.textContent, '', 'chip clear');
});

kase('a quiet alert leaves the panel after 24 h; pending_clear takes either kind off', () => {
	const { win, P, list } = page();
	raise(win, 'q', 'quiet', false);
	win._setNow(T0 + 1);
	raise(win, 'n', 'needs', true);
	win._setNow(T0 + 24 * H);
	P.fresh(); P.render();
	eq(list.children.map((c) => c.dataset.id), ['a:mail:n'], 'the quiet one lapsed');
	JSON.parse(win.DaimondPendingTool.clear('mail', JSON.stringify({ key: 'n' })));
	P.fresh(); P.render();
	eq(list.children.filter((c) => /pend-card/.test(c.className)).length, 0, 'cleared');
});

kase('a trashed Diamond\'s alerts are hidden and come back on restore; a destroyed one\'s are gone', () => {
	const { win, P, list, count, st } = page();
	raise(win, 'k', 'h', true);
	st.trash.mail = 1;
	P.fresh(); P.render();
	eq(list.children.filter((c) => /pend-card/.test(c.className)).length, 0, 'hidden while in the trash');
	eq(count.textContent, '', 'and off the chip');
	delete st.trash.mail;
	P.fresh(); P.render();
	eq(count.textContent, '1', 'restored: still up, counted again');
	st.tombs.mail = T0;
	P.fresh(); P.render();
	eq(count.textContent, '', 'destroyed (tombstoned): off the chip');
	eq(list.children.filter((c) => /pend-card/.test(c.className)).length, 0, 'and off the panel');
});

kase('add refuses kind alert: only the daimon raises one', () => {
	const { P } = page();
	eq(P.add({ kind: 'alert', headline: 'h' }), null, 'refused');
});

console.log((failures ? 'FAIL ' : 'ok ') + (cases - failures) + '/' + cases);
process.exit(failures ? 1 : 0);
