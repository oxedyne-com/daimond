// probe_register.mjs — is a standing prompt's REGISTER worth anything, once its length is held?
//
// The owner's hypothesis of 2026-08-25 is that the system prompting is not calibrated for
// the more powerful models.  `dev/PROMPT_NOTES.md` §6 already showed one half of that: two
// notes turned out to bite on the weaker half of the panel and on nothing else.  The sharper
// form, which is what this file measures, is that the split runs along KIND rather than
// along the note list -- tell a strong model what must be true and what would surprise it,
// tell a weak model how to proceed.
//
// ── The confound this exists to control ─────────────────────────────
//
// A constraints register is naturally shorter than the procedure that implements it, so the
// pair already on the shelf -- `dev/house/prose.md` at 884 tokens against
// `dev/house/prose_short.md` at 511 -- varies KIND and LENGTH at once, and the flip measured
// on it (sonnet-4.5 better on the short one, haiku-4.5 better on the long one) is explained
// equally well by either.  `dev/house/reg/` holds a 2x2 instead: constraints and procedure,
// long and short, each pair matched to within 2% of the other's measured tokens and each
// carrying the same fifteen pieces of information.  **A run that cannot separate kind from
// length has not tested the hypothesis, whichever way its numbers fall.**
//
// ── Why this is not `dev/reflux.mjs` ────────────────────────────────
//
// Reflux runs the same task through the real browser, the real extension and the real fence,
// and `--house` was added to it for exactly this.  It costs a browser and up to ten minutes a
// turn, so a 2x2 across five models at n=3 is a day of wall clock and cannot be read as a
// rate.  This runs the same fixture, the same brief and the same check against the provider
// directly, so an arm is a rate rather than an anecdote.
//
// **What it therefore cannot see**, and reflux is the instrument for each: the extension's
// own refusals, the fence, the panel, and anything that depends on the app's streaming.  The
// seven tools implemented here are the seven the prose task can reach; the other twenty-two
// schemas of the real request are not offered, so a model cannot spend a round on `web_search`
// the way it could in the product.
//
// ── What makes it real ──────────────────────────────────────────────
//
// **Nothing here is transcribed.**  The system prompt and every tool schema come out of
// `<log>.request.json`, which reflux's relay writes from the body it is about to forward.
// The fixture, the brief, the owner's draft and the rewrite it is scored against come out of
// `dev/reflux.mjs` by name, so a reworded task is a hard stop rather than a silent drift, and
// the three checkers are his own files copied read-only into the scratch tree.
//
// **The register is counted into the request.**  It goes where `Instructions::compose` puts
// `DAIMOND.md`, under the same heading `dev/reflux.mjs` uses, and a run whose register never
// reached a request aborts rather than reporting a baseline as an arm.
//
//	node dev/probe_register.mjs --selftest                      free; proves every check
//	node dev/probe_register.mjs --model panel --n 3
//	  --reg none,c_short,c_long,p_short,p_long   which registers (default: all five)
//	  --task prose                               default and, today, the only one
//	  --n 3                                      runs per cell
//	  --model a/b,c/d | panel | baseline
//	  --max-rounds 20 --max-secs 900 --max-bytes 70000
//	  --keep <dir>                               every transcript written there
//	  --dry                                      build every request, send none
//
// The key is read as `dev/probe_notes.mjs` reads it and there is no default:
//   ~/.config/oxedyne/daimond/openrouter.key (0600), or DAIMOND_PROBE_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PANEL, BASELINE, OPEN, priceOf } from './models.mjs';

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const REFLUX = path.join(HERE, 'reflux.mjs');
const argv   = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

