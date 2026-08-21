// verify_spendowner.mjs — spend is billed to the thing that SPENT it, not to
// whatever the rail happens to be showing when the money is counted.
//
// `recordSpend` attributed every metered turn to `currentDiamond && currentDiamond.id`.
// All three of its callers reach it after an await, so the figure on a Diamond tile
// -- the one whose own stylesheet comment says it exists to answer "which Diamond is
// eating the money" -- recorded where the USER was, not where the WORK was:
//
//   * a Diamond fans four workers out and the user goes to look at another
//     Diamond. Each worker lands and is billed to whatever is on screen. That is
//     not an edge case; leaving a fan-out running is what a fan-out is FOR;
//   * the user opens an ordinary chat instead. `selectChat` nulls the global with
//     the comment "a chat is not a Diamond", so the same spend is billed to nobody;
//   * and the chat's own turn, landing while a Diamond is open behind it, was
//     billed to that Diamond -- money spent on a conversation it had never seen.
//
// Measured before the fix, in this world, with the real page: a worker dispatched by
// `0da1000000f2` and landing while `0da1000000e1` was selected went into the index as
//   {"0da1000000e1":{"turns":1,"usd":0.0000372}}
//
// THE CHECK THAT MATTERS IS ATTRIBUTION UNDER NAVIGATION, and it must not be
// passable by accident. Every attribution check here is paired with a CONTROL that
// reads back what was selected at the instant the money was counted -- through
// `DaimondDiamond.current()`, which is the very global the defect read -- so a run
// where the work landed before the user moved fails as loudly as a wrong id.
//
// It also holds the invariant behind `maxOutCeiling`'s note (defect M): `modelFamily`
// still resolves by containment where `DaimondPricing.contextWindow` no longer does,
// and that is only safe while every `MAX_OUT` row sits at or below its model's
// published window, which is what makes a borrowed ceiling tighten rather than widen.
// That is data, so it is checked rather than argued about.
//
//   node dev/verify_spendowner.mjs --break onscreen    # the defect, exactly as it was
//   node dev/verify_spendowner.mjs --break workerarg   # the worker forgets its Diamond
//   node dev/verify_spendowner.mjs --break meterarg    # the daimon turn forgets its own
//   node dev/verify_spendowner.mjs --break maxoutwide  # a ceiling above its own window
//   node dev/verify_spendowner.mjs --break ceilwins    # the ceiling widens instead of tightening
//   node dev/verify_spendowner.mjs                     # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { open, newChat, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const die = (why) => { console.error('ABORT: ' + why); process.exit(2); };

// ── The breaks ─────────────────────────────────────────────────────
//
// Each restores ONE half of the defect in the source text of `daimond.js` as it is
// SERVED to the page, so what runs is the shipped file with one line changed rather
// than a copy of it. Three, not one, because the fix has three independent halves
// and a single break reddening all of them would not say which one was missing.
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = {
	onscreen: {
		what: 'recordSpend reads the selected Diamond again — the defect as it shipped',
		edit: (src) => src.replace(
			'\t\t\t\t\tdiamondId: diamondId || \'\',',
			'\t\t\t\t\tdiamondId: (currentDiamond && currentDiamond.id) || \'\','),
	},
	workerarg: {
		what: 'a worker stops naming the Diamond that dispatched it',
		edit: (src) => src.replace(
			'recordSpend(run.model, _pt, _ct, _ca, _cost, run.provider, run.diamondId || \'\');',
			'recordSpend(run.model, _pt, _ct, _ca, _cost, run.provider);'),
	},
	meterarg: {
		what: 'a daimon turn stops naming its own Diamond',
		edit: (src) => src.split('meterDiamondTurn(fa, diamondId);').join('meterDiamondTurn(fa);'),
	},
	maxoutwide: {
		what: 'a MAX_OUT ceiling above its own model\'s window, so a borrowed one could widen',
		pure: true,
		edit: (src) => src.replace(
			'\t\t\'claude-opus-4-1\':    32000,',
			'\t\t\'claude-opus-4-1\':   320000,'),
	},
	ceilwins: {
		what: 'maxOutCeiling takes the LARGER of the table row and the window, so a borrowed'
			+ ' ceiling widens instead of tightening',
		pure: true,
		edit: (src) => src.replace(
			'\t\tif (pub && ctx) return Math.min(pub, ctx);',
			'\t\tif (pub && ctx) return Math.max(pub, ctx);'),
	},
};
if (BREAK && !BREAKS[BREAK]) die(`no break called "${BREAK}"`);
if (BREAK) console.log(`\n*** BREAK ${BREAK}: ${BREAKS[BREAK].what} — failures below are the point ***\n`);

