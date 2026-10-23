// gateway: none
// A key the provider rejects must not be reported "Saved."/connected: the BYOK
// form fetches /models with the key it was given, and a 401 there has to reach
// the user as a refusal rather than as a saved setting.
//
// The file used to say it also proved "a no-account stranger must have a way to
// create one from the credits pitch". It never did -- nothing below opens the
// pitch -- and the sentence is gone rather than left standing as a claim the
// run does not make.
//
// PROVED AGAINST A KEY THE MOCK ACCEPTS FIRST. `--break accept` sends a key the
// mock does NOT 401, so the note reads as a save and the check below must go
// red. A check that has only ever seen the failing input cannot tell the two
// apart.
//
//   node dev/verify_settings.mjs --break accept   # expected to FAIL
//   node dev/verify_settings.mjs                  # and then, clean
import { open, errors, signInAs, MOCK } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
// "reject" is the mock's sentinel: /v1/models 401s any key containing it (see
// dev/mockllm.mjs). Anything else is accepted.
const KEY = BREAK === 'accept' ? 'accept-me' : 'reject';

const s = await open({ name: 'settings', connect: false });

// Open settings and save a key the model-fetch will reject.
const result = await s.page.evaluate(async (arg) => {
	const door = document.getElementById('user-row');
	if (door) door.click();
	await new Promise(r => setTimeout(r, 300));
	const prov = document.getElementById('cfg-provider');
	if (!prov) return { missing: '#cfg-provider' };
	prov.value = 'custom'; prov.dispatchEvent(new Event('change', { bubbles: true }));
	await new Promise(r => setTimeout(r, 200));
	const url = document.getElementById('cfg-base-url');
	const key = document.getElementById('cfg-api-key');
	const save = document.getElementById('byok-save');
	const note = document.getElementById('byok-note');
	if (!url || !key || !save || !note) {
		return { missing: [['#cfg-base-url', url], ['#cfg-api-key', key], ['#byok-save', save],
			['#byok-note', note]].filter(p => !p[1]).map(p => p[0]).join(', ') };
	}
	url.value = arg.mock;
	url.dispatchEvent(new Event('input', { bubbles: true }));
	url.dispatchEvent(new Event('change', { bubbles: true }));
	key.value = arg.key;
	key.dispatchEvent(new Event('input', { bubbles: true }));
	key.dispatchEvent(new Event('change', { bubbles: true }));
	await new Promise(r => setTimeout(r, 1200));	// let the model fetch run and fail
	// Type a model by hand so validation passes and the key-rejection check is reached.
	const cus = document.getElementById('cfg-model-custom');
	if (cus) { cus.style.display = ''; cus.value = 'mock/fast'; cus.dispatchEvent(new Event('input', { bubbles: true })); }
	save.click();
	await new Promise(r => setTimeout(r, 400));
	return { note: note.textContent };
}, { mock: MOCK, key: KEY });

// A form that has moved is not a passing test: the checks below all read the
// note, and a note that is not there would read as "no rejection" forever.
check('the BYOK form is on the screen the settings cog opens',
	!result.missing, result.missing ? `missing ${result.missing}` : 'provider, base URL, key, save and note all present');

const note = String(result.note || '');
check('A KEY THE PROVIDER REJECTS IS REPORTED AS REJECTED',
	/rejected/i.test(note), `the note reads ${JSON.stringify(note)}`);
// The other half of the same claim: it must not ALSO say the thing was saved or
// connected, which is what the user acts on.
check('and is not reported saved or connected in the same breath',
	!/\bsaved\b|\bconnected\b/i.test(note), `the note reads ${JSON.stringify(note)}`);

// ── Models holds models (D-20261018-09 U4) ──────────────────────────────
//
// The Models view held thirteen selects of turn limits, Search and two folders
// (spec fault 5). Every control left in `#admin-models` must belong to a model
// or a provider: the list, the add button and the add-a-provider form. The
// rest went to Settings -> Limits, Search and Folders, each a home row of its
// own, and each must come back from a reload holding what was chosen -- the
// move is of the control, never of the stored value or its key.
const LIMITS = ['cfg-max-tokens', 'cfg-max-rounds', 'cfg-fold-at', 'cfg-context-cap', 'cfg-spend-cap',
	'cfg-crystal-cap', 'cfg-crystal-page-cap', 'cfg-crystal-hot-cap', 'cfg-versions-cap', 'cfg-delete-ask'];
