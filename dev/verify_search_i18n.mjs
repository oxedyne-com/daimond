// verify_search_i18n.mjs — the search tool's strings, in all eight languages.
//
// `verify_i18n.mjs` already diffs whole key sets against en.js. This one is
// narrower and louder: it is about the keys SEARCH_CONTRACT.md §11 names, and
// when it fails it says which locale and which key, because "de: 3 missing
// keys" is a census and "de is missing search.no_key" is a fix.
//
// Four properties, and the last two exist because of defects that got through:
//
//   1. Every locale carries every key in §11. A key present only in English
//      falls back silently in the app, so nothing on screen looks wrong.
//   2. Every {placeholder} in the English survives into every translation. A
//      translation that drops {engine} renders a sentence with a hole in it,
//      and no screenshot would show a hole -- it reads as a finished sentence.
//   3. The SUBSTITUTED string is clean: no double space, no space at either
//      end, no `{` left standing. Japanese once emitted a stray space before
//      its particle and Chinese once glued a translated word onto an
//      untranslated one, and NEITHER was visible in the source strings --
//      both appeared only once the placeholder was filled in.
//   4. The two terms this release could have invented a second word for --
//      the API key and Daimond credits -- are word for word what the locale
//      already calls them at `models.api_key` and `money.daimond_credits`.
//
// No browser, no server, no gateway: the tables are read from disk.
//
//	node dev/verify_search_i18n.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const I18NDIR = path.join(HERE, '..', 'www', 'i18n');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// One locale table, out of its IIFE and into a plain object.
const loadTable = (code) => {
	let table = null;
	const src = fs.readFileSync(path.join(I18NDIR, code + '.js'), 'utf8');
	new Function('window', src)({ DaimondI18n: { register: (c, t) => { table = t; } } });
	return table;
};

// ── What §11 names ───────────────────────────────────────────────────
//
// Written out rather than derived from en.js: this file is the second reader
// of the contract, and a key quietly dropped from en.js should fail here
// rather than shrink the list being checked.
const KEYS = [
	'search.head', 'search.engine', 'search.engine_note', 'search.credits',
	'search.key', 'search.key_note', 'search.no_key',
	'search.kind_web', 'search.kind_news', 'search.kind_academic',
	'search.refused_serper', 'search.free_month',
	'web.pause', 'pause.refused.web',
	'egress.search_title', 'egress.search_body', 'egress.search_ok',
];

/// The consent dialog. Its own name, because several checks are only about it:
/// it is the one string a user reads before a query leaves their device.
const BODY = 'egress.search_body';

const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];

/// The five engine ids of §3, by the name a user sees. Proper nouns in Latin
/// script in every language, which is the whole reason the spacing around
/// `{engine}` has to be read back.
const ENGINES = ['Brave', 'Exa', 'Tavily', 'Serper'];

/// What each placeholder holds when the app fills it in. Every engine is tried
/// rather than one: `search.refused_serper` is only ever shown for Serper, and
/// a check that only ever composed "Brave" would not be reading the line the
/// user gets. `{node}` is a pause node's human name, and the app passes the
/// TRANSLATED one.
/// Engine DISPLAY names, as the egress dialog and the allowance line receive
/// them: sometimes a proper noun, sometimes a translated phrase. The second
/// kind is why the CJK spacing has to be read back with both.
const DISPLAY = (t) => ['Brave Search', 'Serper', t['search.credits'] || 'Daimond credits'];

const FILL = {
	engine: (t) => ENGINES.concat(DISPLAY(t)),
	node:   (t) => [t['pause.web'] || 'Web'],
	// Already grouped by toLocaleString() before it arrives — three groupings
	// a locale might use, so a separator added by hand shows up as a double.
	n:      () => ['1,000', '1 000', '1.000'],
	// The user's own text, truncated to 300 with an ellipsis. Two shapes that
	// have broken a dialog before: one carrying quotes of its own, and one
	// already ending in the ellipsis.
	query:  () => ['best "cold brew" ratio', 'a very long question…'],
};

/// Every way a string can be filled in: one per engine, times one per query,
/// times one per grouping of {n}. Small enough to enumerate, and enumerating
/// is the point — the defects this file exists for appear in ONE of the fills
/// and not the others.
const fills = (code, s) => {
	let out = [String(s)];
	for (const p of new Set((String(s).match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1)))) {
		if (!FILL[p]) continue;
		const vals = FILL[p](table[code]);
		out = out.flatMap((one) => vals.map((v) => one.split(`{${p}}`).join(v)));
	}
	return out;
};

