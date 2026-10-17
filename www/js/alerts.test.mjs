/* ============================================================
   Test -- DaimondAlerts: EVERY ALERT ON THE PENDING PANEL, ONE PLACE, EVERY DEVICE
   (www/js/alerts.js; D-20261016-17 ALERT-PENDING, owner ruling rulings section 16).
   ------------------------------------------------------------
   alerts.js is a plain script, loaded here as written over the real stamp.js and store.js,
   with a driven clock (dev/syncprobe.mjs makeWindow). Two windows are two devices; the
   parcel between them is DaimondAlerts.merge, the law the sync section applies.

   Each check is proven able to fail:

     node www/js/alerts.test.mjs --break badge      # a needs:false alert counts on the badge
     node www/js/alerts.test.mjs --break noexpire   # a needs:false alert never lapses
     node www/js/alerts.test.mjs --break localexp   # the lapse is not carried in the synced item
     node www/js/alerts.test.mjs --break tie        # at an equal stamp a raise beats a take-down
     node www/js/alerts.test.mjs --break adopt      # a peer's parcel replaces what is held instead of merging
     node www/js/alerts.test.mjs --break livecap    # a Diamond may hold any number of live alerts
     node www/js/alerts.test.mjs --break shedlive   # the 200 cap sheds tombstones only
     node www/js/alerts.test.mjs --break horizon    # an up item outlives the tombstone horizon (a month offline resurrects)
     node www/js/alerts.test.mjs --break floor      # a tombstone shed by count lets a stale raise back
     node www/js/alerts.test.mjs --break keepalive  # the floor takes an alert still up
     node www/js/alerts.test.mjs --break restamp    # a persisting condition's alert lapses after a month
     node www/js/alerts.test.mjs --break utf16      # bounds count UTF-16 units, so emoji the engine passed are refused
     node www/js/alerts.test.mjs --break noteover   # a page note replaces the words still up instead of adding to them
     node www/js/alerts.test.mjs --break needsopt   # a raise with no 'needs' is taken
     node www/js/alerts.test.mjs                    # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
const BREAKS = {
	badge:    ["return live().filter(function (a) { return a.needs; }).length;", "return live().length;"],
	noexpire: ["return it.state === 'up' && !(it.expires &&", "return it.state === 'up' && !(false &&"],
	localexp: ["expires: n ? 0 : ms(it.expires),", "expires: 0,"],
	tie:      ["var STATES       = { up: 0, clear: 1, dismissed: 2 };", "var STATES       = { up: 3, clear: 1, dismissed: 2 };"],
	adopt:    ["var have = read(), next = merge(have, remote);", "var have = read(), next = merge(remote, null);"],
	livecap:  ["if (!up && !pageKey(next.key) && full(next.diamond)) return 'full';", "", "if (was === 'full')", "if (false)"],
	shedlive: ["drop = drop.concat(", "if (0) drop = drop.concat("],
	horizon:  ["if (t - age(items[id]) > TOMB_MAX_MS) delete items[id];", "if (items[id].state !== 'up' && t - age(items[id]) > TOMB_MAX_MS) delete items[id];"],
	floor:    ["if (out[id].state === 'up' && age(out[id]) <= floor) delete out[id];", ""],
	keepalive:["if (items[id].state === 'up' && age(items[id]) <= floor) items[id].seen", "if (0) items[id].seen"],
	restamp:  ["if (up && same) { set(id, next); return 'same'; }", "if (up && same) return 'same';"],
	utf16:    ["function chars(s) { return Array.from(s).length; }", "function chars(s) { return s.length; }"],
	noteover: ["var held = (prev && isLive(prev)) ? prev.detail : '';", "var held = '';"],
	needsopt: ["if (typeof p.needs !== 'boolean') return", "if (false) return",
	           "if (typeof needs !== 'boolean') return null;", "needs = needs !== false;"],
};
let SRC = readFileSync(join(HERE, 'alerts.js'), 'utf8');
if (BREAK) {
	const b = BREAKS[BREAK];
	for (let i = 0; b && i < b.length; i += 2) {
		if (!SRC.includes(b[i])) { console.log('the break text moved: ' + BREAK); process.exit(2); }
		SRC = SRC.replace(b[i], b[i + 1]);
	}
	if (!b) { console.log('no such break: ' + BREAK); process.exit(2); }
}
const LOAD = new Function('window', 'with (window) {\n' + SRC + '\n}\n//# sourceURL=alerts.js');

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
function kase(name, fn) {
	cases++; bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const T0 = 1_790_000_000_000, H = 3600 * 1000;
function device(t) { const w = makeWindow({ now: t || T0 }); LOAD(w); return w; }
function rec(w) { return w.DaimondStore ? w.DaimondStore.get(w.DaimondAlerts.KEY, null) : JSON.parse(w.localStorage.getItem(w.DaimondAlerts.KEY)); }
/// The parcel from `from` lands on `to`, by the path collectSync / applySync take, through JSON.
function carry(from, to) { return to.DaimondAlerts.adoptSync(JSON.parse(JSON.stringify(from.DaimondAlerts.syncSnapshot()))); }
function tool(w, verb, diamond, p) { return JSON.parse(w.DaimondPendingTool[verb](diamond, JSON.stringify(p))); }

console.log('alerts.js' + (BREAK ? '  [--break ' + BREAK + ']' : ''));

kase('the badge counts needs:true alerts only; a quiet one is shown but not counted', () => {
	const w = device();
	eq(tool(w, 'raise', 'mail', { key: 'imap-login', headline: 'Mail login failing', detail: 'Re-enter it.', needs: true }).was, 'new', 'first raise');
	w._setNow(T0 + 1);
	eq(tool(w, 'raise', 'mail', { key: 'digest', headline: 'Three newsletters filed', detail: '', needs: false }).was, 'new', 'quiet raise');
	eq(w.DaimondAlerts.live().length, 2, 'both on the panel');
	eq(w.DaimondAlerts.count(), 1, 'the badge');
	eq(w.DaimondAlerts.live().map((a) => a.needs), [true, false], 'needs carried to the tile');
});

kase('a raise with no needs is refused, and nothing is written', () => {
	const w = device();
	const r = tool(w, 'raise', 'mail', { key: 'k', headline: 'h' });
	eq(r.ok, false, 'refused');
	eq(w.DaimondAlerts.live().length, 0, 'nothing up');
});

kase('the same key raised again updates in place; two devices on one key hold one item', () => {
	const a = device(), b = device(T0 + 5);
	tool(a, 'raise', 'mail', { key: 'k', headline: 'one', needs: true });
	eq(tool(a, 'raise', 'mail', { key: 'k', headline: 'two', needs: true }).was, 'updated', 'in place');
	tool(b, 'raise', 'mail', { key: 'k', headline: 'three', needs: true });
	carry(a, b); carry(b, a);
	eq(a.DaimondAlerts.live().length, 1, 'one item on A');
	eq(a.DaimondAlerts.live().map((x) => x.headline), b.DaimondAlerts.live().map((x) => x.headline), 'A and B agree');
});

kase('a needs:false alert lapses 24 h after it is raised, by a driven clock', () => {
	const w = device();
	tool(w, 'raise', 'mail', { key: 'q', headline: 'quiet', needs: false });
	w._setNow(T0 + 1);
	tool(w, 'raise', 'mail', { key: 'n', headline: 'needs', needs: true });
	w._setNow(T0 + 24 * H - 1);
	eq(w.DaimondAlerts.live().map((x) => x.key), ['q', 'n'], 'still up a moment before');
	w._setNow(T0 + 24 * H);
	eq(w.DaimondAlerts.live().map((x) => x.key), ['n'], 'the quiet one has lapsed; the needed one stays');
	w._setNow(T0 + 400 * H);
	eq(w.DaimondAlerts.live().map((x) => x.key), ['n'], 'a needed alert never lapses');
	eq(w.DaimondAlerts.count(), 1, 'badge');
});

kase('the lapse rides in the synced item, so a device that hears late drops it at the same moment', () => {
	const a = device(), b = device(T0 + 20 * H);	// B hears of it 20 h later
	tool(a, 'raise', 'mail', { key: 'q', headline: 'quiet', needs: false });
	carry(a, b);
	eq(b.DaimondAlerts.live().length, 1, 'B shows it');
	eq(b.DaimondAlerts.live()[0].expires, T0 + 24 * H, 'the same lapse as A');
	b._setNow(T0 + 24 * H);
	eq(b.DaimondAlerts.live().length, 0, 'B drops it with A, not 24 h after it heard');
});

kase('pending_clear takes either kind down on every device', () => {
	const a = device(), b = device(T0 + 1);
	tool(a, 'raise', 'mail', { key: 'n', headline: 'needs', needs: true });
	tool(a, 'raise', 'mail', { key: 'q', headline: 'quiet', needs: false });
	carry(a, b);
	eq(b.DaimondAlerts.live().length, 2, 'B has both');
	a._setNow(T0 + 10);
	eq(tool(a, 'clear', 'mail', { key: 'n' }).cleared, true, 'needed cleared');
	eq(tool(a, 'clear', 'mail', { key: 'q' }).cleared, true, 'quiet cleared');
	eq(tool(a, 'clear', 'mail', { key: 'q' }).cleared, false, 'a second clear finds nothing');
	carry(a, b);
	eq(b.DaimondAlerts.live().length, 0, 'gone on B');
	eq(b.DaimondAlerts.count(), 0, 'badge on B');
});

kase('a dismiss on one device is not undone by the other device\'s older raise', () => {
	const a = device(), b = device(T0 + 1);
	tool(a, 'raise', 'mail', { key: 'k', headline: 'h', needs: true });
	carry(a, b);
	b._setNow(T0 + 100);
	ok(b.DaimondAlerts.dismiss(b.DaimondAlerts.live()[0].id), 'dismissed');
	carry(a, b); carry(b, a);
	eq(a.DaimondAlerts.live().length, 0, 'down on A');
	eq(tool(a, 'raise', 'mail', { key: 'k', headline: 'h', needs: true }).was, 'dismissed', 'same words stay down');
	eq(tool(a, 'raise', 'mail', { key: 'k', headline: 'worse', needs: true }).was, 'new', 'new words come back');
});

kase('one Diamond cannot clear another\'s alert', () => {
	const w = device();
	tool(w, 'raise', 'mail', { key: 'k', headline: 'h', needs: true });
	eq(tool(w, 'clear', 'cal', { key: 'k' }).cleared, false, 'other Diamond');
	eq(w.DaimondAlerts.live().length, 1, 'still up');
});

kase('at an equal stamp, a take-down outranks a raise', () => {
	const M = device().DaimondAlerts.merge;
	const up = { diamond: 'mail', key: 'k', headline: 'h', detail: '', needs: true, expires: 0, state: 'up', at: T0 };
	const down = Object.assign({}, up, { state: 'clear' });
	const m1 = M({ items: { 'mail:k': up } }, { items: { 'mail:k': down } });
	const m2 = M({ items: { 'mail:k': down } }, { items: { 'mail:k': up } });
	eq(m1.items['mail:k'].state, 'clear', 'one order');
	eq(m2.items['mail:k'].state, 'clear', 'the other order');
});

kase('sync: A raises, B shows it; B raises another, A keeps both; a parcel with nothing new changes nothing', () => {
	const a = device(), b = device(T0 + 3);
	tool(a, 'raise', 'mail', { key: 'one', headline: 'h1', needs: true });
	ok(carry(a, b), 'B took it');
	tool(b, 'raise', 'cal', { key: 'two', headline: 'h2', needs: false });
	carry(b, a);
	eq(a.DaimondAlerts.live().map((x) => x.id).sort(), ['cal:two', 'mail:one'], 'A holds both');
	tool(a, 'raise', 'mail', { key: 'three', headline: 'h3', needs: true });
	carry(a, b);
	eq(b.DaimondAlerts.live().length, 3, 'B holds all three, its own kept');
	eq(carry(a, b), false, 'the same parcel again changes nothing');
	eq(a.DaimondAlerts.adoptSync(null), false, 'a parcel with no alerts section is nothing to say');
	eq(a.DaimondAlerts.live().length, 3, 'and erased nothing');
});

kase('a Diamond holds at most 20 live alerts: a 21st new key is refused, with the reason', () => {
	const w = device();
	for (let i = 0; i < 20; i++) { w._setNow(T0 + i); eq(tool(w, 'raise', 'mail', { key: 'k' + i, headline: 'h' + i, needs: true }).was, 'new', 'raise ' + i); }
	w._setNow(T0 + 100);
	const r = tool(w, 'raise', 'mail', { key: 'k20', headline: 'one more', needs: true });
	eq(r.ok, false, 'the 21st new key is refused');
	eq(r.full, true, 'and says why, for the engine');
	ok(/20/.test(r.reason) && /clear/.test(r.reason), 'the reason names the bound and the way out: ' + r.reason);
	eq(w.DaimondAlerts.live().length, 20, 'nothing added');
	eq(tool(w, 'raise', 'mail', { key: 'k3', headline: 'worse', needs: true }).was, 'updated', 'a key already up may still be updated');
	eq(tool(w, 'raise', 'cal', { key: 'k20', headline: 'h', needs: true }).was, 'new', 'another Diamond has its own 20');
	eq(tool(w, 'clear', 'mail', { key: 'k0' }).cleared, true, 'clear one');
	eq(tool(w, 'raise', 'mail', { key: 'k20', headline: 'one more', needs: true }).was, 'new', 'and the new key fits');
});

kase('the parcel stays bounded: 2,000 raises on one Diamond, and on 2,000 Diamonds', () => {
	const det = 'd'.repeat(600), head = 'h'.repeat(120);
	const a = device();
	for (let i = 0; i < 2000; i++) { a._setNow(T0 + i); tool(a, 'raise', 'mail', { key: 'k' + i, headline: head, detail: det, needs: true }); }
	const one = JSON.stringify(a.DaimondAlerts.syncSnapshot());
	eq(a.DaimondAlerts.live().length, 20, 'one Diamond: 20 live');
	ok(one.length < 40000, 'one Diamond: parcel ' + one.length + ' bytes');
	const b = device();
	for (let i = 0; i < 2000; i++) { b._setNow(T0 + i); tool(b, 'raise', 'd' + i, { key: 'k', headline: head, detail: det, needs: true }); }
	const many = b.DaimondAlerts.syncSnapshot();
	ok(Object.keys(many.items).length <= 200, 'many Diamonds: ' + Object.keys(many.items).length + ' items held');
	ok(JSON.stringify(many).length < 200000, 'many Diamonds: parcel ' + JSON.stringify(many).length + ' bytes');
	eq(b.DaimondAlerts.live().map((x) => x.diamond).slice(-1), ['d1999'], 'the newest kept, the oldest shed');
});

kase('a peer parcel of 500 live alerts is shed to the 200 cap on landing', () => {
	const items = {};
	for (let i = 0; i < 500; i++) items['d' + i + ':k'] = { diamond: 'd' + i, key: 'k', headline: 'h', detail: '', needs: true, expires: 0, state: 'up', at: T0 + i };
	const w = device(T0 + 1000);
	w.DaimondAlerts.adoptSync({ items });
	eq(Object.keys(rec(w).items).length, 200, 'held');
	eq(w.DaimondAlerts.live().length, 200, 'live');
});

const DAY = 24 * H;
kase('no resurrection after the month: a device offline 32 days does not bring back a dismissed alert', () => {
	const a = device(), b = device();
	tool(a, 'raise', 'mail', { key: 'k', headline: 'Login failing', needs: true });
	carry(a, b);
	a._setNow(T0 + H); a.DaimondAlerts.dismiss('mail:k');
	a._setNow(T0 + 32 * DAY); b._setNow(T0 + 32 * DAY);
	carry(a, b); carry(b, a);
	eq([a.DaimondAlerts.live().length, b.DaimondAlerts.live().length], [0, 0], 'live on A and B');
});

kase('no resurrection through the cap: 200 raise-and-clear cycles, then the stale device syncs', () => {
	const a = device(), b = device();
	tool(a, 'raise', 'mail', { key: 'k', headline: 'Login failing', needs: true });
	carry(a, b);
	a._setNow(T0 + 10); a.DaimondAlerts.dismiss('mail:k');
	for (let i = 0; i < 200; i++) {
		a._setNow(T0 + 100 + i * 2); tool(a, 'raise', 'mail', { key: 'x' + i, headline: 'h' + i, needs: true });
		a._setNow(T0 + 101 + i * 2); tool(a, 'clear', 'mail', { key: 'x' + i });
	}
	carry(a, b); carry(b, a);
	eq(a.DaimondAlerts.live().map((x) => x.key), [], 'live on A');
	eq(b.DaimondAlerts.live().map((x) => x.key), [], 'live on B');
});

kase('the cap does not take an alert still up: raised before the 200 cycles, it stays on both devices', () => {
	const a = device(), b = device();
	tool(a, 'raise', 'mail', { key: 'up', headline: 'Still failing', needs: true });
	carry(a, b);
	for (let i = 0; i < 200; i++) {
		a._setNow(T0 + 100 + i * 2); tool(a, 'raise', 'mail', { key: 'x' + i, headline: 'h' + i, needs: true });
		a._setNow(T0 + 101 + i * 2); tool(a, 'clear', 'mail', { key: 'x' + i });
	}
	carry(a, b); carry(b, a); carry(a, b);
	eq(a.DaimondAlerts.live().map((x) => x.key), ['up'], 'live on A');
	eq(b.DaimondAlerts.live().map((x) => x.key), ['up'], 'live on B');
	// And a clear on the stale device still wins over the copy the cap kept.
	b._setNow(T0 + 1000); eq(tool(b, 'clear', 'mail', { key: 'up' }).cleared, true, 'B clears it');
	carry(b, a); carry(a, b);
	eq([a.DaimondAlerts.live().length, b.DaimondAlerts.live().length], [0, 0], 'down on both');
});

kase('a condition that persists keeps its alert: raised again in the same words after a week, it is re-stamped', () => {
	const w = device();
	tool(w, 'raise', 'mail', { key: 'k', headline: 'Login failing', needs: true });
	for (let d = 8; d <= 40; d += 8) { w._setNow(T0 + d * DAY); eq(tool(w, 'raise', 'mail', { key: 'k', headline: 'Login failing', needs: true }).was, 'updated', 'day ' + d); }
	w._setNow(T0 + 45 * DAY);
	eq(w.DaimondAlerts.live().map((x) => x.key), ['k'], 'still up on day 45');
	w._setNow(T0 + 71 * DAY);
	eq(w.DaimondAlerts.live().length, 0, 'raised by nobody for a month, it has lapsed');
});

kase('bounds count characters as the engine does: 120 emoji fit a headline, 121 do not', () => {
	const w = device(), e = '\u{1F525}';
	eq(tool(w, 'raise', 'mail', { key: 'e', headline: e.repeat(120), detail: e.repeat(600), needs: true }).was, 'new', '120 + 600 emoji');
	eq(tool(w, 'raise', 'mail', { key: 'f', headline: e.repeat(121), needs: true }).ok, false, '121 in the headline');
	eq(tool(w, 'raise', 'mail', { key: 'g', headline: 'h', detail: e.repeat(601), needs: true }).ok, false, '601 in the detail');
	const b = device(); carry(w, b);
	eq(b.DaimondAlerts.live().map((x) => x.key), ['e'], 'and the emoji alert survives the parcel');
});

kase('a page note adds to the words still up, drops the oldest past 600, and starts afresh once down', () => {
	const w = device(), A = () => w.DaimondAlerts;
	eq(A().note('mail', 'mail-note', 'From Email', 'first'), 'new', 'first note');
	w._setNow(T0 + 1);
	eq(A().note('mail', 'mail-note', 'From Email', 'second'), 'updated', 'second note');
	eq(A().live()[0].detail, 'first\n\nsecond', 'appended in order');
	w._setNow(T0 + 2);
	A().note('mail', 'mail-note', 'From Email', 'z'.repeat(700));
	const d = Array.from(A().live()[0].detail);
	eq([d.length, d[0], d[d.length - 1]], [600, '\u2026', 'z'], 'capped, oldest dropped, marked');
	eq(A().note('mail', 'digest', 'h', 'x'), null, 'a model key is not the page\'s to append to');
	w._setNow(T0 + 25 * H);
	A().note('mail', 'mail-note', 'From Email', 'fresh');
	eq(A().live()[0].detail, 'fresh', 'a lapsed note is not carried into the next');
});

console.log((failures ? 'FAIL ' : 'ok ') + (cases - failures) + '/' + cases);
process.exit(failures ? 1 : 0);
