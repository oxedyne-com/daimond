// verify_improve.mjs — the Improve panel keeps its one promise.
//
// `dev/IMPROVE_CONTRACT.md` §4 states it in a sentence:
//
//   A NOTE LEAVES THIS DEVICE ONLY WHEN A PERSON PRESSES SEND ON THAT ONE
//   NOTE, AND WHAT LEAVES IS EXACTLY THE CHARACTERS ON THE SCREEN AT THAT
//   MOMENT. A vote is two integers and may queue, because two integers cannot
//   carry anything.
//
// Every clause of that is a check here, and every check is COUNTED AT THE
// NETWORK — `page.route` sits between the page and the server, so a request
// that was never made and a request that was merely hidden look different.
//
//   1. WRITING IS NOT SENDING, AND NEITHER IS KEEP. Both halves are asked, and
//      the second is the one that matters: a check that only ever proves
//      silence passes with the feature entirely absent. So Send is pressed
//      afterwards and the request DOES leave.
//
//   2. WHAT LEFT IS WHAT YOU READ. The body of the note request is compared,
//      character for character, against the box's value and the visible line
//      in the "What goes with it" row. Not "the body contains the note": a
//      body that contains the note and a hidden field passes that.
//
//   3. CLOSING THE ROW TAKES THE LINE OFF THE WIRE, not merely off the screen.
//
//   4. A NOTE THAT COULD NOT BE SENT IS KEPT, SAYS SO, AND IS NEVER RETRIED.
//      The retry half is the one worth the seconds: a queue of text outlives
//      the consent that filled it.
//
//   5. THE WORDS APPEAR IN EXACTLY ONE REQUEST IN THE WHOLE SESSION. Every
//      request the page makes is read, whatever its address — telemetry, sync,
//      a beacon, an image. One carries the note; nothing else carries a
//      syllable of it.
//
//   6. A VOTE IS INTEGERS ONLY. Asserted on the parsed body's KEYS and values,
//      so a title smuggled into a fifth field fails even though the four
//      integers are all correct.
//
//   7. AND A VOTE THAT COULD NOT BE DELIVERED IS KEPT AND GOES LATER — the
//      asymmetry with 4, asserted rather than assumed, because the two rules
//      are only defensible as a pair.
//
//   8. A PROPOSAL ROW SAYS ITS OWN STATE AND ITS OWN TALLY. By NAME: the row
//      for "Name the Everything row's closer" reads Being done and 12, not
//      "there are three rows".
//
//   9. THE PANEL'S WORDS ARE THE GUIDE'S WORDS. `www/guide/improve.html` is
//      the only contract this panel was handed, so it is checked mechanically:
//      every `<span class="ui">` label in its §"The Improve panel" must be
//      visible text in the running panel, and every part-noun that section
//      sets in bold must be one of the terms the glossary above it defines.
//
// THE SEAM IS APPLIED BY THIS FILE. The panel's markup lives in
// `www/index.html`, which the lane that built this does not own, so the exact
// edit it asked for is served through `page.route` here. That means the seam
// text is verified too: get it wrong and every check below fails. Once the
// edit is in the file on disk, this file notices and serves it unchanged.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file and the run is expected to FAIL.
// A break that does not apply cleanly aborts rather than passing quietly.
//
//   node dev/verify_improve.mjs --break keepsends      # 1 fails: Keep sends
//   node dev/verify_improve.mjs --break hidden         # 2 fails: a line the user never saw
//   node dev/verify_improve.mjs --break stickycontext  # 3 fails: closed, and still sent
//   node dev/verify_improve.mjs --break retry          # 4 fails: a failed note is retried
//   node dev/verify_improve.mjs --break leak           # 5 fails: the words go somewhere else too
//   node dev/verify_improve.mjs --break votetext       # 6 fails: a vote carries a title
//   node dev/verify_improve.mjs --break votedrop       # 7 fails: an undelivered vote is forgotten
//   node dev/verify_improve.mjs --break flatstate      # 8 fails: every proposal drawn Open
//   node dev/verify_improve.mjs --break closeonvote    # 8 fails: voting shuts what you were reading
//   node dev/verify_improve.mjs --break renamechip     # 9 fails: the panel and the guide disagree
//   node dev/verify_improve.mjs                        # and then, clean
//
//   eval "$(bash dev/world.sh 12 --up)"
//   node dev/verify_improve.mjs
//
// Needs dev/serve.mjs only. No gateway: every route it touches is stubbed here,
// and everything below the stub — the panel, the store, the guide — is real.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const WWW   = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'improve' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The seam ─────────────────────────────────────────────────────────
//
// The three edits `www/index.html` needs, written out so that the lane that
// owns that file can paste them and so that this run proves them. Applied the
// same way a break is, through `page.route`.

