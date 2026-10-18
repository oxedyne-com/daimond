/* ============================================================
   Test -- a runner's errand belongs to its own chat (UNBLOCK-7 check_k K-X1, K-R1).

   K-X1. `runnerTurnOf` was declared twice in one scope, and the later, request-based
   one won: asked with a chat id it read `req.turn` (undefined) and answered the one
   active runner turn whatever its chat. With chat Y's errand in flight, idle chat X
   read `running`, and Stop in X stopped Y as a user Stop. The request form is now
   `runnerTurnOfReq`.

   K-R1. `endLocal` runs after the lease door answers, a second or more after the
   errand's own abort. A Continue pressed in that window started a new turn on the
   chat, and `endLocal` killed it. It now acts only on the run it ends (`chat._turnTag`
   against the run's tag), and Continue / Answer again refuse while the chat's errand
   is in flight.

   L-R1 (check_l). A fan-out's gather round runs inside the errand and re-tags the chat, so
   the run's tag went stale and a kill landing in a gather round skipped it. Every round
   of the errand's turn now carries its tag (`runnerRoundTagged`).

   Every declaration of a lifted name is lifted, in source order, so a duplicate
   shadows here exactly as it does in the page.   `node www/js/runnerchat.test.mjs`
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// Every top-level-in-the-IIFE declaration of `name`, in source order ([] when none).
function extractAll(src, name) {
	const out = [];
	for (const kw of ['\n\tfunction ', '\n\tasync function ']) {
		let at = 0;
		for (;;) {
			const start = src.indexOf(kw + name + '(', at);
			if (start < 0) break;
			const brace = src.indexOf('{', start);
			let depth = 0, i = brace;
			for (; i < src.length; i++) {
				if (src[i] === '{') depth++;
				else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
			}
			out.push({ at: start, text: src.slice(start + 1, i) });
			at = i;
		}
	}
	return out;
}

const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const names = ['runnerTagged', 'runnerRoundTagged', 'activeRunnerTurn', 'runnerTurnByTag', 'runnerTurnOf', 'runnerTurnOfReq',
	'chatIsActiveErrand', 'turnPhase', 'stopGeneration', 'endRunnerLocal', 'continueStopped', 'answerAgain'];
const found = {};
const decls = [];
for (const n of names) { const all = extractAll(src, n); found[n] = all.length; decls.push(...all); }
decls.sort((a, b) => a.at - b.at);
const lifted = decls.map((d) => d.text).join('\n');

check('K-X1: runnerTurnOf is declared once', found.runnerTurnOf === 1, 'declarations=' + found.runnerTurnOf);
check('K-X1: the request form is runnerTurnOfReq', found.runnerTurnOfReq === 1);

function harness() {
	const env = { sends: 0, killed: [], runs: [], retracted: [] };
	const api = new Function('env', `
		"use strict";
		var _runnerCtx = Object.create(null), _peerStopping = Object.create(null);
		var current = null;
		function peerHeldTurnOf() { return null; }
		function syncSendMode() { env.sends++; }
		function syncComposer() {}
		function setCrystalBusy() {}
		function touchMsg(m) { m._touched = true; }
		function endTurnEngine(chat, why) { env.killed.push({ chat: chat, why: why }); return 0; }
		function setTimeout(fn) { fn(); }
		var window = {};
		function endContinuable() { return true; }
		function retireContinue() {}
		function turnHold() { return null; }
		function touchChat() {}
		function persistChats() {}
		function runTurn(chat, text) { env.runs.push({ chat: chat, text: text }); }
		var CONTINUE_NUDGE = 'continue';
		// The Continue's turn, wherever the switch puts it (UNBLOCK-1 QFOLLOW, qfollow.test Q10).
		function continueRouted(chat) { env.runs.push({ chat: chat, text: CONTINUE_NUDGE }); }
		function turnMessagesOf(chat, iturn) { env.retracted.push(iturn); return []; }
		function turnSpan(chat, id) {
			return (chat.messages || []).filter(function (m) { return id && m.iturn === id; });
		}
		${lifted}
		return {
			ctx: _runnerCtx,
			setCurrent: function (c) { current = c; },
			runnerTurnOf: runnerTurnOf, chatIsActiveErrand: chatIsActiveErrand,
			runnerTurnOfReq: typeof runnerTurnOfReq === 'function' ? runnerTurnOfReq : null,
			turnPhase: turnPhase, stopGeneration: stopGeneration,
			endRunnerLocal: endRunnerLocal, continueStopped: continueStopped, answerAgain: answerAgain,
			runnerRoundTagged: typeof runnerRoundTagged === 'function' ? runnerRoundTagged : function () {},
		};`)(env);
	return { api, env };
}

// ── K-X1: one errand in flight, on chat Y. Chat X is idle and must read so. ──
{
	const { api } = harness();
	const chatY = { id: 'chatY' };
	let abortedY = 0;
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: 'tagY', chat: chatY, stopping: false,
		abort: () => { abortedY++; } };
	check('K-X1: runnerTurnOf(X) is null with only Y in flight', api.runnerTurnOf('chatX') === null);
	check('K-X1: chat X is not an active errand', api.chatIsActiveErrand('chatX') === false);
	check('K-X1: runnerTurnOf(Y) is Y\'s turn', api.runnerTurnOf('chatY') === api.ctx.T1);
	api.setCurrent({ id: 'chatX', messages: [] });
	check('K-X1: idle chat X reads idle', api.turnPhase() === 'idle', api.turnPhase());
	api.stopGeneration();
	check('K-X1: Stop in X does not stop Y', abortedY === 0 && !chatY._aborted && !chatY._stopWhy
		&& api.ctx.T1.stopping === false);
	api.setCurrent({ id: 'chatY', messages: [] });
	check('K-X1: chat Y on screen reads running', api.turnPhase() === 'running', api.turnPhase());
	api.stopGeneration();
	check('K-X1: Stop in Y stops Y as a user Stop', abortedY === 1 && chatY._aborted === true
		&& chatY._stopWhy === 'user' && api.ctx.T1.stopping === true);
}

// ── K-X1: two errands in flight. A lookup by chat names each one's own. ──
{
	const { api } = harness();
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: 'tagY' };
	api.ctx.T2 = { turnId: 'T2', chatId: 'chatZ', tag: 'tagZ' };
	check('K-X1: with two in flight, runnerTurnOf(Y) is Y\'s', api.runnerTurnOf('chatY') === api.ctx.T1);
	check('K-X1: with two in flight, runnerTurnOf(Z) is Z\'s', api.runnerTurnOf('chatZ') === api.ctx.T2);
	check('K-X1: with two in flight, X is still idle', api.runnerTurnOf('chatX') === null);
	const rq = api.runnerTurnOfReq;
	check('K-X1: runnerTurnOfReq names a tagged request\'s turn', !!rq && rq({ turn: 'tagZ' }) === api.ctx.T2);
	check('K-X1: runnerTurnOfReq refuses an untagged request among several', !!rq && rq({}) === null);
	delete api.ctx.T2;
	check('K-X1: runnerTurnOfReq falls back to the one active turn', !!rq && rq({}) === api.ctx.T1);
}

// ── K-R1: the door answers after the errand's turn closed and a Continue started the
//    next turn on the chat. endLocal must leave that turn running. ──
{
	const { api, env } = harness();
	const chat = { id: 'chatY', _generating: true, _turnTag: 'tagNext', messages: [
		{ role: 'end_log', how: 'stopped', why: 'lease_cap', iturn: 'T1' }] };
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: 'tagRun', chat: chat };
	await api.endRunnerLocal(chat, { turnId: 'T1' }, 'user');
	check('K-R1: a later turn on the chat is not killed', env.killed.length === 0, JSON.stringify(env.killed.map((k) => k.why)));
	check('K-R1: nor forced down', chat._generating === true);
	check('K-R1: nor marked as a user Stop', !chat._aborted && !chat._stopWhy);
	check('K-R1: the closed run\'s stopped row is still relabelled', chat.messages[0].why === 'user' && chat.messages[0]._touched === true);
}

// ── K-R1: the run's own turn still closing is ended, as before. ──
{
	const { api, env } = harness();
	const chat = { id: 'chatY', _generating: true, _turnTag: 'tagRun', messages: [] };
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: 'tagRun', chat: chat };
	await api.endRunnerLocal(chat, { turnId: 'T1' }, 'user');
	check('K-R1: the run\'s own turn is killed', env.killed.length === 1 && env.killed[0].why === 'user');
	check('K-R1: and marked as a user Stop', chat._aborted === true && chat._stopWhy === 'user');
	check('K-R1: and forced down', chat._generating === false);
}

// ── K-R1: Continue and Answer again refuse while the chat's errand is in flight. ──
{
	const { api, env } = harness();
	const chat = { id: 'chatY', messages: [{ role: 'end_log', how: 'stopped', why: 'lease_cap', iturn: 'T1' }], app: {} };
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: 'tagRun', chat: chat };
	api.continueStopped(chat, null, true);
	check('K-R1: Continue starts nothing while the errand runs', env.runs.length === 0 && !!chat.app);
	api.answerAgain(chat, 'T0');
	check('K-R1: Answer again retracts nothing while the errand runs', env.retracted.length === 0);
	delete api.ctx.T1;
	api.continueStopped(chat, null, true);
	check('K-R1: Continue runs once the errand is done', env.runs.length === 1 && chat.app === null);
	api.answerAgain(chat, 'T0');
	check('K-R1: Answer again reads the turn once the errand is done', env.retracted.length === 1);
}

// ── L-R1: a gather round of the errand carries the errand's tag, so a kill landing in
//    the round ends it. ──
for (const why of ['lease_cap', 'user']) {
	const { api, env } = harness();
	const chat = { id: 'chatY', _generating: true, _turnTag: 'tagRound0', _busy: 'x', messages: [] };
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: '', chat: chat };
	api.runnerRoundTagged('chatY', 'T1', 'tagRound0', 0);
	check('L-R1: round 0 is tagged by its turnId', api.ctx.T1.tag === 'tagRound0');
	chat._turnTag = 'tagGather';		// the gather round, run as runTurn(c, instruction)
	api.runnerRoundTagged('chatY', '', 'tagGather', 1);
	check('L-R1: the gather round re-tags the run', api.ctx.T1.tag === 'tagGather', api.ctx.T1.tag);
	await api.endRunnerLocal(chat, { turnId: 'T1' }, why);
	check('L-R1: ' + why + ' during gather kills the round', env.killed.length === 1 && env.killed[0].why === why);
	check('L-R1: ' + why + ' during gather forces it down', chat._generating === false && chat._busy === '');
	if (why === 'user') check('L-R1: and labels it a user Stop', chat._aborted === true && chat._stopWhy === 'user');
}

// ── L-R1: only a gather round of the errand's own chat re-tags; a depth-0 turn (a
//    Continue after the run) does not, so K-R1 still spares it. ──
{
	const { api } = harness();
	api.ctx.T1 = { turnId: 'T1', chatId: 'chatY', tag: 'tagRound0' };
	api.runnerRoundTagged('chatY', '', 'tagNext', 0);
	check('L-R1: a depth-0 turn does not re-tag the run', api.ctx.T1.tag === 'tagRound0');
	api.runnerRoundTagged('chatX', '', 'tagX', 1);
	check('L-R1: another chat\'s gather round does not re-tag the run', api.ctx.T1.tag === 'tagRound0');
}

// ── L-R1 wiring: runTurn and runSteer both tag through runnerRoundTagged. ──
{
	const body = (n) => { const d = extractAll(src, n); return d.length ? d[0].text : ''; };
	check('L-R1: runTurn tags every round', /runnerRoundTagged\(chat\.id, opts\.turnId, chat\._turnTag, Workers\.gatherDepth\[chat\.id\]/.test(body('runTurn')));
	check('L-R1: runSteer tags every round', /runnerRoundTagged\(rec\.id, detached && detached\.turnId, steerTurn, depth\)/.test(body('runSteer')));
}

if (failures) { console.log(failures + ' FAILURE(S)'); process.exitCode = 1; }
else console.log('all passed');
