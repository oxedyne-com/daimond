// verify_rekey.mjs — a passphrase change carries EVERY secret across, and leaves
// none of them lying in memory afterwards.
//
// WHAT THIS IS FOR. Daimond seals a secret under a key derived from the user's
// passphrase (`DaimondIdentity.wrap` / `.unwrap`). Change the passphrase and the key
// is re-derived under a fresh salt, so anything sealed under the old one is opaque
// from that moment on — unless the code reads it out first and puts it back.
//
// Until 2026-08-14 `doChangePassphrase` re-wrapped exactly two things: `cfg.apiKeyEnc`
// and `cfg.pushTokenEnc` (plus re-sealing the passkey). It did NOT re-wrap the
// mailbox passwords in `www/js/mail.js`, the provider API keys in `www/js/models.js`,
// or the forge voice in `www/js/voice.js`. So changing the passphrase silently made
// every configured mailbox unopenable and took the app's model connection with it.
// Nothing said so — the notice claimed the opposite — and the first sign was a mailbox
// that had stopped working for no stated reason.
//
// Nor was that the whole of it. Every re-seal used to sit BELOW two blocks that could
// `return` on failure, so a failure re-wrapping the API key abandoned the push token,
// the passkey and (once mail arrived above them) the mailboxes as well. Those returns
// are gone: each secret is re-sealed in its own try/catch, every failure is collected,
// and one notice names all of them at the end.
//
// The properties, and the last three carry the weight:
//
//   1. A MAILBOX PASSWORD SURVIVES. After the change, what is stored unwraps under the
//      NEW passphrase to the same password it had before — measured after a reload and
//      a fresh unlock, so the key is derived from the new passphrase and not merely the
//      one already in memory.
//   2. SEVERAL MAILBOXES SURVIVE, not just the first. Named one at a time: "the
//      password stored for sam@example.com is still sam's password", never "two
//      entries were re-wrapped".
//   2a. A PROVIDER API KEY SURVIVES, and 2b SEVERAL PROVIDERS DO. Measured in the three
//      places the defect showed: the stored `keyEnc` opens to the key, `ready()` is
//      true, and `resolve('','')` hands back the key. That table is the shape the
//      original finding took, so it is the shape the check takes.
//   3. THE FORGE VOICE SURVIVES: `DaimondVoice.header()` hands back the same secret.
//   4. THE PLAINTEXTS DO NOT OUTLIVE THE CHANGE. `mail.js` holds them in a module-local
//      `rekey` map for the length of the change. Nothing outside that module can see the
//      map, and a flag claiming it is empty would prove nothing, so the hold is measured
//      by ASKING IT TO ACT: every stored password is replaced with a sentinel,
//      `resealAfterRekey()` is called again with `DaimondIdentity.wrap` spied on, and a
//      hold that is still there gives itself away twice — by wrapping a password this
//      file knows the text of, and by overwriting the sentinel.
//   5. A CHANGE THAT FAILS LEAVES NOTHING IN MEMORY EITHER. The failure path is driven
//      for real: the wrapped private key in storage is corrupted while the new-passphrase
//      dialog is open, so `DaimondIdentity.changePassphrase` genuinely returns
//      `{ ok: false }` after the passwords have been read out. (A wrong CURRENT
//      passphrase cannot be used for this: the first prompt validates it with
//      `DaimondIdentity.verify` and will not close, so the wrong-passphrase case never
//      reaches the code under test at all. That is a good design and an untestable
//      route; corrupting the key store reaches the same branch by the same door.)
//   6. THE STORED PASSWORD IS NEVER PLAINTEXT. Every localStorage key is read through
//      `Storage.prototype` — past the per-account shim in `accounts.js`, which shadows
//      `getItem` on the INSTANCE — and searched for each password and for the voice,
//      before the change, after it, and after a reload.
//   7. A FAILURE IN ONE SECRET CANNOT COST ANOTHER. The `apiKeyEnc` re-wrap is made to
//      fail from OUTSIDE the app (`DaimondIdentity.wrap` refuses the API key's own
//      plaintext and nothing else) against UNMODIFIED source, and then three secrets are
//      asked whether they survived: a mailbox and a provider key, both re-sealed ABOVE
//      the failing block, and THE PUSH TOKEN, which is re-sealed BELOW it. The push
//      token is the load-bearing third: it is the only secret in this file that a
//      reinstated `return` would cost, so without it the check would pass whatever
//      happened underneath.
//   8. THE CHANGE ALWAYS ENDS IN A NOTICE, AND THE NOTICE SAYS THE PASSPHRASE CHANGED
//      BEFORE IT NAMES WHAT FAILED. With the returns gone there is one exit, so a user
//      who stops reading after the first sentence has still been told the thing they
//      must not get wrong.
//   9. THE SEARCH KEY SURVIVES. `search.js` is `models.js` in miniature and it inherited
//      that file's hole with its shape: `setKey` sealed the key and nothing re-wrapped
//      it, so a passphrase change killed it and `unseal`'s empty-string catch made the
//      dead key indistinguishable from no key at all.
//
// AND THE THREE THAT MAKE THE REST SELF-ENFORCING. Checks 1-9 are each about one
// secret, and a check per secret is a list — the same hand-written list that was wrong
// four times over. These are about the CLASS:
//
//  10. EVERY MODULE THAT SEALS SAYS SO. The source is read for every caller of
//      `DaimondIdentity.wrap` / `.wrapBytes`, and a module holding one while
//      registering no participant and stating no exemption FAILS THE RUN. This is the
//      check that would have caught mail, models, voice and search on the day each was
//      written. It is proved on synthetic source first — an unregistered sealer, an
//      exempted one, a registration sitting in the WRONG file, a call in a comment, a
//      call in a string, and an empty tree — because a grep that matched nothing would
//      otherwise pass in silence, which is this defect wearing a verifier's coat.
//  11. EVERY REGISTERED PARTICIPANT IS RUN. Measured from OUTSIDE the registry, by
//      wrapping each live participant's own phases before the change and watching them
//      be called: a registry that reported on itself would be self-consistent and prove
//      nothing. This is also the only measurement of `chunks` and `sync`, whose effects
//      are not otherwise visible in a world with no gateway.
//  12. AND THE SEQUENCE CANNOT BE COST BY ONE PARTICIPANT. A probe that throws is
//      registered between two that record, and the ones after it must still run. The
//      probes also state the two structural promises: every phase is called with NO
//      ARGUMENTS (so no plaintext can arrive on one), the READ happens while the old
//      passphrase still verifies and the RESEAL after it does not (so the two phases
//      really do straddle the key swap), and the registry's own report carries names
//      and counts and none of the secrets this file knows the text of.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. The breaks patch the SOURCE UNDER
// TEST as it is served, the way `verify_capp.mjs` does:
//
//   node dev/verify_rekey.mjs --break nomail          # 1 and 2: mail is never read out
//   node dev/verify_rekey.mjs --break firstonly       # 2 only: 1 must stay GREEN
//   node dev/verify_rekey.mjs --break nomodels        # 2a and 2b: providers not re-sealed
//   node dev/verify_rekey.mjs --break modelfirstonly  # 2b only: 2a must stay GREEN
//   node dev/verify_rekey.mjs --break novoice         # 3 only
//   node dev/verify_rekey.mjs --break sticky          # 4 only: the hold is not cleared
//   node dev/verify_rekey.mjs --break stickyfail      # 5 only: the failure path forgets nothing
//   node dev/verify_rekey.mjs --break keyreturn       # 8 only: the notice leads with "Careful"
//   node dev/verify_rekey.mjs --break searchskip      # 9 only: the search key is not re-sealed
//   node dev/verify_rekey.mjs --break nosearch        # 9 and 10: search registers nothing
//   node dev/verify_rekey.mjs --break unregistered    # 10 only: a NEW sealer, registered nowhere
//   node dev/verify_rekey.mjs --break dupname         # the refusals check, and 9 with it
//   node dev/verify_rekey.mjs --break nochunks        # the chunk map is never dropped
//   node dev/verify_rekey.mjs --break lastonly        # 11 only: the last participant is skipped
//   node dev/verify_rekey.mjs --break abandon         # 12 and 7: a failure abandons the rest
//   node dev/verify_rekey.mjs                         # and then, clean
//
// FOUR OF THOSE REDDEN MORE THAN ONE CHECK, AND EVERY ONE OF THEM IS MEANT TO — but
// which, and why, is worth writing down, because a break that reddens six checks has
// not thereby tested six things.
//
//   nosearch   2: the module is absent from the running app, and its key dies. That IS
//                 the 2026-08-14 defect, in both of the places it showed.
//   dupname    2: the refusal is reported, and the key the refused registration would
//                 have saved dies. The refusals check is what this break exists to
//                 prove; the dead key follows from it. Note what STAYS GREEN: the
//                 running-app check reads the expected names out of the source, and
//                 this break edits the source, so it asks for a participant called
//                 'mail' and finds one. Two checks that each look sound can still
//                 agree with each other about the wrong thing — which is why the
//                 refusal is reported separately and not inferred from the names.
//   lastonly   2: the tail probe is never reached (11) — AND THE PUSH TOKEN DIES,
//                 because during the earlier armed change the last registered
//                 participant is `push` and not a probe. It CANNOT be isolated further:
//                 a loop that drops its last element drops a real secret, and a break
//                 that pretended otherwise would be a gentler fault than the one being
//                 guarded against.
//   abandon    5: this is the regression the whole restructure exists to prevent, and
//                 the spread is the point. It costs the push token (7), the sentence
//                 about the API key and therefore its control and check 8, and every
//                 probe after the one that threw (11 and 12). Note that the CHEAPEST of
//                 those — the control looking for the API key's sentence — goes red
//                 first; a run that stopped there would have proved nothing about 11
//                 and 12, which is why they are asserted separately and reported above.
//
// Where a break can be isolated it is: `searchskip` moves 9 without 10, `unregistered`
// moves 10 without 9, `nochunks` moves the chunk check alone, and `keyreturn` moves the
// notice's shape without costing a single secret.
//
// `firstonly` is the one that keeps check 2 honest. A break that re-seals nothing
// reddens 1 and 2 together, and then "several mailboxes survive" has never been tested
// as anything but a second spelling of "a mailbox survives". `firstonly` re-seals
// state.accounts[0] and stops, so 1 stays green and only 2 moves. `modelfirstonly` does
// the same job for 2b against 2a, and `stickyfail` for 5 against 4: it touches the
// FAILURE path only, so 4 — which is measured on a change that succeeded — stays green.
//
// `earlyreturn` IS GONE, AND ITS ABSENCE IS THE RESULT. It used to move the re-seal
// below the `apiKeyEnc` block and make that block fail, and it reddened five checks at
// once because the secrets were neither re-sealed nor forgotten. Its anchor — an
// `if (plain) { … return; }` — no longer exists: nothing between the change and the
// notice returns or throws out any more, so no ONE-LINE regression can make one
// secret's failure cost a secret above it. What remains constructible is `keyreturn`,
// which reinstates the deleted `return` in the API key's catch, and what it costs is
// the push token BELOW it — never the mail, the voice or the providers above. That
// asymmetry is the whole of the change, and it is why check 7 now asks about a secret
// on each side of the failure rather than only about the mailbox.
//
// Needs a world: `dev/serve.mjs` and `dev/mockllm.mjs`. No gateway.
//
//   eval "$(bash dev/world.sh 14 --env)"
//   node dev/verify_rekey.mjs
//
// A verifier run WITHOUT that eval drives world 0 on :8777 and does not warn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, PASS } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The old behaviour: the mailbox passwords are never read out from under the
	// passphrase that is about to change. Broken at the READ and not at the re-seal,
	// so that nothing is held either — which is what the code did before the fix, and
	// keeps this break off check 4.
	nomail: {
		file: 'js/mail.js',
		find: "			read:   unsealForRekey,",
		with: "			read:   function () { return { held: 0, failed: [] }; },	// break nomail",
	},
	// Only the first mailbox is re-sealed. Check 1 must stay green under this, or
	// check 2 was never asking about "several".
	firstonly: {
		file: 'js/mail.js',
		find: "			for (var i = 0; i < state.accounts.length; i++) {\n"
			+ "				var a = state.accounts[i];\n"
			+ "				if (!a || !a.address) continue;",
		with: "			for (var i = 0; i < 1; i++) {\n"
			+ "				var a = state.accounts[i];\n"
			+ "				if (!a || !a.address) continue;",
	},
	// The voice is not read out, so it is not put back.
	novoice: {
		file: 'js/voice.js',
		find: "			read:   readForRekey,",
		with: "			read:   function () { return { held: 0, failed: [] }; },	// break novoice",
	},
	// The passwords stay in the module after they have been put back.
	sticky: {
		file: 'js/mail.js',
		find: "		} finally { rekey = null; }		// in the clear; never held past here",
		with: "		} finally { /* break sticky: the hold is kept */ }",
	},
	// A change that failed leaves them held.
	stickyfail: {
		file: 'js/daimond.js',
		find: "			try { DaimondRekey.forgetAll(); } catch (e) { /* each one caught its own */ }",
		with: "			// break stickyfail: the failure path forgets nothing",
	},
	// The provider keys are never re-sealed: the defect of 2026-08-14, exactly as it
	// was found. Checks 2a and 2b must reproduce all three of its symptoms.
	nomodels: {
		file: 'js/models.js',
		find: "			reseal: resealAfterRekey,",
		with: "			reseal: function () { return { failed: [] }; },	// break nomodels",
	},
	// Only the first provider holding a key is re-sealed. Counted AFTER the keyless
	// `continue`, so a keyless provider sitting first in the store cannot absorb the
	// allowance and turn 2a red as well — which would put this break on the wrong
	// check and leave 2b untested.
	//
	// TWO SITES, because the allowance has to be declared in one place and spent in
	// another — and this break was found ALREADY STALE on 2026-08-14: its anchor still
	// read `var failed = [];` and the line had become `var failed = [], unread = [];`
	// hours earlier, when the already-unreadable case was added. `--break` refuses an
	// anchor it cannot find and says so, so nothing passed in silence; but a break that
	// cannot be applied is a check with nothing behind it, and the only reason anybody
	// learned is that somebody ran the whole matrix.
	modelfirstonly: [
		{
			file: 'js/models.js',
			find: "		var failed = [], unread = [];",
			with: "		var failed = [], unread = [], _n = 0;		// break modelfirstonly",
		},
		{
			file: 'js/models.js',
			find: "			try {\n"
				+ "				p.keyEnc = await DaimondIdentity.wrap(key);",
			with: "			if (_n++ >= 1) continue;			// break modelfirstonly\n"
				+ "			try {\n"
				+ "				p.keyEnc = await DaimondIdentity.wrap(key);",
		},
	],
	// THE OLD EXIT COMES BACK: a failure ends in a bare "Careful" that never says the
	// passphrase changed. What it costs now is only the sentence — the secrets are all
	// re-sealed above this line, inside the registry — so it moves check 8 alone, where
	// once it would have taken the push token with it. That narrowing IS the
	// restructure, and this break is what states it.
	keyreturn: {
		file: 'js/daimond.js',
		find: "		catch (e) { put = { sentences: [t('changepass.rekey_failed')] }; }",
		with: "		catch (e) { put = { sentences: [t('changepass.rekey_failed')] }; }\n"
			+ "		if (put.sentences.length) { noticeDialog(t('changepass.careful'), put.sentences.join(' ')); return; }",
	},
	// THE REGRESSION THE REGISTRY EXISTS TO PREVENT: the reseal loop returns on the
	// first failure, so one refused secret abandons every participant below it. Reddens
	// check 7 (the push token, registered after the API key) and check 12 (the probes
	// after the one that throws) — and it should redden both, because that is the whole
	// of what the fault does.
	abandon: {
		file: 'js/rekey.js',
		find: "			if (r.failed.length) {\n"
			+ "				out.failed.push({ name: p.name, list: r.failed });\n"
			+ "				out.sentences.push(say(p, 'failed', r.failed));\n"
			+ "			}\n"
			+ "		}\n"
			+ "		return out;\n"
			+ "	}\n"
			+ "\n"
			+ "	/// Drop every plaintext held",
		with: "			if (r.failed.length) {\n"
			+ "				out.failed.push({ name: p.name, list: r.failed });\n"
			+ "				out.sentences.push(say(p, 'failed', r.failed));\n"
			+ "				return out;					// break abandon\n"
			+ "			}\n"
			+ "		}\n"
			+ "		return out;\n"
			+ "	}\n"
			+ "\n"
			+ "	/// Drop every plaintext held",
	},
	// A participant is registered and never reached. An off-by-one in the loop, which
	// is the smallest thing that produces the old defect from the new shape: the list
	// is right and the walk over it is not. The probes register last, so what this
	// drops is the tail probe and nothing a person owns.
	lastonly: {
		file: 'js/rekey.js',
		find: "		var out = { ran: [], failed: [], unread: [], sentences: [] };\n"
			+ "		for (var i = 0; i < parts.length; i++) {",
		with: "		var out = { ran: [], failed: [], unread: [], sentences: [] };\n"
			+ "		for (var i = 0; i < parts.length - 1; i++) {		// break lastonly",
	},
	// THE LIVE BUG OF 2026-08-14, in the file it was still live in that morning:
	// search.js seals a key and registers nothing. The source check must see a sealer
	// that says nothing, and the key must die — both, because both are true of it.
	nosearch: {
		file: 'js/search.js',
		find: "	if (window.DaimondRekey) {\n"
			+ "		DaimondRekey.register({\n"
			+ "			name:   'search',",
		with: "	if (false) {\n"
			+ "		DaimondRekey.register({\n"
			+ "			name:   'search',",
	},
	// Registered, and the re-seal walks nothing. Check 9 moves and the source check
	// stays green, which is what makes 9 a measurement of the key rather than a second
	// spelling of "the registration is there".
	searchskip: {
		file: 'js/search.js',
		find: "		var failed = [], unread = [];\n"
			+ "		for (var id in store.keys) {",
		with: "		var failed = [], unread = [];\n"
			+ "		for (var id in {}) {					// break searchskip",
	},
	// Two participants under one name. The second is REFUSED rather than replacing the
	// first, so `refusals()` must not be empty — and the search key, whose registration
	// this is, is not re-sealed at all.
	dupname: {
		file: 'js/search.js',
		find: "			name:   'search',",
		with: "			name:   'mail',						// break dupname",
	},
	// The chunk map is kept, so the next offload points a fresh manifest at ciphertext
	// sealed under a passphrase that no longer exists.
	nochunks: {
		file: 'js/chunks.js',
		find: "			reseal: forgetMapAfterRekey,",
		with: "			reseal: function () { return { failed: [] }; },	// break nochunks",
	},
	// A NEW module that seals and says nothing about it — the shape every one of the
	// four defects took on the day it was written. It is added to the source the
	// scanner reads rather than to a file that exists, because what is being proved is
	// that the scanner CAN see one: a check that has only ever run against a tree where
	// every module already registers has never been shown to fail at all.
	unregistered: {
		add:  'js/newsealer.js',
		body: "(function () {\n"
			+ "	'use strict';\n"
			+ "	async function keep(v) { return await DaimondIdentity.wrap(v); }\n"
			+ "	window.DaimondNewSealer = { keep: keep };\n"
			+ "})();\n",
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── The fixtures ────────────────────────────────────────────────────
//
// Three mailboxes, because "several survive" cannot be asked of one, and the
// passwords are distinctive strings so that the storage sweep in check 6 is looking
// for something that could not be there by accident.
const BOXES = [
	{ address: 'alpha@example.com', pass: 'alpha-mailbox-secret-91c4f' },
	{ address: 'sam@example.com',   pass: 'sam-mailbox-secret-7b2ed' },
	{ address: 'gamma@example.com', pass: 'gamma-mailbox-secret-4d8ac' },
];
// A voice as the forge issues one: graphic ASCII, comfortably over DaimondVoice.MIN.
const VOICE = 'V01ceSecretForTheForge-abcdefghijklmnopqrs';
// A SECOND provider, so "several providers survive" is a question with an answer. The
// first is the one `connectMock` configured, and it is also the default — which is why
// the check on it can read `ready()` and `resolve()` and the check on this one cannot.
const P2_ID   = 'custom:http://127.0.0.1:9199/v1/chat/completions';
const P2_NAME = 'Second provider';
const P2_KEY  = 'second-provider-key-6f3ba';
// The push token: the one secret in this file re-sealed BELOW the API key block.
const PUSHTOK = 'push-token-secret-2ae71';
// The search key. `brave` because it is a KNOWN engine that is not `credits`, and
// `credits` is the one id `setKey` refuses — its key belongs to the gateway.
const S_ENGINE = 'brave';
const S_KEY    = 'search-service-key-5c19d';
const NEW1  = 'a first new passphrase for the rekey test';
const NEW2  = 'a second new passphrase that never takes';

// ── The broken source, served AND scanned ───────────────────────────
//
// One edit, two readers. The browser is served the patched file, and the source scan
// of check 10 reads the SAME patched text — otherwise a break would move the app and
// leave the scanner reading a tree nobody was running, which is a verifier measuring
// two different programs and reporting one number.
const EDITED = new Map();	// served path -> patched body
const ADDED  = new Map();	// a module that exists only for the scanner
(function applyBreak() {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	if (!spec) { console.error(`no such break: ${BREAK}`); process.exit(2); }
	// A break may name several sites, and every one of them has to land: a break that
	// reached only one of two guards would leave the other holding, go green, and be
	// reported as a check that cannot fail when it was never tested.
	const sites = Array.isArray(spec) ? spec : [spec];
	for (const site of sites) {
		if (site.add) { ADDED.set(site.add, site.body); continue; }
		const src = EDITED.get(site.file) || fs.readFileSync(path.join(WWW, site.file), 'utf8');
		const n = src.split(site.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${site.file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		EDITED.set(site.file, src.replace(site.find, site.with));
	}
})();

async function routeBreak(page) {
	for (const [file, body] of EDITED) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── Check 10: every module that seals says so ───────────────────────
//
// Read the source, find every caller of the sealing API, and fail on one that neither
// registers a participant nor states an exemption in the SAME FILE. Same file is the
// point: a list of exempt modules kept in this verifier would drift from the source it
// exempts within a month, and the first thing to go stale would be the entry for
// whichever module had just changed.

/// Where a `/` may begin a regular expression rather than a division.
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%~^<>]$/;
const REGEX_WORD   = /\b(return|typeof|case|in|of|new|delete|void|do|else|yield|await)$/;

/// The source with comments, string literals and regular expressions removed.
///
/// All three matter. Half the files here MENTION `DaimondIdentity.wrap()` in a doc
/// comment — sync.js does it in its second paragraph — so a scan of the raw text would
/// call every one of them a sealer and then be satisfied by registrations that are
/// themselves only described in prose.
///
/// THE REGULAR EXPRESSIONS ARE NOT PEDANTRY, and this is written down because leaving
/// them out silently broke this scan on its first run. `mail.js` line 149 escapes HTML
/// with `/[&<>"']/g`; a scanner that knows about quotes and not about regexes reads
/// that `"` as the start of a string and swallows the next four thousand characters —
/// which happened to include mail.js's own registration. The check went red on a file
/// that was correct, and had the swallowed span held the `wrap` call instead it would
/// have gone GREEN on a file that was not. A scanner that cannot read the language it
/// polices fails in whichever direction the text happens to fall.
/// `keepText` keeps what is INSIDE the string literals, for reading the name out of a
/// registration; the seal and registration checks themselves are made against the view
/// that drops it, so a module cannot register by mentioning one in a sentence.
function stripped(src, keepText) {
	let out = '', i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i], d = src[i + 1];
		if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
		if (c === '/' && d === '/') { const e = src.indexOf('\n', i);     i = e < 0 ? n : e;     out += ' '; continue; }
		if (c === '"' || c === "'" || c === '`') {
			const q = c, from = i; i++;
			while (i < n && src[i] !== q) { i += (src[i] === '\\') ? 2 : 1; }
			i++;
			out += keepText ? src.slice(from, Math.min(i, n)) : ' ' + q + q;
			continue;
		}
		if (c === '/') {
			const lead = out.replace(/\s+$/, '');
			if (lead === '' || BEFORE_REGEX.test(lead) || REGEX_WORD.test(lead)) {
				i++;
				let cls = false;						// inside a [...] class, where / is literal
				while (i < n) {
					const k = src[i];
					if (k === '\\') { i += 2; continue; }
					if (k === '[') cls = true;
					else if (k === ']') cls = false;
					else if (k === '/' && !cls) { i++; break; }
					else if (k === '\n') break;			// unterminated: not a regex after all
					i++;
				}
				out += ' /re/ '; continue;
			}
		}
		out += c; i++;
	}
	return out;
}

const SEALS  = /DaimondIdentity\s*\??\.\s*wrap(?:Bytes)?\s*\(/;
/// A COMPUTED reach into the identity module. The property name may be a string this
/// scan has already blanked, so what is caught is the bracket itself — `DaimondIdentity
/// ['wrap']` and a variable-keyed call alike. Nothing in the app does this today, so it
/// costs nothing; if something starts to, it is asked to register like everyone else,
/// which is the safe direction for a check to be wrong in.
const ODD    = /DaimondIdentity\s*\??\s*\[/;
const REGS   = /DaimondRekey\s*\.\s*register\s*\(/;
const EXEMPT = /DaimondRekey\s*\.\s*exempt\s*\(/;

/// The names a file registers under, read out of its own source.
const NAMED = /DaimondRekey\s*\.\s*register\s*\(\s*\{\s*name\s*:\s*['"]([A-Za-z0-9_-]+)['"]/g;

/// Which of these files seal, which of those say nothing about it, and what the ones
/// that do say call themselves.
///
/// `files` is `[{ name, src }]`, so the same function runs over the real tree and over
/// the synthetic fixtures that prove it can fail.
function scanSealers(files) {
	const sealers = [], quiet = [], claims = [];
	for (const f of files) {
		const s = stripped(f.src);
		if (!SEALS.test(s) && !ODD.test(s)) continue;
		sealers.push(f.name);
		if (!REGS.test(s) && !EXEMPT.test(s)) quiet.push(f.name);
		const text = stripped(f.src, true);
		let m;
		NAMED.lastIndex = 0;
		while ((m = NAMED.exec(text)) !== null) if (claims.indexOf(m[1]) < 0) claims.push(m[1]);
	}
	return { sealers, quiet, claims };
}

/// Every module the app is made of, as the browser is being served it.
function appSources() {
	const out = [];
	for (const name of fs.readdirSync(path.join(WWW, 'js')).sort()) {
		if (!name.endsWith('.js')) continue;
		const rel = 'js/' + name;
		out.push({ name: rel, src: EDITED.get(rel) || fs.readFileSync(path.join(WWW, rel), 'utf8') });
	}
	for (const [rel, src] of ADDED) out.push({ name: rel, src });
	return out;
}

/// The modules that seal something today. NAMED, not counted — a check that asserted
/// "seven sealers" would go red when a new one arrived and green again the moment
/// somebody deleted a different one.
const KNOWN_SEALERS = [
	'js/chunks.js', 'js/daimond.js', 'js/mail.js', 'js/models.js',
	'js/search.js', 'js/sync.js', 'js/voice.js',
];

const s = await open({ name: 'rekey', connect: true, route: routeBreak });
const { page } = s;

// ── Driving the change the way a person does ────────────────────────
//
// Account menu, "Change passphrase…", the current passphrase, then the new one typed
// rather than generated — the generated path is verify_changepass's subject, and a
// known new passphrase is what lets this file unlock again afterwards.
async function changePassphrase(cur, next, before) {
	await page.evaluate(() => document.getElementById('user-row').click());
	await sleep(250);
	await page.evaluate(() => {
		const b = [...document.querySelectorAll('#admin-home .admin-item')]
			.find(x => /Change passphrase/.test(x.textContent));
		if (!b) throw new Error('no "Change passphrase" item in the account menu');
		b.click();
	});
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', cur);
	await page.click('.dlg-ok');
	await page.waitForSelector('#cp-modal', { timeout: 10000 });
	await sleep(200);
	if (before) await before();
	await page.click('#cp-modal .id-choose');
	await sleep(150);
	await page.fill('#cp-modal #cp-pass', next);
	await page.fill('#cp-modal #cp-pass2', next);
	await page.click('#cp-modal .dlg-ok');
	await page.waitForSelector('#cp-modal', { state: 'detached', timeout: 15000 });
	// Whatever notice follows — changed, failed, or "be careful" — its words are the
	// only thing on screen that says which path ran. A notice that never arrives is
	// returned as '' rather than thrown, so that check 8 fails with one clean red
	// instead of the whole run collapsing into "the run completed".
	const came = await page.waitForSelector('.dlg .dlg-ok', { timeout: 15000 })
		.then(() => true).catch(() => false);
	if (!came) return { head: '', body: '' };
	// The HEADING separately, because it is the half that says which exit was taken —
	// and reading it out of the body would have the check turn on the difference
	// between "Passphrase changed" and "The passphrase changed, but…", which is one
	// capital letter.
	const said = await page.evaluate(() => {
		const d = document.querySelector('.dlg');
		const h = d && d.querySelector('h2');
		const flat = (n) => (n ? (n.innerText || '') : '').replace(/\s+/g, ' ').trim();
		return { head: flat(h), body: flat(d) };
	});
	await page.click('.dlg .dlg-ok');
	await sleep(300);
	return said;
}

/// Unlock after a reload, with a passphrase this file chose.
async function unlockWith(pass) {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#id-primary', { timeout: 15000 });
	await page.waitForTimeout(400);
	await page.fill('#id-pass', pass);
	await page.evaluate(() => document.getElementById('id-primary').click());
	const opened = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 })
		.then(() => true).catch(() => false);
	await page.waitForTimeout(600);
	return opened;
}

/// What the password stored for `address` opens to, under the key in force now.
function opened(address) {
	return page.evaluate(async (addr) => {
		const j = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const a = (j.accounts || []).find(x => x.address === addr);
		if (!a) return { err: 'no such mailbox is stored' };
		if (!a.pass) return { err: 'the stored password is empty' };
		try { return { text: await DaimondIdentity.unwrap(a.pass) }; }
		catch (e) { return { err: String((e && e.message) || e) }; }
	}, address);
}

/// What the provider store holds, in the three places the 2026-08-14 defect showed.
///
/// The stored `keyEnc` is opened here rather than asked of the module, because
/// `models.js` keeps a decrypted copy in its `plain` map for the length of an unlocked
/// session: a check that only asked the module would pass on that copy while the thing
/// on disk was already unopenable, and would go red one reload later on somebody's
/// laptop instead of here. `ready()` and `resolve()` are read as well, because they are
/// what the user meets — a false `ready()` is the app saying it has no model.
function providerState() {
	return page.evaluate(async () => {
		const g  = (k) => Storage.prototype.getItem.call(localStorage, k);
		const mv = JSON.parse(g('daimond-models-v2') || '{}');
		const out = { order: [], providers: {}, ready: false, resolved: null };
		for (const id in (mv.providers || {})) {
			const p = mv.providers[id];
			out.order.push(id);
			let opens = '(no keyEnc)';
			if (p.keyEnc) {
				try { opens = await DaimondIdentity.unwrap(p.keyEnc); }
				catch (e) { opens = 'UNREADABLE:' + ((e && e.name) || e); }
			}
			out.providers[id] = { name: p.name || '', opens, plaintext: String(p.key || '') };
		}
		out.ready = !!DaimondModels.ready();
		const r = DaimondModels.resolve('', '');
		out.resolved = r ? String(r.apiKey || '') : null;
		return out;
	});
}

/// What the stored search key opens to, and what the module says about it.
///
/// The stored `keyEnc` first, for the same reason the provider check reads it: `plain`
/// keeps a decrypted copy for the length of an unlocked session, so a check that asked
/// only the module would pass on that copy while the thing on disk was already dead —
/// and would go red one reload later, on somebody's laptop.
function searchState(id) {
	return page.evaluate(async (engine) => {
		const g = (k) => Storage.prototype.getItem.call(localStorage, k);
		const j = JSON.parse(g('daimond-search-v1') || '{}');
		const row = (j.keys || {})[engine] || null;
		const out = { has: !!row, opens: '(no keyEnc)', plaintext: '', says: '' };
		if (row && row.keyEnc) {
			try { out.opens = await DaimondIdentity.unwrap(row.keyEnc); }
			catch (e) { out.opens = 'UNREADABLE:' + ((e && e.name) || e); }
		}
		if (row) out.plaintext = String(row.key || '');
		// What the app itself would use for a search, which is the half the user meets.
		out.says = String(DaimondSearch.key(engine) || '');
		return out;
	}, id);
}

/// What the stored push token opens to.
function pushNow() {
	return page.evaluate(async () => {
		const b = JSON.parse(localStorage.getItem('daimond-byok') || '{}');
		if (!b.pushTokenEnc) return { err: 'nothing is stored' };
		try { return { text: await DaimondIdentity.unwrap(b.pushTokenEnc) }; }
		catch (e) { return { err: String((e && e.name) || e) }; }
	});
}

/// The voice, as a request would ask for it.
function voiceNow() {
	return page.evaluate(async () => {
		try {
			const h = await DaimondVoice.header();
			return { text: h[DaimondVoice.HEADER] || '' };
		} catch (e) { return { err: String((e && e.message) || e) }; }
	});
}

/// Every localStorage value that carries one of these strings in the clear.
///
/// Read through `Storage.prototype`: `accounts.js` shadows `getItem` on the instance
/// to namespace `daimond-*` keys per account, so a shimmed read of a key that is
/// already namespaced would look somewhere that does not exist and find nothing.
function plaintextHits(needles) {
	return page.evaluate((ns) => {
		const get = Storage.prototype.getItem, key = Storage.prototype.key;
		const hits = [];
		for (let i = 0; i < localStorage.length; i++) {
			const k = key.call(localStorage, i);
			const v = get.call(localStorage, k) || '';
			for (const n of ns) if (v.indexOf(n.text) >= 0) hits.push(`${n.what} in ${k}`);
		}
		return hits;
	}, needles);
}

/// Is `mail.js` still holding the plaintexts?
///
/// Nothing outside that module can see the `rekey` map, so this asks it to ACT on
/// whatever it is holding and watches what happens. Every stored password is replaced
/// with a sentinel first, so a hold that is still there is caught twice over: by the
/// call it makes (a `wrap` of a password this file knows the text of) and by the write
/// it performs (the sentinel overwritten). Then the real stored values go back, so the
/// checks after this measure the change and not the probe.
function heldNow() {
	return page.evaluate(async (boxes) => {
		const SENT = 'SENTINEL-not-a-wrapped-password';
		const raw  = localStorage.getItem('daimond-mail') || '{}';
		const was  = {};
		JSON.parse(raw).accounts.forEach(x => { was[x.address] = String(x.pass || ''); });

		const stamped = JSON.parse(raw);
		stamped.accounts.forEach(x => { x.pass = SENT; });
		localStorage.setItem('daimond-mail', JSON.stringify(stamped));
		window.DaimondMail.reload();

		const real = DaimondIdentity.wrap;
		const seen = [];
		DaimondIdentity.wrap = async function (v) { seen.push(String(v)); return await real(v); };
		let ret = null;
		try { ret = await DaimondMail.resealAfterRekey(); }
		catch (e) { ret = { err: String((e && e.message) || e) }; }
		DaimondIdentity.wrap = real;

		const after = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		const wrote = (after.accounts || [])
			.filter(x => String(x.pass || '') !== SENT).map(x => x.address);

		const back = JSON.parse(localStorage.getItem('daimond-mail') || '{}');
		back.accounts.forEach(x => { if (was[x.address] != null) x.pass = was[x.address]; });
		localStorage.setItem('daimond-mail', JSON.stringify(back));
		window.DaimondMail.reload();

		return {
			// Named, not counted: which mailbox's password is still in memory.
			leaked: boxes.filter(b => seen.indexOf(b.pass) >= 0).map(b => b.address),
			wrote,
			ret,
		};
	}, BOXES);
}

try {
	// ── Check 10, and first: the instrument, on source it must fail ──
	//
	// Six fixtures, and the first three are the ones that matter. A scan that cannot
	// see an unregistered sealer would pass every day for ever without once having
	// looked, and that is precisely the failure being fixed — so it is shown failing
	// before it is believed.
	const fx = (name, src) => ({ name, src });
	const sawQuiet = (files) => scanSealers(files).quiet;
	const sawSeal  = (files) => scanSealers(files).sealers;

	check('the scan SEES a sealer that registers nothing',
		sawQuiet([fx('js/newthing.js', 'async function f(v) { return await DaimondIdentity.wrap(v); }')])
			.join() === 'js/newthing.js',
		'an unregistered sealer is reported');
	check('the scan ACCEPTS a sealer that states an exemption',
		sawQuiet([fx('js/newthing.js', 'async function f(v) { return await DaimondIdentity.wrapBytes(v); }\n'
			+ 'DaimondRekey.exempt("newthing", "sealed at the moment of sending; never read back");')]).length === 0,
		'an exemption at the site is enough');
	// The drift trap: a registration in ANOTHER file must not answer for this one.
	// A list kept anywhere but beside the seal is a list that will one day be wrong
	// about the module it names, and nothing will say so.
	check('the scan does NOT accept a registration in a different file',
		sawQuiet([fx('js/a.js', 'DaimondIdentity.wrap(v)'), fx('js/b.js', "DaimondRekey.register({ name: 'a' })")])
			.join() === 'js/a.js',
		'the registration has to be where the sealing is');
	// The bug this scan had on its first run, kept as a check because a scanner that
	// mis-reads the language can fail in either direction and only one of those is
	// visible. See `stripped`.
	check('a regex holding a quote does not blind the scan to what follows it',
		sawQuiet([fx('js/f.js', 'var re = /[&<>"\']/g;\nDaimondIdentity.wrap(v);\n'
			+ "DaimondRekey.register({ name: 'f' });")]).length === 0
			&& sawSeal([fx('js/g.js', 'var re = /[&<>"\']/g;\nDaimondIdentity.wrap(v);')]).join() === 'js/g.js',
		'the seal and the registration are both still visible after it');
	// What it can and cannot see, stated as a check rather than as a claim. The first
	// two are the spellings a person might reasonably write; the third is the one this
	// cannot follow, and it is written down here so that nobody reads a green run as
	// proof that no such call exists.
	check('the scan follows the spellings a seal is actually written in',
		sawSeal([fx('js/h.js', 'await DaimondIdentity\n\t.wrap(v)'),
			fx('js/i.js', "await DaimondIdentity?.wrap(v)"),
			fx('js/j.js', "await DaimondIdentity['wrapBytes'](v)")]).length === 3,
		'a line break, an optional chain and a computed name are all still a seal');
	// WHAT IT CANNOT SEE, and no check is written for it because a check that asserted
	// the limitation would go red the day somebody removed it: a seal reached through
	// an ALIAS — `var W = DaimondIdentity.wrap; await W(v)` — is invisible to any
	// regex, and so is a module that seals by calling a helper in another file. What
	// covers those is that the alias would have to be written deliberately, and that
	// the registry is one lookup away at the same call site.
	check('the scan does not count a seal that is only DESCRIBED',
		sawSeal([fx('js/c.js', '// see DaimondIdentity.wrap(v) for how this is stored\n'),
			fx('js/d.js', '/* DaimondIdentity.wrap(v) */'),
			fx('js/e.js', 'var s = "DaimondIdentity.wrap(";')]).length === 0,
		'comments and strings are not code');
	// The check that stops this from being satisfiable by accident. Everything above
	// asks whether the scan can fail; this asks whether it can pass for having found
	// nothing at all — which is how a grep-based check dies quietly.
	check('an empty tree is a FAILURE, not a clean scan',
		sawSeal([]).length === 0 && KNOWN_SEALERS.length > 0,
		'zero sealers means the scan is broken, and is reported as such below');

	const scan = scanSealers(appSources());
	const lost = KNOWN_SEALERS.filter(n => scan.sealers.indexOf(n) < 0);
	check('the scan found the modules that seal',
		scan.sealers.length > 0 && lost.length === 0,
		scan.sealers.length === 0 ? 'IT FOUND NONE — the scan itself is broken'
			: lost.length ? `it did not see ${lost.join(', ')}, which do seal`
			: scan.sealers.join(', '));
	check('EVERY MODULE THAT SEALS EITHER REGISTERS OR SAYS WHY NOT',
		scan.quiet.length === 0,
		scan.quiet.length ? `seals and says nothing: ${scan.quiet.join(', ')}`
			: `${scan.sealers.length} sealers, all accounted for`);

	// ── Seed: three mailboxes and a voice, sealed under the passphrase in force ──
	await page.waitForSelector('#user-row', { timeout: 15000 });
	await page.evaluate(async (a) => {
		const accounts = [];
		for (const m of a.boxes) {
			accounts.push({
				address: m.address, host: 'imap.test.local', port: 993, user: m.address,
				pass: await DaimondIdentity.wrap(m.pass),
				folder: 'INBOX',
				folders: { INBOX: { dir: 'INBOX', uidValidity: 0, lastUid: 0, firstUid: 0,
					heldBack: 0, limit: 0, lastSync: 0 } },
			});
		}
		localStorage.setItem('daimond-mail',
			JSON.stringify({ accounts, sel: accounts[0].address }));
		window.DaimondMail.reload();
		await DaimondVoice.set(a.voice);
		// A second provider beside the one connectMock configured. Added through the
		// module's own doors, so what is measured afterwards is a key stored the way
		// the app stores one.
		if (!DaimondModels.providers().some(p => p.id === a.p2.id)) {
			DaimondModels.addProvider(a.p2.id, { name: a.p2.name, url: a.p2.url });
		}
		await DaimondModels.setKey(a.p2.id, a.p2.key);
		// The search key, through the module's own door: `setKey` seals it, and that is
		// the line that had nothing putting it back.
		await DaimondSearch.setKey(a.s.engine, a.s.key);
		// A map entry standing in for a chunk already in the cloud store, sealed under
		// the passphrase about to go: nothing may offer it for reuse afterwards. A
		// plausible entry rather than an empty map, because a check on a map that was
		// empty to begin with would pass whatever the change did.
		localStorage.setItem('daimond-chunk-map', JSON.stringify({
			['0'.repeat(64)]: ['f'.repeat(64), 4096],
		}));
		localStorage.removeItem('daimond-chunk-stale');
	}, { boxes: BOXES, voice: VOICE, s: { engine: S_ENGINE, key: S_KEY },
		p2: { id: P2_ID, name: P2_NAME, key: P2_KEY, url: P2_ID.slice('custom:'.length) } });

	// WHO SAYS THEY TAKE PART. The source scan proves every sealer registers in its own
	// file; this proves the registration RAN. A module that index.html never loads, or
	// whose registration sits behind a condition that is false in a browser, satisfies
	// the source and is absent here — which is the gap neither check can see alone.
	const reg = await page.evaluate(() => ({
		names:   DaimondRekey.names(),
		refused: DaimondRekey.refusals(),
		exempt:  DaimondRekey.exemptions(),
	}));
	// WHAT MUST BE THERE IS READ OUT OF THE SOURCE, not written here. A list of expected
	// participants kept in this file would be the hand-written list all over again, one
	// directory along: it would go stale the first time somebody added a module, and it
	// would go stale silently, which is the whole complaint.
	const WANT = scan.claims;
	const absent = WANT.filter(n => reg.names.indexOf(n) < 0);
	check('every module that seals is registered IN THE RUNNING APP',
		absent.length === 0 && WANT.length > 0,
		absent.length ? `never registered: ${absent.join(', ')}`
			: WANT.length === 0 ? 'the source claims no participants at all, so this proved nothing'
			: reg.names.join(', '));
	check('and no registration was refused',
		reg.refused.length === 0,
		reg.refused.map(r => `${r.name}: ${r.why}`).join('; ') || 'all accepted');

	// The instrument, proved before anything is measured with it: every fixture is
	// readable NOW. A check that the password survives is worth nothing if the
	// password was never there.
	for (const b of BOXES) {
		const r = await opened(b.address);
		check(`fixture: ${b.address}'s password is sealed and readable before the change`,
			r.text === b.pass, r.err || JSON.stringify(r.text));
	}
	const v0 = await voiceNow();
	check('fixture: the forge voice is sealed and readable before the change',
		v0.text === VOICE, v0.err || JSON.stringify(v0.text));

	// The two providers, and which of them the store iterates FIRST — `modelfirstonly`
	// re-seals whichever that is, so the two checks below have to be pinned to the
	// store's own order rather than to this file's idea of it.
	const ps0 = await providerState();
	const withKey = ps0.order.filter(id => ps0.providers[id].opens
		&& ps0.providers[id].opens.indexOf('UNREADABLE') !== 0
		&& ps0.providers[id].opens !== '(no keyEnc)');
	const P1_ID = withKey[0] || '';
	const P1_KEY = P1_ID ? ps0.providers[P1_ID].opens : '';
	check('fixture: two providers hold readable keys before the change',
		withKey.length >= 2 && ps0.providers[P2_ID] && ps0.providers[P2_ID].opens === P2_KEY
			&& ps0.ready === true && ps0.resolved === P1_KEY,
		`${withKey.length} keyed; first=${P1_ID}; ready=${ps0.ready}; resolve=${JSON.stringify(ps0.resolved)}`);

	const s0 = await searchState(S_ENGINE);
	check('fixture: the search key is sealed and readable before the change',
		s0.opens === S_KEY && s0.says === S_KEY,
		`stored opens to ${JSON.stringify(s0.opens)}; the module says ${JSON.stringify(s0.says)}`);

	const needles = BOXES.map(b => ({ what: `${b.address}'s password`, text: b.pass }))
		.concat([{ what: 'the forge voice', text: VOICE }])
		.concat(P1_KEY ? [{ what: "the first provider's key", text: P1_KEY }] : [])
		.concat([{ what: "the second provider's key", text: P2_KEY }])
		.concat([{ what: "the search service's key", text: S_KEY }]);
	const hits0 = await plaintextHits(needles);
	check('THE STORED SECRETS ARE NEVER PLAINTEXT (before the change)',
		hits0.length === 0, hits0.join('; ') || 'nothing in the clear');

	// ── The change ───────────────────────────────────────────────────
	const said1 = await changePassphrase(PASS, NEW1);
	console.log(`         the app said: ${JSON.stringify(said1.body.slice(0, 200))}`);
	check('control: the change ended in a notice headed "Passphrase changed"',
		said1.head === 'Passphrase changed', JSON.stringify(said1.head) || 'no notice appeared');

	// Check 4 is measured HERE, before the reload: a reload would drop the module
	// and its hold with it, which would make every run green for the wrong reason.
	const held1 = await heldNow();
	check('THE PLAINTEXTS DO NOT OUTLIVE THE CHANGE',
		held1.leaked.length === 0 && held1.wrote.length === 0,
		held1.leaked.length ? `still held: ${held1.leaked.join(', ')}`
			: held1.wrote.length ? `re-wrote ${held1.wrote.join(', ')} from a hold that should be empty`
			: 'the hold is empty');

	// ── Reload, and unlock with the NEW passphrase ───────────────────
	//
	// The point of the reload: the wrapping key is now derived from the new
	// passphrase from scratch. Unwrapping with the key that happened to be in memory
	// would pass even if the change had never been applied to storage at all.
	const openedNew = await unlockWith(NEW1);
	check('control: the new passphrase unlocks the account', openedNew === true,
		openedNew ? '' : 'the gate did not open, so nothing below means anything');

	for (const b of BOXES) {
		const r = await opened(b.address);
		const first = b === BOXES[0];
		check(first
			? `A MAILBOX PASSWORD SURVIVES THE CHANGE (${b.address})`
			: `SEVERAL MAILBOXES SURVIVE, not just the first (${b.address})`,
			r.text === b.pass,
			r.err || (r.text === b.pass ? 'the same password as before'
				: `opened to ${JSON.stringify(r.text)}, not ${JSON.stringify(b.pass)}`));
	}

	// ── The provider keys, in the three places the defect showed ─────
	const ps1 = await providerState();
	const p1  = ps1.providers[P1_ID] || { opens: '(absent)', plaintext: '' };
	const p2  = ps1.providers[P2_ID] || { opens: '(absent)', plaintext: '' };
	check(`A PROVIDER API KEY SURVIVES THE CHANGE (${P1_ID})`,
		p1.opens === P1_KEY && ps1.ready === true && ps1.resolved === P1_KEY,
		`keyEnc ${p1.opens === P1_KEY ? 'opens to the same key' : JSON.stringify(p1.opens)}; `
		+ `ready=${ps1.ready}; resolve=${JSON.stringify(ps1.resolved)}`);
	check(`SEVERAL PROVIDERS SURVIVE, not just the first (${P2_NAME})`,
		p2.opens === P2_KEY,
		p2.opens === P2_KEY ? 'the same key as before' : JSON.stringify(p2.opens));
	// The re-seal writes `p.key = ''`; a plaintext copy left beside the sealed one
	// would be a key in the clear that nothing ever offers to remove.
	check('and the re-seal leaves no plaintext key beside the sealed one',
		!p1.plaintext && !p2.plaintext,
		`${P1_ID}:${JSON.stringify(p1.plaintext)} ${P2_ID}:${JSON.stringify(p2.plaintext)}`);

	// ── The search key, the one still live that morning ──────────────
	const s1 = await searchState(S_ENGINE);
	check(`THE SEARCH KEY SURVIVES THE CHANGE (${S_ENGINE})`,
		s1.opens === S_KEY && s1.says === S_KEY,
		s1.opens === S_KEY && s1.says === S_KEY ? 'the same key as before'
			: `stored opens to ${JSON.stringify(s1.opens)}; the module says ${JSON.stringify(s1.says)}`);
	check('and the search re-seal leaves no plaintext key beside the sealed one',
		!s1.plaintext, JSON.stringify(s1.plaintext));

	// ── The chunk store, which cannot be re-wrapped and must not be reused ──
	//
	// `chunks.js` seals AT REST: the ciphertext lives on the gateway for as long as the
	// file is in the cloud store, so a passphrase change leaves every chunk up there
	// sealed under a key nobody has. It cannot re-wrap them from a dialog — that is
	// gigabytes over the wire, and it could not reach a file this device does not hold
	// anyway — so what it must do instead is make sure none of that ciphertext is ever
	// offered for reuse. The address map goes, and the debt is recorded so that
	// `collectChunked` offloads again rather than skipping the files as unchanged.
	const chunkState = await page.evaluate(() => ({
		map:   Storage.prototype.getItem.call(localStorage, 'daimond-chunk-map'),
		stale: !!(window.DaimondChunks && DaimondChunks.staleSinceRekey && DaimondChunks.staleSinceRekey()),
	}));
	check('THE CHUNK ADDRESSES SEALED UNDER THE OLD PASSPHRASE ARE NOT REUSED',
		(!chunkState.map || chunkState.map === '{}') && chunkState.stale === true,
		`the map is ${JSON.stringify(chunkState.map)}; a re-offload is owed: ${chunkState.stale}`);

	const v1 = await voiceNow();
	check('THE FORGE VOICE SURVIVES THE CHANGE',
		v1.text === VOICE, v1.err || (v1.text === VOICE ? 'the same secret as before'
			: `now ${JSON.stringify(v1.text)}`));

	const hits1 = await plaintextHits(needles);
	check('THE STORED SECRETS ARE NEVER PLAINTEXT (after the change and a reload)',
		hits1.length === 0, hits1.join('; ') || 'nothing in the clear');

	// ── A change that FAILS ──────────────────────────────────────────
	//
	// Driven for real. The wrapped private key is corrupted while the new-passphrase
	// dialog is open — after the current passphrase has been accepted and before
	// `changePassphrase` opens the key with it — so the GCM tag fails and the real
	// function returns `{ ok: false }` on the real path, with the mailbox passwords
	// already read out and held.
	//
	// What each mailbox opens to on the way in, so that "a failed change changed
	// nothing" is asked as exactly that, against the state the failure met. Compared
	// with the FIXTURE instead, this would go red under any break that had already
	// broken the mailbox — reporting the earlier defect a second time, in a check that
	// is not about it.
	const beforeFail = {};
	for (const b of BOXES) beforeFail[b.address] = JSON.stringify(await opened(b.address));
	let savedPriv = '';
	const said2 = await changePassphrase(NEW1, NEW2, async () => {
		savedPriv = await page.evaluate(() => {
			const raw = localStorage.getItem('daimond-id-priv') || '';
			const c = raw[5] === 'A' ? 'B' : 'A';
			localStorage.setItem('daimond-id-priv', raw.slice(0, 5) + c + raw.slice(6));
			return raw;
		});
	});
	await page.evaluate((raw) => localStorage.setItem('daimond-id-priv', raw), savedPriv);
	console.log(`         the app said: ${JSON.stringify(said2.body.slice(0, 140))}`);

	// Control, and it is load-bearing: check 5 is about the FAILURE path, so the
	// change really must have failed. If it had gone through, the probe below would
	// be measuring the success path under another name.
	const state = await page.evaluate(async (a) => ({
		old: await DaimondIdentity.verify(a.NEW1),
		neu: await DaimondIdentity.verify(a.NEW2),
	}), { NEW1, NEW2 });
	check('control: the failed change really did not happen',
		state.old === true && state.neu === false,
		`${NEW1.slice(0, 12)}… still opens: ${state.old}; the attempted one opens: ${state.neu}`);

	const held2 = await heldNow();
	check('A FAILED CHANGE LEAVES NO PASSWORD IN MEMORY',
		held2.leaked.length === 0 && held2.wrote.length === 0,
		held2.leaked.length ? `still held: ${held2.leaked.join(', ')}`
			: held2.wrote.length ? `re-wrote ${held2.wrote.join(', ')} from a hold that should be empty`
			: 'the hold is empty');

	// And the mailboxes are exactly as the failed change found them.
	for (const b of BOXES) {
		const now = JSON.stringify(await opened(b.address));
		check(`a failed change leaves ${b.address}'s stored password as it found it`,
			now === beforeFail[b.address],
			now === beforeFail[b.address] ? 'unchanged' : `${beforeFail[b.address]} -> ${now}`);
	}

	const hits2 = await plaintextHits(needles);
	check('THE STORED SECRETS ARE NEVER PLAINTEXT (after the failed change)',
		hits2.length === 0, hits2.join('; ') || 'nothing in the clear');

	// ── One secret's failure, against unmodified code ────────────────
	//
	// Every re-seal now sits in its own try/catch and none of them returns, so a
	// failure in any one of them is supposed to cost nothing but a sentence in the
	// notice. In an ordinary run they all succeed, which is exactly why that claim
	// cannot be read off a clean run: it needs a failure, and it needs one that is not
	// simulated by patching the source. So the API key's re-wrap is made to fail from
	// OUTSIDE the app — `DaimondIdentity.wrap` refuses that one plaintext — and three
	// secrets are asked whether they survived: a mailbox and a provider key from ABOVE
	// the failing block, and the push token from BELOW it.
	//
	// The push token is the one that matters. A reinstated `return` in the API key's
	// catch — the single line this restructure deleted — costs nothing above it, so a
	// check that asked only about the mailbox would stay green through the very
	// regression it was written for.
	//
	// The push credential is seeded into the stored config and picked up by a reload,
	// because `afterUnlock` is what puts `cfg.pushToken` in memory and `doChangePassphrase`
	// reads it from there. The mail, voice and provider fixtures are re-set under the
	// key in force so that this section measures ITS change and not what an earlier
	// break left behind.
	await page.evaluate(async (tok) => {
		const b = JSON.parse(localStorage.getItem('daimond-byok') || '{}');
		b.pushHost = 'https://example.invalid/repo.git';
		b.pushUser = 'tester';
		b.pushTokenEnc = await DaimondIdentity.wrap(tok);
		localStorage.setItem('daimond-byok', JSON.stringify(b));
	}, PUSHTOK);
	const openedAgain = await unlockWith(NEW1);
	check('control: the push credential is in memory for the change to re-seal',
		openedAgain === true && (await pushNow()).text === PUSHTOK,
		JSON.stringify((await pushNow()).text || (await pushNow()).err));

	const armed = await page.evaluate(async (a) => {
		const j = JSON.parse(localStorage.getItem('daimond-mail'));
		for (const x of j.accounts) {
			const m = a.boxes.find(b => b.address === x.address);
			if (m) x.pass = await DaimondIdentity.wrap(m.pass);
		}
		localStorage.setItem('daimond-mail', JSON.stringify(j));
		window.DaimondMail.reload();
		await DaimondVoice.set(a.voice);
		// Set again deliberately, and not because the re-seal is doubted: it is set
		// here so that this section is independent of whether the re-seal above worked.
		// Without it `nomodels` would leave `cfg.apiKey` empty, the API key block would
		// be SKIPPED rather than failing, and this whole section would measure nothing
		// while reporting green.
		const d = DaimondModels.getDefault();
		if (d && d.provider) await DaimondModels.setKey(d.provider, a.key);
		const r = DaimondModels.resolve('', '');
		// Only now: `setKey` wraps the key itself, and a refusal installed first would
		// have stopped the arrangement rather than the change.
		const real = DaimondIdentity.wrap;
		DaimondIdentity.wrap = async function (v) {
			if (String(v) === a.key) throw new Error('the API key cannot be re-wrapped (probe)');
			return await real(v);
		};
		return !!(r && r.apiKey === a.key);
	}, { boxes: BOXES, voice: VOICE, key: P1_KEY });
	check('control: the API key is readable, so the block that will fail really runs',
		armed === true, armed ? '' : 'no provider key resolved; the checks below prove nothing');

	const NEW3  = 'a third new passphrase, with the api key failing';
	const said3 = await changePassphrase(NEW1, NEW3);
	console.log(`         the app said: ${JSON.stringify(said3.body)}`);
	// Specifically the API key's own sentence. `/could not be re-encrypted/` alone also
	// matches the PROVIDERS sentence, which the same refusal produces — the default
	// provider's key IS `cfg.apiKey`, so one refused plaintext fails both — and a
	// control that cannot tell the two apart would pass while the block it is about
	// had been skipped.
	check('control: the API key re-wrap really did fail',
		/your API key could not be re-encrypted/.test(said3.body), JSON.stringify(said3.body.slice(0, 160)));
	// Check 8. One exit, and it leads with the sentence that is true whatever else
	// went wrong. Before the restructure this path ended in a bare "Careful" and the
	// user was never told the passphrase had changed at all.
	check('THE NOTICE SAYS THE PASSPHRASE CHANGED AND THEN NAMES WHAT FAILED',
		said3.head === 'Passphrase changed'
			&& /your API key could not be re-encrypted/.test(said3.body),
		`heading ${JSON.stringify(said3.head)}`);

	const opened3 = await unlockWith(NEW3);
	check('control: the third passphrase unlocks the account', opened3 === true);
	const r3  = await opened(BOXES[0].address);
	const ps3 = await providerState();
	const pu3 = await pushNow();
	check('A FAILURE IN ONE SECRET CANNOT COST A MAILBOX (above it)',
		r3.text === BOXES[0].pass,
		r3.err || (r3.text === BOXES[0].pass ? `${BOXES[0].address} survived` : JSON.stringify(r3.text)));
	check('A FAILURE IN ONE SECRET CANNOT COST A PROVIDER KEY (above it)',
		(ps3.providers[P2_ID] || {}).opens === P2_KEY,
		JSON.stringify((ps3.providers[P2_ID] || {}).opens));
	check('A FAILURE IN ONE SECRET CANNOT COST THE PUSH TOKEN (below it)',
		pu3.text === PUSHTOK,
		pu3.err ? `the stored token is ${pu3.err}` : JSON.stringify(pu3.text));

	// And a failed re-wrap must not fall back to writing the thing in the clear:
	// `saveCfg` stores a plaintext `apiKey` whenever `apiKeyEnc` is empty, which is a
	// deliberate path for a browser with no identity and would be a leak here.
	const hits3 = await plaintextHits(needles.concat([{ what: 'the push token', text: PUSHTOK }]));
	check('THE STORED SECRETS ARE NEVER PLAINTEXT (after a change with a failure in it)',
		hits3.length === 0, hits3.join('; ') || 'nothing in the clear');

	// ── Checks 11 and 12: the sequence, watched from outside it ──────
	//
	// Everything above is about a particular secret, and a check per secret is a list —
	// the same hand-written list that was wrong four times over. What follows is about
	// the walk itself, and it is measured from OUTSIDE the registry: each live
	// participant's own phases are wrapped before the change and watched being called,
	// because a registry reporting on itself would be self-consistent and prove
	// nothing. It is also the only measurement `chunks` and `sync` get — neither has a
	// visible effect in a world with no gateway, and "it is in the list" is not the
	// same claim as "it was reached".
	//
	// Four probes go in behind the real ones. `probe-throws` sits between two that
	// record, so the ones after a failure are asked whether they still ran; `probe-a`
	// carries both phases and reports whether the OLD passphrase still verified when
	// each was called, which is how the two phases are shown to straddle the key swap
	// rather than merely to happen in the right order in the source.
	const NEW4 = 'a fourth new passphrase, this one watched by probes';
	const registered = await page.evaluate((a) => {
		const P = window.__probe = {
			ran: [], read: [], args: [], reports: [], forgot: 0,
			verifyAtRead: null, verifyAtReseal: null,
		};
		// The live participants, wrapped where they stand. `participants()` hands back
		// the objects themselves; a copy could show only that a list exists.
		DaimondRekey.participants().forEach((p) => {
			const rs = p.reseal, rd = p.read;
			p.reseal = function () {
				P.ran.push(p.name); P.args.push(p.name + '/reseal:' + arguments.length);
				return rs.apply(this, arguments);
			};
			if (rd) p.read = function () {
				P.read.push(p.name); P.args.push(p.name + '/read:' + arguments.length);
				return rd.apply(this, arguments);
			};
		});
		// And what the registry hands back to the caller, so it can be searched for
		// anything it had no business carrying.
		const rl = DaimondRekey.readAll, ra = DaimondRekey.resealAll;
		DaimondRekey.readAll   = async function () {
			const r = await rl.apply(null, arguments); P.reports.push(JSON.stringify(r)); return r;
		};
		DaimondRekey.resealAll = async function () {
			const r = await ra.apply(null, arguments); P.reports.push(JSON.stringify(r)); return r;
		};
		DaimondRekey.register({
			name: 'probe-a',
			read: async function () {
				P.read.push('probe-a'); P.args.push('probe-a/read:' + arguments.length);
				P.verifyAtRead = await DaimondIdentity.verify(a.cur);
				return { held: 0, failed: [] };
			},
			reseal: async function () {
				P.ran.push('probe-a'); P.args.push('probe-a/reseal:' + arguments.length);
				P.verifyAtReseal = await DaimondIdentity.verify(a.cur);
				return { failed: [] };
			},
			forget: function () { P.forgot++; },
		});
		DaimondRekey.register({
			name: 'probe-throws',
			reseal: function () { P.ran.push('probe-throws'); throw new Error('a probe that fails'); },
		});
		DaimondRekey.register({
			name: 'probe-b',
			reseal: function () { P.ran.push('probe-b'); return { failed: [] }; },
		});
		DaimondRekey.register({
			name: 'probe-tail',
			reseal: function () { P.ran.push('probe-tail'); return { failed: [] }; },
		});
		return DaimondRekey.names();
	}, { cur: NEW3 });

	const said4 = await changePassphrase(NEW3, NEW4);
	const P = await page.evaluate(() => window.__probe);
	console.log(`         the app said: ${JSON.stringify(said4.body.slice(0, 200))}`);
	check('control: the watched change happened', said4.head === 'Passphrase changed',
		JSON.stringify(said4.head) || 'no notice appeared');

	// Asked as "is anything in the list unreached", NOT as "did twelve things run". A
	// literal count would go red the day somebody registers a ninth module, and would
	// be reporting the wrong fault when it did — this check is about the walk, and the
	// question of who is on the list belongs to the two checks that already ask it.
	// The floor underneath it is what stops an empty registry passing: the four probes
	// this file registered itself must be there, and something of the app's must be
	// there with them.
	const PROBES = ['probe-a', 'probe-throws', 'probe-b', 'probe-tail'];
	const never    = registered.filter(n => P.ran.indexOf(n) < 0);
	const noProbes = PROBES.filter(n => registered.indexOf(n) < 0);
	check('EVERY REGISTERED PARTICIPANT IS RUN, and none is registered into silence',
		never.length === 0 && noProbes.length === 0 && registered.length > PROBES.length,
		never.length ? `registered and never reached: ${never.join(', ')}`
			: noProbes.length ? `the probes never registered: ${noProbes.join(', ')}`
			: registered.length <= PROBES.length ? 'nothing but the probes is registered'
			: `${registered.length} ran: ${P.ran.join(', ')}`);
	// The one that follows the failure, and not the whole tail: "everything ran" is
	// check 11's question, and asking it twice would put this check red for a reason
	// that has nothing to do with a failure being contained.
	check('A PARTICIPANT THAT THROWS COSTS ONLY ITSELF',
		P.ran.indexOf('probe-throws') >= 0 && P.ran.indexOf('probe-b') >= 0,
		P.ran.indexOf('probe-throws') < 0 ? 'the throwing probe never ran, so nothing was proved'
			: `after it: ${P.ran.slice(P.ran.indexOf('probe-throws') + 1).join(', ') || 'NOTHING'}`);
	check('THE READ IS BEFORE THE KEY CHANGES AND THE RESEAL IS AFTER',
		P.verifyAtRead === true && P.verifyAtReseal === false,
		`the old passphrase verified at read: ${P.verifyAtRead}; at reseal: ${P.verifyAtReseal}`);
	// Structural, and it is what makes "the registry learns no secret" a property of
	// the interface rather than a promise in a comment: there is no parameter for a
	// plaintext to arrive on.
	const carried = P.args.filter(a => !/:0$/.test(a));
	check('NO PHASE IS CALLED WITH ANYTHING AT ALL',
		P.args.length > 0 && carried.length === 0,
		carried.length ? `called with arguments: ${carried.join(', ')}`
			: `${P.args.length} calls, every one of them empty-handed`);
	const report = P.reports.join(' ');
	const leaked = needles.concat([{ what: 'the push token', text: PUSHTOK }])
		.concat([{ what: 'the new passphrase', text: NEW4 }])
		.filter(n => report.indexOf(n.text) >= 0).map(n => n.what);
	check('THE REGISTRY CARRIES NAMES AND COUNTS, NEVER A SECRET',
		leaked.length === 0 && /probe-throws/.test(report),
		leaked.length ? `it carried ${leaked.join(', ')}`
			: /probe-throws/.test(report) ? 'a report with a named failure in it, and no secret'
			: 'the report named nothing at all, so this proved nothing');

} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must:\n  - ${bad.join('\n  - ')}`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
