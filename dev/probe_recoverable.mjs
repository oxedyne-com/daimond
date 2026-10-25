// gateway: none
// probe_recoverable -- F3b protection (spec daimond_free_pro_model_20261025.md §5.1, R1), in the page:
//   A single-feature, failing-first probe (not a verify_ suite), so it runs before the deploy.
//
//   A  KEEP. `navigator.storage.persist()` is asked at the first run's create, and once more at a
//      load for an identity the browser does not keep yet. What the ENGINE answers is printed, not
//      asserted: Chromium and WebKit each grant by their own heuristics.
//
//   B  THE PENDING ROW (QA M3). A first-run create raises the one Pending row "Not recoverable
//      yet" (`data-id="r:recover"`), the recovery cards (`data-ask="recover"`) come up, and the
//      harness's OK to them (it saves the file and confirms the save) records the file half and
//      takes the row down. The sync chip never says it: recoverability is not a sync state, and
//      it hid every sync fault. Watched from an init script, since the harness answers the cards
//      before `open` returns.
//
//   C  THE RAIL SUMMARY. While unrecoverable its warn line says "Not recoverable yet", but a
//      sync fault outranks it: with the chip stood in as stalled, the summary says the fault.
//
//   D  THE HOME SCREEN (QA M4). An iOS Home Screen app has its own, empty storage. In an iOS tab
//      the step says the Home Screen app starts empty and offers this tab's pairing code, and
//      only while nothing else brings the identity back; a Home Screen app with no identity
//      offers "Pair with your other Daimond" before Create. iOS is stood in by the user agent.
//
//   node dev/probe_recoverable.mjs                         (Chromium)
//   DAIMOND_BROWSER=webkit node dev/probe_recoverable.mjs  (WebKit)
import { open, BROWSER } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// Logs every ask, before any script of the page runs, and passes it through to the engine. The log
// is in sessionStorage, so it outlives a navigation the first run makes; each entry says which
// document asked and whether an identity was already stored when that document loaded.
//
// ON THE PROTOTYPE, NOT ON `navigator.storage`. WebKit lets the JS wrapper of the StorageManager be
// collected while nothing but the navigator names it, and hands out a fresh one, without expandos,
// the next time `navigator.storage` is read. A spy set on the instance was gone by the time the
// first run's create asked (a collection during the create took it), so A1 read
// an empty log in WebKit while identity.js had asked (2026-10-26, write-up
// ~/usr/code/ai/claude/agents/daimond-sync/20261026_f3b_webkit_a1_diag.md). The prototype is held
// by the global and survives in both engines.
const SPY = () => {
	const nav = String(performance.timeOrigin);
	const had = (() => { try { return !!localStorage.getItem('daimond-id-pub'); } catch (e) { return false; } })();
	try {
		const proto = window.StorageManager && StorageManager.prototype;
		if (proto && proto.persist) {
			const real = proto.persist;
			proto.persist = function () {
				const log = JSON.parse(sessionStorage.getItem('__persistLog') || '[]');
				log.push({ nav, had });
				sessionStorage.setItem('__persistLog', JSON.stringify(log));
				return real.call(this);
			};
		}
	} catch (e) { /* no storage manager */ }
};
const asks = (p) => p.evaluate(() => JSON.parse(sessionStorage.getItem('__persistLog') || '[]'));
const spied = (extra) => async (page) => {
	await page.addInitScript(SPY);
	if (extra) await extra(page);
};

console.log(`probe_recoverable on ${BROWSER}`);

// ── A: keep ────────────────────────────────────────────────────────────
{
	const s = await open({ name: 'recover_a', connect: false, route: spied() });
	const p = s.page;
	const log1 = await asks(p);
	const first = await p.evaluate(async () => ({
		has: !!(navigator.storage && navigator.storage.persist),
		kept: navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null,
	}));
	console.log(`  info engine answers persisted() = ${first.kept} after the first run (has persist: ${first.has})`);
	if (first.has) check('A1 the first run asks the browser to keep the store', log1.some((a) => !a.had), JSON.stringify(log1));
	else check('A1 an engine with no persist() is not asked', log1.length === 0);

	await p.reload();
	await p.waitForFunction(() => !!window.DaimondIdentity, null, { timeout: 30000 });
	await p.waitForTimeout(800);
	const now = await p.evaluate(() => String(performance.timeOrigin));
	const again = { asks: (await asks(p)).filter((a) => a.nav === now).length };
	if (!first.has) check('A2 a reload asks nothing of an engine without persist()', again.asks === 0);
	else if (first.kept) check('A2 a reload the engine already keeps asks nothing', again.asks === 0, `asks ${again.asks}`);
	else check('A2 a reload with the store not yet kept asks exactly once', again.asks === 1, `asks ${again.asks}`);
	await s.browser.close().catch(() => {});
}

