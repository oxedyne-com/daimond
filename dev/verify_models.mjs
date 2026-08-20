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
//   node dev/verify_models.mjs --break notemissing   # the line taken back out of the markup
//   node dev/verify_models.mjs --break notewiped     # the line eaten by the next redraw
//   node dev/verify_models.mjs --break emptyonly     # the ask offered only to an empty provider
//   node dev/verify_models.mjs --break hidesealed    # the ask hidden, not disabled, when unusable
//   node dev/verify_models.mjs --break mintedtoo     # a second button on the credits row
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
// The one line three of the breaks below rewrite. Held once, so a break that stops matching
// fails loudly at `hurt` rather than quietly patching nothing.
const ASK_GUARD = "if (!p.minted) {\n\t\t\t\t\tvar refetch";

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
			"\t\tif (onScreen(el)) refreshCredits();\n\t\tel.innerHTML = '';\n",
			"\t\tif (onScreen(el)) refreshCredits();\n\t\tel.innerHTML = '';\n\t\tnote('');\n"),
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

const s = await open({
	name: 'models', connect: false,
	route: hurt ? async (pg) => {
		// The document is served at `/`, not at `/index.html`, so a glob on the file name
		// cannot match it.
		if (hurt.file.endsWith('index.html')) {
			await pg.route((url) => url.pathname === '/' || url.pathname === '/index.html',
				(r) => r.fulfill({ status: 200, contentType: hurt.type, body: hurt.body }));
		} else {
			await pg.route('**/' + path.basename(hurt.file),
				(r) => r.fulfill({ status: 200, contentType: hurt.type, body: hurt.body }));
		}
	} : null,
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
