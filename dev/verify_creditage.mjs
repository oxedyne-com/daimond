// verify_creditage.mjs — the provider credit figure, kept honest instead of stale.
//
// THE COMPLAINT. The author added $100 to his OpenRouter account and Daimond went on showing
// the old number for hours: "if my Daimond is just sitting there for hours after I added OR
// credit, I feel like it should be showing an honest credit level." The figure was probed at
// exactly three moments — unlock, a pasted key, and the "Ask again" button — and nothing else
// ever asked again.
//
// A displayed balance goes wrong two ways and they want opposite treatments:
//
//   THE USER SPENT. Daimond watched them do it; the turn and its cost are in the ledger
//   already. So the figure is walked down locally, with NO REQUEST AT ALL, and the next probe
//   replaces it outright. That is the frequent case and it must cost nothing.
//
//   THE USER TOPPED UP. Nothing in the browser can know that; only a probe finds it. So the
//   probe happens when the tab comes back to the front, on a beat while it is in front, and
//   when the Models panel is opened — every one of them behind ONE floor, because the user's
//   own rate limit is not free and the way to find out what OpenRouter allows is not to
//   hammer it.
//
//   AND THE FIGURE CARRIES ITS AGE, because a probe that fails writes nothing and keeps the
//   old number — which is right, no balance beats a wrong one — and silence and freshness
//   look identical on screen without it.
//
// HOW THIS IS DRIVEN, and why you can believe it.
//
//   * EVERY PROBE ASSERTION IS AT THE NETWORK. `openrouter.ai/api/v1/key` and `/credits` are
//     intercepted and counted. A check that counted internal calls could not see a request
//     that never went, nor one that went twice.
//   * EVERY CHECK IS PROVED RED. The same scenario is run five more times against a patched
//     `models.js` served from the dev server — the floor removed, the beat left running while
//     hidden, the age line silenced, the decrement disabled, the "who can answer" test made to
//     say everyone — and the check each patch breaks is asserted to FAIL in that run. A check
//     that passes on the broken build is reported as a broken check.
//   * TIME is Playwright's fake clock, installed before the page loads, so the five-minute
//     floor and a three-hour age are exercised in seconds rather than approximated.
//   * VISIBILITY is the one thing stood in for. Headless Chrome reports every page visible,
//     whatever is in front of it (measured: a second tab brought to front leaves
//     `visibilityState` at "visible", and neither `Emulation.setPageVisibilityOverride` nor
//     `Page.setWebLifecycleState` moves it), so the SIGNAL is faked in an init script and the
//     real `visibilitychange` event is dispatched. Everything downstream of it — the handler,
//     the gate, the request — is the shipped code, and what is measured is the request.
//
//   node dev/verify_creditage.mjs
//
// Needs a world: `bash dev/world.sh N --up` then `eval "$(bash dev/world.sh N --env)"`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, shot } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'www/js/models.js'), 'utf8');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const OR    = 'https://openrouter.ai/api/v1';
const CORS  = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json  = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});
const MIN   = 60 * 1000;
/// The floor in models.js. Named here so the waits below say what they are relative to; the
/// checks assert the PROPERTY (a probe, or none) and never a count of milliseconds.
const FLOOR = 5 * MIN;

// ── The patches that prove each check can fail ─────────────────────────
// Each is [anchor, replacement] against the shipped `www/js/models.js`, applied to the file the
// browser fetches. An anchor that no longer appears is a broken proof, not a passing one, so
// every anchor is checked against the file on disk before a browser is opened.
const BREAK = {
	floor: {
		what:    'the shared floor removed, so every trigger probes',
		patches: [['if (!probeDue(id)) continue;', '/* floor removed */']],
	},
	hidden: {
		what:    'the beat left running while the tab is hidden',
		patches: [['if (document.visibilityState === \'hidden\') { beatOff(); return; }',
			'if (document.visibilityState === \'hidden\') { return; }']],
	},
	age: {
		what:    'the age line silenced',
		patches: [['function ageSentence(id, c) {', 'function ageSentence(id, c) { if (1) return \'\';']],
	},
	decrement: {
		what:    'the local decrement disabled',
		patches: [['var gone = spentSince(id, c.asOf);', 'var gone = 0;']],
	},
	idle: {
		what:    'the finished-turn repaint removed',
		patches: [['window.addEventListener(\'daimond:idle\', function () { ageLines(); });',
			'/* no repaint when a turn finishes */']],
	},
	headsync: {
		// The defect this check was written from: the block below the head counted the turns
		// off and the head went on quoting the provider, so the panel held two balances.
		what:    'the closed row left behind by the open one',
		patches: [['if (bal) paintBal(bal, id, creditFor(id));', '/* head left behind */']],
	},
	anyone: {
		what:    'every provider treated as one that will answer',
		patches: [['return String(url || \'\').indexOf(\'openrouter.ai\') !== -1;', 'return !!url;']],
	},
};

