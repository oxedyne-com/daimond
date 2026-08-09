// verify_defaults.mjs — Help and the Optimiser are FEATURES, so everybody gets
// them; but a Diamond somebody deletes stays deleted.
//
// The two default Diamonds were treated as onboarding furniture: seeded only
// into an EMPTY rail, on the reasoning that a person with thirteen Diamonds does
// not want two more. The flag was written either way, so that decision was taken
// once and for ever. The consequence was reported in notes3, by the author, about
// his own app: "I do not see the Daimond Help or Daimond Optimiser diamonds at
// all." He never had an empty rail on the boot that offered them.
//
// They are not furniture. Daimond Help is the only thing that reads the guide
// mirror at `system/guide/`, and the Optimiser is the only thing that reads the
// usage digest at `system/usage/digest.md`. Withholding them withheld two
// features.
//
// What is pinned here, and none of it held before:
//   * a rail that already has a Diamond STILL receives the two defaults;
//   * booting again does not make a second copy of either;
//   * a default the user DELETES stays deleted, because the app must not argue.
//
// Proved against broken code: restore `if ((diamonds || []).length) { ...; return; }`
// at the top of `seedDefaultDiamonds` and the first check goes red.
//
//   node dev/verify_defaults.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM.
import fs from 'node:fs';
import { open, scratch, signInAs } from './harness.mjs';

const PROFILE = scratch('pw', 'defaults');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// The names in the STORE, sorted. The store rather than the rail, because the
/// question here is whether the two Diamonds were CREATED; whether the rail has
/// re-read since is a different property with its own verifier, and mixing the
/// two would make this file fail for reasons that are nothing to do with it.
const names = async () => (JSON.parse(await wasm(async (app) => await app.list_diamonds())))
	.map((d) => d.name).sort();

const HELP = 'Daimond Help';
const OPT  = 'Daimond Optimiser';

// `defaults: false` removes the two the first boot seeds, so this session owns
// the rail outright and the state below is built rather than inherited.
const s = await open({ name: 'defaults', profile: PROFILE, connect: false, defaults: false });
const { page } = s;

/// The store, driven directly, so the fixture is built rather than clicked.
const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
}, { src: fn.toString(), arg });

/// Reload, sign back in, and let the boot finish.
///
/// The sign-in is not optional: a reload lands on the LOCK SCREEN, and an app
/// sitting behind it never reaches `seedDefaultDiamonds` at all. Without this the
/// file reported that the defaults were never seeded, on a build that seeds them.
const reboot = async (settle) => {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'defaults');
	await page.waitForTimeout(settle);
};
try {
	await page.waitForTimeout(1200);

	// ── A rail that is not empty ─────────────────────────────────
	// One Diamond of the user's own, and the OLD flag set with the new one absent:
	// that is exactly an account which was using the app when the feature shipped,
	// was recorded as having been offered the defaults, and never saw them.
	await wasm(async (app) => { await app.create_diamond('Mine'); });
	await reboot(1500);

	await page.evaluate(() => {
		localStorage.setItem('daimond-defaults-seeded', '1');   // the old flag, as it was
		localStorage.removeItem('daimond-defaults-seeded-2');   // the re-ask
	});
	await reboot(2500);

	const after = await names();
	check(after.includes(HELP) && after.includes(OPT),
		'a rail that already holds a Diamond still receives both defaults', JSON.stringify(after));
	check(after.includes('Mine'), 'and the Diamond that was already there is untouched',
		JSON.stringify(after));

	// ── Once, not once per boot ──────────────────────────────────
	await reboot(2500);
	const twice = await names();
	check(twice.filter((n) => n === HELP).length === 1
		&& twice.filter((n) => n === OPT).length === 1,
		'booting again makes no second copy of either', JSON.stringify(twice));

	// ── A deletion is a decision, and the app must not argue ─────
	const gone = await wasm(async (app, name) => {
		const rows = JSON.parse(await app.list_diamonds());
		const row = rows.find((d) => d.name === name);
		if (!row) return 'no Diamond named ' + name;
		await app.delete_diamond(row.id);
		return '';
	}, HELP);
	if (gone) {
		check(false, 'a deleted default stays deleted', 'could not delete it: ' + gone);
	} else {
		await page.waitForTimeout(700);
		await reboot(2500);
		const back = await names();
		check(!back.includes(HELP), 'a deleted default stays deleted', JSON.stringify(back));
		check(back.includes(OPT), 'and deleting one does not take the other with it',
			JSON.stringify(back));
	}
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
