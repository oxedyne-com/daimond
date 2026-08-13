// verify_pausespend.mjs — a pause is refused where the money is committed.
//
// The PPTW of NOTES2_PLAN §1.1 is one control with three states, and §1.1 says
// what makes it real: "Not in the UI. A pause has to be refused at the point
// money is committed, or it is decoration." So nothing here reads the flag back.
// Every assertion is counted AT THE NETWORK — `page.route` sits between the page
// and every host it talks to, so a request that was refused never reaches a
// counter, and one that was merely hidden does.
//
// Each boundary is asked BOTH questions, and the second is the one that matters:
//
//   * paused  → no request left the page;
//   * resumed → the request DOES leave.
//
// A check that only ever proves silence passes with the feature entirely broken —
// with the network unplugged, with the button doing nothing, with the whole
// module deleted. The resume half is what tells a refusal from an outage.
//
// The boundaries, and what drives each:
//
//   1. THE WORKER-SLOT MINT. A real conductor turn dispatching three agents,
//      with `root/workers` paused. Every worker key is minted at
//      /api/inference-key with a slot of 1 or more; a paused pump mints none.
//   2. THE CHAT'S MINT. `remint(gen, node)` for a paused leaf. Called directly:
//      it is the call daimond.js makes at www/js/daimond.js:7781, with the
//      argument it has yet to pass.
//   3. THE DISPATCH GATE. `assessDispatch(n, node)` comes back refused through
//      the object it already answers with. A decision check, not a network one —
//      the network half of the same boundary is (1).
//   4. WEB FETCH. The real DaimondWeb.fetch, against a stubbed /api/web/fetch.
//   5. MAIL. The real DaimondMail.sync, against a stubbed /api/mail/sync.
//   6. READING IS NOT PAUSED. With every leaf held, a Diamond still opens, its
//      crystal still renders and its files still list.
//
// Everything below the stub is the real code: the real wasm, the real models.js,
// the real gateway.js, the real Workers pool. The gateway itself is not run.
//
//   eval "$(bash dev/world.sh 3 --up)"
//   node dev/verify_pausespend.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs (DAIMOND_PORT / DAIMOND_MOCK_PORT).
import fs from 'node:fs';
import { open, signInAs, shot, scratch, errors, MOCK } from './harness.mjs';

const PROFILE = scratch('pw', 'pausespend');
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});
const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_URL  = `${OR_BASE}/chat/completions`;
const MAILBOX = 'alice@test.local';

// Everything that left the page, by boundary. A refusal shows as a count that
// did not move.
const net = { mint: [], web: [], mailSync: [], mailSend: [], mailFolders: 0, provider: 0 };
const slotMints = () => net.mint.filter(s => s >= 1).length;

async function stub(page) {
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-pause', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, held: true, currency: 'usd' })));

	await page.route('**/api/inference-key', r => {
		let slot = 0;
		try { slot = (JSON.parse(r.request().postData() || '{}').slot) | 0; } catch (e) { slot = 0; }
		net.mint.push(slot);
		return r.fulfill(json({
			ok: true, key: `sk-or-v1-SLOT${slot}-pausemarker00000000000000000000000000`,
			url: OR_BASE, limit_minor: 200, credits_minor: 5000, currency: 'usd',
		}));
	});

	await page.route(`${OR_BASE}/models`,
		r => r.fulfill(json({ data: [{ id: 'anthropic/claude-opus-4.5' }] })));
	await page.route(OR_URL, async (r) => {
		net.provider++;
		const sent = r.request().postData() || '';
		const res  = await fetch(MOCK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent });
		const body = await res.text();
		return r.fulfill({ status: res.status, headers: CORS, body,
			contentType: res.headers.get('content-type') || 'application/json' });
	});

	// The three credit-spending routes this file measures.
	await page.route('**/api/web/fetch', r => {
		net.web.push(r.request().postData() || '');
		return r.fulfill(json({ ok: true, url: 'https://example.com/', title: 'Example',
			text: 'a page', bytes: 6, credits_minor: 4990 }));
	});
	await page.route('**/api/web/head', r => r.fulfill(json({ ok: true, framable: false })));
	await page.route('**/api/mail/sync', r => {
		net.mailSync.push(r.request().postData() || '');
		return r.fulfill(json({ ok: true, uid_validity: 7, messages: [], credits_minor: 4980 }));
	});
	await page.route('**/api/mail/send', r => {
		net.mailSend.push(r.request().postData() || '');
		return r.fulfill(json({ ok: true, credits_minor: 4970 }));
	});
	// Listing is READING, and reading is never paused.
	await page.route('**/api/mail/folders', r => {
		net.mailFolders++;
		return r.fulfill(json({ ok: true, folders: [{ name: 'INBOX' }, { name: 'Sent', role: 'sent' }] }));
	});
	await page.route('**/api/mail/accounts', r => r.fulfill(json({ ok: true, allowed: 3, used: 0 })));
}

