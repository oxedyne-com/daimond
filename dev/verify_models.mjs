// verify_models.mjs — a key per provider, and one model starred as the default.
//
// Daimond used to hold ONE provider: a base URL, a key, a model. The model you want for a cheap
// classification is not the one you want for a hard refactor, and they rarely sit behind the same
// key — so a key is held per provider now, and exactly one model is the default a new chat starts
// on. This drives that: the migration off the old single config (which a real user HAS, with a
// real key in it), adding a second provider without evicting the first, starring a default, and
// the status row that counts what all of them can run.
//
// AND THE PANEL'S MESSAGE LINE, which for a month did not exist. `models.js` looked up
// `#models-note` and NOTHING in the tree created one — no markup, no JS, not even a CSS rule —
// so `if (n)` swallowed all three of the messages behind it: a provider that would not say what
// credit is left, a models list that would not load, and a credit figure that is not a number.
// A user typed `abc`, pressed Set, and the field simply did not take.
//
// The checks below assert the line EXISTS and says what. Never that no error is showing: an
// element that was never created reports itself to a browser locator as HIDDEN, which is exactly
// what a guard doing its job produces, so absence-only checks pass on a panel struck dumb.
//
// THE SAME MISTAKE, ONE PANEL OVER, and found on 2026-08-20: the button that asks a provider
// for its models was drawn inside `if (!p.count)`, so a provider that had answered once could
// never be asked again and a model released this morning appeared on nobody's screen. The owner
// had to call `DaimondModels.fetchModels('openrouter')` from the browser console. The checks at
// the end assert the button EXISTS on a row with a list — drawn disabled where it cannot be
// used, never hidden, for the reason in the paragraph above — and that the row says when the
// list was last asked for.
//
// AND THE CATALOGUE THAT ASKS FOR ITSELF, added 2026-08-20. The button is a person deciding to
// ask; a list nobody presses the button for is a list frozen at the day the key was pasted. So a
// stale one is re-asked when the panel opens and when the app starts — which is a request loop
// with a fuse in it, because `fetchModels` ends in `save()`, `save()` redraws this panel, and a
// redraw asks again. The credit probe beside it measured that loop at four thousand requests. So
// the last checks below COUNT REQUESTS rather than reading the panel: the page's own `fetch` is
// wrapped before the app loads, every catalogue request is intercepted, and the loop check drives
// a thousand redraws and asserts the count stays at ONE.
//
//   node dev/verify_models.mjs --break notemissing   # the line taken back out of the markup
//   node dev/verify_models.mjs --break notewiped     # the line eaten by the next redraw
//   node dev/verify_models.mjs --break emptyonly     # the ask offered only to an empty provider
//   node dev/verify_models.mjs --break hidesealed    # the ask hidden, not disabled, when unusable
//   node dev/verify_models.mjs --break mintedtoo     # a second button on the credits row
//   node dev/verify_models.mjs --break nogate        # THE LOOP: in-flight and floor taken off
//   node dev/verify_models.mjs --break alwaysstale   # every list treated as stale, however new
//   node dev/verify_models.mjs --break mintedauto    # the credits row auto-asked as well
//   node dev/verify_models.mjs --break sealedauto    # a keyless or sealed provider auto-asked
//   node dev/verify_models.mjs --break ignoreoffline # asked with no network to ask over
//   node dev/verify_models.mjs --break loudfail      # an ask nobody made putting its error up
//   node dev/verify_models.mjs --break nobootcall    # the boot never asks; only the panel does
//   node dev/verify_models.mjs                       # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, shot } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const die  = (why) => { console.error('ABORT: ' + why); process.exit(2); };

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The patches that prove the message-line checks can fail ────────────
//
// Each damages ONE shipped file, served to the browser in place of the real one.
//
//   notemissing  the defect exactly as it shipped: no `#models-note` anywhere, so every message
//                is swallowed by a guard that looks correct.
//   notewiped    the line is there, but `render()` blanks it — the arrangement you get by
//                putting the message INSIDE the list that render rewrites wholesale. The
//                immediate message survives; the one the user is still reading does not.
//   emptyonly    the catalogue defect exactly as it shipped: the ask, and the age line under
//                it, drawn only for a provider listing nothing.
//   hidesealed   the ask hidden rather than disabled when the row cannot use it — the shape of
//                mistake that made the first one invisible to a locator.
//   mintedtoo    the guard that keeps the credits row to its one affordance taken off, so Top
//                up and an ask sit side by side offering work that has already happened.
//
// And the six that damage the automatic ask. Five of them take one rule out of `listDue`, which
// is the whole of the policy; the sixth cuts the boot off from it.
//
//   nogate       in-flight suppression AND the floor removed, leaving staleness alone to stop
//                the loop — which it cannot, because a redraw arrives long before an answer
//                does. This is the one that matters: it turns one request into a thousand.
//   alwaysstale  every catalogue counted as stale, so a list asked for an hour ago is asked
//                for again on the next redraw.
//   mintedauto   the credits row asked automatically as well, duplicating the ask `syncCredits`
//                has already made with a key that did not exist before the mint.
//   sealedauto   the key check removed, so a keyless row and a locked one are both asked.
//                Nothing reaches the network — `fetchModels` throws for want of a key before it
//                gets there — which is why those two checks read the GATE as well as the count:
//                a failure has been recorded against a credential that was never there.
//   ignoreoffline  asked with no network to ask over, which is a guaranteed failure recorded
//                against a provider that did nothing wrong.
//   loudfail     the silent failure made loud: an ask nobody requested puts the provider's
//                error on the panel's message line, in front of a user who just opened it.
//
// The one line three of the breaks below rewrite. Held once, so a break that stops matching
// fails loudly at `hurt` rather than quietly patching nothing.
const ASK_GUARD = "if (!p.minted) {\n\t\t\t\t\tvar refetch";

