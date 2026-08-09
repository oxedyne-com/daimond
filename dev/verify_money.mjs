// verify_money.mjs -- whose money the rail is talking about.
//
// The rail carried one row, labelled "Credits", showing the balance held with
// Daimond. To somebody running on their own provider key it said
// **"Credits $0.00"** while that key was paying for every turn. The one number
// on screen about money told them they were broke, about money that was not
// theirs.
//
// The four rules, and each is a check here:
//
//   1. Never a bare "Credits". Every label names an owner.
//   2. The strongest true statement, and otherwise NOTHING. Exact, then an
//      estimate, then what has been spent -- and no row at all if none of those
//      is true. A dash sits where the answer goes and reads as zero.
//   3. Warn on runway, not on a threshold. $2 is fine at a penny an hour and
//      gone in ten minutes during a fan-out; only time can tell them apart.
//   4. At risk, show the CONSEQUENCE rather than the figure, so the reader is
//      not left doing the division.
//
// Pure: these are wording rules and they are tested without a browser.
//
//   node dev/verify_money.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (cond, msg, detail) => {
	if (!cond) failures++;
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail ? ' -- ' + detail : ''));
};

const mod = { exports: {} };
new Function('module', fs.readFileSync(path.join(ROOT, 'www/js/money.js'), 'utf8'))(mod);
const M = mod.exports;

const prov = (o) => Object.assign({ id: 'p', name: 'OpenAI', paid: false, hasKey: true,
	credit: null, spentUsd: 0 }, o);

// ══ THE BUG ITSELF ═════════════════════════════════════════════════
// An account with no Daimond balance, running on its own funded key. The old
// rail said "Credits $0.00" and nothing else.
{
	const rows = M.rows({
		authed: true, creditsUsd: 0, creditsLabel: 'Daimond credits',
		providers: [prov({ credit: { mode: 'auto', usd: 42.5 } })],
		rateUsdPerMin: 0.01,
	});
	const labels = rows.map(r => r.label);
	check(rows.some(r => /OpenAI/.test(r.label)),
		'the user’s own funded key gets a row of its own', labels.join(' | '));
	check(rows.every(r => r.label !== 'Credits'),
		'and no row is labelled just "Credits" -- every label says whose money it is',
		labels.join(' | '));
	const own = rows.find(r => /OpenAI/.test(r.label));
	check(own && own.usd === 42.5 && own.kind === 'exact',
		'the funded key reports its real balance', own && `${own.kind} ${own.usd}`);
	// The zero is still shown, because zero Daimond credits IS true and the row
	// now says which zero it is.
	const cr = rows.find(r => r.label === 'Daimond credits');
	check(!!cr && cr.usd === 0,
		'the Daimond balance is still reported, but now named', cr && String(cr.usd));
}

// ══ An EMPTY pot is not a pot running low ══════════════════════════
// Found by rendering it: zero divided by any rate is zero minutes, so the rail
// said "Daimond credits, ~1 min left at this rate" -- a prediction about money
// that had already gone -- beside a key with $42.50 on it.
{
	const r = M.rowFor({ label: 'Daimond credits', exactUsd: 0 }, 0.01);
	check(r.minutes === null && r.atRisk === false,
		'an empty pot makes no runway claim -- there is no future to predict',
		`${r.minutes} / ${r.atRisk}`);

	// Empty AND the only money there is: that is worth a warning.
	const alone = M.rows({ authed: true, creditsUsd: 0, creditsLabel: 'Daimond credits',
		providers: [], rateUsdPerMin: 0.01 });
	check(alone.length === 1 && alone[0].tone === 'warn' && alone[0].empty === true,
		'but empty with nothing else funding the work is', JSON.stringify(alone[0]));

	// Empty beside a funded key of the user's own: not a warning. Colouring it
	// would put a caution on the rail of somebody whose work is fully paid for.
	const beside = M.rows({ authed: true, creditsUsd: 0, creditsLabel: 'Daimond credits',
		providers: [prov({ credit: { mode: 'auto', usd: 42.5 } })], rateUsdPerMin: 0.01 });
	const cr2 = beside.find(x => x.label === 'Daimond credits');
	check(cr2 && cr2.tone === 'ok' && !cr2.atRisk,
		'and empty beside a funded key of your own is not',
		cr2 && `${cr2.tone} / ${cr2.atRisk}`);
}

