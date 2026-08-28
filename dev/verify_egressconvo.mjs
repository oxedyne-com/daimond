// verify_egressconvo.mjs — one ask per conversation, and it covers every website.
//
// THE DEFECT, reported by a tester on 2026-08-26 and ruled on by the owner the
// next day. The tester wrote: *"Permission sought for every new web_fetch, yet
// the 'THE NETWORK' in the Permission mode dialog says 'Always allow', so I'm
// confused."* A lane read that as a LABEL fault — the setting governs whether a
// command keeps its network after the turn has read a stranger's words, and a
// page fetch goes through a different door — renamed the head to "Commands and
// the network", and shipped a line saying what it is not. That reading of the
// two mechanisms was right and is still right.
//
// THE OWNER THEN RULED THAT THE BEHAVIOUR WAS ALSO THE BUG: *"I should only be
// asked once in a session (i.e. new ordinary chat or fresh daimon) for
// permission to access ANY (not a specific website) ... At the moment, every
// website is triggering a new permission request for that url."*
//
// WHAT IT ACTUALLY DID. `_egressOk` in www/js/daimond.js was an object keyed by
// HOST, living as long as the page. So the scope was wrong twice over and in
// opposite directions: every new site asked again, and a yes given in one chat
// silently answered for the next chat, and for every daimon in the tab. The
// answer now lives on the engine's `TurnState`, where a conversation is a thing
// that exists, and `web_step` in src/tools.rs decides from it.
//
// NINE PROPERTIES. The first four are the owner's sentence, in order.
//
//   1. A CLEAN TURN IS NEVER ASKED. Held first, because every check after it is
//      only meaningful about a turn where the question is genuinely live — and
//      because a gate that asked on every fetch would pass 2 and 3 by asking
//      nobody anything.
//   2. TWO SITES, ONE ASK. The reported defect exactly: two `web_fetch` calls to
//      two different hosts in one turn used to be two dialogs.
//   3. AND WHAT THE ASK SAYS. Half the deliverable, and the half a count cannot
//      see. The user is agreeing that this conversation may reach ANY website,
//      which is materially bigger than "may reach example.com" — so the dialog
//      has to say so. A wide grant collected in the words of a narrow one is the
//      failure the label change was fixing, arriving from the other direction.
//   4. A LATER TURN IN THE SAME CHAT IS NOT ASKED. Separate from 2 because the
//      grant surviving one turn and the grant surviving the conversation are
//      different claims, and the old code satisfied neither.
//   5. A NEW CHAT ASKS AGAIN. The narrowing half of the ruling, and the one a
//      wider fix would have quietly lost: `_egressOk` outlived every chat.
//   6. A DAIMON IS ITS OWN CONVERSATION. The chat's yes does not reach it. This
//      is the sharp one, because a Diamond's client is CACHED BY PROVIDER AND
//      MODEL (`diamondApp`), so the daimon shares one engine cache with every
//      other Diamond on that model; an answer held in a plain `Option` there
//      would be every Diamond's answer. Held in Rust as well, by
//      `test_one_diamonds_yes_is_not_another_diamonds_on_a_shared_client`.
//   7. AND A LONG ADDRESS IS STILL ASKED ABOUT. The limit on the grant, and the
//      reason the grant is safe to give: approving the web is not approving
//      `somewhere.test/?everything-I-know=…`, which is the exfiltration this
//      whole gate exists to catch. Measured AFTER the conversation has granted
//      the web, which is the only state in which it can fail.
//   9. AND SO IS THE DIAMOND NEXT TO IT. Added 2026-08-28. Check 6 says a chat's
//      yes does not answer for a daimon; this says a Diamond's READING does not
//      cross to the Diamond beside it on the same client. `TurnState::tainted` was
//      a bare `bool` on a cache every Diamond on one model shares, so a Research
//      Diamond that fetched a page cut an Accounts Diamond's network and stamped
//      its dispatched workers as carrying a stranger's words. The sharing is
//      asserted before the property is, which is the lesson the Rust test next door
//      taught by not doing it.
//   8. AND OUR OWN PAGES GRANT NOTHING. The same-origin shortcut answers with
//      nobody asked, and the word it answers in now decides whether a standing
//      grant is written. A fetch of Daimond's own address — which the model can
//      write for itself — must not hand over every site in silence. Held as a
//      pair: the shortcut still passing is not the property, the next site being
//      asked about is.
//
// PROVED AGAINST BROKEN CODE FIRST, each break chosen to survive every check but
// the ones under test:
//
//   node dev/verify_egressconvo.mjs --break perhost   # 2, 4, 6: ask about every site again
//   node dev/verify_egressconvo.mjs --break narrowask # 3:       the wide grant, narrow words
//   node dev/verify_egressconvo.mjs --break heavyfree  # 7:       a long address rides the grant
//   node dev/verify_egressconvo.mjs --break sameorigin # 8:       our own pages record a grant
//   node dev/verify_egressconvo.mjs                    # and then, clean
//
// `perhost` is the sharp one: it restores the reported defect exactly, by making
// the page answer a granted conversation as though it had never been asked.
//
// `sameorigin` is the subtle one. The same-origin shortcut answers `allow` for
// Daimond's own pages, with nobody asked — and `allow` is now the word that
// RECORDS a standing grant. Restoring it grants the whole conversation on the
// strength of a request nobody saw.
//
// IT REDDENED NOTHING AT FIRST, and that was a finding about the checks rather
// than about the break: nothing in the run fetched our own origin, so the
// shortcut was never reached. Check 8 exists because of it.
//
// THE MARK IS SET DIRECTLY, through `DaimondCore.markRead`, which is the same
// one-way flag every real path ends at. Which reads produce it is a Rust
// question and is answered there.
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_egressconvo.mjs
//
// Needs dev/serve.mjs and the mock. No gateway. Needs the wasm to have been
// rebuilt since src/ last changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, scratch, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is one real edit to one real file, served in its place. All four
// live in the page, because that is the half a served file can reach; the engine
// half is broken in Rust, by dev/../src/tools.rs's own tests.
const BREAKS = {
	// The conversation's grant never taken into account: every fetch draws the
	// dialog again, which is the defect as reported.
	perhost: {
		file: 'js/daimond.js',
		find: "\t\tif (granted) return 'allow-once';",
		with: "\t\tif (false) return 'allow-once';",
	},
	// The wide grant asked for in the words of a narrow one — the old per-site
	// question, in front of a yes that now covers everything.
	narrowask: {
		file: 'js/daimond.js',
		find: "\t\t\tt('egress.any_body', { host: host }),\n\t\t\tt('egress.any_ok'),\n\t\t\t{ title: t('egress.any_title'), danger: true });",
		with: "\t\t\tt('egress.reach_body', { host: host }),\n\t\t\tt('egress.reach_ok', { host: host }),\n\t\t\t{ title: t('egress.reach_title', { host: host }), danger: true });",
	},
	// The payload test moved below the grant, where it can no longer fire — which
	// is the one edit that would make this widening genuinely dangerous.
	heavyfree: {
		file: 'js/daimond.js',
		find: "\t\tif (load.heavy) {",
		with: "\t\tif (load.heavy && !granted) {",
	},
	// The daimon's mark put on the shared client WITHOUT naming the Diamond, which
	// is where it landed before the taint was keyed by conversation: on the client's
	// own key, which is the empty string and belongs to no Diamond at all. Reddens
	// check 9's precondition -- and check 6 with it, honestly: a mark that lands on
	// nobody's conversation is not the daimon's either. It is the only half of that
	// fault a served file can reach; the bleed itself is a Rust field, broken and
	// held there by
	// `test_one_diamonds_reading_does_not_taint_another_on_a_shared_client`.
	unnamedmark: {
		file: 'js/daimond.js',
		find: "\t\t\t\tif (da && da.set_tainted) { da.set_tainted(current.diamondId); return true; }",
		with: "\t\t\t\tif (da && da.set_tainted) { da.set_tainted(); return true; }",
	},
	// Our own origin answering in the word that records a standing grant.
	sameorigin: {
		file: 'js/daimond.js',
		find: "\t\tif (!strict && host === location.host) return reading ? 'allow-once' : 'allow';",
		with: "\t\tif (!strict && host === location.host) return 'allow';",
	},
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const stub = async (page) => {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src  = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	// An anchor that is not there exactly once patches nothing and the run would
	// pass quietly, which is worse than a red.
	if (src.split(spec.find).length !== 2) {
		console.error(`break '${BREAK}': its anchor is not in ${spec.file} exactly once`);
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
};

const s = await open({
	name:    'egressconvo',
	profile: scratch('pw', 'egressconvo' + (BREAK ? '-' + BREAK : '')),
	route:   stub,
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// Every dialog raised while `body` runs, answered the way `yes` says, with the
/// text of each one kept.
///
/// COUNTED BY ANSWERING THEM, not by watching for one and stopping. A gate that
/// raised two dialogs would otherwise look exactly like a gate that raised one:
/// the second sits unanswered behind the first, the turn never finishes, and the
/// check reads "a dialog appeared" and passes.
const asks = async (body, { yes = true, snap = '' } = {}) => {
	const seen = [];
	let stop = false;
	const pump = (async () => {
		while (!stop) {
			// READ, then photograph, then answer -- three steps and not one, because a
			// dialog that has already been clicked is not on screen to be photographed,
			// and the wording is half of what this file is for.
			const got = await p.evaluate(() => {
				const card = [...document.querySelectorAll('.dlg-card')]
					.filter(c => c.getClientRects().length).pop();
				if (!card) return null;
				return {
					msg:   (card.querySelector('.dlg-msg') || card).textContent || '',
					title: (card.querySelector('h2') || {}).textContent || '',
					ok:    (card.querySelector('.dlg-ok') || {}).textContent || '',
				};
			}).catch(() => null);
			if (got) {
				if (snap && !seen.length) await shot(s, snap);
				await p.evaluate((ok) => {
					const card = [...document.querySelectorAll('.dlg-card')]
						.filter(c => c.getClientRects().length).pop();
					if (!card) return;
					const b = card.querySelector(ok ? '.dlg-ok' : '.dlg-cancel')
						|| card.querySelector('.dlg-ok');
					if (b) b.click();
				}, yes).catch(() => {});
				seen.push(got);
			}
			await p.waitForTimeout(250);
		}
	})();
	await body();
	stop = true;
	await pump;
	return seen;
};

/// One turn in whatever conversation is in focus, and the dialogs it raised.
const turn = (text, { yes = true, wait = 6000, snap = '' } = {}) => asks(async () => {
	await p.fill('#chat-input', text);
	await p.click('#chat-send', { force: true });
	await p.waitForTimeout(wait);
}, { yes: yes, snap: snap });

const mark = () => p.evaluate(() => !!(window.DaimondCore && DaimondCore.markRead()));

const FETCH = (u) => `@tool web_fetch {"url":"${u}"}`;

try {
	// ── 1. A clean turn is never asked ───────────────────────────
	await newChat(s);
	const clean = await turn(FETCH('https://alpha.test/one'));
	check(clean.length === 0,
		'A TURN THAT HAS READ NOTHING IS NOT ASKED AT ALL',
		`${clean.length} dialog(s)`);

	// ── 2 and 3. Two sites, one ask, and what it says ────────────
	const marked = await mark();
	check(marked, 'the conversation can be marked as having read outside content',
		marked ? '' : 'DaimondCore.markRead did not take');
	// TWO CALLS IN ONE TURN, to two different hosts. Every one of these was its
	// own dialog before, and the second is the one the tester was reporting.
	const two = await asks(async () => {
		await p.fill('#chat-input',
			'@tools web_fetch {"url":"https://alpha.test/one"} ;; web_fetch {"url":"https://beta.test/two"}');
		await p.click('#chat-send', { force: true });
		await p.waitForTimeout(9000);
	}, { snap: 'egressconvo-ask' });
	check(two.length === 1,
		'TWO DIFFERENT SITES IN ONE TURN RAISE EXACTLY ONE ASK',
		`${two.length} dialog(s): ${JSON.stringify(two.map(x => x.title))}`);
	const said = two[0] || { msg: '', title: '', ok: '' };
	const whole = (said.title + ' ' + said.msg + ' ' + said.ok).toLowerCase();
	// AGAINST THE APP'S OWN STRING, not against words this file chose: the copy
	// will be reworded, and a literal from today's draft would leave the check
	// unable to fail for the right reason later.
	const wide = await p.evaluate(() => ({
		title: DaimondI18n.t('egress.any_title'),
		ok:    DaimondI18n.t('egress.any_ok'),
		body:  DaimondI18n.t('egress.any_body', { host: 'alpha.test' }),
		narrow: DaimondI18n.t('egress.reach_title', { host: 'alpha.test' }),
	}));
	check(said.title.trim() === wide.title.trim() && said.ok.trim() === wide.ok.trim(),
		'and it is the WIDE question, not the old one about a single site',
		`title=${JSON.stringify(said.title)} ok=${JSON.stringify(said.ok)}`);
	// The pair, because either half alone is satisfied by a reworded narrow
	// dialog: it must say the grant covers ANY site, and it must say where the
	// grant stops.
	check(/any website/.test(whole) && /this conversation/.test(whole),
		'AND IT SAYS PLAINLY WHAT IS BEING GRANTED — any website, this conversation',
		JSON.stringify(said.msg.slice(0, 180)));

	// ── 4. A later turn in the same chat ─────────────────────────
	const third = await turn(FETCH('https://gamma.test/three'));
	check(third.length === 0,
		'A THIRD SITE, IN A LATER TURN OF THE SAME CHAT, IS NOT ASKED',
		`${third.length} dialog(s)`);

	// ── 7. And a long address is still its own question ──────────
	//
	// Here, while the conversation HAS granted the web, because that is the only
	// state in which this can fail.
	const heavy = await turn(FETCH(
		'https://gamma.test/x?carry=' + 'A'.repeat(200)), { wait: 8000 });
	check(heavy.length === 1,
		'AN ADDRESS CARRYING A PAYLOAD IS STILL ASKED ABOUT, grant or no grant',
		`${heavy.length} dialog(s): ${JSON.stringify(heavy.map(x => x.title))}`);

	// ── 5. A new chat asks again ─────────────────────────────────
	//
	// A TURN FIRST, and it is not a flourish: `ensureApp` builds a chat's engine on
	// its first send, so a chat that has said nothing has no engine to mark and
	// `markRead` silently answers false. Written the other way round first, and the
	// check duly read "not asked" about a chat that was never tainted — which is a
	// check that cannot fail rather than a check that passed.
	await newChat(s);
	await turn('@text a brand new chat');
	const remarked = await mark();
	check(remarked, 'the new chat can be marked too',
		remarked ? '' : 'markRead did not take on the new chat');
	const fresh = await turn(FETCH('https://alpha.test/one'));
	check(fresh.length === 1,
		'A NEW CHAT ASKS AGAIN — the grant does not cross a conversation',
		`${fresh.length} dialog(s)`);

	// ── 6. A daimon is its own conversation ──────────────────────
	//
	// Made the way a person makes one, and steered through the same composer, so
	// what is measured is the daimon's own engine and not a second path.
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = 'Reaching';
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	});
	await p.waitForTimeout(1800);
	await p.$$eval('.diamond-box', els => els[0] && els[0].click());
	await p.waitForTimeout(1200);
	const dmark = await mark();
	check(dmark, 'the daimon can be marked as having read outside content',
		dmark ? '' : 'markRead did not reach the daimon');
	const daimon = await turn(FETCH('https://alpha.test/one'), { wait: 9000 });
	check(daimon.length === 1,
		'A DAIMON IS ITS OWN CONVERSATION — a chat’s yes does not answer for it',
		`${daimon.length} dialog(s)`);

	// ── 9. AND SO IS THE DIAMOND NEXT TO IT ──────────────────────
	//
	// TWO DIAMONDS ON ONE MODEL. `diamondApp` caches one client per provider and
	// model, a daimon turn clones that client's `read_seen` cache, and until
	// 2026-08-28 the taint on it was a bare `bool`. So a Research Diamond that
	// fetched a page took the network away from an Accounts Diamond that had
	// touched nothing external, and stamped its dispatched workers as carrying a
	// stranger's words. Held in Rust by
	// `test_one_diamonds_reading_does_not_taint_another_on_a_shared_client`; held
	// HERE because the Rust half cannot see whether the app names the Diamond when
	// it marks and reads the flag, and unnamed the mark lands on the shared
	// client's own conversation, which is nobody's.
	//
	// THE SHARING IS ASSERTED, not assumed. Two Diamonds that happened to sit on
	// two clients would pass every check below while proving nothing at all -- which
	// is the fault the Rust test next door was carrying, and the reason this line
	// exists.
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = 'Accounts';
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	});
	await p.waitForTimeout(1800);
	const twoD = await p.evaluate(() => {
		const rows = [...document.querySelectorAll('.diamond-box[data-id]')]
			.map(e => ({ id: e.dataset.id, name: (e.textContent || '').trim() }));
		const read  = rows.find(r => /Reaching/.test(r.name)) || null;
		const clean = rows.find(r => /Accounts/.test(r.name)) || null;
		// ONE CLIENT, ASKED ABOUT BOTH. `diamondApp()` is the client for the starred
		// model, which is the model a Diamond made with no pin runs on -- so this is
		// the object both Diamonds' daimon turns clone their cache from.
		const app = window.DaimondCore.diamondApp();
		const ask = (r) => (r && app && app.is_tainted) ? !!app.is_tainted(r.id) : null;
		return { read, clean, dirtyMark: ask(read), cleanMark: ask(clean) };
	});
	check(!!twoD.read && !!twoD.clean,
		'a second Diamond exists beside the one that read a page',
		JSON.stringify([twoD.read, twoD.clean]));
	// THE PRECONDITION, STATED. This client knowing about the FIRST Diamond's
	// reading is what proves the two share a cache at all; without it the check
	// below would be two Diamonds on two clients, which never had the fault and
	// would pass for no reason.
	check(twoD.dirtyMark === true,
		'and the shared client carries the first Diamond’s reading, or nothing below is about sharing',
		`mark=${String(twoD.dirtyMark)}`);
	check(twoD.cleanMark === false,
		'A DIAMOND THAT READ NOTHING IS NOT MARKED BY THE ONE THAT DID',
		`mark=${String(twoD.cleanMark)}`);
	// AND WHAT THE USER MEETS: the clean Diamond keeps its network and is not
	// interrupted. Measured by driving it, because the flag reading clean and the
	// gate acting on it are two claims.
	await p.evaluate((id) => {
		const esc = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
		const box = document.querySelector('.diamond-box[data-id="' + esc + '"]');
		if (box) box.click();
	}, twoD.clean ? twoD.clean.id : '');
	await p.waitForTimeout(1200);
	const untouchedDaimon = await turn(FETCH('https://delta.test/four'), { wait: 9000 });
	check(untouchedDaimon.length === 0,
		'and it is never asked — a stranger’s words stop at the Diamond that read them',
		`${untouchedDaimon.length} dialog(s)`);

	// ── 8. Our own pages grant nothing ───────────────────────────
	//
	// The same-origin shortcut answers without asking anybody, and the word it
	// answers in is now the difference between "this one page" and "the whole
	// conversation". If it says the wide word, a fetch of Daimond's own address —
	// which the model can write for itself — hands over every site, with no
	// dialog ever drawn. Measured as a PAIR, because the shortcut passing is not
	// the property: what matters is that the NEXT site is still asked about.
	await newChat(s);
	await turn('@text a chat for our own pages');
	await mark();
	const ownUrl = await p.evaluate(() => location.origin + '/index.html');
	const own = await turn(FETCH(ownUrl));
	check(own.length === 0,
		'Daimond’s own pages are not put to the user',
		`${own.length} dialog(s)`);
	const after = await turn(FETCH('https://alpha.test/one'));
	check(after.length === 1,
		'AND THEY GRANT NOTHING — the next site is still asked about',
		`${after.length} dialog(s)`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
