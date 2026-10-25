/* ============================================================
   Test -- a runner turn's History row, and its Undo (RUN-HIST, 23 Oct 2026).

   A turn handed to argonaut wrote its files on argonaut, and the asker's History had no
   row for it. The report now carries the turn's rows (`turnRec`); the page records them as
   a version with `away`, and that row offers "Undo this turn", which asks argonaut over the
   post box and says, at every step, where the undo stands -- never a button that does nothing.

   N-a: a settling report with `turnRec` reaches the engine's `versions_record_carried` once,
        even when the report arrives twice.
   N-b: the row draws "Undo this turn"; a press posts `undo-turn {to: on, run}`; offline, the
        row says it is waiting, and still does after a reload; past `until` it says the copies
        are gone; an `undone` answer draws the result line, and the undo's own entry offers
        "Undo this restore" over the same route.

   The page code is lifted from daimond.js by a brace-balanced scan, versions.js and peer.js
   run as written, and the engine is a stub that counts.

   Run:  node www/js/runhist.test.mjs
   ============================================================ */
import { makeWindow, loadScript, storage } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const src = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
const en = readFileSync(new URL('../i18n/en.js', import.meta.url), 'utf8');

/// A function declared at the IIFE's top level, by a brace-balanced scan; '' when absent.
function fn(name) {
	let at = src.indexOf('\n\tasync function ' + name + '(');
	if (at < 0) at = src.indexOf('\n\tfunction ' + name + '(');
	if (at < 0) return '';
	return src.slice(at + 1, balanced(src.indexOf('{', at)));
}
function balanced(brace) {
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
	}
	return i;
}
/// The callback daimond.js hands `DaimondPeer.onReport`.
function reportHandler() {
	const at = src.indexOf('DaimondPeer.onReport(function (report) {');
	if (at < 0) return '';
	const open = src.indexOf('function', at);
	return '(' + src.slice(open, balanced(src.indexOf('{', open))) + ')';
}

// A just-enough element tree.
function makeEl(tag) {
	const el = {
		tagName: tag, className: '', textContent: '', title: '', children: [], parent: null, listeners: {}, dataset: {},
		isConnected: true,
		classList: { s: new Set(), add(c) { this.s.add(c); }, remove(c) { this.s.delete(c); }, toggle(c) { this.s.has(c) ? this.s.delete(c) : this.s.add(c); } },
		appendChild(c) { c.parent = el; el.children.push(c); return c; },
		replaceChildren(...n) { el.children = []; n.forEach((c) => el.appendChild(c)); },
		addEventListener(t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); },
		setAttribute() {},
		async press() { for (const f of (el.listeners.click || [])) await f({ stopPropagation() {} }); },
	};
	return el;
}
const walk = (el, out = []) => { out.push(el); el.children.forEach((c) => walk(c, out)); return out; };
const texts = (el) => walk(el).map((e) => e.textContent).filter(Boolean);
const buttons = (el) => walk(el).filter((e) => e.tagName === 'button');
const button = (el, text) => buttons(el).find((b) => b.textContent === text);

// English, read from the real table, so the row is judged in the words it ships with.
const EN = {};
for (const m of en.matchAll(/^\t'([\w.]+)':\s*'((?:[^'\\]|\\.)*)',?/gm)) EN[m[1]] = m[2].replace(/\\'/g, "'");
const t = (k, v) => String(EN[k] == null ? k : EN[k]).replace(/\{(\w+)\}/g, (w, n) => (v && v[n] != null ? String(v[n]) : w));

const NOW = 1761300000000;
const away = { on: 'ARGO', onName: 'argonaut', run: 'e-42', since: 1761200000000, until: 1761804800000, more: 0 };