const PANEL_MARKUP = `
		<!-- Improve: where a note about Daimond is written, and where the
		     proposals made from notes are read and voted on. A note stays on
		     this device until somebody presses Send on that one note, and what
		     leaves is exactly the characters on the screen. See js/improve.js
		     and dev/IMPROVE_CONTRACT.md. -->
		<aside class="panel improve" id="panel-improve" data-panel="improve" data-zone="dock" data-label="Improve" data-i18n-label="panel.improve">
			<div class="railhead"><span role="heading" aria-level="2" data-i18n="panel.improve">Improve</span>
				<span class="imp-chips">
					<button type="button" class="imp-chip on" data-view="notes" aria-pressed="true" data-i18n="improve.notes">Notes</button>
					<button type="button" class="imp-chip" data-view="proposals" aria-pressed="false" data-i18n="improve.proposals">Proposals</button>
					<button class="addbtn panel-close" data-close="improve" title="Close panel" data-i18n-title="common.close_panel">
						<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
					</button>
				</span>
			</div>

			<div class="imp-view" id="improve-notes">
				<div class="imp-write">
					<textarea class="imp-box" id="improve-box" rows="4"
						placeholder="Where it is, what you expected, and what happened instead."
						data-i18n-placeholder="improve.box_ph"
						aria-label="Write a note about Daimond" data-i18n-aria-label="improve.box_label"></textarea>
					<!-- What goes with the note, in the exact characters that will
					     travel, in a row with a closer on it. Closing it takes the
					     line off the wire as well as off the screen. -->
					<div class="imp-with" id="improve-with" hidden>
						<div class="imp-with-body">
							<span class="imp-with-label" data-i18n="improve.with">What goes with it</span>
							<div class="imp-with-text" id="improve-with-text"></div>
						</div>
						<button type="button" class="ui-close imp-with-off" data-act="improve-with-off"
							title="Close" data-i18n-title="common.close"
							aria-label="Take the details off this note" data-i18n-aria-label="improve.with_off"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
					</div>
					<div class="imp-acts" id="improve-acts">
						<button type="button" class="imp-keep" data-act="improve-keep" data-i18n="improve.keep"
							title="Store this note on this device. Nothing is sent." data-i18n-title="improve.keep_help">Keep</button>
						<button type="button" class="imp-send" data-act="improve-send" data-i18n="improve.send"
							title="Send exactly what is above to Oxedyne. Nothing else goes with it." data-i18n-title="improve.send_help">Send</button>
						<span class="imp-as" id="improve-as"></span>
					</div>
					<div class="imp-say" id="improve-say" role="status" aria-live="polite"></div>
				</div>
				<div class="imp-notes" id="improve-list"></div>
			</div>

			<div class="imp-view" id="improve-props-view" hidden>
				<div class="imp-asat" id="improve-asat"></div>
				<div class="imp-props" id="improve-props"></div>
			</div>
		</aside>
`;

// The strings, which must land WITH the markup: a `data-i18n` mark whose key is
// not in the table paints the KEY on the screen, so a panel shipped ahead of its
// catalogue reads "improve.notes" on its own chip. Verified here for that reason
// and not merely for tidiness.
const I18N_BLOCK = `
	// ── The Improve panel ──────────────────────────────────────
	// Where a note about Daimond is written, and where the proposals made from
	// notes are read and voted on. See js/improve.js and dev/IMPROVE_CONTRACT.md.
	'panel.improve':        'Improve',
	'improve.notes':        'Notes',
	'improve.proposals':    'Proposals',
	'improve.box_label':    'Write a note about Daimond',
	'improve.box_ph':       'Where it is, what you expected, and what happened instead.',
	'improve.with':         'What goes with it',
	'improve.with_off':     'Take the details off this note',
	'improve.keep':         'Keep',
	'improve.keep_help':    'Store this note on this device. Nothing is sent.',
	'improve.send':         'Send',
	'improve.send_help':    'Send exactly what is above to Oxedyne. Nothing else goes with it.',
	'improve.as':           'Goes as @{handle}',
	'improve.as_none':      'You have no account, so a note can only be kept here.',
	'improve.nothing':      'Write something first.',
	'improve.not_sent':     'It could not be sent, so it is kept here. Nothing has gone anywhere.',
	'improve.copied':       'Copied.',
	'improve.state_kept':   'Kept here',
	'improve.state_sent':   'Sent {date}',
	'improve.drop':         'Delete this note',
	'improve.drop_ask':     'Delete this note? It is only on this device, so there is no other copy.',
	'improve.drop_ok':      'Delete',
	'improve.no_notes':     'No notes yet.',
	// The one line that goes with a note, in the characters it travels as.
	'improve.ctx_build':    'Build {id}',
	'improve.ctx_touch':    'touch',
	'improve.ctx_pointer':  'pointer',
	'improve.ctx_palette':  'palette {name}',
	'improve.ctx_panels':   'panels open: {list}',
	'improve.no_props':     'No proposals yet. They are made from notes, and they arrive with a new build.',
	'improve.as_at':        'Counts as at build {build}. They move when Daimond updates.',
	'improve.as_at_none':   'Counts move when Daimond updates.',
	'improve.state_open':   'Open',
	'improve.state_taken':  'Being done',
	'improve.state_done':   'Done',
	'improve.state_declined': 'Declined',
	'improve.shipped_in':   'Shipped in build {build}',
	'improve.from_notes.one':   'From {n} note',
	'improve.from_notes.other': 'From {n} notes',
	'improve.tally':        '{yes} for, {no} against',
	'improve.do':           'Do this',
	'improve.not':          'Not this',
	'improve.vote_held':    'Your vote is here and has not been counted yet.',
`;

