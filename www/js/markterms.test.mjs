/* ============================================================
   Test -- NO "MARK" FOR A FOLDER ADDED TO A DIAMOND OR A CHAT
   (D-20261006-25; specs/daimond_mark_terms_20261006.md, ruled 6 Oct 19:24).
   ------------------------------------------------------------
   The owner ruled one vocabulary for putting a folder on this machine into
   a Diamond's or a chat's scope: "Add" for the act, "Workspace" for the
   place, "not yet in use here" for a folder no press has confirmed on this
   device, and the banner "{n} folders here need one more press". "Mark"
   survives only as a code name (`markshere.js`, the `marks.*` keys).

   Three surfaces are checked, because the word reaches him through all of
   them:
     1. the app's strings for that idea, in every locale, carry no word for
        "mark" in that locale (German Markierung, Japanese マーク, and so on);
     2. the guide's §7 in every locale says "added", and the seven
        translations are translations, not the English paragraph;
     3. the engine's model-facing text never asks the user to "mark" a
        folder in, so the daimon does not teach him the retired word.
   False friends are not this idea and are not checked: a trust match, a
   tracker's "Mark done", browser storage "Marked persistent", a taint mark.

   Run:  node www/js/markterms.test.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const WWW   = path.join(HERE, '..');
const SRC   = path.join(WWW, '..', 'src');
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];

// The word each locale used for "mark" before the ruling.
const MARK = {
	'en':      /\bmark(s|ed|ing)?\b/i,
	'de':      /markier/i,
	'es':      /\bmarc(a|as|ado|ada|ar)\b/i,
	'fr':      /\bmarqu(e|es|é|ée|er)\b/i,
	'ja':      /マーク/,
	'ko':      /표시/,
	'pt-BR':   /\bmarc(a|as|ado|ada|ar)\b/i,
	'zh-Hans': /标记/,
};

// The scope family: every string that names a folder added to a Diamond or a chat.
const KEYS = [
	'attach.ws_mark', 'attach.ws_add', 'attach.add_mark', 'attach.pick_mark_title',
	'attach.mark_note', 'attach.mark_focus', 'attach.ws_help', 'attach.ws_empty',
	'dws.confirm_here', 'dws.confirm_old',	// ws2 removed dws.mark_here(_help) with the scope tree
	'marks.waiting.one', 'marks.waiting.other', 'marks.waiting_why', 'marks.no_record',
	'marks.not_saved', 'marks.made_before', 'marks.use_here', 'marks.use_all',
	'marks.use_help', 'marks.use_ask',
];

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// A locale file hands its table to `DaimondI18n.register`, as dev/i18ncheck.mjs reads it.
function tableOf(code) {
	const src = fs.readFileSync(path.join(WWW, 'i18n', code + '.js'), 'utf8');
	let caught = null;
	const sandbox = { window: { DaimondI18n: { register: (c, t) => { caught = t; } } } };
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { timeout: 5000 });
	return caught || {};
}

// ── 1. The app's strings ────────────────────────────────────
const T = {};
for (const c of LOCALES) T[c] = tableOf(c);
for (const c of LOCALES) {
	const missing = KEYS.filter((k) => !(k in T[c]));
	check(c + ': every key of the scope family is present', missing.length === 0, missing.join(' '));
	const said = KEYS.filter((k) => k in T[c] && MARK[c].test(T[c][k]));
	check(c + ': no string of the scope family says "mark"', said.length === 0,
		said.map((k) => k + '=' + JSON.stringify(T[c][k])).join(' '));
}
// The ruled English words, verbatim.
check('en: the banner counts folders that need one more press',
	T.en['marks.waiting.other'] === '{n} folders here need one more press.', T.en['marks.waiting.other']);
check('en: a waiting folder is "not yet in use here"',
	/not yet in use here/.test(T.en['dws.confirm_here']) && /not yet in use here/.test(T.en['dws.confirm_old']),
	T.en['dws.confirm_here'] + ' | ' + T.en['dws.confirm_old']);
check('en: "Use here" and "Use all here" are kept',
	T.en['marks.use_here'] === 'Use here' && T.en['marks.use_all'] === 'Use all here');

// ── 2. The guide's §7 ───────────────────────────────────────
function section7(code) {
	const file = code === 'en' ? path.join(WWW, 'guide', 'email-web-files.html')
		: path.join(WWW, 'guide', code, 'email-web-files.html');
	const html = fs.readFileSync(file, 'utf8');
	const at = html.indexOf('id="s7"');
	if (at < 0) return '';
	const end = html.indexOf('<h3', at + 1);
	return html.slice(at, end < 0 ? undefined : end).replace(/<[^>]+>/g, ' ');
}
const en7 = section7('en');
check('guide en: §7 is "Added folders and your other devices"', /Added folders and your other devices/.test(en7),
	en7.slice(0, 80));
for (const c of LOCALES) {
	const s = section7(c);
	check('guide ' + c + ': §7 exists', s.length > 0);
	const hit = s.match(MARK[c]) || (c !== 'en' && s.match(MARK.en));
	check('guide ' + c + ': §7 says no "mark"', !hit, hit && hit[0]);
	if (c !== 'en') {
		check('guide ' + c + ': §7 is translated, not the English', !/your other devices/.test(s));
	}
}

// ── 3. The engine's model-facing text ───────────────────────
// The text before each file's test module, with comment lines dropped and Rust's
// line continuations joined, so a phrase split across source lines still reads whole.
// `for mark in ...` is a Rust loop over a variable, not words, so it is not matched.
function engineText(rel) {
	const s = fs.readFileSync(path.join(SRC, rel), 'utf8');
	const cut = s.search(/\n(#\[cfg\(test\)\]\s*\n)?mod tests \{/);
	return (cut < 0 ? s : s.slice(0, cut))
		.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
		.replace(/\\\n\s*/g, '').replace(/\\n/g, ' ');
}
const FOLDER_MARK = /(?<!\bfor\s+)\bmark(ed|ing|s)?\s+(it\s+|one\s+|them\s+|a folder\s+)?(in|into)\b|\bmarked\s+(on|through)\b|\brecorded marks\b|\bMarked into\b/gi;
for (const rel of ['tools.rs', 'prompts.rs', 'wasm/app.rs']) {
	const said = [...engineText(rel).matchAll(FOLDER_MARK)].map((m) => m[0]);
	check('engine ' + rel + ': no folder is "marked" in', said.length === 0, said.join(' | '));
}
check('engine prompts.rs: the AI says to add the folder with the + in the Workspace group',
	/add the folder with the \+ in the Workspace group/.test(engineText('prompts.rs')));

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks failed' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);