/// One page: versions.js and peer.js as written, the engine stub, presence as told, and the
/// lifted History code. `ls` is the device's storage, so a second page over it is a reload.
function page(ls, o) {
	const calls = { carried: [], undone: [], posts: [], flush: 0 };
	const eng = {
		versions_list() { return '[]'; },
		versions_record_carried(id, json) { calls.carried.push([id, JSON.parse(json)]); return 'ok'; },
		versions_record_undone(id, json) { calls.undone.push([id, JSON.parse(json)]); return 'ok'; },
	};
	const win = makeWindow({ ls, now: o.now || NOW, extra: {
		DaimondCore: { diamondApp: () => eng },
		DaimondSync: { flush: async () => { calls.flush++; } },
		DaimondPost: { post: async (body) => { calls.posts.push(body.env); return { ok: o.postOk !== false }; } },
	} });
	const presence = {
		awake: () => (o.online ? [{ deviceId: 'ARGO', name: 'argonaut', lastSeen: NOW }] : []),
		unknown: () => false,
		snapshot: () => (o.paired === false ? { PHONE: {} } : { ARGO: { kind: 'runner' }, PHONE: {} }),
	};
	win.document = { createElement: makeEl };
	loadScript(win, 'versions.js');
	try { loadScript(win, 'peer.js'); } catch (e) { /* the parts this needs are defined before any boot step */ }
	if (win.DaimondPeer) win.DaimondPeer.sealForSelf = async (env) => ({ env });
	win.DaimondPresence = presence;		// after peer.js, which publishes its own
	const names = ['recordCarriedTurn', 'histOpenFor', 'undoneFromRunner', 'undoTurnDeps', 'undoTurnProbe',
		'histAwayUndo', 'histAwayNet', 'fmtBytes', 'histRow', 'isRestoreRow', 'shownPath'];
	const body = names.map(fn).join('\n');
	const make = new Function('window', 'document', 't', 'tn', 'stubs',
		'with (window) { with (stubs) {\n'
		+ 'var _histUndoRows = new Map(); var _histList = null;\n'
		+ body + '\nreturn { ' + names.filter((n) => fn(n)).map((n) => n + ': ' + n).join(', ')
		+ ', onReport: ' + (reportHandler() || 'null') + ' };\n} }');
	const stubs = {
		currentDiamond: { id: 'd1' }, diamonds: [], selfDeviceId: () => 'PHONE', deviceNameFor: () => '',
		relTime: () => 'just now', showCrystalHistory: () => { calls.redrawn = (calls.redrawn | 0) + 1; },
		peerReports: {}, requeueUnheard() {}, takeReportTaint() {}, settleRunnerSession() {}, renderDispatchedBadges() {}, updateExpedite() {},
		adoptFinalFrame: () => false, _openAsk: {}, histFile: () => makeEl('div'),
		diamondTurning: () => false, refreshDiamondAfterChange: async () => {},
	};
	const L = make(win, win.document, t, (k, n, v) => t(k + (n === 1 ? '.one' : '.other'), v), stubs);
	return { win, L, calls };
}

console.log('RUN-HIST N-a -- a settling report records the turn\'s rows once');
{
	const { win, L, calls } = page(storage(), { online: true });
	const rec = { v: 1, keeper: 'd1', turnId: 'T42', run: 'e-42', on: 'ARGO', onName: 'argonaut',
		since: away.since, until: away.until, ts: NOW, more: 0,
		files: [{ path: '/home/j/out.mp3', hash: 'h1', created: true, by: { agent: 'a', via: 'command' } }] };
	const rep = { t: 'report', v: 1, turnId: 'T42', chatId: 'c', status: 'done', turnRec: rec };
	check('N-a: daimond.js hands the report to a handler', typeof L.onReport === 'function');
	if (L.onReport) { L.onReport(rep); L.onReport(JSON.parse(JSON.stringify(rep))); }
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
	check('N-a: versions_record_carried is called once for a doubled report', calls.carried.length === 1,
		String(calls.carried.length));
	check('N-a: under the keeper, with the rows as sent',
		calls.carried[0] && calls.carried[0][0] === 'd1' && calls.carried[0][1].files[0].created === true);
	check('N-a: and the new version is sent on', calls.flush >= 1);
	if (L.onReport) L.onReport({ t: 'report', v: 1, turnId: 'T43', chatId: 'c', status: 'undeliverable',
		turnRec: Object.assign({}, rec, { run: 'e-43' }) });
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
	check('N-a: a hand-back records nothing', calls.carried.length === 1);
	check('N-a: the row carries away (versions.js rows)', /row\.away = /.test(readFileSync(new URL('./versions.js', import.meta.url), 'utf8')));
	void win;
}