// ══ Rule 2: the strongest true statement ═══════════════════════════
{
	const exact = M.rowFor({ label: 'Your key', exactUsd: 10, estimateUsd: 99, spentUsd: 99 }, null);
	check(exact.kind === 'exact' && exact.usd === 10,
		'an exact balance wins over an estimate', exact.kind);

	const est = M.rowFor({ label: 'Your key', exactUsd: null, estimateUsd: 7, spentUsd: 99 }, null);
	check(est.kind === 'estimate' && est.usd === 7,
		'an estimate wins over spend-to-date', est.kind);

	const spent = M.rowFor({ label: 'Your key', exactUsd: null, estimateUsd: null, spentUsd: 3 }, null);
	check(spent.kind === 'spent' && spent.usd === 3,
		'and spend-to-date is what is left when no balance can be known', spent.kind);

	const none = M.rowFor({ label: 'Your key', exactUsd: null, estimateUsd: null, spentUsd: 0 }, null);
	check(none === null,
		'with nothing true to say there is NO ROW -- a dash reads as zero to anyone scanning',
		String(none));
}

// A provider whose balance nobody can read, and which has been used. Most
// providers are this case, so it must not be the one that produces a blank.
{
	const rows = M.rows({
		authed: false,
		providers: [prov({ name: 'Anthropic', credit: null, spentUsd: 1.25 })],
		rateUsdPerMin: null,
	});
	check(rows.length === 1 && rows[0].kind === 'spent',
		'a key with no readable balance still says what it has cost',
		JSON.stringify(rows.map(r => r.kind)));
	check(!rows.some(r => r.label === 'Daimond credits'),
		'and an app with no account grows no Daimond row -- that would be an advert where a fact goes');
}

// ══ Rule 3: runway, not a threshold ════════════════════════════════
{
	// The same $2, at two rates. An absolute threshold cannot tell these apart,
	// which is the whole argument for using time.
	const calm  = M.rowFor({ label: 'Your key', exactUsd: 2 }, 0.001);   // ~33 hours
	const burst = M.rowFor({ label: 'Your key', exactUsd: 2 }, 0.5);     // 4 minutes
	check(calm.atRisk === false, 'two dollars at a slow burn is not a warning', String(calm.minutes));
	check(burst.atRisk === true, 'the same two dollars during a fan-out is', String(burst.minutes));
	check(calm.tone === 'ok' && burst.tone === 'warn',
		'and the tone follows the runway rather than the figure',
		calm.tone + ' / ' + burst.tone);

	// A large balance burning fast is also at risk. A threshold on the figure
	// would miss this one entirely.
	const big = M.rowFor({ label: 'Your key', exactUsd: 100 }, 20);
	check(big.atRisk === true,
		'a hundred dollars at twenty a minute is at risk too -- the figure is no guide',
		String(Math.round(big.minutes)));
}

// No rate, no runway: an idle app must not claim to know how long money lasts.
{
	const r = M.rowFor({ label: 'Your key', exactUsd: 2 }, null);
	check(r.minutes === null && r.atRisk === false,
		'with no burn rate there is no runway claim', String(r.minutes));
	const zero = M.rowFor({ label: 'Your key', exactUsd: 2 }, 0);
	check(zero.minutes === null,
		'and a zero rate does not divide into a runway of years', String(zero.minutes));
}

// ══ Rule 4: the consequence, not the figure ════════════════════════
// The module marks the row; the app swaps the text. What is asserted here is
// that the mark is present exactly when the reader needs to be told.
{
	const r = M.rowFor({ label: 'Your key', exactUsd: 0.05 }, 0.05);   // 1 minute
	check(r.atRisk === true && Math.round(r.minutes) === 1,
		'a minute of runway is flagged, with the minutes to say it',
		`${r.minutes} min, atRisk ${r.atRisk}`);
}

