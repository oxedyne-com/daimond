// dev/forge.mjs — the Oregami forge's proposal surface, as a daimon reaches it.
//
// WHAT THIS IS FOR. Daimond's own development is tracked as PROPOSALS on the Oregami forge
// repository `oxedyne/daimond`. Claude Code and the daimons that work on Daimond use THIS helper
// to track that development: to READ the proposal list and one proposal, and — as a PULL voice —
// to OPEN a task proposal and COMMENT progress on it.
//
// THE FLOOR AND THE CEILING OF WHAT A PULL VOICE MAY DO. Reading a public repository needs no
// voice at all; opening a proposal and commenting on one need a `pull` voice, which is the
// floor. This helper does exactly those and NO MORE. It never settles (accept/decline/done/reopen
// is `admin`) and it never amends (a revision is the AUTHOR's alone, not a role). Those doors are
// not written here at all, so a pull voice cannot walk through one by mistake — a `settle` and an
// `amend` that refused at the forge would still be a door this file should not have.
//
// THE VOICE COMES FROM THE ENVIRONMENT, NEVER FROM SOURCE. `ORE_VOICE` holds the pull secret;
// absent, every write refuses loudly before a request is made. A credential in source is how one
// reaches a public repository (CLAUDE.md), so there is not one here, not even a default.
//
//   export ORE_VOICE=<the pull secret the forge minted>
//   node dev/forge.mjs list                    # the proposal list (no voice needed)
//   node dev/forge.mjs list --state open
//   node dev/forge.mjs read 12                 # one proposal in full
//   node dev/forge.mjs open "Title line" "The body."     # open a proposal  [needs ORE_VOICE]
//   node dev/forge.mjs comment 12 "Started on this."     # comment          [needs ORE_VOICE]
//   node dev/forge.mjs ship 12                           # stamp the SHIPPED build id  [needs ORE_VOICE]
//   node dev/forge.mjs --base https://oregami.oxegen.io list
//
// The base, account and repository default to Daimond's own and may be overridden with
// `--base`, `--account`, `--repo` (or `ORE_FORGE`, `ORE_ACCOUNT`, `ORE_REPO`). One node built-in
// beyond the platform `fetch` — `node:fs`, to read the deployed build id for `ship` — and no
// installed dependency: a helper that needed installing is one that stops being run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env;

/// The deployed build stamp beside this repo. `ship` reads the id from here and
/// never anywhere else, so the stamp it writes is the id that actually went out.
const HERE       = dirname(fileURLToPath(import.meta.url));
const BUILD_JSON = join(HERE, '..', 'www', 'build.json');

/// One place the forge is named, so a switch to a gateway-loopback base is one setting and not a
/// search. The read path is public today; the day the repository is veiled, point `ORE_FORGE` at
/// the gateway and nothing below changes.
export const defaults = () => ({
	base:    ENV.ORE_FORGE   || 'https://oregami.oxegen.io',
	account: ENV.ORE_ACCOUNT || 'oxedyne',
	repo:    ENV.ORE_REPO    || 'daimond',
	voice:   ENV.ORE_VOICE   || '',
});

/// The forge's stable refusal tokens. A caller branches on `error` and never on `said`.
const TOKENS = new Set(['absent', 'unvoiced', 'unknown', 'unpermitted', 'throttled',
	'malformed', 'no_proposal', 'unsupported', 'internal']);

/// The URL of the proposals surface. `format=json` is written here and never taken from a caller.
const url = (cfg, tail, query) => {
	const base = String(cfg.base || '').replace(/\/+$/, '');
	const p = `${base}/${encodeURIComponent(cfg.account)}/${encodeURIComponent(cfg.repo)}/proposals`
		+ (tail || '');
	return `${p}?format=json${query ? '&' + query : ''}`;
};

