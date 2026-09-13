// verify_folderloss.mjs — a search that NAMES a withdrawn grant is not a withdrawn grant.
//
// THE DEFECT, turn 53, 2026-09-13. The daimon ran `file_search` for
// `on the user's screen|ask_result|drawn` over its own source. One hit was the doc comment in
// `src/wasm/opfs.rs` that explains what a withdrawn folder grant looks like, and that sentence
// names `NotAllowedError`. `ToolRegistry::try_dispatch_unbilled` ran `is_folder_lost` over EVERY
// result's text, success or failure, and the predicate was a bare containment test — so the
// search's own HITS were read as the browser revoking the folder. `handlePermissionLoss` dropped
// the workspace to OPFS, and every later `code/` read, search and edit was refused by
// `folderVerdict`. The browser had revoked nothing. The turn cost about A$1.32 and ended with no
// commit.
//
// WHAT IS ASSERTED, in the real page against the real bundle:
//
//   1. A `file_search` whose hits carry the exception's name SUCCEEDS, raises no
//      `daimond:folder-lost`, and leaves the workspace in folder mode.
//   2. A `file_read` AFTER that search still answers — the folder is still there, which is the
//      half a user actually lost.
//   3. A read that genuinely fails on a withdrawn grant DOES raise the alarm, from the same door.
//      Without this the fix would be satisfied by never raising it at all, which is the older bug.
//   4. A read that fails any other way (a missing file) raises nothing.
//   5. `friendlyError` leaves a refusal's own sentence alone when it carries numbers. The crystal
//      hot-part refusal names a ceiling and a size, and was being shown to the reader as "could
//      not reach that endpoint" — eleven times in that turn, while the sentence it replaced said
//      what to change. Node-side, over the shipped source, the way verify_classifier_phrases does.
//
// FOLDER MODE IS REAL HERE, not faked in the glue. `set_workspace_dir` is handed the OPFS root
// handle, which IS a `FileSystemDirectoryHandle`, so the Rust override is set and
// `opfs::folder_open()` — the term the alarm actually reads — is true. A `showDirectoryPicker`
// grant cannot be answered under automation (dev/HATES.md, Lane G §1); this is the same override
// by the only other door that sets it.
//
// THE WITHDRAWAL IS INJECTED AT THE BROWSER, not at the glue: `getFileHandle` is made to reject
// with a real `DOMException` named `NotAllowedError` for one leaf name. That is what a revoked
// grant is, and it is the evidence the fix now reads.
//
//   node dev/verify_folderloss.mjs --break mirrorany  # check 5: any failed read drops the folder
//   node dev/verify_folderloss.mjs --break anynumber  # a bare number is a status again
//   node dev/verify_folderloss.mjs --break roadword   # a refusal reads as a dead road again
//   node dev/verify_folderloss.mjs                    # and then, clean
//
//   bash dev/world.sh 28 --up ; eval "$(bash dev/world.sh 28 --env)"
//   node dev/verify_folderloss.mjs
//   bash dev/world.sh 28 --down
//
// Needs dev/serve.mjs only. No gateway and no mock provider: nothing here runs a turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const WWW  = path.join(ROOT, 'www');
const SRC  = 'js/daimond.js';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
//
// A compiled bundle cannot be rebuilt per break, so the Rust half of the rule is proved against
// broken code by its unit test instead — `test_a_folder_is_lost_only_on_a_failed_calls_own_\
// withdrawn_grant_00` in src/tools.rs fails outright on the old rule. What CAN be damaged here is
// the page's own mirror of it (`folderWasLost`), which decides the same question for the panel's
// direct reads, and the status arms of `friendlyError`. Each break has a check that goes red.
const MIRROR = "\treturn text.indexOf('NotAllowedError') >= 0;";
const STATUS = '\t\tvar code = httpStatus(s);';
const ROADRE = 'ECONNREFUSED|connection refused|dns/i;';
const BREAKS = {
	// The panel's own door stops testing what it caught, so an ordinary failed read is a
	// withdrawal — which is the bug on the other side of this one, and check 5 is about it.
	mirrorany: [{ file: SRC, find: MIRROR, with: "\treturn true;" }],
	// The status arms go back to reading a bare number out of any sentence.
	anynumber: [{ file: SRC, find: STATUS, with: "\t\tvar code = (/\\b(\\d{3})\\b/.exec(s) || [0, 0])[1] * 1;" }],
	// `BROWSER_ROAD` gets its bare `refused` back, which is how every refusal in that turn was
	// shown to the reader as an endpoint that could not be reached.
	roadword: [{ file: SRC, find: ROADRE, with: 'ECONNREFUSED|refused|dns/i;' }],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Serve the damaged copy of each file a break names, and abort if an anchor has moved.
async function serveBroken(page) {
	for (const b of (BREAKS[BREAK] || [])) {
		const full = path.join(WWW, b.file);
		const text = fs.readFileSync(full, 'utf8');
		if (text.split(b.find).length !== 2) {
			console.error(`--break ${BREAK}: the anchor below is not in ${b.file} exactly once, `
				+ `so this break would prove nothing:\n  ${b.find}`);
			process.exit(2);
		}
		const body = text.split(b.find).join(b.with);
		await page.route('**/' + b.file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── 5, first: the refusal's own sentence, node-side ──────────────────
//
// STATIC and first, because it needs no browser. `friendlyError` is lifted out of the shipped
// source and run verbatim, with `t` stubbed so a rewritten sentence is unmistakable: if any
// status arm fires, the answer is `[[err.…]]` rather than the refusal.
{
	// The break is applied HERE too, to the same source the browser is served, so one break
	// proves the node half and the browser half at once rather than one of them.
	let js = fs.readFileSync(path.join(WWW, SRC), 'utf8');
	for (const b of (BREAKS[BREAK] || [])) {
		if (b.file !== SRC) continue;
		if (js.split(b.find).length !== 2) {
			console.error(`--break ${BREAK}: the anchor below is not in ${b.file} exactly once:\n  ${b.find}`);
			process.exit(2);
		}
		js = js.split(b.find).join(b.with);
	}
	// By its CLOSING LINE, not by counting braces. `friendlyError` and `httpStatus` both carry
	// braces inside regex literals -- `/["{}]/g`, `\d{3}` -- and a depth count walks straight
	// past the end of the function. Every one of these is declared at one tab inside the module's
	// closure, so the first line that is exactly a tab and a brace is its end.
	const grab = (sig) => {
		const start = js.indexOf(sig);
		if (start < 0) { console.error(`could not find '${sig}' in ${SRC}`); process.exit(2); }
		const end = js.indexOf('\n\t}\n', start);
		if (end < 0) { console.error(`'${sig}' in ${SRC} has no closing line`); process.exit(2); }
		return js.slice(start, end + 3);
	};
	const line = (name) => {
		const m = js.match(new RegExp('^\\s*var ' + name + ' = .*$', 'm'));
		if (!m) { console.error(`could not find 'var ${name}'`); process.exit(2); }
		return m[0].trim();
	};
	const F = new Function(
		line('CLIENT_ROAD') + '\n' + line('BROWSER_ROAD') + '\n'
		+ grab('function stripAnsi(') + '\n' + grab('function isUnreachable(') + '\n'
		+ grab('function httpStatus(') + '\n' + grab('function friendlyError(') + '\n'
		+ "function t(k) { return '[[' + k + ']]'; }\n"
		+ 'return friendlyError;')();

	// The sentences a tool refuses with. Every one of them carries numbers, and the first is the
	// one the daimon met eleven times in a row.
	// `Refused: ` is `refusal_line`'s own opening (src/tools.rs, `REFUSAL_OPENING`), and it is
	// how the daimon's eleven file_edit refusals reached this function. `BROWSER_ROAD` carried a
	// bare `refused`, meaning connection-refused, so every one of them read as a dead road.
	const KEPT = [
		['Refused: file_edit: The HOT part of this crystal -- `title`, `summary`, `open` and every '
			+ 'section marked "hot": true -- may not exceed 4096 bytes; this write would leave it '
			+ 'at 4608. MOVE A SECTION TO COLD -- set "hot": false, or drop the `!` from its '
			+ 'heading -- or shorten the hot part.',
			'the crystal hot ceiling, the sentence of that turn'],
		['Refused: file_write: The crystal is this Diamond\'s summary and may not exceed 49152 '
			+ 'bytes; this write is 51200.',
			'the crystal total ceiling'],
		['Refused: run: the command was refused by the fence.',
			'a fence refusal, which carries the word and nothing else'],
		// Any refusal that COUNTS something can produce a number in the status ranges, which is
		// the second half of the defect: the arms tested for a number rather than for a status.
		['Refused: file_read: 404 files under src/ are granted to this turn, and that one is not.',
			'a refusal whose count reads like a status'],
	];
	console.log('a refusal keeps its own sentence, numbers and all');
	for (const [sentence, where] of KEPT) {
		const got = F(sentence);
		check(!/^\[\[err\./.test(got), `friendlyError keeps ${where}`, got.slice(0, 90));
	}
	// The control: a real transport or provider failure must STILL be rewritten, or the fix
	// would be "stop classifying", which loses the copy that tells a user what to do.
	const MAPPED = [
		['LLM: HTTP error: 401 Unauthorized', '[[err.rejected_401]]', 'a bad key'],
		['LLM: HTTP error: 429 Too Many Requests', '[[err.ratelimit_429]]', 'a rate limit'],
		['LLM: the provider returned HTTP 503', '[[err.server_5xx]]', 'a provider fault'],
		['LLM: fetch failed: TypeError: Failed to fetch', '[[err.unreachable]]', 'a dead road'],
	];
	console.log('and a real failure is still turned into copy a person can act on');
	for (const [sentence, want, where] of MAPPED) {
		check(F(sentence) === want, `friendlyError still maps ${where}`, F(sentence));
	}
}

// ── The browser session ──────────────────────────────────────────────
const PROFILE = scratch('pw', 'folderloss' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({
	name: 'folderloss', profile: PROFILE, connect: false,
	route: async (page) => {
		await serveBroken(page);
		// The counter has to exist before the app does, or a boot-time raise would be missed and
		// the counts below would be the wrong numbers for a good reason.
		await page.addInitScript(() => {
			window.__lost = 0;
			window.addEventListener('daimond:folder-lost', () => { window.__lost++; });
		});
	},
});
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);
const p = s.page;

try {
	/// One tool call through the app's own door, with BOTH halves of what happened.
	const tool = (name, args) => p.evaluate(async (a) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const r = await app.run_tool_outcome(a.name, JSON.stringify(a.args));
		return { text: String(r.text), outcome: String(r.outcome) };
	}, { name, args });

	// ── Seed a workspace that carries the trap ───────────────────
	//
	// The file is the one the daimon actually hit: the sentence in `src/wasm/opfs.rs` that
	// explains a withdrawn grant, which names the exception in plain prose.
	const TRAP = 'The browser reports a withdrawn grant as a `NotAllowedError`, which reaches\n'
		+ 'here inside the error text the tool returns, and is drawn on the user\'s screen.\n';
	await tool('dir_create', { path: 'code' });
	await tool('file_write', { path: 'code/opfs_note.rs', content: TRAP });
	await tool('file_write', { path: 'code/plain.rs', content: 'fn main() {}\n' });

	// ── Folder mode, by the door that really sets it ─────────────
	const mode = await p.evaluate(async () => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		mod.set_workspace_dir(await navigator.storage.getDirectory());
		return mod.workspace_mode();
	});
	check(mode === 'folder', '0. the workspace is in folder mode, by the override the alarm reads', mode);

	const before = await p.evaluate(() => window.__lost);

	// ── 1. The search that cost a turn ───────────────────────────
	const hit = await tool('file_search', { query: "on the user's screen|ask_result|drawn", path: 'code' });
	check(hit.outcome === 'done', '1a. the search succeeds', hit.outcome + ': ' + hit.text.slice(0, 80));
	check(hit.text.includes('NotAllowedError'),
		'1b. and its hits carry the exception\'s name, which is the whole point',
		hit.text.split('\n')[0]);
	await p.waitForTimeout(200);
	check(await p.evaluate(() => window.__lost) === before,
		'1c. and NOTHING said the folder was lost', `${before} → ${await p.evaluate(() => window.__lost)}`);
	check(await p.evaluate(async () =>
		(await import('/pkg/oxedyne_daimond.js')).workspace_mode()) === 'folder',
		'1d. the workspace is still in folder mode');

	// ── 2. The read that used to be refused ──────────────────────
	const after = await tool('file_read', { path: 'code/plain.rs' });
	check(after.outcome === 'done' && after.text.includes('fn main'),
		'2. a read after the search still answers', after.outcome + ': ' + after.text.slice(0, 60));

	// ── 4. An ordinary failure, asked BEFORE the positive half ───
	//
	// First, so the alarm below cannot be satisfied by one already ringing.
	const missing = await tool('file_read', { path: 'code/nosuchfile.rs' });
	check(missing.outcome !== 'done', '4a. a read of a missing file fails', missing.outcome);
	await p.waitForTimeout(200);
	const afterMissing = await p.evaluate(() => window.__lost);
	check(afterMissing === before, '4b. and costs nobody their folder', `${before} → ${afterMissing}`);

	// ── 3. A grant the browser really withdraws ──────────────────
	//
	// One leaf name, so every other operation — the store's included — is untouched.
	await p.evaluate(() => {
		const proto = FileSystemDirectoryHandle.prototype;
		const real = proto.getFileHandle;
		proto.getFileHandle = function (name, opts) {
			if (String(name) === 'revoked.rs') {
				return Promise.reject(new DOMException(
					'The request is not allowed by the user agent or the platform in the current '
					+ 'context.', 'NotAllowedError'));
			}
			return real.call(this, name, opts);
		};
	});
	const revoked = await tool('file_read', { path: 'code/revoked.rs' });
	check(revoked.outcome !== 'done', '3a. a read on a withdrawn grant fails', revoked.outcome);
	check(revoked.text.includes('NotAllowedError'),
		'3b. and says so in words a person can read', revoked.text.slice(0, 110));
	await p.waitForTimeout(200);
	check(await p.evaluate(() => window.__lost) > afterMissing,
		'3c. and THIS raises the alarm, from the same door',
		`${afterMissing} → ${await p.evaluate(() => window.__lost)}`);

	// ── 5. The panel's own door keeps the same discipline ───────
	//
	// `DaimondCore.readFile` does not go through the tool registry, so it carries its own mirror
	// of the rule (`folderWasLost`). A read that fails because the file is not there must cost
	// nobody their folder there either — and a read that fails on the withdrawal must still say
	// so, or the mirror would be satisfied by testing nothing at all.
	const lostBeforePanel = await p.evaluate(() => window.__lost);
	await p.evaluate(() => window.DaimondCore.readFile('code/stillnothere.rs').catch(() => {}));
	await p.waitForTimeout(200);
	check(await p.evaluate(() => window.__lost) === lostBeforePanel,
		'5a. a missing file read through the panel\'s own door raises nothing',
		`${lostBeforePanel} → ${await p.evaluate(() => window.__lost)}`);
	await p.evaluate(() => window.DaimondCore.readFile('code/revoked.rs').catch(() => {}));
	await p.waitForTimeout(200);
	check(await p.evaluate(() => window.__lost) > lostBeforePanel,
		'5b. and a withdrawn grant through the same door still does',
		`${lostBeforePanel} → ${await p.evaluate(() => window.__lost)}`);

	const threw = errors(s).filter((e) =>
		!/Failed to load resource|502|WebSocket|ERR_|NotFound|NotAllowed/i.test(e));
	check(threw.length === 0, '6. nothing threw in the page', threw.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

// THE COUNT IS PINNED. A check displaced by an edit -- or a browser half that threw before it
// ran -- otherwise leaves a green run that asserted less than it says. Update it deliberately.
const EXPECTED = 22;
if (ran !== EXPECTED) {
	bad++;
	console.log(`  FAIL exactly ${EXPECTED} checks must run — ran ${ran}`);
}

console.log(`\n${ran - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
