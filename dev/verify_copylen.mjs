// verify_copylen.mjs — the terseness census: word counts over en.js's UI copy.
//
// Two things this checks, both from `~/.claude-b/…/feedback_ui_copy_terse.md`: a label
// is the fewest words that name the thing, and detail belongs in the guide, not the
// panel. So this counts words per STRING VALUE in en.js (HTML tags and `{placeholder}`
// tokens stripped, since neither is a word a reader reads) and fails the gate when:
//
//   1. any `*_help` or `*_note` key runs to more than 12 words -- these are titles and
//      panel notes, the shortest-lived reading a user does -- unless the key is
//      MODEL-FACING (an instruction or description read by the model, not the user) and
//      named in `MODEL_FACING` below, with the reason it is exempt;
//   2. the census counts (strings >= 14 words, strings >= 40 words) exceed the
//      thresholds passed on the command line, so a regression against a known-good
//      baseline fails the gate without hand-checking two numbers each time.
//
//   node dev/verify_copylen.mjs                    # report only, exit 0
//   node dev/verify_copylen.mjs --max14 N --max40 M # fail if the counts exceed N / M
//
// Uses the same sandboxed `tableOf` approach as i18ncheck.mjs, so a key here is a key
// the app itself would read -- never a second opinion arrived at by regex.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'www', 'i18n');

function tableOf(file) {
	const src = fs.readFileSync(path.join(DIR, file), 'utf8');
	let caught = null;
	const sandbox = { window: { DaimondI18n: { register: (code, table) => { caught = table; } } } };
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { timeout: 5000 });
	return caught || {};
}

/// Model-facing keys are read by an agent, not shown in a panel, so the terseness rule
/// (a label, not a paragraph) does not apply to them. Each entry names the reason it is
/// exempt, checked against the key's actual use before being added here -- never just
/// because a string is long.
const MODEL_FACING = {
	'crystal.page_note': 'the daimon\'s own editing instructions for a capp page, composed into the model\'s turn — never rendered in a panel',
};

function words(s) {
	if (typeof s !== 'string') return 0;
	const stripped = s
		.replace(/<[^>]*>/g, ' ')      // markup, not read as words
		.replace(/\{[^}]*\}/g, ' ')    // {placeholder} tokens, not read as words
		.replace(/[·•]/g, ' ')
		.trim();
	if (!stripped) return 0;
	return stripped.split(/\s+/).filter(Boolean).length;
}

const table = tableOf('en.js');
const keys  = Object.keys(table);

const over12HelpNote = [];
const skippedModelFacing = [];
const at14 = [];
const at40 = [];

for (const k of keys) {
	const v = table[k];
	if (typeof v !== 'string') continue;
	const n = words(v);
	if (n >= 14) at14.push({ k, n });
	if (n >= 40) at40.push({ k, n });
	if (/(_help|_note)$/.test(k) && n > 12) {
		if (MODEL_FACING[k]) {
			skippedModelFacing.push({ k, n, why: MODEL_FACING[k] });
		} else {
			over12HelpNote.push({ k, n, v });
		}
	}
}

at14.sort((a, b) => b.n - a.n);
at40.sort((a, b) => b.n - a.n);
over12HelpNote.sort((a, b) => b.n - a.n);

console.log(`verify_copylen: ${at14.length} string(s) >= 14 words, ${at40.length} >= 40 words (of ${keys.length} keys).`);
console.log(`verify_copylen: ${over12HelpNote.length} *_help/_note key(s) over 12 words (excluding ${skippedModelFacing.length} model-facing).`);

if (skippedModelFacing.length) {
	console.log('  skipped as model-facing:');
	for (const s of skippedModelFacing) console.log(`    ${s.k} (${s.n}w) — ${s.why}`);
}

if (over12HelpNote.length) {
	console.log('  over 12 words:');
	for (const s of over12HelpNote) console.log(`    ${s.k} (${s.n}w): ${s.v}`);
}

// ── Gate mode ──────────────────────────────────────────────
const argv = process.argv.slice(2);
function argNum(flag) {
	const i = argv.indexOf(flag);
	return i >= 0 ? Number(argv[i + 1]) : null;
}
const max14 = argNum('--max14');
const max40 = argNum('--max40');

let fail = false;
if (over12HelpNote.length > 0) {
	console.error(`verify_copylen: FAIL — ${over12HelpNote.length} *_help/_note key(s) exceed 12 words.`);
	fail = true;
}
if (max14 != null && at14.length > max14) {
	console.error(`verify_copylen: FAIL — ${at14.length} strings >= 14 words, over the ${max14} ceiling.`);
	fail = true;
}
if (max40 != null && at40.length > max40) {
	console.error(`verify_copylen: FAIL — ${at40.length} strings >= 40 words, over the ${max40} ceiling.`);
	fail = true;
}

process.exit(fail ? 1 : 0);
