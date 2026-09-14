/* ============================================================
   Test — a tool call that arrived as prose is drawn as CODE.
   ------------------------------------------------------------
   Turn 56, 2026-09-14. glm-5.3 wrote its own native call syntax
   into the reply text, with no JSON `tool_calls` beside it, and
   the page drew

       namedaimonfoldtimeout_ms600000worldtrue

   as the model's answer. `scrub()` in www/js/render.js keeps an
   unknown wrapper's TEXT and discards its markup, which is the
   right rule for every unknown tag but these three: here the
   markup IS the evidence, and stripping it turned a wire fault
   into a sentence.

   Two halves are checked, and they are separate fixes:

     1. `DaimondRender.leakBlock(fragment)` — the path the engine
        now drives. A one-line note, then the fragment inside a
        `<pre>`, escaped: nothing in it is meant to render. This
        is pure string work, so it runs here without a DOM.

     2. `scrub()` — the backstop, for a fragment that reaches the
        markdown door anyway. Asserted at SOURCE, because the
        whitelist walk needs a real `<template>` parse that this
        harness has not got; dev/verify_toolleak.mjs drives the
        live one in a browser.

     node www/js/toolleak.test.mjs
     node www/js/toolleak.test.mjs --break strip   # the old rule back
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || 'strip') : '';
})();

// The wire, verbatim, off the live turn — the head `<tool_call>verify<arg_key>`
// consumed upstream. The same bytes `src/llm.rs`'s tests are pinned to.
const FRAGMENT = 'name</arg_key><arg_value>daimonfold</arg_value>'
	+ '<arg_key>timeout_ms</arg_key><arg_value>600000</arg_value>'
	+ '<arg_key>world</arg_key><arg_value>true</arg_value></tool_call>';

// What the owner was shown instead: every tag gone, the words run together.
const AS_PROSE = 'namedaimonfoldtimeout_ms600000worldtrue';

// ── The breaks ───────────────────────────────────────────────────────
//
// `strip` puts the old unknown-wrapper rule back for these three tags, which is
// exactly the defect; `plain` makes `leakBlock` return the fragment as prose.
const BREAKS = {
	strip: {
		find: "\t\t\t\tif (LEAK_TAG[tag]) {",
		with: "\t\t\t\tif (false) {   // --break strip",
	},
	plain: {
		find: "\t\treturn '<div class=\"leak-note\">' + escapeHtml(note) + '</div>'",
		with: "\t\treturn escapeHtml(note) + String(fragment);   // --break plain\n\t\treturn '<div class=\"leak-note\">' + escapeHtml(note) + '</div>'",
	},
};

function source() {
	let src = readFileSync(join(HERE, 'render.js'), 'utf8');
	const spec = BREAKS[BREAK];
	if (spec) {
		if (!src.includes(spec.find)) {
			// A break whose anchor is gone patches nothing and launders a plain run
			// as proof. Loud, and fatal.
			console.error(`--break ${BREAK}: anchor not found in render.js. The break is stale.`);
			process.exit(1);
		}
		src = src.replace(spec.find, spec.with);
	}
	return src;
}

/// Load render.js the way a classic script is loaded, with only as much of a
/// browser as it touches at load time.
///
/// No `createElement`, deliberately: `sanitize` falls back to a full escape
/// without it, and nothing asserted here goes near the DOM walk.
function loadRender(src) {
	const window = {};
	const document = { addEventListener() {} };
	const fn = new Function('window', 'document', 'navigator', 'setTimeout', src);
	fn(window, document, { clipboard: null }, () => {});
	return window.DaimondRender;
}

const R = loadRender(source());

check('render.js exports leakBlock', typeof R.leakBlock === 'function');

const html = typeof R.leakBlock === 'function' ? R.leakBlock(FRAGMENT) : '';

// ── 1. The fragment lands in a `<pre>`, whole and escaped ────────────
check('1a the fragment is drawn inside a <pre>', /<pre[^>]*>/.test(html), html.slice(0, 80));
check('1b every angle bracket is escaped, so nothing in it renders',
	html.indexOf('<tool_call>') === -1 && html.indexOf('<arg_value>') === -1
	&& html.includes('&lt;/arg_key&gt;') && html.includes('&lt;arg_value&gt;'),
	html.slice(0, 200));
check('1c the fragment survives whole — every argument name and value is there',
	['name', 'daimonfold', 'timeout_ms', '600000', 'world', 'true']
		.every(w => html.includes(w)));
check('1d THE DEFECT: the tags are never run together into a word',
	html.indexOf(AS_PROSE) === -1);
check('1e a one-line note says what happened',
	/<div class="leak-note">[^<]+<\/div>/.test(html), html.slice(0, 120));

// ── 2. The note is not the fragment, and the fragment is not the note ─
check('2a the note comes before the fragment',
	html.indexOf('leak-note') < html.indexOf('<pre'));
check('2b nothing is dropped for an empty fragment',
	typeof R.leakBlock('') === 'string' && R.leakBlock('').includes('leak-note'));

// ── 3. The sanitiser's backstop, guarded at source ───────────────────
//
// The whitelist walk needs a real `<template>` parse; the live one is driven by
// dev/verify_toolleak.mjs. What is guarded here is that the rule exists and
// names the three tags, so it cannot be removed silently.
const src = source();
check('3a scrub names the three wrappers a leaked call is made of',
	/LEAK_TAG\s*=\s*wordSet\(\['TOOL_CALL', 'ARG_KEY', 'ARG_VALUE'\]\)/.test(src));
check('3b and keeps their MARKUP rather than only their text',
	/if \(LEAK_TAG\[tag\]\) \{[\s\S]{0,200}outerHTML/.test(src));

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${failures} check(s) failed`
		+ (failures ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(failures ? 0 : 1);
}
console.log(failures === 0
	? `\ntoolleak: all ${checks} checks passed`
	: `\ntoolleak: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