/// The in-flight test and the floor, as one block, so `nogate` cannot silently patch half of it.
const LIST_GATE = "\t\tvar st = lists[id];\n\t\tif (st) {\n"
	+ "\t\t\tif (st.busy) return false;\t\t\t\t// one in flight is one request already\n"
	+ "\t\t\tif ((Date.now() - st.at) < listWait(id)) return false;\n\t\t}\n";

const BREAKS = {
	notemissing: {
		what: 'the message line taken back out of the markup, exactly as it shipped',
		file: 'www/index.html',
		type: 'text/html; charset=utf-8',
		edit: (src) => src.replace(/\n[ \t]*<div id="models-note"[^>]*><\/div>/, ''),
	},
	notewiped: {
		what: 'render() blanking the message line, as it would if the line lived inside the list',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(
			"\t\telse askWhenShown();\n\t\tel.innerHTML = '';\n",
			"\t\telse askWhenShown();\n\t\tel.innerHTML = '';\n\t\tnote('');\n"),
	},
	emptyonly: {
		what: 'the ask offered only to a provider that lists nothing, exactly as it shipped',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(ASK_GUARD, "if (!p.count) {\n\t\t\t\t\tvar refetch"),
	},
	hidesealed: {
		what: 'the ask hidden rather than disabled on a row that cannot use it',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(ASK_GUARD, "if (!p.minted && p.ready) {\n\t\t\t\t\tvar refetch"),
	},
	mintedtoo: {
		what: 'a second button on the credits row, beside the Top up that is its one affordance',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(ASK_GUARD, "if (true) {\n\t\t\t\t\tvar refetch"),
	},
	nogate: {
		what: 'the in-flight test and the floor taken off the automatic ask, leaving the loop open',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(LIST_GATE, ''),
	},
	alwaysstale: {
		what: 'every catalogue counted as stale, however recently it was asked for',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(
			'return (Date.now() - ms(p.fetched)) >= LIST_STALE_MS;', 'return true;'),
	},
	mintedauto: {
		what: 'the credits row asked automatically too, on top of the ask every mint already makes',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace('\t\tif (id === CREDITS) return false;\n', ''),
	},
	sealedauto: {
		what: 'a provider with no readable key asked anyway, to be told what the app already knew',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace('\t\tif (!canRun(id)) return false;\n', ''),
	},
	ignoreoffline: {
		what: 'asked with no network to ask over, and the certain failure counted against the row',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(
			"\t\tif (typeof navigator !== 'undefined' && navigator.onLine === false) return;\n", ''),
	},
	loudfail: {
		what: 'an ask nobody made putting the provider\u2019s error on the panel\u2019s message line',
		file: 'www/js/models.js',
		type: 'text/javascript',
		edit: (src) => src.replace(
			'\t\t\t/* a revoked key, a typo in a URL, a rate limit: none of it was asked for */\n',
			'\t\t\tnote(e && e.message ? e.message : String(e));\n'),
	},
	nobootcall: {
		what: 'the boot cut off from the ask, so only somebody opening the panel refreshes a list',
		file: 'www/js/daimond.js',
		type: 'text/javascript',
		edit: (src) => src.replace(
			'\t\tif (window.DaimondModels) DaimondModels.refreshLists();\n', ''),
	},
};
if (BREAK && !BREAKS[BREAK]) die(`no break called "${BREAK}"`);

/// The damaged file the browser will be given, or null when nothing is broken.
const hurt = (() => {
	if (!BREAKS[BREAK]) return null;
	const b   = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(ROOT, b.file), 'utf8');
	const out = b.edit(src);
	if (out === src) die(`the "${BREAK}" break no longer matches ${b.file}`);
	return { ...b, body: out };
})();
if (hurt) console.log(`BREAK ${BREAK}: ${hurt.what}\n`);

// ── Counting the catalogue requests, twice ─────────────────────────────
//
// The loop check has to be able to count to four thousand, so it counts REQUESTS and never
// anything on the panel. Two instruments, because each one alone can lie:
//
//   * `page.route` in Node, which is the browser's own interception and therefore the honest
//     answer — but a thousand requests to one host queue behind Chrome's six-connection limit,
//     so a run that does not wait for them to drain reads low.
//   * a wrapper round the page's `fetch`, installed before any of the app's scripts run. It
//     counts the moment the app calls, with no queueing in between, which is what a synchronous
//     run of redraws needs. `models.js` looks `fetch` up globally at each call, so a wrapper on
//     `window` is the call it makes.
//
// Both are reported. They should agree; where they do not, the wrapper is the count of asks the
// app MADE and the route is the count that reached the network.

