// verify_tracker.mjs — the Tracker BOARD reads Daimond's proposals, settles them, and stamps ships.
//
// The Tracker (www/js/tracker.js) is a DECISION-QUEUE BOARD onto Daimond's own development, which
// lives as PROPOSALS on the Oregami forge repository `oxedyne/daimond`. Four columns, the life of
// a proposal left to right: Awaiting you (open) -> Greenlit (accepted) -> Shipped (done) ->
// Dropped (declined). It reaches the forge the way improve.js does: through the same-origin
// Daimond gateway route `/api/improve`, which forwards to the forge and translates
// `x-daimond-voice` into the forge's `x-ore-voice`. READS ARE PUBLIC AND UNVOICED; only a settle
// carries the admin voice. This drives the view in a real browser; the gateway is STOOD IN FOR
// here (as verify_improve.mjs stands it in), and the forge behind it is dev/mock_forge.mjs.
//
// WHAT IS PROVED, each a clause of what the board is for:
//   NODE, against a wire-capture server (dev/forge.mjs `ship`):
//   0a. SHIP STAMPS THE REAL BUILD. `ship` reads the deployed build id from build.json and
//       comments "Shipped in build <id>" — the id from the FILE, never a constant, carried under
//       the pull voice. A different build.json changes the stamp; a build.json with no id THROWS
//       and posts NOTHING (the board would rather show no stamp than an invented one).
//   BROWSER, against the mock forge:
//   1. THE BOARD DRAWS FOUR COLUMNS, each proposal under the column matching its state, newest
//      first within a column.
//   2. A CARD carries its number, title, comment count and vote TALLY.
//   3. VOTES ARE DARK. The tally is two counts and the DOM carries no voter identity anywhere.
//   4. READING IS UNVOICED. Every read the board makes carries no voice header at all, even when
//      an admin voice is held.
//   5. NO DEAD SETTLE BUTTONS. With no admin voice there is NO settle control — only the terse
//      "add your settle voice" affordance; pasting a voice REVEALS the controls.
//   6. THE OWNER SETTLES FROM THE BOARD, THE REASON OPTIONAL. With an admin voice, Accept on a
//      NON-SELF Awaiting-you card opens an OPTIONAL one-line reason box (it does not settle yet);
//      an EMPTY confirm settles, carrying `state` alone; a filled one posts `state=accepted` AND
//      `reason` under the voice and the card moves to Greenlit. Decline the same. Reopen and Mark
//      done carry `state` alone. Reason max is REASON_LIMIT (1000).
//   6b. A SELF-AUTHORED PROPOSAL SKIPS THE REASON STEP. A proposal raised from THIS device (its
//      number in DaimondImprove.raisedProposalNumbers()) settles at a single press: Accept/Decline
//      is a direct settle carrying `state` alone, no reason box.
//   7. A SHIPPED CARD STAMPS THE REAL BUILD. The board PARSES the ship stamp out of the proposal's
//      comments and draws the id, clickable; it reads the id, it does not invent one.
//   8. A PROPOSAL OPENS IN FULL, and a refusal is SAID, not swallowed.
//   9. ALL / MINE. The board defaults to All; Mine shows only the proposals THIS DEVICE raised,
//      read from DaimondImprove.raisedProposalNumbers() (author cannot match — the local voice has
//      no name). With no capture surface, Mine shows a "nothing raised" state and never throws.
//  10. VOTE AND COMMENT ARE RE-HOMED HERE, cast with the PULL voice through the Social panel's own
//      doors (DaimondImprove.forge.vote / .say) — never a copy of the POST in tracker.js. Reading a
//      tally or a thread needs no voice; with no pull voice the card shows the "set a voice"
//      affordance, not a control that the forge would refuse.
//  11. AN UPVOTE INCREMENTS THE SHOWN COUNT, drawn from the forge's own answer and never a second
//      copy: the board folds the record the vote returned and redraws, and the upvote reads pressed.
//  12. PRESSING AN UPVOTE ALREADY CAST WITHDRAWS IT — d=0, and the count falls back.
//  13. A POSTED COMMENT APPEARS in the opened card's thread, from the answer the comment returned.
//  14. A RE-SHOWN BOARD REFETCHES. A proposal declined on ANOTHER device (a settle the board never
//      made) moves from "Awaiting you" to "Dropped" when the panel is re-shown past the refresh
//      throttle -- the board no longer reads once and freezes.
//  15. A FAILED READ IS THROTTLED. Once the board has read, an erroring forge is refetched at most
//      once per REFRESH_MS, because a failed read stamps the throttle exactly as a good one does.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a damaged tracker.js
// and the run is expected to FAIL the one check it targets:
//   node dev/verify_tracker.mjs --break miscolumn      # 1  a proposal lands in the wrong column
//   node dev/verify_tracker.mjs --break leakvoters     # 3  a voter name reaches the DOM
//   node dev/verify_tracker.mjs --break voicedread     # 4  a read carries a voice
//   node dev/verify_tracker.mjs --break alwayssettle   # 5  settle drawn with no voice
//   node dev/verify_tracker.mjs --break noreasongate   # 6  a non-self Accept settles with no box
//   node dev/verify_tracker.mjs --break noemptysettle  # 6  an empty reason is refused, not settled
//   node dev/verify_tracker.mjs --break selfnoskip     # 6b a self proposal still shows the box
//   node dev/verify_tracker.mjs --break shipinvent     # 7  the shipped stamp is invented
//   node dev/verify_tracker.mjs --break swallow        # 8  a refusal drawn as blank
//   node dev/verify_tracker.mjs --break minefilter     # 9  Mine shows more than this device raised
//   node dev/verify_tracker.mjs --break votedark       # 10 a live upvote drawn with no pull voice
//   node dev/verify_tracker.mjs --break votenofold     # 11 the vote answer is not folded back
//   node dev/verify_tracker.mjs --break voteonlyup     # 12 an upvote cannot be withdrawn
//   node dev/verify_tracker.mjs --break commentswallow # 13 a posted comment never appears
//   node dev/verify_tracker.mjs --break freeze         # 14 a re-shown board never refetches
//   node dev/verify_tracker.mjs --break nothrottlefail # 15 a failed read leaves the forge unfloored
//   node dev/verify_tracker.mjs                        # and then, clean
//
// Needs playwright-core (resolved via dev/harness.mjs) and node. No dev server, no Rust: the page
// and the module are served from disk through page.route, and the forge is the mock, proxied.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PW, CHROME, scratch } from './harness.mjs';
import * as forge from './forge.mjs';