// ══ Several keys ═══════════════════════════════════════════════════
{
	// Two keys, both readable: they may be summed.
	const both = M.rows({ authed: false, rateUsdPerMin: null, providers: [
		prov({ id: 'a', name: 'A', credit: { mode: 'auto', usd: 5 } }),
		prov({ id: 'b', name: 'B', credit: { mode: 'auto', usd: 7 } }),
	] });
	check(both.length === 1 && both[0].usd === 12,
		'two readable keys are summed into one row', JSON.stringify(both[0]));
	check(!/A|B/.test(both[0].label),
		'named collectively, because four provider names is a list and not a status',
		both[0].label);

	// One readable, one not. Summing would produce a WRONG number.
	const mixed = M.rows({ authed: false, rateUsdPerMin: null, providers: [
		prov({ id: 'a', name: 'A', credit: { mode: 'auto', usd: 5 }, spentUsd: 1 }),
		prov({ id: 'b', name: 'B', credit: null, spentUsd: 2 }),
	] });
	check(mixed.length === 1 && mixed[0].kind === 'spent',
		'a total that could only count half the keys is not shown as a balance',
		JSON.stringify(mixed[0]));
	check(mixed[0].usd === 3,
		'it falls back to what all of them together have cost, which IS true',
		String(mixed[0].usd));

	// An estimate anywhere in the sum makes the sum an estimate.
	const est = M.rows({ authed: false, rateUsdPerMin: null, providers: [
		prov({ id: 'a', name: 'A', credit: { mode: 'auto', usd: 5 } }),
		prov({ id: 'b', name: 'B', credit: { mode: 'manual', usd: 7 } }),
	] });
	check(est[0].kind === 'estimate',
		'and one estimated part makes the whole an estimate', est[0].kind);
}

// ══ A key with no key ══════════════════════════════════════════════
{
	const rows = M.rows({ authed: false, rateUsdPerMin: null,
		providers: [prov({ hasKey: false, credit: { mode: 'auto', usd: 5 } })] });
	check(rows.length === 0,
		'a provider the user holds no key for is not their money and gets no row',
		JSON.stringify(rows));
}

// ══ THE REAL RAIL ══════════════════════════════════════════════════
// The pure half above was proved with a mock box injected into the page, which
// tested the wording rules and NOTHING about whether the rail draws them. It
// did not, and the case it missed is the commonest one there is: a user on
// their own key with no Daimond account. `moneyRows` was called only for an
// authed account, so that user saw no money row at all -- which is the whole
// complaint this file exists to answer. Never again from a mock.
if (!process.argv.includes('--pure')) {
	const { open, connectMock, signInAs, scratch } = await import('./harness.mjs');
	const s = await open({ name: 'moneyrail', signIn: false, connect: false,
		profile: scratch('pw', 'moneyrail-' + process.pid) });
	const { page: p } = s;
	try {
		await signInAs(s, 'moneyrail');
		await connectMock(s);
		// Spend on the user's OWN key, and no gateway account at all.
		await p.evaluate(() => {
			const id = (DaimondModels.providers()[0] || {}).id || 'custom';
			for (let i = 0; i < 5; i++) {
				DaimondLedger.record({ ts: Date.now() - i * 60000, model: 'mock/fast',
					promptTokens: 1000, completionTokens: 400, cachedTokens: 0,
					costUsd: 0.11, provider: id });
			}
			DaimondAdmin.status();
		});
		await p.waitForTimeout(700);

		const seen = await p.evaluate(() => {
			const rows = [...document.querySelectorAll('.astat-row')]
				.filter(r => getComputedStyle(r).display !== 'none')
				.map(r => r.textContent.trim());
			const gw = window.DaimondGateway && DaimondGateway.state();
			return { rows, authed: gw ? gw.authed : null };
		});
		check(seen.authed === false,
			'this is the no-account case, which is the one that was broken',
			String(seen.authed));
		const money = seen.rows.filter(x => /spent|\$/.test(x));
		check(money.length > 0,
			'a user on their own key with NO Daimond account still sees a money row',
			seen.rows.join(' | '));
		check(money.some(x => /key/i.test(x)),
			'and it names the key as theirs rather than saying "Credits"',
			money.join(' | '));
		check(!seen.rows.some(x => /^Credits/.test(x)),
			'nothing on the rail is labelled just "Credits"', seen.rows.join(' | '));
	} catch (e) {
		failures++;
		console.log('  FAIL rail half threw -- ' + (e && e.message ? e.message.split('\n')[0] : e));
	} finally {
		await s.close();
	}
}

console.log('');
console.log(failures ? `verify_money: ${failures} FAILED` : 'verify_money: all checks pass.');
process.exit(failures ? 1 : 0);