const SELFTEST = has('selftest');
const DRY      = has('dry');
const REQUEST  = flag('request', path.join(os.homedir(), '.cache/daimond/lane-n/reflux/reflux.request.json'));
const N        = Number(flag('n', '3'));
const MAXROUND = Number(flag('max-rounds', '12'));
const MAXSECS  = Number(flag('max-secs', '900'));
const MAXBYTES = Number(flag('max-bytes', '70000'));
const MAXTOK   = Number(flag('max-tokens', '4000'));
const KEEP     = flag('keep', '');
const SCRATCH  = flag('scratch', path.join(os.homedir(), '.cache/daimond/lane-ab'));
// ── The baseline gate ───────────────────────────────────────────────
//
// **A model that cannot do the task with NO standing prompt at all is unmeasurable here, and
// its register arms are not evidence about a register.**  Nothing separates "this prompt hurt
// the model" from "this model cannot drive these tools" once both arms are floored, and the
// difference is the whole finding.  So `--gate` runs the bare arm first, and where the model
// never writes the file in any baseline sample it is recorded UNMEASURABLE and the register
// arms are not run -- which also stops the money going to a column nobody could read.
//
// It is not on by default, because a run that already holds its model's baseline should not
// pay for another.  Measured 2026-08-25, it would have caught two of the five models then on
// the panel: qwen3.8-max never wrote the paragraph in three bare samples out of three, and
// glm-5.2 wrote it in two of three and then in none of twelve with any register at all.
const GATE = has('gate');
const MODELS   = (() => {
	const raw = String(flag('model', 'baseline'));
	if (raw === 'panel')    return PANEL.filter((s) => !s.endsWith(':free'));
	if (raw === 'baseline') return BASELINE;
	if (raw === 'open')     return OPEN;
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
})();

// ── The registers under test ────────────────────────────────────────
//
// `none` is the control that says how much of any arm's score is the register at all.  The two
// shipped files are carried as well, unmeasured by the 2x2, because the flip that started this
// was measured on them and a run that cannot be compared with it has lost the thread.
const REGISTERS = {
	none:    null,
	c_short: 'reg/prose_constraints_short.md',
	c_long:  'reg/prose_constraints_long.md',
	p_short: 'reg/prose_procedure_short.md',
	p_long:  'reg/prose_procedure_long.md',
	shipped_short: 'prose_short.md',
	shipped_long:  'prose.md',
};
const REGS = String(flag('reg', 'none,c_short,c_long,p_short,p_long'))
	.split(',').map((s) => s.trim()).filter(Boolean);
for (const r of REGS) {
	if (!(r in REGISTERS)) {
		throw new Error(`--reg ${r}: no such register. One of ${Object.keys(REGISTERS).join(', ')}.`);
	}
}
const HOUSE_HEAD = '## Standing instructions from the user';
const registerText = (name) => (REGISTERS[name]
	? fs.readFileSync(path.join(HERE, 'house', REGISTERS[name]), 'utf8').trim() : '');

// ── The task, read out of `dev/reflux.mjs` rather than copied ───────
//
// A JS template literal, by name.  The parser understands the one shape these four constants
// use and refuses anything else by name, for `dev/promptparts.mjs`'s reason: an instrument
// holding its own copy of a fixture reports on a task nothing runs.
function templateConst(src, name) {
	const decl = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\``);
	const m = decl.exec(src);
	if (!m) throw new Error(`probe_register: no const ${name} = \`…\` in dev/reflux.mjs`);
	let out = '';
	for (let i = m.index + m[0].length; i < src.length; i++) {
		const ch = src[i];
		if (ch === '`') return out;
		if (ch === '$' && src[i + 1] === '{') {
			throw new Error(`probe_register: ${name} interpolates, which this parser will not `
				+ 'guess at. Teach it that shape rather than letting it drift.');
		}
		if (ch === '\\') { out += { n: '\n', t: '\t', '\\': '\\', '`': '`', '$': '$' }[src[i + 1]] ?? src[i + 1]; i++; continue; }
		out += ch;
	}
	throw new Error(`probe_register: ${name} is unterminated`);
}
const RSRC        = fs.readFileSync(REFLUX, 'utf8');
const PROSE_DRAFT = templateConst(RSRC, 'PROSE_DRAFT');
const PROSE_KEPT  = templateConst(RSRC, 'PROSE_KEPT');

// The brief, held here because reflux's is a function of its own context object.  It is the
// same sentence, and `--selftest` asserts that every clause of it is still in reflux's source:
// a brief that has drifted from the one the browser harness sends is two experiments.
const BRIEF = (mark) => `The "${mark}" folder of this workspace is on this computer, and `
	+ 'draft.typ in it holds one paragraph of a book the user is writing. It reads as an '
	+ 'AI draft rather than as his own prose. Rewrite it so that it reads as his, and '
	+ `write the result back to draft.typ. Use commands with the working directory set to "${mark}". `
	+ 'Keep every claim, every name and every date. Change no other file.';