const table = {};
for (const code of LOCALES) {
	try {
		table[code] = loadTable(code);
	} catch (e) {
		table[code] = null;
		check(`${code}: the table loads`, false, String(e.message));
	}
}
check('the eight locale files load', LOCALES.every((c) => table[c]), LOCALES.join(' '));

const EN = table.en || {};

// ── 1. Every locale carries every key ────────────────────────────────
{
	const gaps = [];
	for (const code of LOCALES) {
		if (!table[code]) continue;
		for (const k of KEYS) {
			const v = table[code][k];
			if (typeof v !== 'string')  gaps.push(`${code} is missing ${k}`);
			else if (!v.trim())         gaps.push(`${code} has ${k} empty`);
		}
	}
	check('every locale carries every key §11 names', gaps.length === 0, gaps.join('; '));
}

// ── 2. Every placeholder survives translation ────────────────────────
//
// Order is a translator's business and is not checked; presence is not.
{
	const holes = [];
	const names = (s) => (String(s).match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1)).sort();
	for (const k of KEYS) {
		const want = names(EN[k]);
		if (!want.length) continue;
		for (const code of LOCALES) {
			if (!table[code] || typeof table[code][k] !== 'string') continue;
			const got = names(table[code][k]);
			for (const p of new Set(want)) {
				if (!got.includes(p)) holes.push(`${code}/${k} drops {${p}}`);
			}
			for (const p of new Set(got)) {
				if (!want.includes(p)) holes.push(`${code}/${k} invents {${p}}`);
			}
		}
	}
	check('every placeholder in the English survives into every translation',
		holes.length === 0, holes.join('; '));
}

// ── 3. The substituted string, read back ─────────────────────────────
//
// Both halves matter. The RAW value catches a double space a translator typed;
// the SUBSTITUTED one catches what only appears once the placeholder is gone.
{
	const dirty = [];
	for (const code of LOCALES) {
		if (!table[code]) continue;
		for (const k of KEYS) {
			const raw = table[code][k];
			if (typeof raw !== 'string') continue;
			for (const [what, s] of [['source', raw]].concat(fills(code, raw).map((f) => ['substituted', f]))) {
				if (/ {2}/.test(s))        dirty.push(`${code}/${k} ${what}: double space — ${JSON.stringify(s)}`);
				if (/^\s|\s$/.test(s))     dirty.push(`${code}/${k} ${what}: space at an end — ${JSON.stringify(s)}`);
				if (what === 'substituted' && /[{}]/.test(s))
					dirty.push(`${code}/${k}: a brace survived substitution — ${JSON.stringify(s)}`);
			}
		}
	}
	check('no double space, no space at either end, no brace left standing',
		dirty.length === 0, dirty.join('; '));
}

// ── 3b. CJK spacing around a placeholder in Latin script ─────────────
//
// Two placeholders arrive in Latin script whatever the language: `{engine}`
// holds a proper noun or a display name, `{n}` holds digits. Each of the three
// files has a settled convention for what goes beside them, and each is
// different, so the rule is read off the file rather than off the language.
//
//   ja      spaces both — `API キー`, `{provider} 経由`, `{n} 件`, `{n} 分前`.
//   zh-Hans spaces both — `Daimond 额度`, `移除 {provider}`, `{n} 个`, `{n} 封`.
//   ko      spaces a following NOUN but glues a PARTICLE onto {engine}
//           (`{host}에`, `{provider}을(를)`), and glues the counter onto {n}
//           (`{n}개`, `{n}번`, `{n}줄`) — 24 of 24 in that file.
//
// Punctuation beside a placeholder is not spacing and is not checked: a
// full-width comma or colon takes no space in front of it in any of the three.
{
	const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
	const HANGUL = /[가-힯]/;
	// The particles this file already glues to a placeholder.
	const JOSA = /^(을\(를\)|이\(가\)|와\(과\)|은\(는\)|\(으\)로|으?로|에서|에게|까지|부터|을|를|이|가|은|는|와|과|의|에|도|만)/;
	const wrong = [];
	for (const code of ['ja', 'zh-Hans', 'ko']) {
		if (!table[code]) continue;
		for (const k of KEYS) {
			const s = table[code][k];
			if (typeof s !== 'string') continue;
			for (const m of s.matchAll(/\{(engine|n)\}/g)) {
				const ph = m[0], which = m[1];
				const after = s.slice(m.index + ph.length);
				const prev = s.slice(0, m.index).slice(-1), next = after.slice(0, 1);
				if (prev && (CJK.test(prev) || HANGUL.test(prev)))
					wrong.push(`${code}/${k}: ${ph} is glued to “${prev}” before it`);
				if (!next) continue;
				if (code === 'ko' && which === 'engine') {
					if (HANGUL.test(next) && !JOSA.test(after))
						wrong.push(`${code}/${k}: ${ph} runs into “${after.slice(0, 4)}” with neither a space nor a particle`);
				} else if (code === 'ko') {
					// The counter is glued, so a SPACE is what goes wrong here.
					if (/\s/.test(next) && HANGUL.test(after.trim().slice(0, 1)))
						wrong.push(`${code}/${k}: ${ph} is spaced off its counter “${after.trim().slice(0, 2)}”`);
				} else if (CJK.test(next)) {
					wrong.push(`${code}/${k}: ${ph} is glued to “${next}” after it`);
				}
			}
		}
	}
	check('ja and zh-Hans space a Latin placeholder; ko takes a particle on {engine} and glues the counter to {n}',
		wrong.length === 0, wrong.join('; '));
}

