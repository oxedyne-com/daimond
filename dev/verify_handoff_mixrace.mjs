// gateway: live
// verify_handoff_mixrace.mjs -- a busy runner's hand-back across page versions and fleets (r545, FA).
//
// Ported from r544 QA-A's probe (p_race.mjs). Every turn A sends must reach the model exactly
// once, its answer reach A, and leave one ledger entry for its tid on each device.
//
//   MIX=A543|B543   serve an older build's www (DAIMOND_OLD_WWW, default lane-r543rel's) to A or B.
//   THREE=1         add C, a second idle desktop; B is made the nominee so A seats B.
//   B2B=1           A sends two chats back to back while B is busy.
//   IDLE=1          B's own turn ends ~3 s after A's send: busy goes idle mid-errand.
//   DUMP=1          print A's rows for each tid, its lease record and its stored messages.
//
// THE CONTROL (MIX only): the old page first runs a turn of its own. r544 QA-A read F-A1 ("an
// r543 sender never runs a turn a busy r544 runner hands back") from a run in which the old
// page could not reach the model at all: the r543 sender reclaimed, claimed and ran the turn
// locally, and the run ended `interrupted: offline` (9 Oct, FA). A red control means the rig,
// not the hand-off.
//
import fs from 'node:fs';
import path from 'node:path';
import {
	checker, pair, until, storedMsgs, placeholders, modelSaw, send, sendDesk, freshChat,
} from './handoffpair.mjs';
import { open, signInAs, connectMock } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const MIX = process.env.MIX || '', THREE = !!process.env.THREE, B2B = !!process.env.B2B, IDLE = !!process.env.IDLE;
const R543 = process.env.DAIMOND_OLD_WWW || '/home/jason/lanes/oxedyne/pin/web/apps/oxedyne/lane-r543rel/www';
const APP = process.env.DAIMOND_APP || 'http://localhost:' + (process.env.DAIMOND_PORT || 8777);
const { ok, bad, check } = checker();
const tag = Math.random().toString(36).slice(2, 8);
console.log('p_race MIX=' + MIX + ' THREE=' + THREE + ' B2B=' + B2B + ' IDLE=' + IDLE + ' tag=' + tag);

// Serve r543's www to one device, A (MIX=A543) or B (MIX=B543). THE OLD PAGE COULD NOT REACH
// THE MOCK (9 Oct, FA): a document answered by page.route has no server address, so Chromium
// files it in the PUBLIC address space, and its Local Network Access checks then refused every
// call to loopback -- the mock's /v1/models, the sync socket -- and each turn ended
// `interrupted: offline`. A real r543 page is served from the app's own address and is never
// refused, so the old device runs with those checks off. Its service workers are blocked too:
// page.route never sees what a worker answers. OLD_RIG=1 restores the broken rig (the red control).
const want = MIX === 'A543' ? 0 : MIX === 'B543' ? 1 : -1;
const oldOpen = {
	serviceWorkers: process.env.OLD_RIG ? 'allow' : 'block',
	extraArgs:      process.env.OLD_RIG ? [] : ['--disable-features=LocalNetworkAccessChecks'],
	route: async (page) => {
		const tally = { served: 0, through: 0, sw: 0 };
		page.on('response', (r) => { try { if (r.fromServiceWorker()) tally.sw++; } catch (e) {} });
		page.__errs543 = [];
		page.on('console', (m) => { if (m.type() === 'error' && page.__errs543.length < 12) page.__errs543.push(m.text().slice(0, 240)); });
		page.on('pageerror', (e) => { if (page.__errs543.length < 12) page.__errs543.push('pageerror ' + String(e).slice(0, 240)); });
		await page.route((u) => u.origin === new URL(APP).origin && !u.pathname.startsWith('/api'), (r) => {
			const u = new URL(r.request().url());
			let p = decodeURIComponent(u.pathname);
			if (p.endsWith('/')) p += 'index.html';
			const f = path.join(R543, p);
			if (f.startsWith(R543) && fs.existsSync(f) && fs.statSync(f).isFile()) { tally.served++; return r.fulfill({ path: f }); }
			tally.through++;
			return r.continue();
		});
		page.__tally543 = () => tally;
	},
};

