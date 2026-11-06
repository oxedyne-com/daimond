/* ============================================================
   Test: the "not run" tile offers Run here beside Retry (NOTRUN-WHY 2).

   Run here is his explicit choice to run that same turn on this
   device. It goes through the one fenced retry path (rulings l.16-18):
   the lost route's one derived turn id (`<iturn>-rt`), its work claim
   and its lease, never through the switch's election.

     RH1  the tile draws Retry and Run here, and drawing runs nothing
     RH2  a reload draws the tile again and never runs the turn by itself
     RH3  Run here, pressed twice, runs the turn once, here, under one
          turn id and one lease, with the switch on a runner
     RH4  the same for a Diamond's daimon turn (`retryDiamond`)
     RH5  a busy Diamond: Run here waits for it, never hands the turn off
     RH6  Retry still follows the switch: it is asked of the election
          first, and runs nothing here when the election hands it off
     RH7  an old hand-off placeholder a later turn follows draws a record
          and no button, and a lost Retry or a Continue on it runs nothing
     RH8  a runner's refusal is ONE "not run" row under its message, and
          its Run here steers that message exactly once, never an older one
     RH9  a load heals a leftover placeholder whose `-final` row is present

   RH7-RH9 are his chat's shape (UNBLOCK-83), dev/fixtures/runhere/his_chat_cmth5oiix.txt: Fred Hoogland
   diamond 1a05794cb284 chat cmth5oiix-9-0cdza rows muxkksvy-k-x5cz1 / mvxm98ag-2-hg7fg

   Lifts the REAL functions out of daimond.js and runs them in a scope
   of fakes; a free name the fakes lack throws.

   Run:  node www/js/runhere.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { source, lift } from './testlift.mjs';

const SRC = source('daimond.js');

let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (ok) { console.log('  ok   ' + name); return; }
	failures++;
	console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
}

const FNS = ['markInterrupted', 'isNotRunRow', 'isLostRow', 'notRunAsk', 'drawNotRunReason', 'notRunWhyKey',
	'seatReason', 'drawLostRowRunning', 'lostRetryMid', 'turnMessagesOf', 'retryTurn', 'retryRouted',
	'runRetryHere', 'retryDiamond', 'retryWhenIdle', 'askAgain'];
// UNBLOCK-83's, lifted for every world (the drawing reads them); RH1 asks only the FNS lift
// whole, so on the live record, where these are absent, only RH7-RH9 go red.
const FNS83 = ['turnSuperseded', 'opensTurn', 'isUndoNote', 'turnLive', 'handoffEnded', 'renderDispatchedFooter',
	'runnerRefusalRow', 'dispatchedAnswerPresent', 'healLeftoverPlaceholders', 'continueTurn'];

// A small element, enough for `markInterrupted` to draw a footer and its buttons.
function el(tag) {
	return { tag, children: [], handlers: {}, textContent: '', className: '', dataset: {}, attrs: {}, title: '',
		classList: { add() {} },
		setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.handlers[k] = f; } };
}
function buttons(e, out = []) { if (e.tag === 'button') out.push(e); e.children.forEach((c) => buttons(c, out)); return out; }

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

const TID = 'u1', PROMPT = 'build the page';

// A chat whose turn `u1` ended "not run": the prompt, and the row.
function notRunChat(diamondId) {
	const c = { id: 'c1', messages: [
		{ role: 'user', content: PROMPT, mid: TID, iturn: TID },
		{ role: 'assistant', content: '', interrupted: true, why: 'notrun', iturn: TID, mid: 'nr1',
			itext: PROMPT, notRun: { why: 'qa', cause: 'size', to: 'argonaut1', ts: 1 } },
	] };
	if (diamondId) c.diamondId = diamondId;
	return c;
}

// The world: `elect` is what the switch's election answers (true = handed off).
function world(chat, over) {
	const fns = FNS.concat(FNS83);
	const W = { elect: [], ran: [], steered: [], taken: [], claims: [], waits: [], settled: [], busy: false, idle: null };
	const leases = {};
	const held = new Set();
	const env = {
		window: null, Date, String, Object, Array, JSON, Math, Promise, setTimeout, Error,
		document: { createElement: el },
		t: (k) => k, diag: () => {}, toast: () => {},
		current: chat, pg: { current: chat },
		selfDeviceId: () => 'phone1', leaseClockNow: () => Date.now(),
		peerLeaseClaimed: () => '', runnerLabel: () => '', deviceNameFor: () => 'argonaut',
		renderDispatchedFooter: () => { throw new Error('not a dispatched row'); },
		seatDrawnRunner: () => 'argonaut1',
		maybeAutoDispatch: async (c, text, words, mid, app, drawn) => { W.elect.push({ text, mid, drawn }); await tick(); return env.handOff; },
		handOff: true,
		claimTurnHere: async (tid) => {
			await tick();
			if (held.has(tid)) return null;
			held.add(tid); W.claims.push(tid);
			return { release() { held.delete(tid); } };
		},
		DaimondLease: {
			record: () => null,
			take: async (tid) => { await tick(); W.taken.push(tid); if (leases[tid]) return { won: false, why: 'held', holder: leases[tid] }; leases[tid] = 'phone1'; return { won: true }; },
		},
		DaimondPeer: {
			dispatchState: () => 'none', dispatchControl: () => '', isAskAnswer: () => false,
			syncCas: () => ({}), standDownUndecided: () => false,
			settleLease: async (w, tid, h, mode) => { W.settled.push(tid + ':' + mode); },
		},
		peerSyncShim: () => ({}), watchRetryLease: () => () => {},
		DaimondSync: { flush: async () => {} },
		steerDiamondOf: (c) => (c && c.diamondId ? { id: c.diamondId } : null),
		diamondBusy: () => W.busy,
		awaitDiamondIdle: (c, f, text, nmid) => { W.waits.push(nmid); return new Promise((r) => { W.idle = r; }); },
		turnHold: () => null, askOpenIn: () => false,
		loadMsgTombs: () => ({}), newMid: () => 'fresh', msgTombstone: () => {}, sessionCut: () => {},
		touchChat: () => {}, persistChats: () => {}, renderHistory: () => {}, ChatStore: { compact: () => {} },
		ownsChat: () => false, intoComposer: () => {},
		// A run here writes its turn under the id it was given, as runTurn and runSteer do.
		runTurn: async (c, text, opts) => {
			W.ran.push({ text, mid: opts && opts.mid });
			c.messages.push({ role: 'user', content: text, mid: opts && opts.mid, iturn: opts && opts.mid });
			return true;
		},
		runSteer: async (f, text, n, x, how) => {
			W.steered.push({ text, mid: how && how.mid });
			chat.messages.push({ role: 'user', content: text, mid: how && how.mid, iturn: how && how.mid });
			return true;
		},
	};
	Object.assign(env, over || {});
	env.window = env;
	W.env = env;
	const L = lift(SRC, fns, ['NOTRUN_KEYS']);
	W.missing = L.missing;
	const body = L.body + '\nreturn {' + fns.map((n) => n + ': ' + (L.missing.includes(n) ? 'null' : n)).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => { if (!(k in t) && typeof k === 'string' && !(k in globalThis)) throw new ReferenceError(k + ' is not in the fakes'); return t[k]; },
		set: (t, k, v) => { t[k] = v; return true; },
	});
	W.f = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
	return W;
}

function draw(W, row) {
	const div = el('div');
	W.f.markInterrupted(div, row);
	const bs = buttons(div);
	return { div, retry: bs.find((b) => b.textContent === 'turn.retry'), here: bs.find((b) => b.textContent === 'turn.peer_runhere') };
}
const rowOf = (c) => c.messages.find((m) => m.mid === 'nr1');

// His chat (UNBLOCK-83), from dev/fixtures/runhere/his_chat_cmth5oiix.txt: the 7 Oct FBR turn handed to argonaut, its run
// cut after its tool calls (placeholder, unstamped rows, no answer), a later turn answered, Daimond's own note, then the
// B-roll ask the runner refused before running anything.
const HIS = readFileSync(new URL('../../dev/fixtures/runhere/his_chat_cmth5oiix.txt', import.meta.url), 'utf8')
	.split('\n').filter((l, i) => i > 0 && !l.startsWith('#')).join('\n');
const OLD = 'muxkksma-j-f1400', OLDPH = 'muxkksvy-k-x5cz1', FBR = 'Write the FBR life story preview';
const NEW = 'mvxm98ag-2-hg7fg', BROLL = 'Cut the B-roll list for the preview', RUN = 'e-0492a1';
function hisChat() { return JSON.parse(HIS); }
// The fakes the hand-off footer reads: the 7 Oct lease aged to `failed`, whose control is Run here.
function hisWorld(chat, over) {
	const W = world(chat, Object.assign({
		pg: { current: chat },
		peerUiStateFor: () => 'failed', turnRunnerId: () => '', interruptedRunner: () => null,
		pausedBack: () => '', handoffTargetLabel: () => 'argonaut', reRunParked: () => { throw new Error('re-run parked'); },
		DaimondTime: { fmtLocal: () => '7 Oct' },
		_dispatchedIx: {},
	}, over || {}));
	const P = W.env.DaimondPeer;
	P.uiState = () => 'failed';
	P.dispatchControl = (st) => (st === 'failed' ? 'runhere' : '');
	P.steerEchoes = () => ({});
	return W;
}
const allButtons = (d) => buttons(d.div);

async function main() {
	{
		console.log('RH1: the tile draws Retry and Run here, and drawing runs nothing');
		const chat = notRunChat();
		const W = world(chat);
		check('RH1 every function lifts', W.missing.filter((n) => FNS.includes(n)).length === 0, W.missing.join(', '));
		const d = draw(W, rowOf(chat));
		await settle();
		check('RH1 Retry is drawn', !!d.retry);
		check('RH1 Run here is drawn beside it', !!d.here && d.here.className === d.retry.className
			&& d.div.children[0].children.indexOf(d.here) > d.div.children[0].children.indexOf(d.retry));
		check('RH1 drawing runs nothing', W.elect.length + W.ran.length + W.claims.length + W.taken.length === 0,
			JSON.stringify({ elect: W.elect, ran: W.ran }));
	}
	{
		console.log('RH2: a reload draws the tile again and never runs the turn by itself');
		const chat = JSON.parse(JSON.stringify(notRunChat()));	// as stored, read back on boot
		const W = world(chat);
		const d1 = draw(W, rowOf(chat));
		const d2 = draw(W, rowOf(chat));
		await settle();
		check('RH2 the tile is drawn again, with both controls', !!d1.here && !!d2.here && !!d2.retry);
		check('RH2 nothing runs, nothing is elected, claimed or leased', W.elect.length + W.ran.length + W.claims.length + W.taken.length === 0,
			JSON.stringify({ elect: W.elect, ran: W.ran }));
		check('RH2 the row stands', !!rowOf(chat));
	}
	{
		console.log('RH3: Run here, pressed twice, runs once here, under one turn id and one lease');
		const chat = notRunChat();
		const W = world(chat);
		const d = draw(W, rowOf(chat));
		if (d.here) { d.here.handlers.click(); d.here.handlers.click(); }
		await settle();
		const d2 = rowOf(chat) ? draw(W, rowOf(chat)) : null;	// drawn again (another tab, a redraw)
		if (d2 && d2.here) d2.here.handlers.click();
		if (d.here) d.here.handlers.click();
		await settle();
		check('RH3 the switch is not asked', W.elect.length === 0, JSON.stringify(W.elect));
		check('RH3 it ran exactly once, here, as the lost route\'s turn', W.ran.length === 1 && W.ran[0].mid === TID + '-rt'
			&& W.ran[0].text === PROMPT, JSON.stringify(W.ran));
		check('RH3 under its one lease, taken once and settled', W.taken.filter((x) => x === TID + '-rt').length === 1
			&& W.settled.indexOf(TID + '-rt:done') >= 0, JSON.stringify({ taken: W.taken, settled: W.settled }));
		check('RH3 the "not run" row is gone', !rowOf(chat));
	}
	{
		console.log('RH4: a Diamond\'s turn, Run here pressed twice, runs once here');
		const chat = notRunChat('d1');
		const W = world(chat);
		const d = draw(W, rowOf(chat));
		if (d.here) { d.here.handlers.click(); d.here.handlers.click(); }
		const d2 = draw(W, rowOf(chat));	// another draw before the claim lands
		if (d2.here) d2.here.handlers.click();
		await settle();
		check('RH4 the switch is not asked', W.elect.length === 0, JSON.stringify(W.elect));
		check('RH4 it was steered exactly once, here, as the lost route\'s turn', W.steered.length === 1
			&& W.steered[0].mid === TID + '-rt', JSON.stringify(W.steered));
		check('RH4 nothing ran as a chat turn', W.ran.length === 0);
	}
	{
		console.log('RH5: a busy Diamond: Run here waits for it, and never hands the turn off');
		const chat = notRunChat('d1');
		const W = world(chat);
		W.busy = true;
		const d = draw(W, rowOf(chat));
		if (d.here) d.here.handlers.click();
		await settle();
		check('RH5 it waits for the Diamond, with the row still drawn', W.waits.length === 1 && !!rowOf(chat) && W.elect.length === 0,
			JSON.stringify({ waits: W.waits, elect: W.elect }));
		W.busy = false;
		if (W.idle) W.idle('done');
		await settle();
		check('RH5 woken, it runs once here, not through the switch', W.steered.length === 1 && W.elect.length === 0
			&& W.steered[0].mid === TID + '-rt', JSON.stringify({ steered: W.steered, elect: W.elect }));
	}
	{
		console.log('RH6: Retry still follows the switch');
		const chat = notRunChat();
		const W = world(chat);
		const d = draw(W, rowOf(chat));
		d.retry.handlers.click();
		await settle();
		check('RH6 Retry asks the election, as the lost route\'s turn', W.elect.length === 1 && W.elect[0].mid === TID + '-rt',
			JSON.stringify(W.elect));
		check('RH6 handed off, nothing runs here', W.ran.length === 0 && W.claims.length === 0, JSON.stringify(W.ran));
		const chat2 = notRunChat();
		const W2 = world(chat2, { handOff: false });
		draw(W2, rowOf(chat2)).retry.handlers.click();
		await settle();
		check('RH6 kept here by the election, it runs here fenced', W2.elect.length === 1 && W2.ran.length === 1
			&& W2.ran[0].mid === TID + '-rt' && W2.taken.length === 1, JSON.stringify({ elect: W2.elect, ran: W2.ran }));
	}
	{
		console.log('RH7: an old placeholder a later turn follows is a record, with no button');
		const chat = hisChat();
		const W = hisWorld(chat);
		check('RH7 every function lifts', W.missing.length === 0, W.missing.join(', '));
		const ph = chat.messages.find((m) => m.mid === OLDPH);
		let d = null, err = '';
		try { d = draw(W, ph); } catch (e) { err = String(e); }
		check('RH7 it draws', !!d, err);
		check('RH7 it offers no button', !!d && allButtons(d).length === 0,
			d ? allButtons(d).map((b) => b.textContent).join(',') : err);
		const before = chat.messages.length;
		let rv = null;
		err = '';
		try { rv = W.f.retryTurn(chat, OLD, FBR, { lost: true }); } catch (e) { err = String(e); }
		try { W.f.continueTurn && W.f.continueTurn(chat, OLD, FBR, false, undefined, false); } catch (e) { err = String(e); }
		await settle();
		check('RH7 a lost Retry and a Continue on it run nothing', err === '' && rv === false && W.ran.length + W.steered.length
			+ W.elect.length + W.claims.length + W.taken.length === 0 && chat.messages.length === before,
			JSON.stringify({ rv, ran: W.ran, steered: W.steered, err }));
		check('RH7 its prompt and rows stand', !!chat.messages.find((m) => m.mid === OLD) && !!chat.messages.find((m) => m.mid === OLDPH));
	}
	{
		console.log('RH8: a runner\'s refusal is ONE "not run" row, and Run here asks that message once');
		const chat = hisChat();
		const W = hisWorld(chat);
		const fin = chat.messages.find((m) => m.mid === RUN + '-final');
		let row = null, err = '';
		try { row = W.f.runnerRefusalRow(fin, chat.messages); } catch (e) { err = String(e); }
		check('RH8 the refusal gives a "not run" row for the B-roll turn', !!row && row.why === 'notrun'
			&& row.iturn === NEW && row.itext === BROLL && row.notRun && row.notRun.cause === 'refused'
			&& row.notRun.said === 'Refused at line 1, column 0.', JSON.stringify(row) + err);
		const withRow = { role: 'assistant', interrupted: true, why: 'notrun', iturn: NEW, mid: 'nr9', notRun: { cause: 'qa' } };
		let again = null;
		try { again = W.f.runnerRefusalRow(fin, chat.messages.concat([withRow])); } catch (e) { err = String(e); }
		check('RH8 a turn with its own "not run" row draws no second one', again === false, String(again) + err);
		const ran = Object.assign({}, fin, { mid: 'x' }), tool = { role: 'tool_log', run: RUN, mid: RUN + '-1', content: 'ls' };
		let kept = 'unset';
		try { kept = W.f.runnerRefusalRow(fin, chat.messages.concat([tool])); } catch (e) { err = String(e); }
		check('RH8 a run that ran, then failed, keeps its error row (ruling 2)', kept === null, String(kept) + err);
		if (row) {
			chat.messages.push(row);	// as drawHistoryMessage draws it
			let d = null;
			try { d = draw(W, row); } catch (e) { err = String(e); }
			check('RH8 its tile offers Run here', !!d && !!d.here, err);
			if (d && d.here) { d.here.handlers.click(); d.here.handlers.click(); }
			await settle();
			check('RH8 Run here steered exactly once, the B-roll message, never the FBR one',
				W.steered.length === 1 && W.steered[0].text === BROLL && W.steered[0].mid === NEW + '-rt'
				&& W.ran.length === 0 && W.elect.length === 0, JSON.stringify({ steered: W.steered, ran: W.ran }));
		}
		const ph = chat.messages.find((m) => m.mid === OLDPH);
		let d7 = null;
		try { d7 = draw(W, ph); } catch (e) { err = String(e); }
		check('RH8 the old FBR placeholder still offers nothing', !!d7 && allButtons(d7).length === 0, err);
	}
	{
		console.log('RH9: a load heals a leftover placeholder whose -final row is present');
		const chat = hisChat();
		chat.messages.push({ role: 'user', content: 'the index', mid: 'u3', iturn: 'u3', ts: 1793100000000 },
			{ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: 'u3', mid: 'ph3', ts: 1793100000100 },
			{ role: 'assistant', content: 'Here is the index.', mid: 'e-77-final', run: 'e-77', iturn: 'u3', ts: 1793100009000 });
		const tombs = [];
		const ix = { u3: 'cmth5oiix-9-0cdza', [OLD]: 'cmth5oiix-9-0cdza' };
		const W = hisWorld(chat, { msgTombstone: (mids) => { tombs.push(...mids); }, _dispatchedIx: ix });
		let n = null, err = '';
		try { n = W.f.healLeftoverPlaceholders(chat); } catch (e) { err = String(e); }
		check('RH9 the answered placeholder is dropped and tombstoned, once', n === 1 && !chat.messages.find((m) => m.mid === 'ph3')
			&& tombs.length === 1 && tombs[0] === 'ph3' && !('u3' in ix), JSON.stringify({ n, tombs, ix }) + err);
		check('RH9 the unanswered 7 Oct placeholder is kept, as a record', !!chat.messages.find((m) => m.mid === OLDPH) && (OLD in ix));
		let n2 = null;
		try { n2 = W.f.healLeftoverPlaceholders(chat); } catch (e) { err = String(e); }
		check('RH9 a second load finds nothing to heal', n2 === 0, String(n2) + err);
	}
	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
