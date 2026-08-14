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
import { open, errors, MOCK } from './harness.mjs';

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
	const cog = document.getElementById('settings-btn');
	if (cog) cog.click();
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

// 502 is this world with no gateway behind it; 401 is the rejection this file
// exists to drive.
const errs = errors(s).filter(e => !/502|Bad Gateway|401|Unauthorized/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
