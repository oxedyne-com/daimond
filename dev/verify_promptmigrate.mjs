// A renamed role carries its old prompt file across.
//
// `prompts/conductor.md` was the daimon's before the rename, and it is a file a
// user may have spent an afternoon on. Renaming the role without carrying it
// would leave that file in the workspace being read by nothing: the agent
// quietly back on the shipped default, the edited file still on disk looking as
// though it were in force. Of the three ways this could go, that is the worst,
// because nothing about it looks wrong.
//
//   node dev/verify_promptmigrate.mjs
//   node dev/verify_promptmigrate.mjs --break numbers   # must fail something
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();

// The break is the real defect, restored: the migration reading the old file
// through `file_read` — a MODEL-facing rendering — and writing THAT into the new
// one, so a prompt the user wrote by hand acquires `1\t` on every line, for good.
// It shipped that way, and the check that should have caught it was itself
// reading through the same door, so it failed for the wrong reason and was
// dismissed as noise for four days.
const BREAKS = {
	numbers: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\tvar old = await readBytes(from);',
		with: "\t\t\t\t\tvar old = await tools().run_tool('file_read', JSON.stringify({ path: from }));",
	}],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// `src` with `spec` applied, or a hard stop. An anchor that matched nothing
/// would leave the run below proving the opposite of what it claims.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The damaged files, ONE BODY PER FILE.
///
/// Every edit a break names for a file goes into the SAME body, in order, and
/// that one body is what the route serves. A `page.route` per edit spec does not
/// work and does not say so: Playwright hands a request to the LAST route
/// registered for its URL, so a two-edit break shipped only its second edit --
/// and still went red, for half the reason it claims, with nothing to notice it.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

const s = await open({ name: 'promptmig' + (BREAK ? '-' + BREAK : '') });
const { page } = s;
for (const [file, body] of damagedFiles()) {
	await page.route('**/' + file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
}
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

const wasm = (fn) => page.evaluate(async (src) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', `return (${src})(app);`))(app);
}, fn.toString());

/// The bytes on disk, NOT `file_read`'s rendering of them.
///
/// This verifier used to read every file through `run_tool('file_read')` and
/// compare the result to a plain string. `file_read` is a MODEL-facing
/// rendering — it prefixes every line with `N\t` — so the comparison could never
/// hold and all three checks had failed since the day they were written, against
/// a migration that was working. Worse, the failure looked exactly like the real
/// bug it was meant to catch: line numbers appearing in a user's own prompt.
/// `read_file` is the raw door and resolves against the same active root.
const raw = (p) => page.evaluate(async (path) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return await m.read_file(path); } catch (e) { return 'ERR'; }
}, p);

const MINE = '# My own daimon prompt\nKeep the crystal terse.\n';

// A prompt file written under the OLD name, as a user upgrading would have.
await wasm(async (app) => await app.run_tool('file_write',
	JSON.stringify({ path: 'prompts/conductor.md', content: '# My own daimon prompt\nKeep the crystal terse.\n' })));
await page.waitForTimeout(300);

// The real upgrade path: the user reloads into a build where the role has been
// renamed. Nothing is called directly -- boot has to do it, or it will not
// happen for anyone.
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'promptmig');       // a reload lands on the gate; boot resumes past it
await page.waitForTimeout(2000);

const after = { neu: await raw('prompts/daimon.md'), old: await raw('prompts/conductor.md') };
console.log(JSON.stringify(after));

check(after.neu === MINE, 'the edited prompt now reads under the new name');
check(after.old === MINE, 'and the old file is left alone rather than destroyed');

// The defect this file exists downstream of, hunted rather than assumed absent.
// The migration once read the old file with `file_read` and wrote the RESULT
// into the new one, baking `1\t` into a prompt the user had written by hand —
// permanently, and invisibly, because the same rendering put the numbers back on
// every subsequent read. Assert the stored bytes carry no such prefix, and gate
// it on the file existing so an absent file cannot satisfy it vacuously.
check(after.neu !== 'ERR' && !/^\d+\t/m.test(after.neu),
	`the carried prompt holds no line numbers (${JSON.stringify(after.neu.slice(0, 40))})`);

// Running again must not clobber a daimon.md the user has since edited.
await wasm(async (app) => await app.run_tool('file_write',
	JSON.stringify({ path: 'prompts/daimon.md', content: 'newer\n' })));
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'promptmig');       // a reload lands on the gate; boot resumes past it
await page.waitForTimeout(2000);
const again = await raw('prompts/daimon.md');
check(again === 'newer\n', `a second run does not overwrite the new file (${JSON.stringify(again)})`);

await s.close();
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad} check(s) failed`
		+ (bad ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad ? 0 : 1);		// a break MUST fail something
}
console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
process.exit(bad ? 1 : 0);