const rows = (s, re) => s.page.evaluate((src) => {
	const r = new RegExp(src);
	try { return window.DaimondDiag.rows().filter((x) => r.test(String(x.tag)))
		.map((x) => String(x.tag) + ' | ' + String(x.data).slice(0, 200)); } catch (e) { return ['diag: ' + e]; }
}, re.source).catch((e) => ['eval: ' + e]);
const sawUntil = async (pg, text, ms) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (modelSaw(text) > 0) return Date.now() - t0; await pg.waitForTimeout(100); }
	return -1;
};
const answered = (a, prompt) => a.page.evaluate(async (p) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		const ms = (got && got.messages) || [];
		const at = ms.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(p));
		if (at < 0) continue;
		return ms.slice(at + 1).filter((m) => m && m.role === 'assistant' && !m.interrupted && String(m.content || '').trim()).length;
	}
	return 0;
}, prompt).catch(() => 0);
const ledgerFor = (s, tid) => s.page.evaluate(async (t) => {
	try { await window.DaimondSync.pull(); } catch (e) { /* offline */ }
	try { return (window.DaimondLedger.entries() || []).filter((e) => String(e.tid || '') === t).length; } catch (e) { return 'err ' + e; }
}, tid).catch((e) => 'eval ' + e);
const version = (s) => s.page.evaluate(() => ({
	hb: typeof (window.DaimondPeer || {}).handBackReport === 'function',
})).catch(() => null);

// C: a third device of the same account, a desktop, paired from A.
async function addC(a) {
	const c = await open({ name: 'qa544c' + tag, signIn: false, connect: false });
	c.account = a.account; c.name = 'qa544c';
	await c.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await c.page.evaluate((x) => DaimondPairing.redeem(x), code.code);
	await c.page.reload({ waitUntil: 'domcontentloaded' });
	await c.page.waitForFunction(() => { try { return !!window.__DAIMOND_READY; } catch (e) { return false; } }, null, { timeout: 90000 }).catch(() => {});
	await signInAs(c, a.account);
	await c.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(c.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(c);
	await c.page.setViewportSize({ width: 1280, height: 900 });
	await c.page.waitForTimeout(2000);
	await c.page.evaluate((n) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n), 'qa544c');
	return c;
}