// ── The request the app really sends ────────────────────────────────

const req = JSON.parse(fs.readFileSync(REQUEST, 'utf8'));
const sysMsg = (req.messages || []).find((m) => m.role === 'system');
if (!sysMsg) throw new Error(`${REQUEST} carries no system message.`);
const SYSTEM = typeof sysMsg.content === 'string' ? sysMsg.content
	: (sysMsg.content || []).map((p) => (p && p.text) || '').join('');
// The seven the prose task can reach, and no others: a schema offered but not implemented is
// a round the model spends on a tool that answers nothing.
const OFFERED = ['file_read', 'file_write', 'file_edit', 'file_list', 'file_search', 'file_glob', 'run'];
const TOOLS = (req.tools || []).filter((t) => OFFERED.includes(t.function && t.function.name));
if (TOOLS.length !== OFFERED.length) {
	throw new Error(`${REQUEST} carries ${TOOLS.length} of the ${OFFERED.length} tool schemas `
		+ 'this probe implements. Capture a request from a role that holds the file tools.');
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

// ── The fixture ─────────────────────────────────────────────────────
//
// Built exactly as `dev/reflux.mjs`'s prose task builds it, and for the same reason: `~/usr` is
// a Syncthing folder and a command could write in it, so the run is handed READ-ONLY COPIES and
// the worst it can do is spoil its own scratch tree.
const BOOKS = path.join(os.homedir(), 'usr/books');
function buildFixture(dir) {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'style'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'elearnity'), { recursive: true });
	// AT THE PATH EVERY REGISTER NAMES, which is where reflux's own fixture differs: it puts the
	// spec at the root, so every register arm pays a wasted round on ENOENT that the `none`
	// control does not.  Measured on haiku-4.5, 2026-08-25, and it was the second call of the run.
	fs.copyFileSync(path.join(BOOKS, 'elearnity/writing_spec.md'),
		path.join(dir, 'elearnity/writing_spec.md'));
	fs.copyFileSync(path.join(BOOKS, 'style/exemplars.md'), path.join(dir, 'style/exemplars.md'));
	for (const t of ['cadence', 'spec_check', 'decode_load']) {
		fs.copyFileSync(path.join(BOOKS, 'tools', t), path.join(dir, 'tools', t));
	}
	fs.writeFileSync(path.join(dir, 'draft.typ'), PROSE_DRAFT);
	return path.join(dir, 'draft.typ');
}

/// The draft's own band distance, which is the bar the gate holds a bare arm to.
///
/// Floored the way every other distance is, so a model that hands the paragraph back scores
/// exactly this and a model that moved it at all scores less.
const DRAFT_DIST = 6;

/// How far outside his band a scored run landed, in half-widths of the band itself.
///
/// The same arithmetic `dev/register_verdict.mjs` reports with, kept here because the gate has
/// to make the same judgement before it will spend anything on a register.
function bandDistance(r) {
	if (typeof r.dl !== 'number' || typeof r.mean !== 'number') return DRAFT_DIST;
	let d = r.dl;
	if (r.mean < 19.5) d += (19.5 - r.mean) / 2.5;
	if (r.mean > 24.5) d += (r.mean - 24.5) / 2.5;
	if (typeof r.long === 'number' && r.long > 20) d += (r.long - 20) / 20;
	if (r.spec === false) d += 1;
	return Math.min(d, DRAFT_DIST);
}