// ── B: the chip ────────────────────────────────────────────────────────
// Every chip state and every recovery card, in order, kept in sessionStorage.
const WATCH = () => {
	const put = (e) => {
		const log = JSON.parse(sessionStorage.getItem('__recoverLog') || '[]');
		if (log.length && log[log.length - 1] === e) return;
		log.push(e);
		sessionStorage.setItem('__recoverLog', JSON.stringify(log));
	};
	const look = () => {
		const c = document.getElementById('sync-chip');
		if (c && c.style.display !== 'none' && c.dataset.state) put('chip:' + c.dataset.state);
		if (document.querySelector('#pending-list [data-id="r:recover"]')) put('row');
		if (document.querySelector('.modal.dlg[data-ask="recover"]')) put('card');
	};
	const start = () => new MutationObserver(look).observe(document.documentElement,
		{ subtree: true, childList: true, attributes: true, attributeFilter: ['data-state', 'style', 'data-ask', 'data-id'] });
	if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
};
{
	const s = await open({ name: 'recover_b', connect: false, route: async (page) => { await page.addInitScript(WATCH); } });
	const p = s.page;
	await p.waitForTimeout(800);
	const r = await p.evaluate(() => ({
		log: JSON.parse(sessionStorage.getItem('__recoverLog') || '[]'),
		rec: window.DaimondIdentity && DaimondIdentity.recoverable ? DaimondIdentity.recoverable() : null,
		chip: (() => { const c = document.getElementById('sync-chip'); return c && c.style.display !== 'none' ? c.dataset.state : ''; })(),
		row: !!document.querySelector('#pending-list [data-id="r:recover"]'),
	}));
	const firstCard = r.log.indexOf('card');
	check('B1 the Pending row "Not recoverable yet" is raised on create', r.log.includes('row'), JSON.stringify(r.log));
	check('B2 the recovery cards come up', firstCard >= 0);
	check('B3 a confirmed recovery file is recorded', r.rec === 'file', `recoverable() = ${JSON.stringify(r.rec)}`);
	check('B4 the row goes once the file is confirmed', !r.row, `row = ${JSON.stringify(r.row)}`);
	check('B5 the sync chip never says it', !r.log.some((e) => e === 'chip:unrecoverable'), JSON.stringify(r.log));
	// C: forget the file half, so the identity is unrecoverable again, and read the summary.
	const c = await p.evaluate(async () => {
		const read = () => (document.querySelector('#astat-summary .astat-val') || {}).textContent || '';
		DaimondStore.remove('daimond-id-recover');
		window.dispatchEvent(new Event('daimond:recoverable'));
		await new Promise((r) => setTimeout(r, 300));
		const out = { rec: DaimondIdentity.recoverable(), calm: read(),
			row: !!document.querySelector('#pending-list [data-id="r:recover"]'),
			act: !!document.querySelector('#pending-list [data-id="r:recover"] .pend-recover-go') };
		const real = DaimondSync.chip;
		DaimondSync.chip = () => 'stalled';
		DaimondAdmin.summary();
		out.fault = read();
		DaimondSync.chip = real;
		DaimondAdmin.summary();
		return out;
	});
	check('C1 unrecoverable again: the summary says so', c.rec === '' && /recoverable/i.test(c.calm), JSON.stringify(c));
	check('C2 and the row is back, with its one act', c.row && c.act, JSON.stringify(c));
	check('C3 a sync fault outranks it in the summary', c.fault && !/recoverable/i.test(c.fault), JSON.stringify(c));
	await s.browser.close().catch(() => {});
}