let a, b, c;
try {
	({ a, b } = await pair(check, 'qa544lead' + tag, 'qa544mate' + tag,
		want === 0 ? { openA: oldOpen } : want === 1 ? { openB: oldOpen } : {}));
	for (const s of [a, b]) await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'qa544'); } catch (e) {} });
	console.log('  versions A ' + JSON.stringify(await version(a)) + ' B ' + JSON.stringify(await version(b))
		+ ' r543 A=' + JSON.stringify(a.page.__tally543 ? a.page.__tally543() : '-') + ' B=' + JSON.stringify(b.page.__tally543 ? b.page.__tally543() : '-'));
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	let idC = '';
	if (THREE) {
		c = await addC(a);
		await c.page.evaluate(() => { try { window.DaimondDiag.set(true, 'qa544'); } catch (e) {} });
		idC = await c.page.evaluate(() => window.DaimondIdentity.deviceId());
		await a.page.evaluate((id) => window.DaimondCore.nominate(id), idB);
		await a.page.waitForTimeout(3000);
		for (const s of [a, b, c]) await s.page.evaluate(() => { try { return window.DaimondSync.pull(); } catch (e) {} });
		const awake = await a.page.evaluate(() => (window.DaimondPresence.awake(window.DaimondIdentity.deviceId(), Date.now()) || []).length);
		check('C joined: A sees two awake peers', awake >= 2, 'awake ' + awake);
	}

	// CONTROL: the old page runs a turn of its own at a desktop's width, so a turn that never
	// reaches the model below is the hand-off's fault and not a page that cannot reach the mock.
	if (want >= 0) {
		const old = want === 0 ? a : b;
		await freshChat(old);
		await sendDesk(old.page, 'control turn ' + tag);
		const at = await sawUntil(old.page, 'control turn ' + tag, 30000);
		check('control: the r543 page reaches the model', at >= 0, (at >= 0 ? 'at +' + at + 'ms' : 'never in 30 s')
			+ ' r543 files ' + JSON.stringify(old.page.__tally543 ? old.page.__tally543() : null));
		if (at < 0) {
			for (const e of old.page.__errs543 || []) console.log('  old err ..', e);
			for (const r of (await rows(old, /./)).slice(-30)) console.log('  old ..', r);
			for (const m of (await storedMsgs(old)).slice(-4)) console.log('  old msg ..', JSON.stringify(m).slice(0, 300));
		}
		await old.page.waitForTimeout(3000);
	}

	// B busy on a local turn, its beats lost on the way.
	await b.page.route(/[?&]presence=1/, (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
	await freshChat(b);
	const localMs = IDLE ? 6000 : 60000;
	const local = '@slow ' + localMs + ' b local turn ' + tag;
	await sendDesk(b.page, local);
	check('B is running its own turn', (await sawUntil(b.page, 'b local turn ' + tag, 10000)) >= 0);
	const aView = await a.page.evaluate(async (id) => {
		try { await window.DaimondSync.refreshPresence(); } catch (e) {}
		const r = window.DaimondPresence.snapshot()[id] || null; return r ? r.busy | 0 : null;
	}, idB);
	check('A still reads B idle', aView === 0, 'busy=' + aView);

	const sends = B2B ? ['qa race one ' + tag, 'qa race two ' + tag] : ['qa race one ' + tag];
	const t0 = Date.now();
	for (const p of sends) { await freshChat(a); await send(a.page, p); }
	const tids = [];
	for (const p of sends) {
		let ph = null;
		for (let i = 0; i < 80 && !ph; i++) {
			ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '') === p) || null;
			if (!ph) await a.page.waitForTimeout(150);
		}
		check('A handed "' + p + '" off', !!ph, ph ? 'to ' + String(ph.toDevice || '').slice(0, 8) + (ph.toDevice === idB ? ' (B)' : (idC && ph.toDevice === idC) ? ' (C)' : '') + ' tid=' + ph.iturn : 'ran locally');
		tids.push(ph ? String(ph.iturn) : '');
	}
	const DEAD = 130000;
	for (let k = 0; k < sends.length; k++) {
		const at = await sawUntil(a.page, sends[k], Math.max(1000, DEAD - (Date.now() - t0)));
		check('"' + sends[k] + '" reached the model', at >= 0, at >= 0 ? 'at +' + (Date.now() - t0) + 'ms from first send' : 'never in ' + DEAD + 'ms');
	}
	for (const p of sends) {
		let n = 0;
		for (const tA = Date.now(); !n && Date.now() - tA < 30000;) { n = await answered(a, p); if (!n) await a.page.waitForTimeout(500); }
		check('its answer reached A: "' + p + '"', n >= 1, 'answers ' + n);
	}
	await a.page.waitForTimeout(8000);
	for (const p of sends) check('"' + p + '" reached the model exactly once', modelSaw(p) === 1, 'seen ' + modelSaw(p));
	check('B\'s own turn exactly once', modelSaw('b local turn ' + tag) === 1, 'seen ' + modelSaw('b local turn ' + tag));
	for (let k = 0; k < sends.length; k++) {
		if (!tids[k]) continue;
		const la = await ledgerFor(a, tids[k]), lb = await ledgerFor(b, tids[k]), lc = c ? await ledgerFor(c, tids[k]) : '-';
		check('ledger: one entry for "' + sends[k] + '" on every device', la === 1 && lb === 1 && (lc === '-' || lc === 1), 'A=' + la + ' B=' + lb + ' C=' + lc);
		for (const r of (await rows(a, new RegExp('handoff|handback|fallback|reseat|recover|elect|dispatch|' + tids[k]))).slice(-40)) console.log('  A ..', r);
		for (const r of await rows(b, /./)) if (r.includes(tids[k])) console.log('  B ..', r);
		if (process.env.DUMP) {
			for (const r of await rows(a, /./)) if (r.includes(tids[k])) console.log('  A* ..', r);
			const st = await a.page.evaluate((t) => {
				let lease = null, ph = null;
				try { lease = window.DaimondLease.record(t); } catch (e) { lease = 'err ' + e; }
				return JSON.stringify({ lease });
			}, tids[k]).catch((e) => 'eval ' + e);
			console.log('  A lease ..', st);
			for (const m of (await storedMsgs(a)).filter((m) => m && String(m.iturn || m.mid || '') === tids[k])) console.log('  A msg ..', JSON.stringify(m).slice(0, 400));
		}
		if (c) for (const r of await rows(c, /collect/)) if (r.includes(tids[k])) console.log('  C ..', r);
	}
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 500));
} finally {
	for (const s of [a, b, c]) { try { await s?.close(); } catch (e) {} }
}
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
