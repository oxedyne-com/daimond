// verify_improve.mjs — the Improve panel keeps its one promise, against a real forge.
//
// `dev/IMPROVE_CONTRACT.md` §4 states it in a sentence:
//
//   A NOTE LEAVES THIS DEVICE ONLY WHEN A PERSON PRESSES SEND ON THAT ONE
//   NOTE, AND WHAT LEAVES IS EXACTLY THE CHARACTERS ON THE SCREEN AT THAT
//   MOMENT.
//
// Every clause of that is a check here, and every check is COUNTED AT THE
// NETWORK — `page.route` sits between the page and the server, so a request
// that was never made and a request that was merely hidden look different.
//
// ── WHAT IS AT THE OTHER END ─────────────────────────────────────────
//
// `dev/mock_forge.mjs`, which is the Oregami forge's whole JSON surface stood
// in for, and a stand-in for the GATEWAY that builds the upstream path exactly
// as `gateway/src/handlers/improve.rs` does. Nothing here answers the panel out
// of its own idea of the protocol: a verifier that did would agree with itself
// and prove nothing about the forge. The bytes the panel parses are the bytes
// the forge will send, canonical JSON and all.
//
// Five stand-ins run at once, because several properties need a forge that
// behaves DIFFERENTLY and a client cannot be asked to prove it survives one it
// never meets:
//
//   :8437  the ordinary corpus, twelve proposals — most checks
//   :8438  fifty proposals — paging, which needs more than one page
//   :8439  fifty, `--break fromascends` — a forge that reads `from` as a LOWER
//          bound, which is the shape that makes a paging client loop for ever
//   :8440  `--break novotes` — the listing carries no tally, which is what the
//          real forge does TODAY, and is what "the vote control ships dark"
//          means
//   :8441  `--refuse unsupported` — the one refusal token no path the panel
//          takes can reach naturally, and a token nobody has met is a token
//          nobody has handled
//
//   1. WRITING IS NOT SENDING, AND NEITHER IS KEEP. Both halves are asked, and
//      the second is the one that matters: a check that only ever proves
//      silence passes with the feature entirely absent. So Send is pressed
//      afterwards and the request DOES leave.
//
//   2. WHAT LEFT IS WHAT YOU READ. A note is now a PROPOSAL, so the request has
//      a title field and a body field rather than being the note's own bytes —
//      and the property that the old shape carried for free has to be bought
//      back by two assertions instead of one:
//        * the fields put back together, `title + "\n" + body`, are character
//          for character the box's value plus the visible "What goes with it"
//          line;
//        * and the FIELD SET is exactly `title`, `body`, `build`. Not "the body
//          contains the note": a request that contains the note and a fifth
//          field passes that.
//
//   3. CLOSING THE ROW TAKES THE LINE OFF THE WIRE, not merely off the screen —
//      and the `build` FIELD with it, since it carries the same characters that
//      row's first item shows.
//
//   4. A NOTE THAT COULD NOT BE SENT IS KEPT, SAYS SO, OFFERS COPY, AND IS
//      NEVER RETRIED. The retry half is the one worth the seconds: a queue of
//      text outlives the consent that filled it.
//
//   5. THE WORDS APPEAR IN EXACTLY ONE REQUEST IN THE WHOLE SESSION. Every
//      request the page makes is read, whatever its address — telemetry, sync,
//      a beacon, an image. One carries the note; nothing else carries a
//      syllable of it.
//
//   6. A VOTE'S WHOLE BODY IS `d=1`, `d=-1` OR `d=0`. Asserted on the RAW
//      characters, so a fifth field smuggled in fails even though the `d` is
//      right. And no request ever sends a vote with no `d` at all, which the
//      forge reads as malformed and which nothing may read as a withdrawal.
//
//   7. THE VOTE CONTROL SHIPS DARK. Against a forge whose listing carries no
//      tally — which is the forge as it stands today — nothing is drawn: not a
//      disabled button, not a zero. And `mine` ABSENT is drawn differently from
//      `mine` NULL, because "I was not asked" and "I have not voted" are
//      different facts and a panel that confused them would offer an unvoted
//      button to somebody who cannot vote.
//
//   8. A PROPOSAL ROW SAYS ITS OWN STATE AND ITS OWN TALLY. By NAME: the row
//      for a named proposal reads Being done and its own numbers, not "there
//      are three rows". And voting does not shut the proposal you were reading.
//
//   8b. EVERY ONE OF THE NINE REFUSALS IS SAID, NOT SWALLOWED, and `absent`'s
//      sentence is TRUE IN BOTH CASES — it covers "no such repository" and
//      "this repository is private" permanently, so a sentence that names
//      either is a sentence that is false or that leaks.
//
//   8c. PAGING TERMINATES AND DOES NOT WRAP. `from` is a ceiling that counts
//      down and there is no value of it meaning "nothing below this", so
//      `from=0` is never sent — and against a forge that reads `from` the wrong
//      way round the walk still ENDS rather than offering to show more for ever.
//
//   9. THE PANEL'S WORDS ARE THE GUIDE'S WORDS. `www/guide/improve.html` is
//      the only contract this panel was handed, so it is checked mechanically:
//      every `<span class="ui">` label in its §"The Improve panel" must be
//      visible text in the running panel, and every part-noun that section
//      sets in bold must be one of the terms the glossary above it defines.
//
//  10. AND IT EXISTS ON A PHONE.
//
// THE SEAM IS APPLIED BY THIS FILE. The panel's markup lives in
// `www/index.html`, which the lane that built this does not own, so the exact
// edit it asked for is served through `page.route` here. Once the edit is in the
// file on disk, this file notices and serves it unchanged.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file and the run is expected to FAIL.
// A break that does not apply cleanly aborts rather than passing quietly.
//
//   node dev/verify_improve.mjs --break keepsends      # 1  Keep sends
//   node dev/verify_improve.mjs --break hidden         # 2a a line nobody saw
//   node dev/verify_improve.mjs --break smuggle        # 2b a fifth field
//   node dev/verify_improve.mjs --break stickycontext  # 3a closed, and still sent
//   node dev/verify_improve.mjs --break buildsticky    # 3b closed, and the build still sent
//   node dev/verify_improve.mjs --break retry          # 4a a failed note is retried
//   node dev/verify_improve.mjs --break nocopy         # 4b a kept note offers no Copy
//   node dev/verify_improve.mjs --break leak           # 5  the words go somewhere else too
//   node dev/verify_improve.mjs --break votetext       # 6  a vote carries a title
//   node dev/verify_improve.mjs --break votequeue      # 6b a refused vote is drawn as cast
//   node dev/verify_improve.mjs --break alwaysvote     # 7a a control with nothing behind it
//   node dev/verify_improve.mjs --break minesame       # 7b not-asked READ as not-voted
//   node dev/verify_improve.mjs --break minedraw       # 7c not-asked DRAWN as not-voted
//   node dev/verify_improve.mjs --break flatstate      # 8a every proposal drawn Open
//   node dev/verify_improve.mjs --break closeonvote    # 8b voting shuts what you were reading
//   node dev/verify_improve.mjs --break saidnothing    # 8c a refusal swallowed
//   node dev/verify_improve.mjs --break absentleak     # 8d a sentence that is false when private
//   node dev/verify_improve.mjs --break becauseblind   # 8e every throttle said the same way
//   node dev/verify_improve.mjs --break pagezero       # 8f from=0 goes on the wire
//   node dev/verify_improve.mjs --break nowrap         # 8g the walk never ends
//   node dev/verify_improve.mjs --break nolive         # 9b the change-feed line goes
//   node dev/verify_improve.mjs --break renamechip     # 9  the panel and the guide disagree
//   node dev/verify_improve.mjs                        # and then, clean
//
// EACH BREAK IS SCOPED SO IT SURVIVES EVERY CHECK BUT THE ONE IT PROVES. That
// is not decoration. `smuggle` adds a field and leaves the two real ones exactly
// right, so check 2a stays green and only 2b moves; had it also mangled the
// body, 2a would have gone red and 2b would have been credited with catching
// something it never saw. `buildsticky` is the same trick against `stickycontext`:
// one leaves the context LINE on the wire, the other leaves only the `build`
// FIELD, and a single "closing does nothing" break would redden both and prove
// neither. `hidden` appends its line only when the row is SHOWN, so check 3 —
// which closes the row — stays green under it.
//
// FIVE BREAKS REDDEN MORE THAN ONE CHECK, established by running all
// twenty-two rather than by reasoning about them. Each is written down rather
// than tidied away, because a break whose reach is not stated is a break whose
// reach is not known:
//
//   `keepsends`  2 — "Keep sends nothing" and "the words of a KEPT note are in
//                no request at all". One property counted twice, once at the
//                button and once over the whole session.
//   `leak`       2 — the same check over two different notes. It is written as
//                one check per marker so a red names which note leaked.
//   `votetext`   2 — the cast and the withdrawal, which is the same assertion
//                about the same body made twice on purpose: a client that got
//                the first right and the second wrong would be worse than one
//                that got both wrong.
//   `minesame`   2 — the record and the drawing. The drawing is downstream of
//                the record, which is why `minedraw` exists: it leaves the
//                record right and breaks only what is drawn, so the drawing
//                check is proved by something that is not merely echoing the
//                record check.
//   `flatstate`  3 — two state assertions and the guide-words check, because
//                three of the four state words the guide names are only ever
//                painted by a proposal that is in that state. Nothing can be
//                drawn from the guide check that the state checks have not
//                already said.
//
// EVERY OTHER BREAK REDDENS EXACTLY ONE. Two were not isolated when first run
// and both were the verifier's fault rather than the panel's, which is worth
// recording because both failures LOOKED like proof:
//
//   `keepsends` also reddened "every write carried the voice", because the note
//   it sends is sent before a voice exists. That check was asserting two
//   properties at once and now asserts one.
//   `closeonvote` reddened NOTHING and ended the run: a row shut before the
//   vote was cast turns the click into a Playwright timeout, so the run stopped
//   at the check it was meant to prove and said nothing about the twenty after
//   it. Every interaction inside that row now re-opens it first, and the one
//   check that must NOT re-open — whether voting shut it — is measured with
//   nothing in between.
//
// WHAT FALLS BETWEEN THE CHECKS, asked deliberately. The pair "the fields put
// back together are what was on screen" and "the field set is exactly these
// three" leaves nothing between them for a proposal write: any character added
// fails the first and any field added fails the second. It leaves plenty
// between them for a request this file never makes — a second write on some
// other route — which is what check 5 is for, and check 5 is blind to the
// address on purpose.
//
//   eval "$(bash dev/world.sh 7 --env)"
//   node dev/verify_improve.mjs
//
// Needs dev/serve.mjs and node. No gateway and no Rust: the gateway's half of
// the path is reproduced here, from the source, and the forge's half is the
// mock.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