// ── The check, which is reflux's, number for number ─────────────────
//
// It returns the SCORE as well as the verdict, so a failing arm still says how far out of his
// band it landed.  An arm scored only pass/fail prices nothing.
function scoreProse(dir, file) {
	const s = { ok: null, dl: null, mean: null, long: null, spec: null, changed: false };
	let now;
	try { now = fs.readFileSync(file, 'utf8'); }
	catch (e) { s.ok = 'draft.typ is gone'; return s; }
	s.changed = now.trim() !== PROSE_DRAFT.trim();
	if (!s.changed) { s.ok = 'draft.typ is unchanged'; return s; }
	for (const who of ['Clark', 'George', 'Cobb', 'Douglas', 'Solow', '1899', '1928', '1956']) {
		if (!now.includes(who)) { s.ok = `the rewrite has lost ${who}`; return s; }
	}
	const tool = (name) => spawnSync('python3', [path.join(dir, 'tools', name), file],
		{ encoding: 'utf8', timeout: 60_000 });
	const dl = tool('decode_load').stdout || '';
	const m = dl.match(/(\d+) sentences? at or above decode-load 4/);
	if (!m) { s.ok = 'decode_load said nothing this check can read: ' + dl.slice(0, 120); return s; }
	s.dl = Number(m[1]);
	const cad = tool('cadence').stdout || '';
	const num = (k) => {
		const g = cad.match(new RegExp(`${k}\\s+([0-9.]+)`));
		return g ? Number(g[1]) : null;
	};
	s.mean = num('mean_sentence_words');
	s.long = num('pct_long_gt35');
	s.spec = /Clean|All clean/.test(tool('spec_check').stdout || '');
	if (s.dl > 0) {
		s.ok = `decode_load still ranks ${s.dl} sentence(s) at or above 4`;
		return s;
	}
	if (s.mean === null || s.long === null) { s.ok = 'cadence said nothing this check can read'; return s; }
	if (s.mean < 19.5 || s.mean > 24.5) {
		s.ok = `cadence puts the mean sentence at ${s.mean} words, outside his band of 19.5-24.5`;
		return s;
	}
	if (s.long > 20) {
		s.ok = `cadence puts ${s.long}% of sentences over 35 words, above his band of 10-20`;
		return s;
	}
	if (!s.spec) { s.ok = 'spec_check is not clean'; return s; }
	return s;
}

// ── The seven tools, executed for real inside the scratch tree ──────
//
// `run` takes a WHITELIST and refuses anything else in words.  A refusal is a measurement here
// and not an accident: half of what a register is being asked to buy is a turn that meets a
// refusal and gets past it, so the count of refusals and the count of rounds after the first
// one are both reported.
const ALLOWED = new Set(['python3', 'cat', 'ls', 'head', 'tail', 'wc', 'grep', 'sed', 'sort', 'uniq', 'diff']);
const LINE = (t) => t.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');

function inside(root, rel) {
	const p = path.resolve(root, rel || '.');
	if (p !== root && !p.startsWith(root + path.sep)) return null;
	return p;
}

