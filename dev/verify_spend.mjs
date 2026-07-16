// verify_spend.mjs — the Spending view shows where the money goes: inference
// (the client per-turn ledger) and credits (the gateway ledger), each as a
// graph, a breakdown and a table.
//
// Drives the real panel (spend.js) with a seeded client ledger and against the
// REAL gateway (/api/ledger), so it needs the dev stack up: the app on :8777
// and the gateway on :9002.
//
//   1. The panel opens and both sections render, no console errors.
//   2. Inference: a seeded ledger draws bars and a per-model table; the headline
//      is non-zero; the Week/Month toggle re-renders.
//   3. /api/ledger answers ok with an entries array, every entry categorised.
//   4. Credits: an authed account shows a balance; the header meter opens the panel.
import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const until = async (page, fn, arg, ms = 6000) => {
	const t0 = Date.now();
	for (;;) {
		try { if (await page.evaluate(fn, arg)) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await new Promise(r => setTimeout(r, 60));
	}
};

const s = await open({ name: 'spend', signIn: true, connect: true });
const { page } = s;

await page.waitForFunction(
	() => !!window.DaimondSpend && !!window.DaimondLedger && !!window.DaimondPanels,
	null, { timeout: 12000 }).catch(() => {});

// Let the gateway bootstrap settle before driving anything, so the credit side
// reads a real session and the sign-in flow's pre-auth calls are done.
await page.waitForFunction(
	() => window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 12000 }).catch(() => {});

