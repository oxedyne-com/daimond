/* ============================================================
   Test -- r578 (r577 review, finding 2): a word typed on the runner
   into a turn it runs for another device is never lost.
   ------------------------------------------------------------
   argonaut runs the phone's handed-off turn of Diamond D, and D is
   open on argonaut too. A turn run for another device hands back
   what it never heard to that device (`reclaimInterjections`, keep
   false), so a word typed on argonaut and said into it is dropped
   by both. It must queue behind the turn and go out through the
   election instead; a word relayed over the lease still goes in.

     W1  typed on the runner during a detached, tool-less turn: not
         said into it, queued, and still queued after the turn ends,
         with no "said into" bubble left on the chat it was typed in
     W2  a word relayed from the asking device still goes in
     W3  a turn of this device's own still hears a word typed here
     W4  runSteer marks a detached steer beside `_steerApp`, and
         clears the mark with it

   Lifts the REAL functions (testlift.mjs). Red proof:

     MM_SRC_REV=cd3359c36 node www/js/detachedsay.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { source, lift } from './testlift.mjs';

const SRC = source('daimond.js');
const FNS = ['interjectInto', 'interjectMessage', 'sayIntoHere', 'sendToDiamondTurn', 'reclaimInterjections',
	'enqueueMessage'];

// One runner device: the lifted code over fakes, with D busy on `fa`, the turn's app.
function runner(detached) {
	const L = lift(SRC, FNS);
	assert.deepEqual(L.missing, [], 'daimond.js lacks ' + L.missing.join(', '));
	const log = [];
	const shown = { id: 'cD', diamondId: 'D', messages: [], _queue: [] };	// D's chat, on screen here
	const rec   = { id: 'cD', diamondId: 'D', messages: [], _queue: [] };	// the errand's own record
	let q = [];
	const fa = {
		interject_daimon: (did, text) => { log.push(['said', text]); q.push(text); },
		take_daimon_interjections: () => { const r = q; q = []; return r; },
	};
	const ctx = vm.createContext({
		console, Object, Array, String, JSON, Date, Math, Promise,
		_steerApp: { D: fa }, _steerDetached: detached ? { D: true } : {},
		chats: [shown], current: shown, locked: false,
		diamondBusy: () => true, recoveringHere: () => false, seatNamesRunner: () => false,
		peerHeldTurnOf: () => null,
		sayToRunner: async () => { log.push(['sayToRunner']); return false; },
		maybeAutoDispatch: async () => { log.push(['elect']); return true; },
		commitRatings: () => {}, ratingPre: () => '', journalQueue: () => {}, giveUpSent: () => {},
		syncSendMode: () => {}, renderQueue: () => {}, diag: (k, m) => log.push(['diag', k, m]),
	});
	ctx.window = ctx;
	const api = vm.runInContext(L.body + '\n;({ ' + FNS.map((n) => n + ': ' + n).join(', ') + ' })', ctx);
	// The turn ends with no seam: what it holds is handed back as runSteer's `saidBack` does.
	const end = () => { delete ctx._steerApp.D; delete ctx._steerDetached.D;
		api.reclaimInterjections(rec, fa.take_daimon_interjections, !detached); };
	return { api, log, shown, rec, end, said: () => log.filter((e) => e[0] === 'said').map((e) => e[1]) };
}

test('W1: typed on the runner into a detached tool-less turn: queued, and still queued at its end', async () => {
	const r = runner(true);
	const went = await r.api.sendToDiamondTurn(r.shown, 't', 't');
	assert.equal(went, true);
	assert.deepEqual(r.said(), [], 'not said into the turn it runs for another device');
	r.end();
	assert.deepEqual(r.shown._queue, ['t'], 'the word waits for the election: ' + JSON.stringify(r.log));
	assert.deepEqual(r.shown._interject || [], [], 'no "said into" bubble left on the chat it was typed in');
});

test('W2: a word relayed from the asking device still goes into the detached turn', () => {
	const r = runner(true);
	const ok = r.api.interjectMessage(r.rec, 'r', undefined, { id: 'm1', pre: '' });
	assert.equal(ok, true);
	assert.deepEqual(r.said(), ['r']);
});

test('W3: a turn of this device\'s own still hears a word typed here', async () => {
	const r = runner(false);
	await r.api.sendToDiamondTurn(r.shown, 't', 't');
	assert.deepEqual(r.said(), ['t']);
	assert.deepEqual(r.shown._queue, []);
});

test('W4: runSteer marks a detached steer beside _steerApp and clears it with it', () => {
	const a = SRC.indexOf('_steerApp[diamondId] = fa;');
	assert.ok(a > 0, 'runSteer sets _steerApp');
	const near = SRC.slice(a, SRC.indexOf('reclaimInterjections(rec', a));
	assert.match(near, /if \(detached\) _steerDetached\[diamondId\] = true;/);
	assert.match(near, /delete _steerApp\[diamondId\]; delete _steerDetached\[diamondId\];/);
	assert.match(SRC, /\n\tvar _steerDetached = Object\.create\(null\);/);
});
