/* ============================================================
   Test -- r543 QA A2, F-A2-2: one bill per attempt, so a re-keyed attempt's
   tokens reach the ledger.
   ------------------------------------------------------------
   A worker or a chat turn whose key is refused mid-turn (a 402 from a key at its
   cap) is re-keyed and run again on a NEW app. The bill read only the app that
   stood at the end, so the rounds the dead attempt had already spent never
   reached the ledger; a chat's three rebuilds (reply-length back-off, re-mint,
   the turn-start raise) had the same shape.

   The fix bills each attempt as its own entry under the same turn, the dying
   app's spend recorded before it is replaced, and never bills an app twice.

   Runs the REAL ledger.js and the REAL `recordSpend`, `appSpend`,
   `billChatSpend` and `rebuildAppWithout`, lifted out of daimond.js, and the
   worker's own `billAttempt`, lifted out of its block.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { loadStore } from './storefixture.mjs';

const LEDGER = readFileSync(new URL('./ledger.js', import.meta.url), 'utf8');
const DAIMOND = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};

function lift(name) {
	let a = DAIMOND.indexOf('\tfunction ' + name + '(');
	if (a < 0) a = DAIMOND.indexOf('\tasync function ' + name + '(');
	const b = DAIMOND.indexOf('\n\t}\n', a);
	if (a < 0 || b < 0) return null;
	return DAIMOND.slice(a, b + 3);
}

// The worker's own biller, a closure inside its block.
function liftWorker() {
	const a = DAIMOND.indexOf('var wbilled = null;');
	const b = DAIMOND.indexOf('\n\t\t\t};', a);
	if (a < 0 || b < 0) return null;
	return DAIMOND.slice(a, b + 6);
}

// A stand-in DaimondApp: the four cumulative counters the wasm keeps, and a turn
// that adds one attempt's rounds to them.
function fakeApp(p, c, ca, cost) {
	return { prompt_tokens: p || 0, completion_tokens: c || 0, cached_tokens: ca || 0, cost_usd: cost || 0,
		spend(dp, dc, dca, dcost) {
			this.prompt_tokens += dp; this.completion_tokens += dc;
			this.cached_tokens += dca; this.cost_usd += dcost;
		} };
}

function device() {
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};
	loadStore(win, localStorage);
	new Function('window', 'localStorage', LEDGER)(win, localStorage);
	const clock = { now: Date.UTC(2026, 9, 9, 6, 0, 0) };
	const fakeDate = { now: () => { clock.now += 7; return clock.now; } };
	const names = ['recordSpend', 'appSpend', 'billChatSpend', 'rebuildAppWithout'];
	const srcs = names.map(lift);
	const missing = names.filter((n, i) => !srcs[i]);
	// `ensureApp` restores the session it is given: with a transcript to restore, the
	// counters come back at the chat's totals and the baseline with them; with none (a
	// chat's first turn, whose only message is the prompt held out), a fresh app at zero.
	const ensureApp = (chat) => {
		const hist = chat.messages.length > 0;
		chat.app = hist ? fakeApp(chat.promptTokens, chat.completionTokens, chat.cachedTokens, chat.costUsd)
			: fakeApp();
		if (hist) {
			chat.prevPrompt = chat.promptTokens || 0; chat.prevCompletion = chat.completionTokens || 0;
			chat.prevCached = chat.cachedTokens || 0; chat.prevCost = chat.costUsd || 0;
		}
		return chat.app;
	};
	const fns = missing.length ? {} : new Function('window', 'DaimondLedger', 'Date', 'writeUsageDigest',
		'ensureApp', 'scopeTurnApp',
		srcs.join('') + '\nreturn { recordSpend, appSpend, billChatSpend, rebuildAppWithout };')(
		win, win.DaimondLedger, fakeDate, () => {}, ensureApp, async () => {});
	const rows = () => win.DaimondStore.get('daimond-ledger', []);
	return { L: win.DaimondLedger, clock, fakeDate, rows, missing, ...fns };
}

const sum = (rows, k) => rows.reduce((s, e) => s + (e[k] || 0), 0);

for (const hist of [true, false]) {
	console.log('chat: a 402 after two rounds, re-minted and run again'
		+ (hist ? ' (a chat with a transcript)' : " (a chat's first turn)"));
	const D = device();
	check('the chat billers are in daimond.js', !D.missing.length, 'missing: ' + D.missing.join(', '));
	if (D.missing.length) continue;
	const U = 'umid-1';
	// Totals and baseline as the last turn left them; the dying app restored to them.
	const base = hist ? [1000, 100, 0, 0.01] : [0, 0, 0, 0];
	const chat = { model: 'm', provider: 'openrouter', diamondId: '', _generating: true,
		messages: hist ? [{ mid: 'old', role: 'user' }, { mid: U, role: 'user' }] : [{ mid: U, role: 'user' }],
		promptTokens: base[0], completionTokens: base[1], cachedTokens: base[2], costUsd: base[3],
		prevPrompt: base[0], prevCompletion: base[1], prevCached: base[2], prevCost: base[3] };
	const app1 = fakeApp(...base);
	chat.app = app1; chat._runApp = app1;
	app1.spend(5000, 300, 1000, 0.03);		// attempt 1: two rounds, then the 402
	const app2 = await D.rebuildAppWithout(chat, U);
	check('the rebuild hands back a new app', app2 && app2 !== app1);
	app2.spend(7000, 500, 2000, 0.05);		// attempt 2 completes
	const fin = D.billChatSpend(chat, app2, U);
	const mine = D.rows().filter((e) => e.tid === U);
	check('two entries under the turn, one per attempt', mine.length === 2, JSON.stringify(D.rows()));
	check('their prompt tokens sum to both attempts\'', sum(mine, 'p') === 12000, 'p=' + sum(mine, 'p'));
	check('their completion tokens sum to both attempts\'', sum(mine, 'c') === 800, 'c=' + sum(mine, 'c'));
	check('their cost sums to both attempts\'', Math.abs(sum(mine, 'u') - 0.08) < 1e-9, 'u=' + sum(mine, 'u'));
	check('nothing else was billed (no double count)', D.rows().length === 2, 'rows=' + D.rows().length);
	check('the turn closes on the last attempt\'s entry', fin && fin.entry && fin.entry.p === 7000,
		JSON.stringify(fin));
	check('the chat\'s totals carry both attempts', chat.promptTokens === base[0] + 12000
		&& chat.completionTokens === base[1] + 800, chat.promptTokens + '/' + chat.completionTokens);
	// A second bill of the same app, as a turn's `finally` makes, finds nothing new.
	const again = D.billChatSpend(chat, app2, U);
	check('billing the same app again bills nothing', !again.entry && D.rows().length === 2,
		JSON.stringify(again));
}

console.log('chat: a rebuild before any round (the turn-start raise) bills nothing');
{
	const D = device();
	if (!D.missing.length) {
		const chat = { model: 'm', provider: 'openrouter', diamondId: '', _generating: true,
			messages: [{ mid: 'u2', role: 'user' }], promptTokens: 0, completionTokens: 0, cachedTokens: 0,
			costUsd: 0, prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0 };
		chat.app = chat._runApp = fakeApp();
		await D.rebuildAppWithout(chat, 'u2');
		check('no entry for an attempt that spent nothing', D.rows().length === 0, JSON.stringify(D.rows()));
	}
}

console.log('worker: a 402 mid-turn, re-minted, run again; the `finally` bills last');
{
	const D = device();
	const src = liftWorker();
	check("the worker's biller is in its block", !!src);
	if (src && !D.missing.length) {
		const run = { model: 'm', provider: 'openrouter', diamondId: 'd1', prov: { rid: 'rid-1' }, app: null };
		const meters = [{ facts: () => ({ tc: 3, ro: 'w' }) }, { facts: () => ({ tc: 5, ro: 'w' }) }];
		const env = { wmeter: null };
		const Wk = new Function('run', 'recordSpend', 'appSpend', 'env',
			src.replace(/\bwmeter\b/g, 'env.wmeter')
			+ '\nreturn { bill: billAttempt, spent: typeof wspent === "undefined" ? null : wspent };')
			(run, D.recordSpend, D.appSpend, env);
		const W = Wk.bill;
		run.app = fakeApp(); env.wmeter = meters[0];
		run.app.spend(5000, 300, 0, 0.03);
		W();									// before the rebuild
		run.app = fakeApp(); env.wmeter = meters[1];
		run.app.spend(7000, 500, 0, 0.05);
		W();									// the `finally`
		W();									// a second call never bills twice
		const mine = D.rows().filter((e) => e.tid === 'rid-1');
		check('two entries under the run id', mine.length === 2, JSON.stringify(D.rows()));
		check('their tokens sum to both attempts\'', sum(mine, 'p') === 12000 && sum(mine, 'c') === 800,
			sum(mine, 'p') + '/' + sum(mine, 'c'));
		// The `finally` adds the session's spend to the run's totals and the feed: every
		// attempt's, not the last app's alone, and never a name the biller kept to itself
		// (the turnfacts R regression: `_pt is not defined` threw out of the `finally`).
		const sp = Wk.spent;
		check('the session spend sums both attempts', !!sp && sp.p === 12000 && sp.c === 800
			&& Math.abs(sp.cost - 0.08) < 1e-9, JSON.stringify(sp));
		check('each entry carries its own attempt\'s facts', mine.some((e) => e.p === 5000 && e.tc === 3)
			&& mine.some((e) => e.p === 7000 && e.tc === 5), JSON.stringify(mine));
	}
}

console.log("daimond.js: where each attempt is billed");
{
	const a = DAIMOND.indexOf('var wmeter = null;');
	const fin = DAIMOND.indexOf('} finally {', DAIMOND.indexOf('await runTurnCapped(run.task);', a));
	const blk = DAIMOND.slice(a, fin);
	const rm = blk.indexOf('DaimondModels.remintSlot(');
	const bill = blk.indexOf('billAttempt();', rm);
	const rebuild = blk.indexOf('build();', rm);
	check('the worker bills the dying app after its re-mint and before the rebuild',
		rm > 0 && bill > rm && rebuild > bill, [rm, bill, rebuild].join(','));
	const fblk = DAIMOND.slice(fin, DAIMOND.indexOf('run.report', fin));
	check("the worker's `finally` bills through the same biller", /\bbillAttempt\(\);/.test(fblk)
		&& !/recordSpend\(/.test(fblk), fblk.slice(0, 200));
	const tot = DAIMOND.slice(fin, DAIMOND.indexOf("dsEvent('worker'", DAIMOND.indexOf('this.settleAwaits(run);', fin)));
	check("the `finally` totals the session's spend, not names local to the biller",
		/run\.promptTokens = \(run\.priorPrompt \|\| 0\) \+ wspent\.p;/.test(tot)
			&& !/\b_(pt|ct|ca|cost)\b/.test(DAIMOND.slice(fin, DAIMOND.indexOf('this.active--;', fin))));
	const rb = lift('rebuildAppWithout') || '';
	check('a chat rebuild bills the app it replaces before it builds the next',
		rb.indexOf('billChatSpend(') > 0 && rb.indexOf('billChatSpend(') < rb.indexOf('ensureApp('));
	check("the chat's turn-end bill is the same biller", /turnSpent = billChatSpend\(chat, app, umid\)/.test(DAIMOND)
		|| /billChatSpend\(chat, app, umid\)/.test(DAIMOND));
}

console.log(`\nattempt bill (r543 QA F-A2-2): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