const SEAM = [
	// On a phone a dock panel is only reachable if it is a GUEST — something
	// that rises over the chat as a sheet. Without this the Improve panel exists
	// on a desktop and nowhere else, which for a panel about reporting faults
	// would leave out every reader most likely to meet one.
	//
	// Matched by SHAPE rather than by its exact text: that table is edited
	// often, and was reformatted from one line to three while this file was
	// being written. An anchor on the literal line would have made this
	// verifier fail for a reason that has nothing to do with the panel.
	{
		file: 'js/daimond.js',
		re:   /(var MOBILE_GUESTS = \{[\s\S]*?)(\n\t\};)/,
		with: '$1\n\t\timprove: 1,$2',
		want: 'improve: 1,',
	},
	// And the sheet's "ask about this" pill is not offered on it. The panel is
	// already the place you write in; a second box under it, which sends what
	// you write to a model, is two boxes with opposite meanings.
	{
		file: 'js/mobile.js',
		find: "\tvar NO_ASK       = { compose: 1, tools: 1, trash: 1 };",
		with: "\tvar NO_ASK       = { compose: 1, tools: 1, trash: 1, improve: 1 };",
	},
	// Same story as the three below: the catalogue has carried these keys since
	// 2026-08-12, so re-inserting the block gave the served `en.js` TWO of every
	// `improve.*` key. Nothing here noticed -- a duplicate literal later in an
	// object simply wins -- but `--break renamechip` anchors on one of them and
	// refused to apply, because its anchor now appeared twice. A break that
	// cannot apply is a check that proves nothing, so this one had quietly
	// stopped being provable.
	{
		file: 'i18n/en.js',
		find: "\t'panel.trash': 'Trash',",
		with: "\t'panel.trash': 'Trash',\n" + I18N_BLOCK,
		want: "'panel.improve':",
	},
	// The three index.html seams, each with a `want` naming the ONE THING it is
	// there to ensure, for the same reason the mobile-guests seam has one.
	//
	// `www/index.html` gained all three on 2026-08-12, so from then on the seam
	// should have been a no-op. It was, while the panel's markup still matched
	// `PANEL_MARKUP` byte for byte -- and on 2026-08-14 an "i" button was added
	// to the panel's chip row. The default `already` is the whole replacement
	// text, so the comparison failed, the seam fired against a file that already
	// had the panel, and THE PAGE WAS SERVED WITH TWO `#panel-improve` ELEMENTS:
	// the count check went red, `#improve-with` matched twice and Playwright's
	// strict mode threw. None of that was about the Improve panel, which is the
	// definition of the wrong red. A `want` asks whether the thing is there,
	// which stays true however the panel is later dressed.
	{
		file: 'index.html',
		find: '<link rel="stylesheet" href="css/trash.css">',
		with: '<link rel="stylesheet" href="css/trash.css">\n<link rel="stylesheet" href="css/improve.css">',
		want: 'href="css/improve.css"',
	},
	{
		file: 'index.html',
		find: '<script src="js/trash.js"></script>',
		with: '<script src="js/trash.js"></script>\n<script src="js/improve.js"></script>',
		want: '<script src="js/improve.js"></script>',
	},
	{
		file: 'index.html',
		find: '\t\t\t<div class="trash-list arte-list" id="trash-list"></div>\n\t\t</aside>\n',
		with: '\t\t\t<div class="trash-list arte-list" id="trash-list"></div>\n\t\t</aside>\n' + PANEL_MARKUP,
		want: 'id="panel-improve"',
	},
];

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must appear
// exactly once: a break that silently matched nothing would leave the suite
// green against working code and prove the opposite of what it claims.
const BREAKS = {
	// Keep reaches the network. The panel would look identical.
	keepsends: [{
		file: 'js/improve.js',
		find: '\t\tvar rec = store(text, 0);\n\t\tclearBox();\n\t\trender();\n\t\treturn rec;\n\t}',
		with: '\t\tvar rec = store(text, 0);\n\t\tclearBox();\n\t\trender();\n\t\tpost(text);\n\t\treturn rec;\n\t}',
	}],
	// One line appended that was never on the screen. The note is all there, so
	// a check that asked whether the body CONTAINS the note would pass.
	hidden: [{
		file: 'js/improve.js',
		find: '\t\treturn ctx ? (body + \'\\n\\n\' + ctx) : body;',
		with: '\t\treturn (ctx ? (body + \'\\n\\n\' + ctx) : body) + \'\\n\\nseen: \' + navigator.userAgent;',
	}],
	// The row is closed, and the line goes anyway: off the screen, on the wire.
	stickycontext: [{
		file: 'js/improve.js',
		find: '\t\tif (contextOff()) return body;',
		with: '\t\tif (contextOff() && false) return body;',
	}],
	// A failed note is queued and tried again. This is the failure the whole
	// design refuses, and it is invisible from the panel.
	retry: [{
		file: 'js/improve.js',
		find: '\t\telse flash(tOr(\'improve.not_sent\', \'It could not be sent, so it is kept here. Nothing has gone anywhere.\'));\n\t\trender();\n\t\treturn rec;',
		with: '\t\telse { flash(tOr(\'improve.not_sent\', \'It could not be sent, so it is kept here. Nothing has gone anywhere.\')); setTimeout(function () { post(text); }, 1200); }\n\t\trender();\n\t\treturn rec;',
	}],
	// The words go somewhere else as well. Everything about the note request
	// stays correct, so checks 1 to 4 all still pass.
	leak: [{
		file: 'js/improve.js',
		find: '\t\t\t\tbody:        text,\n\t\t\t});',
		with: '\t\t\t\tbody:        text,\n\t\t\t});\n\t\t\ttry { fetch(\'/api/telemetry\', { method: \'POST\', body: JSON.stringify({ e: text }) }); } catch (e) {}',
	}],
	// A vote carries the proposal's title, "for the operator's convenience".
	votetext: [{
		file: 'js/improve.js',
		find: '\t\t\t\tvar body = { v: 1, b: buildOrdinal(_build), p: Number(k), d: s.votes[k].d };\n\t\t\t\tif (!onlyIntegers(body)) continue;',
		with: '\t\t\t\tvar body = { v: 1, b: buildOrdinal(_build), p: Number(k), d: s.votes[k].d };\n\t\t\t\tvar found = (_props || []).find(function (x) { return x.id === Number(k); });\n\t\t\t\tbody.title = found ? found.title : \'\';',
	}],
	// An undelivered vote is forgotten rather than kept — the asymmetry with a
	// note collapses, and a vote made offline is silently lost.
	votedrop: [{
		file: 'js/improve.js',
		find: '\t\t\t\tif (!ok) break;\t\t\t\t\t\t\t// no gateway; the rest wait too\n\t\t\t\ts.votes[k].sent = 1;',
		with: '\t\t\t\ts.votes[k].sent = 1;',
	}],
	// Every proposal drawn Open, whatever it says. The list is the right length
	// and every title is right.
	flatstate: [{
		file: 'js/improve.js',
		find: '\t\t\tstate: STATES[p.state] ? p.state : \'open\',',
		with: '\t\t\tstate: \'open\',',
	}],
	// Voting closes the proposal you were reading — the answer vanishing along
	// with the question. This is what the first build of the panel did.
	closeonvote: [{
		file: 'js/improve.js',
		find: '\t\t\tbody.hidden = !wasOpen[String(p.id)];',
		with: '\t\t\tbody.hidden = true;',
	}],
	// The panel calls its first chip something the guide does not. Broken in the
	// CATALOGUE and not in the markup, because the markup's English is only a
	// fallback: `data-i18n` paints the table's word over it on the first apply,
	// so a renaming that reached the screen is a renaming of the string. (The
	// first draft of this break edited the markup, and the panel dutifully put
	// "Notes" back — proving the break rather than the check.)
	renamechip: [{
		file: 'i18n/en.js',
		find: "\t'improve.notes':        'Notes',",
		with: "\t'improve.notes':        'Feedback',",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Apply one edit to a source file, or stop. Nothing is served that was not
/// verified to differ from what it started as.
///
/// A spec anchors either on a literal (`find`) or on a shape (`re`), and either
/// way the anchor must match EXACTLY ONCE: an edit that silently matched
/// nothing would leave the run green against unmodified code and prove the
/// opposite of what it claims.
function edit(src, spec, what) {
	if (spec.re) {
		const all = src.match(new RegExp(spec.re.source, spec.re.flags.replace('g', '') + 'g'));
		const n = all ? all.length : 0;
		if (n !== 1) {
			console.error(`${what}: the shape ${spec.re} matches ${n} time(s) in ${spec.file}, `
				+ 'so nothing was changed and the run below would prove nothing.');
			process.exit(2);
		}
		return src.replace(spec.re, spec.with);
	}
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`${what}: the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The file as it should be served: the seam applied if it is not already in
/// the file on disk, then this run's break on top of it.
const FILES = new Map();		// path under www/ -> the text to serve

function build() {
	for (const spec of SEAM) {
		const p = spec.file;
		let src = FILES.get(p) ?? fs.readFileSync(path.join(WWW, p), 'utf8');
		// Already in the file on disk: the lane that owns it has applied the
		// seam, and it is served unchanged from here on.
		const already = spec.want || (spec.re ? null : spec.with);
		if (already && src.includes(already)) { FILES.set(p, src); continue; }
		FILES.set(p, edit(src, spec, 'seam'));
	}
	if (!BREAK) return;
	for (const spec of BREAKS[BREAK]) {
		const p = spec.file;
		const src = FILES.get(p) ?? fs.readFileSync(path.join(WWW, p), 'utf8');
		FILES.set(p, edit(src, spec, `break '${BREAK}'`));
	}
}
build();

// ── The fixture proposals ────────────────────────────────────────────
//
// `www/assets/proposals.json` ships EMPTY, because nothing in it may be
// invented: a proposal is made from real notes and there are none yet. So the
// list the panel reads is served here, and the checks name its rows.

const FIXTURE = {
	v: 1,
	built: 'aa11bb22cc33',
	proposals: [
		{ id: 3,  state: 'open',     title: 'Name the closer on every row',
		  body: 'Several rows carry a closer whose spoken name is only "Close".',
		  from: 4, yes: 21, no: 2,  build: '' },
		{ id: 7,  state: 'taken',    title: 'A light on the Everything row that reads amber',
		  body: 'Partly paused shows green on one palette.',
		  from: 2, yes: 12, no: 0,  build: '' },
		{ id: 11, state: 'done',     title: 'The spend row hides itself while nothing has been spent',
		  body: 'It showed three zeroes on a first run.',
		  from: 1, yes: 5,  no: 0,  build: 'dd7cfef8fe27' },
		{ id: 12, state: 'declined', title: 'Put the chip row down the side',
		  body: 'Declined: the row is the one surface every panel is reached from.',
		  from: 1, yes: 1,  no: 9,  build: '' },
	],
};

// ── The stubbed gateway ──────────────────────────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

/// EVERY request the page made, whatever its address. Check 5 reads all of it.
const wire = [];
/// The note posts, in order, with their exact bodies.
const notes = [];
/// The vote posts, in order, with their parsed bodies.
const votes = [];

let noteAnswer = 200;			// what /api/note replies with, changed per check
let voteAnswer = 200;

async function stub(page) {
	for (const [p, body] of FILES) {
		const type = p.endsWith('.html') ? 'text/html' : 'application/javascript';
		await page.route('**/' + p, r => r.fulfill({ status: 200, contentType: type, body }));
	}
	// The bare app URL serves index.html too, and `**/index.html` does not match
	// a request for `/`. The predicate takes a URL object, not a string.
	if (FILES.has('index.html')) {
		await page.route(u => u.pathname === '/' || u.pathname === '/index.html',
			r => r.fulfill({ status: 200, contentType: 'text/html', body: FILES.get('index.html') }));
	}

	// Every request, recorded before anything else answers it. This is what
	// check 5 reads, and it is deliberately blind to the address.
	page.on('request', req => {
		let body = '';
		try { body = req.postData() || ''; } catch (e) { body = ''; }
		wire.push({ url: req.url(), method: req.method(), body });
	});

	await page.route('**/proposals.json', r => r.fulfill(json(FIXTURE)));

	await page.route('**/api/note', r => {
		notes.push({ body: r.request().postData() || '', at: Date.now() });
		return r.fulfill(noteAnswer === 200
			? json({ ok: true })
			: { status: noteAnswer, contentType: 'application/json', headers: CORS, body: '{"ok":false}' });
	});
	await page.route('**/api/vote', r => {
		let b = null;
		try { b = JSON.parse(r.request().postData() || 'null'); } catch (e) { b = null; }
		votes.push({ body: b, raw: r.request().postData() || '', at: Date.now() });
		return r.fulfill(voteAnswer === 200
			? json({ ok: true })
			: { status: voteAnswer, contentType: 'application/json', headers: CORS, body: '{"ok":false}' });
	});
	await page.route('**/api/telemetry', r => r.fulfill(json({ ok: true })));

	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-imp', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: false, currency: 'usd' })));
}

// ── The guide, read as the contract it is ────────────────────────────
//
// Both harvests are from `www/guide/improve.html` itself, never from a list
// copied into this file: a list here would go stale the moment somebody edited
// the page, and would then be checking this file against itself.

const GUIDE = fs.readFileSync(path.join(WWW, 'guide', 'improve.html'), 'utf8');

/// The section the panel has to answer to.
function guideSection() {
	const i = GUIDE.indexOf('<section id="improve-panel">');
	const j = GUIDE.indexOf('</section>', i);
	if (i === -1 || j === -1) {
		console.error('the guide has no §"The Improve panel"; check 9 would prove nothing.');
		process.exit(2);
	}
	return GUIDE.slice(i, j);
}

/// The terms the glossary above it defines, from their own `id="term-…"`.
function glossaryTerms() {
	const out = new Set();
	for (const m of GUIDE.matchAll(/id="term-([a-z-]+)"/g)) out.add(m[1].replace(/-/g, ' '));
	// The four regions and the words the page names in prose rather than in a
	// glossary card, taken from the sentence that introduces them.
	['top bar', 'rail', 'stage', 'dock', 'panel', 'crystal', 'daimon', 'worker',
		'note box', 'proposal', 'chip row'].forEach(w => out.add(w));
	return out;
}

const SECTION = guideSection();
const TERMS   = glossaryTerms();

/// Every app label the section names, in the page's own `<span class="ui">`
/// convention. These must be readable in the panel.
const GUIDE_LABELS = [...new Set(
	[...SECTION.matchAll(/<span class="ui">([^<]+)<\/span>/g)].map(m => m[1].trim()))];

/// Every part-noun the section sets in bold. These must be glossary terms.
const GUIDE_NOUNS = [...new Set(
	[...SECTION.matchAll(/<strong>([^<]+)<\/strong>/g)]
		.map(m => m[1].trim().replace(/\.$/, ''))
		// A bold lead-in to a paragraph is a sentence, not a part. A part-noun
		// is one or two words; anything longer is prose and is not claiming to
		// name a control.
		.filter(s => s.split(/\s+/).length <= 2))];

// ── Driving ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// `route` is applied BEFORE the first navigation, which is the whole reason it
// is an option of `open` rather than something a caller does afterwards: the
// seam has to be in the document the browser parses.
const s = await open({ name: 'improve', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'improve');
await page.waitForTimeout(1500);

try {
	// A handle, because a note goes as the account and the panel refuses to
	// send without one. Written the way the gateway writes it: verbatim, stamp
	// and all, through the one function that takes the server's answer.
	await page.evaluate(() => {
		window.DaimondIdentity.setHandle({ h: 'tester', t: 1754870000 });
	});

	await page.evaluate(() => {
		window.DaimondPanels.show('improve');
		if (window.DaimondImprove) window.DaimondImprove.onOpen();
	});
	await page.waitForTimeout(800);

	// EXACTLY one. Two is its own defect and not a near miss: every `#improve-*`
	// id is then ambiguous, Playwright's strict mode throws on the first one it
	// reaches, and the stack that comes back says nothing about the panel. The
	// count is printed so that a red names the shape it found.
	const panel = page.locator('#panel-improve');
	const panels = await panel.count();
	check('the panel is on screen, exactly once', panels === 1, `${panels} found`);

	// ── 1. Writing is not sending, and neither is Keep ───────────
	const NOTE_1 = 'The closer on the Everything row put the whole rail away. '
		+ 'I expected it to close that row. quokka-marker-one';

	await page.fill('#improve-box', NOTE_1);
	await page.waitForTimeout(700);
	check('writing a note sends nothing', notes.length === 0,
		`${notes.length} request(s) left the page`);

	await page.click('.imp-keep');
	await page.waitForTimeout(700);
	check('and Keep sends nothing either', notes.length === 0,
		`${notes.length} request(s) left the page`);

	const kept = await page.locator('.imp-note .imp-note-state[data-state="kept"]').first().innerText();
	check('the kept note says it is only here', /kept here/i.test(kept), kept);

	// ── 2. What left is what you read ────────────────────────────
	const NOTE_2 = 'The Diamonds chip in the chip row does not fill when the panel '
		+ 'opens. quokka-marker-two';
	await page.fill('#improve-box', NOTE_2);
	await page.waitForTimeout(500);

	// Read the screen BEFORE pressing, because pressing clears the box. This is
	// the oracle: two strings the user could have read off the panel.
	const onScreen = await page.evaluate(() => {
		const box = document.getElementById('improve-box');
		const row = document.getElementById('improve-with');
		const line = document.getElementById('improve-with-text');
		return {
			box:  box ? box.value.trim() : '',
			ctx:  (row && !row.hidden) ? (line ? line.textContent.trim() : '') : '',
			shown: !!(row && !row.hidden),
		};
	});
	check('the row saying what goes with the note is on screen and says something',
		onScreen.shown && onScreen.ctx.length > 10, onScreen.ctx);
	check('and it names the build, the palette and the panels that are open',
		/build/i.test(onScreen.ctx) && /palette/i.test(onScreen.ctx) && /panels open/i.test(onScreen.ctx),
		onScreen.ctx);

	const before = notes.length;
	await page.click('.imp-send');
	await page.waitForTimeout(1200);
	check('Send sends — so the two silences above were the design and not a dead button',
		notes.length === before + 1, `${notes.length - before} request(s)`);

	const sent = notes[notes.length - 1] || { body: '' };
	const want = onScreen.box + '\n\n' + onScreen.ctx;
	check('and the body of that request is character-for-character what was on screen',
		sent.body === want,
		`sent ${JSON.stringify(sent.body.slice(0, 160))}\n         want ${JSON.stringify(want.slice(0, 160))}`);

	const sentRow = await page.locator('.imp-note').first().innerText();
	check('the note now says it went', /sent/i.test(sentRow), sentRow.slice(0, 80));

	// ── 3. Closing the row takes the line off the wire ───────────
	const NOTE_3 = 'The divider above the admin panel will not go back on a '
		+ 'double-click. quokka-marker-three';
	await page.fill('#improve-box', NOTE_3);
	await page.waitForTimeout(400);
	await page.click('.imp-with-off');
	await page.waitForTimeout(300);
	const rowGone = await page.locator('#improve-with').isHidden();
	check('the closer on that row closes it', rowGone);

	const before3 = notes.length;
	await page.click('.imp-send');
	await page.waitForTimeout(1200);
	const sent3 = notes[notes.length - 1] || { body: '' };
	check('and the line it was showing is off the wire, not merely off the screen',
		notes.length === before3 + 1 && sent3.body === NOTE_3,
		JSON.stringify(sent3.body.slice(0, 200)));

	// ── 4. A note that could not be sent is kept, and never retried ──
	noteAnswer = 503;
	const NOTE_4 = 'The paperclip is missing from file rows in the Workspace '
		+ 'panel. quokka-marker-four';
	await page.fill('#improve-box', NOTE_4);
	await page.waitForTimeout(400);
	const before4 = notes.length;
	await page.click('.imp-send');
	await page.waitForTimeout(1200);
	check('a note that the gateway refuses was still tried once',
		notes.length === before4 + 1, `${notes.length - before4} attempt(s)`);

	const keptRow = await page.locator('.imp-note').first().innerText();
	check('and it is kept, and the row says so rather than claiming it went',
		/kept here/i.test(keptRow) && !/^sent/i.test(keptRow.trim()), keptRow.slice(0, 90));

	const after4 = notes.length;
	await sleep(4000);
	check('and nothing tries again — a queue of text is what this design refuses',
		notes.length === after4, `${notes.length - after4} further attempt(s) in 4s`);
	noteAnswer = 200;

	// ── 5. The words appear in exactly one request ───────────────
	// Every request the page made, whatever its address. A leak into telemetry,
	// into a sync parcel or into an image URL fails here and nowhere else.
	const carrying = (marker) => wire.filter(r =>
		(r.body && r.body.indexOf(marker) !== -1) || r.url.indexOf(marker) !== -1);
	for (const [marker, where] of [['quokka-marker-two', '/api/note'], ['quokka-marker-three', '/api/note']]) {
		const hits = carrying(marker);
		check(`the words of a sent note are in exactly one request, and it is ${where}`,
			hits.length === 1 && hits[0].url.indexOf(where) !== -1,
			hits.map(h => h.method + ' ' + h.url).join(' | ') || 'none');
	}
	const keptOnly = carrying('quokka-marker-one');
	check('and the words of a KEPT note are in no request at all',
		keptOnly.length === 0, keptOnly.map(h => h.url).join(' | '));

	// ── 6, 7, 8. Proposals and votes ─────────────────────────────
	await page.evaluate(() => window.DaimondImprove.show('proposals'));
	await page.waitForTimeout(800);

	// 8. By NAME, not by count: this row and what it says about itself.
	const taken = page.locator('.imp-prop[data-prop="7"]');
	const takenRow = await taken.locator('.imp-prop-row').innerText();
	const takenState = await taken.getAttribute('data-state');
	check('the proposal that is being done says so, and says how many asked for it',
		takenState === 'taken' && takenRow.indexOf('12') !== -1
			&& takenRow.indexOf('A light on the Everything row') !== -1,
		`state=${takenState} row=${JSON.stringify(takenRow)}`);

	const doneRow = page.locator('.imp-prop[data-prop="11"]');
	check('and the one that shipped is drawn as done, not as open',
		await doneRow.getAttribute('data-state') === 'done',
		await doneRow.getAttribute('data-state'));

	await doneRow.locator('.imp-prop-row').click();
	await page.waitForTimeout(300);
	const doneBody = await doneRow.locator('.imp-prop-body').innerText();
	check('opening it names the build it shipped in',
		doneBody.indexOf('dd7cfef8fe27') !== -1, doneBody.slice(0, 120));

	const asAt = await page.locator('#improve-asat').innerText();
	check('the list says which build the counts are as at',
		asAt.indexOf('aa11bb22cc33') !== -1, asAt);

	// 7. A vote made while the gateway refuses is KEPT.
	voteAnswer = 503;
	await page.locator('.imp-prop[data-prop="3"] .imp-prop-row').click();
	await page.waitForTimeout(300);
	const votesBefore = votes.length;
	await page.locator('.imp-prop[data-prop="3"] .imp-vote[data-dir="do"]').click();
	await page.waitForTimeout(1000);
	check('a vote is offered to the gateway when it is cast',
		votes.length === votesBefore + 1, `${votes.length - votesBefore}`);

	const held = await page.evaluate(() => window.DaimondImprove.myVote(3));
	check('and one the gateway refused is kept, not dropped — the opposite of a note',
		!!held && held.d === 1 && held.sent === 0, JSON.stringify(held));
	const heldClass = await page.locator('.imp-prop[data-prop="3"] .imp-vote[data-dir="do"]').getAttribute('class');
	check('and it is drawn as yours-but-not-counted', /\bheld\b/.test(heldClass || ''), heldClass);

	// Voting redraws the list. The proposal being voted on must still be open
	// afterwards: the button that was pressed is INSIDE it, so closing the row
	// takes the answer away along with the question.
	const stillOpen = await page.locator('.imp-prop[data-prop="3"] .imp-prop-body').isVisible();
	check('and the proposal being voted on is still open to read', stillOpen);

	// And it goes later, without anybody pressing it again.
	voteAnswer = 200;
	const votesBefore2 = votes.length;
	await page.evaluate(() => window.DaimondImprove.flushVotes());
	await page.waitForTimeout(1000);
	check('and it goes on the next attempt, with nobody pressing anything again',
		votes.length === votesBefore2 + 1, `${votes.length - votesBefore2}`);
	const counted = await page.evaluate(() => window.DaimondImprove.myVote(3));
	check('and it is then marked as counted', !!counted && counted.sent === 1, JSON.stringify(counted));

	// 6. Integers only, asserted on the KEYS as well as the values.
	const last = votes[votes.length - 1] || { body: null, raw: '' };
	const keys = last.body ? Object.keys(last.body).sort() : [];
	const ints = last.body ? Object.keys(last.body).every(k => Number.isInteger(last.body[k])) : false;
	check('a vote carries four integers and nothing else',
		keys.join(',') === 'b,d,p,v' && ints, last.raw);
	check('and it names the proposal by its number, and the direction as a number',
		!!last.body && last.body.p === 3 && last.body.d === 1, last.raw);

	// Both surfaces are photographed, not one. The proposals view is the half a
	// reader never sees in a shot of the notes view, and a panel is only as
	// verified as the pictures somebody actually looked at.
	await shot(s, 'improve-proposals' + (BREAK ? '-' + BREAK : ''));

	// One chip per thing, FILLED while that thing is showing — the chip row's own
	// rule, which the two chips on this head have to keep or they are tabs
	// wearing a chip's shape. Asserted on both, because "one is filled" and "the
	// other is not" are different failures.
	const chipState = async () => page.evaluate(() => {
		const q = (v) => document.querySelector(`#panel-improve .imp-chip[data-view="${v}"]`);
		const n = q('notes'), p = q('proposals');
		const vis = (id) => { const e = document.getElementById(id); return !!(e && !e.hidden); };
		return {
			notes: !!(n && n.classList.contains('on')), props: !!(p && p.classList.contains('on')),
			notesView: vis('improve-notes'), propsView: vis('improve-props-view'),
		};
	});
	const onProps = await chipState();
	check('the Proposals chip is filled while the proposals are showing, and Notes is not',
		onProps.props && !onProps.notes && onProps.propsView && !onProps.notesView,
		JSON.stringify(onProps));

	// ── 9. The panel's words are the guide's words ───────────────
	await page.evaluate(() => window.DaimondImprove.show('notes'));
	await page.waitForTimeout(400);
	const onNotes = await chipState();
	check('and pressing the other chip swaps which is filled and which view shows',
		onNotes.notes && !onNotes.props && onNotes.notesView && !onNotes.propsView,
		JSON.stringify(onNotes));
	// Both views' text, because the guide describes both and one is hidden at
	// any moment. `textContent` rather than `innerText`: a hidden view has no
	// rendered text, and what is being checked is the WORDS the panel is built
	// from, not what happens to be painted this second.
	const panelWords = await page.evaluate(() => {
		const p = document.getElementById('panel-improve');
		return p ? p.textContent.replace(/\s+/g, ' ') : '';
	});
	const missing = GUIDE_LABELS.filter(w => panelWords.indexOf(w) === -1);
	check(`every label the guide names is in the panel (${GUIDE_LABELS.length} checked)`,
		missing.length === 0, missing.map(m => JSON.stringify(m)).join(', '));

	// A plural of a term is the term. Tried as written first, so the allowance
	// is one letter wide and cannot admit a word the glossary never had.
	const known = (n) => TERMS.has(n) || TERMS.has(n.replace(/s$/, ''));
	const coined = GUIDE_NOUNS.filter(n => !known(n.toLowerCase()));
	check(`and every part the guide names in bold is a word the glossary defines (${GUIDE_NOUNS.length} checked)`,
		coined.length === 0, coined.map(m => JSON.stringify(m)).join(', '));

	// The one word the guide is emphatic about: the box is NOT the composer.
	check('the panel does not call its box the composer',
		panelWords.toLowerCase().indexOf('composer') === -1);

	// The guide is framed WITHOUT `allow-same-origin`, so its own stylesheets are
	// requested from an opaque origin and Chrome refuses them on a loopback
	// address. That is the Web panel opening itself on a first run, it predates
	// this panel and has nothing to do with it; everything else counts.
	// ── 10. And it exists on a phone ─────────────────────────────
	// A panel about reporting faults that a phone cannot reach leaves out every
	// reader most likely to meet one. On a phone it rises over the chat as a
	// sheet, and the two things that must survive the change of shape are the
	// box you write in and the button that sends it.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(600);
	await page.evaluate(() => { if (window.DaimondSheet) window.DaimondSheet.open('improve'); });
	await page.waitForTimeout(900);
	const phone = await page.evaluate(() => {
		const box  = document.getElementById('improve-box');
		const send = document.querySelector('#improve-acts .imp-send');
		const b = box ? box.getBoundingClientRect() : null;
		const t = send ? send.getBoundingClientRect() : null;
		return {
			inSheet: !!(box && box.closest('#msheet')),
			box:  b ? { w: Math.round(b.width), h: Math.round(b.height) } : null,
			send: t ? { w: Math.round(t.width), h: Math.round(t.height), right: Math.round(t.right) } : null,
			width: window.innerWidth,
		};
	});
	check('on a phone the panel rises as a sheet', phone.inSheet, JSON.stringify(phone));
	check('and the note box is a box you could write in',
		!!phone.box && phone.box.w > 240 && phone.box.h > 60, JSON.stringify(phone.box));
	check('and Send is on the screen rather than off the right of it',
		!!phone.send && phone.send.w > 30 && phone.send.right <= phone.width,
		JSON.stringify(phone.send) + ' in ' + phone.width);
	await shot(s, 'improve-phone' + (BREAK ? '-' + BREAK : ''));
	await page.setViewportSize({ width: 1500, height: 950 });

	const errs = errors(s).filter(e =>
		!/Failed to load resource/.test(e)
		&& !(/blocked by CORS policy/.test(e) && /\/guide\//.test(e)));
	check('nothing above was reached by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	await shot(s, 'improve' + (BREAK ? '-' + BREAK : ''));
} finally {
	await s.close();
}

console.log(`\nnote posts: ${notes.length}   vote posts: ${votes.length}   requests seen: ${wire.length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
