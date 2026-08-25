// probe_notes.mjs — is each standing note still buying anything?
//
// `Role::compose` appends six notes to every chat and daimon request and a seventh to
// every reducer request.  `dev/prompt_cost.mjs` prices them.  This asks the other half:
// **take one out and does the model still do the thing the note claims to cause.**
//
// ── Why this is not `dev/reflux.mjs` ────────────────────────────────
//
// Reflux runs a whole turn through the real browser, the real extension and the real
// fence, which is the only way to measure a note whose effect is a TOOL LOOP -- and
// `--strip` was added to it for exactly that.  It costs a browser and about ten seconds
// a turn, so n is one or two and a single column cannot be read as a rate.
//
// Every note here governs ONE DECISION taken in ONE round: which tool to reach for, or
// what shape to answer in.  That decision can be read off a single request, so this runs
// it five times an arm on two models and reports a rate rather than an anecdote -- which
// is what "do not delete a note on one green run" actually requires.
//
// ── What makes it real ──────────────────────────────────────────────
//
// **Nothing here is transcribed.**  The system prompt and all twenty-nine tool schemas
// come out of `<log>.request.json`, which `dev/reflux.mjs`'s relay writes from the body
// it is about to forward -- so they are the words the app sent, not a copy of them.  The
// notes come out of `src/prompts.rs` through `promptparts.mjs`, and a note that is not a
// substring of that prompt is a hard stop rather than a silent zero.
//
// **No tool is ever executed.**  The reply's `tool_calls` are the measurement, so one
// round answers the question and the run cannot touch a file, a command or the network.
//
// ── What it cannot see ──────────────────────────────────────────────
//
// - **One question per note.**  A model that reaches for `file_show` here may not on
//   another phrasing.  This is a floor, not a rate over all phrasings.
// - **One round.**  A note that only bites on the fourth call of a long turn reads as
//   worthless here.  `dev/reflux.mjs --strip` is the instrument for that, and the two
//   are meant to be read together.
// - **`temperature` is not set**, so every provider default applies and a re-run will
//   not reproduce exactly.  That is why n is five and the column is a count.
//
//	node dev/probe_notes.mjs --request ~/.cache/daimond/lane-n/reflux/reflux.request.json
//	  --note VISION_NOTE,SHOW_NOTE   only these scenarios
//	  --model a/b,c/d                default haiku-4.5 and sonnet-4.5
//	  --n 5                          repetitions per arm
//	  --dry                          build every request, send none, print the shapes
//	  --keep <dir>                   write every raw reply there
//
// The key is read as `dev/reflux.mjs` reads it and there is no default:
//   ~/.config/oxedyne/daimond/openrouter.key (0600), or DAIMOND_PROBE_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readNotes, constText, PROMPTS } from './promptparts.mjs';
import { PANEL, BASELINE, FREE, priceOf } from './models.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DRY     = argv.includes('--dry');
const REQUEST = flag('request', path.join(os.homedir(), '.cache/daimond/lane-n/reflux/reflux.request.json'));
// `--model panel` is the whole panel from `dev/models.mjs`, `--model baseline` the two the
// standing findings were made on, `--model free` the one that costs nothing.  Anything else
// is taken as a comma-separated list of slugs, which are the provider's own and never guessed.
const MODELS  = (() => {
	const raw = String(flag('model', 'baseline'));
	if (raw === 'panel')    return PANEL;
	if (raw === 'baseline') return BASELINE;
	if (raw === 'free')     return [FREE];
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
})();
const N       = Number(flag('n', '5'));
const ONLY    = String(flag('note', '')).split(',').map((s) => s.trim()).filter(Boolean);
const KEEP    = flag('keep', '');
const MAXTOK  = Number(flag('max-tokens', '1400'));
// A CANDIDATE WORDING, put in the note's place and measured against it.  `--alt
// FOLD_NOTE=candidate.txt` runs the "with" arm on the file's words instead of the source's,
// so a proposed rewrite is scored the same way the shipped one is and on the same questions.
// This is the only honest way to change a note: the brief this file was written under says
// every change must be justified by a measurement, and taste is not one.
const ALT = new Map();
for (const spec of argv.filter((a) => a.startsWith('--alt='))
	.map((a) => a.slice(6))
	.concat((() => { const i = argv.indexOf('--alt'); return i >= 0 && argv[i + 1] ? [argv[i + 1]] : []; })())) {
	const eq = spec.indexOf('=');
	if (eq < 0) throw new Error(`--alt ${spec}: write it as NOTE=path/to/candidate.txt`);
	ALT.set(spec.slice(0, eq), fs.readFileSync(spec.slice(eq + 1), 'utf8').trim());
}