/// THE ONE DOOR. Every request goes through here. A read carries no voice — the repository is
/// public; a write carries the pull voice in `x-ore-voice`, form-encoded, like every write on the
/// forge. A `voice` in the BODY would be refused by the forge, so the credential is only ever a
/// header. Answers `{ ok, data }` or `{ ok:false, why, because, status }`.
///
/// `cfg` overrides `defaults()` per call, which is what the tests use to point at a stand-in.
export async function request(path, { method = 'GET', body = undefined, voice = undefined,
	cfg = defaults() } = {}) {
	const headers = {};
	if (method !== 'GET') {
		headers['content-type'] = 'application/x-www-form-urlencoded';
		// A write needs a voice, and it is a header and only ever a header.
		const v = voice !== undefined ? voice : cfg.voice;
		if (v) headers['x-ore-voice'] = v;
	}
	let r;
	try {
		r = await fetch(path, { method, headers, body });
	} catch (e) {
		return { ok: false, why: 'offline', said: String((e && e.message) || 'no answer') };
	}
	let text = '';
	try { text = await r.text(); } catch { text = ''; }
	let data = null;
	try { data = text ? JSON.parse(text) : null; } catch { data = null; }
	if (data && typeof data === 'object' && typeof data.error === 'string' && TOKENS.has(data.error)) {
		return {
			ok:      false,
			why:     data.error,
			because: typeof data.because === 'string' ? data.because : '',
			said:    typeof data.said === 'string' ? data.said : '',
			status:  r.status,
		};
	}
	if (r.ok && data && typeof data === 'object') return { ok: true, data };
	return { ok: false, why: 'gateway', status: r.status, said: text.slice(0, 200) };
}

// ── Reading (public, no voice) ───────────────────────────────────────────────────────────────

/// The proposal list, newest first. `opts` may carry `state` (open|accepted|declined|done),
/// `from` (a proposal-number ceiling counting down) and `limit` (1..200).
export async function list({ state, from, limit, cfg = defaults() } = {}) {
	const q = [];
	if (state != null)  q.push('state=' + encodeURIComponent(state));
	if (from != null)   q.push('from=' + encodeURIComponent(from));
	if (limit != null)  q.push('limit=' + encodeURIComponent(limit));
	return request(url(cfg, '', q.join('&')), { cfg });
}

/// One proposal in full: its body, its comments (`discussion`) and its revisions.
export async function read(n, { cfg = defaults() } = {}) {
	return request(url(cfg, '/' + Number(n)), { cfg });
}

// ── Writing (a PULL voice: open + comment ONLY) ──────────────────────────────────────────────
//
// There is no settle here and no amend here, on purpose. A pull voice may open a proposal and
// comment on one; settling is admin's and amending is the author's, and neither is this helper's
// to offer. The absence is the guarantee.

/// The pull secret, or a thrown error naming the environment variable. Every write asks for it
/// first, so a missing voice fails before a request rather than as a forge refusal.
function requireVoice(cfg) {
	if (!cfg.voice) {
		throw new Error('no voice: set ORE_VOICE to the forge pull secret before opening or '
			+ 'commenting. Reading needs none.');
	}
	return cfg.voice;
}

/// Open a task proposal. `title` is the one line it is about; `body` is what to do. `build` is an
/// optional sealed build identifier. Answers the whole record the forge created, so a caller
/// learns the proposal number it just opened.
export async function open(title, body = '', { build, cfg = defaults() } = {}) {
	requireVoice(cfg);
	const t = String(title || '').trim();
	if (!t) throw new Error('a proposal needs a title (the first argument).');
	const f = new URLSearchParams();
	f.set('title', t);
	f.set('body', String(body || ''));
	if (build) f.set('build', String(build));
	return request(url(cfg, ''), { method: 'POST', body: f.toString(), cfg });
}

/// Comment progress on one proposal. Answers the whole record, so a caller sees its comment
/// landed. It never carries a state field, so it cannot settle: a comment says something, a
/// decision decides something, and this door only says.
export async function comment(n, said, { cfg = defaults() } = {}) {
	requireVoice(cfg);
	const s = String(said || '').trim();
	if (!s) throw new Error('a comment needs something to say (the second argument).');
	const f = new URLSearchParams();
	f.set('said', s);
	return request(url(cfg, '/' + Number(n)), { method: 'POST', body: f.toString(), cfg });
}