const SRC = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
const BROKEN = BREAKS[BREAK] ? BREAKS[BREAK].edit(SRC) : SRC;
if (BREAK && BROKEN === SRC) die(`the "${BREAK}" break no longer matches www/js/daimond.js`);

// ══════════════════════════════════════════════════════════════════
//  1. Two resolvers, one table (defect M) — pure, no browser
// ══════════════════════════════════════════════════════════════════
//
// `modelFamily` and its ceiling table are read OUT OF THE SOURCE rather than
// re-typed here. A copy would go stale the day a model is added, which is the same
// failure mode -- a second list of the same facts -- that the note in `maxOutCeiling`
// is about.
console.log('\n1. modelFamily, MAX_OUT and the tightening property\n');

const cut = (label, re) => {
	const m = BROKEN.match(re);
	if (!m) die(`could not find ${label} in www/js/daimond.js; the anchor has moved`);
	return m[0];
};
const MAX_OUT_SRC     = cut('the MAX_OUT table', /\tvar MAX_OUT = \{[\s\S]*?\n\t\};/);
const MODELFAMILY_SRC = cut('modelFamily',       /\tfunction modelFamily\(model\) \{[\s\S]*?\n\t\}/);
const CEILING_SRC     = cut('maxOutCeiling',     /\tfunction maxOutCeiling\(model, provider\) \{[\s\S]*?\n\t\}/);

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WWW, 'js/pricing.js'), 'utf8'), sandbox);
// `window` is the global object in a browser, so the extracted source reaches
// `DaimondPricing` bare. In a sandbox it is a property, hence the alias.
vm.runInContext('var DaimondPricing = window.DaimondPricing;', sandbox);
vm.runInContext(`${MAX_OUT_SRC}\n${MODELFAMILY_SRC}\n${CEILING_SRC}\n`
	+ 'this.MAX_OUT = MAX_OUT; this.modelFamily = modelFamily; this.maxOutCeiling = maxOutCeiling;',
	sandbox);
const { MAX_OUT, modelFamily, maxOutCeiling } = sandbox;
const C = sandbox.window.DaimondPricing._core;

// Every canonical id and every alias must land on ITSELF. Containment is only ever
// a fallback, and a table that collides with itself would have it deciding cases it
// was never meant to see.
{
	const wrong = [];
	for (const id of Object.keys(C.TABLE)) {
		if (modelFamily(id) !== id) wrong.push(`${id} -> ${modelFamily(id) || '(nothing)'}`);
		for (const a of (C.TABLE[id].alias || [])) {
			if (modelFamily(a) !== id) wrong.push(`${a} -> ${modelFamily(a) || '(nothing)'}`);
		}
	}
	check('every table id and alias resolves to itself', wrong.length === 0, wrong.slice(0, 3).join('; '));
}

// A MAX_OUT key that is not a table id is a ceiling nothing can ever reach:
// `modelFamily` answers canonical ids, so a typo here is silently dead.
{
	const orphans = Object.keys(MAX_OUT).filter(k => !C.TABLE[k]);
	check('every MAX_OUT key is a real table id', orphans.length === 0, orphans.join(', '));
}

