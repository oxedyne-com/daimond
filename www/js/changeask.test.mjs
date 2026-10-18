/* ============================================================
   Test -- a change to a file he made is asked first, with the change shown (UNBLOCK-26 U5).
   ------------------------------------------------------------
   The engine holds the change and calls `DaimondDeletes.change(payload)`, which resolves
   'apply', 'refused' or 'unanswered' (`held_change::Answer::from_word`). Only 'apply'
   writes, so what is proven here is which word each route out of the question gives.

   WHAT IS CHECKED:
     A. A local turn: a Pending tile carrying the change; Apply is 'apply', Don't Change
        'refused', ten minutes or a reload 'unanswered'; the chat's caption says the turn
        waits in Pending and leads there; the autonomous setting answers nothing.
     B. A handed-off turn: asked on the device it came from through the permit route as
        kind `change`; that device's Apply returns 'allow-change' to the runner, which is
        'apply'; its no is 'refused'; silence 'unanswered'.
     C. The tile: folder line, the diff in History's classes, a fold row, the count of
        changed lines cut off, "Cannot compare" for binary, and no discuss control.
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
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 20));
const t = (k, v) => k + (v ? JSON.stringify(v) : '');

const REQ = {
	keeper: 'D1', path: 'notes/plan.md', turn: '', act: 'write', to: '', add: 1, del: 1, more: 0,
	text: true, wait: 600000,
	rows: [{ k: ' ', t: 'a' }, { k: '-', t: 'b' }, { k: '+', t: 'B' }, { k: '~', n: 9 }],
};

/// One device with the change machinery lifted from daimond.js. `rc` is a handed-off turn
/// from PHONE when given; `answer` is what PHONE does with an ask posted to it.
function device(o) {
	const opts = Object.assign({ rc: null, answer: { verdict: 'allow' }, auto: false }, o);
	const parked = Object.create(null), consentWait = Object.create(null);
	const items = [], posted = [], says = [], shown = [];
	const chat = { id: 'C1', diamondId: 'D1', _generating: true, _busy: 'Running write…' };
	const Pending = {
		add(item) { const rec = Object.assign({ id: 'p' + items.length }, item); items.push(rec); return rec.id; },
		fresh() { items.forEach((x) => { if (x.kind === 'consent') x.expired = !parked[x.id]; }); },
		render() {},
		execute(it) { settleConsent(it.id, 'allow'); },
		drop(id) { settleConsent(id, 'deny'); },
	};
	function settleConsent(id, verdict) {
		const go = parked[id]; if (!go) return false; delete parked[id]; go(verdict); return true;
	}
	const Pw = Object.assign(Object.create(P), { CONSENT_DEADLINE_MS: 40, sealForSelf: async (x) => x });
	const Post = { post: async (b) => {
		posted.push(b);
		if (b.t === 'consent-ask' && opts.answer) setTimeout(() => {
			const w = consentWait[b.cid];
			const d = P.blockerAnswerDecision(w, { turnId: b.turnId, cid: b.cid, verdict: opts.answer.verdict,
				kind: b.kind, by: 'PHONE' });
			if (d.commit) { delete consentWait[b.cid]; w.resolve(d.verdict); }
		}, 5);
		return { ok: true };
	} };
	const runnerCtx = opts.rc ? { T1: Object.assign({ turnId: 'T1', eid: 'E1', chatId: 'C1', dispatchedBy: 'PHONE',
		asks: P.PERMIT_ASKS, tag: 'tag1', auto: opts.auto }, opts.rc) } : {};
	const pres = { snapshot: () => ({ PHONE: { lastSeen: Date.now() } }) };
	const src = ['permitRunnerTurn', 'runnerTurnByTag', 'routePermitAsk', 'putPermitAsk', 'refusePermit',
		'tellPermit', 'changeName', 'changeHead', 'changeChat', 'changeWaitMs', 'askChange'].map(lift).join('')
		+ '\nvar CHANGE_WORD = { allow: \'apply\', deny: \'refused\' };'
		+ '\nreturn { askChange: askChange };';
	const f = new Function('DaimondPeer', 'DaimondPost', 'window', 'DaimondPresence', '_consentWait', '_runnerCtx',
		'_openAskForTurn', 'selfDeviceId', 'raiseBlocker', 'clearBlocker', 'trail', 'Pending', '_parked',
		'settleConsent', 'busySay', 't', 'tOr', 'chats', 'diamonds', 'autonomousPosture', 'egressAllowed', src);
	const api = f(Pw, Post, { DaimondPresence: pres }, pres, consentWait, runnerCtx, () => false, () => 'RUNNER',
		async () => true, async () => true, () => {}, Pending, parked, settleConsent,
		(c, w, go) => { c._busy = w; c._busyGo = go === true; says.push([w, go === true]); },
		t, (k, d) => d, [chat], [{ id: 'D1', name: 'Notes' }],
		() => opts.auto, async () => { throw new Error('the permission door was asked'); });
	return { api, items, posted, says, chat, parked, Pending, shown };
}

// ── A. a local turn ──

test('A1: Apply is "apply", Don\'t change is "refused", and the tile carries the change', async () => {
	for (const [press, word] of [['execute', 'apply'], ['drop', 'refused']]) {
		const d = device({});
		const p = d.api.askChange(JSON.stringify(REQ));
		assert.equal(d.items.length, 1);
		const it = d.items[0];
		assert.equal(it.kind, 'consent'); assert.equal(it.priority, 'high');
		assert.equal(it.diamondId, 'D1'); assert.equal(it.diamondName, 'Notes');
		assert.equal(it.change.path, 'notes/plan.md'); assert.equal(it.change.rows.length, 4);
		assert.match(it.headline, /^change\.head.*plan\.md/);
		if (press === 'execute') d.Pending.execute(it); else d.Pending.drop(it.id);
		assert.equal(await p, word, press);
	}
});

test('A2: ten minutes unanswered, or a reload, is "unanswered" and the tile reads expired', async () => {
	const d = device({});
	const p = d.api.askChange(JSON.stringify(Object.assign({}, REQ, { wait: 1000 })));
	assert.equal(await Promise.race([p, settle(1100).then(() => 'still waiting')]), 'unanswered');
	assert.equal(d.items[0].expired, true);
	// The wait is the engine's ten minutes when the payload names none.
	assert.match(lift('changeWaitMs'), /Number\(req && req\.wait\) \|\| 600000/);
	assert.match(lift('askChange'), /var wait = changeWaitMs\(req\)/);
	// A reload: the page that held the promise is gone, so nothing parked survives; a fresh
	// page finds the tile with nobody behind it.
	const r = device({});
	r.api.askChange(JSON.stringify(Object.assign({}, REQ, { wait: 1000 })));
	for (const k in r.parked) delete r.parked[k];
	r.Pending.fresh();
	assert.equal(r.items[0].expired, true);
	// A payload the page cannot read, or none, is never a yes.
	assert.equal(await device({}).api.askChange('{not json'), 'unanswered');
	assert.equal(await device({}).api.askChange(JSON.stringify({ keeper: 'D1' })), 'unanswered');
});

test('A3: the chat says the turn waits in Pending, leads there, and gets its caption back', async () => {
	const d = device({});
	const p = d.api.askChange(JSON.stringify(REQ));
	assert.deepEqual(d.says[0], ['change.waiting{"name":"plan.md"}', true]);
	assert.equal(d.chat._busyGo, true);
	d.Pending.drop(d.items[0].id);
	await p;
	assert.deepEqual(d.says[1], ['Running write…', false]);
	// The caption's press opens Pending, and only a caption marked so is pressable.
	assert.match(lift('openPendingFromCaption'), /DaimondPanels\.show\('pending'\)/);
	assert.match(lift('showSpinner'), /current\._busyGo && current\._busy === words/);
	assert.match(lift('busySay'), /chat\._busyGo = go === true;/);
});

test('A4: the autonomous setting answers nothing, here or handed off', async () => {
	const local = device({ auto: true });
	const p = local.api.askChange(JSON.stringify(REQ));
	const r = await Promise.race([p, settle(60).then(() => 'still waiting')]);
	assert.equal(r, 'still waiting', 'the tile is up and the turn waits on him');
	local.Pending.drop(local.items[0].id);
	assert.equal(await p, 'refused');
	const away = device({ auto: true, rc: {}, answer: null });
	assert.equal(await away.api.askChange(JSON.stringify(Object.assign({}, REQ, { turn: 'tag1', wait: 40 }))), 'unanswered');
	assert.equal(away.posted.filter((b) => b.t === 'consent-ask').length, 1, 'still asked of him');
	// Neither the permission door nor the posture is ever read on this path.
	const src = lift('askChange') + lift('changeChat') + lift('changeHead') + lift('changeName');
	assert.doesNotMatch(src, /egressAllowed|autonomousPosture|\.auto\b/);
});

// ── B. a handed-off turn ──

test('B1: asked on the device it came from as kind change; its Apply returns to the runner', async () => {
	const d = device({ rc: {}, answer: { verdict: 'allow' } });
	const v = await d.api.askChange(JSON.stringify(Object.assign({}, REQ, { turn: 'tag1' })));
	assert.equal(v, 'apply');
	const a = d.posted.filter((b) => b.t === 'consent-ask');
	assert.equal(a.length, 1);
	assert.equal(a[0].kind, 'change'); assert.equal(a[0].target, 'PHONE'); assert.equal(a[0].detail, 'notes/plan.md');
	assert.equal(JSON.parse(a[0].about).rows.length, 4, 'the whole change travels to be drawn there');
	assert.equal(d.items.length, 0, 'the runner raises no tile of its own');
	assert.equal(P.permitOutcome('change', 'allow').word, 'allow-change');
});

test('B2: the other device\'s no is "refused"; silence is "unanswered"', async () => {
	const no = device({ rc: {}, answer: { verdict: 'deny' } });
	assert.equal(await no.api.askChange(JSON.stringify(Object.assign({}, REQ, { turn: 'tag1' }))), 'refused');
	const quiet = device({ rc: {}, answer: null });
	assert.equal(await quiet.api.askChange(JSON.stringify(Object.assign({}, REQ, { turn: 'tag1', wait: 40 }))), 'unanswered');
	// This device's own turn beside it (another tag, or none) is asked here.
	const own = device({ rc: {} });
	const mine = own.api.askChange(JSON.stringify(REQ));
	assert.equal(own.items.length, 1);
	own.Pending.drop(own.items[0].id);
	assert.equal(await mine, 'refused');
});

test('B4: an ask on the other device waits ten minutes like a local one, never the 60 s permit limit', async () => {
	// The lead's decision (r573): the change ask crosses devices on the permit route, whose
	// own wait is CONSENT_DEADLINE_MS (40 ms here, 60 s live). A change waits the engine's
	// ten minutes there too, and silence is still 'unanswered' -- nothing is written.
	for (const req of [REQ, Object.assign({}, REQ, { wait: 0 })]) {
		const d = device({ rc: {}, answer: { verdict: 'allow' } });
		const at = Date.now();
		assert.equal(await d.api.askChange(JSON.stringify(Object.assign({}, req, { turn: 'tag1' }))), 'apply');
		const a = d.posted.filter((b) => b.t === 'consent-ask');
		assert.equal(a.length, 1);
		assert.equal(a[0].wait, 600000, 'the ask says it waits ten minutes');
		assert.ok(a[0].deadline >= at + 600000 && a[0].deadline <= Date.now() + 600000, 'its deadline is ten minutes out');
	}
	// Silence past the change's own wait (not the 40 ms permit limit) is 'unanswered'.
	const quiet = device({ rc: {}, answer: null });
	const t0 = Date.now();
	assert.equal(await quiet.api.askChange(JSON.stringify(Object.assign({}, REQ, { turn: 'tag1', wait: 1200 }))), 'unanswered');
	assert.ok(Date.now() - t0 >= 1100, 'it waited the change\'s wait, not the permit limit');
});

test('B3: the asking device draws the change on its tile; its footer offers no bare Allow', () => {
	assert.ok(P.PERMIT_ASKS.includes('change'));
	const ask = P.makeAsk({ kind: 'change', about: JSON.stringify(REQ), target: 'PHONE', deadline: Date.now() + 60000 });
	assert.equal(ask.kind, 'change');
	assert.equal(P.askRaiseDecision(ask, 'PHONE', Date.now(), { canAnswer: true }).raise, true);
	assert.match(lift('raiseConsentFromPeer'), /ask\.kind === 'change' \? changeAbout\(ask\.about\) : null/);
	const b = P.makeBlocker({ kind: 'change', cid: 'c1', detail: 'notes/plan.md', target: 'PHONE' });
	assert.deepEqual(Array.from(P.blockerTileSpec(b, 'argonaut', 'PHONE').controls), []);
});

// ── C. the tile ──

/// Just enough DOM to draw a tile and read it back.
function el(tag) {
	const e = { tag, className: '', textContent: '', children: [], dataset: {}, style: {}, listeners: {},
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.listeners[k] = f; },
		setAttribute() {}, classList: { toggle() {} } };
	return e;
}
function all(e) { return [e].concat(...e.children.map(all)); }

function drawTile(it) {
	const src = lift('changeName') + lift('changeTile') + '\nreturn changeTile;';
	const calls = [];
	const f = new Function('document', 't', 'tn', 'Pending', src)(
		{ createElement: el }, t, (k, n, v) => k + '.' + (n === 1 ? 'one' : 'other') + JSON.stringify(v),
		{ execute: (x) => calls.push(['execute', x.id]), drop: (id) => calls.push(['drop', id]) });
	const box = el('div');
	f(box, it);
	return { nodes: all(box), calls };
}

test('C1: folder, diff rows in History\'s classes, a fold, the cut-off count, Apply and Don\'t change', () => {
	const it = { id: 'p0', kind: 'consent', headline: 'Change plan.md?',
		change: Object.assign({}, REQ, { more: 37 }) };
	const { nodes, calls } = drawTile(it);
	const by = (c) => nodes.filter((n) => (' ' + n.className + ' ').includes(' ' + c + ' '));
	assert.equal(by('pend-change-in')[0].textContent, 'change.in{"folder":"notes"}');
	const rows = by('hist-diff-line');
	assert.deepEqual(rows.map((r) => r.textContent), ['a', 'b', 'B', 'change.same.other{"n":9}']);
	assert.equal(by('add').length, 1); assert.equal(by('del').length, 1); assert.equal(by('fold').length, 1);
	assert.equal(by('pend-change-more')[0].textContent, 'change.more.other{"n":37}');
	const buttons = nodes.filter((n) => n.tag === 'button');
	assert.deepEqual(buttons.map((b) => b.textContent), ['change.apply', 'change.keep']);
	assert.ok(!nodes.some((n) => n.className.includes('pend-ask')), 'no discuss control');
	buttons[0].listeners.click(); buttons[1].listeners.click();
	assert.deepEqual(calls, [['execute', 'p0'], ['drop', 'p0']]);
});

test('C2: a binary change says it cannot be compared; a move names where to; expired offers only Dismiss', () => {
	const bin = drawTile({ id: 'p1', headline: 'h', change: Object.assign({}, REQ, { text: false, rows: [] }) });
	assert.ok(bin.nodes.some((n) => n.textContent === 'versions.cannot_compare'));
	assert.ok(!bin.nodes.some((n) => n.className === 'hist-diff'));
	const mv = drawTile({ id: 'p2', headline: 'h', change: Object.assign({}, REQ, { act: 'move', to: 'old/plan.md' }) });
	assert.match(mv.nodes.find((n) => n.className.includes('pend-change-in')).textContent,
		/change\.move_to\{"to":"old\/plan\.md"\}/);
	const gone = drawTile({ id: 'p3', headline: 'h', expired: true, change: REQ });
	assert.ok(gone.nodes.some((n) => n.textContent === 'change.expired'));
	assert.deepEqual(gone.nodes.filter((n) => n.tag === 'button').map((b) => b.textContent), ['common.dismiss']);
});
