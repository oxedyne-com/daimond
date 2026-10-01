/* ============================================================
   Test -- THE WORDS OF RATING U2, IN EIGHT LANGUAGES (unit F of
   specs/daimond_rating_u2_plan_20260930.md).
   ------------------------------------------------------------
   The rating widget, its popup, its tile and the Models page's read-only
   counts say nothing until every locale table holds their keys. A missing key
   falls back to English (i18n.js), so a German user would see an English chip
   in a German popup and nothing would fail; only a census can see it.

   Four claims are checked, and the first is checked against the Rust form
   rather than against a list typed here, so the tables cannot agree with a
   list that has itself drifted from `src/rating.rs`:
     1. every tag, scale word and dimension the form declares has a key in
        every locale, and so does every other key the widget reads;
     2. the plan's length budgets hold in every locale, counted in code
        points, because the five steps must fit one line at 390px;
     3. every placeholder the English carries is carried by the translation;
     4. the two tooltips of the Models page's retired buttons are gone.

   Run:  node www/js/ratingi18n.test.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const I18N  = path.join(HERE, '..', 'i18n');
const RATER = path.join(HERE, '..', '..', 'src', 'rating.rs');
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// A locale file hands its table to `DaimondI18n.register`, as dev/i18ncheck.mjs reads it.
function tableOf(code) {
	const src = fs.readFileSync(path.join(I18N, code + '.js'), 'utf8');
	let caught = null;
	const sandbox = { window: { DaimondI18n: { register: (c, t) => { caught = t; } } } };
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { timeout: 5000 });
	return caught || {};
}
const T = {};
for (const c of LOCALES) T[c] = tableOf(c);

const len = (s) => Array.from(String(s)).length;
const holders = (s) => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join(',');

// ── The form, read from the Rust source of truth ────────────
const rs = fs.readFileSync(RATER, 'utf8');
const tagIds   = [...rs.matchAll(/Tag \{ id: "([a-z_]+)"/g)].map((m) => m[1]);
const scaleIds = [...rs.matchAll(/\(-?\d,\s*"([a-z]+)"\)/g)].map((m) => m[1]);
const dimIds   = [...rs.matchAll(/\("([a-z]+)",\s*\d+\),?/g)].map((m) => m[1]);
check('the form declares 28 tags, 5 scale words and 4 dimensions',
	tagIds.length === 28 && scaleIds.length === 5 && dimIds.length === 4,
	tagIds.length + '/' + scaleIds.length + '/' + dimIds.length);

// ── The plan's keys, with the English it fixes ──────────────
// One deviation, recorded in the build log: the plan gave `followed` as "Followed instructions",
// 21 code points against its own budget of 20, so the English is "Did as instructed".
const WORDS = {
	'rating.aria_group':  'Rate this answer',
	'rating.aria_up':     'Rate up',
	'rating.aria_down':   'Rate down',
	'rating.aria_more':   'Rating details',
	'rating.title':       'Rate this answer',
	'rating.sec_score':   'Score',
	'rating.sec_tags':    'Tags',
	'rating.details':     'Details',
	'rating.note_label':  'In your words',
	'rating.where':       'Saved in this chat, on your devices.',
	'rating.model':       'Model: {model}',
	'rating.clear':       'Withdraw',
	'rating.who':         'Rating',
	'rating.log_line':    '{score} on {what}',
	'rating.log_answer':  'the answer of {time}',
	'rating.log_cleared': 'Withdrawn from {what}',
	'rating.log_gone':    'an answer no longer here',
	'rating.quote':       '“{text}”',
	'rating.tags_down':   'What was wrong',
	'rating.tags_up':     'What went well',
	'rating.scale.wrong': 'Wrong',
	'rating.scale.poor':  'Poor',
	'rating.scale.fine':  'Fine',
	'rating.scale.good':  'Good',
	'rating.scale.great': 'Great',
	'rating.dim.correct':  'Correct',
	'rating.dim.followed': 'Followed the instructions',
	'rating.dim.length':   'Right length',
	'rating.dim.style':    'Style',
	'rating.tag.wrong':        'Wrong',
	'rating.tag.ignored':      'Ignored instructions',
	'rating.tag.long':         'Too long',
	'rating.tag.short':        'Too short',
	'rating.tag.style':        'Tone or format',
	'rating.tag.tool':         'Tool use',
	'rating.tag.refused':      'Refused or hedged',
	'rating.tag.slow':         'Slow',
	'rating.tag.correct':      'Correct',
	'rating.tag.followed':     'Did as instructed',
	'rating.tag.concise':      'Concise',
	'rating.tag.style_good':   'Good style',
	'rating.tag.broke':        'Broke something',
	'rating.tag.wrong_change': 'Wrong change',
	'rating.tag.incomplete':   'Incomplete',
	'rating.tag.scope':        'Changed too much',
	'rating.tag.wiped':        'Lost content',
	'rating.tag.clean':        'Clean',
	'rating.tag.complete':     'Complete',
	'rating.tag.lost':         'Lost information',
	'rating.tag.bloated':      'Bloated',
	'rating.tag.faithful':     'Faithful',
	'rating.tag.tidy':         'Tidy',
	'rating.tag.tone':         'Tone',
	'rating.tag.ready':        'Ready to send',
	'rating.tag.not_useful':   'Not useful',
	'rating.tag.already_knew': 'Already knew',
	'rating.tag.useful':       'Useful',
	'modeldash.rating_counts': '{up} up · {down} down',
};
const KEYS = Object.keys(WORDS);

// Claim 1: the keys the form implies are among the keys the plan lists, and every one is everywhere.
check('every tag the form declares has a `rating.tag.<id>` key in the list',
	tagIds.every((id) => ('rating.tag.' + id) in WORDS),
	tagIds.filter((id) => !(('rating.tag.' + id) in WORDS)).join(' '));
check('every scale word the form declares has a `rating.scale.<word>` key in the list',
	scaleIds.every((id) => ('rating.scale.' + id) in WORDS));
check('every dimension the form declares has a `rating.dim.<id>` key in the list',
	dimIds.every((id) => ('rating.dim.' + id) in WORDS));
check('the list holds no tag the form does not declare',
	KEYS.filter((k) => k.startsWith('rating.tag.')).every((k) => tagIds.includes(k.slice(11))));
check('the plan lists ' + KEYS.length + ' keys', KEYS.length === 58, String(KEYS.length));

for (const c of LOCALES) {
	const gone = KEYS.filter((k) => typeof T[c][k] !== 'string' || T[c][k].trim() === '');
	check(c + ': every key is present and not blank', gone.length === 0, gone.slice(0, 5).join(' '));
}

// The English is exactly what the plan fixes, since the verifiers and the popup read it.
const wrongEn = KEYS.filter((k) => T.en[k] !== WORDS[k]);
check('en: the values are the plan’s', wrongEn.length === 0, wrongEn.slice(0, 5).join(' '));

// English labels are sentence case: nothing after the first word starts with a capital.
const shouty = KEYS.filter((k) => /\s[A-Z]/.test(String(T.en[k] || '').replace(/\{[a-z_]+\}/g, '')));
check('en: every label is sentence case', shouty.length === 0, shouty.join(' '));

// Claim 2: the budgets, in code points, in every locale.
const BUDGETS = [
	['scale words',       (k) => k.startsWith('rating.scale.'), 9],
	['tag labels',        (k) => k.startsWith('rating.tag.'),   20],
	['dimension labels',  (k) => k.startsWith('rating.dim.'),   26],
	['the popup title',   (k) => k === 'rating.title',          24],
];
for (const c of LOCALES) {
	for (const [what, pick, max] of BUDGETS) {
		const over = KEYS.filter(pick).filter((k) => len(T[c][k]) > max);
		check(c + ': ' + what + ' are at most ' + max + ' code points', over.length === 0,
			over.map((k) => k + '=' + len(T[c][k])).join(' '));
	}
}

// Claim 3: the placeholders. `{up}` and `{down}` are the Models page's, the rest the widget's.
for (const c of LOCALES) {
	const bad = KEYS.filter((k) => holders(T[c][k]) !== holders(WORDS[k]));
	check(c + ': every placeholder of the English is carried', bad.length === 0,
		bad.map((k) => k + ' wants ' + holders(WORDS[k]) + ' has ' + holders(T[c][k])).join('; '));
}

// A translation left in English is the silent failure; a few words are the same in a language,
// so the bar is a fifth, not none.
for (const c of LOCALES.filter((x) => x !== 'en')) {
	const same = KEYS.filter((k) => T[c][k] === T.en[k]);
	check(c + ': fewer than a fifth of the values are still English',
		same.length * 5 < KEYS.length, same.length + ' of ' + KEYS.length + ': ' + same.join(' '));
}

// Unit G removed the Models page's per-model buttons, so their two tooltips have no reader; a key
// with no caller is a translation someone pays for and nobody sees.
for (const c of LOCALES) {
	const left = ['modeldash.rate_up_help', 'modeldash.rate_down_help'].filter((k) => k in T[c]);
	check(c + ': the retired Models-page button tooltips are gone', left.length === 0, left.join(' '));
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks failed' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);