// THE INVARIANT THE NOTE RESTS ON. `maxOutCeiling` takes `min(pub, ctx)`, so a
// borrowed ceiling can only ever be smaller than the answer with no row at all --
// which is what makes a wrong containment hit degrade into a shorter reply, said
// out loud by `capCut`, rather than into a request the provider refuses.
{
	const over = Object.keys(MAX_OUT).filter((k) => {
		const ctx = C.TABLE[k] && C.TABLE[k].ctx;
		return ctx == null || MAX_OUT[k] > ctx;
	}).map(k => `${k}: out ${MAX_OUT[k]} > ctx ${(C.TABLE[k] || {}).ctx}`);
	check('every MAX_OUT ceiling sits at or below its model\'s window',
		over.length === 0, over.join('; '));
}

// And the property itself, measured on the real function rather than reasoned about:
// for every drifted id that containment places on a MAX_OUT row, the ceiling it
// yields must be no larger than the one the same id would get with no row at all.
//
// A PUBLISHED WINDOW HAS TO BE IN PLAY OR THIS CHECK IS VACUOUS. `contextWindow`
// answers null for a containment-only id -- that was defect 6's whole fix -- so with
// no provider the comparison degenerates to "a number is smaller than no ceiling",
// which is true of anything and proves nothing. So a provider IS supplied, with a
// window under every MAX_OUT row, which is the only arrangement in which the two
// answers can differ at all: `min(pub, ctx)` against `ctx`.
{
	const LIVE_CTX = 50000;             // below every MAX_OUT row, so `min` has work to do
	sandbox.window.DaimondModels = {
		rateFor: (provider, model) => (provider ? { inPerM: 1, outPerM: 1, ctx: LIVE_CTX } : null),
	};
	const ids = [...Object.keys(C.TABLE), ...Object.values(C.TABLE).flatMap(e => e.alias || [])];
	const drift = ['-20251001', '@20260101', '-latest', '-thinking', ':free', '-1', '-3', '.3', '.7'];
	const pre   = ['anthropic/', 'us.anthropic.', 'openrouter/'];
	const probes = [];
	for (const b of ids) { for (const d of drift) probes.push(b + d); for (const p of pre) probes.push(p + b); }
	const hits = probes.filter(m => !C.INDEX[C.norm(m)] && MAX_OUT[modelFamily(m)]);
	const widened = hits.filter((m) => {
		// What the id would get with no borrowed row: the window the provider published.
		const without = sandbox.window.DaimondPricing.contextWindow(m, 'live') || 0;
		return maxOutCeiling(m, 'live') > without;
	});
	check('a borrowed output ceiling can only tighten, never widen',
		widened.length === 0 && hits.length > 0,
		`${hits.length} containment hits examined against a ${LIVE_CTX} window, `
		+ `${widened.length} widened` + (widened.length ? ': ' + widened.slice(0, 3).join(', ') : ''));
	delete sandbox.window.DaimondModels;
}

if (BREAKS[BREAK] && BREAKS[BREAK].pure) {
	// A pure break says nothing about the browser half, so the browser half is not
	// run: a page reporting green under a break aimed elsewhere reads as a pass.
	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  ' + bad.join('\n  '));
	console.log(bad.length ? '\nTHE BREAK WAS CAUGHT.' : '\nTHE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(bad.length ? 0 : 1);
}

// ══════════════════════════════════════════════════════════════════
//  2. Attribution under navigation — the real page
// ══════════════════════════════════════════════════════════════════

const s = await open({
	name:  'spendowner' + (BREAK ? '-' + BREAK : ''),
	route: BREAK ? (async (page) => {
		await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: BROKEN,
		}));
	}) : null,
});
const p = s.page;

await p.waitForFunction(() => !!window.DaimondSignals && !!window.DaimondWorkers
	&& !!window.DaimondDiamond && !!window.DaimondModels, null, { timeout: 20000 });