const { chromium } = await import(pathToFileURL(PW).href);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'tracker' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The broken copies ────────────────────────────────────────────────
// Each edit is a real change to www/js/tracker.js, served in place of it. `find` must appear
// exactly once, or the run aborts: a break that matched nothing would prove the opposite of what
// it claims.
const BREAKS = {
	// A proposal lands in the wrong column: the Awaiting-you column is pointed at `accepted`, so
	// the five open proposals appear nowhere and three accepted ones sit under "Awaiting you".
	miscolumn: [{
		file: 'js/tracker.js',
		find: "\t\t{ state: 'open',     key: 'col_open',  label: 'Awaiting you' },",
		with: "\t\t{ state: 'accepted', key: 'col_open',  label: 'Awaiting you' },",
	}],
	// A voter identity drawn into the tally. The forge never sends one, so this fabricates it —
	// exactly the shape of the mistake the dark-vote rule forbids. The counts stay right, so only
	// the dark check moves.
	leakvoters: [{
		file: 'js/tracker.js',
		find: "\t\treturn el('span', 'trk-tally', tOr('tracker.tally', '{yes} for, {no} against',\n\t\t\t{ yes: p.votes.for, no: p.votes.against }));",
		with: "\t\tvar s = el('span', 'trk-tally', tOr('tracker.tally', '{yes} for, {no} against',\n\t\t\t{ yes: p.votes.for, no: p.votes.against }));\n\t\ts.title = 'quokka-voter-leak voted for';\n\t\treturn s;",
	}],
	// A voice attached to a READ. Reads stay public, so a read must carry none; this makes the
	// listing read send the admin voice on its GET. It bites where an admin voice is held.
	voicedread: [{
		file: 'js/tracker.js',
		find: "\t\tvar a = await request(route('limit=' + PAGE), { method: 'GET' });",
		with: "\t\tvar a = await request(route('limit=' + PAGE), { method: 'GET' }, cfg.voice);",
	}],
	// Settle controls drawn with no admin voice: a control that belongs to the owner offered to a
	// reader who cannot use it.
	alwayssettle: [{
		file: 'js/tracker.js',
		find: "\t\tif (!canSettle()) return null;\n\t\tvar acts = el('div', 'trk-settle');",
		with: "\t\tvar acts = el('div', 'trk-settle');",
	}],
	// The shipped stamp INVENTED. `parseShip` stops reading the comment and returns a constant id
	// for any discussion, so the board draws a build that was never stamped.
	shipinvent: [{
		file: 'js/tracker.js',
		find: "\t\tfor (var i = discussion.length - 1; i >= 0; i--) {\n\t\t\tvar said = discussion[i] && discussion[i].said;\n\t\t\tvar m = (typeof said === 'string') ? SHIP_RE.exec(said) : null;\n\t\t\tif (m) return m[1];\n\t\t}\n\t\treturn '';",
		with: "\t\treturn discussion.length ? 'ffffffffffff' : '';",
	}],
	// A refusal swallowed: the error is dropped and the view draws blank.
	swallow: [{
		file: 'js/tracker.js',
		find: "\t\tif (_st.err) _host.appendChild(el('div', 'trk-err', saying(_st.err)));",
		with: "\t\tif (_st.err && false) _host.appendChild(el('div', 'trk-err', saying(_st.err)));",
	}],
	// The Mine filter ignores the raised set, so Mine shows every proposal rather
	// than only the ones this device raised. Bites check 9: Mine is no longer Mine.
	minefilter: [{
		file: 'js/tracker.js',
		find: "\t\t\t\tif (_filter === 'mine') return !!(mine && mine[n]);",
		with: "\t\t\t\tif (_filter === 'mine') return true;",
	}],
	// A live upvote drawn WITHOUT a pull voice: a control that the forge would
	// refuse, offered to a reader who cannot post. Bites check 10: the no-voice
	// card must show the "set a voice" affordance, not a live button.
	votedark: [{
		file: 'js/tracker.js',
		find: "\t\tif (pullVoice() && voteDoor()) {\n\t\t\tvar up = button('trk-vote-btn', 'tracker-vote',",
		with: "\t\tif (true) {\n\t\t\tvar up = button('trk-vote-btn', 'tracker-vote',",
	}],
	// The vote answer is not folded back, so the shown count never moves and the
	// upvote never reads pressed -- the tally kept in the client disagreeing with
	// the forge, which is exactly what the one-store rule forbids. Bites check 11.
	votenofold: [{
		file: 'js/tracker.js',
		find: "\t\tif (!a || !a.ok) { _st.err = a || { why: 'gateway' }; draw(); return false; }\n\t\tabsorb(clean(a.data));\n\t\tderiveFrom(whole(n));\n\t\t_st.err = null;\n\t\tdraw();\n\t\treturn true;\n\t}\n\n\t/// Say something on proposal",
		with: "\t\tif (!a || !a.ok) { _st.err = a || { why: 'gateway' }; draw(); return false; }\n\t\tif (false) absorb(clean(a.data));\n\t\tderiveFrom(whole(n));\n\t\t_st.err = null;\n\t\tdraw();\n\t\treturn true;\n\t}\n\n\t/// Say something on proposal",
	}],
	// Pressing an upvote already cast sends d=1 again instead of d=0, so there is
	// no way to take a vote back -- a pressed control that will not un-press. Bites
	// check 12: the withdrawal body.
	voteonlyup: [{
		file: 'js/tracker.js',
		find: "\t\tvar d = (p.asked && p.mine === 1) ? 0 : 1;",
		with: "\t\tvar d = 1;",
	}],
	// A posted comment's answer is not folded back, so the comment never appears in
	// the thread -- the reader is left unsure whether it was sent. Bites check 13.
	commentswallow: [{
		file: 'js/tracker.js',
		find: "\t\tbox.value = '';\n\t\tabsorb(clean(a.data));",
		with: "\t\tbox.value = '';\n\t\tif (false) absorb(clean(a.data));",
	}],
	// The board FREEZES on its first read: the observer disconnects after one fire and onOpen
	// only ever loads when it has never read. So a proposal declined on another device stays in
	// "Awaiting you", which is the exact regression the re-show refetch removed. Bites check 14:
	// the re-shown board never sees the cross-device decline. TWO edits, both reverting the fix --
	// the read-once guard in onOpen and the one-shot disconnect in the observer.
	freeze: [{
		file: 'js/tracker.js',
		find: "\t\tif (!_st.read || Date.now() - _lastLoad >= REFRESH_MS) load();",
		with: "\t\tif (!_st.read && !_st.loading) load();",
	}, {
		file: 'js/tracker.js',
		find: "\t\t\t\t\t\tif (entries[i].isIntersecting) { onOpen(); return; }",
		with: "\t\t\t\t\t\tif (entries[i].isIntersecting) { onOpen(); io.disconnect(); return; }",
	}],
	// A FAILED read does not stamp the throttle, so a board that has read once and then meets an
	// erroring forge refetches on every re-show with no floor -- a down forge pounded once per
	// panel show. Bites check 15: two rapid re-shows against an erroring forge fire two reads, not
	// one.
	nothrottlefail: [{
		file: 'js/tracker.js',
		find: "\t\tif (!a.ok) { _st.err = a; _lastLoad = Date.now(); draw(); return false; }",
		with: "\t\tif (!a.ok) { _st.err = a; draw(); return false; }",
	}],
	// Accept and decline no longer offer their reason box: CARRIES_REASON is emptied, so
	// the buttons settle at a press even for a NON-SELF proposal, and the optional note is
	// gone. Bites the reason-box check (a non-self Accept must open a box, not post).
	noreasongate: [{
		file: 'js/tracker.js',
		find: "\tvar CARRIES_REASON = { accept: 1, decline: 1 };",
		with: "\tvar CARRIES_REASON = {};",
	}],
	// The optional-reason guard is put BACK, so an empty confirm is refused rather than
	// settled. Bites the check that an empty box now SETTLES with no reason field.
	noemptysettle: [{
		file: 'js/tracker.js',
		find: "\t\tvar reason = inp ? String(inp.value || '').trim() : '';\n\t\treturn settle(n, which, reason);",
		with: "\t\tvar reason = inp ? String(inp.value || '').trim() : '';\n\t\tif (!reason) return false;\n\t\treturn settle(n, which, reason);",
	}],
	// The self signal is severed: isSelf always answers false, so a self-authored proposal
	// still shows the reason box. Bites the 6b check that a self Accept is a direct settle.
	selfnoskip: [{
		file: 'js/tracker.js',
		find: "\t\tvar mine = raisedSet();\n\t\treturn !!(mine && mine[whole(p.n)]);",
		with: "\t\treturn false;",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The file as served: this run's break on top of what is on disk.
const FILES = new Map();
function edit(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, so nothing `
			+ 'was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}
function build() {
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const src = FILES.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		FILES.set(spec.file, edit(src, spec));
	}
}
build();

const trackerSrc = () => FILES.get('js/tracker.js') ?? fs.readFileSync(path.join(WWW, 'js', 'tracker.js'), 'utf8');

// ── NODE: dev/forge.mjs `ship` stamps the REAL build, against a wire capture ──────────
// A capture server records exactly what `ship` put on the socket, so the stamp is proved by its
// bytes rather than an effect: that the id is the FILE's and not a constant, that the credential
// rode in x-ore-voice, and that a build.json with no id posts NOTHING at all.

const CAP_PORT = 8453;
const captured = [];
const capSrv = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		captured.push({ method: req.method, url: req.url, headers: req.headers,
			body: Buffer.concat(chunks).toString('utf8') });
		const rec = { number: 7, title: 'x', state: 'done', author: 'ci', comments: 0,
			votes: { for: 0, against: 0 }, opened: 1, changed: 1, mark: null, build: null,
			body: '', discussion: [], revisions: [] };
		const buf = Buffer.from(JSON.stringify(rec), 'utf8');
		res.writeHead(200, { 'content-type': 'application/json', 'content-length': buf.length });
		res.end(buf);
	});
});

const PULL = 'mock-voice-grace';		// a comment (which a stamp is) needs only the pull voice

/// Write a build.json fixture and hand back its path.
function buildFile(name, obj) {
	const p = path.join(PROFILE, name);
	fs.mkdirSync(PROFILE, { recursive: true });
	fs.writeFileSync(p, JSON.stringify(obj));
	return p;
}

async function nodePhase() {
	await new Promise((resolve, reject) => {
		capSrv.on('error', reject);
		capSrv.listen(CAP_PORT, '127.0.0.1', resolve);
	});
	const CAP = `http://127.0.0.1:${CAP_PORT}`;
	const cfg = (voice) => ({ base: CAP, account: 'oxedyne', repo: 'daimond', voice });

	const idA = '85bfe5f585b6';
	const idB = '0011223344ff';
	const fileA   = buildFile('build_a.json',   { build: idA, note: 'a' });
	const fileB   = buildFile('build_b.json',   { build: idB, note: 'b' });
	const fileBad = buildFile('build_bad.json', { note: 'no build id here' });

	// A stamp with the file's id, carried under the pull voice, form-encoded on the proposal.
	captured.length = 0;
	await forge.ship(7, { buildFile: fileA, cfg: cfg(PULL) });
	const c0 = captured[0] || { method: '', url: '', headers: {}, body: '' };
	check('ship posts to the proposal on the forge', c0.method === 'POST' && /\/oxedyne\/daimond\/proposals\/7\?/.test(c0.url), c0.method + ' ' + c0.url);
	check('the stamp carries the pull voice in x-ore-voice', c0.headers['x-ore-voice'] === PULL, String(c0.headers['x-ore-voice']));
	const f0 = Object.fromEntries(new URLSearchParams(c0.body));
	check('the stamp body is the said field alone', JSON.stringify(Object.keys(f0).sort()) === JSON.stringify(['said']), c0.body);
	check('the stamp names the REAL build id from build.json', f0.said === `Shipped in build ${idA}`, f0.said);

	// A different build.json → a different stamp: it reads the file, it is not a constant.
	captured.length = 0;
	await forge.ship(7, { buildFile: fileB, cfg: cfg(PULL) });
	const f1 = Object.fromEntries(new URLSearchParams((captured[0] || {}).body || ''));
	check('a different build.json changes the stamp (it is read, not hard-coded)', f1.said === `Shipped in build ${idB}`, f1.said);

	// A build.json with no id THROWS and posts NOTHING — the board would rather show no stamp.
	captured.length = 0;
	let threw = false;
	try { await forge.ship(7, { buildFile: fileBad, cfg: cfg(PULL) }); }
	catch (e) { threw = true; }
	check('a build.json with no id throws rather than inventing one', threw);
	check('a build.json with no id posts nothing at all', captured.length === 0, `${captured.length} posts`);

	await new Promise(r => capSrv.close(r));
}

// ── The forge, spawned and proxied ───────────────────────────────────

const MOCK_PORT = 8452;
let mockProc = null;

/// The build id the stand-in gateway injects as a ship stamp onto every DONE proposal's detail,
/// so the browser board has a real stamp to parse. Deliberately not the `shipinvent` constant.
const SHIP_ID = 'deadbeef1234';

async function reachable(port) {
	try { const r = await fetch(`http://127.0.0.1:${port}/a/b/proposals?format=json&limit=1`); await r.text(); return true; }
	catch { return false; }
}
async function startMock() {
	if (await reachable(MOCK_PORT)) {
		console.error(`:${MOCK_PORT} is already held; free it, or this run drives someone else's forge.`);
		process.exit(2);
	}
	mockProc = spawn('node', [path.join(HERE, 'mock_forge.mjs'), '--port', String(MOCK_PORT), '--count', '12'],
		{ stdio: ['ignore', 'ignore', 'inherit'] });
	for (let i = 0; i < 100; i++) { if (await reachable(MOCK_PORT)) return; await new Promise(r => setTimeout(r, 100)); }
	console.error('the mock forge never bound.');
	process.exit(2);
}
function stopMock() { if (mockProc) { try { mockProc.kill('SIGTERM'); } catch { /* gone */ } mockProc = null; } }
process.on('exit', stopMock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopMock(); process.exit(130); });

// Every request the page made to the gateway route, so the read checks can see whether a voice
// rode on a GET. `voice` here is the Daimond voice header the browser sent.
const forgeReqs = [];

/// When set, the gateway answers every LISTING read with a 502, so the board can be driven
/// against a forge that has gone down AFTER a first successful read. That is the one state the
/// throttle-on-a-failed-read fix is about: a board that has read once (`read` is true) and then
/// meets an erroring forge must not refetch on every re-show. Off for every other check.
let failReads = false;

/// Decline a proposal ON THE FORGE the way ANOTHER DEVICE would — a settle POST straight to the
/// mock under the admin voice, which the board itself never made. This is the cross-device change
/// the re-show refetch has to notice; the board has no hand in it. The mock holds its corpus in
/// memory, so this mutation is the same corpus the browser reads back through the gateway.
async function declineOnForge(n) {
	const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/oxedyne/daimond/proposals/${n}?format=json`, {
		method:  'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-ore-voice': 'mock-voice-ada' },
		body:    'state=declined',
	});
	return r.status;
}

/// The upstream forge path the gateway builds from the query, reproduced from
/// gateway/src/handlers/improve.rs (and verify_improve.mjs's stand-in): `format=json` is written
/// by the gateway and never taken from the caller; the settle `state` field rides in the body.
function upstreamPath(u) {
	const q = u.searchParams;
	const n = q.get('n');
	// The sub-resource of a proposal rides in the QUERY here and becomes a path
	// segment upstream, exactly as improve.rs does: `&vote=1` -> `/proposals/n/vote`,
	// `&amend=1` -> `/proposals/n/amend`. A settle carries neither, and its `state`
	// rides in the body. Without this the board's vote POST would hit the comment
	// route, and its `d=1` would be read as an empty comment.
	const leaf = q.get('vote') === '1' ? '/vote' : (q.get('amend') === '1' ? '/amend' : '');
	let p = `/${q.get('account')}/${q.get('repo')}/proposals`;
	if (n !== null) p += '/' + n + leaf;
	p += '?format=json';
	if (n === null) {
		for (const k of ['state', 'from', 'limit']) {
			const v = q.get(k);
			if (v !== null) p += `&${k}=` + v;
		}
	}
	return p;
}

/// A DONE proposal's detail, with a ship stamp appended to its comments as a shipped agent would
/// have left one. The forge is not made to carry it (that would change a shared fixture); the
/// stand-in gateway adds it, so the board has a real stamp to parse. Left verbatim on anything but
/// a done detail.
function withShipStamp(text) {
	let j;
	try { j = JSON.parse(text); } catch { return text; }
	if (!j || j.state !== 'done' || !Array.isArray(j.discussion)) return text;
	j.discussion = j.discussion.concat([{ author: 'ci', said: `Shipped in build ${SHIP_ID}`, when: (j.changed || 1) + 1 }]);
	return JSON.stringify(j);
}

/// THE DAIMOND GATEWAY, stood in for. It reads the account/repo/n/selectors off the query,
/// translates the Daimond voice header (`x-daimond-voice`) into the forge's (`x-ore-voice`),
/// forwards to the mock forge over loopback, and hands the answer back. Same-origin as the page,
/// so no CORS is involved — which is the whole point of routing through the gateway.
async function gatewayRoute(route) {
	const req = route.request();
	const u = new URL(req.url());
	const method = req.method();
	const headers = req.headers();
	const dvoice = headers['x-daimond-voice'] || '';
	forgeReqs.push({ url: req.url(), method, voice: dvoice, body: req.postData() || '' });
	// A forge that has gone down: every LISTING read answers 502. The read is still counted above,
	// so a check can see the board FIRE a read; what it cannot get back is a listing, so `load()`
	// fails and stamps its throttle. Only the listing, so an open/enrich detail read is untouched.
	if (failReads && method === 'GET' && u.searchParams.get('n') === null) {
		return route.fulfill({ status: 502, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'the forge is unreachable' }) });
	}
	// The gateway refuses a voiceless POST before forwarding (reproduced from improve.rs).
	if (method === 'POST' && !dvoice) {
		return route.fulfill({ status: 401, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'writing needs a voice' }) });
	}
	const out = { 'accept': 'application/json' };
	if (dvoice) out['x-ore-voice'] = dvoice;			// the translation the gateway performs
	if (method === 'POST') out['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
	let res, text;
	try {
		res = await fetch(`http://127.0.0.1:${MOCK_PORT}${upstreamPath(u)}`, {
			method, headers: out, body: method === 'POST' ? (req.postData() || '') : undefined,
		});
		text = await res.text();
	} catch (e) {
		return route.fulfill({ status: 502, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'the forge could not be reached' }) });
	}
	// A done detail gets a ship stamp, so the board's Shipped column has an id to parse.
	if (res.ok && u.searchParams.get('n') !== null) text = withShipStamp(text);
	return route.fulfill({
		status: res.status,
		contentType: res.headers.get('content-type') || 'application/json',
		body: text,
	});
}

