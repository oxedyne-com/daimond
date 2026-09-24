// verify_typedpause.mjs — a paused Diamond refuses a TYPED TURN alike, whichever key
// it runs on.
//
// The gap this closes (`~/usr/code/ai/claude/notes/daimond_delta_recheck_20260924/`,
// `typed_turn_control.mjs`): a turn typed into a Diamond after a real "Pause all", or
// the Diamond paused on its own, used to be refused only on the gateway's own key —
// the mint is where the pause was checked, and a turn on the person's own key never
// mints, so it reached the provider regardless. The fix moves the check to dispatch,
// once, in `runTurn`, ahead of either key's own path — see `chatSpendNode` and
// `DaimondModels.held`/`pauseError` in www/js/daimond.js.
//
// TWO SEPARATE SESSIONS, each a fresh account/profile, so neither's "on a fresh
// account" half owes anything to state the other left behind:
//
//   BYO      connectMock only — no sign-in, exactly as a person who has never made
//            an account and just pasted a key runs. `typed_turn_control.mjs`'s path.
//   GATEWAY  signed in, `/api` fully stubbed (account, mint, provider) the way
//            `verify_pausespend.mjs` already does — the gateway itself is not run.
//
// Each proves the same four things, so the two answers can be read side by side:
//   1. a typed turn on a Diamond paused BEFORE it is sent reaches no provider,
//   2. the refusal is on screen, in the transcript, naming why,
//   3. that refusal is the SAME sentence `DaimondModels.pauseError` gives the
//      credits path — the two doors were fixed to ask one question, not two,
//   4. the SAME Diamond, played, DOES reach the provider on its very next turn —
//      the only way (1) is evidence of a refusal and not of a turn that never ran.
//   and, since the R2 QA of 2026-09-24, that it names the Diamond rather than a node id
//   (F0b).
//
// The BYO session then takes the other ways a held Diamond's work leaves the page
// (`~/usr/code/ai/claude/specs/daimond_r2_qa_20260924.md`):
//
//   F3  a WORKER for a Diamond held by hand starts nothing on the own key, where only
//       the credits mint used to ask;
//   F2  a typed turn is not HANDED to another device when one is elected, the hand-off
//       door itself refuses a held turn, and a RUNNER refuses an errand whose own pause
//       snapshot holds its Diamond although its own copy of the set says play.
//
// A third session, DEFAULTS, is a fresh account with the two default Diamonds (F0):
//
//   G   the Optimiser is seeded with its action held and its own conversation NOT, so a
//       person's typed turn reaches the provider; held by hand, it is refused by name;
//   H   an account an earlier build seeded with `self` held (`seedPaused`, the call that
//       build made) is repaired on its next boot, its action still held -- once, and never
//       over a person's Pause all.
//
//   eval "$(bash dev/world.sh N --env)"
//   node dev/verify_typedpause.mjs
import { open, signInAs, connectMock, scratch, mockLog, MOCK } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Make a Diamond through the dialog a person uses, and answer with the id it was
/// actually given — `create_diamond` names none of this dialog's callers, so the id
/// is read back off the rail by the name just typed (the same idiom `verify_diamonds.mjs`
/// uses, over the same `data-id` the widget's own pause controls read).
async function createDiamond(page, name) {
	const drawer = page.locator('#admin-close');
	if (await drawer.isVisible().catch(() => false)) {
		await drawer.click({ force: true });
		await page.waitForTimeout(300);
	}
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForSelector('#chat-input', { timeout: 15000 });
	await page.waitForTimeout(400);
	// A fresh Diamond opens on its crystal face, not its chat thread — `daimonOnScreen`
	// is false there, so a turn's own error line would be pushed into the record but
	// never drawn. The chat face is where a person actually watches a typed turn go,
	// so that is the face this file drives it from too.
	const chatTab = page.locator('#dview-chat');
	if (await chatTab.count()) { await chatTab.click({ force: true }); await page.waitForTimeout(500); }
	let id = '';
	for (let i = 0; i < 20 && !id; i++) {
		id = await page.evaluate((nm) => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find((x) => {
					const n = x.querySelector('.session-box-name');
					return n && n.textContent.trim() === nm;
				});
			return b ? b.dataset.id : '';
		}, name);
		if (!id) await page.waitForTimeout(300);
	}
	return id;
}