/// Every catalogue request the browser issued, by path, as Playwright saw it.
const hits = {};
/// A fixture endpoint, and what it should do when asked.
///
/// `answer` stands in for a provider that publishes a list. `refuse` is a key the provider will
/// not accept — the ordinary failure, which must be silent. `drop` never gets off the machine at
/// all, so a thousand of them cannot queue behind six connections, and it never writes `fetched`,
/// which is what keeps the row stale for the whole of the loop check.
const FIXTURES = {
	'/boot/v1/models':    'answer',
	'/fixture/v1/models': 'answer',
	'/loop/v1/models':    'drop',
	'/refuse/v1/models':  'refuse',
	// None of these may ever be asked. They answer rather than refuse so that a break which
	// leaks a request leaks a SUCCESSFUL one, and the damage shows in the panel as well as here.
	'/fresh/v1/models':   'answer',
	'/nokey/v1/models':   'answer',
	'/sealed/v1/models':  'answer',
	'/credits/v1/models': 'answer',
	'/off/v1/models':     'answer',
};
const CATALOGUE = JSON.stringify({ data: [{ id: 'listed-a' }, { id: 'listed-b' }] });

const s = await open({
	name: 'models', connect: false,
	route: async (pg) => {
		// Before any of the app's own scripts: `models.js` reads `window.fetch` at the moment it
		// asks, so this is the call it makes.
		await pg.addInitScript(() => {
			window.__asked = {};
			const real = window.fetch;
			window.fetch = function (input) {
				try {
					const u = typeof input === 'string' ? input : (input && input.url) || '';
					const path = new URL(u, location.href).pathname;
					if (/\/models$/.test(path)) window.__asked[path] = (window.__asked[path] || 0) + 1;
				} catch (e) { /* not a URL this test is about */ }
				return real.apply(this, arguments);
			};
		});
		// EVERY catalogue request, wherever it is bound. The fixture endpoints are same-origin
		// on purpose — a cross-origin one carries an `authorization` header and so drags a CORS
		// preflight in front of it, which is a second request this test would have to reason
		// about. Anything else asking for a `/models` is aborted rather than allowed out: this
		// change makes the app ask the real Fireworks and the real Groq for their catalogues at
		// boot, and a test suite must not become a client of somebody else's API.
		await pg.route((url) => /\/models$/.test(url.pathname), (r) => {
			const at = new URL(r.request().url()).pathname;
			hits[at] = (hits[at] || 0) + 1;
			const kind = FIXTURES[at];
			if (kind === 'answer') {
				return r.fulfill({ status: 200, contentType: 'application/json', body: CATALOGUE });
			}
			if (kind === 'refuse') {
				return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"no"}' });
			}
			return r.abort();
		});
		if (!hurt) return;
		// The document is served at `/`, not at `/index.html`, so a glob on the file name
		// cannot match it.
		if (hurt.file.endsWith('index.html')) {
			await pg.route((url) => url.pathname === '/' || url.pathname === '/index.html',
				(r) => r.fulfill({ status: 200, contentType: hurt.type, body: hurt.body }));
		} else {
			await pg.route('**/' + path.basename(hurt.file),
				(r) => r.fulfill({ status: 200, contentType: hurt.type, body: hurt.body }));
		}
	},
});
const p = s.page;
await p.waitForTimeout(1500);

// ── The migration ───────────────────────────────────────────────────────
//
// A user on the old build has a provider, a key and a model in `daimond-byok`. The shape changed
// underneath them; losing any of it would be the app forgetting something they told it.

