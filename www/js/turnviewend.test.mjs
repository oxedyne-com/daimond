/* ============================================================
   Test -- the hand-off tile's end-of-turn checks read the turn's TurnView
   (P2.3a4; design daimond_p2_turnlog_design_20261030 §2: "the one
   end-of-turn decision, written and tested once").

     VIEW     turnlog.js keeps each turn's state as the log folded it:
              open while its view is held, ended(status) once its end row
              folds, kept with the device's place; nothing for a turn the
              log never named
     TILE     uiState reads the view: handed off, running elsewhere, ended
              done / stopped / interrupted / not_run, and lost (the run's
              lease lapsed with the view still open); a settled lease
              alone never draws an end
     SETTLED  dispatchedTurnSettled (and so dispatchedTurnFinished) is
              the view's end or the lease view's, never a report or an
              answer row read off the transcript
     LOSS     withdrawOnLoss stands down for an ended view
     ANSWERED dropOwnPlaceholderIfAnswered drops on an ended view, else
              reads the chat's log so the end folds; handoffDone is gone

     node www/js/turnviewend.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); }
}
const J = JSON.stringify;
const { liftSource } = await import('../../dev/syncprobe.mjs');
const TL = await import('./page/turnlog.js');

// A stand-in TurnView: a row joins the view, an `end` row ends it with its status.
const seal = {
	turnviewApply: async (vj, rj) => {
		const v = JSON.parse(vj), r = JSON.parse(rj);
		if (r.head.kind === 'end') { v.state = 'ended'; v.status = r.body.status; v.end = r.body; }
		else v.rows.push({ mid: r.body.mid, role: 'assistant', text: r.body.text, seq: r.head.seq, at: r.head.seq });
		v.last = r.head.n;
		return J({ view: v });
	},
};
const deps = { seal, join: (a, b) => Object.assign({}, a, b), isTile: () => false };
const row = (seq, turn, kind, body) => ({ head: { seq, turn, n: seq, kind }, body });

// ── VIEW ──
{
	check('VIEW turnView exists', typeof TL.turnView === 'function');
	const chat = { id: 'c1', messages: [] };
	if (typeof TL.turnView === 'function') {
		check('VIEW a turn the log never named has none', TL.turnView(chat, 'T1') === null, J(TL.turnView(chat, 'T1')));
		await TL.foldRows(chat, [row(1, 'T1', 'say', { mid: 'a1', text: 'hi' })], deps);
		check('VIEW open while its view is held', J(TL.turnView(chat, 'T1')) === J({ state: 'open' }), J(TL.turnView(chat, 'T1')));
		for (const [i, st] of ['done', 'stopped', 'interrupted', 'not_run'].entries()) {
			const t = 'E' + i;
			await TL.foldRows(chat, [row(10 + 2 * i, t, 'say', { mid: t + 'a', text: 'x' }), row(11 + 2 * i, t, 'end', { status: st })], deps);
			check('VIEW ended(' + st + ') once its end folds', J(TL.turnView(chat, t)) === J({ state: 'ended', status: st }), J(TL.turnView(chat, t)));
		}
		check('VIEW the ends ride the chat (kept with the place)', !!(chat.logEnds && chat.logEnds.E0 === 'done'), J(chat.logEnds));
	}
}

// ── TILE ──
function loadPeer() {
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
	return win;
}
const P = loadPeer().DaimondPeer;
const NOW = Date.now(), SELF = 'PHONE', DESK = 'DESK';
const turn = () => ({ role: 'assistant', why: 'dispatched', iturn: 'T1', itext: 'go', ts: NOW - 4000,
	toDevice: DESK, dispatchedBy: SELF });
const live = (mode) => ({ holder: DESK, mode, expiry: NOW + 60000, deadline: NOW + 60000 });
const ui = (lease, view) => P.uiState(turn(), lease, null, SELF, NOW, null, false, view);
check('TILE handed off: no lease, view open', ui(null, { state: 'open' }) === 'dispatched', ui(null, { state: 'open' }));
check('TILE handed off: no lease, no view yet', ui(null, null) === 'dispatched', ui(null, null));
check('TILE running elsewhere: a live foreign run, view open', ui(live('running'), { state: 'open' }) === 'running', ui(live('running'), { state: 'open' }));
for (const [st, want] of [['done', 'done'], ['stopped', 'done'], ['interrupted', 'interrupted'], ['not_run', 'ending']]) {
	const got = ui(live('running'), { state: 'ended', status: st });
	check('TILE ended(' + st + ') reads ' + want + ', whatever the lease', got === want, got);
}
const lapsed = { holder: DESK, mode: 'running', expiry: NOW - 1000, deadline: NOW + 60000 };
check('TILE lost: the run lease lapsed, the view still open', ui(lapsed, { state: 'open' }) === 'failed', ui(lapsed, { state: 'open' }));
const settled = { holder: DESK, mode: 'done', expiry: 0, deadline: NOW + 60000, settled: 1 };
const sOpen = ui(settled, { state: 'open' }), sCut = ui(Object.assign({ cut: 1 }, settled), { state: 'open' });
check('TILE a settled lease alone draws no end (done)', sOpen !== 'done' && sOpen !== 'failed', sOpen);
check('TILE a settled cut lease alone draws no end (interrupted)', sCut !== 'interrupted' && sCut !== 'failed', sCut);

// ── LOSS ──
const gone = { derived: true, listening: false };
const w = (lease, view) => P.withdrawOnLoss(turn(), lease, gone, SELF, NOW, view);
check('LOSS an open turn on a runner that stopped listening is withdrawn', w(null, { state: 'open' }) === true, w(null, { state: 'open' }));
check('LOSS an ended view stands it down', w(null, { state: 'ended', status: 'done' }) === false);

// ── SETTLED ──
function lift(names, stubs, args) {
	try {
		return new Function(...stubs, liftSource(names, stubs).src + '\nreturn {' + names.join(',') + '};')(...args);
	} catch (e) { console.log('  lift ' + names + ': ' + e.message); return null; }
}
const leases = {};
const win = {
	DaimondPeer: { settledLease: P.settledLease, settlingReport: (r) => !!r && r.status === 'done' },
	DaimondLease: { record: (t) => leases[t] || null },
};
const chats = [{ id: 'c2', messages: [
	{ role: 'assistant', iturn: 'R1', mid: 'r1', content: 'an answer off the transcript' },
] }];
chats[0].logViews = { O1: { turn: 'O1', state: 'open', rows: [] } };
chats[0].logEnds = { E1: 'done', E2: 'interrupted', E3: 'not_run', E4: 'stopped' };
const reports = { R1: { t: 'report', status: 'done' } };
const H = lift(['dispatchedTurnSettled', 'dispatchedTurnFinished'], ['window', 'DaimondPeer', 'DaimondLease', 'chats', 'peerReports', 'turnView'], [win, win.DaimondPeer, win.DaimondLease, chats, reports, TL.turnView]);
check('SETTLED lifts', !!H);
if (H) {
	const s = (t) => H.dispatchedTurnSettled({ turnId: t, chatId: 'c2' });
	check('SETTLED an open view is not settled', s('O1') === false);
	for (const t of ['E1', 'E2', 'E3', 'E4']) check('SETTLED ended(' + chats[0].logEnds[t] + ') is settled', s(t) === true);
	check('SETTLED with no chat named, every chat is searched', H.dispatchedTurnSettled({ turnId: 'E1' }) === true);
	leases.O1 = { mode: 'done', settled: 1 };
	check('SETTLED the lease view settles an open one', s('O1') === true);
	check('SETTLED a report or a transcript answer alone settles nothing', s('R1') === false);
	check('SETTLED dispatchedTurnFinished is the same decision', H.dispatchedTurnFinished(chats[0], 'E2') === true
		&& H.dispatchedTurnFinished(chats[0], 'R1') === false);
}

// ── ANSWERED ──
{
	const dropped = [], read = [];
	const c = { id: 'c3', messages: [], logEnds: { D1: 'done' }, logViews: { D2: { turn: 'D2', state: 'open', rows: [] } } };
	const ph = { why: 'dispatched', dispatchedBy: SELF };
	const A = lift(['dropOwnPlaceholderIfAnswered'],
		['dispatchedChat', 'dispatchedPlaceholderIn', 'selfDeviceId', 'dropDispatchedPlaceholder', 'readChatLog', 'dispatchedAnswerPresent', 'turnView'],
		[() => c, () => ph, () => SELF, (t) => dropped.push(t), (x) => { read.push(x.id); return Promise.resolve(null); }, () => true, TL.turnView]);
	if (A) {
		A.dropOwnPlaceholderIfAnswered('D1');
		A.dropOwnPlaceholderIfAnswered('D2');
		check('ANSWERED an ended view drops the placeholder', dropped.join() === 'D1', dropped.join());
		check('ANSWERED an open one reads the log for its end', read.join() === 'c3', read.join());
	} else check('ANSWERED lifts', false);
	const src = readFileSync(join(HERE, 'page', 'handoff.js'), 'utf8');
	check('ANSWERED handoffDone is gone', !/function handoffDone\(/.test(src));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('turnviewend: all passed');