for (const [name, b] of Object.entries(BREAK)) {
	for (const [anchor] of b.patches) {
		const n = SRC.split(anchor).length - 1;
		if (n !== 1) {
			console.log(`  FAIL  the "${name}" proof cannot be applied — its anchor appears ${n} times in models.js`);
			console.log(`        anchor: ${anchor}`);
			process.exit(1);
		}
	}
}

/// Run the whole scenario once, against the shipped file or a patched one.
///
/// Returns the observations; the checks are made afterwards, once for the green run and once
/// per patched run, so the same sentence is asserted true here and false there.
async function scenario(label, patches) {
	// What the provider says, and the levers the scenario pulls on it.
	const or = { key: 0, credits: 0, total: 40, usage: 0, fail: false };
	const fw = { hits: 0 };
	let patched = 0;

	const s = await open({
		name: `creditage-${label}`, signIn: false, connect: false, defaults: false,
		route: async (page) => {
			// Fake time, and a faked visibility SIGNAL. Both before the first byte of the app.
			await page.clock.install();
			await page.addInitScript(() => {
				var vis = 'visible';
				Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return vis; } });
				Object.defineProperty(document, 'hidden',          { configurable: true, get: function () { return vis === 'hidden'; } });
				window.__vis = function (v) { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
			});
			if (patches) {
				await page.route('**/js/models.js', async (r) => {
					const res = await r.fetch();
					let body = await res.text();
					for (const [from, to] of patches) {
						if (body.includes(from)) { patched++; body = body.split(from).join(to); }
					}
					await r.fulfill({ status: 200, contentType: 'application/javascript', body });
				});
			}
			// The two probe endpoints, counted. `limit: null` is an UNCAPPED key, which is what
			// a user's own pasted key normally is, so both requests are exercised.
			await page.route(`${OR}/key`, (r) => {
				or.key++;
				if (or.fail) return r.fulfill(json({ error: 'upstream' }, 500));
				return r.fulfill(json({ data: { label: 'test', limit: null, limit_remaining: null, usage: or.usage } }));
			});
			await page.route(`${OR}/credits`, (r) => {
				or.credits++;
				if (or.fail) return r.fulfill(json({ error: 'upstream' }, 500));
				return r.fulfill(json({ data: { total_credits: or.total, total_usage: or.usage } }));
			});
			await page.route(`${OR}/models`, (r) => r.fulfill(json({ data: [{ id: 'z-ai/glm-5p2' }] })));
			// A provider that has no such endpoint. Any request at all to it is a request to
			// nowhere, so the whole host is counted rather than one path.
			await page.route('https://api.fireworks.ai/**', (r) => { fw.hits++; return r.fulfill(json({}, 404)); });
		},
	});
	const p = s.page;
	await signInAs(s, `creditage-${label}`);
	await p.waitForTimeout(1500);

	const ff   = async (ms) => { await p.clock.fastForward(ms); await p.waitForTimeout(250); };
	const vis  = async (v) => { await p.evaluate((x) => window.__vis(x), v); await p.waitForTimeout(250); };
	/// What the expanded OpenRouter row says: the figure sentence, its age line, and the
	/// balance on the head. This is what the user reads, so it is what is asserted.
	const said = () => p.evaluate(() => {
		const w = document.querySelector('.models-credit[data-prov="openrouter"]');
		const heads = Array.prototype.slice.call(document.querySelectorAll('.models-prov-head'));
		const head = heads.find((h) => /OpenRouter/.test(h.textContent || ''));
		const bal  = head && head.querySelector('.models-bal');
		const ageEl = w && w.querySelector('.models-credit-age');
		return {
			line: w ? (w.querySelector('.models-credit-line') || {}).textContent || '' : '',
			age:  ageEl ? ageEl.textContent || '' : '',
			// The loud colour on the age line, and the mark on the closed row's balance. Both
			// have to keep up, or the staleness warning is itself stale.
			ageStale: !!(ageEl && ageEl.classList.contains('stale')),
			bal:  bal ? bal.textContent || '' : '',
			tip:  bal ? bal.getAttribute('title') || '' : '',
			stale: !!(bal && bal.hasAttribute('data-stale')),
		};
	});

	// ── A provider with a key, the way the settings form adds one ──
	await p.evaluate(async () => {
		DaimondModels.addProvider('openrouter', { url: 'https://openrouter.ai/api/v1/chat/completions' });
		DaimondModels.addProvider('fireworks',  { url: 'https://api.fireworks.ai/inference/v1/chat/completions' });
		await DaimondModels.setKey('fireworks',  'fw-test-key');
		await DaimondModels.setKey('openrouter', 'sk-or-v1-testkey0000');
	});
	await p.waitForTimeout(1200);
	const paste = { key: or.key, credits: or.credits };

	// The panel, opened the way a user opens it, and the row expanded.
	await p.click('#astat-model');
	await p.waitForTimeout(600);
	await p.evaluate(() => {
		const heads = Array.prototype.slice.call(document.querySelectorAll('.models-prov-head'));
		const h = heads.find((x) => /OpenRouter/.test(x.textContent || ''));
		if (h) h.click();
	});
	await p.waitForTimeout(400);
	const opened = { key: or.key, said: await said() };
	await shot(s, `creditage-${label}-opened`);

	// ── The floor, against the trigger that fires most often ──
	// Away and back five times in a row, well inside the floor.
	for (let i = 0; i < 5; i++) { await vis('hidden'); await vis('visible'); }
	const toggled = { key: or.key };

	// ── And against the panel being opened again ──
	// Shut by whichever closer this window is wearing: the rail's drawer has its own cross,
	// and a window with no rail hosts the same view in a modal card.
	const shut = async () => {
		for (const sel of ['#admin-close', '#settings-close']) {
			if (await p.isVisible(sel)) { await p.click(sel); return; }
		}
		throw new Error('nothing visible closes the Admin panel');
	};
	for (let i = 0; i < 3; i++) {
		await shut();
		await p.waitForTimeout(200);
		await p.click('#astat-model');
		await p.waitForTimeout(300);
	}
	const reopened = { key: or.key };

	// ── The user spent: the figure moves with no request at all ──
	// The two things daimond.js does at the end of every metered turn, in that order: the cost
	// goes into the ledger, and the app announces that it is idle again. No clock is moved and
	// no floor is spent — if the figure changes here, it changed out of books this device
	// already keeps.
	await p.evaluate(() => {
		DaimondLedger.record({
			ts: Date.now(), model: 'z-ai/glm-5p2', provider: 'openrouter',
			promptTokens: 1000, completionTokens: 500, cachedTokens: 0, costUsd: 2.5,
		});
		window.dispatchEvent(new Event('daimond:idle'));
	});
	await p.waitForTimeout(500);
	const spent = { key: or.key, credits: or.credits, said: await said() };

	// ── The user topped up: found when the tab comes back ──
	or.total = 140;
	await vis('hidden');
	await ff(FLOOR + MIN);
	await vis('visible');
	await p.waitForTimeout(600);
	const toppedUp = { key: or.key, said: await said() };

	// ── A hidden tab does not poll ──
	await vis('hidden');
	await ff(4 * FLOOR);
	const whileHidden = { key: or.key };
	await vis('visible');
	await p.waitForTimeout(600);
	const backAgain = { key: or.key, said: await said() };

	// ── A probe that fails writes nothing, and says so ──
	or.fail = true;
	await ff(FLOOR + MIN);
	await p.waitForTimeout(600);
	const failed = { key: or.key, said: await said() };

	// ── ...and the age goes on climbing, which is how you can tell ──
	await ff(3 * 60 * MIN);
	await p.waitForTimeout(400);
	const aged = { said: await said() };

	// ── A failing key backs off rather than retrying on the next beat ──
	const beforeBackoff = or.key;
	await ff(FLOOR + MIN);
	const backoffHeld = { key: or.key, from: beforeBackoff };
	await ff(60 * MIN);
	const backoffFreed = { key: or.key };

	// ── The user asks by hand: never held back by the floor ──
	or.fail = false;
	or.total = 200;
	await p.evaluate(() => {
		const w = document.querySelector('.models-credit[data-prov="openrouter"]');
		const ask = w && w.querySelector(':scope > .models-refetch');
		if (ask) ask.click();
	});
	await p.waitForTimeout(900);
	const asked = { key: or.key, said: await said() };

	const errs = s.errs.filter((e) => !/favicon|502|Failed to load resource/i.test(e));
	await s.close();
	return {
		label, patched, or, fw, errs,
		paste, opened, toggled, reopened, spent, toppedUp,
		whileHidden, backAgain, failed, aged, backoffHeld, backoffFreed, asked,
	};
}