// ── D: the Home Screen ─────────────────────────────────────────────────
const IOS = (home) => `(() => {
	const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
	Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => ua, configurable: true });
	Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
	${home ? "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });" : ''}
	// Every recovery card's words, kept, since the harness answers them before open() returns.
	const look = () => document.querySelectorAll('.modal.dlg[data-ask="recover"]').forEach((c) => {
		const log = JSON.parse(sessionStorage.getItem('__dlgTexts') || '[]'), x = c.textContent || '';
		if (!log.includes(x)) { log.push(x); sessionStorage.setItem('__dlgTexts', JSON.stringify(log)); }
	});
	const go = () => new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true });
	if (document.documentElement) go(); else document.addEventListener('DOMContentLoaded', go);
})()`;
{
	const s = await open({ name: 'recover_d1', connect: false, route: async (page) => { await page.addInitScript(IOS(false)); } });
	const p = s.page;
	await p.waitForTimeout(500);
	const shown = await p.evaluate(async () => {
		const sel = '.modal.dlg[data-ask="recover"]';
		const wait = async (f) => { for (let i = 0; i < 60; i++) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
		const out = { ios: DaimondIdentity.ios(), home: DaimondIdentity.homeScreen(), recFirst: DaimondIdentity.recoverable() };
		// The harness saved the file, so the step was not owed: it must not have shown.
		const seen = JSON.parse(sessionStorage.getItem('__dlgTexts') || '[]');
		out.cards = seen.length;
		out.homeShownWhileRecoverable = seen.some((x) => /starts empty/.test(x));
		DaimondStore.remove('daimond-id-recover');
		const run = DaimondAdmin.recover();
		const texts = [];
		for (let i = 0; i < 4; i++) {
			const c = await wait(() => { const m = document.querySelectorAll(sel); return m.length ? m[m.length - 1] : null; });
			if (!c) break;
			const txt = c.textContent || '';
			texts.push(txt);
			if (/starts empty/.test(txt)) { c.querySelector('.dlg-ok').click(); break; }
			(c.querySelector('.dlg-cancel') || c.querySelector('.dlg-ok')).click();	// the passkey or the file: not now
			await new Promise((r) => setTimeout(r, 300));
		}
		out.texts = texts;
		out.pair = !!(await wait(() => document.querySelector('.pair-scrim')));
		await Promise.race([run, new Promise((r) => setTimeout(r, 1500))]);
		return out;
	});
	const step = (shown.texts || []).find((x) => /starts empty/.test(x)) || '';
	check('D1 an iOS tab is iOS and not the Home Screen', shown.ios && !shown.home, JSON.stringify({ ios: shown.ios, home: shown.home }));
	check('D2 unrecoverable: the step says the Home Screen app starts empty and is paired from here',
		/starts empty/.test(step) && /Pair with your other Daimond/.test(step), JSON.stringify(shown.texts).slice(0, 400));
	check('D3 its OK opens the pairing code (pairing.js showLink)', shown.pair);
	check('D4 recoverable: the step is not shown', shown.recFirst === 'file' && !shown.homeShownWhileRecoverable, `rec ${shown.recFirst}, seen ${shown.cards}`);
	await s.browser.close().catch(() => {});
}
{
	const s = await open({ name: 'recover_d5', signIn: false, connect: false, defaults: false,
		route: async (page) => { await page.addInitScript(IOS(true)); } });
	const p = s.page;
	await p.waitForFunction(() => { const m = document.getElementById('identity-modal'); return m && m.style.display === 'flex'; }, null, { timeout: 30000 }).catch(() => {});
	const d = await p.evaluate(() => {
		const box = document.getElementById('id-pairfirst'), form = document.getElementById('id-form');
		return { home: DaimondIdentity.homeScreen(), exists: DaimondIdentity.exists(), box: !!box,
			before: !!(box && form && (box.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING)),
			text: box ? box.textContent : '' };
	});
	check('D5 a Home Screen app with no identity offers pairing before Create', d.home && !d.exists && d.box && d.before
		&& /Pair with your other Daimond/.test(d.text), JSON.stringify(d));
	await s.browser.close().catch(() => {});
}

console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