function readKey() {
	const env = (process.env.DAIMOND_PROBE_KEY || '').trim();
	if (env) return env;
	const file = process.env.DAIMOND_PROBE_KEY_FILE
		|| path.join(os.homedir(), '.config/oxedyne/daimond/openrouter.key');
	let text;
	try { text = fs.readFileSync(file, 'utf8'); }
	catch (e) { throw new Error(`No provider key. Put one in ${file} (0600), or set DAIMOND_PROBE_KEY.`); }
	const key = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
	if (!key) throw new Error(`${file} holds no key.`);
	return key;
}

// ── The words the app really sends ──────────────────────────────────

const req = JSON.parse(fs.readFileSync(REQUEST, 'utf8'));
const sysMsg = (req.messages || []).find((m) => m.role === 'system');
if (!sysMsg) throw new Error(`${REQUEST} carries no system message.`);
const SYSTEM = typeof sysMsg.content === 'string' ? sysMsg.content
	: (sysMsg.content || []).map((p) => (p && p.text) || '').join('');
const TOOLS = req.tools || [];
if (!TOOLS.length) throw new Error(`${REQUEST} carries no tool schemas.`);
const NOTES = readNotes();

/// The composed prompt with one note lifted out, exactly as `--strip` lifts it.
function without(name) {
	const text = NOTES.get(name);
	if (!text) throw new Error(`no note ${name}`);
	const cut = SYSTEM.replace('\n\n' + text, '');
	if (cut === SYSTEM) {
		throw new Error(`${name} is not in ${REQUEST}'s system prompt, so taking it out `
			+ 'measures nothing. Capture a request from a role that carries it.');
	}
	return cut;
}

// The reducer's whole prompt, which no chat request carries: assembled from the same two
// constants `Role::Reducer.compose("")` joins, and from nothing else.
const rsrc = fs.readFileSync(PROMPTS, 'utf8');
const REDUCER = constText(rsrc, 'DEFAULT_REDUCER') + '\n\n' + constText(rsrc, 'CRYSTAL_SCHEMA_NOTE');

// ── Reading a reply ─────────────────────────────────────────────────

const calls = (m) => (m && m.tool_calls || []).map((c) => ({
	name: (c.function || {}).name || '?', args: String((c.function || {}).arguments || ''),
}));
const called  = (m, n) => calls(m).some((c) => c.name === n);
const argsOf  = (m, n) => (calls(m).find((c) => c.name === n) || {}).args || '';
const said    = (m) => String((m && m.content) || '');
/// A fenced region is not the model doing the thing — it is the model showing it.
const unfenced = (t) => String(t).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

