// verify_fsview.mjs — the workspace is one tree, and every entry says where it is.
//
// THE DEFECT. A path a file tool was given could be in any of four places — browser storage, a
// folder the user marked in, cloud storage, or Daimond's own store — and nothing in a listing or
// in a refusal said which. The model learnt it from failures, one round at a time. On the tune
// bank that was the LARGEST single bucket of tool errors: ~80 of 141 in r1 were a `file_read` or
// `file_list` of a path spelled relative to the wrong root, answered with the browser's own
// exception — `Error: OPFS: open dir 'src' failed: JsValue(NotFoundError: …)` — an envelope
// addressed to a developer that says nothing about the rule it broke.
//
// WHAT IS ASSERTED, all of it through the engine's own text:
//
//   1. A listing says where every non-local entry is, INSIDE the parentheses the page's two
//      readers already parse. A cloud-only DIRECTORY keeps the flag it used to lose.
//   2. `www/js/listing.js` reads those entries, and the sync census is unmoved by them: a
//      phantom entry here is what the other device deletes on (`dev/verify_refusedpath.mjs` 1c).
//   3. A small cloud-only file is fetched by the read itself; a large one is still refused, and
//      the refusal names `file_fetch` and the ceiling.
//   4. A path spelled against the wrong root is answered with the rule, the nearest folder that
//      exists, and what IS at the root — and never with `JsValue(`.
//   5. The store is always writable, whatever else is open.
//   6. The turn's composed prompt says where the turn is and what the root holds, so the model
//      never spends a round discovering it.
//
// WHAT IS NOT HERE, and why. `Where::Machine` and `would_invent_said` need a paired machine hand,
// which cannot be arranged under automation (`dev/HATES.md` Lane G §1, `dev/reflux.mjs`'s
// `opfsSplit`). Both are covered by Rust unit tests over stubbed marks instead —
// `test_every_kind_of_path_says_which_place_it_is_in_00`,
// `test_the_hands_listing_says_which_computer_it_is_of_00` and
// `test_the_invented_folder_refusal_names_the_three_places_00` in `src/tools.rs`.
//
// EACH CHECK PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_fsview.mjs --break noanno   # 1 and 2: the store roots lose their note
//   node dev/verify_fsview.mjs --break rawjs    # 4: the browser's exception reaches the model
//   node dev/verify_fsview.mjs --break nofetch  # 3: a small cloud file is refused again
//   node dev/verify_fsview.mjs                  # and then, clean
//
//   eval "$(bash dev/world.sh 7 --up)"
//   node dev/verify_fsview.mjs
//
// Needs dev/serve.mjs. No mock provider and no gateway: every call goes straight through
// `DaimondApp.run_tool`, which is the door the panels take.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break damages the ENGINE's own text on the way to the page, so what goes red is the
// assertion and not a mock. The wasm cannot be rebuilt per break, so the damage is done to the
// strings the engine emits, in the glue the page imports — which is the only lever a verifier
// has over a compiled bundle, and is enough because every check below reads text.
const BREAKS = {
	// The store roots stop saying what they are, which is the world before this landed.
	noanno: [["Daimond's own store: browser storage on this device, never on the machine", '', 1]],
	// The wrong-root sentence stops being composed, so `file_read` falls through to the raw
	// browser exception exactly as it used to.
	rawjs: [['is not in the workspace. Paths are relative to the workspace root',
		'JsValue(NotFoundError: nothing here)', 1]],
	// The name of the JS global that brings a file down, mangled, so the fetch the read makes for
	// itself cannot land. The refusal a read used to give is then the only answer again.
	// TWO occurrences, and that is the honest count: the bundle carries the literal in its data
	// section and again in the debug-name section a dev build keeps. Damaging both is one break.
	nofetch: [['__daimondCloudFetch', '__daimondCloudFetX', 2]],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const GLUE_SRC = fs.readFileSync(path.join(WWW, 'pkg/oxedyne_daimond.js'), 'utf8');
const WASM     = path.join(WWW, 'pkg/oxedyne_daimond_bg.wasm');

// The strings live in the WASM, not in the glue, so the damage is applied to the bytes the page
// fetches. Same length or shorter, padded with spaces: the data section's layout must not move.
let wasmBytes = fs.readFileSync(WASM);
for (const [find, repl, want] of (BREAKS[BREAK] || [])) {
	if (repl.length > find.length) {
		console.error(`--break ${BREAK}: the replacement is longer than what it replaces, which `
			+ 'would move every string after it. Write a shorter one.');
		process.exit(2);
	}
	const hay = wasmBytes.toString('latin1');
	const got = hay.split(find).length - 1;
	if (got !== want) {
		console.error(`--break ${BREAK}: expected ${want} occurrence(s) of\n  ${find}\nin the `
			+ `bundle but found ${got}; the anchor has moved and this break would patch nothing`);
		process.exit(2);
	}
	wasmBytes = Buffer.from(hay.split(find).join(repl.padEnd(find.length, ' ')), 'latin1');
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const PROFILE = scratch('pw', 'fsview' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({
	name:    'fsview',
	profile: PROFILE,
	connect: false,
	route:   async (page) => {
		if (BREAK) await page.route('**/pkg/oxedyne_daimond_bg.wasm', (r) => r.fulfill({
			status: 200, contentType: 'application/wasm', body: wasmBytes,
		}));
	},
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// One tool call through the app's own door, as the panels take it.
const tool = (name, args) => p.evaluate(async (a) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return String(await app.run_tool(a.name, JSON.stringify(a.args)));
}, { name, args });

// ── 1. Seed the four places ─────────────────────────────────────────────
await tool('dir_create', { path: 'docs' });
await tool('file_write', { path: 'docs/a.md', content: 'hello\n' });
await tool('dir_create', { path: 'diamonds' });
await tool('dir_create', { path: 'diamonds/d1' });
await tool('file_write', { path: 'diamonds/d1/keep.md', content: 'x\n' });

// Cloud storage, as `src/wasm/cloud.rs` reads it: a path-to-size map in localStorage, plus the
// one JS global that brings a file down. The stub COUNTS its calls and writes the bytes into
// OPFS, so an auto-fetch is observable rather than inferred.
const SMALL = 'docs/cloud.md';
const BIG   = 'archive/old/big.bin';
await p.evaluate(async (a) => {
	localStorage.setItem('daimond-cloud-paths', JSON.stringify({ [a.small]: 100, [a.big]: 300 * 1024 }));
	window.__fetched = [];
	window.__daimondCloudFetch = async (path) => {
		window.__fetched.push(path);
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path, content: 'x'.repeat(100) }));
		// The path is on this device now, so it leaves the index — which is what the real
		// `fetchDown` does through `__daimondCloudForget`.
		const ix = JSON.parse(localStorage.getItem('daimond-cloud-paths') || '{}');
		delete ix[path];
		localStorage.setItem('daimond-cloud-paths', JSON.stringify(ix));
		return 'OK';
	};
}, { small: SMALL, big: BIG });

// ── 2. The listing says where ───────────────────────────────────────────
const root = await tool('file_list', { path: '.' });
check(/^diamonds\/ {2}\(Daimond's own store: browser storage/m.test(root),
	'1a. the store root says what it is, inside the parentheses', root.split('\n')[0]);
check(/^archive\/ {2}\(in cloud storage\)$/m.test(root),
	'1b. a directory that exists only in cloud storage says so', root);
check(/^docs\/$/m.test(root),
	'1c. an ordinary directory is unannotated, because silence means here', root);

const docs = await tool('file_list', { path: 'docs' });
check(/^a\.md {2}\(6 bytes\)$/m.test(docs), '1d. a local file reads as it always did', docs);
check(/^cloud\.md {2}\(100 bytes, in cloud storage\)$/m.test(docs),
	'1e. a cloud-only file keeps its size and its flag', docs);

// ── 3. The one parser, and the census it feeds ──────────────────────────
const parsed = await p.evaluate((texts) => ({
	root: window.DaimondListing.parse(texts.root).map((e) => [e.name, e.dir, e.where]),
	docs: window.DaimondListing.parse(texts.docs).map((e) => [e.name, e.dir, e.where]),
}), { root, docs });
const whereOf = (rows, name) => (rows.find((r) => r[0] === name) || [])[2];
check(whereOf(parsed.root, 'diamonds') === 'store',
	'2a. the page reads the store root as the store', JSON.stringify(parsed.root));
check(whereOf(parsed.root, 'archive') === 'cloud',
	'2b. ...the cloud-only directory as cloud', JSON.stringify(parsed.root));
check(whereOf(parsed.root, 'docs') === 'local' && whereOf(parsed.docs, 'a.md') === 'local',
	'2c. ...and an unannotated entry as local', JSON.stringify(parsed.docs));
// THE PHANTOM ENTRY, which is what the other device deletes on. Every row the parser produced
// must be an entry the listing really carries — a note read as a file is the fault
// `dev/verify_refusedpath.mjs` check 1c was written about.
const names = parsed.root.map((r) => r[0]).concat(parsed.docs.map((r) => r[0]));
check(names.every((n) => n && !/ /.test(n) && !/[.]$/.test(n)),
	'2d. no annotation became an entry of its own', names.join(' | '));

// ── 4. Hydration on read ────────────────────────────────────────────────
const small = await tool('file_read', { path: SMALL });
const calls = await p.evaluate(() => window.__fetched.slice());
check(/fetched 100 bytes from cloud storage/.test(small),
	'3a. a small cloud-only file is fetched by the read itself and says so',
	small.split('\n')[0]);
check(/xxxx/.test(small), '3b. ...and the body arrives', small.slice(0, 60));
check(calls.length === 1 && calls[0] === SMALL,
	'3c. ...in exactly one fetch', JSON.stringify(calls));

const big = await tool('file_read', { path: BIG });
const after = await p.evaluate(() => window.__fetched.slice());
check(/file_fetch/.test(big) && /256 KiB/.test(big),
	'3d. a large one is still refused, naming file_fetch and the ceiling', big);
check(after.length === 1, '3e. ...and nothing was fetched for it', JSON.stringify(after));

// ── 5. The wrong root ───────────────────────────────────────────────────
for (const [name, args] of [
	['file_read', { path: 'src/util.js' }],
	['file_list', { path: 'src' }],
	['file_edit', { path: 'src/util.js', old_string: 'a', new_string: 'b' }],
]) {
	const out = await tool(name, args);
	check(/is not in the workspace/.test(out),
		`4a. ${name} of a wrong-root path names the rule`, out.slice(0, 110));
	check(/docs\//.test(out),
		`4b. ...and says what IS at the root`, out.slice(0, 160));
	check(!/JsValue\(/.test(out),
		`4c. ...and never hands over the browser's own exception`, out.slice(0, 110));
}

// ── 6. The store is always writable ─────────────────────────────────────
const wrote = await tool('file_write', { path: 'diamonds/d1/notes.md', content: 'kept\n' });
check(/Wrote/.test(wrote), '5a. a Diamond may always be written to', wrote.split('\n')[0]);
const back = await tool('file_read', { path: 'diamonds/d1/notes.md' });
check(/kept/.test(back), '5b. ...and read back', back.slice(0, 80));

// ── 7. The turn knows where it is ───────────────────────────────────────
//
// The orientation note rides in the turn's briefing, which `system_parts` composes and the Wire
// view reads — the same composition the request carries, which is the whole point of that getter.
const sys = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '',
		'moonshotai/kimi-k2.7-code', 256, 'You are Daimond.', true);
	return { wire: await app.wire_system('', '[]', '[]', '[]'), limits: app.turn_limits };
}).catch((e) => ({ err: String(e) }));
if (sys && typeof sys.wire === 'string') {
	check(/Where you are/.test(sys.wire),
		'6a. the composed prompt says where the turn is', sys.wire.slice(0, 80));
	check(/docs\//.test(sys.wire) && /diamonds\//.test(sys.wire),
		'6b. ...and names the root’s top-level entries', sys.wire.slice(0, 200));
	check(/"family":"kimi"/.test(sys.limits),
		'6c. the engine echoes which model family it detected', sys.limits.slice(-40));
	// The addendum is composed by `compose_prompt_for`, which the page calls to build the role
	// prompt BEFORE the app is constructed -- so it is asked of that entry point rather than of
	// the Wire, which reports whatever text it was handed.
	const composed = await p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		return {
			kimi:   mod.compose_prompt_for('chat', '', 'moonshotai/kimi-k2.7-code'),
			claude: mod.compose_prompt_for('chat', '', 'anthropic/claude-opus-5'),
		};
	});
	check(/ONE JSON object/.test(composed.kimi),
		'6d. a Kimi prompt carries Kimi\'s own addendum', composed.kimi.slice(-200));
	check(!/ONE JSON object/.test(composed.claude),
		'6e. ...and a Claude one does not', composed.claude.slice(-120));
	check(/Where files are/.test(composed.kimi) && /Where files are/.test(composed.claude),
		'6f. both are told where files are', 'PLACES_NOTE');
} else {
	check(false, '6. the Wire getter answered', sys && sys.err);
}

const errs = s.errs.filter((e) => !/favicon|404|401|402|502|net::ERR/.test(e));
check(errs.length === 0, '7. nothing throws while all this happens', errs.slice(0, 3).join(' | '));

console.log(`\n${bad ? 'FAILED' : 'passed'}: ${bad} failing check(s)`);
await s.close();
process.exit(bad ? 1 : 0);
