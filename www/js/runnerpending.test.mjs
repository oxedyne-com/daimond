/* ============================================================
   Test -- A RUNNER UPDATE WAITING FOR HIS TAP, AS ONE PENDING TILE (KS-p4)
   (www/js/daimond.js, "A runner update waiting for his tap"; ksgpe_plan.md §4 L3-L4;
   daimond_release_key_design_20261018.md §3.4 rev 2 and §4 "Pending 'Runner update'").
   ------------------------------------------------------------
   `daimond.js` is an ES module over the compiled wasm, so `Pending` and the `runner*`
   functions are LIFTED from the file's own text (dev/syncprobe.mjs) and run as written.
   Stand-ins: the hand (its reported install id), `fetch` (the relay's answer), the clock,
   and the panel's drawing (`render`), which is not under test here. `alerts.js` is loaded as
   written: the runner item rides DaimondAlerts (ALERT-PENDING, synced to every device; lead
   ruling L3), so these checks read the synced record, not only the panel.

   Each check is proven able to fail:

     node www/js/runnerpending.test.mjs --break oldest     # the older of two requests is shown
     node www/js/runnerpending.test.mjs --break sticky     # a tile outlives its relay entry
     node www/js/runnerpending.test.mjs --break noinstall  # the relay is asked with no install id
     node www/js/runnerpending.test.mjs --break hidden     # a hidden page still polls
     node www/js/runnerpending.test.mjs --break alarmlow   # an alarm is raised as a quiet alert
     node www/js/runnerpending.test.mjs --break local      # the tile is kept on this device's list only
     node www/js/runnerpending.test.mjs --break kind       # save and read drop synced items by kind, not by id
     node www/js/runnerpending.test.mjs --break done       # the runner's done mark takes nothing down (RA-DONE)
     node www/js/runnerpending.test.mjs --break held       # his tap here holds nothing down until the done mark
     node www/js/runnerpending.test.mjs --break comeback   # a re-post after a refusal does not end the hold
     node www/js/runnerpending.test.mjs --break fast       # a waiting tap is polled at the minute cadence only
     node www/js/runnerpending.test.mjs --break phone      # a device with no runner of its own never polls its tap
     node www/js/runnerpending.test.mjs --break count      # the tap takes its answer count from an older poll (QA-B LOW-3')
     node www/js/runnerpending.test.mjs --break ownjudge   # a kept state judges a tap on this machine's own install (QA-B MED-4)
     node www/js/runnerpending.test.mjs                    # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWindow, liftSource } from '../../dev/syncprobe.mjs';

const ALERTS_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'alerts.js'), 'utf8');
const LOAD_ALERTS = new Function('window', 'with (window) {\n' + ALERTS_SRC + '\n}\n//# sourceURL=alerts.js');

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['oldest', 'sticky', 'noinstall', 'hidden', 'alarmlow', 'local', 'kind', 'done', 'held', 'comeback', 'phone', 'fast', 'count', 'ownjudge', 'quickpost'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

/// Each break patches the lifted source and must match exactly once, or the run exits 2.
function patch(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	if (BREAK === 'oldest')    swap('if (!best || seq > best.seq || (seq === best.seq && i > best.i))', 'if (!best || seq < best.seq)');
	if (BREAK === 'sticky')    swap('if (a.diamond === A.RUNNER && a.key.indexOf(RUNNER_KEY) === 0 && a.key !== want) A.clear(A.RUNNER, a.key);', '');
	if (BREAK === 'noinstall') swap('if (inst) {\n\t\t\tvar full = await runnerRead(inst);', '{\n\t\t\tvar full = await runnerRead(inst);');
	if (BREAK === 'hidden')    swap('if (document.hidden) return false;', '');
	if (BREAK === 'alarmlow')  swap("A.raise(A.RUNNER, RUNNER_ALARM + e.nonce, 'runner alarm', String(e.alarm || '').slice(0, 200), true);", "A.raise(A.RUNNER, RUNNER_ALARM + e.nonce, 'runner alarm', String(e.alarm || '').slice(0, 200), false);");
	if (BREAK === 'local')     swap("if (want && !held) A.raise(A.RUNNER, want, 'runner update', (r.commit || '?') + ' ' + runnerInstall(), true);", "if (want && !held) Pending.items.push({ id: 'p' + want, kind: 'runner', headline: 'x', priority: 'high', runner: { nonce: newest.nonce } });");
	if (BREAK === 'kind') {
		swap('var mine = this.items.filter(function (it) { return !Pending.fromAlerts(it); });', "var mine = this.items.filter(function (it) { return it.kind !== 'alert'; });");
		swap('this.items = this.items.filter(function (it) { return !Pending.fromAlerts(it); });', "this.items = this.items.filter(function (it) { return it.kind !== 'alert' && it.kind !== 'runner'; });");
	}
	if (BREAK === 'done')      swap("if (e.kind !== 'release' || e.done === true || (e.answered && !Array.isArray(e.answers))) return;", "if (e.kind !== 'release' || (e.answered && !Array.isArray(e.answers))) return;");
	if (BREAK === 'held')      swap('if (runnerHeld(e, taps, now)) _runnerHeld[e.nonce] = true;', '');
	if (BREAK === 'fast')      swap('var RUNNER_TAP_POLL_MS   = 3000;', 'var RUNNER_TAP_POLL_MS   = 60 * 1000;');
	if (BREAK === 'phone')     swap('if (await runnerTapPoll(inst)) read = true;', '');
	if (BREAK === 'count')     swap('v[nonce] = { at: Date.now(), n: null, inst: inst };', 'v[nonce] = { at: Date.now(), n: _runnerSeen[nonce] || 0, inst: inst };');
	if (BREAK === 'ownjudge') {
		swap('if (!tp || (own && tp.inst === own)) return false;', 'if (!tp) return false;');
		swap('if (tp && own && tp.inst === own && tp.state !== undefined) { delete tp.state; pruned = true; }', '');
	}
	if (BREAK === 'quickpost') swap('return posted <= tp.pt + RUNNER_POST_JITTER_MS;', 'return posted <= tp.at + RUNNER_TAP_SLACK_MS;');
	if (BREAK === 'comeback')  swap('return posted <= tp.pt + RUNNER_POST_JITTER_MS;', 'return true;');
	return src;
}

const NAMES = ['Pending', 'runnerPoll', 'runnerSettle', 'runnerTapped'];
// Pending reaches most of the file (its tile, execute and discuss), so EVERYTHING it reaches but these
// names and the runner's own is stubbed: what the exercised paths touch gets a stand-in below, and the rest is left undefined.
const OWN = /^(runner|RUNNER_|_runner)/;			// the unit under test, lifted as written
const STUBS = liftSource(NAMES, []).ordered.filter((n) => !NAMES.includes(n) && !OWN.test(n));

const INSTALL = 'IiIiIiIiIiIiIiIiIiIiIg';
const N1 = 'AAAAAAAAAAAAAAAAAAAAAA', N2 = 'BBBBBBBBBBBBBBBBBBBBBB', N3 = 'CCCCCCCCCCCCCCCCCCCCCC';
function entry(nonce, seq, commit, more) {
	return Object.assign({ nonce: nonce, kind: 'release', install: INSTALL,
		body: JSON.stringify({ seq: seq, sha256: '11'.repeat(32), size: 1, commit: commit, engine_id: 'kimberlite', target: 'x86_64-unknown-linux-gnu' }),
		answered: false, alarmed: false, expires_in: 600 }, more || {});
}

function page(o) {
	o = o || {};
	const win = makeWindow();
	const st = { fetches: [], reply: { ok: true, entries: [] }, install: o.install === undefined ? INSTALL : o.install };
	win.fetch = async (url) => { st.fetches.push(String(url)); const r = st.reply; return { ok: true, status: 200, json: async () => r }; };
	win.DaimondHand = { runnerInstall: () => st.install };
	win.document.hidden = !!o.hidden;
	LOAD_ALERTS(win);
	const stub = {
		t: (k, v) => k + (v ? '|' + Object.keys(v).sort().map((x) => x + '=' + v[x]).join(',') : ''),
		readJson: (k, d) => { try { const v = win.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
		PENDING_KEY: 'daimond-pending', PRIORITIES: ['high', 'normal', 'low'], NOTICED_KEY: 'daimond-pending-noticed', NOTICED_MAX: 64,
		settleConsent: () => false, _parked: {}, relTime: () => 'now', nudgeSync: () => {}, steerTile: () => {}, steerRaise: () => {},
		toast: () => {}, diamonds: [], currentDiamond: null, selectDiamond: async () => {}, turnHold: () => null, confirmHold: async () => {},
		doSteer: async () => {}, steerPress: async () => {}, steerEdit: async () => {}, promptDialog: async () => null,
		sendMessage: async () => {}, newChat: async () => {}, DaimondPanels: { isOpen: () => true, show: () => {} },
		tombMapNow: () => ({}), DIAMOND_TOMBS_KEY: 'daimond-diamond-tombs', trashed: () => false,
	};
	let src = liftSource(NAMES, STUBS).src;
	src = patch(src);
	for (const n of STUBS) if (!(n in stub)) stub[n] = undefined;
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ') {\n' + src + '\nreturn { ' + NAMES.join(', ') + ' };\n}).apply(null, stubs); }';
	const fns = new Function('window', 'stubs', body)(win, sk.map((k) => stub[k]));
	fns.Pending.render = () => {};
	return { win, st, fns, P: fns.Pending, items: () => { fns.Pending.fresh(); return fns.Pending.items.slice(); } };
}
const runners = (pg) => pg.items().filter((x) => x.kind === 'runner');
/// The runner's items as the SYNCED record holds them (what reaches his phone).
const synced = (pg) => pg.win.DaimondAlerts.live().filter((a) => a.diamond === pg.win.DaimondAlerts.RUNNER);

console.log('runner update tile (KS-p4)');

await kase('two open requests make ONE tile, showing the newer', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N2, 1760745700, 'bbbbbbb2'), entry(N1, 1760745600, 'aaaaaaa1')] };
	eq(await pg.fns.runnerPoll(), true, 'the relay was read');
	const r = runners(pg);
	eq(r.length, 1, 'one runner tile');
	ok(r[0] && r[0].runner && r[0].runner.nonce === N2, 'the newer request (by seq) is the tile: ' + JSON.stringify(r[0] && r[0].runner));
	ok(r[0] && r[0].runner && r[0].runner.commit === 'bbbbbbb2', 'its commit is shown');
	eq(r[0] && r[0].headline, 'pending.runner.headline', 'headline');
	ok(r[0] && r[0].id.indexOf('a:') === 0, 'the tile is the synced alert, not a local list item: ' + JSON.stringify(r[0] && r[0].id));
	const s = synced(pg);
	eq(s.length, 1, 'one synced runner item');
	ok(s[0] && s[0].needs === true, 'it needs him: counted on the badge, never quiet');
	ok(s[0] && s[0].key.indexOf('runner.' + N2) === 0, 'the synced item names the newer request: ' + JSON.stringify(s[0] && s[0].key));
	// A newer request still supersedes the one on the panel.
	pg.st.reply = { ok: true, entries: [entry(N2, 1760745700, 'bbbbbbb2'), entry(N3, 1760745800, 'ccccccc3')] };
	await pg.fns.runnerPoll();
	const r2 = runners(pg);
	eq(r2.length, 1, 'still one tile');
	ok(r2[0] && r2[0].runner.nonce === N3, 'the newest supersedes');
	eq(synced(pg).length, 1, 'one synced item after the swap');
	ok(r2[0] && r2[0].runner.seq === 1760745800 && r2[0].runner.commit === 'ccccccc3', 'seq and commit ride the synced item');
});

await kase('the tile clears when the entry disappears, or is answered', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1')] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'raised');
	pg.st.reply = { ok: true, entries: [] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 0, 'gone with its entry');
	eq(synced(pg).length, 0, 'cleared on every device');
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1')] };
	await pg.fns.runnerPoll();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 0, 'gone once answered');
	// A relay that cannot be read takes nothing down.
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1')] };
	await pg.fns.runnerPoll();
	pg.win.fetch = async () => { throw new Error('offline'); };
	eq(await pg.fns.runnerPoll(), false, 'unread');
	eq(runners(pg).length, 1, 'kept while the relay cannot be read');
});

await kase('no poll without an install id, and none while hidden', async () => {
	const pg = page({ install: '' });
	eq(await pg.fns.runnerPoll(), false, 'not read');
	eq(pg.st.fetches.length, 0, 'no request without an install id');
	const pg2 = page({ hidden: true });
	eq(await pg2.fns.runnerPoll(), false, 'not read while hidden');
	eq(pg2.st.fetches.length, 0, 'no request while hidden');
	const pg3 = page();
	await pg3.fns.runnerPoll();
	eq(pg3.st.fetches, ['/api/runner/relay?install=' + INSTALL], 'the one request names the install');
});

await kase('an alarm entry raises a high-priority notice, once, and no tile', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { alarmed: true, alarm: 'unrequested manifest' })] };
	await pg.fns.runnerPoll();
	const all = pg.items();
	const n = all.filter((x) => x.kind === 'notice');
	eq(n.length, 1, 'one notice');
	eq(n[0] && n[0].priority, 'high', 'high priority');
	const s = synced(pg);
	eq(s.length, 1, 'the alarm is a synced item');
	ok(s[0] && s[0].needs === true, 'the alarm needs him');
	eq(runners(pg).length, 0, 'an alarmed entry is no approve tile');
	await pg.fns.runnerPoll();
	eq(pg.items().filter((x) => x.kind === 'notice').length, 1, 'told once');
	// Dismissed, the same alarm is not raised again.
	pg.P.drop(n[0].id);
	await pg.fns.runnerPoll();
	eq(pg.items().filter((x) => x.kind === 'notice').length, 0, 'a dismissed alarm stays down');
});

await kase('nothing else raises anything (importance filter)', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { kind: 'enrol' })] };
	await pg.fns.runnerPoll();
	eq(pg.items().length, 0, 'an enrol request is not his to approve here');
});

await kase("Pending.add refuses kind 'runner': runnerSettle is its one writer", async () => {
	const pg = page();
	eq(pg.P.add({ kind: 'runner', headline: 'Kimberlite update waiting', runner: { nonce: N1, commit: 'aaaaaaa1', seq: 1760745600 } }), null, 'refused');
	eq(runners(pg).length, 0, 'no tile');
});

await kase('a model may neither raise nor clear the runner keys', async () => {
	const pg = page();
	const T = pg.win.DaimondPendingTool;
	ok(JSON.parse(T.raise('d1', JSON.stringify({ key: 'runner.' + N1, headline: 'x', detail: '', needs: true }))).ok === false, 'raise refused');
	ok(JSON.parse(T.clear('d1', JSON.stringify({ key: 'runner-alarm.' + N1 }))).ok === false, 'clear refused');
});

await kase('a save while the alarm is up keeps no stale alarm tile once it clears (rafreeze)', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { alarmed: true, alarm: 'unrequested manifest' })] };
	await pg.fns.runnerPoll();
	eq(pg.items().filter((x) => x.kind === 'notice').length, 1, 'the alarm is up');
	pg.P.save();						// anything saving Pending while the alarm is up
	const stored = JSON.parse(pg.win.localStorage.getItem('daimond-pending') || '[]');
	eq(stored.filter((x) => String(x.id).indexOf('a:') === 0).length, 0, 'no synced item is written into the local list');
	const A = pg.win.DaimondAlerts;
	A.live().filter((a) => a.diamond === A.RUNNER).forEach((a) => A.clear(A.RUNNER, a.key));
	eq(synced(pg).length, 0, 'the alarm cleared on the synced record');
	eq(pg.items().filter((x) => x.kind === 'notice').length, 0, 'and its tile is gone here too');
});

// ── RA-DONE: the done mark, and the device he tapped on ──────────────────────────
const TAPPED = 'daimond-runner-tapped';
/// The tap on `pg` for `nonce` as if made `ago` ms before now (the hold reads post times off
/// `expires_in` against this device's clock).
async function tapAgo(pg, nonce, ago, inst) {
	await pg.fns.runnerTapped(nonce, inst);		// the tap and its own immediate read
	const v = JSON.parse(pg.win.localStorage.getItem(TAPPED) || '{}');
	ok(v[nonce] && typeof v[nonce].at === 'number', 'the tap was not kept: ' + JSON.stringify(v));
	v[nonce].at -= ago;
	pg.win.localStorage.setItem(TAPPED, JSON.stringify(v));
}

await kase('the runner\'s done mark takes the tile down on every device', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [] })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'raised');
	// Answered, not done: the answer may be one the runner refuses, so the tile stays.
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 590 })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'kept while answered and not done');
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], done: true, expires_in: 590 })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 0, 'gone on the done mark');
	eq(synced(pg).length, 0, 'cleared on the synced record, so on every device');
});

await kase('answered, not done, on the device he tapped on: no tile there, the tile elsewhere', async () => {
	const here = page(), there = page();
	const open = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 560 })] };
	here.st.reply = open; there.st.reply = open;
	await here.fns.runnerPoll(); await there.fns.runnerPoll();
	eq(runners(here).length, 1, 'raised here');
	await tapAgo(here, N1, 30 * 1000);			// tapped 30 s ago; last posted 40 s ago
	// The runner is offline: answered, no re-post, no done.
	const answered = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 530 })] };
	here.st.reply = answered; there.st.reply = answered;
	await here.fns.runnerPoll(); await there.fns.runnerPoll();
	eq(runners(here).length, 0, 'held down at once on the device he tapped on');
	eq(runners(there).length, 1, 'still up on a device he did not tap on, until the done mark');
	eq(synced(here).length, 1, 'the hold is this device\'s alone: the synced item stands');
	// An answer that was there before his tap (a junk one) holds nothing down.
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N2, 1760745700, 'bbbbbbb2', { answered: true, answers: ['junk'], expires_in: 560 })] };
	await pg.fns.runnerPoll();
	await tapAgo(pg, N2, 30 * 1000);
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'an answer from before the tap holds nothing down');
});

await kase('re-posted after a refusal: the tile comes back on the device he tapped on', async () => {
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 560 })] };
	await pg.fns.runnerPoll();
	await tapAgo(pg, N1, 30 * 1000);
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 530 })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 0, 'held after the tap');
	// The runner refused it and posted the entry again (its TTL restarted after the tap).
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 600 })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'back once the runner posted it again after the tap');
	// A new request after a refusal was never tapped, and shows.
	pg.st.reply = { ok: true, entries: [entry(N3, 1760745800, 'ccccccc3', { answers: [], expires_in: 600 })] };
	await pg.fns.runnerPoll();
	const r = runners(pg);
	ok(r.length === 1 && r[0].runner.nonce === N3, 'the new request shows: ' + JSON.stringify(r.map((x) => x.runner)));
	eq(Object.keys(JSON.parse(pg.win.localStorage.getItem(TAPPED) || '{}')), [], 'a tap on a request the relay no longer lists is pruned');
});

await kase('a device with NO install id (his phone) that taps: down at once with the runner down, again after a second tap, back on a refusal re-post', async () => {
	const phone = page({ install: '' });
	const A = phone.win.DaimondAlerts;
	// The runner's own machine raised the synced item; it reaches the phone with its install id.
	A.raise(A.RUNNER, 'runner.' + N1 + '.1760745600.aaaaaaa1', 'runner update', 'aaaaaaa1 ' + INSTALL, true);
	const r = runners(phone);
	eq(r.length, 1, 'the synced tile is up on the phone');
	eq(r[0] && r[0].runner.install, INSTALL, 'the tile carries the install id');
	eq(await phone.fns.runnerPoll(), false, 'nothing to ask before a tap');
	eq(phone.st.fetches.length, 0, 'no poll without an install id or a tap');
	// The tap's own immediate read sees the entry not yet answered, and takes its count (LOW-3').
	phone.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 560 })] };
	await tapAgo(phone, N1, 30 * 1000, INSTALL);
	ok(JSON.parse(phone.win.localStorage.getItem(TAPPED))[N1].inst === INSTALL, 'the tap keeps the install id');
	// The runner is down: answered, no re-post, no done.
	phone.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 530 })] };
	eq(await phone.fns.runnerPoll(), true, 'the phone read the tapped install');
	ok(phone.st.fetches[0] === '/api/runner/relay?install=' + INSTALL, 'by the tapped install: ' + JSON.stringify(phone.st.fetches));
	eq(runners(phone).length, 0, 'down at once on the phone he tapped on');
	eq(synced(phone).length, 1, 'the phone wrote nothing synced');
	// A second tap (a reload, the tile seen again elsewhere) keeps it down.
	phone.fns.runnerTapped(N1, INSTALL);
	await phone.fns.runnerPoll();
	eq(runners(phone).length, 0, 'still down after a second tap');
	// The runner returns, refuses the answer and posts the entry again: back, and the poll stops.
	phone.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 600 })] };
	await phone.fns.runnerPoll();
	eq(runners(phone).length, 1, 'back on the phone once the refusal was re-posted');
	const n = phone.st.fetches.length;
	await phone.fns.runnerPoll();
	eq(phone.st.fetches.length, n, 'the poll stopped on the re-post');
	// A tap again after the refusal, and the runner's done mark: down, and the poll stops.
	await tapAgo(phone, N1, 1000, INSTALL);
	phone.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1', 'a2'], done: true, expires_in: 598 })] };
	await phone.fns.runnerPoll();
	eq(runners(phone).length, 0, 'down on the done mark');
	const m = phone.st.fetches.length;
	await phone.fns.runnerPoll();
	eq(phone.st.fetches.length, m, 'the poll stopped on done');
});

await kase('a waiting tap is polled at once and every 3 s, the tile down within one short interval, then the minute alone', async () => {
	const phone = page({ install: '' });
	const timers = [];
	phone.win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
	const A = phone.win.DaimondAlerts;
	A.raise(A.RUNNER, 'runner.' + N1 + '.1760745600.aaaaaaa1', 'runner update', 'aaaaaaa1 ' + INSTALL, true);
	phone.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 590 })] };
	await phone.fns.runnerTapped(N1, INSTALL);
	eq(phone.st.fetches.length >= 1, true, 'polled at the moment of the tap');
	eq(runners(phone).length, 1, 'not answered yet: the tile stays');
	eq(timers.length, 1, 'one short timer armed');
	ok(timers[0] && timers[0].ms <= 3000, 'the waiting cadence is short: ' + (timers[0] && timers[0].ms) + ' ms');
	// He answers on the approve page; the runner is down. One short interval later:
	phone.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 589 })] };
	await timers.shift().fn();
	eq(runners(phone).length, 0, 'down within one short interval of his answer');
	eq(timers.length, 0, 'held: the short cadence stops, the minute poll keeps it');
	// A tap that waits past the window drops to the minute poll.
	const pg = page({ install: '' });
	const t2 = [];
	pg.win.setTimeout = (fn, ms) => { t2.push({ fn, ms }); return t2.length; };
	pg.st.reply = { ok: true, entries: [entry(N2, 1760745700, 'bbbbbbb2', { answers: [], expires_in: 590 })] };
	await pg.fns.runnerTapped(N2, INSTALL);
	const v = JSON.parse(pg.win.localStorage.getItem(TAPPED)); v[N2].at -= 181 * 1000; pg.win.localStorage.setItem(TAPPED, JSON.stringify(v));
	const n = pg.st.fetches.length;
	await t2.shift().fn();
	eq(pg.st.fetches.length, n, 'no short poll past the window');
	eq(t2.length, 0, 'and no short timer re-armed: the minute cadence alone');
});

// QA-B part 2, P3 (LOW-3'): his PHONE (no runner). An earlier answer (a stranger's junk, or his own
// refused one) is on the entry, refused and re-posted 40 s ago. He taps Approve: the tap's own first
// read sees that answer, which is from before the tap, and holds nothing down.
await kase("phone: an answer already on the entry at his tap does not take the tile down (LOW-3')", async () => {
	const ph = page({ install: '' });
	const A = ph.win.DaimondAlerts;
	A.raise(A.RUNNER, 'runner.' + N1 + '.1760745600.aaaaaaa1', 'runner update', 'aaaaaaa1 ' + INSTALL, true);
	ph.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['junk'], expires_in: 560 })] };
	await ph.fns.runnerTapped(N1, INSTALL);		// the tap polls at once
	eq(runners(ph).length, 1, 'the tile stays: the answer was there before the tap');
	eq(JSON.parse(ph.win.localStorage.getItem(TAPPED))[N1].n, 1, "the tap's own read filled in its count");
	// His own answer then lands, and the runner is down: held from here.
	ph.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['junk', 'a1'], expires_in: 555 })] };
	await ph.fns.runnerPoll();
	eq(runners(ph).length, 0, 'his own answer after the tap holds it down');
});
// QA-B part 2, P4 (MED-4): the runner's own machine. The page loads before the hand's hello (own
// install ''), so the tap poll judges its own install and keeps 'held'; then the hand reports, the
// runner refuses and re-posts. The tile is back: the kept state judges only another install's tap.
await kase('runner machine: a held state kept before the hand reported does not outlive a refusal (MED-4)', async () => {
	const pg = page({ install: '' });
	const A = pg.win.DaimondAlerts;
	A.raise(A.RUNNER, 'runner.' + N1 + '.1760745600.aaaaaaa1', 'runner update', 'aaaaaaa1 ' + INSTALL, true);
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 560 })] };
	await tapAgo(pg, N1, 30 * 1000, INSTALL);
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 530 })] };
	await pg.fns.runnerPoll();				// hand not yet reported: polled as another install
	eq(JSON.parse(pg.win.localStorage.getItem(TAPPED))[N1].state, 'held', 'held kept');
	eq(runners(pg).length, 0, 'held down meanwhile');
	pg.st.install = INSTALL;				// the hand's hello arrives
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 600 })] };
	await pg.fns.runnerPoll();				// refused and re-posted
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'the refusal re-posted shows again on the runner machine');
	eq(JSON.parse(pg.win.localStorage.getItem(TAPPED))[N1].state, undefined, 'the own-install tap keeps no state');
});

// eps14c RED RA: the runner refuses within 5 s of the tap and re-posts. The hold is judged against
// the post seen when the tap first read as held, never the tap time, so the quick re-post is new.
await kase('a refusal re-posted 2 s after the tap brings the tile back on the tapping device; the same post re-read stays held', async () => {
	const ph = page({ install: '' });
	const A = ph.win.DaimondAlerts;
	A.raise(A.RUNNER, 'runner.' + N1 + '.1760745600.aaaaaaa1', 'runner update', 'aaaaaaa1 ' + INSTALL, true);
	ph.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 560 })] };
	await tapAgo(ph, N1, 3000, INSTALL);			// tapped 3 s ago; posted 40 s ago
	ph.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 560 })] };
	await ph.fns.runnerPoll();
	eq(runners(ph).length, 0, 'held after the tap');
	// The same post read again, its expires_in rounded the other way: still held.
	ph.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 561 })] };
	await ph.fns.runnerPoll();
	eq(runners(ph).length, 0, 'a re-read of the same post (1 s rounding) stays held');
	// Refused and re-posted 2 s after the tap (1 s ago).
	ph.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 599 })] };
	await ph.fns.runnerPoll();
	eq(runners(ph).length, 1, 'back on the phone after a quick refusal re-post');
	// The runner's own machine, judged live.
	const pg = page();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answers: [], expires_in: 560 })] };
	await pg.fns.runnerPoll();
	await tapAgo(pg, N1, 3000);
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 560 })] };
	await pg.fns.runnerPoll();
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 561 })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 0, 'runner machine: held across a rounding re-read');
	pg.st.reply = { ok: true, entries: [entry(N1, 1760745600, 'aaaaaaa1', { answered: true, answers: ['a1'], expires_in: 599 })] };
	await pg.fns.runnerPoll();
	eq(runners(pg).length, 1, 'runner machine: back after a quick refusal re-post');
});

console.log((failures ? 'FAIL' : 'PASS') + ' runnerpending: ' + (cases - failures) + '/' + cases + (BREAK ? ' (break ' + BREAK + ')' : ''));
if (failures) process.exitCode = 1;