// ── Stamping a shipped build ─────────────────────────────────────────────────────────────────
//
// When a proposal's fix has actually gone out, the agent that shipped it stamps the proposal with
// the build it went out in. The stamp is a COMMENT — it needs only the pull voice, not admin — in
// the fixed line the tracker board parses: "Shipped in build <id>". The id is READ from the
// deployed build.json and never invented; a stamp with a guessed id would be worse than none.

/// The build id in a build.json, or a thrown error. Read, never guessed: a missing file,
/// unreadable JSON, or a value that is not a build id all throw rather than stamp a proposal with
/// something invented. The shape — 8..40 lower-case hex — is the same one the board parses.
function buildId(buildFile) {
	let raw;
	try { raw = readFileSync(buildFile, 'utf8'); }
	catch (e) { throw new Error(`ship: cannot read the build stamp at ${buildFile}: ${String((e && e.message) || e)}`); }
	let obj;
	try { obj = JSON.parse(raw); }
	catch (e) { throw new Error(`ship: ${buildFile} is not the JSON build stamp: ${String((e && e.message) || e)}`); }
	const id = obj && typeof obj.build === 'string' ? obj.build.trim() : '';
	if (!/^[0-9a-f]{8,40}$/.test(id)) {
		throw new Error(`ship: ${buildFile} carries no build id to stamp (found ${JSON.stringify(id)}).`);
	}
	return id;
}

/// Stamp proposal `n` with the REAL deployed build id, read from build.json. Comments
/// "Shipped in build <id>", which the tracker board reads for its Shipped column. `buildFile`
/// overrides where the id is read from, for a test; by default it is the deployed www/build.json.
/// Answers the whole record, so a caller sees the stamp landed and can read back the id it wrote.
export async function ship(n, { buildFile = BUILD_JSON, cfg = defaults() } = {}) {
	requireVoice(cfg);
	const num = Number(n);
	if (!Number.isInteger(num) || num < 1) throw new Error('ship <n>: n is the proposal number.');
	const id = buildId(buildFile);
	return comment(num, `Shipped in build ${id}`, { cfg });
}

// ── The command line ─────────────────────────────────────────────────────────────────────────

/// Read `--base`, `--account`, `--repo` off argv, and hand back the rest as positionals.
function parse(argv) {
	const cfg = defaults();
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--base')    { cfg.base    = argv[++i] || cfg.base; continue; }
		if (a === '--account') { cfg.account = argv[++i] || cfg.account; continue; }
		if (a === '--repo')    { cfg.repo    = argv[++i] || cfg.repo; continue; }
		if (a === '--state')   { rest.push('--state', argv[++i]); continue; }
		rest.push(a);
	}
	return { cfg, rest };
}

async function main(argv) {
	const { cfg, rest } = parse(argv);
	const [verb, ...args] = rest;
	const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
	const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1); };

	try {
		if (verb === 'list') {
			let state;
			const si = args.indexOf('--state');
			if (si >= 0) state = args[si + 1];
			const a = await list({ state, cfg });
			out(a);
			return a.ok ? 0 : 1;
		}
		if (verb === 'read') {
			if (!args[0]) return fail('read <n>');
			const a = await read(args[0], { cfg });
			out(a);
			return a.ok ? 0 : 1;
		}
		if (verb === 'open') {
			if (!args[0]) return fail('open "<title>" ["<body>"]');
			const a = await open(args[0], args[1] || '', { cfg });
			out(a);
			return a.ok ? 0 : 1;
		}
		if (verb === 'comment') {
			if (!args[0] || !args[1]) return fail('comment <n> "<said>"');
			const a = await comment(args[0], args[1], { cfg });
			out(a);
			return a.ok ? 0 : 1;
		}
		if (verb === 'ship') {
			if (!args[0]) return fail('ship <n>   (stamps the deployed build id from www/build.json)');
			const a = await ship(args[0], { cfg });
			out(a);
			return a.ok ? 0 : 1;
		}
		return fail('verbs: list [--state <s>] | read <n> | open "<title>" ["<body>"] | comment <n> "<said>" | ship <n>');
	} catch (e) {
		return fail(String((e && e.message) || e));
	}
}

// Run only when invoked directly, so importing the functions for a test does not start the CLI.
if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).then((code) => process.exit(code || 0));
}