// ── The harness page ─────────────────────────────────────────────────
// A bare page whose only job is to hold a mount point and load the module. It carries a MINIMAL
// DaimondIdentity stub so the "add your settle voice" paste path is drawable and testable (the
// real one wraps under the passphrase; here wrap/unwrap are the identity). The view draws itself
// into `#trk`; the checks read the DOM and call the published API.

const PAGE = `<!doctype html><meta charset="utf-8"><title>Tracker harness</title>
<body><div id="trk"></div>
<script>
window.DaimondIdentity = {
	isUnlocked: function () { return true; },
	wrap:   async function (s) { return 'w:' + String(s); },
	unwrap: async function (w) { return String(w).replace(/^w:/, ''); },
};
// The Social panel (js/improve.js) STOOD IN FOR: the board holds no pull voice
// and no vote/comment POST of its own -- it calls these doors, which carry the
// pull voice and speak the one copy of the wire improve.js keeps. The stub POSTs
// through the same gateway route with the mock's PULL voice, and reads the answer
// into the panel's {ok,data} shape exactly as improve.js's own \`ask\` does. This
// is what lets the checks prove the board CALLS these doors and draws the result,
// rather than re-implementing the POST in tracker.js.
function __door(path, body) {
	return fetch(path, { method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-daimond-voice': 'mock-voice-grace' },
		body: body }).then(function (r) {
		return r.text().then(function (t) {
			var data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
			if (data && data.error) return { ok: false, why: data.error };
			if (r.ok && data) return { ok: true, data: data };
			return { ok: false, why: 'gateway', status: r.status };
		});
	}).catch(function () { return { ok: false, why: 'offline' }; });
}
window.__installImprove = function (hasVoice) {
	window.DaimondImprove = {
		hasVoice: function () { return !!hasVoice; },
		raisedProposalNumbers: function () { return []; },
		provision: function () { return Promise.resolve(false); },
		forge: {
			vote: function (n, d) { return __door('/api/improve?account=oxedyne&repo=daimond&n=' + n + '&vote=1', 'd=' + d); },
			say:  function (n, text) { var f = new URLSearchParams(); f.set('said', text);
				return __door('/api/improve?account=oxedyne&repo=daimond&n=' + n, f.toString()); },
		},
	};
};
</script>
<script src="/js/tracker.js"></script>
<script>window.__mount = function (opts) {
	DaimondTracker.reset();
	try { DaimondTracker.adminClear(); } catch (e) {}
	// base is the same-origin gateway route; the harness's #trk is the mount point (the app uses
	// #tracker-view). onOpen() reads the listing, which mount() no longer does on its own.
	DaimondTracker.configure(Object.assign({ base: '/api/improve', account: 'oxedyne', repo: 'daimond', voice: '' }, opts || {}));
	DaimondTracker.mount(document.getElementById('trk'));
	DaimondTracker.onOpen();
};</script></body>`;