function runTool(state, name, args) {
	const root = state.root;
	const a = (() => { try { return JSON.parse(args || '{}'); } catch (e) { return null; } })();
	if (!a) return { text: `Error: ${name}: the arguments were not valid JSON.`, bad: true };
	const rel = (v) => {
		if (typeof v !== 'string' || !v) return null;
		if (path.isAbsolute(v)) return null;
		return inside(root, v);
	};
	switch (name) {
	case 'file_read': {
		const p = rel(a.path);
		if (!p) return { text: `Error: file_read: '${a.path}' is not a workspace-relative path.`, bad: true };
		let text;
		try { text = fs.readFileSync(p, 'utf8'); }
		catch (e) { return { text: `Error: file_read: ${a.path}: ${e.code || e.message}`, bad: true }; }
		const lines = text.split('\n');
		const off = Math.max(1, Number(a.offset || 1));
		const lim = Math.min(Number(a.limit || 2000), 10000);
		let out = lines.slice(off - 1, off - 1 + lim);
		let note = '';
		// The output budget the real tool has, so a model that asks for a 120 KB spec is told
		// what it is told in the product rather than being handed the file.
		let joined = out.map((l, i) => `${off + i}\t${l}`).join('\n');
		if (joined.length > 16_000) {
			let keep = 0, n = 0;
			for (const l of out) { if (n + l.length > 16_000) break; n += l.length + 1; keep++; }
			out = out.slice(0, keep);
			joined = out.map((l, i) => `${off + i}\t${l}`).join('\n');
			note = `\n\n[the output budget ran out after line ${off + keep - 1} of ${lines.length}; `
				+ `read on with offset ${off + keep}]`;
		}
		return { text: joined + note };
	}
	case 'file_write': {
		const p = rel(a.path);
		if (!p) return { text: `Error: file_write: '${a.path}' is not a workspace-relative path.`, bad: true };
		if (typeof a.content !== 'string') return { text: 'Error: file_write: no content.', bad: true };
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, a.content);
		return { text: `Wrote ${a.content.length} bytes to ${a.path}.` };
	}
	case 'file_edit': {
		const p = rel(a.path);
		if (!p) return { text: `Error: file_edit: '${a.path}' is not a workspace-relative path.`, bad: true };
		let text;
		try { text = fs.readFileSync(p, 'utf8'); }
		catch (e) { return { text: `Error: file_edit: ${a.path}: ${e.code || e.message}`, bad: true }; }
		const parts = text.split(a.old_string || '\u0000');
		if (parts.length !== 2) {
			return { text: `Error: file_edit: 'old_string' appears ${parts.length - 1} times in `
				+ `${a.path}; it must appear exactly once.`, bad: true };
		}
		fs.writeFileSync(p, parts.join(a.new_string || ''));
		return { text: `Edited ${a.path}.` };
	}
	case 'file_list': {
		const p = rel(a.path || '.');
		if (!p) return { text: `Error: file_list: '${a.path}' is not a workspace-relative path.`, bad: true };
		let ent;
		try { ent = fs.readdirSync(p, { withFileTypes: true }); }
		catch (e) { return { text: `Error: file_list: ${a.path}: ${e.code || e.message}`, bad: true }; }
		return { text: ent.map((d) => (d.isDirectory() ? d.name + '/' : d.name)).join('\n') || '(empty)' };
	}
	case 'file_glob': {
		const walk = (d, acc) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const q = path.join(d, e.name);
				if (e.isDirectory()) walk(q, acc); else acc.push(path.relative(root, q));
			}
			return acc;
		};
		const pat = String(a.pattern || '*');
		const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*\//g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?')
			.replace(/\?/g, '.') + '$');
		return { text: walk(root, []).filter((f) => rx.test(f)).slice(0, 500).join('\n') || '(no match)' };
	}
	case 'file_search': {
		const flags = ['-rn'];
		if (a.fixed) flags.push('-F');
		else flags.push('-E');
		if (a.ignore_case) flags.push('-i');
		const where = rel(a.path || '.') || root;
		const r = spawnSync('grep', [...flags, '-a', String(a.query || ''), '-r', where],
			{ encoding: 'utf8', timeout: 30_000, maxBuffer: 4 << 20 });
		const out = (r.stdout || '').split('\n').slice(0, Number(a.limit || 200))
			.map((l) => l.replace(root + '/', '')).join('\n');
		return { text: out || '(no match)' };
	}
	case 'run': {
		if (!Array.isArray(a.argv) || !a.argv.length) {
			return { text: "Error: run: 'argv' must be an array, the program then each argument.", bad: true };
		}
		const prog = path.basename(String(a.argv[0]));
		if (!ALLOWED.has(prog)) {
			return { text: `Refused: this probe's fence runs only ${[...ALLOWED].join(', ')}, and `
				+ `'${prog}' is not among them. Nothing was run.`, refused: true };
		}
		const cwd = a.cwd ? rel(a.cwd) : root;
		if (!cwd) return { text: `Error: run: cwd '${a.cwd}' is outside the workspace.`, bad: true };
		const r = spawnSync(String(a.argv[0]), a.argv.slice(1).map(String),
			{ cwd, encoding: 'utf8', timeout: Math.min(Number(a.timeout_ms || 120_000), 300_000),
				maxBuffer: 8 << 20, input: a.stdin ? String(a.stdin) : undefined });
		const body = ((r.stdout || '') + (r.stderr || '')).slice(0, 24_000);
		const code = r.status === null ? 'killed' : r.status;
		return { text: `exit ${code}\n${body}`, bad: r.status !== 0 };
	}
	default:
		return { text: `Error: ${name} is not a tool this probe implements.`, bad: true };
	}
}

// ── One run ─────────────────────────────────────────────────────────