// ── The tree, driven the way the widget will drive it ────────────────
// Only leaves are set, so none of this needs the live tree daimond.js has yet
// to register: `DaimondPause.set` on an id it cannot find writes that id alone,
// which for a leaf is exactly right.
const pauseLeaf = (page, id) => page.evaluate(i => window.DaimondPause.set(i, false), id);
const playLeaf  = (page, id) => page.evaluate(i => window.DaimondPause.set(i, true), id);
const pausedIds = (page) => page.evaluate(() => window.DaimondPause.pausedIds());

const s = await open({ name: 'pausespend', profile: PROFILE, signIn: false, connect: false });
const { page } = s;
await stub(page);
await signInAs(s, 'pausespend');
await page.waitForTimeout(2500);		// unlock → bootstrap → mint slot 0 → catalogue

try {
	await page.evaluate(() => window.DaimondModels.setDefault('credits', 'anthropic/claude-opus-4.5'));
	check('the account is on credits and slot 0 was minted at unlock',
		net.mint.includes(0), 'mints ' + JSON.stringify(net.mint));

	// ── 1. The worker-slot mint ──────────────────────────────────
	const WORKERS = 'root/workers';
	await pauseLeaf(page, WORKERS);

	// The Admin drawer opens over the rail on an unconnected profile and swallows
	// the click; close it the way a person would, then force past the fade that
	// keeps failing Playwright's stability check.
	const drawer = page.locator('#admin-close');
	if (await drawer.isVisible().catch(() => false)) {
		await drawer.click({ force: true });
		await page.waitForTimeout(300);
	}
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
	await page.fill('.dlg-input', 'Held');
	await page.click('.dlg-ok', { force: true });
	await page.waitForSelector('#chat-input', { timeout: 10000 });
	await page.waitForTimeout(400);

	const steer = '@tools spawn_agent {"name":"a","task":"one"} ;; '
		+ 'spawn_agent {"name":"b","task":"two"} ;; '
		+ 'spawn_agent {"name":"c","task":"three"}';
	const before = slotMints();
	await page.fill('#chat-input', steer);
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(7000);
	check('a paused worker pump dispatches nothing and mints nothing',
		slotMints() === before, 'slot mints ' + JSON.stringify(net.mint));

	// AND THE MINT ITSELF, asked directly. The check above passes with the mint
	// gate deleted, because daimond.js's pump reads the same leaf and never
	// reaches the mint — which is two guards doing their job and one check
	// proving only the outer one. This is the inner one on its own: the call the
	// pump makes at www/js/daimond.js:8453, made here with the pump held.
	const beforeDirect = net.mint.length;
	const refusedSlot = await page.evaluate(async () => {
		try { await window.DaimondModels.mintSlot(1); return { threw: false, msg: '' }; }
		catch (e) { return { threw: true, msg: String(e && e.message || e), node: e && e.pauseNode }; }
		finally { window.DaimondModels.forgetSlot(1); }
	});
	check('and a worker key asked for directly is refused at the mint',
		net.mint.length === beforeDirect && refusedSlot.threw,
		refusedSlot.msg || ('mints ' + JSON.stringify(net.mint)));
	check('and that refusal names the pump and how to resume it',
		refusedSlot.node === WORKERS && refusedSlot.msg.includes(WORKERS)
			&& /play/i.test(refusedSlot.msg), refusedSlot.msg);

	await playLeaf(page, WORKERS);
	const afterDirect = await page.evaluate(async () => {
		try { await window.DaimondModels.mintSlot(1); return 'ok'; }
		catch (e) { return String(e && e.message || e); }
		finally { window.DaimondModels.forgetSlot(1); }
	});
	check('and a resumed pump mints — so the silence above was the pause',
		net.mint.length > beforeDirect, afterDirect + ' — mints ' + JSON.stringify(net.mint));

	await page.fill('#chat-input', steer);
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(9000);
	check('and a resumed pump dispatches again',
		slotMints() > before, 'slot mints ' + JSON.stringify(net.mint));

	// ── 2. The chat's own mint ───────────────────────────────────
	// `remint(gen, node)` is the call at www/js/daimond.js:7781, given the
	// argument the widget's own work will pass it.
	const CHAT = 'root/chats/pausespend-1';
	await pauseLeaf(page, CHAT);
	const n2 = net.mint.length;
	// The LIVE generation in BOTH halves. `remint` hands an OLD generation the key
	// somebody else has already minted rather than buying another, so a stale
	// number makes the paused half silent whatever the guard does — a check that
	// passes with the guard deleted, which is no check at all.
	const refusedMint = await page.evaluate(async (node) => {
		try {
			await window.DaimondModels.remint(window.DaimondModels.creditsGen(), node);
			return { threw: false, msg: '' };
		} catch (e) {
			return { threw: true, msg: String(e && e.message || e), node: e && e.pauseNode, flag: !!(e && e.paused) };
		}
	}, CHAT);
	check('a paused chat mints no key', net.mint.length === n2 && refusedMint.threw,
		'mints ' + JSON.stringify(net.mint));
	check('and the refusal names the node and how to resume it',
		refusedMint.threw && refusedMint.node === CHAT
			&& /play/i.test(refusedMint.msg) && refusedMint.msg.includes(CHAT),
		refusedMint.msg);
	check('and it is marked a pause rather than a fault', refusedMint.flag === true);

	await playLeaf(page, CHAT);
	// The LIVE generation, or `remint` rightly hands back the key somebody else
	// has already minted instead of buying another — and the resume half would
	// pass without a request ever leaving.
	const mintedAfter = await page.evaluate(async (node) => {
		try {
			await window.DaimondModels.remint(window.DaimondModels.creditsGen(), node);
			return 'ok';
		} catch (e) { return String(e && e.message || e); }
	}, CHAT);
	check('and resuming it mints', net.mint.length > n2,
		mintedAfter + ' — mints ' + JSON.stringify(net.mint));

	// ── 3. The dispatch gate ─────────────────────────────────────
	const DIA = 'root/diamonds/d1/self';
	await pauseLeaf(page, DIA);
	const gate = await page.evaluate((node) => ({
		held: window.DaimondGovernor.assessDispatch(3, node),
		free: window.DaimondGovernor.assessDispatch(3, 'root/diamonds/d2/self'),
		none: window.DaimondGovernor.assessDispatch(3),
	}), DIA);
	check('a paused node comes back refused through the same decision object',
		gate.held.refused === true && gate.held.pauseNode === DIA,
		JSON.stringify({ refused: gate.held.refused, node: gate.held.pauseNode }));
	check('and its refusal names the node and how to resume it',
		typeof gate.held.refusal === 'string' && gate.held.refusal.includes(DIA)
			&& /play/i.test(gate.held.refusal), gate.held.refusal);
	check('and it also stops a caller that only reads needsConfirm',
		gate.held.needsConfirm === true);
	check('a node that is playing is not refused', gate.free.refused === false);
	check('and neither is a caller that names no node at all', gate.none.refused === false);
	await playLeaf(page, DIA);

	// ── 4. Web fetch ─────────────────────────────────────────────
	const WEB = 'root/web';
	await pauseLeaf(page, WEB);
	const n4 = net.web.length;
	const refusedWeb = await page.evaluate(async () => {
		try { await window.DaimondWeb.fetch('https://example.com/'); return { threw: false, msg: '' }; }
		catch (e) { return { threw: true, msg: String(e && e.message || e) }; }
	});
	check('a paused Web panel fetches no page', net.web.length === n4,
		net.web.length + ' fetch(es)');
	check('and the refusal names the node and how to resume it',
		refusedWeb.threw && refusedWeb.msg.includes(WEB) && /play/i.test(refusedWeb.msg),
		refusedWeb.msg);

	await playLeaf(page, WEB);
	const gotWeb = await page.evaluate(async () => {
		try { return (await window.DaimondWeb.fetch('https://example.com/')).title || 'no title'; }
		catch (e) { return 'THREW ' + (e && e.message || e); }
	});
	check('and resuming it fetches', net.web.length === n4 + 1,
		gotWeb + ' — ' + net.web.length + ' fetch(es)');

	// The global control is the root of the same tree, and holds a fetch that
	// belongs to no leaf of its own.
	await pauseLeaf(page, 'root');
	const n4b = net.web.length;
	await page.evaluate(async () => { try { await window.DaimondWeb.fetch('https://example.com/'); } catch (e) {} });
	check('the global pause holds a page fetch that names no leaf',
		net.web.length === n4b, net.web.length + ' fetch(es)');
	await playLeaf(page, 'root');

	// ── 5. Mail ──────────────────────────────────────────────────
	await page.evaluate(async (addr) => {
		const pass = await window.DaimondIdentity.wrap('test-app-password');
		localStorage.setItem('daimond-mail', JSON.stringify({
			accounts: [{
				address: addr, host: '127.0.0.1', port: 1143, security: 'plain',
				smtpHost: '127.0.0.1', smtpPort: 1587, smtpSecurity: 'plain',
				user: addr, pass, folder: 'INBOX', folders: {}, lastSync: 0,
			}],
			sel: addr,
		}));
		window.DaimondMail.reload();
		window.DaimondPanels.show('mail');
		window.DaimondMail.onOpen();
	}, MAILBOX);
	await page.waitForTimeout(1200);

	const INBOX = `root/mail/${MAILBOX}/INBOX`;
	const MBOX  = `root/mail/${MAILBOX}/self`;
	await pauseLeaf(page, INBOX);
	const n5 = net.mailSync.length;
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1500);
	check('a paused mail folder contacts no server', net.mailSync.length === n5,
		net.mailSync.length + ' sync(s)');

	await playLeaf(page, INBOX);
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1500);
	check('and resuming it syncs', net.mailSync.length === n5 + 1,
		net.mailSync.length + ' sync(s)');

	// The mailbox's own leaf holds every folder under it, or a paused mailbox
	// would go on reaching the server one folder at a time.
	await pauseLeaf(page, MBOX);
	const n5b = net.mailSync.length;
	await page.evaluate(() => window.DaimondMail.sync());
	await page.waitForTimeout(1500);
	check('a paused mailbox holds a sync of a folder that is playing',
		net.mailSync.length === n5b, net.mailSync.length + ' sync(s)');

	const sendHeld = await page.evaluate((addr) => window.DaimondGateway.spendRefusal(
		'/api/mail/send', { body: JSON.stringify({ address: addr }) }), MAILBOX);
	check('and it holds a send too', !!sendHeld && sendHeld.node === MBOX,
		JSON.stringify(sendHeld));
	await playLeaf(page, MBOX);

	// ── 6. Reading is not paused ─────────────────────────────────
	// Everything held: the folder list is still asked for, the Diamond still
	// opens, its crystal still renders and its files still list.
	await pauseLeaf(page, 'root');
	await pauseLeaf(page, WORKERS);
	await pauseLeaf(page, INBOX);
	await pauseLeaf(page, MBOX);

	const foldersBefore = net.mailFolders;
	await page.evaluate(() => window.DaimondMail.loadFolders(undefined, true));
	await page.waitForTimeout(1200);
	check('the folder list is still asked for — a list is reading, not spending',
		net.mailFolders > foldersBefore, net.mailFolders + ' listing(s)');

	await page.evaluate(() => { window.DaimondPanels.show('ai'); window.DaimondPanels.show('work'); });
	await page.click('.diamond-item, #diamond-list > *', { force: true }).catch(() => {});
	await page.waitForTimeout(2000);
	const read = await page.evaluate(() => {
		const body = document.getElementById('crystal-body');
		const view = document.getElementById('crystal-view');
		return {
			// A CRYSTAL WITH ANYTHING IN IT IS NOW A FRAME, and a frame contributes
			// no text to its container -- so counting characters here would have
			// answered zero for every Diamond and failed pointing at pause, which is
			// not where the fault would have been. What this ever meant is "the
			// crystal face drew something", and the frame reports that itself.
			crystal: !!(body && (body.textContent.trim().length > 0
				|| body.querySelector('.crystal-frame, .crystal-fallback, .crystal-empty'))),
			shown:   !!(view && view.style.display !== 'none'),
			files:   document.querySelectorAll('#panel-work .files-tree *').length,
			steer:   !!document.getElementById('chat-input'),
		};
	});
	check('a paused Diamond still opens and its crystal still renders',
		read.crystal && read.shown, JSON.stringify(read));
	check('and its files still list, and its steer input is still there — '
		+ 'pause is about spending, not access',
		read.files > 0 && read.steer, JSON.stringify(read));

	// A refusal is a decision, not a fault, so it must not arrive as a thrown
	// stack in the console: an app that logs an error every time a paused node
	// is asked to spend has taught the user to ignore its console.
	// "Failed to load resource" is the dev server answering the routes this
	// stub does not cover (/api/sync, /api/admin); it is noise, not a refusal.
	const errs = errors(s).filter(e => !/Paused:/.test(e) && !/Failed to load resource/.test(e));
	check('nothing was refused by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	console.log('\npaused when finished: ' + JSON.stringify(await pausedIds(page)));
	await shot(s, 'pausespend');
} finally {
	await s.close();
}

console.log('\nmints: ' + JSON.stringify(net.mint));
console.log('web: ' + net.web.length + '  mail sync: ' + net.mailSync.length
	+ '  mail folders: ' + net.mailFolders + '  provider: ' + net.provider);
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