const ORIGIN = 'https://daimond.test';

async function run() {
	await nodePhase();
	await startMock();

	fs.mkdirSync(PROFILE, { recursive: true });
	const env = Object.assign({}, process.env);
	delete env.DISPLAY;
	const browser = await chromium.launchPersistentContext(PROFILE, {
		executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
		env, viewport: { width: 1100, height: 900 },
	});
	const page = browser.pages()[0] || await browser.newPage();
	const errs = [];
	page.on('pageerror', e => errs.push(String(e.message)));

	// Serve the page and the module; proxy the forge host.
	await page.route(`${ORIGIN}/`, r => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
	await page.route(`${ORIGIN}/js/tracker.js`, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: trackerSrc() }));
	await page.route(`${ORIGIN}/api/improve*`, gatewayRoute);

	const sleep = (ms) => new Promise(r => setTimeout(r, ms));
	/// Mount the view with the given config and wait for the listing and its enrichment reads.
	const mount = async (opts) => {
		forgeReqs.length = 0;
		await page.evaluate((o) => window.__mount(o), opts || null);
		await sleep(700);
	};
	const col = (i) => page.locator('#trk .trk-col').nth(i);

	try {
		await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });

		// ── 1. The board draws four columns ──────────────────────────
		await mount();
		check('the board draws four columns', (await page.locator('#trk .trk-col').count()) === 4);
		const labels = await page.locator('#trk .trk-col-label').allInnerTexts();
		check('the four columns are Awaiting you / Greenlit / Shipped / Dropped',
			JSON.stringify(labels.map(s => s.trim())) === JSON.stringify(['Awaiting you', 'Greenlit', 'Shipped', 'Dropped']),
			labels.join(' | '));

		// Each proposal under the column matching its state (corpus: 5 open, 3 accepted, 2 done,
		// 2 declined). This is what `miscolumn` breaks.
		check('Awaiting you holds the five open proposals', (await col(0).locator('.trk-card').count()) === 5, `${await col(0).locator('.trk-card').count()}`);
		check('Greenlit holds the three accepted proposals', (await col(1).locator('.trk-card').count()) === 3);
		check('Shipped holds the two done proposals', (await col(2).locator('.trk-card').count()) === 2);
		check('Dropped holds the two declined proposals', (await col(3).locator('.trk-card').count()) === 2);

		// Newest first within the Shipped column: #11 before #7 (done sits at positions 7 and 11).
		const shipNums = (await col(2).locator('.trk-num').allInnerTexts()).map(s => Number(s.replace('#', '')));
		check('a column runs newest first', JSON.stringify(shipNums) === JSON.stringify(shipNums.slice().sort((a, b) => b - a)) && shipNums[0] > shipNums[1], shipNums.join(','));

		// ── 2. A card's fields ───────────────────────────────────────
		const anyCard = page.locator('#trk .trk-card').first();
		check('a card carries its number', /^#\d+$/.test((await anyCard.locator('.trk-num').innerText()).trim()));
		check('a card carries a title', (await anyCard.locator('.trk-title').innerText()).trim().length > 0);
		check('a card carries a comment count', (await anyCard.locator('.trk-comments').count()) === 1);
		check('a card carries a vote tally', (await anyCard.locator('.trk-tally').count()) === 1);

		// ── 3. Votes are dark ────────────────────────────────────────
		const tally = (await anyCard.locator('.trk-tally').innerText()).trim();
		check('the tally is two counts and nothing else', /for.*against/i.test(tally) || /\d+.*\d+/.test(tally), tally);
		const html = await page.locator('#trk').innerHTML();
		check('no voter identity appears anywhere in the view', !/voter|quokka-voter/i.test(html));

		// ── 4. Reading is unvoiced (read-only phase, no voice held) ──
		check('the listing read carried no voice', forgeReqs.filter(r => r.method === 'GET' && r.voice).length === 0);

		// ── 5. No dead settle buttons ────────────────────────────────
		check('with no admin voice, no settle control is drawn', (await page.locator('#trk .trk-settle-btn').count()) === 0);
		const affordance = page.locator('#trk [data-act="tracker-admin-open"]');
		check('with no admin voice, the "add your settle voice" affordance is shown', (await affordance.count()) === 1);

		// ── 7. A Shipped card stamps the REAL build ──────────────────
		// The done details were given a ship stamp by the stand-in; the board parses the id.
		const shipId = col(2).locator('.trk-ship-id').first();
		check('a Shipped card shows a build stamp', (await shipId.count()) >= 1);
		if (await shipId.count()) {
			check('the shipped stamp is the REAL parsed id, not invented', (await shipId.innerText()).trim() === SHIP_ID, (await shipId.innerText()).trim());
			check('the shipped stamp is clickable to the transparency log',
				(await shipId.getAttribute('data-act')) === 'tracker-transparency' && (await shipId.getAttribute('data-build')) === SHIP_ID);
		} else {
			check('the shipped stamp is the REAL parsed id, not invented', false, 'no stamp drawn');
			check('the shipped stamp is clickable to the transparency log', false, 'no stamp drawn');
		}

		// parseShip, driven directly: the same parse the board does, proved on crafted comments.
		const ps = await page.evaluate(() => {
			const P = window.DaimondTracker.parseShip;
			return {
				hit:   P([{ said: 'working on it' }, { said: 'Shipped in build 85bfe5f585b6' }]),
				none:  P([{ said: 'no stamp here' }, { said: 'still none' }]),
				last:  P([{ said: 'Shipped in build aaaaaaaa1111' }, { said: 'Shipped in build bbbbbbbb2222' }]),
			};
		});
		check('parseShip extracts the build id from a ship stamp', ps.hit === '85bfe5f585b6', ps.hit);
		check('parseShip returns nothing when no stamp is present', ps.none === '', JSON.stringify(ps.none));
		check('parseShip takes the last stamp when several are present', ps.last === 'bbbbbbbb2222', ps.last);

		// ── 8a. A proposal opens in full ─────────────────────────────
		await anyCard.locator('.trk-title').click();
		await sleep(500);
		check('opening a card shows the detail view', (await page.locator('#trk .trk-detail').count()) === 1);
		check('the detail shows the title and body', (await page.locator('#trk .trk-detail-title').count()) === 1 && (await page.locator('#trk .trk-body').count()) === 1);
		check('the detail shows a comments section', (await page.locator('#trk .trk-comments-list').count()) === 1);
		check('the detail shows the state', (await page.locator('#trk .trk-detail .trk-state').count()) === 1);
		check('the detail read carried no voice', forgeReqs.filter(r => r.method === 'GET' && r.voice).length === 0);
		await page.locator('#trk .trk-back').click();
		await sleep(300);
		check('Back returns to the board', (await page.locator('#trk .trk-col').count()) === 4);

		// ── 5b. Pasting a settle voice REVEALS the controls ──────────
		check('before pasting, still no settle control', (await page.locator('#trk .trk-settle-btn').count()) === 0);
		await page.locator('#trk [data-act="tracker-admin-open"]').click();
		await sleep(150);
		check('the affordance opens a paste field', (await page.locator('#trk #tracker-admin-in').count()) === 1);
		await page.locator('#trk #tracker-admin-in').fill('a-settle-voice-2026');
		await page.locator('#trk [data-act="tracker-admin-save"]').click();
		await sleep(300);
		check('pasting a settle voice reveals the settle controls', (await page.locator('#trk .trk-settle-btn').count()) >= 1);
		await page.evaluate(() => window.DaimondTracker.adminClear());

		// ── 6. The owner settles from the board ──────────────────────
		// mock-voice-ada is the mock's ADMIN voice; the view sends it verbatim as x-ore-voice.
		await mount({ voice: 'mock-voice-ada' });
		// EVEN WITH A VOICE HELD, a READ carries none — reads stay public. This is where
		// `voicedread` bites: the listing read here would leak the held voice.
		check('reads carry no voice even when an admin voice is held', forgeReqs.filter(r => r.method === 'GET' && r.voice).length === 0, `${forgeReqs.filter(r => r.method === 'GET' && r.voice).length} voiced GET(s)`);
		check('with an admin voice, settle controls are drawn on Awaiting-you cards', (await col(0).locator('.trk-settle-btn').count()) >= 1);

		// Accept on a NON-SELF card opens an OPTIONAL reason box; an EMPTY confirm now SETTLES,
		// carrying state alone. Two cards, since the first is consumed when it settles. Guarded by
		// the button's presence, so a break that empties the column fails cleanly.
		const emptyCard = col(0).locator('.trk-card').first();
		const emptyAccept = emptyCard.locator('.trk-settle-btn[data-which="accept"]');
		if (await emptyAccept.count()) {
			const emptyN = Number((await emptyCard.locator('.trk-num').innerText()).replace('#', ''));

			// Pressing Accept opens the reason box and posts NOTHING yet. Bitten by
			// `noreasongate`, where a non-self Accept settles at a press with no box.
			forgeReqs.length = 0;
			await emptyAccept.click();
			await sleep(200);
			const askRow = col(0).locator(`.trk-card[data-prop="${emptyN}"] .trk-reason`);
			check('pressing Accept opens a reason box and posts nothing yet',
				(await askRow.count()) === 1 && forgeReqs.filter(r => r.method === 'POST').length === 0,
				`box ${await askRow.count()}, ${forgeReqs.filter(r => r.method === 'POST').length} writes`);

			// A confirm with an EMPTY reason now SETTLES — the note is optional. One write,
			// state=accepted, NO reason field. Bitten by `noemptysettle`, where empty is refused.
			forgeReqs.length = 0;
			await col(0).locator(`.trk-card[data-prop="${emptyN}"] [data-act="tracker-settle-do"]`).click();
			await sleep(500);
			const ePosted = forgeReqs.filter(r => r.method === 'POST');
			const ef = Object.fromEntries(new URLSearchParams((ePosted[0] || {}).body || ''));
			check('an empty reason SETTLES: one write, state=accepted, no reason field',
				ePosted.length === 1 && ef.state === 'accepted' && !('reason' in ef)
					&& JSON.stringify(Object.keys(ef)) === JSON.stringify(['state']),
				`${ePosted.length} writes, ${JSON.stringify(ef)}`);
			await sleep(200);
			check('the empty-reason accept moved the card to Greenlit',
				(await col(1).locator(`.trk-card[data-prop="${emptyN}"]`).count()) === 1);
		} else {
			check('pressing Accept opens a reason box and posts nothing yet', false, 'no Accept on the first Awaiting-you card');
			check('an empty reason SETTLES: one write, state=accepted, no reason field', false, 'no Accept to click');
			check('the empty-reason accept moved the card to Greenlit', false, 'no Accept to click');
		}

		// Accept on ANOTHER card WITH a filled reason: one write, state=accepted AND the reason —
		// the note is still carried where it is written.
		const reasonCard = col(0).locator('.trk-card').first();
		const acceptBtn = reasonCard.locator('.trk-settle-btn[data-which="accept"]');
		if (await acceptBtn.count()) {
			const acceptN = Number((await reasonCard.locator('.trk-num').innerText()).replace('#', ''));
			const REASON = 'clear win, shipping it';
			await acceptBtn.click();
			await sleep(200);
			await col(0).locator(`.trk-card[data-prop="${acceptN}"] .trk-reason`).fill(REASON);
			forgeReqs.length = 0;
			await col(0).locator(`.trk-card[data-prop="${acceptN}"] [data-act="tracker-settle-do"]`).click();
			await sleep(500);
			const posted = forgeReqs.filter(r => r.method === 'POST');
			check('Accept, with a reason, posts exactly one write', posted.length === 1, `${posted.length} writes`);
			const w = posted[0] || { voice: '', body: '' };
			check('the settle write carried the admin voice in x-daimond-voice', w.voice === 'mock-voice-ada', w.voice);
			const f = Object.fromEntries(new URLSearchParams(w.body));
			check('the accept write is state=accepted AND the reason, and nothing else',
				JSON.stringify(Object.keys(f).sort()) === JSON.stringify(['reason', 'state'])
					&& f.state === 'accepted' && f.reason === REASON, JSON.stringify(f));
			await sleep(200);
			const inGreen = await col(1).locator(`.trk-card[data-prop="${acceptN}"]`).count();
			check('the accepted proposal moves to Greenlit', inGreen === 1, `#${acceptN} in Greenlit: ${inGreen}`);

			// Reopen it from Greenlit: posts state=open.
			const greenCard = col(1).locator(`.trk-card[data-prop="${acceptN}"]`);
			if (await greenCard.locator('.trk-settle-btn[data-which="reopen"]').count()) {
				forgeReqs.length = 0;
				await greenCard.locator('.trk-settle-btn[data-which="reopen"]').click();
				await sleep(400);
				const rf = Object.fromEntries(new URLSearchParams((forgeReqs.filter(r => r.method === 'POST')[0] || {}).body || ''));
				check('Reopen posts state=open and no reason',
					rf.state === 'open' && !('reason' in rf), JSON.stringify(rf));
			} else {
				check('Reopen posts state=open and no reason', false, 'no Reopen offered on the Greenlit card');
			}
		} else {
			check('Accept, with a reason, posts exactly one write', false, 'no Accept to click');
			check('the settle write carried the admin voice in x-daimond-voice', false, 'no Accept to click');
			check('the accept write is state=accepted AND the reason, and nothing else', false, 'no Accept to click');
			check('the accepted proposal moves to Greenlit', false, 'no Accept to click');
			check('Reopen posts state=open and no reason', false, 'no Accept to click');
		}

		// ── 6b. A self-authored proposal skips the reason step ───────
		// A proposal raised from THIS device settles at a single press. Name one open card as
		// raised (DaimondImprove.raisedProposalNumbers), remount, and prove its Accept is a DIRECT
		// settle carrying state alone — no reason box drawn first. Bitten by `selfnoskip`.
		const selfCard = col(0).locator('.trk-card').first();
		if (await selfCard.locator('.trk-settle-btn[data-which="accept"]').count()) {
			const selfN = Number((await selfCard.locator('.trk-num').innerText()).replace('#', ''));
			await page.evaluate((n) => {
				window.__installImprove(true);
				window.DaimondImprove.raisedProposalNumbers = function () { return [n]; };
			}, selfN);
			await mount({ voice: 'mock-voice-ada' });
			const sAccept = col(0).locator(`.trk-card[data-prop="${selfN}"] .trk-settle-btn[data-which="accept"]`);
			check('a self proposal Accept is a direct settle, not a reason-box opener',
				(await sAccept.getAttribute('data-act')) === 'tracker-settle',
				await sAccept.getAttribute('data-act'));
			forgeReqs.length = 0;
			await sAccept.click();
			await sleep(500);
			const sPosted = forgeReqs.filter(r => r.method === 'POST');
			const sf = Object.fromEntries(new URLSearchParams((sPosted[0] || {}).body || ''));
			check('the self-accept posts state=accepted alone, drawing no reason box',
				sPosted.length === 1 && sf.state === 'accepted' && !('reason' in sf)
					&& (await col(0).locator(`.trk-card[data-prop="${selfN}"] .trk-reason`).count()) === 0,
				`${sPosted.length} writes, ${JSON.stringify(sf)}`);
			// Back to no-self for the sections below.
			await page.evaluate(() => window.__installImprove(true));
			await mount({ voice: 'mock-voice-ada' });
		} else {
			check('a self proposal Accept is a direct settle, not a reason-box opener', false, 'no open card to mark self');
			check('the self-accept posts state=accepted alone, drawing no reason box', false, 'no open card to mark self');
		}

			// Decline still carries a filled reason where one is written: state=declined AND reason.
			const declCard = col(0).locator('.trk-card').first();
			const declineBtn = declCard.locator('.trk-settle-btn[data-which="decline"]');
			if (await declineBtn.count()) {
				const declN = Number((await declCard.locator('.trk-num').innerText()).replace('#', ''));
				await declineBtn.click();
				await sleep(200);
				const DREASON = 'out of scope for now';
				await col(0).locator(`.trk-card[data-prop="${declN}"] .trk-reason`).fill(DREASON);
				forgeReqs.length = 0;
				await col(0).locator(`.trk-card[data-prop="${declN}"] [data-act="tracker-settle-do"]`).click();
				await sleep(500);
				const dPosted = forgeReqs.filter(r => r.method === 'POST');
				const df = Object.fromEntries(new URLSearchParams((dPosted[0] || {}).body || ''));
				check('Decline, with a reason, posts state=declined AND the reason',
					dPosted.length === 1 && df.state === 'declined' && df.reason === DREASON
						&& JSON.stringify(Object.keys(df).sort()) === JSON.stringify(['reason', 'state']),
					`${dPosted.length} writes, ${JSON.stringify(df)}`);
			} else {
				check('Decline, with a reason, posts state=declined AND the reason', false, 'no Decline on the first Awaiting-you card');
			}

		// ── 10-13. Vote and comment, re-homed to the hub ─────────────
		// The pull voice lives in the Social panel; the board CALLS its doors. Install
		// the stand-in DaimondImprove with a pull voice held, and redraw.
		await page.evaluate(() => window.__installImprove(true));
		await mount();
		const vCard = col(0).locator('.trk-card').first();
		check('with a pull voice, a card offers a live upvote', (await vCard.locator('.trk-vote-btn').count()) === 1);
		check('with a pull voice, the card shows no "set a voice" affordance', (await vCard.locator('.trk-setvoice').count()) === 0);

		const vN = Number((await vCard.locator('.trk-num').innerText()).replace('#', ''));
		const beforeFor = await page.evaluate((n) => window.DaimondTracker.proposal(n).votes.for, vN);
		forgeReqs.length = 0;
		await vCard.locator('.trk-vote-btn').click();
		await sleep(400);
		const postV = forgeReqs.filter(r => r.method === 'POST');
		check('the upvote posts exactly one write', postV.length === 1, `${postV.length}`);
		check('the upvote carried the PULL voice, not the admin one', (postV[0] || {}).voice === 'mock-voice-grace', (postV[0] || {}).voice);
		check('the upvote body is d=1 and nothing else', (postV[0] || {}).body === 'd=1', (postV[0] || {}).body);
		const afterFor = await page.evaluate((n) => window.DaimondTracker.proposal(n).votes.for, vN);
		check('the shown for-count increments by one', afterFor === beforeFor + 1, `${beforeFor} -> ${afterFor}`);
		check('the upvote reads pressed after casting', (await col(0).locator(`.trk-card[data-prop="${vN}"] .trk-vote-btn.on`).count()) === 1);

		// Pressing the cast upvote again withdraws it: d=0, and the count falls back.
		forgeReqs.length = 0;
		await col(0).locator(`.trk-card[data-prop="${vN}"] .trk-vote-btn`).click();
		await sleep(400);
		const wBody = (forgeReqs.filter(r => r.method === 'POST')[0] || {}).body;
		check('pressing an upvote already cast withdraws it (d=0)', wBody === 'd=0', String(wBody));
		const backFor = await page.evaluate((n) => window.DaimondTracker.proposal(n).votes.for, vN);
		check('the for-count falls back after a withdrawal', backFor === beforeFor, `${backFor}`);

		// Comment, in the opened card where the thread is read.
		const cCard = col(0).locator('.trk-card').first();
		const cN = Number((await cCard.locator('.trk-num').innerText()).replace('#', ''));
		await cCard.locator('.trk-title').click();
		await sleep(500);
		check('the opened card offers a reply box with a pull voice', (await page.locator(`#trk .trk-reply[data-prop="${cN}"]`).count()) === 1);
		const commentsBefore = await page.locator('#trk .trk-comment').count();
		const SAYTEXT = 'the dark-mode grey needs this too';
		await page.locator(`#trk .trk-reply[data-prop="${cN}"]`).fill(SAYTEXT);
		forgeReqs.length = 0;
		await page.locator(`#trk [data-act="tracker-comment"][data-prop="${cN}"]`).click();
		await sleep(500);
		const postC = forgeReqs.filter(r => r.method === 'POST');
		check('the comment posts exactly one write', postC.length === 1, `${postC.length}`);
		check('the comment carried the pull voice', (postC[0] || {}).voice === 'mock-voice-grace', (postC[0] || {}).voice);
		const cf = Object.fromEntries(new URLSearchParams((postC[0] || {}).body || ''));
		check('the comment body is the said field alone', JSON.stringify(Object.keys(cf).sort()) === JSON.stringify(['said']) && cf.said === SAYTEXT, JSON.stringify(cf));
		const commentsAfter = await page.locator('#trk .trk-comment').count();
		check('the posted comment appears in the thread', commentsAfter === commentsBefore + 1, `${commentsBefore} -> ${commentsAfter}`);
		check('the posted comment text is shown', (await page.locator('#trk .trk-comment-said').allInnerTexts()).some(s => s.includes(SAYTEXT)));
		await page.locator('#trk .trk-back').click();
		await sleep(200);

		// With NO pull voice: the affordance, never a control that would 500.
		await page.evaluate(() => window.__installImprove(false));
		await mount();
		const nCard = col(0).locator('.trk-card').first();
		check('with no pull voice, a card shows the set-a-voice affordance, not a live upvote',
			(await nCard.locator('.trk-setvoice').count()) === 1 && (await nCard.locator('.trk-vote-btn').count()) === 0);
		check('with no pull voice, the vote count is still shown', (await nCard.locator('.trk-vote-count').count()) === 1);
		const nN = Number((await nCard.locator('.trk-num').innerText()).replace('#', ''));
		await nCard.locator('.trk-title').click();
		await sleep(400);
		check('with no pull voice, the opened card shows the say affordance, not a reply box',
			(await page.locator('#trk .trk-say-novoice').count()) === 1 && (await page.locator(`#trk .trk-reply`).count()) === 0);
		check('reading votes and comments needed no voice at all', forgeReqs.filter(r => r.method === 'GET' && r.voice).length === 0);
		await page.evaluate(() => { try { delete window.DaimondImprove; } catch (e) { window.DaimondImprove = undefined; } });

		// ── 9. All / Mine filter ─────────────────────────────────────
		// "Mine" is the proposals THIS DEVICE raised. The local voice has no name, so
		// Mine cannot be an author match; it is a match against the numbers the capture
		// surface (js/improve.js) publishes as DaimondImprove.raisedProposalNumbers().
		// The harness has no capture surface by default, which is the empty-state path.
		await page.evaluate(() => { try { delete window.DaimondImprove; } catch (e) { window.DaimondImprove = undefined; } });
		await mount();
		check('the board draws an All / Mine filter', (await page.locator('#trk .trk-filter').count()) === 1);
		check('the filter defaults to All',
			(await page.locator('#trk .trk-filter-btn[data-filter="all"].on').count()) === 1
			&& (await page.locator('#trk .trk-filter-btn[data-filter="mine"].on').count()) === 0);
		const allNums = (await page.locator('#trk .trk-board .trk-num').allInnerTexts()).map(s => Number(s.replace('#', '')));
		check('All shows every loaded proposal', allNums.length === 12, `${allNums.length} cards`);

		// Mine with NO capture surface: the empty state, no cards, and no throw.
		await page.locator('#trk .trk-filter-btn[data-filter="mine"]').click();
		await sleep(150);
		check('Mine, with no capture surface, shows the "nothing raised" state', (await page.locator('#trk .trk-mine-empty').count()) === 1);
		check('Mine, with no capture surface, shows no cards', (await page.locator('#trk .trk-card').count()) === 0);

		// A capture surface that raised two specific proposals: Mine shows exactly those.
		const raised = [allNums[0], allNums[5]].sort((a, b) => a - b);
		await page.evaluate((nums) => { window.DaimondImprove = { raisedProposalNumbers: () => nums.slice() }; }, raised);
		await page.locator('#trk .trk-filter-btn[data-filter="all"]').click();		// force a redraw off Mine
		await sleep(120);
		await page.locator('#trk .trk-filter-btn[data-filter="mine"]').click();
		await sleep(150);
		const mineNums = (await page.locator('#trk .trk-board .trk-num').allInnerTexts()).map(s => Number(s.replace('#', ''))).sort((a, b) => a - b);
		check('Mine shows ONLY the proposals this device raised', JSON.stringify(mineNums) === JSON.stringify(raised),
			`shown ${JSON.stringify(mineNums)} vs raised ${JSON.stringify(raised)}`);
		check('Mine drew those cards, not the empty state',
			(await page.locator('#trk .trk-mine-empty').count()) === 0 && mineNums.length === raised.length);

		// All restores the whole board.
		await page.locator('#trk .trk-filter-btn[data-filter="all"]').click();
		await sleep(120);
		const backNums = (await page.locator('#trk .trk-board .trk-num').allInnerTexts()).map(s => Number(s.replace('#', '')));
		check('All restores every proposal', backNums.length === allNums.length, `${backNums.length} vs ${allNums.length}`);
		await page.evaluate(() => { try { delete window.DaimondImprove; } catch (e) { window.DaimondImprove = undefined; } });

		// ── 8b. A refusal is said ────────────────────────────────────
		await mount({ repo: '_absent' });
		const err = await page.locator('#trk .trk-err').count();
		check('a repository that is not available draws the refusal sentence', err === 1);
		if (err) {
			const said = (await page.locator('#trk .trk-err').innerText()).trim();
			check('the refusal sentence is non-empty', said.length > 0, said);
		} else {
			check('the refusal sentence is non-empty', false, 'no refusal drawn');
		}

		// ── 14. A RE-SHOWN BOARD REFETCHES A CROSS-DEVICE DECLINE ────
		// A proposal open under "Awaiting you" is declined ON THE FORGE by another device -- a
		// settle the board never made. A re-show past the REFRESH_MS throttle must refetch and move
		// it to "Dropped"; the old freeze (a one-shot observer and a read-once guard) left declines
		// made elsewhere sitting in "Awaiting you". Proved red by `--break freeze`.
		await mount();
		const declineN = Number((await col(0).locator('.trk-card').first().locator('.trk-num').innerText()).replace('#', ''));
		check('a proposal is awaiting the owner before the cross-device decline',
			(await col(0).locator(`.trk-card[data-prop="${declineN}"]`).count()) === 1, `#${declineN}`);
		const declStatus = await declineOnForge(declineN);
		check('the cross-device decline reached the forge', declStatus === 200, `status ${declStatus}`);
		// Wait out the throttle (REFRESH_MS is 4s), then re-show the way a person returning to the
		// panel does. The board must refetch, not serve its frozen snapshot.
		await sleep(4200);
		forgeReqs.length = 0;
		await page.evaluate(() => window.DaimondTracker.onOpen());
		await sleep(700);
		check('the re-show refetched the listing (a network read fired)',
			forgeReqs.filter(r => r.method === 'GET').length >= 1,
			`${forgeReqs.filter(r => r.method === 'GET').length} GET(s)`);
		check('after a cross-device decline, the re-shown board moves it to Dropped',
			(await col(3).locator(`.trk-card[data-prop="${declineN}"]`).count()) === 1,
			`#${declineN} in Dropped: ${await col(3).locator(`.trk-card[data-prop="${declineN}"]`).count()}`);
		check('and the declined proposal is gone from Awaiting you',
			(await col(0).locator(`.trk-card[data-prop="${declineN}"]`).count()) === 0,
			`#${declineN} still awaiting: ${await col(0).locator(`.trk-card[data-prop="${declineN}"]`).count()}`);

		// ── 15. A FAILED READ STAMPS THE THROTTLE (bounded refetch) ──
		// The board reads once successfully, the forge then errors, and two rapid re-shows past the
		// stale point must fire EXACTLY ONE network read -- the second throttled by the `_lastLoad`
		// the failed read stamped. Without that stamp a down forge is refetched on every re-show.
		// Proved red by `--break nothrottlefail`.
		await mount();				// a clean, successful first read: `read` is now true
		failReads = true;			// the forge now errors on every listing read
		await sleep(4200);			// let the snapshot go stale
		forgeReqs.length = 0;
		await page.evaluate(() => window.DaimondTracker.onOpen());	// stale -> load -> fails, stamps the throttle
		await sleep(400);
		await page.evaluate(() => window.DaimondTracker.onOpen());	// within 4s of the failure -> throttled, no read
		await sleep(400);
		const failReadCount = forgeReqs.filter(r => r.method === 'GET').length;
		check('a failed read stamps the throttle: two rapid re-shows against a down forge fire ONE read, not two',
			failReadCount === 1, `${failReadCount} GET(s)`);
		failReads = false;

		check('no page errors were thrown', errs.length === 0, errs.join(' | '));
	} finally {
		await browser.close();
		stopMock();
	}
}

await run();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