/// The first money figure in a sentence, as a number.
const amount = (s) => {
	const m = String(s || '').match(/\$([0-9][0-9,]*\.?[0-9]*)/);
	return m ? parseFloat(m[1].replace(/,/g, '')) : null;
};
const near = (a, b) => a !== null && Math.abs(a - b) < 0.005;

// ── The claims, each one a function of a run's observations ────────────
// Written once and asserted twice: TRUE of the shipped code, FALSE of the build whose patch
// breaks it. A claim that holds on the broken build is a claim that was measuring something
// else, and is reported as such.
const CLAIMS = {
	pasted: {
		says: 'pasting a key still asks what is on it',
		holds: (r) => r.paste.key === 1 && r.paste.credits === 1,
		shows: (r) => `${r.paste.key} /key, ${r.paste.credits} /credits`,
	},
	shown: {
		says: 'and the panel shows what it answered',
		holds: (r) => near(amount(r.opened.said.line), 40) && /40/.test(r.opened.said.bal),
		shows: (r) => `${r.opened.said.bal} | ${r.opened.said.line}`,
	},
	floorVisibility: {
		says: 'FLOOR: away and back five times is not five probes',
		breaks: 'floor',
		holds: (r) => r.toggled.key === r.opened.key,
		shows: (r) => `${r.opened.key} probe(s) before, ${r.toggled.key} after five round trips`,
	},
	floorPanel: {
		says: 'FLOOR: opening the panel three more times is not three probes',
		breaks: 'floor',
		holds: (r) => r.reopened.key === r.opened.key,
		shows: (r) => `${r.opened.key} before, ${r.reopened.key} after three re-opens`,
	},
	decrementCosts: {
		says: 'SPENT: a turn moves the figure with NO request',
		breaks: 'decrement',
		holds: (r) => r.spent.key === r.reopened.key && r.spent.credits === r.paste.credits
			&& near(amount(r.spent.said.line), 37.5),
		shows: (r) => `${r.spent.key} /key, ${r.spent.credits} /credits, "${r.spent.said.line}"`,
	},
	decrementAtOnce: {
		says: 'SPENT: a finished turn moves it at once, without waiting for the beat',
		breaks: 'idle',
		holds: (r) => near(amount(r.spent.said.line), 37.5),
		shows: (r) => r.spent.said.line,
	},
	decrementHead: {
		says: 'SPENT: and the closed row never shows a different figure from the open one',
		breaks: 'headsync',
		holds: (r) => near(amount(r.spent.said.bal), amount(r.spent.said.line)),
		shows: (r) => `head "${r.spent.said.bal}" vs block "${r.spent.said.line}"`,
	},
	decrementSays: {
		says: 'SPENT: and the sentence stops claiming the provider said the new figure',
		breaks: 'decrement',
		holds: (r) => /40/.test(r.spent.said.line) && /2\.5/.test(r.spent.said.line),
		shows: (r) => r.spent.said.line,
	},
	// No `breaks`: removing the floor makes the app probe MORE, so it finds the money too. What
	// this claim is for is the other half — that coming back finds it with ONE request.
	topUp: {
		says: 'TOPPED UP: the tab coming back after the floor finds the money, in one request',
		holds: (r) => r.toppedUp.key === r.opened.key + 1 && near(amount(r.toppedUp.said.line), 140),
		shows: (r) => `${r.toppedUp.key} probe(s), "${r.toppedUp.said.line}"`,
	},
	freshNotDoubled: {
		says: 'TOPPED UP: a fresh reading is not decremented by spending it already knew about',
		holds: (r) => near(amount(r.toppedUp.said.line), 140),
		shows: (r) => r.toppedUp.said.line,
	},
	hiddenQuiet: {
		says: 'HIDDEN: four floors face down produces no request at all',
		breaks: 'hidden',
		holds: (r) => r.whileHidden.key === r.toppedUp.key,
		shows: (r) => `${r.toppedUp.key} before hiding, ${r.whileHidden.key} after four floors hidden`,
	},
	hiddenThenBack: {
		says: 'HIDDEN: and coming back asks once',
		holds: (r) => r.backAgain.key === r.whileHidden.key + 1,
		shows: (r) => `${r.whileHidden.key} -> ${r.backAgain.key}`,
	},
	failKeeps: {
		says: 'FAILED: a probe that errors leaves the figure exactly where it was',
		holds: (r) => near(amount(r.failed.said.line), amount(r.backAgain.said.line))
			&& r.failed.key > r.backAgain.key,
		shows: (r) => `asked ${r.backAgain.key}->${r.failed.key}, "${r.failed.said.line}"`,
	},
	failSays: {
		says: 'FAILED: and the age line says the last check did not answer',
		breaks: 'age',
		holds: (r) => /did not answer/i.test(r.failed.said.age) && r.failed.said.ageStale,
		shows: (r) => `"${r.failed.said.age}" loud=${r.failed.said.ageStale}`,
	},
	failMarksClosedRow: {
		says: 'FAILED: and the mark on the closed row keeps up without a redraw',
		breaks: 'age',
		holds: (r) => r.failed.said.stale && /did not answer/i.test(r.failed.said.tip),
		shows: (r) => `mark=${r.failed.said.stale} tip="${r.failed.said.tip}"`,
	},
	failAges: {
		says: 'FAILED: and the age goes on climbing, so the user can see it has stopped',
		breaks: 'age',
		holds: (r) => /minute/i.test(r.failed.said.age) && /hour/i.test(r.aged.said.age),
		shows: (r) => `"${r.failed.said.age}" then "${r.aged.said.age}"`,
	},
	backoff: {
		says: 'BACKOFF: a failing key waits longer than the floor before it is asked again',
		breaks: 'floor',
		holds: (r) => r.backoffHeld.key === r.backoffHeld.from && r.backoffFreed.key > r.backoffHeld.key,
		shows: (r) => `${r.backoffHeld.from} -> ${r.backoffHeld.key} after a floor, -> ${r.backoffFreed.key} after twelve`,
	},
	byHand: {
		says: 'BY HAND: "Ask again" is never held back, and picks up the new figure',
		holds: (r) => r.asked.key === r.backoffFreed.key + 1 && near(amount(r.asked.said.line), 200),
		shows: (r) => `${r.backoffFreed.key} -> ${r.asked.key}, "${r.asked.said.line}"`,
	},
	nowhere: {
		says: 'NOWHERE: a provider with no such endpoint is never asked, ever',
		breaks: 'anyone',
		holds: (r) => r.fw.hits === 0,
		shows: (r) => `${r.fw.hits} request(s) to api.fireworks.ai`,
	},
	quiet: {
		says: 'and none of it throws',
		holds: (r) => r.errs.length === 0,
		shows: (r) => r.errs.slice(0, 2).join(' | '),
	},
};