// ── The forges ───────────────────────────────────────────────────────

const FORGE = {
	main:  { port: 8437, args: ['--count', '12'] },
	pages: { port: 8438, args: ['--count', '50'] },
	// A forge that reads `from` as a LOWER bound. Not a straw man: it is what
	// both implementations of this contract wrote first, and it is the shape
	// that makes the obvious paging loop never terminate.
	wrong: { port: 8439, args: ['--count', '50', '--break', 'fromascends'] },
	// A listing with no tally on it, which is the forge as it stands today: §9's
	// vote route is still in flight.
	dark:  { port: 8440, args: ['--break', 'novotes'] },
	// The one token no path the panel takes can reach naturally.
	unsup: { port: 8441, args: ['--refuse', 'unsupported'] },
};

const started = [];

async function reachable(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/a/b/proposals?format=json&limit=1`);
		await r.text();
		return true;
	} catch (e) { return false; }
}

async function startForges() {
	for (const [name, f] of Object.entries(FORGE)) {
		if (await reachable(f.port)) {
			console.error(`:${f.port} is already held by something. Free it, or the run below `
				+ 'would be driven against somebody else\'s forge.');
			process.exit(2);
		}
		const p = spawn('node', [path.join(HERE, 'mock_forge.mjs'), '--port', String(f.port), ...f.args],
			{ stdio: ['ignore', 'ignore', 'inherit'] });
		started.push(p);
		f.proc = p;
	}
	for (let i = 0; i < 100; i++) {
		const all = await Promise.all(Object.values(FORGE).map(f => reachable(f.port)));
		if (all.every(Boolean)) return;
		await new Promise(r => setTimeout(r, 100));
	}
	console.error('a forge never bound; nothing below would prove anything.');
	process.exit(2);
}

function stopForges() {
	for (const p of started) { try { p.kill('SIGTERM'); } catch (e) { /* already gone */ } }
	started.length = 0;
}

// A run that fell over before its `finally` used to leave five node processes
// holding five ports, and the next run then refused to start against them --
// which reads as a fault in the panel and is a fault in this file. An orphaned
// mock holding a port has caused a false failure here before.
process.on('exit', stopForges);
for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => { stopForges(); process.exit(130); });
}

// ── The seam ─────────────────────────────────────────────────────────
//
// The edits `www/index.html`, `www/i18n/en.js`, `www/js/daimond.js` and
// `www/js/mobile.js` need, written out so that the lanes that own them can paste
// them and so that this run proves them. Each carries a `want` naming the ONE
// thing it is there to ensure, so a panel later dressed differently does not make
// the seam fire against a file that already has it — which once served the page
// with TWO `#panel-improve` elements and turned every check red for a reason that
// had nothing to do with this panel.

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

const SEAM = [
	// On a phone a dock panel is only reachable if it is a GUEST — something
	// that rises over the chat as a sheet. Matched by SHAPE rather than by its
	// exact text: that table is edited often, and an anchor on the literal line
	// would make this verifier fail for a reason with nothing to do with the
	// panel.
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
		with: '\t\tvar rec = store(text, 0);\n\t\tclearBox();\n\t\trender();\n\t\tpost(split(text));\n\t\treturn rec;\n\t}',
	}],
	// One line appended that was never on the screen. The note is all there, so
	// a check that asked whether the body CONTAINS the note would pass.
	hidden: [{
		file: 'js/improve.js',
		find: '\t\treturn ctx ? (body + \'\\n\\n\' + ctx) : body;',
		with: '\t\treturn ctx ? (body + \'\\n\\n\' + ctx + \'\\n\\nseen: \' + navigator.userAgent) : body;',
	}],
	// A fifth field, and the two real ones left exactly right. This is the whole
	// reason the field set is asserted at all: with an envelope on the wire,
	// "the note is in there" stopped being the same claim as "and nothing else
	// is".
	smuggle: [{
		file: 'js/improve.js',
		find: '\t\tif (parts.build) f.set(\'build\', parts.build);',
		with: '\t\tif (parts.build) f.set(\'build\', parts.build);\n\t\tf.set(\'via\', navigator.userAgent);',
	}],
	// The row is closed, and the line goes anyway: off the screen, on the wire.
	stickycontext: [{
		file: 'js/improve.js',
		find: '\t\tif (contextOff()) return body;',
		with: '\t\tif (contextOff() && false) return body;',
	}],
	// The row is closed, the LINE is honestly gone, and the build identifier it
	// was showing goes anyway. Deliberately not the same break as the one above:
	// a single "closing does nothing" edit would redden both checks and prove
	// neither.
	buildsticky: [{
		file: 'js/improve.js',
		find: '\t\treturn { title: title, body: body, build: contextOff() ? \'\' : _build };',
		with: '\t\treturn { title: title, body: body, build: _build };',
	}],
	// A failed note is queued and tried again. This is the failure the whole
	// design refuses, and it is invisible from the panel.
	retry: [{
		file: 'js/improve.js',
		find: '\t\t} else flash(keptAfter(a));\n\t\trender();\n\t\treturn rec;',
		with: '\t\t} else { flash(keptAfter(a)); setTimeout(function () { post(parts); }, 2500); }\n\t\trender();\n\t\treturn rec;',
	}],
	// A note that could not be sent, and no way to carry it out by hand. The row
	// still says it is kept, so everything about check 4a stays green.
	nocopy: [{
		file: 'js/improve.js',
		find: '\t\t\tfoot.appendChild(button(\'imp-note-copy\', \'improve-copy\', t(\'common.copy\'), t(\'common.copy\')));',
		with: '\t\t\tif (n.sent) foot.appendChild(button(\'imp-note-copy\', \'improve-copy\', t(\'common.copy\'), t(\'common.copy\')));',
	}],
	// The words go somewhere else as well. Everything about the proposal request
	// stays correct, so checks 1 to 4 all still pass.
	leak: [{
		file: 'js/improve.js',
		find: '\t\treturn await ask(route(\'\'), {\n\t\t\tmethod:  \'POST\',\n\t\t\theaders: { \'Content-Type\': \'application/x-www-form-urlencoded\' },\n\t\t\tbody:    f.toString(),\n\t\t});',
		with: '\t\ttry { fetch(\'/api/telemetry\', { method: \'POST\', body: JSON.stringify({ e: parts.body }) }); } catch (e) {}\n'
			+ '\t\treturn await ask(route(\'\'), {\n\t\t\tmethod:  \'POST\',\n\t\t\theaders: { \'Content-Type\': \'application/x-www-form-urlencoded\' },\n\t\t\tbody:    f.toString(),\n\t\t});',
	}],
	// A vote carries the proposal's title, "for the operator's convenience". The
	// `d` is still right, so a check on the direction alone would pass.
	votetext: [{
		file: 'js/improve.js',
		find: '\t\t\tbody:    body,\n\t\t});\n\t\tif (!a.ok) { _list.err = a; drawProps(); return false; }\n\t\tabsorb(cleanProp(a.data));',
		with: '\t\t\tbody:    body + \'&title=\' + encodeURIComponent(rec.title),\n\t\t});\n\t\tif (!a.ok) { _list.err = a; drawProps(); return false; }\n\t\tabsorb(cleanProp(a.data));',
	}],
	// A vote the forge refused, drawn as though it had been counted. This is the
	// old client-side queue coming back in its mildest form, and it is the exact
	// shape §9 rejected: two stores of truth, and the panel showing the one that
	// is wrong.
	votequeue: [{
		file: 'js/improve.js',
		// Anchored through the line ABOVE it: `loadOne` refuses in exactly the
		// same words, so the shorter anchor matched twice and the break landed
		// nowhere -- which is a check proving nothing, dressed as a check.
		find: '\t\t\tbody:    body,\n\t\t});\n\t\tif (!a.ok) { _list.err = a; drawProps(); return false; }',
		with: '\t\t\tbody:    body,\n\t\t});\n\t\tif (!a.ok) { _list.err = a; rec.mine = (rec.mine === want ? null : want); drawProps(); return false; }',
	}],
	// A vote control drawn over a record that has no tally: a zero where the
	// forge has said nothing at all. This is the defect class the whole rewrite
	// was about, reintroduced one control at a time.
	alwaysvote: [{
		file: 'js/improve.js',
		find: '\t\tif (!p.votes) return;',
		with: '\t\tif (!p.votes) p = Object.assign({}, p, { votes: { for: 0, against: 0 } });',
	}],
	// "I was not asked" drawn as "I have not voted". Everything a voiced reader
	// sees is unchanged, so every other vote check stays green.
	minesame: [{
		file: 'js/improve.js',
		find: '\t\tif (Object.prototype.hasOwnProperty.call(p, \'mine\')) {\n\t\t\trec.asked = true;',
		with: '\t\tif (true) {\n\t\t\trec.asked = true;',
	}],
	// The drawing half of the same rule, on its own. `minesame` breaks the
	// RECORD and the drawing goes with it, because the drawing is downstream;
	// this one leaves the record exactly right and breaks only what is drawn,
	// which is what establishes that the drawing check is not merely echoing
	// the record check.
	minedraw: [{
		file: 'js/improve.js',
		find: '\t\tif (!p.asked) {',
		with: '\t\tif (false) {',
	}],
	// Every proposal drawn Open, whatever it says. The list is the right length
	// and every title is right.
	flatstate: [{
		file: 'js/improve.js',
		find: '\t\t\tstate:      STATES[p.state] ? p.state : \'open\',',
		with: '\t\t\tstate:      \'open\',',
	}],
	// Voting closes the proposal you were reading — the answer vanishing along
	// with the question. This is what the first build of the panel did.
	closeonvote: [{
		file: 'js/improve.js',
		find: '\t\t\tbody.hidden = !_open[String(p.n)];',
		with: '\t\t\tbody.hidden = true;',
	}],
	// One refusal swallowed. Scoped to `internal` alone: a break that silenced
	// them all would redden nine checks and prove one.
	saidnothing: [{
		file: 'js/improve.js',
		find: '\t\t\treturn tOr(\'improve.err_internal\', \'Something went wrong at the forge. This is not your fault.\');',
		with: '\t\t\treturn \'\';',
	}],
	// A sentence that is false when the repository is private. `absent` covers
	// both cases permanently, so this is not a nicety of wording: it is the
	// privacy rule, undone by a kindness.
	absentleak: [{
		file: 'js/improve.js',
		find: '\t\t\treturn tOr(\'improve.err_absent\', \'This repository is not available to you.\');',
		with: '\t\t\treturn tOr(\'improve.err_absent_broken\', \'There is no such repository.\');',
	}],
	// Every throttle said the same way, so a tester refused for the address is
	// told it was their own voice. The token is still branched on, so the
	// presence checks all stay green.
	becauseblind: [{
		file: 'js/improve.js',
		find: '\t\t\tif (a.because === \'address\') {',
		with: '\t\t\tif (false) {',
	}],
	// `from=0` on the wire. There is no value of `from` that says "nothing below
	// this", and zero means back to the newest — so this is the request that
	// turns a walk into a circle. Two sites, because the guard is layered and
	// removing one leaves the other holding.
	pagezero: [
		{
			file: 'js/improve.js',
			find: '\t\t\tif (!(_list.lowest > 1)) { _list.done = true; drawProps(); return false; }',
			with: '\t\t\tif (!(_list.lowest > 0)) { _list.done = true; drawProps(); return false; }',
		},
		{
			file: 'js/improve.js',
			find: '\t\tif (lowest === null || lowest <= 1) _list.done = true;',
			with: '\t\tif (lowest === null) _list.done = true;',
		},
	],
	// The belt comes off: a walk that does not descend goes on offering to show
	// more, for ever, against a forge that reads `from` the wrong way round. The
	// two cheaper rules still hold against a forge that reads it correctly, so
	// ordinary paging stays green and only the wrong-forge check moves.
	nowrap: [{
		file: 'js/improve.js',
		find: '\t\tif (more && lowest !== null && _list.lowest !== null && lowest >= _list.lowest) {\n\t\t\t_list.done = true;\n\t\t}',
		with: '\t\tif (false) { _list.done = true; }',
	}],
	// The line that says nothing will tell you when a proposal is answered.
	// There is no change feed on either side; a panel that does not say so is a
	// panel a tester waits at.
	nolive: [{
		file: 'js/improve.js',
		find: '\t\t\tasAt.textContent = tOr(\'improve.live_note\',\n'
			+ '\t\t\t\t\'These are read from the forge as you look at them. Nothing tells you when a proposal is answered; look again to find out.\');',
		with: '\t\t\tasAt.textContent = \'\';',
	}],
	// The panel calls its first chip something the guide does not. Broken in the
	// CATALOGUE and not in the markup, because the markup's English is only a
	// fallback: `data-i18n` paints the table's word over it on the first apply.
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
		const src = FILES.get(p) ?? fs.readFileSync(path.join(WWW, p), 'utf8');
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