await p.evaluate(() => {
	localStorage.setItem('daimond-byok', JSON.stringify({
		baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
		apiKey:  'old-single-key',
		model:   'accounts/fireworks/models/glm-5p2',
		maxTokens: 4096, tools: true,
	}));
	localStorage.setItem('daimond-models', JSON.stringify([
		'accounts/fireworks/models/glm-5p2', 'accounts/fireworks/models/other',
	]));
	localStorage.removeItem('daimond-models-v2');   // as if this build had never run
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'models');
await p.waitForTimeout(2000);

const migrated = await p.evaluate(() => {
	const M = window.DaimondModels;
	const provs = M.providers();
	const d = M.getDefault();
	return {
		provs: provs.map(x => ({ id: x.id, hasKey: x.hasKey, count: x.count })),
		def:   d,
		key:   M.keyFor('fireworks'),
		ready: M.ready(),
		count: M.count(),
	};
});
check('the single provider is carried into the store that holds many',
	migrated.provs.length === 1 && migrated.provs[0].id === 'fireworks' && migrated.provs[0].hasKey,
	JSON.stringify(migrated.provs));
check('its key survives the change of shape', migrated.key === 'old-single-key');
check('and the model they chose is still the default',
	migrated.def.provider === 'fireworks' && /glm-5p2$/.test(migrated.def.model),
	`${migrated.def.provider} / ${migrated.def.model}`);
check('the app can still run', migrated.ready === true);

// ── The status row counts models, not providers ─────────────────────────

const rail = await p.evaluate(() => {
	const r = document.getElementById('astat-model');
	return { text: r ? r.textContent.trim() : '(none)', count: window.DaimondModels.count() };
});
check('the status row says Models and counts them',
	/Models/.test(rail.text) && rail.text.includes(String(rail.count)),
	`${rail.text} (count ${rail.count})`);

// ── A second provider joins; it does not evict the first ────────────────

const second = await p.evaluate(async () => {
	const M = window.DaimondModels;
	M.addProvider('groq', {});
	await M.setKey('groq', 'the-groq-key');
	// Stand in for the provider's /models answer: the network is not under test here.
	M.providers();
	const store = JSON.parse(localStorage.getItem('daimond-models-v2'));
	store.providers.groq.models = ['llama-3.3-70b', 'mixtral-8x7b'];
	localStorage.setItem('daimond-models-v2', JSON.stringify(store));
	M.init({});                                   // reload the store from disk
	await M.unseal();
	return {
		provs: M.providers().map(x => ({ id: x.id, count: x.count, hasKey: x.hasKey })),
		count: M.count(),
		fireworksKey: M.keyFor('fireworks'),
		groqKey: M.keyFor('groq'),
		def: M.getDefault(),
	};
});
check('a second provider is added alongside the first',
	second.provs.length === 2, JSON.stringify(second.provs));
check('and does not evict the first provider’s key',
	second.fireworksKey === 'old-single-key' && second.groqKey === 'the-groq-key');
check('the model count is the sum across providers',
	second.count === 4, second.count + ' models');
check('and adding a provider does not silently move the default',
	second.def.provider === 'fireworks', second.def.provider);

// ── Starring a different default ────────────────────────────────────────

const starred = await p.evaluate(() => {
	const M = window.DaimondModels;
	M.setDefault('groq', 'llama-3.3-70b');
	const r = M.resolve('', '');            // what a NEW chat would run on
	const keep = M.resolve('fireworks', 'accounts/fireworks/models/glm-5p2');
	return { def: M.getDefault(), resolved: r, kept: keep };
});
check('starring a model makes it what a new chat runs on',
	starred.resolved && starred.resolved.provider === 'groq'
	&& starred.resolved.model === 'llama-3.3-70b'
	&& starred.resolved.apiKey === 'the-groq-key',
	JSON.stringify(starred.resolved && { p: starred.resolved.provider, m: starred.resolved.model }));
check('a chat already running on another provider still resolves to it',
	starred.kept && starred.kept.provider === 'fireworks'
	&& starred.kept.apiKey === 'old-single-key',
	'an existing chat is not dragged onto the new default');

// ── The panel ───────────────────────────────────────────────────────────

await p.evaluate(() => { document.getElementById('astat-model').click(); });
await p.waitForTimeout(700);

const panel = await p.evaluate(() => {
	const list = document.getElementById('models-list');
	const heads = [...document.querySelectorAll('.models-prov-name')].map(e => e.textContent);
	return {
		shown:  !!(document.getElementById('admin-models') || {}).offsetParent,
		heads:  heads,
		footer: (document.querySelector('.models-default') || {}).textContent || '',
	};
});
check('the Models row opens the models form', panel.shown === true);
check('and it lists every provider', panel.heads.length === 2, panel.heads.join(', '));
check('and says plainly what a new chat will start on',
	/Groq/.test(panel.footer) && /llama-3\.3-70b/.test(panel.footer), panel.footer.trim());

// Expand one and check the star is on the model itself.
await p.evaluate(() => {
	[...document.querySelectorAll('.models-prov-head')]
		.find(h => /Groq/.test(h.textContent)).click();
});
await p.waitForTimeout(400);
const expanded = await p.evaluate(() => {
	const models = [...document.querySelectorAll('.models-model')].map(m => m.textContent.trim());
	const on = (document.querySelector('.models-model.on') || {}).textContent || '';
	return { models, on };
});
check('expanding a provider shows its models, with the default starred',
	expanded.models.length === 2 && /★/.test(expanded.on) && /llama-3\.3-70b/.test(expanded.on),
	expanded.on.replace(/\s+/g, ' '));

// ── The panel's message line ────────────────────────────────────────────
//
// EXISTENCE FIRST, because that is the whole defect. `models-note` appeared exactly once in the
// tree — in the lookup that could never find it.

const line = await p.evaluate(() => {
	const n    = document.getElementById('models-note');
	const list = document.getElementById('models-list');
	return {
		there:  !!n,
		inList: !!(n && list && list.contains(n)),
		live:   n ? n.getAttribute('aria-live') : '',
	};
});
check('the Models panel HAS a message line, under the id the code looks it up by',
	line.there,
	line.there ? `aria-live="${line.live}"`
		: 'NO #models-note — every message this panel can make is swallowed by its own guard');
check('and it sits outside the list that render() rewrites wholesale',
	line.there && !line.inList,
	!line.there ? 'there is no line to place'
		: line.inList ? 'inside #models-list, where the next redraw will take it' : 'beside the list');

const form = await p.evaluate(() => ({
	input: !!document.querySelector('.models-credit-input'),
	set:   !!document.querySelector('.models-credit-form .models-refetch'),
}));
check('the expanded provider offers the “I have this much” field',
	form.input && form.set, JSON.stringify(form));

// `abc` is not an amount. Until this landed the field simply did not take: an early return with
// no message, no styling and nothing whatever to say what was wrong with what had been typed.
const typed = await p.evaluate(() => {
	const M    = window.DaimondModels;
	const want = window.DaimondI18n ? DaimondI18n.t('models.credit_base_bad') : '';
	const inp  = document.querySelector('.models-credit-input');
	const btn  = document.querySelector('.models-credit-form .models-refetch');
	const held = () => JSON.stringify(M.providers().map(x => [x.id, (x.credit || {}).baseUsd]));
	const before = held();
	inp.value = 'abc';
	btn.click();
	const n = document.getElementById('models-note');
	return {
		want, before, after: held(),
		there: !!n,
		text:  n ? n.textContent.trim() : '',
		seen:  !!(n && n.offsetParent !== null),
	};
});
check('a credit figure that is not a number is refused IN WORDS, not by silence',
	typed.there && typed.text.length > 0 && typed.text === typed.want,
	typed.there ? `“${typed.text || '(the panel said nothing at all)'}”`
		: 'there is no message line to say it on');
check('and the message is on screen, not merely in the document',
	typed.seen === true, typed.there ? '' : 'no element');
check('and nothing was written: “abc” did not become a balance',
	typed.after === typed.before, typed.after.slice(0, 90));

// The list is rewritten wholesale on every render — collapsing a row is enough — and the
// complaint belongs to what the user just typed, not to the list. A background redraw (a sync
// pull, a change of language) must not take it off the screen while they are reading it.
await p.evaluate(() => { window.DaimondModels.render(); });
await p.waitForTimeout(400);
const survived = await p.evaluate(() => {
	const n = document.getElementById('models-note');
	return { there: !!n, text: n ? n.textContent.trim() : '' };
});
check('and it is still on screen after the provider list redraws',
	survived.there && survived.text === typed.want,
	survived.there ? `“${survived.text || '(the redraw ate it)'}”` : 'the message line is gone');

// And a figure that IS a number clears it: a panel that goes on complaining about something
// already fixed teaches the user to stop reading it.
const cleared = await p.evaluate(() => {
	const inp = document.querySelector('.models-credit-input');
	const btn = document.querySelector('.models-credit-form .models-refetch');
	inp.value = '12.50';
	btn.click();
	const n = document.getElementById('models-note');
	return { text: n ? n.textContent.trim() : '(no message line)' };
});
check('and a figure that IS a number clears the complaint', cleared.text === '', `“${cleared.text}”`);

// ── Asking a provider again ─────────────────────────────────────────────
//
// Groq already lists two models, so it is exactly the row the old `if (!p.count)` silenced.
// `together` is added with no key, to prove the button is DRAWN and disabled rather than left
// out: an element that was never created reports itself to a locator as hidden, which is
// indistinguishable from a guard doing its job — the mistake this whole file was written about.
// A credits row is put in beside them because it is the one row that must NOT gain the button.
//
// Every "is it there" test below reads a bounding rectangle. A computed `display` does not
// cascade, so an element inside a hidden parent still reports `display: block`.

const STAMP = Date.UTC(2026, 6, 14, 3, 25);		// a fixed moment, so the age line can be read back

await p.evaluate((stamp) => {
	const M = window.DaimondModels;
	M.addProvider('together', {});				// configured, keyless, and therefore not ready
	const raw = JSON.parse(localStorage.getItem('daimond-models-v2'));
	raw.providers.groq.fetched = stamp;			// a catalogue with a date on it
	// The minted row as it sits on disk: name, host and models are ordinary and ARE stored;
	// the key never is. `credits.state` stays '', so no Top up is drawn either.
	raw.providers.credits = {
		name: 'Daimond credits', url: '', key: '', keyEnc: '',
		models: ['z-ai/glm-5.2'], fetched: 0,
	};
	localStorage.setItem('daimond-models-v2', JSON.stringify(raw));
	M.init({});
	return M.unseal();
}, STAMP);

/// Open one provider row by id, and leave it open.
const openRow = async (id) => {
	await p.evaluate((pid) => {
		window.DaimondModels.render();
		const row = document.querySelector('.models-prov[data-prov="' + pid + '"]');
		if (row && !row.querySelector('.models-prov-body')) row.querySelector('.models-prov-head').click();
	}, id);
	await p.waitForTimeout(250);
};

/// What one provider row draws: the ask, its label and state, and the age line under it.
///
/// Direct children only. The credit block's own Set button is a `.models-refetch` too, nested
/// inside `.models-credit-form`, and counting it would let the ask disappear unnoticed.
const readRow = (id) => p.evaluate((pid) => {
	const box = (e) => {
		if (!e) return null;
		const r = e.getBoundingClientRect();
		return { w: Math.round(r.width), h: Math.round(r.height) };
	};
	const row = document.querySelector('.models-prov[data-prov="' + pid + '"]');
	if (!row) return { row: false };
	const body = row.querySelector('.models-prov-body');
	const own  = body ? [...body.children].filter(e => e.classList.contains('models-refetch')) : [];
	const btn  = own[0] || null;
	const age  = body ? body.querySelector('.models-list-age') : null;
	return {
		row:     true,
		open:    !!body,
		asks:    own.length,
		text:    btn ? btn.textContent.trim() : '',
		off:     btn ? btn.disabled : null,
		btnBox:  box(btn),
		age:     !!age,
		ageText: age ? age.textContent.trim() : '',
		ageBox:  box(age),
	};
}, id);

const words = await p.evaluate(() => ({
	again:  DaimondI18n.t('models.ask_provider_again'),
	first:  DaimondI18n.t('models.ask_provider'),
	nokey:  DaimondI18n.t('models.add_key_first'),
	never:  DaimondI18n.t('models.list_never'),
}));

await openRow('groq');
const listed = await readRow('groq');
check('a provider that ALREADY lists models is still offered a way to ask again',
	listed.asks === 1 && !!listed.btnBox && listed.btnBox.w > 0 && listed.btnBox.h > 0,
	listed.asks === 0 ? 'no ask on a row with a list — it can be asked once and never again'
		: `${listed.asks} asks, box ${JSON.stringify(listed.btnBox)}`);
check('and the label says AGAIN, not the words for a provider that has never answered',
	listed.text === words.again && listed.text !== words.first, `“${listed.text}”`);
check('and it is live, because this row can ask', listed.off === false, 'disabled=' + listed.off);
check('the row says when the list was last asked for',
	listed.age && !!listed.ageBox && listed.ageBox.h > 0
	&& listed.ageText.length > 0 && listed.ageText !== words.never,
	listed.age ? `“${listed.ageText}”` : 'no .models-list-age — a count with no date on it');

await openRow('together');
const keyless = await readRow('together');
check('a provider with no key still DRAWS the ask, rather than hiding it',
	keyless.asks === 1 && !!keyless.btnBox && keyless.btnBox.w > 0 && keyless.btnBox.h > 0,
	keyless.asks === 0 ? 'nothing drawn — indistinguishable from a guard working'
		: JSON.stringify(keyless.btnBox));
check('drawn disabled, and saying what is missing',
	keyless.off === true && keyless.text === words.nokey, `“${keyless.text}” disabled=${keyless.off}`);
check('and a list never asked for says so',
	keyless.age && keyless.ageText === words.never, `“${keyless.ageText}”`);

await openRow('credits');
const minted = await readRow('credits');
check('the credits row keeps its one affordance and gains no ask',
	minted.open && minted.asks === 0 && !minted.age,
	minted.open ? `${minted.asks} asks, age=${minted.age}` : 'the row did not open');

// The button is wired, not decoration. The label flips the instant it is pressed; what the
// provider then says is the provider's business and is not waited for here.
const pressed = await p.evaluate(() => {
	const asking = DaimondI18n.t('models.asking');
	const body = document.querySelector('.models-prov[data-prov="groq"] .models-prov-body');
	const btn  = body ? [...body.children].find(e => e.classList.contains('models-refetch')) : null;
	// A missing button is a FAILURE to report, not an exception to die on: a break that
	// removes it must still reach the summary and the browser must still be closed.
	if (!btn) return { asking, there: false, now: '', off: null };
	btn.click();
	return { asking, there: true, now: btn.textContent.trim(), off: btn.disabled };
});
check('pressing it actually asks — the label and the button both change at once',
	pressed.there && pressed.now === pressed.asking && pressed.off === true,
	pressed.there ? `“${pressed.now}”` : 'there is no button to press');

// THE MOMENT ITSELF REACHES THE LINE. The words belong to the locale files; the wiring belongs
// here. A stand-in table with a marked placeholder proves the stamp is interpolated whatever
// the sentence around it turns out to say, and does it now rather than after the locales land.
const dated = await p.evaluate(async (stamp) => {
	DaimondI18n.register('de', {
		'models.list_asked': 'A<{when}>B',
		'models.list_never': 'NEVER',
	});
	await DaimondI18n.setLocale('de');
	window.DaimondModels.render();
	const at = (pid) => {
		const e = document.querySelector('.models-prov[data-prov="' + pid + '"] .models-list-age');
		return e ? e.textContent.trim() : '';
	};
	const out = { asked: at('groq'), never: at('together'),
		day: new Date(stamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
	await DaimondI18n.setLocale('en');
	return out;
}, STAMP);
check('the age line interpolates the moment the list was asked for',
	/^A<.+>B$/.test(dated.asked), `“${dated.asked}”`);
check('and the moment is THIS list’s, not some other date',
	dated.asked.includes(dated.day), `“${dated.asked}” should carry “${dated.day}”`);
check('while a list never asked for takes the other sentence entirely',
	dated.never === 'NEVER', `“${dated.never}”`);

// ── A catalogue that has gone stale asks for itself ─────────────────────
//
// Everything above is somebody pressing something. This is the app deciding, which is why the
// checks below count requests rather than reading the panel: the failure mode of a self-refresh
// is not "nothing happened", it is "four thousand things happened", and no amount of looking at
// the screen can tell those apart from the one thing that should have.
//
// The fixture providers are same-origin, so a request to one is a request this test fully
// controls and no CORS preflight comes with it. Four of them are seeded WITHOUT a key and given
// one later, which is the only way to hold a row back from the boot pass and still have it due
// when the panel opens.

const NOW  = Date.now();
const DAY  = 24 * 60 * 60 * 1000;
const OLD  = NOW - 3 * DAY;			// three days: stale by any reading of the threshold
const NEW  = NOW - 60 * 60 * 1000;	// an hour: not stale by any reading of it

/// What the browser has asked for, by path, from inside the page. See the two instruments above.
const askedIn = () => p.evaluate(() => JSON.parse(JSON.stringify(window.__asked || {})));

/// Wait until a path has been asked for `want` times, or give up and let the check say so.
const settle = async (at, want, ms = 4000) => {
	const until = Date.now() + ms;
	for (;;) {
		const a = await askedIn();
		if ((a[at] || 0) >= want || Date.now() > until) return a;
		await p.waitForTimeout(120);
	}
};

await p.evaluate((t) => {
	const raw  = JSON.parse(localStorage.getItem('daimond-models-v2'));
	const at   = (leaf) => location.origin + '/' + leaf + '/v1/chat/completions';
	const row  = (leaf, key, fetched, extra) => Object.assign({
		name: leaf, url: at(leaf), key: key, keyEnc: '', models: ['listed-old'], fetched: fetched,
	}, extra || {});
	// Asked at boot: a key already in place, and a list three days old.
	raw.providers.bootp   = row('boot', 'boot-key', t.old);
	// Never asked, each for its own reason.
	raw.providers.fresh   = row('fresh', 'fresh-key', t.new);				// asked an hour ago
	raw.providers.nokeyp  = row('nokey', '', t.old);						// nothing to ask with
	raw.providers.sealedp = row('sealed', '', t.old, { keyEnc: 'not-a-real-blob' });	// locked
	// The minted row, given a readable key ON PURPOSE. Without one it would be skipped for want
	// of a key and the rule that actually protects it would never be reached.
	raw.providers.credits = row('credits', 'minted-key', t.old, { name: 'Daimond credits' });
	// Keyless for now, so the boot pass leaves them alone and the panel finds them due.
	raw.providers.stale   = row('fixture', '', t.old);
	raw.providers.refuse  = row('refuse', '', t.old);
	raw.providers.loopp   = row('loop', '', t.old);
	raw.providers.offp    = row('off', '', t.old);
	localStorage.setItem('daimond-models-v2', JSON.stringify(raw));
}, { old: OLD, new: NEW });

await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'models');
await settle('/boot/v1/models', 1, 6000);
await p.waitForTimeout(600);

const booted = await askedIn();
check('a stale catalogue is asked for when the app starts, with nobody watching',
	(booted['/boot/v1/models'] || 0) === 1,
	`${booted['/boot/v1/models'] || 0} asks — the boot is where a key pasted last year gets a list`);
check('a catalogue asked for an hour ago is left alone',
	!booted['/fresh/v1/models'], `${booted['/fresh/v1/models'] || 0} asks`);
check('the credits row is never asked automatically, however stale its list',
	!booted['/credits/v1/models'],
	`${booted['/credits/v1/models'] || 0} asks — every mint already refetches it`);
// A REQUEST COUNT IS NOT ENOUGH HERE, and the break proved it: `fetchModels` throws for want of
// a key before it reaches the network, so a provider asked in error issues nothing and looks, to
// a counter, exactly like one that was never asked. The gate record is what tells them apart —
// an ask that got as far as being stamped spent this row's floor and put a failure against a
// credential that was simply not there.
const gateAfterBoot = await p.evaluate(() => window.DaimondModels.listAsks());
check('a provider with no key is never asked',
	!booted['/nokey/v1/models'] && !gateAfterBoot.nokeyp,
	`${booted['/nokey/v1/models'] || 0} asks, gate ${JSON.stringify(gateAfterBoot.nokeyp || null)}`);
check('nor is one whose key is sealed',
	!booted['/sealed/v1/models'] && !gateAfterBoot.sealedp,
	`${booted['/sealed/v1/models'] || 0} asks, gate ${JSON.stringify(gateAfterBoot.sealedp || null)}`);

// The four keyless rows get their keys now, with the panel shut. Nothing may ask on the strength
// of a key alone: the two triggers are the boot, which has been and gone, and the panel opening.
const armed = await p.evaluate(async () => {
	const M = window.DaimondModels;
	// `loopp` and `offp` are left keyless: each belongs to a check that has to own the first
	// ask its provider ever gets, and a key given here would spend it on this panel opening.
	for (const id of ['stale', 'refuse']) await M.setKey(id, id + '-key');
	const list = document.getElementById('models-list');
	return { onScreen: !!(list && (list.offsetParent || list.getClientRects().length)) };
});
await p.waitForTimeout(500);
const quiet = await askedIn();
check('a key arriving with the panel shut asks for nothing by itself',
	armed.onScreen === false
	&& !quiet['/fixture/v1/models'] && !quiet['/refuse/v1/models'],
	armed.onScreen ? 'the panel was on screen; this proves nothing'
		: `${quiet['/fixture/v1/models'] || 0} / ${quiet['/refuse/v1/models'] || 0} asks`);

// ── Trigger one: the panel comes up ─────────────────────────────────────

await p.evaluate(() => { document.getElementById('astat-model').click(); });
await settle('/fixture/v1/models', 1, 5000);
await p.waitForTimeout(500);

const opened = await askedIn();
check('opening the panel asks the provider whose list has gone stale',
	(opened['/fixture/v1/models'] || 0) === 1,
	`${opened['/fixture/v1/models'] || 0} asks`);
const gateAfterOpen = await p.evaluate(() => window.DaimondModels.listAsks());
check('and still asks nothing of the fresh, the keyless, the sealed or the minted',
	!opened['/fresh/v1/models'] && !opened['/nokey/v1/models']
	&& !opened['/sealed/v1/models'] && !opened['/credits/v1/models']
	&& !opened['/loop/v1/models'] && !opened['/off/v1/models']
	&& !gateAfterOpen.nokeyp && !gateAfterOpen.sealedp && !gateAfterOpen.credits,
	JSON.stringify({ fresh: opened['/fresh/v1/models'] || 0, nokey: opened['/nokey/v1/models'] || 0,
		sealed: opened['/sealed/v1/models'] || 0, credits: opened['/credits/v1/models'] || 0,
		loop: opened['/loop/v1/models'] || 0, off: opened['/off/v1/models'] || 0,
		stamped: Object.keys(gateAfterOpen).filter(k => ['nokeyp', 'sealedp', 'credits'].includes(k)) }));

const landed = await p.evaluate(() => {
	const M = window.DaimondModels;
	const by = {};
	M.providers().forEach(x => { by[x.id] = x.models.slice(); });
	return { stale: by.stale, refuse: by.refuse, fresh: by.fresh };
});
check('the answer is kept: the row now lists what the provider just said',
	landed.stale.join() === 'listed-a,listed-b', landed.stale.join());
check('and a row nobody asked about is untouched', landed.fresh.join() === 'listed-old',
	landed.fresh.join());

// ── A refusal nobody asked for says nothing ─────────────────────────────
//
// The button reports the provider's own words, because somebody is waiting for them. This did
// not ask. An error across the panel of a user who has just opened it is the app blaming them
// for arriving, and the old list is still perfectly good.

const refused = await p.evaluate(() => {
	const n = document.getElementById('models-note');
	const M = window.DaimondModels;
	const st = M.listAsks().refuse || {};
	return {
		note:   n ? n.textContent.trim() : '(no message line)',
		seen:   !!(n && n.offsetParent !== null && n.textContent.trim()),
		models: (M.providers().find(x => x.id === 'refuse') || {}).models,
		fails:  st.fails, ok: st.ok, busy: st.busy,
	};
});
check('a provider that refuses an ask nobody made is asked exactly once',
	(opened['/refuse/v1/models'] || 0) === 1, `${opened['/refuse/v1/models'] || 0} asks`);
check('and says nothing whatever on the panel',
	refused.note === '' && refused.seen === false, `“${refused.note}”`);
check('and the list it already had still stands',
	(refused.models || []).join() === 'listed-old', (refused.models || []).join());
check('while the refusal is COUNTED, so the next one waits longer',
	refused.fails === 1 && refused.ok === false && refused.busy === false,
	JSON.stringify({ fails: refused.fails, ok: refused.ok }));

// ── Nothing is asked with nothing to ask over ───────────────────────────

const off = await p.evaluate(async () => {
	Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
	// The key arrives with the browser already knowing it is offline, so this row's very first
	// chance to be asked is one it must not take.
	await window.DaimondModels.setKey('offp', 'off-key');
	window.DaimondModels.render();
	const st = window.DaimondModels.listAsks().offp;
	return { onLine: navigator.onLine, stamped: !!st };
});
await p.waitForTimeout(400);
const offline = await askedIn();
check('a browser that knows it is offline asks nobody, and blames nobody for it',
	off.onLine === false && !offline['/off/v1/models'] && off.stamped === false,
	`${offline['/off/v1/models'] || 0} asks, gate stamped=${off.stamped}`);
await p.evaluate(() => { delete navigator.onLine; });

// ── THE LOOP TERMINATES ─────────────────────────────────────────────────
//
// This is the check the whole change is about. `fetchModels` ends in `save()`, daimond.js
// redraws the panel when the store is saved, and a redraw asks again — so the ask is inside its
// own trigger. The credit probe beside it measured that at four thousand requests in the seconds
// it took to hide and show a tab five times.
//
// A THOUSAND REDRAWS IN ONE SYNCHRONOUS RUN, which is the worst case and not a contrived one:
// nothing can answer while JavaScript is on the stack, so the list is exactly as stale at redraw
// one thousand as it was at redraw one, and only the in-flight test knows the difference. Then
// five hide-and-show cycles with a redraw each, once the answers have landed, which is what the
// floor is for. The endpoint is dropped rather than answered on purpose: an answer would stamp
// `fetched` and staleness would stop the loop on its own, hiding whether the gate works at all.

const REDRAWS = 1000;
const drove = await p.evaluate(async (n) => {
	const M = window.DaimondModels;
	await M.setKey('loopp', 'loop-key');		// its `save()` is the first redraw, and the first ask
	const t0 = performance.now();
	for (let i = 0; i < n; i++) M.render();		// nothing can answer while this runs
	return { ms: Math.round(performance.now() - t0) };
}, REDRAWS);
await p.waitForTimeout(1500);

const cycled = await p.evaluate(async (n) => {
	for (let i = 0; i < n; i++) {
		document.dispatchEvent(new Event('visibilitychange'));
		window.DaimondModels.render();
		await new Promise(r => setTimeout(r, 60));
	}
	return true;
}, 5);
await p.waitForTimeout(1200);

const loop  = await askedIn();
const asks  = loop['/loop/v1/models'] || 0;
const wire  = hits['/loop/v1/models'] || 0;
console.log(`  loop drive: ${REDRAWS} redraws in ${drove.ms}ms + 5 hide/show cycles`
	+ ` -> ${asks} asks (page), ${wire} requests (browser)`);
check('THE LOOP TERMINATES: a thousand redraws over one stale provider is ONE request',
	asks === 1,
	asks === 0 ? 'nothing was asked at all — the trigger is not wired'
		: `${asks} asks from ${REDRAWS} redraws, ${wire} of them reaching the network`);
check('and the browser agrees with the page about how many that was',
	wire === asks, `page ${asks}, browser ${wire}`);
check('the gate holds one ask, one failure and nothing in flight',
	await p.evaluate(() => {
		const st = window.DaimondModels.listAsks().loopp || {};
		return st.busy === false && st.fails === 1 && st.ok === false;
	}),
	JSON.stringify(await p.evaluate(() => window.DaimondModels.listAsks().loopp)));

await shot(s, 'models');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
if (BREAK) {
	if (bad.length) { console.log('the break was caught, as it should be'); process.exit(0); }
	console.log('THE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