/// The verdict every `FOLD_NOTE` question is scored by, written once.
///
/// Four scenarios share it and it used to be copied into two of them, which is how a rule
/// gets fixed in one place and left wrong in the other.  The ladder is the note's own claims
/// in the order they matter:
///
/// - **`HARM` is `FOLD-ALL`** -- nothing of substance above the first fold, so the control
///   opens on the only content there is.  `dev/CONTRACT_FOLD.md` §5 calls that worse than not
///   having the feature, and `dev/PROMPT_NOTES.md` §5 records a rewrite that produced it 8
///   times in 8.
/// - **`PARTIAL` is a fold that exists and is wrong**: a `<summary>` of fewer than six words
///   is a label rather than a summary, which is the failure the owner reported on 2026-08-23;
///   a missing blank line after `</summary>` makes the whole element raw HTML and sends every
///   heading inside it to the reader as literal hashes.
/// - **`NONE` is a long answer with no fold at all**, and `MOOT` a short one, where the note
///   asks for nothing.
function foldVerdict(m) {
	const t = said(m);
	if (!t.trim()) return calls(m).length ? 'MOOT' : 'NONE';
	const open = t.indexOf('<details>');
	if (open < 0) return t.length > 700 ? 'NONE' : 'MOOT';
	if (t.slice(0, open).replace(/\s+/g, ' ').trim().length < 40) return 'HARM';
	const sum = /<summary>([\s\S]*?)<\/summary>/.exec(t);
	if (!sum || sum[1].trim().split(/\s+/).length < 6) return 'PARTIAL';
	if (!/<summary>[\s\S]*?<\/summary>\s*\n\s*\n/.test(t)) return 'PARTIAL';
	return 'GOOD';
}

// ── The scenarios ───────────────────────────────────────────────────
//
// Each names the note it takes out, the decision that note claims to cause, and the
// failure that makes the note worth its tokens.  `verdict` reads the reply and answers
// one of GOOD / HARM / NONE / MOOT, in `dev/PROMPTS_PROBE.md`'s vocabulary:
//
//   GOOD  the note's claimed behaviour happened
//   HARM  the named failure the note exists to prevent
//   NONE  neither: the behaviour did not happen and nor did the harm
//   MOOT  the model did something that left the question untested