// The two Diamonds the app seeds on a first boot. Named A and B here and nowhere
// else: which is which does not matter, only that they are two.
const [A, B] = await p.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box')].map(b => b.dataset.id));
if (!A || !B || A === B) die('this world does not hold two Diamonds to navigate between');

// THE INSTRUMENT. Every call into the index is recorded with what was SELECTED at
// that instant, read through `DaimondDiamond.current()` -- the same global the
// defect read. Without this the checks below could pass on a run where the work
// landed before the user moved, and prove nothing whatever.
const spy = async () => p.evaluate(() => window.__spendSpy.slice());
const armSpy = () => p.evaluate(() => {
	if (!window.__spendSpyOn) {
		window.__spendSpyOn = true;
		const real = window.DaimondSignals.noteTurn;
		window.DaimondSignals.noteTurn = function (ev) {
			const cur = window.DaimondDiamond.current();
			window.__spendSpy.push({
				billed:   (ev && ev.diamondId) || '',
				onScreen: cur ? cur.id : '',
				usd:      (ev && ev.usd) || 0,
			});
			return real.apply(this, arguments);
		};
	}
	window.__spendSpy = [];
	window.DaimondSignals.reset();
});
const goDiamond = (id) => p.evaluate((i) => {
	// `el.click()`, not Playwright's: headless Chrome without a display gives the
	// rail no frame to consider stable, and the actionability wait never resolves.
	document.querySelector(`#diamond-list .diamond-box[data-id="${i}"]`).click();
}, id);
const waitSpy = async (n, ms = 30000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if ((await p.evaluate(() => window.__spendSpy.length)) >= n) return true;
		await p.waitForTimeout(200);
	}
	return false;
};
const pick = await p.evaluate(() => {
	const r = window.DaimondModels.resolve('', '');
	return r ? { provider: r.provider, model: r.model } : null;
});
if (!pick) die('no model is connected in this world, so nothing can spend anything');

// ── 2a. A worker of A's, landing while B is on screen ──────────────
console.log('\n2. a worker lands while another Diamond is on screen\n');
{
	await armSpy();
	await goDiamond(A);
	await p.waitForTimeout(200);
	await p.evaluate(({ A, pick }) => window.DaimondWorkers.dispatch(
		A, 'A', [{ name: 'away', task: '@slow 5000' }], false, pick, 0), { A, pick });
	await p.waitForTimeout(700);
	await goDiamond(B);
	await p.waitForTimeout(300);
	const during = await p.evaluate(() => ({
		sel: (window.DaimondDiamond.current() || {}).id || '',
		running: window.DaimondWorkers.runs.filter(r => r.status === 'running' || r.status === 'queued').length,
	}));
	check('the control: the worker was still running when B came up',
		during.running > 0 && during.sel === B, JSON.stringify(during));

	const landed = await waitSpy(1);
	const rows = await spy();
	check('the worker\'s spend was recorded at all', landed && rows.length === 1,
		JSON.stringify(rows));
	// THE CONTROL. Without this the next check passes on a run where the worker
	// finished before the click, which is a different test entirely.
	check('the control: B was the Diamond on screen when the money was counted',
		rows.length === 1 && rows[0].onScreen === B, JSON.stringify(rows[0] || null));
	check('the worker was billed to A, the Diamond that dispatched it',
		rows.length === 1 && rows[0].billed === A, JSON.stringify(rows[0] || null));

	const ix = await p.evaluate(() => window.DaimondSignals.snapshot().diamonds);
	check('and the index shows A spending and B untouched',
		!!(ix[A] && ix[A].usd > 0) && !ix[B], JSON.stringify(ix));
}