// ── 3c. {n} is not grouped twice ─────────────────────────────────────
//
// The count arrives already grouped by toLocaleString(), so the reader gets
// 1,000 or 1 000 or 1.000 as their own locale wants it. A separator written
// into the string on top of that reads as a real, larger figure rather than as
// a bug -- "1,000,000 searches a month free" is a promise nobody can keep --
// and it would be wrong in all eight locales at once, not just the CJK three,
// so this is not part of the spacing check above.
{
	const doubled = [];
	for (const code of LOCALES) {
		if (!table[code]) continue;
		for (const k of KEYS) {
			const s = table[code][k];
			if (typeof s !== 'string') continue;
			for (const m of s.matchAll(/\{n\}/g)) {
				const after = s.slice(m.index + m[0].length);
				if (/^[,.\u00a0\u202f ]\d/.test(after))
					doubled.push(`${code}/${k}: {n} is followed by \u201c${after.slice(0, 4)}\u201d \u2014 a digit separator on top of the one toLocaleString() already wrote`);
			}
		}
	}
	check('{n} carries no digit grouping of our own', doubled.length === 0, doubled.join('; '));
}

// ── 3d. No space between two Japanese or two Chinese characters ──────
//
// This is the check the other spacing one cannot be. 3b reads the TEMPLATE and
// can only ask whether a space sits beside the placeholder; whether that space
// is right depends on what the placeholder turns out to hold. `{engine}` holds
// a proper noun most of the time and a TRANSLATED phrase when the tier is
// credits, and one template cannot be correct for both:
//
//	検索には {engine} を使います
//	→ 検索には Brave Search を使います     ← right, Latin on one side
//	→ 検索には Daimond クレジット を使います ← wrong, a stray space before を
//
// That second line is the recorded Japanese defect exactly, and it is
// invisible in the source string. The rule that separates the two cases is not
// about particles at all: a space belongs between Latin and Japanese, and
// never between two Japanese characters. So compose, then look for a space
// with CJK on BOTH sides. Same in zh-Hans, where the same trap is a space
// between two Chinese words.
{
	const CJK = /[぀-ヿ㐀-䶿一-鿿]/;
	const wrong = [];
	for (const code of ['ja', 'zh-Hans']) {
		if (!table[code]) continue;
		for (const k of KEYS) {
			const raw = table[code][k];
			if (typeof raw !== 'string') continue;
			for (const s of fills(code, raw)) {
				for (const m of s.matchAll(/(.) (.)/gs)) {
					if (CJK.test(m[1]) && CJK.test(m[2]))
						wrong.push(`${code}/${k}: “${m[1]} ${m[2]}” — a space between two ${code === 'ja' ? 'Japanese' : 'Chinese'} characters, in ${JSON.stringify(s.slice(Math.max(0, m.index - 14), m.index + 16))}`);
				}
			}
		}
	}
	check('once filled in, no space sits between two Japanese or two Chinese characters',
		wrong.length === 0, [...new Set(wrong)].join('; '));
}

// ── 3c. The consent dialog keeps its shape ───────────────────────────
//
// `egress.search_body` is five paragraphs and four `\n\n`. A translation that
// runs them together passes every other check in this file and produces a wall
// of text in a permission dialog, which is a dialog nobody reads. And {query}
// — the user's own words, the thing that is about to leave — stands alone in
// its own paragraph: never wrapped in quotation marks, because the query may
// carry quotes of its own and a mismatched pair reads as corruption.
{
	const runs = (s) => (String(s).match(/\n+/g) || []).join('|');
	const want = runs(EN[BODY]);
	const broke = [], loose = [];
	for (const code of LOCALES) {
		const s = table[code] && table[code][BODY];
		if (typeof s !== 'string') continue;
		if (runs(s) !== want)
			broke.push(`${code}: ${JSON.stringify(runs(s))} not ${JSON.stringify(want)}`);
		// Its own paragraph: \n\n on both sides, and nothing between those
		// breaks but the placeholder itself.
		if (!/(^|\n\n)\{query\}(\n\n|$)/.test(s))
			loose.push(`${code}: ${JSON.stringify((s.match(/.{0,12}\{query\}.{0,12}/s) || ['(absent)'])[0])}`);
	}
	check(`${BODY} keeps every paragraph break (${want.split('|').length} of them)`,
		broke.length === 0, broke.join('; '));
	check('the query stands alone in its own paragraph, unquoted', loose.length === 0, loose.join('; '));
}

