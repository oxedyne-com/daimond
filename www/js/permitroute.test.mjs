/* ============================================================
   Test -- a handed-off turn's permits are asked at home (CONSENT-ROUTE).
   ------------------------------------------------------------
   A write outside the Diamond (`place`), a toolkit on first use (`toolkit`) and a
   command in the ask mode (`run`) were asked as a dialog on the RUNNER, a machine
   nobody is at. They now go to the device the turn was sent from, and a silence
   there is a refusal, never a park.

   WHAT IS CHECKED:
     A. peer.js's pure rules: where a permit may go (`permitRouteDecision`), the
        engine's word for an answer (`permitOutcome`), which grants are news to the
        asking device (`permitNotice`), the answer rule (`blockerAnswerDecision`, an
        old device's plain consent is a no at once), the raise rule (only the target
        draws it), and that an errand carries what its sender can answer.
     B. daimond.js's `routePermitAsk`, lifted from the tree and run against stubs:
        the yes word per kind, a no, a timeout, an old sender and a sleeping one,
        each refusal told to the sender, and a dispatcher's own run left alone.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const HERE    = dirname(fileURLToPath(import.meta.url));
const PEER    = readFileSync(join(HERE, 'peer.js'), 'utf8');
const DAIMOND = readFileSync(join(HERE, 'daimond.js'), 'utf8');

function loadPeer() {
	const win = {};
	const ctx = vm.createContext({
		window: win, crypto: webcrypto, TextEncoder, TextDecoder, setTimeout, clearTimeout,
		console, Date, Math, JSON, Promise, Uint8Array, ArrayBuffer, atob, btoa,
		localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
	});
	vm.runInContext(PEER, ctx);
	return win.DaimondPeer;
}

function lift(name) {
	let a = DAIMOND.indexOf('\tfunction ' + name + '(');
	if (a < 0) a = DAIMOND.indexOf('\tasync function ' + name + '(');
	const b = DAIMOND.indexOf('\n\t}\n', a);
	assert.ok(a >= 0 && b >= 0, 'daimond.js holds ' + name);
	return DAIMOND.slice(a, b + 3);
}

const P = loadPeer();
// Values made in the vm carry its prototypes, so they are compared as plain data.
const plain = (x) => JSON.parse(JSON.stringify(x));
const same = (a, b, m) => assert.deepEqual(plain(a), b, m);
const NOW = 1_800_000_000_000;

// ── A. the pure rules ──

test('A1: a permit goes to the awake source that can answer it, and only there', () => {
	const route = { action: 'ask', peer: { deviceId: 'PHONE' } };
	for (const k of ['place', 'toolkit', 'run']) {
		same(P.permitRouteDecision(k, route, 'PHONE', ['place', 'toolkit', 'run']),
			{ action: 'ask', target: 'PHONE' });
	}
	// A source that never said it can answer (an older build): refused, unsupported.
	same(P.permitRouteDecision('place', route, 'PHONE', []), { action: 'refuse', why: 'unsupported' });
	assert.equal(P.permitRouteDecision('run', route, 'PHONE', ['place']).why, 'unsupported');
	// The route found another device (the source is asleep), or none: never asked, never park.
	same(P.permitRouteDecision('place', { action: 'ask', peer: { deviceId: 'TABLET' } }, 'PHONE', P.PERMIT_ASKS),
		{ action: 'refuse', why: 'unsupported' });
	assert.equal(P.permitRouteDecision('place', { action: 'park', why: 'no-attended-device' }, 'PHONE', P.PERMIT_ASKS).why, 'unsupported');
	assert.equal(P.permitRouteDecision('web_type', route, 'PHONE', P.PERMIT_ASKS).action, 'refuse');
});

test('A2: the engine hears its own yes word, and every other answer as deny with a reason', () => {
	same(P.permitOutcome('place', 'allow'),   { word: 'allow-place', why: '' });
	same(P.permitOutcome('toolkit', 'allow'), { word: 'allow-kit', why: '' });
	same(P.permitOutcome('run', 'allow'),     { word: 'allow', why: '' });
	same(P.permitOutcome('place', 'deny'),    { word: 'deny', why: 'refused' });
	same(P.permitOutcome('toolkit', null),    { word: 'deny-timeout', why: 'timeout' });
	// The engine reads the reason from the word (tools.rs `permit_of`).
	same(P.permitNoWord('refused'),     'deny');
	same(P.permitNoWord('timeout'),     'deny-timeout');
	same(P.permitNoWord('unsupported'), 'deny-unasked');
	same(P.permitNoWord('whatever'),    'deny');
	same(P.permitOutcome('nope', 'allow'),    { word: 'deny', why: '' });
});

test('A3: only the runner\'s refusal, addressed to this device, is news here', () => {
	const g = (o) => P.makeGrant(Object.assign({ cid: 'c', turnId: 't', kind: 'place', verdict: 'deny',
		choice: 'refused', by: 'RUNNER', to: 'PHONE' }, o));
	assert.equal(P.permitNotice(g({}), 'PHONE'), 'refused');
	assert.equal(P.permitNotice(g({ choice: 'timeout' }), 'PHONE'), 'timeout');
	assert.equal(P.permitNotice(g({ choice: 'unsupported' }), 'PHONE'), 'unsupported');
	assert.equal(P.permitNotice(g({}), 'RUNNER'), '');				// its own copy
	assert.equal(P.permitNotice(g({ to: 'TABLET' }), 'PHONE'), '');		// someone else's
	assert.equal(P.permitNotice(g({ choice: '' }), 'PHONE'), '');		// a person's plain no
	assert.equal(P.permitNotice(g({ kind: 'consent' }), 'PHONE'), '');
	assert.equal(P.permitNotice(g({ verdict: 'allow' }), 'PHONE'), '');
});

test('A4: a permit takes only its own kind; an old device\'s plain consent is a no at once', () => {
	const pend = { turnId: 't1', kind: 'place', target: 'PHONE' };
	const yes = P.blockerAnswerDecision(pend, { turnId: 't1', kind: 'place', verdict: 'allow', by: 'PHONE' });
	assert.equal(yes.commit, true); assert.equal(yes.verdict, 'allow');
	const old = P.blockerAnswerDecision(pend, { turnId: 't1', kind: 'consent', verdict: 'allow', by: 'PHONE' });
	assert.equal(old.commit, true); assert.equal(old.verdict, 'deny'); assert.equal(old.why, 'old-answerer');
	assert.equal(P.blockerAnswerDecision(pend, { turnId: 't1', kind: 'toolkit', verdict: 'allow', by: 'PHONE' }).commit, false);
	assert.equal(P.blockerAnswerDecision(pend, { turnId: 't2', kind: 'place', verdict: 'allow', by: 'PHONE' }).commit, false);
	// A consent is untouched.
	const c = P.blockerAnswerDecision({ turnId: 't1', kind: 'consent' }, { turnId: 't1', kind: 'consent', verdict: 'allow' });
	assert.equal(c.verdict, 'allow');
});

test('A4b: a permit is answered by its target alone, from the tile or the lease footer', () => {
	// The runner: a third device's answer, or one naming no device, drops, at any build and
	// either way, so the question stays open for the device it was asked of.
	for (const kind of P.PERMIT_ASKS) {
		const pend = { turnId: 't1', kind: kind, target: 'PHONE' };
		for (const by of ['TABLET', 'RUNNER', '']) {
			for (const verdict of ['allow', 'deny']) {
				for (const gk of [kind, 'consent']) {
					const d = P.blockerAnswerDecision(pend, { turnId: 't1', kind: gk, verdict: verdict, by: by });
					assert.equal(d.commit, false, kind + '/' + by + '/' + verdict + '/' + gk);
					assert.equal(d.why, 'not-target');
				}
			}
		}
		// A permit wait with no target accepts nobody (fail closed).
		assert.equal(P.blockerAnswerDecision({ turnId: 't1', kind: kind },
			{ turnId: 't1', kind: kind, verdict: 'allow', by: 'PHONE' }).commit, false);
		// The footer: Allow/Deny on the target only; elsewhere a report with no control.
		const b = P.makeBlocker({ kind: kind, cid: 'c1', detail: 'x', target: 'PHONE' });
		assert.equal(b.target, 'PHONE');
		// A change is answered on its Pending tile alone, where the change is drawn (UNBLOCK-26 U5).
		same(P.blockerTileSpec(b, 'argonaut', 'PHONE').controls, kind === 'change' ? [] : ['grant', 'deny']);
		for (const self of ['TABLET', 'RUNNER', '', undefined]) {
			const s = P.blockerTileSpec(b, 'argonaut', self);
			same(s.controls, []); assert.equal(s.answerable, false);
		}
		same(P.blockerTileSpec(P.makeBlocker({ kind: kind, detail: 'x' }), 'argonaut', 'PHONE').controls, []);
	}
	// A consent keeps answering from any device, by or not.
	assert.equal(P.blockerAnswerDecision({ turnId: 't1', kind: 'consent' },
		{ turnId: 't1', kind: 'consent', verdict: 'allow', by: 'TABLET' }).verdict, 'allow');
	same(P.blockerTileSpec(P.makeBlocker({ kind: 'consent', detail: 'x', target: 'PHONE' }), 'n', 'TABLET').controls,
		['grant', 'deny']);
	assert.equal(P.makeBlocker({ kind: 'consent', target: 'PHONE' }).target, undefined);
});

test('A5: a permit is raised only on its target; a consent still broadcasts', () => {
	const ask = P.makeAsk({ turnId: 't', kind: 'place', target: 'PHONE', deadline: NOW + 60000 });
	const o = { canAnswer: true };
	assert.equal(P.askRaiseDecision(ask, 'PHONE', NOW, o).raise, true);
	assert.equal(P.askRaiseDecision(ask, 'RUNNER', NOW, o).why, 'not-target');
	assert.equal(P.askRaiseDecision(ask, 'TABLET', NOW, o).why, 'not-target');
	const c = P.makeAsk({ turnId: 't', tool: 'web_type', target: '', deadline: NOW + 60000 });
	assert.equal(c.kind, 'consent');
	assert.equal(P.askRaiseDecision(c, 'TABLET', NOW, o).raise, true);
});

test('A6: an ask, a blocker and an errand carry what a permit needs', () => {
	const ask = P.makeAsk({ kind: 'toolkit', about: '{"id":"d1","kits":["rust"]}' });
	assert.equal(ask.kind, 'toolkit'); assert.equal(ask.about, '{"id":"d1","kits":["rust"]}');
	assert.equal(P.makeAsk({ kind: 'bogus' }).kind, 'consent');
	const spec = P.blockerTileSpec({ kind: 'place', detail: '/etc/x', about: '{"id":"d1"}', target: 'PHONE' }, 'argonaut', 'PHONE');
	same(spec.controls, ['grant', 'deny']);
	assert.equal(spec.answerable, true);
	const e = P.makeErrand({ turnId: 't', asks: ['run', 'bogus', 'run', 'place'] });
	assert.deepEqual(Array.from(e.asks), ['run', 'place']);
	assert.deepEqual(Array.from(P.makeErrand({ turnId: 't' }).asks), []);
});

// ── B. routePermitAsk, lifted ──

/// A runner with one handed-off turn from PHONE. `answer` is what PHONE does with the
/// ask: { kind, verdict } to answer, or null to stay silent.
function runner(o) {
	const opts = Object.assign({ asks: P.PERMIT_ASKS, awake: true, answer: { kind: 'same', verdict: 'allow' },
		dispatchedBy: 'PHONE', postOk: true, sealOk: true, by: 'PHONE' }, o);
	const posted = [], blockers = [], trails = [], sealed = [];
	const consentWait = Object.create(null);
	const Pw = Object.assign(Object.create(P), { CONSENT_DEADLINE_MS: 40, sealForSelf: async (x) => {
		sealed.push(x);
		if (!opts.sealOk) throw new Error('seal failed');
		return x;
	} });
	const Post = { post: async (b) => {
		posted.push(b);
		if (b.t === 'consent-ask' && opts.answer) setTimeout(() => {
			const w = consentWait[b.cid];
			const d = P.blockerAnswerDecision(w, { turnId: b.turnId, cid: b.cid, verdict: opts.answer.verdict,
				kind: opts.answer.kind === 'same' ? b.kind : opts.answer.kind, by: opts.by });
			if (d.commit) { delete consentWait[b.cid]; w.resolve(d.verdict); }
		}, 5);
		return { ok: opts.postOk };
	} };
	const rc = { turnId: 'T1', eid: 'E1', chatId: 'C1', dispatchedBy: opts.dispatchedBy, asks: opts.asks, tag: 'tag1' };
	const src = lift('permitRunnerTurn') + lift('runnerTurnByTag') + lift('routePermitAsk') + lift('putPermitAsk') + lift('refusePermit') + lift('tellPermit')
		+ '\nreturn { permitRunnerTurn: permitRunnerTurn, routePermitAsk: routePermitAsk };';
	const f = new Function('DaimondPeer', 'DaimondPost', 'window', 'DaimondPresence', '_consentWait', '_runnerCtx',
		'_openAskForTurn', 'selfDeviceId', 'raiseBlocker', 'clearBlocker', 'trail', src);
	const presence = opts.awake ? { PHONE: { lastSeen: Date.now() } } : {};
	const pres = { snapshot: () => presence };
	const api = f(Pw, Post, { DaimondPresence: pres }, pres, consentWait,
		{ T1: rc }, () => false, () => 'RUNNER',
		async (tid, b) => { blockers.push(b); return true; }, async () => { blockers.push(null); return true; },
		(w, d) => trails.push(w + ': ' + d));
	return { api, rc, posted, blockers, trails, sealed };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const grants = (posted) => posted.filter((b) => b.t === 'consent-grant');
const asks   = (posted) => posted.filter((b) => b.t === 'consent-ask');

test('B1: a yes comes back as the kind\'s own word; the ask is targeted and blocked on the lease', async () => {
	for (const [k, word] of [['place', 'allow-place'], ['toolkit', 'allow-kit'], ['run', 'allow']]) {
		const r = runner({});
		const v = await r.api.routePermitAsk(r.rc, k, 'shown', '{"id":"d1"}');
		await settle();
		assert.equal(v, word, k);
		const a = asks(r.posted);
		assert.equal(a.length, 1); assert.equal(a[0].kind, k); assert.equal(a[0].target, 'PHONE');
		assert.equal(a[0].dispatchedBy, 'RUNNER'); assert.equal(a[0].about, '{"id":"d1"}');
		assert.equal(r.blockers[0].kind, k); assert.equal(r.blockers[1], null);
		assert.equal(grants(r.posted).length, 0, 'a yes needs no notice');
	}
});

test('B2: a no is deny, and the sender is told "refused"', async () => {
	const r = runner({ answer: { kind: 'same', verdict: 'deny' } });
	assert.equal(await r.api.routePermitAsk(r.rc, 'place', '/x', '{}'), 'deny');
	await settle();
	const g = grants(r.posted);
	assert.equal(g.length, 1); assert.equal(g[0].choice, 'refused'); assert.equal(g[0].to, 'PHONE');
	assert.equal(g[0].kind, 'place'); assert.equal(g[0].verdict, 'deny');
});

test('B3: silence is a refusal at the unchanged deadline, told "timeout", never a park', async () => {
	const r = runner({ answer: null });
	// The engine's word names the reason too, so the model is not told the user said no.
	assert.equal(await r.api.routePermitAsk(r.rc, 'run', 'ls', '{}'), 'deny-timeout');
	await settle();
	assert.equal(grants(r.posted)[0].choice, 'timeout');
	// A permit with no wait of its own (place, toolkit, run) keeps the 60 s; only a change
	// passes its ten minutes (r573, changeask.test B4).
	assert.match(lift('putPermitAsk'), /var wait = \(Number\(waitMs\) > 0\) \? Number\(waitMs\) : \(DaimondPeer\.CONSENT_DEADLINE_MS \|\| 60000\);/);
	assert.doesNotMatch(lift('putPermitAsk'), /parkRunnerTurn/);
});

test('B4: an old device\'s plain consent "yes" is a no', async () => {
	const r = runner({ answer: { kind: 'consent', verdict: 'allow' } });
	assert.equal(await r.api.routePermitAsk(r.rc, 'toolkit', 'cargo build', '{}'), 'deny');
});

test('B4b: a third device\'s Allow, from its footer or anywhere, lets nothing through', async () => {
	for (const k of P.PERMIT_ASKS) {
		const r = runner({ by: 'TABLET' });
		assert.equal(await r.api.routePermitAsk(r.rc, k, 'shown', '{}'), 'deny-timeout', k);
		await settle();
		assert.equal(grants(r.posted)[0].choice, 'timeout', 'the question waited for PHONE, untaken');
		assert.equal(r.blockers[0].target, 'PHONE');
	}
});

test('B5: an old sender is not asked at all: "unsupported", at once', async () => {
	const r = runner({ asks: [] });
	assert.equal(await r.api.routePermitAsk(r.rc, 'place', '/x', '{}'), 'deny-unasked');
	await settle();
	assert.equal(asks(r.posted).length, 0);
	assert.equal(grants(r.posted)[0].choice, 'unsupported');
	assert.ok(r.trails.some((s) => s.includes('could not ask on your other device')));
});

test('B6: a sleeping sender is not asked: "could not ask", at once, never "timeout" (B-F3)', async () => {
	const r = runner({ awake: false });
	assert.equal(await r.api.routePermitAsk(r.rc, 'place', '/x', '{}'), 'deny-unasked');
	await settle();
	assert.equal(asks(r.posted).length, 0);
	assert.equal(grants(r.posted)[0].choice, 'unsupported');
});

test('B6b: an ask that could not be sealed or posted was never asked: "could not ask", never "timeout"', async () => {
	// Lead ruling (10 Oct, rc-a's condition): A is told the truth. Nobody was asked, so
	// nobody failed to answer in time.
	for (const o of [{ postOk: false }, { sealOk: false }]) {
		const r = runner(o);
		assert.equal(await r.api.routePermitAsk(r.rc, 'run', 'ls', '{}'), 'deny-unasked', JSON.stringify(o));
		await settle();
		// What was put to the sender, sealed or not: a failed seal loses the notice too.
		const g = grants(r.sealed);
		assert.equal(g.length, 1, JSON.stringify(o));
		assert.equal(g[0].choice, 'unsupported', JSON.stringify(o));
		assert.ok(r.trails.some((s) => s.includes('could not ask on your other device')), JSON.stringify(o));
		assert.ok(!r.trails.some((s) => s.includes('did not answer in time')), JSON.stringify(o));
	}
});

test('B7: the dispatcher\'s own run, and a turn nobody sent, keep their local dialog', () => {
	const own = { turn: 'tag1' };
	assert.equal(runner({ dispatchedBy: 'RUNNER' }).api.permitRunnerTurn(own), null);
	assert.equal(runner({ dispatchedBy: '' }).api.permitRunnerTurn(own), null);
	assert.ok(runner({}).api.permitRunnerTurn(own));
});

test('F1: the asking turn is the one the question\'s tag names; this device\'s own turn beside it is local', () => {
	const r = runner({});
	assert.equal(r.api.permitRunnerTurn({ turn: 'tag1' }), r.rc);
	assert.equal(r.api.permitRunnerTurn({ turn: 'other' }), null, 'another turn of the same Diamond');
	assert.equal(r.api.permitRunnerTurn({ turn: '' }), null, 'an untagged question');
	assert.equal(r.api.permitRunnerTurn({}), null);
});

test('F5: two permits of one turn are asked one after the other, the second when the first settles', async () => {
	const r = runner({});
	const both = await Promise.all([
		r.api.routePermitAsk(r.rc, 'place', '/a', '{}'),
		r.api.routePermitAsk(r.rc, 'place', '/b', '{}'),
	]);
	assert.deepEqual(both, ['allow-place', 'allow-place']);
	assert.equal(asks(r.posted).length, 2, 'both were put to the sender');
	// Raise, clear, raise, clear: never two questions up at once.
	assert.deepEqual(r.blockers.map((b) => (b ? b.detail : null)), ['/a', null, '/b', null]);
});

test('B8: each egress branch routes a handed-off turn before its own dialog, B\'s own grants first', () => {
	const eg = lift('egressAllowed');
	const at = (s) => { const i = eg.indexOf(s); assert.ok(i >= 0, s); return i; };
	assert.ok(at("routePermitAsk(rrc, 'run'") < at('var okRun = await confirmDialog('));
	assert.ok(at("if (kwant.every(") < at("routePermitAsk(krc, 'toolkit'"));
	assert.ok(at("routePermitAsk(krc, 'toolkit'") < at("ask: 'toolkit',"));
	assert.ok(at('markForce(pd.id, pl)') < at("routePermitAsk(prc, 'place'"));
	assert.ok(at("routePermitAsk(prc, 'place'") < at("ask: 'place',"));
	// A place yes writes nothing on either device: no grantHoldHere on the routed path.
	assert.doesNotMatch(lift('answerPermitHere'), /grantHoldHere|confirmMarkHere|add_link/);
	assert.match(lift('answerPermitHere'), /kind !== 'toolkit' \|\| verdict !== 'allow'/);
});

test('A9: a third device\'s grant does not take a permit question down on the device it was asked of', () => {
	const ask = { cid: 'c1', turnId: 't1', kind: 'place', target: 'HOME', dispatchedBy: 'RUNNER' };
	assert.equal(P.grantSettlesAsk(ask, { cid: 'c1', by: 'TABLET', verdict: 'allow', kind: 'place' }), false);
	assert.equal(P.grantSettlesAsk(ask, { cid: 'c1', by: '', verdict: 'allow', kind: 'place' }), false);
	assert.equal(P.grantSettlesAsk(ask, { cid: 'c1', by: 'HOME', verdict: 'deny', kind: 'place' }), true);	// its own answer, from another tab
	assert.equal(P.grantSettlesAsk(ask, { cid: 'c1', by: 'RUNNER', verdict: 'deny', choice: 'timeout', kind: 'place' }), true);
	// A plain consent keeps the broadcast rule: the first device to answer settles it everywhere.
	assert.equal(P.grantSettlesAsk({ cid: 'c2', kind: 'consent', dispatchedBy: 'RUNNER' }, { cid: 'c2', by: 'TABLET' }), true);
	assert.equal(P.grantSettlesAsk(null, { cid: 'c3', by: 'TABLET' }), true);
});

test('B9: adoptRemoteGrant asks the settle rule before it takes a tile down or marks a cid resolved', () => {
	const ad = lift('adoptRemoteGrant');
	const i = ad.indexOf('DaimondPeer.grantSettlesAsk(');
	assert.ok(i >= 0);
	assert.ok(i < ad.indexOf('_askResolved[cid] = true'));
	assert.ok(i < ad.indexOf('Pending.dismiss('));
});

test('B10: a refused permit\'s Retry sends the turn the way a send goes, so it is asked here again', () => {
	assert.match(lift('permitRetry'), /retryTurn\(chat, id, text\)/);
	const rt = lift('retryTurn');
	// Every routed Retry, a daimon's too (R3 3c, 7c939256): the hand-off first; one the hand-off
	// declines is asked again here through askAgain (runSteer for a daimon), as its send would be.
	assert.ok(rt.indexOf('return retryRouted(chat, text, nmid, lost, ropts && ropts.onStart, ropts ? ropts.drawn : undefined);') >= 0);	// every Retry is routed (UNBLOCK-1 QFOLLOW)
	// A refused permit's Retry is not a lost run's: it runs unfenced, as a send that stayed here;
	// a lost run's is fenced for a chat and a daimon alike (SUHT-R F2).
	assert.match(lift('retryRouted'), /if \(lost\) return runRetryHere\(chat, text, nmid\);[\s\S]*return askAgain\(chat, text, \{ person: true, mid: nmid, onStart: onStart \}\);/);
	assert.match(lift('retryRouted'), /if \(await maybeAutoDispatch\(chat, text, '', nmid, undefined, drawn\)\) return true;/);
	assert.match(lift('maybeAutoDispatch'), /var umid = mid \|\| newMid\(\);/);
});