async function post(key, body, secs) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), secs * 1000);
	try {
		const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST', signal: ctl.signal,
			headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const text = await r.text();
		let json;
		try { json = JSON.parse(text); } catch (e) { return { err: `unparseable: ${text.slice(0, 200)}` }; }
		if (json.error) return { err: `${json.error.code || ''} ${json.error.message || ''}`.trim() };
		return { json };
	} catch (e) {
		return { err: e.name === 'AbortError' ? `no reply in ${secs}s` : String(e.message || e) };
	} finally { clearTimeout(t); }
}

async function oneRun(key, model, reg, tag) {
	const root = path.join(SCRATCH, 'reg', tag);
	const file = buildFixture(root);
	const house = registerText(reg);
	let system = SYSTEM;
	let placed = 0;
	if (house) { system = `${SYSTEM}\n\n${HOUSE_HEAD}\n\n${house}`; placed = 1; }
	if (house && !system.includes(house)) throw new Error(`${reg} never reached the request.`);
	const state = { root };
	const messages = [{ role: 'system', content: system },
		{ role: 'user', content: BRIEF('.') }];
	const rec = { model, reg, rounds: 0, calls: 0, bytes: 0, bad: 0, refused: 0,
		in_tok: 0, out_tok: 0, secs: 0, err: null, placed };
	const t0 = Date.now();
	for (rec.rounds = 1; rec.rounds <= MAXROUND; rec.rounds++) {
		if ((Date.now() - t0) / 1000 > MAXSECS) { rec.err = 'wall clock'; break; }
		const body = { model, messages, tools: TOOLS, max_tokens: MAXTOK, usage: { include: true } };
		if (DRY) { rec.err = 'dry'; break; }
		const left = Math.max(30, MAXSECS - (Date.now() - t0) / 1000);
		const { json, err } = await post(key, body, Math.min(600, left));
		if (err) { rec.err = err; break; }
		const ch = ((json.choices || [])[0] || {}).message || {};
		const u = json.usage || {};
		rec.in_tok += Number(u.prompt_tokens || 0);
		rec.out_tok += Number(u.completion_tokens || 0);
		messages.push({ role: 'assistant', content: ch.content || '', tool_calls: ch.tool_calls || undefined });
		const tc = ch.tool_calls || [];
		if (!tc.length) break;
		for (const c of tc) {
			rec.calls++;
			const name = (c.function || {}).name || '?';
			const r = runTool(state, name, (c.function || {}).arguments);
			rec.bytes += r.text.length;
			if (r.bad) rec.bad++;
			if (r.refused) rec.refused++;
			messages.push({ role: 'tool', tool_call_id: c.id, name, content: r.text });
		}
		if (rec.bytes > MAXBYTES) { rec.err = `read ${rec.bytes} bytes, past the ${MAXBYTES} budget`; break; }
		// A run that used every round is not the same outcome as one that stopped, and reading a
		// truncated arm as a verdict on the register is how a cap becomes a finding.
		if (rec.rounds === MAXROUND) rec.err = `used all ${MAXROUND} rounds`;
	}
	rec.secs = Math.round((Date.now() - t0) / 10) / 100;
	rec.usd = priceOf(model, rec.in_tok, rec.out_tok);
	Object.assign(rec, scoreProse(root, file));
	if (KEEP) {
		fs.mkdirSync(KEEP, { recursive: true });
		fs.writeFileSync(path.join(KEEP, `${tag}.json`),
			JSON.stringify({ rec, messages, system_chars: system.length }, null, '\t'));
	}
	fs.rmSync(root, { recursive: true, force: true });
	return rec;
}

// ── The self-test: every check proved red before it is trusted ──────

