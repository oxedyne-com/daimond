/* ============================================================
   Test -- Stop takes down the questions its turn left up (QA r578d-A D2).
   ------------------------------------------------------------
   A stopped turn's Rust future is gone, so an answer to the run, network
   or delete dialog it raised (up to 2 min), or to its askChange Pending tile
   (up to 10 min), reaches nobody. Every such question is filed under the tag
   of the turn that asked (the payload's `turn`), and `abortTurn` closes the
   ones filed under the stopped turn, each with its own safe answer.

   Run:  node --test www/js/stopasks.test.mjs
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE    = dirname(fileURLToPath(import.meta.url));
const DAIMOND = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const DELETES = readFileSync(join(HERE, '..', '..', 'src', 'wasm', 'deletes.rs'), 'utf8');

function lift(name) {
	let a = DAIMOND.indexOf('\tfunction ' + name + '(');
	if (a < 0) a = DAIMOND.indexOf('\tasync function ' + name + '(');
	const b = DAIMOND.indexOf('\n\t}\n', a);
	assert.ok(a >= 0 && b >= 0, 'daimond.js holds ' + name);
	return DAIMOND.slice(a, b + 3);
}

/// The text of every call to `fn(` in `src`, brace- and paren-matched.
function calls(src, fn) {
	const out = [];
	let at = 0;
	for (;;) {
		const i = src.indexOf(fn + '(', at);
		if (i < 0) return out;
		let j = i + fn.length, depth = 0;
		for (; j < src.length; j++) {
			const c = src[j];
			if (c === '(') depth++;
			else if (c === ')') { depth--; if (depth === 0) break; }
		}
		out.push(src.slice(i, j + 1));
		at = j;
	}
}

function register() {
	const asks = Object.create(null);
	const src = lift('holdTurnAsk') + lift('closeTurnAsks')
		+ '\nreturn { hold: holdTurnAsk, close: closeTurnAsks };';
	return new Function('_turnAsks', src)(asks);
}

test('D2: a turn\'s questions close on its Stop, and no other turn\'s', () => {
	const r = register();
	const shut = [];
	r.hold('tagA', () => shut.push('a1'));
	r.hold('tagA', () => shut.push('a2'));
	r.hold('tagB', () => shut.push('b1'));
	const off = r.hold('tagA', () => shut.push('a3'));
	off();									// answered before the Stop: not closed again
	r.hold('', () => shut.push('untagged'));	// no turn named: never filed
	r.close('tagA');
	assert.deepEqual(shut.sort(), ['a1', 'a2']);
	r.close('tagA');						// a second Stop finds nothing
	assert.deepEqual(shut.sort(), ['a1', 'a2']);
	r.close('');
	assert.deepEqual(shut.sort(), ['a1', 'a2']);
	r.close('tagB');
	assert.deepEqual(shut.sort(), ['a1', 'a2', 'b1']);
});

test('D2: an askChange tile of the stopped turn comes down as unanswered', async () => {
	const asks = Object.create(null), parked = Object.create(null), items = [];
	const Pending = {
		add(item) { const rec = Object.assign({ id: 'p' + items.length }, item); items.push(rec); return rec.id; },
		fresh() {}, render() {},
		drop(id) { settleConsent(id, 'deny'); const k = items.findIndex((x) => x.id === id); if (k >= 0) items.splice(k, 1); },
	};
	function settleConsent(id, verdict) {
		const go = parked[id]; if (!go) return false; delete parked[id]; go(verdict); return true;
	}
	const chat = { id: 'C1', diamondId: 'D1', _generating: true, _busy: 'x' };
	const src = ['holdTurnAsk', 'closeTurnAsks', 'permitRunnerTurn', 'runnerTurnByTag', 'changeName',
		'changeHead', 'changeChat', 'changeWaitMs', 'askChange'].map(lift).join('')
		+ '\nvar CHANGE_WORD = { allow: \'apply\', deny: \'refused\' };'
		+ '\nreturn { askChange: askChange, close: closeTurnAsks };';
	const api = new Function('_turnAsks', '_runnerCtx', 'selfDeviceId', 'Pending', '_parked', 'settleConsent',
		'busySay', 't', 'tOr', 'chats', 'diamonds', 'DaimondPeer', src)(
		asks, {}, () => 'ME', Pending, parked, settleConsent, (c, w) => { c._busy = w; },
		(k) => k, (k, d) => d, [chat], [{ id: 'D1', name: 'Notes' }], {});
	const req = (turn) => JSON.stringify({ keeper: 'D1', path: 'a/' + turn + '.md', turn: turn, act: 'write', wait: 600000 });
	const pa = api.askChange(req('tagA'));
	const pb = api.askChange(req('tagB'));
	assert.equal(items.length, 2);
	api.close('tagA');
	assert.equal(await pa, 'unanswered', 'never his refusal: he did not answer');
	assert.deepEqual(items.map((x) => x.change.turn), ['tagB'], 'the stopped turn\'s tile is down');
	assert.ok(parked[items[0].id], 'the other turn still waits');
	Pending.drop(items[0].id);
	assert.equal(await pb, 'refused');
});

test('D2: every dialog a turn raises is filed under its turn, and Stop closes them', () => {
	// The modal files itself and unfiles on every exit.
	const dlg = lift('dialog');
	assert.match(dlg, /holdTurnAsk\(opts\.turn,/);
	assert.match(lift('confirmDialog'), /turn: opts\.turn/);
	// Every question the permission door draws names the turn that asked.
	const door = lift('egressAllowed');
	const asks = calls(door, 'confirmDialog').concat(calls(door, 'dialog').filter((c) => /^dialog\(\{/.test(c)));
	assert.ok(asks.length >= 8, 'found the door\'s dialogs: ' + asks.length);
	asks.forEach((c) => assert.match(c, /turn:\s+req\.turn/, c.slice(0, 80)));
	// The held delete carries its turn from the engine to the dialog.
	assert.match(DELETES, /\\"turn\\":\\"\{\}\\"/, 'ask_to_go_on sends the turn');
	assert.match(lift('askHeldDelete'), /turn: turn/);
	// Stop and pause both come through abortTurn.
	assert.match(lift('abortTurn'), /closeTurnAsks\(c\._turnTag\)/);
});