console.log('\nRUN-HIST N-b -- the row offers the Undo and says where it stands');
const row = (a, cause) => ({ v: 7, ts: NOW, kind: 'files', cause: cause || 'turn', note: '', files: [{ path: '/home/j/out.mp3' }],
	truncated: 0, delta_ref: '', crystal: false, away: a });
{
	const ls = storage();
	const { L, calls } = page(ls, { online: false });
	check('N-b: histRow is there', typeof L.histRow === 'function');
	const el = L.histRow ? L.histRow('d1', row(away), true, null) : makeEl('div');
	const undo = button(el, 'Undo this turn');
	check('N-b: a row with away shows "Undo this turn"', !!undo, texts(el).join(' | '));
	check('N-b: and no local "Undo this restore"', !button(el, 'Undo this restore'));
	if (undo) await undo.press();
	const sent = calls.posts[0] || {};
	check('N-b: the press posts undo-turn to the runner, for the run', sent.t === 'undo-turn' && sent.to === 'ARGO'
		&& sent.run === 'e-42' && !!sent.uid && sent.by === 'PHONE', JSON.stringify(sent));
	const wait = t('versions.undo_offline', { runner: 'argonaut' });
	check('N-b: offline, the row reads the waiting sentence', texts(el).includes(wait), texts(el).join(' | '));
	const awayBox = walk(el).find((e) => e.className === 'hist-away');
	check('N-b: and offers no Cancel, nor any button, while it waits (a request on the relay cannot be taken back)',
		!!awayBox && buttons(awayBox).length === 0, awayBox ? texts(awayBox).join(' | ') : 'no box');
	// A reload: a new page over the same storage.
	const again = page(ls, { online: false });
	const el2 = again.L.histRow ? again.L.histRow('d1', row(away), true, null) : makeEl('div');
	check('N-b: after a reload it still waits, and posts nothing more', texts(el2).includes(wait) && again.calls.posts.length === 0,
		texts(el2).join(' | '));
	// Online, the same mark reads as asked.
	const on = page(ls, { online: true });
	const el3 = on.L.histRow ? on.L.histRow('d1', row(away), true, null) : makeEl('div');
	check('N-b: online, it reads asked', texts(el3).includes(t('versions.undo_asked', { runner: 'argonaut' })), texts(el3).join(' | '));

	// The runner answers: the row redraws with what it did; the undo's own entry is recorded.
	const done = { t: 'undone', v: 1, uid: sent.uid, to: 'PHONE', keeper: 'd1', run: 'e-42', status: 'done',
		restored: ['/home/j/a.txt', '/home/j/b.txt'], removed: ['/home/j/out.mp3'],
		skipped: [{ path: '/home/j/c.txt', why: 'changed since' }],
		undo: { on: 'ARGO', run: 'u-' + sent.uid, since: NOW + 5, until: NOW + 604800000 } };
	if (on.L.undoneFromRunner) await on.L.undoneFromRunner(done);
	const line = t('versions.undo_done', { runner: 'argonaut', n: 2, m: 1 });
	check('N-b: undone -> "N put back, M removed" (created files count as removed)', texts(el3).includes(line), texts(el3).join(' | '));
	check('N-b: and the skipped file is named', texts(el3).some((x) => x.includes('/home/j/c.txt')));
	check('N-b: no button is left on a done row', buttons(el3).length === 0 || !button(el3, 'Undo this turn'));
	check('N-b: the undo\'s own entry is recorded under the keeper', on.calls.undone.length === 1
		&& on.calls.undone[0][0] === 'd1' && on.calls.undone[0][1].undo.run === 'u-' + sent.uid);
	// A later `already` (the runner keeps its answer a week) leaves the done result standing.
	if (on.L.undoneFromRunner) await on.L.undoneFromRunner(Object.assign({}, done, { status: 'already' }));
	check('N-b: a later already leaves the done line', texts(el3).includes(line)
		&& !texts(el3).includes(t('versions.undo_already', { runner: 'argonaut' })), texts(el3).join(' | '));
	const own = on.L.histRow ? on.L.histRow('d1', row(done.undo, 'restore'), true, null) : makeEl('div');
	const ur = button(own, 'Undo this restore');
	check('N-b: the undo\'s own entry offers "Undo this restore"', !!ur, texts(own).join(' | '));
	if (ur) await ur.press();
	const sent2 = on.calls.posts[0] || {};
	check('N-b: over the same route', sent2.t === 'undo-turn' && sent2.to === 'ARGO' && sent2.run === 'u-' + sent.uid);
}
{
	// Past `until`: the button is replaced by the sentence.
	const { L } = page(storage(), { online: true });
	const old = Object.assign({}, away, { since: NOW - 9e8, until: NOW - 1 });
	const el = L.histRow ? L.histRow('d1', row(old), true, null) : makeEl('div');
	check('N-b: past until, the copies-gone sentence and no button',
		texts(el).includes(t('versions.undo_past', { runner: 'argonaut' })) && !button(el, 'Undo this turn'), texts(el).join(' | '));
}
{
	// Unpaired, and nothing kept.
	const { L } = page(storage(), { online: false, paired: false });
	const el = L.histRow ? L.histRow('d1', row(away), true, null) : makeEl('div');
	check('N-b: a runner no longer paired says so', texts(el).includes(t('versions.undo_unpaired', { runner: 'argonaut' })), texts(el).join(' | '));
	const none = page(storage(), { online: true }).L;
	const el2 = none.histRow ? none.histRow('d1', row(Object.assign({}, away, { since: 0 })), true, null) : makeEl('div');
	check('N-b: since 0 kept nothing, so no Undo', !button(el2, 'Undo this turn'));
}
{
	// already / busy / expired are each said; a post that did not go says so, never silence.
	for (const [st, key] of [['already', 'versions.undo_already'], ['busy', 'versions.undo_busy'], ['expired', 'versions.undo_expired']]) {
		const p = page(storage(), { online: true });
		const el = p.L.histRow ? p.L.histRow('d1', row(away), true, null) : makeEl('div');
		const b = button(el, 'Undo this turn'); if (b) await b.press();
		const u = p.calls.posts[0] || {};
		if (p.L.undoneFromRunner) await p.L.undoneFromRunner({ t: 'undone', v: 1, uid: u.uid, to: 'PHONE', run: 'e-42', status: st });
		check('N-b: ' + st + ' is said', texts(el).includes(t(key, { runner: 'argonaut' })), texts(el).join(' | '));
	}
	const p = page(storage(), { online: true, postOk: false });
	const el = p.L.histRow ? p.L.histRow('d1', row(away), true, null) : makeEl('div');
	const b = button(el, 'Undo this turn'); if (b) await b.press();
	check('N-b: a post that failed says so and offers the button again',
		texts(el).includes(t('versions.undo_not_sent', { runner: 'argonaut' })) && !!button(el, 'Undo this turn'), texts(el).join(' | '));
}
{
	// The undo's own entry is recorded from undone.keeper, on a device that asked nothing.
	const p = page(storage(), { online: true });
	const got = p.win.DaimondVersions.undoneArrived ? await p.win.DaimondVersions.undoneArrived({ t: 'undone', v: 1, uid: 'zz',
		to: 'LAPTOP', keeper: 'd9', run: 'e-77', status: 'done', restored: [], removed: [], skipped: [],
		undo: { on: 'ARGO', run: 'u-zz', since: NOW, until: NOW + 6e8 } }) : {};
	check('N-b: undone.keeper records the undo entry without a local mark', p.calls.undone.length === 1
		&& p.calls.undone[0][0] === 'd9' && got.mark === null, JSON.stringify(p.calls.undone));
}
{
	// An ask the relay let lapse (a day, the gateway's cap) goes again when the runner is seen back,
	// and not on a page load, and not before the relay's day.
	const ls = storage();
	const first = page(ls, { online: false });
	const el = first.L.histRow('d1', row(away), true, null);
	await button(el, 'Undo this turn').press();
	const uid = (first.calls.posts[0] || {}).uid;
	const soon = page(ls, { online: true, now: NOW + 3600e3 });
	await soon.win.DaimondVersions.undoTurnAgain(soon.L.undoTurnDeps(), soon.L.undoTurnProbe().online);
	check('N-b: within the relay\'s day, nothing is asked again', soon.calls.posts.length === 0);
	const away2 = page(ls, { online: false, now: NOW + 25 * 3600e3 });
	await away2.win.DaimondVersions.undoTurnAgain(away2.L.undoTurnDeps(), away2.L.undoTurnProbe().online);
	check('N-b: past it, still offline, nothing is asked', away2.calls.posts.length === 0);
	const back = page(ls, { online: true, now: NOW + 25 * 3600e3 });
	await back.win.DaimondVersions.undoTurnAgain(back.L.undoTurnDeps(), back.L.undoTurnProbe().online);
	const re = back.calls.posts[0] || {};
	check('N-b: seen back past the relay\'s day, the same ask goes again', re.t === 'undo-turn' && re.run === 'e-42' && re.uid === uid,
		JSON.stringify(re));
	check('N-b: on a presence change, not on a page load',
		/addEventListener\('daimond:presence', function \(\) \{\s*if \(!window\.DaimondVersions \|\| !DaimondVersions\.undoTurnAgain\) return;\s*DaimondVersions\.undoTurnAgain\(undoTurnDeps\(\), undoTurnProbe\(\)\.online\)/.test(src));
	check('N-b: no Cancel key left', !/'versions\.undo_cancel/.test(en));
}

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('runhist: all ok');