function selftest() {
	let bad = 0;
	const say = (ok, what) => { if (!ok) bad++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); };
	const dir = path.join(SCRATCH, 'reg', 'selftest');
	const file = buildFixture(dir);

	// RED: the owner's own draft, which is the text he threw away.
	const red = scoreProse(dir, file);
	say(red.ok === 'draft.typ is unchanged', `an untouched draft is red: ${red.ok}`);
	fs.writeFileSync(file, PROSE_DRAFT + '\n% a comment, so the file differs\n');
	const red2 = scoreProse(dir, file);
	say(red2.ok !== null, `his 2026-08-06 draft is red: ${red2.ok}`);
	say(red2.mean !== null && red2.mean > 24.5, `and red on cadence: mean ${red2.mean} words`);

	// RED: a rewrite that scores well and drops the argument.
	fs.writeFileSync(file, 'Land is not capital. The return on capital falls back when investors '
		+ 'build more of it, and the supply of land is fixed, so a high return to it persists in a '
		+ 'way that no amount of building can compete away from the owners who hold it.\n');
	const red3 = scoreProse(dir, file);
	say(/has lost Clark/.test(red3.ok || ''), `a rewrite that drops the names is red: ${red3.ok}`);

	// GREEN: the paragraph he kept.
	fs.writeFileSync(file, PROSE_KEPT);
	const green = scoreProse(dir, file);
	say(green.ok === null, `his own rewrite is green: ${green.ok || 'clean'}`);
	say(green.dl === 0, `decode_load 0 on the kept paragraph, got ${green.dl}`);

	// The fixture and the brief are reflux's, and a drift is a hard stop.
	say(RSRC.includes('reads as an '), 'the brief is still reflux\'s wording');
	for (const clause of ['It reads as an ', 'Keep every claim, every name and every date.',
		'write the result back to draft.typ']) {
		say(RSRC.includes(clause), `reflux still sends: ${JSON.stringify(clause.slice(0, 40))}`);
	}

	// Every register is matched to its opposite number within 2%, which is the whole control.
	const chars = {};
	for (const [k, v] of Object.entries(REGISTERS)) if (v) chars[k] = registerText(k).length;
	const near = (a, b) => Math.abs(chars[a] - chars[b]) / Math.max(chars[a], chars[b]) < 0.02;
	say(near('c_long', 'p_long'), `long pair matched: ${chars.c_long} vs ${chars.p_long} chars`);
	say(near('c_short', 'p_short'), `short pair matched: ${chars.c_short} vs ${chars.p_short} chars`);
	say(chars.c_long > chars.c_short * 1.4, 'long really is longer than short');

	// Every tool answers, and `run` refuses what it must.
	const st = { root: dir };
	say(!runTool(st, 'file_read', '{"path":"draft.typ"}').bad, 'file_read reads the draft');
	say(runTool(st, 'file_read', '{"path":"/etc/passwd"}').bad, 'file_read refuses an absolute path');
	say(runTool(st, 'file_read', '{"path":"../../../etc/passwd"}').bad, 'file_read refuses an escape');
	say(runTool(st, 'run', '{"argv":["curl","http://example.com"]}').refused, 'run refuses curl');
	say(runTool(st, 'run', '{"argv":["python3","tools/cadence","draft.typ"]}').text.startsWith('exit 0'),
		'run runs the owner\'s own cadence');
	const bigRead = runTool(st, 'file_read', '{"path":"elearnity/writing_spec.md"}');
	say(/output budget ran out/.test(bigRead.text), 'a 120 KB spec comes back paged, not whole');
	// THE GATE'S OWN BAR, put to the run that made it necessary: gpt-oss-120b's three bare
	// samples of 2026-08-25, which wrote a file and handed the draft back inside it.
	say(bandDistance({ dl: 2, mean: 35.2, long: 67 }) >= DRAFT_DIST,
		'a near-copy of the draft does not pass the gate');
	say(bandDistance({ dl: 2, mean: 20.3, long: 10 }) < DRAFT_DIST,
		'a paragraph that really moved does pass it');
	say(bandDistance({ dl: 0, mean: 22.3, long: 11 }) < 0.5, 'his own register scores near zero');
	say(TOOLS.length === OFFERED.length, `${TOOLS.length} schemas taken from the captured request`);
	say(PROSE_DRAFT.includes('John Bates Clark') && PROSE_KEPT.includes('Progress and Poverty'),
		'both paragraphs came out of dev/reflux.mjs by name');

	fs.rmSync(dir, { recursive: true, force: true });
	console.log(bad ? `\n${bad} FAILED` : '\nall green');
	return bad;
}

// ── Report ──────────────────────────────────────────────────────────