// ── 2b. A worker of A's, landing while an ordinary CHAT is on screen ──
console.log('\n3. a worker lands while an ordinary chat is on screen\n');
{
	await armSpy();
	await goDiamond(A);
	await p.waitForTimeout(200);
	await p.evaluate(({ A, pick }) => window.DaimondWorkers.dispatch(
		A, 'A', [{ name: 'away2', task: '@slow 5000' }], false, pick, 0), { A, pick });
	await p.waitForTimeout(700);
	await newChat(s);
	await p.waitForTimeout(300);
	const during = await p.evaluate(() => ({
		sel: (window.DaimondDiamond.current() || {}).id || '',
		running: window.DaimondWorkers.runs.filter(r => r.status === 'running' || r.status === 'queued').length,
	}));
	check('the control: the worker was still running when the chat came up',
		during.running > 0 && during.sel === '', JSON.stringify(during));

	await waitSpy(1);
	const rows = await spy();
	// `selectChat` nulls the global, so under the defect this landed on NOBODY.
	check('the control: no Diamond was selected when the money was counted',
		rows.length === 1 && rows[0].onScreen === '', JSON.stringify(rows[0] || null));
	check('the worker was still billed to A, not to nobody',
		rows.length === 1 && rows[0].billed === A, JSON.stringify(rows[0] || null));
}

// ── 2c. A daimon's own turn, metered while another Diamond is on screen ──
console.log('\n4. a daimon turn is metered while another Diamond is on screen\n');
{
	await armSpy();
	await goDiamond(A);
	await p.waitForTimeout(400);
	await p.evaluate(() => {
		const el = document.getElementById('chat-input');
		el.value = '@slow 5000';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('chat-send').click();
	});
	await p.waitForTimeout(900);
	await goDiamond(B);
	await p.waitForTimeout(300);
	check('the control: B was selected before the steer landed',
		(await p.evaluate(() => (window.DaimondDiamond.current() || {}).id || '')) === B);

	const landed = await waitSpy(1);
	const rows = await spy();
	check('the daimon turn\'s spend was recorded at all', landed && rows.length >= 1,
		JSON.stringify(rows));
	check('the control: B was on screen when the daimon turn was counted',
		rows.length >= 1 && rows[0].onScreen === B, JSON.stringify(rows[0] || null));
	check('the daimon turn was billed to A, whose daimon ran it',
		rows.length >= 1 && rows[0].billed === A, JSON.stringify(rows[0] || null));
}

// ── 2d. An ordinary chat's own turn, landing while a Diamond is on screen ──
console.log('\n5. an ordinary chat\'s turn lands while a Diamond is on screen\n');
{
	await armSpy();
	await newChat(s);
	await p.waitForTimeout(300);
	await p.evaluate(() => {
		const el = document.getElementById('chat-input');
		el.value = '@slow 5000';
		el.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('chat-send').click();
	});
	await p.waitForTimeout(900);
	await goDiamond(B);
	await p.waitForTimeout(300);
	check('the control: B was selected before the chat turn landed',
		(await p.evaluate(() => (window.DaimondDiamond.current() || {}).id || '')) === B);

	const landed = await waitSpy(1);
	const rows = await spy();
	check('the chat turn\'s spend was recorded at all', landed && rows.length >= 1,
		JSON.stringify(rows));
	check('the control: B was on screen when the chat turn was counted',
		rows.length >= 1 && rows[0].onScreen === B, JSON.stringify(rows[0] || null));
	// An ordinary chat is not a Diamond and has no row in this index, so the honest
	// answer is nobody. What it must NOT be is the Diamond the user wandered to.
	check('the chat turn was billed to nobody, not to the Diamond on screen',
		rows.length >= 1 && rows[0].billed === '', JSON.stringify(rows[0] || null));
	const ix = await p.evaluate(() => window.DaimondSignals.snapshot().diamonds);
	check('and B\'s row did not move for a conversation it never saw',
		!ix[B], JSON.stringify(ix));
}

const errs = errors(s).filter(e => !/favicon|401|402|502|Unauthorized|Payment|Bad Gateway/i.test(e));
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await s.close();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) console.log('  ' + bad.join('\n  '));
if (BREAK) {
	console.log(bad.length
		? '\nTHE BREAK WAS CAUGHT.'
		: '\nTHE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