const spendNode = (page, id) =>
	page.evaluate((i) => window.DaimondPause.id('root', 'diamonds', i, 'self'), id);
const setPaused = (page, node, playing) =>
	page.evaluate(({ n, p }) => window.DaimondPause.set(n, p), { n: node, p: playing });

/// The last refusal line on screen, or '' when none is there. A pause's refusal is said in
/// the app's neutral voice and an error in the danger colour (`appendFailure`, R3 QA Q6-3),
/// so both registers are read; `verify_q6` holds which one a refusal is drawn in.
const lastRefusal = (page) => page.evaluate(() => {
	const rows = [...document.querySelectorAll('.chat-msg-error .chat-msg-content, .chat-msg-compacted .chat-msg-content')];
	return rows.length ? rows[rows.length - 1].textContent : '';
});

/// The wording `DaimondModels.pauseError` gives for this node, asked directly — the
/// standard the transcript's own wording is measured against below.
const pauseWording = (page, node) => page.evaluate((n) => {
	const e = window.DaimondModels.pauseError(n);
	return String(e && e.message || e);
}, node);

async function typedTurnRefusesAlike(label, session, node, id, name) {
	const { page } = session;
	await setPaused(page, node, false);					// a real "Pause all" of this leaf
	await page.waitForTimeout(400);
	const before = mockLog().length;
	await page.fill('#chat-input', label + ' turn while paused ' + Date.now());
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(6000);
	const requests = mockLog().length - before;
	check(label + ': a typed turn on a paused Diamond reaches no provider',
		requests === 0, 'requests=' + requests);

	const refusal = await lastRefusal(page);
	const wording = await pauseWording(page, node);
	check(label + ': the refusal is on screen, in the transcript',
		/paused/i.test(refusal), JSON.stringify(refusal));
	// Case-insensitively: the transcript's copy of it went through `friendlyError`,
	// which capitalises the leading letter for display (see its own header comment);
	// `pauseError` is asked directly here and is not. Same sentence, same source.
	check(label + ': it is the SAME sentence the gateway path throws',
		!!wording && refusal.toLowerCase() === wording.toLowerCase(),
		JSON.stringify({ refusal, wording }));
	// F0b: `pauseError` filled `{node}` with the id, so the person read
	// "Root/diamonds/<hex>/self is paused" and the check above, comparing the sentence
	// with itself, could not see it.
	check(label + ': it names the Diamond, not an internal node id',
		refusal.includes(name) && !/root\//i.test(refusal), JSON.stringify(refusal));

	await setPaused(page, node, true);						// play it
	await page.waitForTimeout(400);
	const before2 = mockLog().length;
	await page.fill('#chat-input', label + ' turn after play ' + Date.now());
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(8000);
	const requests2 = mockLog().length - before2;
	check(label + ': the SAME Diamond, played, DOES reach the provider',
		requests2 > 0, 'requests=' + requests2);
}

/// F3: a worker for a Diamond held by hand starts nothing, on the own key.
async function workerHeld(page, id, node) {
	const dispatch = (task) => page.evaluate(({ i, t }) => {
		window.DaimondWorkers.dispatch(i, 'Typed pause BYO', [{ name: 'tp-w', task: t }], false, null, 0, null);
		return true;
	}, { i: id, t: task });
	const lastRun = () => page.evaluate(() => {
		const r = (window.DaimondWorkers.runs || []).filter((x) => x.name === 'tp-w').pop();
		return r ? { status: r.status, text: String(r.text || '') } : null;
	});
	await setPaused(page, node, false);
	await page.waitForTimeout(400);
	const before = mockLog().length;
	await dispatch('Reply with the word OK. ' + Date.now());
	await page.waitForTimeout(6000);
	const held = mockLog().length - before;
	const run = await lastRun();
	check('F3: a worker for a Diamond held by hand reaches no provider on the own key',
		held === 0, 'requests=' + held + ' run=' + JSON.stringify(run));
	check('F3: and the run is held, named for the Diamond, not failed',
		!!run && run.status === 'paused' && run.text.includes('Typed pause BYO') && !/root\//i.test(run.text),
		JSON.stringify(run));
	await setPaused(page, node, true);
	await page.waitForTimeout(400);
	const before2 = mockLog().length;
	await dispatch('Reply with the word OK. ' + Date.now());
	await page.waitForTimeout(9000);
	const played = mockLog().length - before2;
	check('F3: played, the same worker does reach the provider', played > 0,
		'requests=' + played + ' run=' + JSON.stringify(await lastRun()));
}

/// F2, the sending side: a peer is elected and the post box answers, both stubbed so an
/// errand is caught here rather than delivered.
async function handoffHeld(page, id, node) {
	await page.evaluate(() => {
		window.__tp = { posted: [], decide: window.DaimondPeer.autoDispatchDecision, post: window.DaimondPost.post };
		window.DaimondPeer.autoDispatchDecision = function () {
			return { dispatch: true, reason: 'typedpause', peer: { deviceId: 'feedfacefeedface', label: 'tp-desktop' } };
		};
		window.DaimondPost.post = async function (b) { window.__tp.posted.push(b); return { ok: true }; };
	});
	const posted = () => page.evaluate(() => window.__tp.posted.length);
	try {
		await setPaused(page, node, false);
		await page.waitForTimeout(400);
		const before = mockLog().length;
		await page.fill('#chat-input', 'handed off while held ' + Date.now());
		await page.click('#chat-send', { force: true });
		await page.waitForTimeout(5000);
		const sent = await posted();
		const reqs = mockLog().length - before;
		check('F2: a typed turn in a Diamond held by hand is not handed to another device',
			sent === 0, 'errands posted: ' + sent + ', provider requests here: ' + reqs);
		const refusal = await lastRefusal(page);
		check('F2: it is refused here instead, in the person\'s words, spending nothing',
			reqs === 0 && /paused/i.test(refusal) && refusal.includes('Typed pause BYO'), JSON.stringify(refusal));
		// The door itself, asked directly: every hand-off passes it, so it refuses whoever
		// calls it, before marking or posting anything.
		const door = await page.evaluate(async (i) => {
			const chat = window.DaimondDiamond.conversation(i);
			const n = (chat.messages || []).length;
			const r = await window.__daimondDispatchToPeer(chat, 'tp-door-' + Date.now(), 'door', []);
			return { r, marked: (chat.messages || []).length - n, posted: window.__tp.posted.length };
		}, id);
		check('F2: the hand-off door refuses a held turn, marking and posting nothing',
			door.r && door.r.ok === false && door.r.paused === true && door.marked === 0 && door.posted === 0,
			JSON.stringify(door));
		// Control: played, the same stubs carry the turn away, so the silence above was the pause.
		await setPaused(page, node, true);
		await page.waitForTimeout(400);
		await page.fill('#chat-input', 'handed off when played ' + Date.now());
		await page.click('#chat-send', { force: true });
		await page.waitForTimeout(5000);
		check('F2: played, the stubbed election does hand the turn off', (await posted()) > 0,
			'errands posted: ' + (await posted()));
	} finally {
		await page.evaluate(() => {
			window.DaimondPeer.autoDispatchDecision = window.__tp.decide;
			window.DaimondPost.post = window.__tp.post;
		});
	}
}

/// F2, the running side: an errand from another device of this account, sealed as a
/// dispatch seals it, whose own pause snapshot holds the Diamond -- the parcel that would
/// tell this device follows the errand -- while this device's set still says play.
async function runnerHeld(page, id, node) {
	const run = (holdIt) => page.evaluate(async ({ i, n, holdIt }) => {
		const P = window.DaimondPeer;
		const posted = [];
		const orig = window.DaimondPost.post;
		window.DaimondPost.post = async (b) => { posted.push(b); return { ok: true }; };
		try {
			const chat = window.DaimondDiamond.conversation(i);
			const snap = window.DaimondPause.snapshot();
			// Held by the sender after this device last heard: the same set, the node held,
			// a stamp one later. Not held: no snapshot at all.
			const pause = holdIt
				? { paused: snap.paused.concat([n]).sort(), stamp: (snap.stamp || 0) + 1 } : null;
			// Shaped as a turn id is (`newMid`): its base-36 prefix is the turn's birth, which
			// the age rule reads before anything else is asked.
			const tid = Date.now().toString(36) + '-tprun' + (holdIt ? 'h' : 'f');
			const plan = P.buildDispatch(chat, { turnId: tid, diamondId: i, prompt: 'from another device',
				model: { provider: chat.provider || '', model: chat.model || '', url: '' },
				scope: [], pause, dispatchedBy: 'feedfacefeedface', parkCount: 0 });
			const body = await P.sealForSelf(plan.errand(0));
			const obj = await P.peek(body.envelope);
			const res = await P.absorb(obj, { ts: Math.floor(Date.now() / 1000), seq: 1 });
			const reports = [];
			for (const b of posted) {
				try { const o = await P.peek(b.envelope); if (o && o.t === 'report') reports.push(o); } catch (e) {}
			}
			return { res: res && res.result, reports: reports.map((r) => ({ status: r.status, why: r.why })),
				heldHere: window.DaimondPause.isPaused(n) };
		} catch (e) {
			return { threw: String(e && e.message || e) };
		} finally {
			window.DaimondPost.post = orig;
		}
	}, { i: id, n: node, holdIt });
	const before = mockLog().length;
	const held = await run(true);
	const reqs = mockLog().length - before;
	check('F2: a runner refuses an errand whose own pause snapshot holds its Diamond',
		!!held.res && held.res.ran === false && held.res.why === 'paused' && reqs === 0,
		JSON.stringify(held) + ' requests=' + reqs);
	check('F2: and sends home an error report naming the Diamond',
		!!held.reports && held.reports.some((r) => r.status === 'error' && /Typed pause BYO/.test(r.why || '')),
		JSON.stringify(held.reports));
	check('F2: having taken the sender\'s newer hold for its own, as the parcel would',
		held.heldHere === true, JSON.stringify(held.heldHere));
	await setPaused(page, node, true);
	await page.waitForTimeout(400);
	const free = await run(false);
	// Past the pause it goes on to the lease, which a world with no gateway cannot take:
	// a stand-down or a throw there is still past the gate this measures.
	check('F2: played here and in the errand, the runner does not refuse it for a pause',
		!(free.res && free.res.why === 'paused') && !(free.reports || []).some((r) => /paused/i.test(r.why || '')),
		JSON.stringify(free).slice(0, 300));
}

// ── BYO: the own-key path, no account at all ──────────────────────
{
	const s = await open({
		name: 'typedpause-byo', defaults: false,
		profile: scratch('pw', 'typedpause-byo-' + process.pid),
	});
	const { page } = s;
	for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
		await page.keyboard.press('Escape').catch(() => {});
		await sleep(1500);
		await connectMock(s);
	}
	await page.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause),
		null, { timeout: 30000 });
	await sleep(1500);
	const id = await createDiamond(page, 'Typed pause BYO');
	check('BYO: the Diamond was created', !!id, 'id=' + JSON.stringify(id));
	if (id) {
		const node = await spendNode(page, id);
		await typedTurnRefusesAlike('BYO (own key)', s, node, id, 'Typed pause BYO');

		// QA-1's own distinction: a Diamond merely HELD by automation -- a seeded
		// trigger's leaf paused, `heldByHand` false for the Diamond as a whole --
		// must not refuse a person's typed turn. `isPaused` reads a leaf's OWN
		// flag and nothing under it, so holding an unrelated trigger leaf must
		// leave `self` exactly as it was.
		const triggerLeaf = await page.evaluate((i) =>
			window.DaimondPause.id('root', 'diamonds', i, 'triggers', 'seeded-1'), id);
		await setPaused(page, triggerLeaf, false);				// hold the trigger, not the Diamond
		const stillFree = await page.evaluate((n) => !window.DaimondPause.isPaused(n), node);
		check('QA-1: a trigger held elsewhere does not pause the Diamond itself', stillFree);
		const before3 = mockLog().length;
		await page.fill('#chat-input', 'typed turn beside a held trigger ' + Date.now());
		await page.click('#chat-send', { force: true });
		await page.waitForTimeout(8000);
		const requests3 = mockLog().length - before3;
		check('QA-1: and a typed turn beside it still reaches the provider',
			requests3 > 0, 'requests=' + requests3);
		await setPaused(page, triggerLeaf, true);

		await workerHeld(page, id, node);
		await handoffHeld(page, id, node);
		await runnerHeld(page, id, node);
	}
	await s.close();
}