function report(rows) {
	const models = [...new Set(rows.map((r) => r.model))];
	console.log('\nEach cell: passes/n, mean calls, mean bytes read, mean cadence mean-sentence.\n');
	const w = 22;
	console.log('model'.padEnd(30) + REGS.map((r) => r.padEnd(w)).join(''));
	for (const m of models) {
		let line = m.padEnd(30);
		for (const g of REGS) {
			const cell = rows.filter((r) => r.model === m && r.reg === g);
			if (!cell.length) { line += '-'.padEnd(w); continue; }
			const pass = cell.filter((r) => r.ok === null).length;
			const mean = (f) => {
				const v = cell.map(f).filter((x) => typeof x === 'number' && isFinite(x));
				return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null;
			};
			line += `${pass}/${cell.length} ${mean((r) => r.calls)}c ${Math.round((mean((r) => r.bytes) || 0) / 1000)}k ${mean((r) => r.mean) ?? '-'}`.padEnd(w);
		}
		console.log(line);
	}
	const usd = rows.reduce((a, r) => a + (r.usd || 0), 0);
	console.log(`\n${rows.length} runs, $${usd.toFixed(4)} by the table in dev/models.mjs.`);
	for (const r of rows.filter((x) => x.err)) {
		console.log(`  ${r.model} ${r.reg}: ${r.err}`);
	}
}

// ── Main ────────────────────────────────────────────────────────────

if (SELFTEST) {
	process.exit(selftest() ? 1 : 0);
}
const key = DRY ? 'dry' : readKey();
const rows = [];
const out = KEEP ? path.join(KEEP, 'rows.json') : '';
const say = (rec, i) => console.log(`${rec.model.padEnd(28)} ${rec.reg.padEnd(14)} #${i} `
	+ `${rec.ok === null ? 'PASS' : 'fail'} ${String(rec.calls).padStart(2)}c `
	+ `${String(Math.round((rec.bytes || 0) / 1000)).padStart(3)}k `
	+ `dl=${rec.dl ?? '-'} mean=${rec.mean ?? '-'} long=${rec.long ?? '-'} `
	+ `${rec.secs}s $${(rec.usd || 0).toFixed(4)}`
	+ (rec.ok ? `  — ${String(rec.ok).slice(0, 70)}` : '')
	+ (rec.err ? `  [${rec.err}]` : ''));
const once = async (model, reg, i) => {
	const tag = `${model.replace(/[^a-z0-9]+/gi, '_')}__${reg}__${i}`;
	let rec;
	try { rec = await oneRun(key, model, reg, tag); }
	catch (e) { rec = { model, reg, err: String(e.message || e), ok: 'threw', calls: 0, bytes: 0 }; }
	rows.push(rec);
	say(rec, i);
	if (out) fs.writeFileSync(out, JSON.stringify(rows, null, '\t'));
	return rec;
};

for (const model of MODELS) {
	// THE GATE, and it runs before a penny goes on any register.
	if (GATE) {
		const base = [];
		for (let i = 0; i < Math.max(2, N); i++) base.push(await once(model, 'none', i));
		// **The bar is MOVING the paragraph, not writing a file.**  Written as "wrote something
		// different" it passed `openai/gpt-oss-120b`, which reads the draft, writes a near-copy
		// of it back -- mean sentence 35.2 words against the draft's 35, three bare samples out
		// of three -- and declares the work done.  A model that hands back what it was given has
		// not shown it can do the task, and its register arms would measure nothing.
		const moved = base.filter((r) => typeof r.mean === 'number' && bandDistance(r) < DRAFT_DIST).length;
		if (!moved) {
			console.log(`${model.padEnd(28)} UNMEASURABLE: in ${base.length} bare samples it never `
				+ `moved the paragraph past the draft's own score, so nothing it does with a `
				+ 'register is evidence about the register. Its arms are not run.');
			continue;
		}
		console.log(`${model.padEnd(28)} gate passed: moved the paragraph in ${moved}/${base.length} bare samples.`);
	}
	for (const reg of REGS) {
		if (GATE && reg === 'none') continue;
		for (let i = 0; i < N; i++) await once(model, reg, i);
	}
}
report(rows);
