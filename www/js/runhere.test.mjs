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

   Lifts the REAL functions out of daimond.js and runs them in a scope
   of fakes; a free name the fakes lack throws.

   Run:  node www/js/runhere.test.mjs
   ============================================================ */
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
	const W = { elect: [], ran: [], steered: [], taken: [], claims: [], waits: [], settled: [], busy: false, idle: null };
	const leases = {};
	const held = new Set();
	const env = {
		window: null, Date, String, Object, Array, JSON, Math, Promise, setTimeout, Error,
		document: { createElement: el },
		t: (k) => k, diag: () => {}, toast: () => {},
		current: chat,
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
	const L = lift(SRC, FNS, ['NOTRUN_KEYS']);
	W.missing = L.missing;
	const body = L.body + '\nreturn {' + FNS.map((n) => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(', ') + '};';
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

async function main() {
	{
		console.log('RH1: the tile draws Retry and Run here, and drawing runs nothing');
		const chat = notRunChat();
		const W = world(chat);
		check('RH1 every function lifts', W.missing.length === 0, W.missing.join(', '));
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
	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