const models = await s.page.evaluate(async () => {
	window.DaimondAdmin.home();
	document.getElementById('astat-model').click();
	await new Promise(r => setTimeout(r, 400));
	const view = document.getElementById('admin-models');
	const ok = (c) => c.closest('#models-list, #byok-form') || c.id === 'models-add';
	const stray = [...view.querySelectorAll('select, input, textarea, button')].filter(c => !ok(c))
		.map(c => '#' + (c.id || c.className || c.tagName));
	const prose = view.querySelector('[data-i18n-html="models.privacy"]') ? 1 : 0;
	return { shown: view.style.display !== 'none', stray, prose };
});
check('Models opens from its status row', models.shown);
check('THE MODELS VIEW HOLDS NO CONTROL THAT IS NOT A MODEL OR A PROVIDER',
	models.stray.length === 0, models.stray.length ? 'strays: ' + models.stray.join(' ') : 'none');
check('and no privacy paragraph under the provider form', !models.prose);

// Open one Settings section from its home row, as a person would.
const openSection = (row) => s.page.evaluate(async (row) => {
	window.DaimondAdmin.home();
	const b = document.getElementById(row);
	if (!b) return false;
	b.click();
	await new Promise(r => setTimeout(r, 400));
	return true;
}, row);

// Choose a value that is not the one standing, in every moved select.
const chosen = {};
const reached = await openSection('admin-open-limits');
check('Settings home has a Limits row', reached);
if (reached) {
	Object.assign(chosen, await s.page.evaluate((ids) => {
		const out = {};
		for (const id of ids) {
			const sel = document.querySelector('#admin-limits #' + id);
			if (!sel || sel.options.length < 2) { out[id] = null; continue; }
			sel.selectedIndex = sel.selectedIndex === sel.options.length - 1 ? 0 : sel.options.length - 1;
			out[id] = sel.value;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		}
		return out;
	}, LIMITS));
}
const searchReached = await openSection('admin-open-search');
check('Settings home has a Search row', searchReached);
if (searchReached) {
	chosen['set-search-engine'] = await s.page.evaluate(() => {
		const sel = document.querySelector('#admin-search #set-search-engine');
		if (!sel || sel.options.length < 2) return null;
		sel.selectedIndex = sel.selectedIndex === sel.options.length - 1 ? 0 : sel.options.length - 1;
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		return sel.value;
	});
}

await s.page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await s.page.waitForTimeout(800);

const back = {};
if (await openSection('admin-open-limits')) {
	Object.assign(back, await s.page.evaluate((ids) => {
		const out = {};
		for (const id of ids) {
			const sel = document.querySelector('#admin-limits #' + id);
			out[id] = sel ? sel.value : null;
		}
		return out;
	}, LIMITS));
}
if (await openSection('admin-open-search')) {
	back['set-search-engine'] = await s.page.evaluate(() => {
		const sel = document.querySelector('#admin-search #set-search-engine');
		return sel ? sel.value : null;
	});
}
for (const id of LIMITS.concat(['set-search-engine'])) {
	const want = chosen[id];
	check(`#${id} is in its new section and keeps its value across a reload`,
		want != null && back[id] === want, `chose ${JSON.stringify(want)}, reads ${JSON.stringify(back[id])}`);
}
// Folders is a home row only once a hand offers a folder (this world has none), so the
// placement is read from the DOM, and the row's absence is checked against that rule.
const folders = await s.page.evaluate(() => ({
	placed: ['grantroot-section', 'termroot-section']
		.every(id => !!document.querySelector('#admin-folders #' + id)),
	row: !!document.getElementById('admin-open-folders'),
}));
check("Daimond's folder and Terminal folder are in Folders", folders.placed, JSON.stringify(folders));
check('and with no hand to offer one, Settings home offers no Folders row', !folders.row);
check('Fold with is gone from Settings', await s.page.evaluate(() => !document.getElementById('cfg-fold-model')));

// 502 is this world with no gateway behind it; 401 is the rejection this file
// exists to drive.
const errs = errors(s).filter(e => !/502|Bad Gateway|401|Unauthorized/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