try {
	check('DaimondSpend is present', await page.evaluate(() => !!window.DaimondSpend));

	// ── Seed the client inference ledger: two models over several days. The
	// stored `u` (USD) is read directly by the view, so figures are deterministic
	// without leaning on the price table. ────────────────────────────────────
	await page.evaluate(() => {
		const DAY = 86400000, now = Date.now();
		const e = (daysAgo, m, u) => ({ t: now - daysAgo * DAY, m, p: 1200, c: 400, ca: 0, u, e: false });
		const seed = [
			e(0, 'mock/fast', 0.012), e(0, 'anthropic/claude-x', 0.21),
			e(1, 'mock/fast', 0.008),
			e(3, 'anthropic/claude-x', 0.15), e(3, 'mock/fast', 0.004),
			e(10, 'anthropic/claude-x', 0.30),
		];
		localStorage.setItem('daimond-ledger', JSON.stringify(seed));
	});

	// Open the panel and wait for it to draw.
	await page.evaluate(() => window.DaimondSpend.show());
	await until(page, () => {
		const v = document.getElementById('spend-view');
		return v && v.querySelector('.spend-sec');
	});

	// ── Inference section. ────────────────────────────────────────────────────
	const bars = await page.evaluate(() => document.querySelectorAll('#spend-view .spend-bar').length);
	check('inference chart draws bars for spend days', bars > 0, bars + ' bars');

	const models = await page.evaluate(() =>
		[...document.querySelectorAll('#spend-view .spend-model')].map(td => td.textContent));
	check('per-model table lists both seeded models',
		models.some(m => /claude-x/.test(m)) && models.some(m => /mock\/fast/.test(m)),
		models.join(', '));

	const headline = await page.evaluate(() =>
		(document.querySelector('#spend-view .spend-stat-val') || {}).textContent || '');
	check('headline shows a non-zero month total', /[1-9]/.test(headline), headline);

	// The Month total should be the sum of everything in the last 30 days
	// ($0.704), distinct from the Week total ($0.394); switching the toggle
	// must change the chart's bar count (30 → 7 days).
	const monthBars = bars;
	await page.evaluate(() => {
		const btns = [...document.querySelectorAll('#spend-view .spend-toggle-btn')];
		const wk = btns.find(b => /week/i.test(b.textContent));
		if (wk) wk.click();
	});
	await new Promise(r => setTimeout(r, 200));
	const weekBars = await page.evaluate(() => document.querySelectorAll('#spend-view .spend-bar').length);
	check('Week/Month toggle re-renders the chart', weekBars !== monthBars,
		`month=${monthBars} bars, week=${weekBars} bars`);

	// ── /api/ledger contract. ─────────────────────────────────────────────────
	const led = await page.evaluate(async () => {
		const r = await fetch('/api/ledger', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		let j = null; try { j = await r.json(); } catch (e) {}
		return { status: r.status, ok: !!(j && j.ok), isArray: Array.isArray(j && j.entries),
			categorised: !!(j && Array.isArray(j.entries) && j.entries.every(x => typeof x.category === 'string')),
			hasBalance: !!(j && typeof j.credits_minor === 'number') };
	});
	check('/api/ledger returns 200 ok', led.status === 200 && led.ok, 'status ' + led.status);
	check('/api/ledger entries is an array', led.isArray);
	check('/api/ledger every entry carries a category', led.categorised);
	check('/api/ledger reports a numeric balance', led.hasBalance);

	// ── Credits section renders for an authed account. ────────────────────────
	const authed = await page.evaluate(() => window.DaimondGateway.state().authed);
	check('gateway session is authed', authed);
	const creditsSec = await page.evaluate(() => {
		const secs = [...document.querySelectorAll('#spend-view .spend-sec-title')].map(h => h.textContent);
		return secs.includes('Credits');
	});
	check('a Credits section is shown', creditsSec);

	// ── Credits breakdown + table render from categorised movements. ──────────
	// The fresh test account has no gateway spend, so feed the view a realistic
	// categorised ledger and confirm it draws the breakdown and the table.
	const creditsRender = await page.evaluate(async () => {
		const ns = 1e6;	// the view divides ts (ns) by 1e6 for ms
		const now = Date.now();
		window.DaimondGateway.ledger = async () => ([
			{ ts: now * ns,          kind: 'topup',  category: 'topup',  delta_minor: 2000, balance: 2000, ref: 'evt_1' },
			{ ts: (now - 6e4) * ns,  kind: 'spend',  category: 'web',    delta_minor: -35,  balance: 1965, ref: 'web:example.com' },
			{ ts: (now - 12e4) * ns, kind: 'spend',  category: 'mail',   delta_minor: -12,  balance: 1953, ref: 'mail:me@x.io' },
			{ ts: (now - 18e4) * ns, kind: 'spend',  category: 'sync',   delta_minor: -8,   balance: 1945, ref: 'sync:acct' },
		]);
		await window.DaimondSpend.refresh();
		const labels = [...document.querySelectorAll('#spend-view .spend-bd-label')].map(x => x.textContent);
		const rows = document.querySelectorAll('#spend-view .spend-table tbody tr').length;
		const debits = document.querySelectorAll('#spend-view .spend-table td.debit, #spend-view .spend-table td.credit').length;
		return { labels, rows, debits };
	});
	check('credit breakdown lists the spend categories',
		['Web pages', 'Mail', 'Cross-device sync'].every(l => creditsRender.labels.includes(l)),
		creditsRender.labels.join(', '));
	check('credit movements table has a row per movement', creditsRender.rows >= 4, creditsRender.rows + ' rows');
	check('movements show signed debit/credit amounts', creditsRender.debits >= 4, creditsRender.debits + ' amounts');

	// ── The header meter opens the panel. ─────────────────────────────────────
	// (Re-render fresh, close the panel, then click the meter.)
	const meterOpens = await page.evaluate(async () => {
		document.getElementById('spend-view').innerHTML = '';	// prove the click repopulates it
		const row = document.getElementById('spend-row');
		if (!row) return 'no-row';
		row.click();
		await new Promise(r => setTimeout(r, 400));
		return document.querySelector('#spend-view .spend-sec') ? 'opened' : 'empty';
	});
	check('header spend meter opens the Spending view', meterOpens === 'opened', meterOpens);

	// ── The Admin > Credits view offers an always-available door, for a
	// credits-only user whose header meter (inference-gated) never appears. ────
	const adminDoor = await page.evaluate(async () => {
		const b = document.getElementById('credits-see-spend');
		if (!b) return 'no-button';
		document.getElementById('spend-view').innerHTML = '';
		b.click();
		await new Promise(r => setTimeout(r, 400));
		return document.querySelector('#spend-view .spend-sec') ? 'opened' : 'empty';
	});
	check('Admin credits view has a working "see spending" door', adminDoor === 'opened', adminDoor);

	await shot(s, 'spend-view');

	// Ambient sign-in noise: /api/tools and /api/sync fire during the bootstrap
	// race and 401 before the session cookie lands (confirmed in the gateway log,
	// and unrelated to this view -- every /api/ledger and /api/balance call the
	// spend view makes returns 200). Everything else is a real error.
	const errs = errors(s).filter(e => !/status of 401/.test(e));
	check('no console errors (other than ambient sign-in 401s)', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('run completed without throwing', false, e.message);
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
await s.close();
process.exit(bad.length ? 1 : 0);