const SCENARIOS = [
	{
		note: 'SEARCH_NOTE',
		claims: 'the model reaches for web_search rather than writing a search URL by hand',
		harm: 'an engine chosen on the user\'s behalf, and their money spent on it',
		user: 'What is the current stable version number of the Typst compiler? I do not know '
			+ 'the address of the page that says.',
		verdict(m) {
			if (called(m, 'web_search')) return 'GOOD';
			const f = argsOf(m, 'web_fetch');
			if (/[?&](q|query|search_query|p|wd)=/.test(f) || /\/search\b/.test(f)) return 'HARM';
			if (calls(m).length) return 'MOOT';
			return 'NONE';
		},
	},
	{
		note: 'SHOW_NOTE',
		claims: 'the model puts the document on the user\'s screen with file_show',
		harm: 'a courteous denial that the app can display something it has always displayed',
		user: 'I have just compiled report.pdf in this workspace. Put it on my screen so I can '
			+ 'look at the typeset pages.',
		verdict(m) {
			if (called(m, 'file_show')) return 'GOOD';
			const t = unfenced(said(m));
			if (/(can(?:'|no)?t|cannot|unable to|no way to|not able to)[^.]{0,60}(display|show|render|view|preview)/i.test(t)
				|| /(display|show|render|preview)[^.]{0,40}(is|are) not (supported|possible|available)/i.test(t)) {
				return 'HARM';
			}
			if (calls(m).length) return 'MOOT';
			return 'NONE';
		},
	},
	{
		note: 'VISION_NOTE',
		claims: 'the model reads the image file and looks at it',
		harm: 'an answer invented from the filename, or a denial that it can see pictures',
		user: 'shots/panel.png is a screenshot of the settings panel. Tell me what the third '
			+ 'row of it says.',
		verdict(m) {
			if (/\.png/i.test(argsOf(m, 'file_read'))) return 'GOOD';
			const t = unfenced(said(m));
			if (/(can(?:'|no)?t|cannot|unable to|not able to)[^.]{0,60}(see|view|look at|read|open|process|interpret)[^.]{0,30}(image|picture|screenshot|png)/i.test(t)
				|| /(image|picture|screenshot)s? (are|is) not something I can/i.test(t)) {
				return 'HARM';
			}
			if (calls(m).length) return 'MOOT';
			return 'NONE';
		},
	},
	{
		note: 'FOLD_NOTE',
		dev: true,
		claims: 'a long answer comes back short-first, with the working behind a <details>',
		harm: 'FOLD-ALL — everything folded, so the control opens on the only content there is',
		// NO FILE IS NAMED, deliberately: the question must be answerable without a tool, or
		// a turn that reasonably goes looking would score as a refusal to fold.
		user: 'Do not look at any file. From what you know of this application, argue whether a '
			+ 'Diamond\'s crystal is better kept as one JSON file per Diamond or as rows in a '
			+ 'single indexed store. Weigh both properly and then say which you would choose.',
		max_tokens: 1600,
		verdict: foldVerdict,
	},
	{
		// THE OWNER'S OWN CASE, and a second phrasing on purpose.  One question cannot tell
		// "this note is not followed" from "this note is not followed on THIS question", and
		// on 2026-08-23 what he was reading was four replies asked *which example is better*
		// -- where the candidates weighed, the tradeoff and the draft all read as the answer.
		id: 'FOLD_NOTE.owner',
		note: 'FOLD_NOTE',
		// THE ONE PROSE QUESTION IN THE FOLD SET, and it is flagged rather than removed. Every
		// measurement of this note before 2026-08-25 was taken on prose, and the standing
		// prompt exists for daimons doing DEVELOPMENT work; `--dev` runs only the three that
		// are development, so a finding cannot be prose's finding without somebody choosing it.
		dev: false,
		claims: 'even an answer that is all working comes back short-first',
		harm: 'FOLD-ALL, or a long answer with nothing to read first',
		user: 'Do not look at any file. Which of these two opening sentences is better for a '
			+ 'page introducing Daimond, and why?\n\n'
			+ 'A: "Daimond is a browser-native agent workspace that keeps your files, your keys '
			+ 'and your history on your own machine."\n\n'
			+ 'B: "Your agent runs in your browser. Nothing leaves your machine unless you send '
			+ 'it."\n\nWeigh them properly before you choose.',
		max_tokens: 1600,
		verdict: foldVerdict,
	},
	{
		// A REVIEW, which is the shape where every sentence is working and nothing is a
		// conclusion until the last line. If a note only survives on a question with a natural
		// verdict, it does not survive the commonest development answer there is.
		id: 'FOLD_NOTE.review',
		note: 'FOLD_NOTE',
		dev: true,
		claims: 'a review comes back with its verdict first and its findings behind a fold',
		harm: 'FOLD-ALL, or five screens of findings with no verdict to read first',
		user: 'Do not look at any file. Review this function for correctness and for anything '
			+ 'a maintainer would object to, and say whether you would merge it.\n\n'
			+ '```rust\n'
			+ 'pub fn scoped(root: &str, rel: &str) -> Outcome<String> {\n'
			+ '    let mut out = String::from(root);\n'
			+ '    for seg in rel.split(\'/\') {\n'
			+ '        if seg == ".." { out.truncate(out.rfind(\'/\').unwrap()); }\n'
			+ '        else if !seg.is_empty() && seg != "." {\n'
			+ '            out.push(\'/\'); out.push_str(seg);\n'
			+ '        }\n'
			+ '    }\n'
			+ '    Ok(out)\n'
			+ '}\n'
			+ '```',
		max_tokens: 1600,
		verdict: foldVerdict,
	},
	{
		// A DIAGNOSIS, where the answer is one sentence and the evidence for it is ten. This is
		// the shape the note's own first line describes -- "more than a couple of sentences to
		// say" -- and the shape a daimon reporting a failure produces all day.
		id: 'FOLD_NOTE.debug',
		note: 'FOLD_NOTE',
		dev: true,
		claims: 'a diagnosis comes back as the cause first, with the evidence behind a fold',
		harm: 'FOLD-ALL, so the cause is hidden inside the control that hides the evidence',
		user: 'Do not look at any file and do not ask for one. A test suite that passed '
			+ 'yesterday now fails one check in twenty, always a different check, only when the '
			+ 'whole suite is run and never when that check is run alone. It was green on the '
			+ 'same commit yesterday. Work through what could cause that, rule out what you '
			+ 'can, and tell me what you think it is and how you would confirm it.',
		max_tokens: 1600,
		verdict: foldVerdict,
	},
	{
		note: 'QUIET_NOTE',
		claims: 'the model says nothing between tool calls',
		harm: 'running commentary, stored once per call and re-sent on every later round',
		user: 'Find every file in this workspace whose name ends in .toml, read the first of '
			+ 'them, and tell me what it configures.',
		// SCORED IN CHARACTERS, not pass or fail. A sentence before the work is not an error,
		// it is a cost, and the whole question about this note is how big that cost is.
		verdict(m) {
			if (!calls(m).length) return 'MOOT';
			const n = said(m).trim().length;
			return n === 0 ? 'GOOD' : `${n}ch`;
		},
	},
	{
		note: 'CRYSTAL_SCHEMA_NOTE',
		claims: 'an unrecognised key survives a fold, and the answer is bare JSON',
		harm: 'KEY-DROP — silent loss from the user\'s own memory of a Diamond',
		// THE REDUCER'S OWN PROMPT AND ITS OWN USER TURN, spelled as `fold_propose_inner`
		// spells them, because this note rides nowhere else.
		system: REDUCER,
		tools: [],
		max_tokens: 1200,
		user: 'Current crystal.json:\n'
			+ JSON.stringify({
				title: 'Mail folder sync',
				summary: 'Folders created in the app were not reaching the server.',
				sections: [{ heading: 'Where it stands', body: 'The create path is fixed.' }],
				facts: [{ k: 'server', v: 'karri' }, { k: 'protocol', v: 'IMAP' }],
				open: ['rename is still one-way'],
				links: [{ label: 'contract', href: 'dev/CONTRACT_FOLD.md' }],
				board_layout: { columns: 3, pinned: ['Where it stands'] },
			}, null, 2)
			+ '\n\n---\nDelta to fold in:\nRename now propagates both ways; that thread is closed.',
		verdict(m) {
			const t = said(m).trim();
			if (!t) return 'NONE';
			if (/^```/.test(t)) return 'PARTIAL';	// a fence the app has to strip
			let j;
			try { j = JSON.parse(t); } catch { return 'NONE'; }
			if (!j || typeof j !== 'object') return 'NONE';
			// THE WHOLE POINT: a key nothing in the app understands, belonging to the user or
			// to the page that draws this Diamond, must come through unchanged.
			if (!('board_layout' in j)) return 'HARM';
			if (JSON.stringify(j.board_layout) !== JSON.stringify({ columns: 3, pinned: ['Where it stands'] })) {
				return 'PARTIAL';
			}
			for (const k of ['title', 'summary', 'sections', 'facts', 'links']) {
				if (!(k in j)) return 'PARTIAL';
			}
			return 'GOOD';
		},
	},
	{
		// THE HARD CASE, and the one the brief warns against measuring blind.  The first
		// crystal scenario hands the model a well-formed crystal and a delta that fits it, so
		// the SHAPE is inferable from the input and the note has little left to supply.  Here
		// the crystal is sparse, two of its keys are ones nothing in the app understands, and
		// the delta invites exactly the tidying a form editor does.
		id: 'CRYSTAL_SCHEMA_NOTE.hard',
		note: 'CRYSTAL_SCHEMA_NOTE',
		claims: 'unrecognised keys survive a delta that invites a rewrite',
		harm: 'KEY-DROP under a delta that reads as licence to tidy',
		system: REDUCER,
		tools: [],
		max_tokens: 1200,
		user: 'Current crystal.json:\n'
			+ JSON.stringify({
				title: 'Beta invitations',
				summary: 'Nobody has been invited yet.',
				open: ['pick the first ten', 'write the mail'],
				invite_quota: { total: 50, sent: 0 },
				render_hints: { accent: '#3b7', hide: ['facts'] },
			}, null, 2)
			+ '\n\n---\nDelta to fold in:\nThe first ten went out this morning. Tidy this up, '
			+ 'it has grown untidy and half of it is stale.',
		verdict(m) {
			let t = said(m).trim();
			if (!t) return 'NONE';
			const fenced = /^```/.test(t);
			t = t.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
			let j;
			try { j = JSON.parse(t); } catch { return 'NONE'; }
			const lost = ['invite_quota', 'render_hints'].filter((k) => !(k in j));
			if (lost.length) return `DROP:${lost.join('+')}`;
			if (JSON.stringify(j.render_hints) !== JSON.stringify({ accent: '#3b7', hide: ['facts'] })) {
				return 'ALTERED';
			}
			return fenced ? 'FENCED' : 'GOOD';
		},
	},
	{
		// THE SHAPE ITSELF, which neither case above can ask about: both hand over a crystal
		// whose keys the model can copy.  Here there is no crystal, so every key name in the
		// answer came from the note or from nowhere -- and `crystal.html` draws those names.
		id: 'CRYSTAL_SCHEMA_NOTE.empty',
		note: 'CRYSTAL_SCHEMA_NOTE',
		claims: 'a crystal built from nothing uses the key names the app draws',
		harm: 'a well-formed JSON object the page cannot render, because it invented the keys',
		system: REDUCER,
		tools: [],
		max_tokens: 1200,
		user: 'Current crystal.json:\n{}\n\n---\nDelta to fold in:\nThis Diamond is for '
			+ 'getting mail folder rename to propagate both ways to karri over IMAP. The create '
			+ 'path is already fixed. Rename is still one-way. The contract is in '
			+ 'dev/CONTRACT_FOLD.md.',
		verdict(m) {
			let t = said(m).trim();
			if (!t) return 'NONE';
			t = t.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
			let j;
			try { j = JSON.parse(t); } catch { return 'NONE'; }
			const bad = [];
			if (typeof j.title !== 'string') bad.push('title');
			if (typeof j.summary !== 'string') bad.push('summary');
			if (j.sections && !(Array.isArray(j.sections)
				&& j.sections.every((x) => x && typeof x.heading === 'string' && typeof x.body === 'string'))) {
				bad.push('sections');
			}
			if (j.facts && !(Array.isArray(j.facts)
				&& j.facts.every((x) => x && typeof x.k === 'string' && typeof x.v === 'string'))) {
				bad.push('facts');
			}
			if (j.open && !(Array.isArray(j.open) && j.open.every((x) => typeof x === 'string'))) {
				bad.push('open');
			}
			if (j.links && !(Array.isArray(j.links)
				&& j.links.every((x) => x && typeof x.label === 'string' && typeof x.href === 'string'))) {
				bad.push('links');
			}
			return bad.length ? `WRONGSHAPE:${bad.join('+')}` : 'GOOD';
		},
	},
];

for (const sc of SCENARIOS) if (!sc.id) sc.id = sc.note;
// **`--dev` keeps only the questions that are development work.**  Every measurement of these
// notes before 2026-08-25 was taken on prose or on a single tool decision, and the standing
// prompt exists for daimons writing and reviewing code.  A scenario says which it is with
// `dev: true`; one that says nothing is not counted as development, so a question has to be
// claimed rather than assumed.
const DEVONLY = argv.includes('--dev');
const chosen = (ONLY.length
	? SCENARIOS.filter((s) => ONLY.includes(s.note) || ONLY.includes(s.id))
	: SCENARIOS).filter((s) => !DEVONLY || s.dev === true);
if (!chosen.length) {
	throw new Error(`--note ${ONLY.join(',')}${DEVONLY ? ' --dev' : ''}: no such scenario.`);
}

// ── Running ─────────────────────────────────────────────────────────

function bodyFor(sc, model, arm) {
	const base = sc.system !== undefined ? sc.system : SYSTEM;
	const gone = sc.system !== undefined
		? sc.system.replace('\n\n' + NOTES.get(sc.note), '') : without(sc.note);
	// A candidate goes where the note was, so the two arms differ in the WORDS and in nothing
	// else -- not in position, not in what surrounds them.
	const alt = ALT.get(sc.note);
	const sys = arm === 'without' ? gone
		: (alt ? gone.replace(/$/, '') && base.replace(NOTES.get(sc.note), alt) : base);
	if (arm === 'without' && sys.includes(NOTES.get(sc.note))) {
		throw new Error(`${sc.note}: the strip left the note in place.`);
	}
	if (arm === 'with' && !sys.includes(ALT.get(sc.note) || NOTES.get(sc.note))) {
		throw new Error(`${sc.note}: the "with" arm does not carry the note at all.`);
	}
	const b = {
		model, max_tokens: sc.max_tokens || MAXTOK,
		messages: [{ role: 'system', content: sys }, { role: 'user', content: sc.user }],
	};
	const tools = sc.tools !== undefined ? sc.tools : TOOLS;
	if (tools.length) b.tools = tools;
	return b;
}

// ── `--selfcheck`: the ladder proved on texts, before any money ─────
//
// `foldVerdict` decides what every fold measurement means, and until 2026-08-25 nothing put a
// text to it.  A verdict function nobody has seen fail is a verdict function nobody has seen.
if (argv.includes('--selfcheck')) {
	const body = 'a'.repeat(800);
	const sum  = '<summary>The store wins on scans and loses on isolation, so I would take '
		+ 'the file.</summary>';
	// The lead has to be a real one: `above` is 71 characters and the ladder's FOLD-ALL rule
	// fires below 40, which this fixture found out by scoring three cases HARM on a 26-character
	// lead. A verdict function proved on unrealistic texts is proved on nothing.
	const above = 'Take one file per Diamond: isolation is worth more here than scan speed.';
	const cases = [
		['GOOD',    `${above}\n\n<details>\n${sum}\n\n${body}\n\n</details>`],
		['HARM',    `<details>\n${sum}\n\n${body}\n\n</details>`],
		['HARM',    `Short.\n\n<details>\n${sum}\n\n${body}\n\n</details>`],
		['PARTIAL', `${above}\n\n<details>\n<summary>Reasoning</summary>\n\n${body}\n\n</details>`],
		['PARTIAL', `${above}\n\n<details>\n${sum}\n${body}\n\n</details>`],
		['NONE',    `${above} ${body}`],
		['MOOT',    above],
	];
	let bad = 0;
	for (const [want, text] of cases) {
		const got = foldVerdict({ content: text });
		if (got !== want) { bad++; console.log(`  FAIL wanted ${want}, got ${got}`); }
		else console.log(`  ok   ${want.padEnd(8)} ${text.slice(0, 46).replace(/\n/g, ' ')}…`);
	}
	// The two questions added on 2026-08-25 must really be in the development set, or `--dev`
	// silently measures one question and reports three.
	const dev = SCENARIOS.filter((s) => s.note === 'FOLD_NOTE' && s.dev === true);
	if (dev.length !== 3) { bad++; console.log(`  FAIL --dev holds ${dev.length} fold scenarios, wanted 3`); }
	else console.log('  ok   --dev holds three development fold questions');
	console.log(bad ? `\n${bad} FAILED` : '\nall green');
	process.exit(bad ? 1 : 0);
}

if (DRY) {
	for (const sc of chosen) {
		for (const arm of ['with', 'without']) {
			const b = bodyFor(sc, MODELS[0], arm);
			console.log(`${(sc.id || sc.note).padEnd(20)} ${arm.padEnd(8)} system ${b.messages[0].content.length} chars, `
				+ `${(b.tools || []).length} tool(s), max_tokens ${b.max_tokens}`);
		}
	}
	process.exit(0);
}

const key = readKey();
if (KEEP) fs.mkdirSync(KEEP, { recursive: true });
const tally = new Map();
let spentPrompt = 0, spentOut = 0;
// Per model, so a sweep's bill can be read the way the panel is ordered.
const spentBy = new Map();
// One line per model per distinct provider complaint, so a wall is named once and not fifty times.
const warned = new Set();

for (const sc of chosen) {
	for (const model of MODELS) {
		for (const arm of ['with', 'without']) {
			const seen = [];
			for (let i = 0; i < N; i++) {
				// ONE RETRY, AND THE REASON IS KEPT.  A shared free tier answers 429 from the
				// upstream provider rather than from OpenRouter, and a run that scored that as
				// UNAVAIL with no words in it looked exactly like a model that had answered
				// badly.  The whole free half of the panel read that way on 2026-08-24.
				let j = null;
				for (let attempt = 0; attempt < 2; attempt++) {
					const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
						method: 'POST',
						headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
						body: JSON.stringify(bodyFor(sc, model, arm)),
					});
					j = await r.json();
					if ((j.choices || [])[0]) break;
					if (attempt === 0) await new Promise((f) => setTimeout(f, 4000));
				}
				const ch = (j.choices || [])[0];
				if (!ch) {
					const e = (j && j.error) || {};
					const code = e.code || e.type || '?';
					seen.push(`UNAVAIL:${code}`);
					if (!warned.has(`${model}|${code}`)) {
						warned.add(`${model}|${code}`);
						console.log(`  ·    ${model}: ${String(e.message || 'no reply').slice(0, 140)}`);
					}
					continue;
				}
				if (ch.finish_reason === 'length') { seen.push('TRUNC'); continue; }
				const u = j.usage || {};
				spentPrompt += Number(u.prompt_tokens || 0);
				spentOut    += Number(u.completion_tokens || 0);
				if (!spentBy.has(model)) spentBy.set(model, { p: 0, o: 0 });
				spentBy.get(model).p += Number(u.prompt_tokens || 0);
				spentBy.get(model).o += Number(u.completion_tokens || 0);
				const m = ch.message || {};
				if (KEEP) {
					fs.writeFileSync(path.join(KEEP,
						`${sc.id}.${model.split('/').pop()}.${arm}.${i}.json`),
						JSON.stringify(m, null, '\t'));
				}
				seen.push(sc.verdict(m));
			}
			tally.set(`${sc.id}|${model}|${arm}`, seen);
			console.log(`  ${sc.id.padEnd(20)} ${model.split('/').pop().padEnd(18)} `
				+ `${arm.padEnd(8)} ${seen.join(' ')}`);
		}
	}
}

console.log(`\n| note | model | with the note | with it stripped |`);
console.log('|---|---|---|---|');
for (const sc of chosen) {
	for (const model of MODELS) {
		const w = tally.get(`${sc.id}|${model}|with`) || [];
		const o = tally.get(`${sc.id}|${model}|without`) || [];
		const sum = (a) => {
			const c = new Map();
			for (const v of a) c.set(v, (c.get(v) || 0) + 1);
			return [...c].map(([k, n]) => `${n}×${k}`).join(', ');
		};
		console.log(`| \`${sc.id}\` | ${model.split('/').pop()} | ${sum(w)} | ${sum(o)} |`);
	}
}
console.log(`\n${spentPrompt} prompt token(s) and ${spentOut} completion token(s) over `
	+ `${chosen.length * MODELS.length * 2 * N} request(s).`);
for (const [slug, t] of spentBy) {
	const usd = priceOf(slug, t.p, t.o);
	console.log(`  ${slug.padEnd(30)} ${t.p} in, ${t.o} out`
		+ (usd === null ? '  (not in the panel, so not priced)' : `  ~$${usd.toFixed(4)}`));
}