// ── The gateway, stood in for ────────────────────────────────────────
//
// `gateway/src/handlers/improve.rs` builds the upstream request-target, refuses
// what it will not forward, translates `x-daimond-voice` into the forge's
// `x-ore-voice`, and hands the answer back VERBATIM. All four are reproduced
// here from that file. What is deliberately NOT reproduced is the per-tester
// meter, which is Rust's own and is tested there: a second, different copy of a
// limiter is a thing to disagree with the real one.

/// Which forge the panel's requests are pointed at, and at which repository.
/// The panel names one repository and cannot be made to name another — that is
/// the contract — so the STAND-IN rewrites it, exactly as a gateway pointed at a
/// different forge would. The panel stays honest and every refusal stays
/// reachable.
let forge = FORGE.main;
let asRepo = '';				// '' means "whatever the panel asked for"

const NAME = /^[A-Za-z0-9_-]+$/;

/// The path `upstream_path()` builds. `format=json` is written HERE and never
/// taken from the caller.
function upstreamPath(u, repo) {
	const q = u.searchParams;
	const n = q.get('n');
	const voting = q.get('vote') === '1';
	let p = `/${q.get('account')}/${repo}/proposals`;
	if (n !== null) p += '/' + n + (voting ? '/vote' : '');
	p += '?format=json';
	if (n === null) {
		const state = q.get('state');
		if (state !== null) p += '&state=' + state;
		const from = q.get('from');
		if (from !== null) p += '&from=' + from;
		const limit = q.get('limit');
		if (limit !== null) p += '&limit=' + limit;
	}
	return p;
}