// ── 4. One word per thing ────────────────────────────────────────────
//
// The two terms this change could have coined a second word for. `search.key`
// is the same kind of thing as a provider key for inference, and the credits
// tier is the same money as everywhere else; a user must not meet two words
// for one thing because two lanes named it on different days.
//
// The credits group is three keys deep, and pt-BR had drifted: `Créditos
// Daimond` at `models.credits_row` against `Créditos do Daimond` at
// `money.daimond_credits`, in a file that takes the article for the product
// everywhere else. Seven locales agreed word for word and one did not, which
// is a typo with a long life rather than a translation somebody chose. Holding
// all three equal is what stops a fourth key arriving to three spellings.
for (const [what, group] of [
	['the API key',     ['search.key', 'models.api_key']],
	['Daimond credits', ['search.credits', 'money.daimond_credits', 'models.credits_row']],
]) {
	const [first, ...rest] = group;
	const off = [];
	for (const code of LOCALES) {
		if (!table[code]) continue;
		for (const k of rest) {
			if (table[code][k] !== table[code][first])
				off.push(`${code}: ${k} ${JSON.stringify(table[code][k])} vs ${first} ${JSON.stringify(table[code][first])}`);
		}
	}
	check(`${what} is one word per locale (${group.join(' = ')})`, off.length === 0, off.join('; '));
}

// ── 4b. No engine is written into a string ───────────────────────────
//
// `search.refused_serper` used to say "That engine", which pointed at nothing
// in two of the three places it is reached from. It names the engine now, and
// it does so through `{engine}` — writing "Serper" into thirteen strings
// across eight files is how a fifth engine arrives and eight files disagree.
{
	const written = [];
	for (const code of LOCALES) {
		if (!table[code]) continue;
		for (const k of KEYS) {
			const v = table[code][k];
			if (typeof v !== 'string') continue;
			for (const e of ENGINES) {
				if (new RegExp(`\\b${e}\\b`).test(v)) written.push(`${code}/${k} names ${e} outright`);
			}
		}
	}
	check('no engine is written into a string; {engine} carries the name', written.length === 0, written.join('; '));
}

// ── 5. Product nouns are left alone ──────────────────────────────────
{
	const lost = [];
	for (const k of KEYS) {
		if (!String(EN[k] || '').includes('Daimond')) continue;
		for (const code of LOCALES) {
			const v = table[code] && table[code][k];
			if (typeof v === 'string' && !v.includes('Daimond')) lost.push(`${code}/${k}`);
		}
	}
	check('"Daimond" is left untranslated wherever the English says it', lost.length === 0, lost.join(', '));
}

// ── 6. Every refusal says where the control is ───────────────────────
//
// This check has been both ways round, and the reason is worth keeping. The web
// refusal used to end "Press play on it to resume" and sent the reader into a
// dead end, because `root/web` had no control anywhere in the app: it was the
// one leaf nobody had given a widget. So the clause was stripped and this
// asserted its ABSENCE.
//
// The Web panel header has the control now. The clause is true again, and its
// three siblings never stopped saying it -- so a reader who is told how to
// resume a held mailbox and not a held page would reasonably conclude the page
// cannot be resumed at all. Consistency across the four is the property; the
// absence never was.
{
	const NAMES_A_CONTROL = [
		/press play/i, /auf Play/i, /Pulsa play/i, /pulsar play/i, /appuyez sur lecture/i,
		/Pressione play/i, /再生を押/, /재생을 누/, /播放键/, /播放按钮/,
	];
	// All four, in every language -- not the English alone. A clause dropped
	// from one locale is exactly the kind of thing a census of keys cannot see,
	// since the key is present and the sentence is merely poorer.
	const KINDS = ['turn', 'dispatch', 'web', 'mail'];
	const silent = [];
	for (const c of LOCALES) {
		for (const n of KINDS) {
			const v = table[c] && table[c]['pause.refused.' + n];
			if (typeof v !== 'string') continue;
			if (!NAMES_A_CONTROL.some((re) => re.test(v))) silent.push(`${c}/${n}`);
		}
	}
	check('every pause refusal says how to resume, in every language',
		silent.length === 0, silent.join(', '));
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