// ── GATEWAY: the credits path, /api fully stubbed, gateway not run ──
{
	const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
	const json = (body, status = 200) => ({
		status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
	});
	const OR_BASE = 'https://openrouter.ai/api/v1';
	const OR_URL  = `${OR_BASE}/chat/completions`;
	let mints = [];

	const s = await open({
		name: 'typedpause-gw',
		profile: scratch('pw', 'typedpause-gw-' + process.pid),
		signIn: false, connect: false,
	});
	const { page } = s;
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({
		ok: true, challenge: 'chal-typedpause', challenge_id: 'cid-typedpause' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({
		ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({
		ok: true, licence: true, held: true, currency: 'usd' })));
	await page.route('**/api/inference-key', (r) => {
		let slot = 0;
		try { slot = (JSON.parse(r.request().postData() || '{}').slot) | 0; } catch (e) { slot = 0; }
		mints.push(slot);
		return r.fulfill(json({
			ok: true, key: `sk-or-v1-SLOT${slot}-typedpausemarker0000000000000000000`,
			url: OR_BASE, limit_minor: 200, credits_minor: 5000, currency: 'usd',
		}));
	});
	await page.route(`${OR_BASE}/models`,
		r => r.fulfill(json({ data: [{ id: 'anthropic/claude-opus-4.5' }] })));
	// Proxied to the SAME mock the BYO half used, so `mockLog()` counts both alike.
	await page.route(OR_URL, async (r) => {
		const sent = r.request().postData() || '';
		const res  = await fetch(MOCK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent });
		const body = await res.text();
		return r.fulfill({ status: res.status, headers: CORS, body,
			contentType: res.headers.get('content-type') || 'application/json' });
	});

	await signInAs(s, 'typedpausegw');
	await page.waitForTimeout(2500);		// unlock → bootstrap → mint slot 0 → catalogue
	await page.evaluate(() => window.DaimondModels.setDefault('credits', 'anthropic/claude-opus-4.5'));
	check('gateway key: the account minted on unlock', mints.includes(0),
		'mints=' + JSON.stringify(mints));

	const id = await createDiamond(page, 'Typed pause GW');
	check('gateway key: the Diamond was created', !!id, 'id=' + JSON.stringify(id));
	if (id) {
		const node = await spendNode(page, id);
		await typedTurnRefusesAlike('gateway key', s, node, id, 'Typed pause GW');
	}
	await s.close();
}

// ── DEFAULTS: a fresh account with the two default Diamonds (F0) ────
{
	const OPT = '0da1000000f2';
	const s = await open({
		name: 'typedpause-defaults',
		profile: scratch('pw', 'typedpause-defaults-' + process.pid),
		connect: false,
	});
	const { page } = s;
	for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
		await page.keyboard.press('Escape').catch(() => {});
		await sleep(1500);
		await connectMock(s);
	}
	const boot = async () => {
		await page.waitForFunction(() => !!(window.DaimondCore && window.DaimondPause), null, { timeout: 60000 });
		for (let i = 0; i < 60; i++) {
			if (await page.evaluate((o) => !!document.querySelector(`#diamond-list .diamond-box[data-id="${o}"]`), OPT)) break;
			await sleep(500);
		}
		await sleep(1500);
	};
	const leaves = () => page.evaluate((o) => {
		const base = window.DaimondPause.id('root', 'diamonds', o);
		return { self: window.DaimondPause.isPaused(base + '/self'),
			held: window.DaimondPause.pausedIds().filter((k) => k.indexOf(base + '/') === 0) };
	}, OPT);
	const typeInto = async (text) => {
		await page.evaluate((o) => {
			const b = document.querySelector(`#diamond-list .diamond-box[data-id="${o}"]`);
			if (b) b.click();
		}, OPT);
		await sleep(1200);
		const tab = page.locator('#dview-chat');
		if (await tab.count()) { await tab.click({ force: true }); await sleep(600); }
		const before = mockLog().length;
		await page.fill('#chat-input', text + ' ' + Date.now());
		await page.click('#chat-send', { force: true });
		await sleep(7000);
		return mockLog().length - before;
	};
	const selfNode = 'root/diamonds/' + OPT + '/self';
	const reload = async () => {
		await page.reload({ waitUntil: 'domcontentloaded' });
		await boot();
	};
	// The repair waits for the session's first pull, and this world has an identity and no
	// gateway, so it goes ahead when that wait runs out (`afterFirstPull`, FU QA FA).
	const repaired = async () => {
		for (let i = 0; i < 70; i++) {
			if (await page.evaluate(() => localStorage.getItem('daimond-default-self-played') === '1')) return true;
			await sleep(500);
		}
		return false;
	};

	await boot();
	const L0 = await leaves();
	check('G0: the Optimiser is seeded with its action held and its own conversation not',
		!L0.self && L0.held.some((k) => /\/triggers\//.test(k)), JSON.stringify(L0));
	const g1 = await typeInto('what can you optimise?');
	check('G1: a person\'s typed turn in the Optimiser on a fresh account reaches the provider',
		g1 > 0, 'requests=' + g1);

	await setPaused(page, selfNode, false);
	await sleep(500);
	const g2 = await typeInto('held by hand');
	const refusal = await lastRefusal(page);
	check('G2: held by hand, the typed turn reaches no provider', g2 === 0, 'requests=' + g2);
	check('G2: and the refusal names the Diamond, not an internal node id',
		/Daimond Optimiser/.test(refusal) && !/root\//i.test(refusal), JSON.stringify(refusal));

	// H: the state an earlier build left -- `self` seeded held beside the action, by the
	// very call it made -- and no record yet of the repair.
	await setPaused(page, selfNode, true);
	await page.evaluate((n) => {
		localStorage.removeItem('daimond-default-self-played');
		window.DaimondPause.seedPaused(n);
	}, selfNode);
	const H0 = await leaves();
	check('H0: seeded as the earlier build seeded it: self and the action held',
		H0.self && H0.held.length >= 2, JSON.stringify(H0));
	await reload();
	await repaired();
	const H1 = await leaves();
	check('H1: on the next boot the Optimiser\'s own conversation is played', !H1.self, JSON.stringify(H1));
	check('H2: and its action is still held', H1.held.some((k) => /\/triggers\//.test(k)), JSON.stringify(H1));
	const h3 = await typeInto('after the repair');
	check('H3: and a typed turn in it reaches the provider', h3 > 0, 'requests=' + h3);

	// Once per account: a person's own hold on it afterwards stands across a boot.
	await setPaused(page, selfNode, false);
	await reload();
	check('H4: the repair runs once -- a hold pressed afterwards survives the next boot',
		(await leaves()).self === true, JSON.stringify(await leaves()));

	// And never over a person's Pause all, which holds `self` as theirs.
	await setPaused(page, 'root', false);
	await page.evaluate(() => localStorage.removeItem('daimond-default-self-played'));
	await reload();
	await repaired();
	const H5 = await leaves();
	check('H5: under a person\'s Pause all the repair leaves the conversation held',
		H5.self === true && await page.evaluate(() => window.DaimondPause.heldByHand('root')), JSON.stringify(H5));
	await setPaused(page, 'root', true);
	await s.close();
}

console.log('');
console.log(ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) process.exit(1);