/// EVERY request the page made, whatever its address. Check 5 reads all of it.
const wire = [];
/// Every request that reached the improve route, in order.
const asked = [];

const HDR = 'x-daimond-voice';

async function improveRoute(r) {
	const req = r.request();
	const u   = new URL(req.url());
	const q   = u.searchParams;
	const method = req.method();
	const body = req.postData() || '';
	const headers = req.headers();
	asked.push({ url: req.url(), method, body, query: Object.fromEntries(q), headers });

	const refuse = (status, sentence) => r.fulfill({
		status, contentType: 'application/json',
		body: JSON.stringify({ ok: false, error: sentence }),
	});

	// The gateway's own refusals, in its own order.
	const account = q.get('account') || '';
	const repo    = asRepo || q.get('repo') || '';
	if (!NAME.test(account)) return refuse(400, 'An account is letters, digits, \'-\' and \'_\'.');
	if (!NAME.test(repo))    return refuse(400, 'A repository is letters, digits, \'-\' and \'_\'.');
	const n = q.get('n');
	if (n !== null && !/^[0-9]+$/.test(n)) return refuse(400, '\'n\' is a proposal number.');
	const limit = q.get('limit');
	if (limit !== null && !(/^[0-9]+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 200)) {
		return refuse(400, '\'limit\' is between 1 and 200.');
	}
	const voice = headers[HDR];
	if (method === 'POST' && !voice) {
		return refuse(401, 'Writing on the forge needs your voice, which Daimond sends with the '
			+ 'request and never keeps here.');
	}

	const out = { 'accept': 'application/json' };
	// The forge's own spelling. The translation is the gateway's, so that the
	// panel is not coupled to the forge's vocabulary.
	if (voice) out['x-ore-voice'] = (voice === SECRET ? MOCK_SECRET : voice);
	if (method === 'POST') out['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';

	let res, text;
	try {
		res = await fetch(`http://127.0.0.1:${forge.port}` + upstreamPath(u, repo), {
			method, headers: out, body: method === 'POST' ? body : undefined,
		});
		text = await res.text();
	} catch (e) {
		return r.fulfill({ status: 502, contentType: 'application/json',
			body: JSON.stringify({ ok: false, error: 'The forge could not be reached just now.' }) });
	}
	// Verbatim, status and body. The forge answers canonical JSON precisely so
	// that two ends agreeing on the value agree on the bytes.
	return r.fulfill({
		status: res.status,
		contentType: res.headers.get('content-type') || 'application/json',
		body: text,
	});
}

const json = (body, status = 200) => ({
	status, contentType: 'application/json', body: JSON.stringify(body),
});

async function stub(page) {
	for (const [p, body] of FILES) {
		const type = p.endsWith('.html') ? 'text/html' : 'application/javascript';
		await page.route('**/' + p, r => r.fulfill({ status: 200, contentType: type, body }));
	}
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

	await page.route(u => u.pathname === '/api/improve', improveRoute);

	await page.route('**/api/telemetry', r => r.fulfill(json({ ok: true })));
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-imp', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: false, currency: 'usd' })));
}

// ── The guide, read as the contract it is ────────────────────────────

const GUIDE = fs.readFileSync(path.join(WWW, 'guide', 'improve.html'), 'utf8');

function guideSection() {
	const i = GUIDE.indexOf('<section id="improve-panel">');
	const j = GUIDE.indexOf('</section>', i);
	if (i === -1 || j === -1) {
		console.error('the guide has no §"The Improve panel"; check 9 would prove nothing.');
		process.exit(2);
	}
	return GUIDE.slice(i, j);
}

function glossaryTerms() {
	const out = new Set();
	for (const m of GUIDE.matchAll(/id="term-([a-z-]+)"/g)) out.add(m[1].replace(/-/g, ' '));
	['top bar', 'rail', 'stage', 'dock', 'panel', 'crystal', 'daimon', 'worker',
		'note box', 'proposal', 'chip row'].forEach(w => out.add(w));
	return out;
}

const SECTION = guideSection();
const TERMS   = glossaryTerms();

const GUIDE_LABELS = [...new Set(
	[...SECTION.matchAll(/<span class="ui">([^<]+)<\/span>/g)].map(m => m[1].trim()))];

const GUIDE_NOUNS = [...new Set(
	[...SECTION.matchAll(/<strong>([^<]+)<\/strong>/g)]
		.map(m => m[1].trim().replace(/\.$/, ''))
		.filter(s => s.split(/\s+/).length <= 2))];

// ── Driving ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A voice shaped like a real minted one is 43 characters of the Hematite64
// alphabet. The mock's fixtures are three obvious strings, and `mock-voice-ada`
// is fourteen characters — under `DaimondVoice.MIN`, which is sixteen, and
// deliberately so: sixteen catches a truncated paste. So the fixture is padded
// to something the panel will accept and the mock is told about it below.
// allowlist secret
const SECRET = 'mock-voice-ada-0000000000000';
/// What the mock knows that secret as.
///
/// THE STAND-IN TRANSLATES, and it is worth saying why rather than quietly
/// pasting the mock's own string above. `voice.js` refuses a secret under
/// sixteen characters, deliberately: the forge mints forty-three and a
/// truncated paste is exactly what that floor catches. The mock's fixtures are
/// three obvious strings and `mock-voice-ada` is fourteen. So the browser holds
/// a secret shaped like a real one, and the gateway stand-in maps it at the
/// hop — which is the piece that translates headers anyway. What the BROWSER
/// sent is asserted below to be its own secret, unaltered.
const MOCK_SECRET = 'mock-voice-ada';

await startForges();

const s = await open({ name: 'improve', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'improve');
await page.waitForTimeout(1500);

/// The proposal opens, comments and votes that reached the route, told apart the
/// way the gateway tells them apart: by the query, never by the body.
const opens    = () => asked.filter(a => a.method === 'POST' && a.query.n === undefined);
const votes    = () => asked.filter(a => a.method === 'POST' && a.query.vote === '1');
const comments = () => asked.filter(a => a.method === 'POST' && a.query.n !== undefined && a.query.vote === undefined);

/// A form body, as fields. Compared field by field rather than as a string: the
/// encoding is `URLSearchParams`'s at both ends, and what is being asserted is
/// the CHARACTERS, not the escaping.
const fields = (raw) => {
	const out = {};
	for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
	return out;
};

try {
	await page.evaluate(() => {
		window.DaimondPanels.show('improve');
		if (window.DaimondImprove) window.DaimondImprove.onOpen();
	});
	await page.waitForTimeout(600);

	const panel = page.locator('#panel-improve');
	const panels = await panel.count();
	check('the panel is on screen, exactly once', panels === 1, `${panels} found`);

	// ── 1. Writing is not sending, and neither is Keep ───────────
	const NOTE_1 = 'The closer on the Everything row put the whole rail away\n'
		+ 'I expected it to close that row. quokka-marker-one';

	// Send is not offered before there is a voice to send under. A control that
	// does nothing when pressed teaches people to distrust every control.
	// Asked for by the selector the markup really has, AND counted: an absent
	// locator reports itself hidden, so a check that only asked whether it was
	// hidden would pass over a button that does not exist -- which is how the
	// hiding went unbuilt for as long as it did.
	check('the Send button is there to be hidden in the first place',
		await page.locator('#improve-acts .imp-send').count() === 1);
	check('with no voice, Send is not offered at all',
		await page.locator('#improve-acts .imp-send').isHidden());

	await page.fill('#improve-box', NOTE_1);
	await page.waitForTimeout(700);
	check('writing a note sends nothing', opens().length === 0,
		`${opens().length} request(s) left the page`);

	await page.click('.imp-keep');
	await page.waitForTimeout(700);
	check('and Keep sends nothing either', opens().length === 0,
		`${opens().length} request(s) left the page`);

	const kept = await page.locator('.imp-note .imp-note-state[data-state="kept"]').first().innerText();
	check('the kept note says it is only here', /kept here/i.test(kept), kept);

	// ── A voice is set, in this panel, by the person who has one ──
	await page.click('[data-act="improve-voice-open"]');
	await page.waitForTimeout(200);
	await page.fill('#improve-voice-in', SECRET);
	await page.click('[data-act="improve-voice-save"]');
	await page.waitForTimeout(600);
	check('a voice can be set in the panel that needs it',
		await page.evaluate(() => window.DaimondVoice.has()) === true);
	check('and the secret is not left in the field it was typed into',
		await page.evaluate(() => {
			const i = document.getElementById('improve-voice-in');
			return !i || !i.value;
		}));
	check('and Send is offered once there is a voice',
		await page.locator('#improve-acts .imp-send').isVisible());

	// ── 2. What left is what you read ────────────────────────────
	const NOTE_2 = 'The Diamonds chip does not fill when the panel opens\n'
		+ 'It stays empty until something else is pressed. quokka-marker-two';
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

	const before = opens().length;
	await page.click('.imp-send');
	await page.waitForTimeout(1500);
	check('Send sends — so the two silences above were the design and not a dead button',
		opens().length === before + 1, `${opens().length - before} request(s)`);

	const sent = opens()[opens().length - 1] || { body: '' };
	const f2   = fields(sent.body);
	const want = onScreen.box + '\n\n' + onScreen.ctx;
	check('and the request put back together is character-for-character what was on screen',
		(f2.title || '') + '\n' + (f2.body || '') === want,
		`sent ${JSON.stringify(((f2.title || '') + '\n' + (f2.body || '')).slice(0, 160))}\n         want ${JSON.stringify(want.slice(0, 160))}`);
	check('and the request carries THOSE FIELDS AND NO OTHERS',
		Object.keys(f2).sort().join(',') === 'body,build,title',
		Object.keys(f2).sort().join(',') || '(none)');

	const sentRow = await page.locator('.imp-note').first().innerText();
	check('the note now says it went, and names the proposal it became',
		/sent/i.test(sentRow) && /\b13\b/.test(sentRow), sentRow.slice(0, 90));

	// ── 3. Closing the row takes the line off the wire ───────────
	const NOTE_3 = 'The divider above the admin panel will not go back\n'
		+ 'A double-click does nothing to it. quokka-marker-three';
	await page.fill('#improve-box', NOTE_3);
	await page.waitForTimeout(400);
	await page.click('.imp-with-off');
	await page.waitForTimeout(300);
	const rowGone = await page.locator('#improve-with').isHidden();
	check('the closer on that row closes it', rowGone);

	const before3 = opens().length;
	await page.click('.imp-send');
	await page.waitForTimeout(1500);
	const sent3 = opens()[opens().length - 1] || { body: '' };
	const f3 = fields(sent3.body);
	check('and the line it was showing is off the wire, not merely off the screen',
		opens().length === before3 + 1
			&& (f3.title || '') + '\n' + (f3.body || '') === NOTE_3,
		JSON.stringify(((f3.title || '') + '\n' + (f3.body || '')).slice(0, 200)));
	check('and the build identifier that row was showing is off it too',
		!('build' in f3), Object.keys(f3).sort().join(','));

	// ── 4. A note that could not be sent is kept, and never retried ──
	forge = FORGE.main; asRepo = '_throttled-writes';
	const NOTE_4 = 'The paperclip is missing from file rows\n'
		+ 'The Workspace panel draws none of them. quokka-marker-four';
	await page.fill('#improve-box', NOTE_4);
	await page.waitForTimeout(400);
	const before4 = opens().length;
	await page.click('.imp-send');
	await page.waitForTimeout(1500);
	check('a note the forge refuses was still tried once',
		opens().length === before4 + 1, `${opens().length - before4} attempt(s)`);

	const keptRow = await page.locator('.imp-note').first().innerText();
	check('and it is kept, and the row says so rather than claiming it went',
		/kept here/i.test(keptRow) && !/^sent/i.test(keptRow.trim()), keptRow.slice(0, 90));
	check('and Copy is offered on it, so the words can be carried out by hand',
		await page.locator('.imp-note').first().locator('.imp-note-copy').count() === 1);
	const saidBack = await page.locator('#improve-say').innerText();
	check('and the panel says WHY, rather than one sentence for every fault',
		/too many/i.test(saidBack) && /kept/i.test(saidBack), saidBack);

	const after4 = opens().length;
	await sleep(4000);
	check('and nothing tries again — a queue of text is what this design refuses',
		opens().length === after4, `${opens().length - after4} further attempt(s) in 4s`);
	asRepo = '';

	// ── 5. The words appear in exactly one request ───────────────
	const carrying = (marker) => wire.filter(r =>
		(r.body && r.body.indexOf(marker) !== -1) || r.url.indexOf(marker) !== -1);
	for (const marker of ['quokka-marker-two', 'quokka-marker-three']) {
		const hits = carrying(marker);
		check(`the words of a sent note are in exactly one request, and it is /api/improve — ${marker}`,
			hits.length === 1 && hits[0].url.indexOf('/api/improve') !== -1,
			hits.map(h => h.method + ' ' + h.url).join(' | ') || 'none');
	}
	const keptOnly = carrying('quokka-marker-one');
	check('and the words of a KEPT note are in no request at all',
		keptOnly.length === 0, keptOnly.map(h => h.url).join(' | '));

	// ── 6, 7, 8. Proposals, read from the forge ──────────────────
	await page.evaluate(() => window.DaimondImprove.show('proposals'));
	await page.waitForTimeout(1200);

	const live = await page.locator('#improve-asat').innerText();
	check('the list says these are read as you look, and that nothing will tell you',
		/forge/i.test(live) && /look/i.test(live), live.slice(0, 120));

	const drawn = await page.evaluate(() => window.DaimondImprove.listing());
	check('the listing was read, newest first, and says how many there are',
		drawn.total >= 12 && drawn.shown.length >= 12 && drawn.shown[0] > drawn.shown[1],
		JSON.stringify(drawn).slice(0, 160));

	// 8. BY NAME: this row, and what it says about itself. The corpus is seeded,
	// so proposal 3 is `accepted` and its tally is the corpus's own.
	const three = page.locator('.imp-prop[data-prop="3"]');
	const threeState = await three.getAttribute('data-state');
	const threeRow = await three.locator('.imp-prop-row').innerText();
	const threeRec = await page.evaluate(() => window.DaimondImprove.proposal(3));
	check('the proposal that is being done says so, and says its own tally',
		threeState === 'accepted' && threeRow.indexOf(String(threeRec.votes.for)) !== -1,
		`state=${threeState} row=${JSON.stringify(threeRow)} votes=${JSON.stringify(threeRec.votes)}`);

	const seven = page.locator('.imp-prop[data-prop="7"]');
	check('and the one that is finished is drawn as done, not as open',
		await seven.getAttribute('data-state') === 'done',
		await seven.getAttribute('data-state'));

	await seven.locator('.imp-prop-row').click();
	await page.waitForTimeout(900);
	const sevenBody = await page.evaluate(() =>
		document.querySelector('.imp-prop[data-prop="7"] .imp-prop-body').textContent.replace(/\s+/g, ' '));
	const sevenRec = await page.evaluate(() => window.DaimondImprove.proposal(7));
	check('opening it reads it in full, and it names the mark that closed it',
		sevenBody.indexOf(sevenRec.mark) !== -1 && sevenBody.indexOf(sevenRec.body.slice(0, 24)) !== -1,
		sevenBody.slice(0, 140));
	// Contract §5, on the surface and not in a help page: a reader looking at a
	// proposal closed by a change to the code is the reader who asks whether a
	// note followed it.
	check('and it says out loud that a note follows content only above 64 bytes',
		/64 bytes/.test(sevenBody) && /move/i.test(sevenBody),
		sevenBody.indexOf('64 bytes') === -1 ? 'not said' : 'said');
	check('and the body it read is the forge\'s own, not a placeholder',
		sevenBody.indexOf(sevenRec.body.slice(0, 24)) !== -1, sevenRec.body.slice(0, 40));

	// 7b. `mine` NULL: a voice asked, and has not voted. Two buttons, neither on.
	const voteBtns = seven.locator('.imp-vote');
	check('a voiced reader is offered both ways to vote, with neither pressed',
		await voteBtns.count() === 2
			&& await seven.locator('.imp-vote.on').count() === 0,
		`${await voteBtns.count()} buttons, ${await seven.locator('.imp-vote.on').count()} pressed`);

	// 6. The vote itself.
	//
	// EVERY INTERACTION INSIDE THAT ROW RE-OPENS IT FIRST if something shut it.
	// Whether VOTING shuts it is a check of its own, below, and it is measured
	// with no re-opening in between -- but a row shut before the vote was even
	// cast turns the click into a Playwright timeout, and the run then ENDS
	// THERE, reporting nothing about that check and nothing about the twenty
	// after it. A break that crashes the run is a break that proves nothing, and
	// a crash reads like a red for the wrong reason.
	const openSeven = async () => {
		if (await seven.locator('.imp-prop-body').isVisible()) return;
		await seven.locator('.imp-prop-row').click();
		await page.waitForTimeout(400);
	};
	await openSeven();
	const beforeVote = votes().length;
	await seven.locator('.imp-vote[data-dir="do"]').click();
	await page.waitForTimeout(1000);
	check('a vote is cast when it is pressed',
		votes().length === beforeVote + 1, `${votes().length - beforeVote}`);
	const lastVote = votes()[votes().length - 1] || { body: '' };
	check('and its WHOLE body is the one field the forge reads, and says which way',
		lastVote.body === 'd=1', JSON.stringify(lastVote.body));

	const afterVote = await page.evaluate(() => window.DaimondImprove.proposal(7));
	check('and the tally the panel draws came back with the answer, not from a guess',
		afterVote.mine === 1 && afterVote.votes.for === sevenRec.votes.for + 1,
		`mine=${afterVote.mine} for=${afterVote.votes.for} was=${sevenRec.votes.for}`);
	check('and the button is drawn as yours',
		await seven.locator('.imp-vote[data-dir="do"].on').count() === 1);

	// Voting redraws the list. The proposal being voted on must still be open
	// afterwards: the button that was pressed is INSIDE it.
	check('and the proposal being voted on is still open to read',
		await seven.locator('.imp-prop-body').isVisible());

	// Pressing the side you already chose takes it back off — `d=0`, which is
	// the only way back, and never an absent field.
	await openSeven();
	await seven.locator('.imp-vote[data-dir="do"]').click();
	await page.waitForTimeout(1000);
	const withdrawn = votes()[votes().length - 1] || { body: '' };
	check('pressing it again withdraws, and says so with a value rather than a silence',
		withdrawn.body === 'd=0', JSON.stringify(withdrawn.body));
	const afterOff = await page.evaluate(() => window.DaimondImprove.proposal(7));
	check('and the tally goes back down, from the answer',
		afterOff.mine === null && afterOff.votes.for === sevenRec.votes.for,
		`mine=${afterOff.mine} for=${afterOff.votes.for}`);
	check('NO REQUEST EVER SENT A VOTE WITHOUT A DIRECTION',
		votes().every(v => /(^|&)d=(1|-1|0)($|&)/.test(v.body)),
		votes().map(v => v.body).join(' | '));

	// A VOTE THE FORGE REFUSED IS NOT DRAWN AS THOUGH IT HAD BEEN COUNTED.
	// §9 puts the tally on the forge precisely so there is ONE store of truth;
	// a client that moved its own copy on a refusal would be showing the one
	// that is wrong, and nothing on the screen would say so. `_throttled-votes`
	// refuses votes and leaves the other budget alone, which is the shape a
	// separate vote budget has.
	const beforeRefused = await page.evaluate(() => window.DaimondImprove.proposal(7));
	asRepo = '_throttled-votes';
	await openSeven();
	await seven.locator('.imp-vote[data-dir="do"]').click();
	await page.waitForTimeout(1000);
	asRepo = '';
	const afterRefused = await page.evaluate(() => window.DaimondImprove.proposal(7));
	check('a vote the forge refused moves nothing, and the refusal is said',
		afterRefused.mine === beforeRefused.mine
			&& afterRefused.votes.for === beforeRefused.votes.for
			&& await page.locator('#improve-props .imp-err[data-why="throttled"]').count() === 1,
		`mine=${afterRefused.mine} for=${afterRefused.votes.for} `
			+ `was mine=${beforeRefused.mine} for=${beforeRefused.votes.for}`);

	// And the browser sent ITS OWN secret, on its own header. The stand-in
	// translates at the hop; what left the page must be what the page holds.
	// The property is that what LEFT is the browser's own secret, unaltered --
	// not that every write carried one, which is a different claim and is the
	// "Send is not offered without a voice" check's. Asserting both here made a
	// break about Keep redden this one too.
	const voiced = asked.filter(a => a.headers[HDR]);
	check('every request that carried a voice carried the browser\'s own, on x-daimond-voice',
		voiced.length > 0 && voiced.every(a => a.headers[HDR] === SECRET),
		`${voiced.length} voiced request(s)`);

	// ── 11. Saying something back ────────────────────────────────
	//
	await openSeven();
	const SAY = 'It also happens on a narrow window. quokka-marker-five';
	await seven.locator('.imp-reply').fill(SAY);
	await page.waitForTimeout(200);
	const beforeSaid = comments().length;
	await seven.locator('[data-act="improve-comment"]').click();
	await page.waitForTimeout(1200);
	check('a comment goes when the button beside it is pressed',
		comments().length === beforeSaid + 1, `${comments().length - beforeSaid}`);
	const said = comments()[comments().length - 1] || { body: '' };
	const fs5 = fields(said.body);
	check('and it carries exactly what was in that box, and nothing else',
		fs5.said === SAY && Object.keys(fs5).join(',') === 'said',
		JSON.stringify(said.body).slice(0, 160));
	const afterSaid = await page.evaluate(() => window.DaimondImprove.proposal(7));
	check('and the discussion the panel draws came back with the answer',
		afterSaid.discussion.some(d => d.said === SAY),
		String(afterSaid.discussion.length) + ' entries');

	await shot(s, 'improve-proposals' + (BREAK ? '-' + BREAK : ''));

	// ── 7a. `mine` ABSENT: the request carried no voice at all ───
	//
	// The same forge, the same repository, the same records — and no voice. The
	// answer then carries no `mine` AT ALL, which is a different fact from
	// `mine: null`, and the panel has to draw it differently or it offers an
	// unvoted button to somebody who cannot vote.
	await page.evaluate(() => { window.DaimondVoice.clear(); window.DaimondImprove.reset(); });
	await page.evaluate(() => window.DaimondImprove.load(false));
	await page.waitForTimeout(1200);
	const unvoiced = await page.evaluate(() => window.DaimondImprove.proposal(7));
	check('a read with no voice works at all — a public repository needs none',
		!!unvoiced, JSON.stringify(unvoiced && unvoiced.n));
	check('and the answer carries no `mine`, which is not the same as "has not voted"',
		unvoiced && unvoiced.asked === false, JSON.stringify(unvoiced && unvoiced.asked));
	const unvoicedVotes = await page.evaluate(() => {
		const e = document.querySelector('.imp-prop[data-prop="7"] .imp-votes');
		return e ? e.textContent.replace(/\s+/g, ' ').trim() : '';
	});
	check('so no vote button is drawn, and a line says why instead',
		await page.locator('.imp-prop[data-prop="7"] .imp-vote').count() === 0
			&& /voice/i.test(unvoicedVotes),
		JSON.stringify(unvoicedVotes));
	check('and the tally is still shown, because reading one needs no voice',
		/\d/.test(unvoicedVotes), JSON.stringify(unvoicedVotes));

	// ── 7c. DARK: a forge that answers no tally at all ───────────
	forge = FORGE.dark;
	await page.evaluate(() => { window.DaimondImprove.reset(); return window.DaimondImprove.load(false); });
	await page.waitForTimeout(1200);
	check('against a forge whose listing carries no tally, NO vote control is drawn',
		await page.locator('#improve-props .imp-votes').count() === 0,
		`${await page.locator('#improve-props .imp-votes').count()} drawn`);
	check('and the rows carry no tally value either, rather than a zero nothing counted',
		await page.locator('#improve-props .imp-prop-row .imp-prop-tally').count() === 0);
	forge = FORGE.main;

	// Put the voice back for what follows.
	await page.evaluate(async (sec) => { await window.DaimondVoice.set(sec); }, SECRET);

	// ── 8b. The nine refusals ────────────────────────────────────
	//
	// Each reached BY NAME through the mock, which makes every branch of §3.1
	// reachable on demand: a client that has never seen a refusal has not
	// handled one.
	const refusal = async (repo, token) => {
		asRepo = repo;
		await page.evaluate(() => { window.DaimondImprove.reset(); return window.DaimondImprove.load(false); });
		await page.waitForTimeout(700);
		const box = page.locator('#improve-props .imp-err');
		const n = await box.count();
		const why = n ? await box.getAttribute('data-why') : '';
		const text = n ? (await box.innerText()).trim() : '';
		asRepo = '';
		return { n, why, text };
	};

	const REFUSALS = [
		['_absent', 'absent'],
		['_unvoiced', 'unvoiced'],
		['_unknown', 'unknown'],
		['_unpermitted', 'unpermitted'],
		['_malformed', 'malformed'],
		['_no_proposal', 'no_proposal'],
		['_internal', 'internal'],
		['_throttled-address', 'throttled'],
	];
	const seen = {};
	for (const [repo, token] of REFUSALS) {
		const got = await refusal(repo, token);
		seen[token + ':' + repo] = got.text;
		check(`the refusal '${token}' is understood and SAID`,
			got.n === 1 && got.why === token && got.text.length > 10,
			`why=${got.why} said=${JSON.stringify(got.text.slice(0, 80))}`);
	}
	// The ninth. No path the panel takes sends a method the forge does not
	// answer, so it is reached through a forge that refuses that way — and a
	// token nobody has met is a token nobody has handled.
	forge = FORGE.unsup;
	{
		const got = await refusal('daimond', 'unsupported');
		check('the refusal \'unsupported\' is understood and SAID',
			got.n === 1 && got.why === 'unsupported' && got.text.length > 10,
			`why=${got.why} said=${JSON.stringify(got.text.slice(0, 80))}`);
	}
	forge = FORGE.main;

	// `absent` covers BOTH "no such repository" and "this repository is
	// private", permanently. So the sentence has to be true in both cases:
	// "there is no such repository" is false when it is private, and "this
	// repository is private" republishes exactly what is being withheld.
	const absentSaid = seen['absent:_absent'] || '';
	check('and `absent` is said in words that are true whether it is missing OR private',
		absentSaid.length > 10
			&& !/no such/i.test(absentSaid)
			&& !/does not exist/i.test(absentSaid)
			&& !/private/i.test(absentSaid),
		JSON.stringify(absentSaid));
	// And the private repository really is byte-identical at the far end, so a
	// panel could not tell them apart even if it wanted to.
	const privateSaid = (await refusal('_private', 'absent')).text;
	check('and a private repository is refused in exactly the same words',
		privateSaid === absentSaid, JSON.stringify(privateSaid));

	// `because` is branched on, so a tester refused for the ADDRESS is not told
	// it was their own voice.
	const byAddress = seen['throttled:_throttled-address'] || '';
	const byVoice = (await refusal('_throttled-voice', 'throttled')).text;
	check('and a throttle says which limit it was, without naming what it was spent on',
		byAddress !== byVoice
			&& /address/i.test(byAddress)
			&& !/submission|proposal|note|vote/i.test(byAddress)
			&& !/submission|proposal|note|vote/i.test(byVoice),
		JSON.stringify(byAddress) + ' | ' + JSON.stringify(byVoice));

	// ── 8c. Paging ───────────────────────────────────────────────
	forge = FORGE.pages;
	await page.evaluate(() => { window.DaimondImprove.reset(); return window.DaimondImprove.load(false); });
	await page.waitForTimeout(1000);
	let steps = 0;
	while (steps < 12) {
		const more = page.locator('#improve-props [data-act="improve-more"]');
		if (await more.count() === 0) break;
		await more.click();
		await page.waitForTimeout(800);
		steps++;
	}
	const walked = await page.evaluate(() => window.DaimondImprove.listing());
	check('the walk downwards ends, and ends having drawn every proposal',
		walked.done === true && walked.shown.length === 50 && walked.total === 50,
		`${walked.shown.length} of ${walked.total}, done=${walked.done}, ${steps} step(s)`);
	check('and the button to show more is gone rather than offering an empty page',
		await page.locator('#improve-props [data-act="improve-more"]').count() === 0);
	check('AND NOT ONE REQUEST ASKED FOR from=0, which means back to the newest',
		asked.every(a => a.query.from !== '0'),
		asked.filter(a => a.query.from === '0').map(a => a.url).join(' | '));

	// A forge that reads `from` as a LOWER bound hands the same page back for
	// ever, and every answer along the way looks perfectly valid. The walk has to
	// END anyway, or the panel offers to show more until somebody gives up.
	forge = FORGE.wrong;
	await page.evaluate(() => { window.DaimondImprove.reset(); return window.DaimondImprove.load(false); });
	await page.waitForTimeout(1000);
	const firstPage = (await page.evaluate(() => window.DaimondImprove.listing())).shown.length;
	await page.locator('#improve-props [data-act="improve-more"]').click();
	await page.waitForTimeout(1000);
	const wrapped = await page.evaluate(() => window.DaimondImprove.listing());
	check('against a forge that reads `from` the wrong way round, the walk STOPS rather than circling',
		wrapped.done === true && wrapped.shown.length === firstPage,
		`done=${wrapped.done}, ${firstPage} then ${wrapped.shown.length}`);
	check('and it stops offering to show more',
		await page.locator('#improve-props [data-act="improve-more"]').count() === 0);
	forge = FORGE.main;

	// ── 9. The panel's words are the guide's words ───────────────
	await page.evaluate(() => { window.DaimondImprove.reset(); return window.DaimondImprove.load(false); });
	await page.waitForTimeout(1000);

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

	const known = (n) => TERMS.has(n) || TERMS.has(n.replace(/s$/, ''));
	const coined = GUIDE_NOUNS.filter(n => !known(n.toLowerCase()));
	check(`and every part the guide names in bold is a word the glossary defines (${GUIDE_NOUNS.length} checked)`,
		coined.length === 0, coined.map(m => JSON.stringify(m)).join(', '));

	check('the panel does not call its box the composer',
		panelWords.toLowerCase().indexOf('composer') === -1);

	// ── 10. And it exists on a phone ─────────────────────────────
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

	// ── The secret is nowhere it should not be ───────────────────
	const leaked = wire.filter(r => (r.url + ' ' + r.body).indexOf(SECRET) !== -1
		&& r.url.indexOf('/api/improve') === -1);
	check('the voice is in no URL and in no body anywhere on the wire',
		leaked.length === 0 && asked.every(a => a.url.indexOf(SECRET) === -1),
		leaked.map(h => h.url).join(' | '));

	const errs = errors(s).filter(e =>
		!/Failed to load resource/.test(e)
		&& !(/blocked by CORS policy/.test(e) && /\/guide\//.test(e)));
	check('nothing above was reached by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	await shot(s, 'improve' + (BREAK ? '-' + BREAK : ''));
} finally {
	await s.close();
	stopForges();
}

console.log(`\nopens: ${opens().length}   votes: ${votes().length}   comments: ${comments().length}`
	+ `   improve requests: ${asked.length}   requests seen: ${wire.length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