// ── The shipped build ──────────────────────────────────────────────────
console.log('\n── the shipped build ──');
const green = await scenario('green', null);
for (const [k, c] of Object.entries(CLAIMS)) check(c.says, c.holds(green), c.shows(green));

// ── The broken builds ──────────────────────────────────────────────────
// One per patch, and in each the claims that name it must FAIL. Anything else it breaks is
// reported but not counted: a patch is allowed collateral damage, it is not allowed to leave
// its own claim standing.
for (const [name, b] of Object.entries(BREAK)) {
	const want = Object.entries(CLAIMS).filter(([, c]) => c.breaks === name);
	if (!want.length) { console.log(`  FAIL  the "${name}" patch proves nothing: no claim names it`); bad.push(name); continue; }
	console.log(`\n── broken on purpose: ${b.what} ──`);
	const run = await scenario(name, b.patches);
	check(`the "${name}" patch reached the browser`, run.patched >= b.patches.length,
		`${run.patched} of ${b.patches.length} applied`);
	for (const [, c] of want) {
		check(`RED: "${c.says}" fails when ${b.what}`, !c.holds(run), c.shows(run));
	}
}

console.log(`\n${bad.length ? `verify_creditage: ${bad.length} FAILED` : 'verify_creditage: all checks pass.'}`);
if (bad.length) { bad.forEach((b) => console.log('  - ' + b)); process.exit(1); }
