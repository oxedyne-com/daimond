// verify_socialpost.mjs — the Social panel's compose box, in a real browser, with
// the forge stood in for.
//
// TWO DEFECTS THE OWNER HIT ON 2026-09-14, against build 1f8ca7ce44f0, and the
// one property each of them turns on.
//
//   (A) THE FORGE REFUSED A PROPOSAL FOR THE LENGTH OF ITS TITLE and the panel
//       left him at a dead end. The row said, in the forge's own words, "That
//       title is longer than a title here may be. Nothing was written; the length
//       is there so that a listing stays a listing." — a sentence carrying NO
//       NUMBER, because `Fault::Malformed` holds a `&'static str` and oregami's
//       own comment says a client "must be told elsewhere what that rule's number
//       is". Under it sat Send now, which would re-send the same characters for
//       the same refusal, and Copy. Nothing on the screen said what the limit was
//       and nothing offered to change the title.
//
//   (B) "POLISH & POST" SENT WITHOUT ASKING. In his words: "the 'Send now' button
//       and associated model-revised proposal appears momentarily, before
//       disappearing, apparently sent automatically. It should wait for my
//       permission."
//
// What this proves, at the network, because "not posted" and "posted and hidden"
// look identical on a screen:
//
//   (a) POLISH LEAVES THE CARD UP. The model runs, its proposal is drawn with an
//       enabled Send now beside it, and NOTHING is POSTed until that is pressed.
//       A flush, a panel open and a reload move nothing.
//   (b) THE PRESS IS WHAT SENDS IT, once, carrying the model's draft.
//   (c) A REFUSAL OPENS THE TITLE FOR EDITING. The row draws the forge's sentence,
//       the limit with both numbers, the title in an input, a live count, and a
//       Send that is dark until the title fits.
//   (d) A RELOAD AFTER A REFUSAL DOES NOT RE-POST. The note is still there and the
//       wire is still.
//   (e) THE BOX REFUSES AN OVER-LENGTH TITLE BEFORE IT IS QUEUED, and counts.
//   (g) A PUBLICATION PUT TO A SCREEN NOBODY IS AT DECLINES ITSELF, after a bounded wait --
//       and one put to somebody who is there does not. Proposal 11, 2026-09-15: a daimon
//       reached for the forge in the owner's name, this card rose on a tab he was not looking
//       at, and the turn held on it. No daimon reaches this card now (dev/verify_optimiser.mjs
//       measures that); this is the half that is still raised, by the user's own chat.
//
// The forge is stubbed at `/api/improve`: 201-shaped answers, and — on a flag —
// the 400 the real forge gives, with its sentence verbatim. The model is stubbed
// the way dev/verify_composemerge.mjs stubs it, so what is proved is improve.js's
// own wiring; dev/verify_triage.mjs proves the real model run.
//
//   eval "$(bash dev/world.sh 38 --env)"
//   node dev/verify_socialpost.mjs
//   node dev/verify_socialpost.mjs --break autosend      # polish posts at once, as it did
//   node dev/verify_socialpost.mjs --break deadend       # a refusal draws no editor
//   node dev/verify_socialpost.mjs --break nobrake       # the box does not count the title
//   node dev/verify_socialpost.mjs --break nodeadline    # the card waits for ever, unattended

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'socialpost' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Seams: the surface has to be wired, or the run proves nothing.

const SEAM = [
	{ file: 'js/improve.js', want: 'titleLimit: function () { return TITLE_LIMIT; }',
	  why: 'the client publishes no title limit, so nothing can be told the number' },
	{ file: 'js/improve.js', want: 'function polishOnly(rec)',
	  why: 'there is no path that drafts without sending' },
	{ file: 'js/improve.js', want: 'imp-note-title-in',
	  why: 'a refused note has no title editor' },
	{ file: 'js/triage.js', want: 'polishSystem',
	  why: 'the model is not told the forge\'s title limit' },
	{ file: 'js/daimond.js', want: 'function publishAskDeadline(opts)',
	  why: 'a publication card put to a screen nobody is at waits for ever' },
	{ file: 'js/daimond.js', want: "ask: 'publish'",
	  why: 'nothing can tell the publication card from any other confirm' },
];

function requireSeams() {
	const missing = [];
	for (const s of SEAM) {
		const src = FILES.get(s.file) ?? fs.readFileSync(path.join(WWW, s.file), 'utf8');
		if (!src.includes(s.want)) missing.push(`  ${s.file}: ${s.why}`);
	}
	if (missing.length) {
		console.error('the compose surface is not wired, so this run would prove nothing:');
		for (const b of missing) console.error(b);
		process.exit(2);
	}
}

// ── The breaks, each putting back exactly one piece of what was wrong.

const BREAKS = {
	// The drafting posts in the same breath again, which is defect (B) whole.
	// Only (a) and (b)'s "posts once" reddens; the refusal half is untouched.
	autosend: [{
		file: 'js/improve.js',
		find: '		if (cur.draft) return await sendDraft(cur);\n'
			+ '		if (cur.mode === \'polish\') { await polishOnly(cur); return false; }',
		with: '		if (cur.draft) return await sendDraft(cur);\n'
			+ '		if (cur.mode === \'polish\') { await polishOnly(cur); return await sendDraft(find(cur.id)); }',
	}],
	// No row draws a title editor, so there is nothing to shorten and Send is
	// never dark: the dead end the owner was left in. (c) and (f) redden.
	deadend: [{
		file: 'js/improve.js',
		find: "		wrap.className = 'imp-note-title';",
		with: "		wrap.className = 'imp-note-title';\n\t\treturn wrap;\t\t// editor removed by the break",
	}, {
		file: 'js/improve.js',
		find: '		btn.disabled = !ready;',
		with: '		btn.disabled = false;\t\t// the brake removed by the break',
	}],
	// The box takes an over-length title again and queues it for the forge to
	// refuse. Only (e) reddens.
	// The publication card waits for ever again, on a screen nobody is at: proposal 11's own
	// shape. Only (g)'s first two checks redden.
	nodeadline: [{
		file: 'js/daimond.js',
		find: '			var pubWaitMs = (req.alone || !isAttended()) ? publishAskDeadline(opts) : 0;',
		with: '			var pubWaitMs = 0;\t\t// the bound removed by the break',
	}],
	nobrake: [{
		file: 'js/improve.js',
		find: '			if (titleLen(cut.title) > TITLE_LIMIT) {',
		with: '			if (false) {',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function edit(src, spec, what) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`${what}: the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was changed and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const FILES = new Map();
function build() {
	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const p = spec.file;
			const src = FILES.get(p) ?? fs.readFileSync(path.join(WWW, p), 'utf8');
			FILES.set(p, edit(src, spec, `break '${BREAK}'`));
		}
	}
	requireSeams();
}
build();

// ── The forge, answered locally.
//
// ONE STAND-IN THROUGHOUT, refusing or not on a flag. A retry that went to a
// different server would prove the client can talk to two servers and nothing
// about the retry.

const HDR = 'x-daimond-voice';
// allowlist secret
const SECRET = 'mock-voice-ada-0000000000000';

// The forge's own words about a title past its limit, verbatim from
// oregami/src/views/proposals.rs:1167 (`LONG_TITLE`). It carries no number, which
// is the whole reason the panel has to hold one.
const LONG_TITLE_SAID = 'That title is longer than a title here may be. Nothing was '
	+ 'written; the length is there so that a listing stays a listing.';

let nextNew = 100;
const asked = [];
let refusing = null;

async function improveRoute(r) {
	const req = r.request();
	const u   = new URL(req.url());
	const q   = u.searchParams;
	const method = req.method();
	asked.push({ method, body: req.postData() || '', query: Object.fromEntries(q) });

	const json = (obj) => r.fulfill({ status: 200, contentType: 'application/json',
		body: JSON.stringify(obj) });
	const refuse = (status, error, said) => r.fulfill({ status, contentType: 'application/json',
		body: JSON.stringify({ error, said }) });

	const record = (n) => ({ number: n, title: 'Proposal ' + n, body: 'b', state: 'open',
		author: 'ada', comments: 0, opened: 1, changed: 2, discussion: [],
		votes: { for: 0, against: 0 }, mark: null, build: null, revisions: [] });

	if (method === 'GET') {
		if (q.get('n') !== null) return json(record(Number(q.get('n'))));
		return json({ proposals: [], total: 0, done: true });
	}
	if (!req.headers()[HDR]) return refuse(401, 'unvoiced', 'No voice was given.');
	const n = q.get('n');
	if (n === null && refusing) return refuse(refusing.status, refusing.error, refusing.said);
	return json(record(n !== null ? Number(n) : nextNew++));
}

const j = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stub(page) {
	for (const [p, body] of FILES) {
		const type = p.endsWith('.html') ? 'text/html' : 'application/javascript';
		await page.route('**/' + p, r => r.fulfill({ status: 200, contentType: type, body }));
	}
	await page.route(u => u.pathname === '/api/improve', improveRoute);
	await page.route('**/api/telemetry',      r => r.fulfill(j({ ok: true })));
	await page.route('**/api/account',        r => r.fulfill(j({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(j({ ok: true, challenge: 'chal-sp', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(j({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(j({ ok: true, credits_minor: 0, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(j({ ok: true, licence: false, currency: 'usd' })));
}

/// Every POST that OPENS a proposal. The count is the measurement throughout: an
/// unmade request is the claim, and a made-then-swallowed one looks the same on
/// the screen.
const opens = () => asked.filter(a => a.method === 'POST' && a.query.n === undefined);
const fields = (raw) => { const o = {}; for (const [k, v] of new URLSearchParams(raw)) o[k] = v; return o; };

const LONG = 'L'.repeat(247);

const s = await open({ name: 'socialpost', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

await signInAs(s, 'socialpost');
await page.waitForTimeout(1000);

async function stubPolish(title) {
	await page.evaluate((t) => {
		window.DaimondTriage = window.DaimondTriage || {};
		window.DaimondTriage.polish = async function (text) {
			return { title: t || ('Polished: ' + String(text || '').split('\n')[0].slice(0, 40)),
				body: 'A tidier body the model wrote from the note.' };
		};
	}, title || '');
}

async function typeAndClick(text, act) {
	await page.evaluate((t) => {
		const box = document.getElementById('improve-box');
		box.value = t;
		box.dispatchEvent(new Event('input', { bubbles: true }));
	}, text);
	await page.waitForTimeout(80);
	await page.click('#panel-social [data-act="' + act + '"]');
}

/// The one queued row, as it is drawn. `send` is read off the button rather than
/// off the record, because a control a person cannot press is the claim.
const qRow = () => page.evaluate(() => {
	const row = document.querySelector('#improve-queue .imp-queue-row');
	if (!row) return null;
	const st = row.querySelector('.imp-note-state');
	const inp = row.querySelector('.imp-note-title-in');
	const cnt = row.querySelector('.imp-note-count');
	const snd = row.querySelector('[data-act="improve-resend"]');
	return {
		id:     row.dataset.note,
		state:  st ? st.dataset.state : '',
		says:   st ? (st.textContent || '').trim() : '',
		title:  inp ? inp.value : null,
		count:  cnt ? (cnt.textContent || '').trim() : null,
		over:   cnt ? cnt.dataset.over === '1' : false,
		send:   snd ? { label: (snd.textContent || '').trim(), off: !!snd.disabled, why: snd.title } : null,
		copy:   !!row.querySelector('[data-act="improve-copy"]'),
		draft:  (row.querySelector('.imp-note-draftbody') || {}).textContent || null,
	};
});

/// Press the row's own Send. A row that is not there at all is a FAILED check
/// rather than a thrown run, so a break that empties the queue reports the rest.
async function pressSend(why) {
	const at = '#improve-queue .imp-queue-row [data-act="improve-resend"]';
	if (await page.locator(at).count() === 0) {
		check(why + ' — there is a row to press Send on', false, 'the queue is empty');
		return false;
	}
	await page.click(at);
	return true;
}

/// Type into the row's title editor as a person does.
async function typeTitle(text) {
	const has = await page.locator('#improve-queue .imp-queue-row .imp-note-title-in').count();
	if (!has) return false;
	await page.fill('#improve-queue .imp-queue-row .imp-note-title-in', text);
	await page.waitForTimeout(120);
	return true;
}

try {
	await page.evaluate(() => { window.DaimondPanels.show('social'); });
	await page.waitForTimeout(300);
	await page.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
	await page.waitForTimeout(300);

	// A voice, set the way a person sets one.
	await page.evaluate(() => window.DaimondSocial.show('settings'));
	await page.waitForTimeout(200);
	await page.click('#panel-social [data-act="improve-voice-open"]');
	await page.waitForTimeout(150);
	await page.fill('#improve-voice-in', SECRET);
	await page.click('#panel-social [data-act="improve-voice-save"]');
	await page.waitForTimeout(500);
	check('a voice is held, so the box can post',
		await page.evaluate(() => window.DaimondVoice.has()) === true);
	await page.evaluate(() => window.DaimondSocial.show('proposals'));
	await page.waitForTimeout(200);

	check('the panel knows the forge\'s title limit, and it is oregami\'s 200',
		await page.evaluate(() => window.DaimondImprove.titleLimit()) === 200);

	// ── (e) The box refuses a title the forge would, and counts ──
	let before = opens().length;
	await page.evaluate((t) => {
		const box = document.getElementById('improve-box');
		box.value = t + '\nThe body says what happened.';
		box.dispatchEvent(new Event('input', { bubbles: true }));
	}, LONG);
	await page.waitForTimeout(200);
	const counted = await page.evaluate(() => {
		const n = document.getElementById('improve-count');
		return n && !n.hidden ? (n.textContent || '').trim() : '';
	});
	check('(e) the box counts the first line once it is over the limit',
		/247/.test(counted) && /200/.test(counted), counted || 'no counter');
	await page.click('#panel-social [data-act="improve-post"]');
	await page.waitForTimeout(500);
	check('(e) pressing Post sends nothing', opens().length - before === 0,
		`${opens().length - before} posts`);
	check('(e) and queues nothing: the forge is never asked to refuse it',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);
	const said = await page.evaluate(() => (document.getElementById('improve-say').textContent || '').trim());
	check('(e) the box says both numbers, which the forge\'s own refusal cannot',
		/247/.test(said) && /200/.test(said), said.slice(0, 100));
	await shot(s, 'socialpost-toolong' + (BREAK ? '-' + BREAK : ''));

	// ── (a) Polish draws the model's proposal and WAITS ──
	await page.evaluate(() => { document.getElementById('improve-box').value = ''; });
	await stubPolish();
	before = opens().length;
	await typeAndClick('the reply box scrolls to the top on send', 'improve-polish');
	await page.waitForTimeout(1200);
	check('(a) the model ran and NOTHING was posted', opens().length - before === 0,
		`${opens().length - before} posts`);
	let r = await qRow();
	check('(a) the model\'s proposal is on the screen, title and body',
		!!r && /^Polished:/.test(r.title || '') && /tidier body/.test(r.draft || ''),
		JSON.stringify(r && [r.title, r.draft]).slice(0, 140));
	check('(a) the row says nothing has been sent',
		!!r && r.state === 'drafted' && /[Nn]othing has been sent/.test(r.says),
		JSON.stringify(r && r.says));
	check('(a) with an ENABLED Send now beside it',
		!!r && r.send && r.send.label === 'Send now' && r.send.off === false,
		JSON.stringify(r && r.send));
	await shot(s, 'socialpost-awaiting' + (BREAK ? '-' + BREAK : ''));

	// Nothing automatic may take it: a flush, a panel open, a reconnect.
	before = opens().length;
	await page.evaluate(() => window.DaimondImprove.flushQueue());
	await page.evaluate(() => window.DaimondImprove.onOpen());
	await page.evaluate(() => window.dispatchEvent(new Event('online')));
	await page.waitForTimeout(900);
	check('(a) a flush, a panel open and a reconnect post nothing',
		opens().length - before === 0, `${opens().length - before} posts`);
	check('(a) and the card is still there, still holding the draft',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 1
		&& await page.evaluate(() => !!window.DaimondImprove.notes()[0].draft));

	// ── (b) The press is what sends it ──
	before = opens().length;
	await pressSend('(b)');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(300);
	check('(b) pressing Send now posts exactly once', opens().length - before === 1,
		`${opens().length - before} posts`);
	const sent = opens().length ? fields(opens()[opens().length - 1].body) : {};
	check('(b) and what went is the model\'s draft, not the raw note',
		/^Polished:/.test(sent.title || '') && /tidier body/.test(sent.body || ''),
		JSON.stringify(sent).slice(0, 140));
	check('(b) the note leaves the queue: the forge holds it now',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);

	// ── (c) A refusal opens the title for editing ──
	//
	// The note is made over-length THROUGH THE MODEL, which is the owner's own
	// path: the box refuses a long title, so the way to get one onto the wire is
	// for the model to write it.
	refusing = { status: 400, error: 'malformed', said: LONG_TITLE_SAID };
	await stubPolish(LONG);
	before = opens().length;
	await typeAndClick('a note the model will over-title', 'improve-polish');
	await page.waitForTimeout(1200);
	r = await qRow();
	check('(c) an over-length DRAFT is held rather than posted',
		opens().length - before === 0 && !!r && r.over === true,
		`${opens().length - before} posts, ${r && r.count}`);
	check('(c) its Send is dark, and says why in both numbers',
		!!r && r.send && r.send.off === true && /247/.test(r.send.why || '') && /200/.test(r.send.why || ''),
		JSON.stringify(r && r.send));

	// Now the refusal proper: shorten it to something the box would take, let the
	// forge refuse it anyway, and read the row.
	await typeTitle('A title that fits');
	before = opens().length;
	await pressSend('(c)');
	await page.waitForTimeout(900);
	check('(c) the press sent it once and the forge refused',
		opens().length - before === 1, `${opens().length - before} posts`);
	r = await qRow();
	check('(c) the row says, in the forge\'s own words, that it would not take it',
		!!r && r.state === 'refused' && /longer than a title here may be/.test(r.says),
		JSON.stringify(r && r.says).slice(0, 160));
	check('(c) and the title is open for editing, with a live count beside it',
		!!r && r.title === 'A title that fits' && /200/.test(r.count || ''),
		JSON.stringify(r && [r.title, r.count]));
	check('(c) Copy is still on the row', !!r && r.copy === true);

	// Type past the limit: Send goes dark, and a press sends nothing.
	check('(c) the row offers an editor to type an over-length title into',
		await typeTitle(LONG));
	r = await qRow();
	check('(c) typing past the limit disables Send and marks the count',
		!!r && r.send && r.send.off === true && r.over === true && /247/.test(r.count || ''),
		JSON.stringify(r && [r.count, r.send]));
	before = opens().length;
	await page.evaluate(() => window.DaimondImprove.resend(
		document.querySelector('#improve-queue .imp-queue-row').dataset.note));
	await page.waitForTimeout(700);
	check('(c) and a press while it is over sends nothing at all',
		opens().length - before === 0, `${opens().length - before} posts`);

	// ── (d) A reload after a refusal does not re-POST ──
	before = opens().length;
	await page.reload();
	await page.waitForTimeout(2500);
	await page.evaluate(() => { window.DaimondPanels.show('social'); });
	await page.waitForTimeout(400);
	// The panel opens on Messages after a reload now (2026-09-15: Feedback is a
	// chip, not the default view), so the queue this section reads is hidden
	// until Feedback is chosen -- the same switch the setup above already makes
	// once, before any of this ever ran.
	await page.evaluate(() => window.DaimondSocial.show('proposals'));
	await page.waitForTimeout(200);
	await page.evaluate(() => { if (window.DaimondImprove) window.DaimondImprove.onOpen(); });
	await page.waitForTimeout(1200);
	check('(d) a reload posts nothing: a refusal is final until it is edited',
		opens().length - before === 0, `${opens().length - before} posts`);
	check('(d) and the note is still held here, so it can be shortened and sent',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 1
		&& await page.evaluate(() => !!window.DaimondImprove.notes()[0].refused));
	r = await qRow();
	check('(d) the shortened title survived the reload with it',
		!!r && r.title === LONG, r && r.title && r.title.length);
	await shot(s, 'socialpost-refused' + (BREAK ? '-' + BREAK : ''));

	// And the way out: shorten it, and the same press goes.
	refusing = null;
	await typeTitle('A title the forge will take');
	before = opens().length;
	await pressSend('(d)');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(300);
	check('(d) shortening it and pressing Send posts it, once',
		opens().length - before === 1, `${opens().length - before} posts`);
	const last = opens().length ? fields(opens()[opens().length - 1].body) : {};
	check('(d) carrying the SHORTENED title',
		last.title === 'A title the forge will take', JSON.stringify(last).slice(0, 120));
	check('(d) and the note leaves the queue',
		await page.evaluate(() => window.DaimondImprove.notes().length) === 0);

	// ── (f) A refused VERBATIM note opens its own title ─────────
	//
	// The path above goes through the model, so the editor it draws is the draft's.
	// A note posted as written is refused by the forge too -- for a title this
	// client would take and the forge would not, which is exactly what a limit
	// that drifted apart looks like -- and that row has to offer the same edit.
	refusing = { status: 400, error: 'malformed', said: LONG_TITLE_SAID };
	before = opens().length;
	await typeAndClick('A plainly written title\nand the body under it.', 'improve-post');
	await page.waitForTimeout(900);
	r = await qRow();
	check('(f) a refused verbatim note is kept, and says what the forge said',
		opens().length - before === 1 && !!r && r.state === 'refused'
		&& /longer than a title here may be/.test(r.says),
		`${opens().length - before} posts, ${JSON.stringify(r && r.says).slice(0, 90)}`);
	check('(f) its own first line is what the editor holds',
		!!r && r.title === 'A plainly written title', JSON.stringify(r && r.title));
	check('(f) typing past the limit darkens Send here too',
		await typeTitle(LONG));
	r = await qRow();
	check('(f) and the count says how far over',
		!!r && r.over === true && r.send && r.send.off === true,
		JSON.stringify(r && [r.count, r.send]));
	// Cut it back, and the body the person wrote is still under it.
	refusing = null;
	await typeTitle('A shorter title');
	before = opens().length;
	await pressSend('(f)');
	for (let i = 0; i < 40 && await page.evaluate(() => window.DaimondImprove.notes().length > 0); i++) {
		await page.waitForTimeout(150);
	}
	await page.waitForTimeout(300);
	const vf = opens().length ? fields(opens()[opens().length - 1].body) : {};
	check('(f) the edited title goes, and the body is exactly as it was written',
		opens().length - before === 1 && vf.title === 'A shorter title'
		&& /and the body under it\./.test(vf.body || ''),
		JSON.stringify(vf).slice(0, 140));

	// ── (g) A publication put to a screen nobody is at ─────────
	//
	// PROPOSAL 11, 2026-09-15. A daimon called `social_send` with a comment on the forge in the
	// owner's name; this card rose on a tab he was not looking at, nothing answered it, and the
	// turn held there until somebody told him. No daimon reaches this card any more -- see
	// `diamondMayPublish`, measured in dev/verify_optimiser.mjs -- but the card itself is still
	// raised by an ordinary chat, and a question nobody can answer must not hold a turn open for
	// an afternoon. So: bounded when nobody is there, and NOT bounded when somebody is.
	//
	// The deadline is driven short through `__daimondEgressAllowed`'s second argument, which
	// `publishAskDeadline` clamps DOWNWARD only -- a caller can bring the refusal forward and
	// can never push it back. Two minutes is what it gets in production.
	const gone = () => page.evaluate(() => !document.querySelector('.modal.dlg[data-ask="publish"]'));
	before = opens().length;
	const t0 = Date.now();
	// RACED, so the break this check exists for REDDENS rather than hanging: the fault being
	// measured is a card that waits for ever, and a verifier that waits for ever with it has
	// reported nothing. `still-waiting` is not a verdict the gate can return, so it can only
	// mean the deadline never fired.
	const unattended = await page.evaluate(() => Promise.race([
		window.__daimondEgressAllowed(
			JSON.stringify({ tool: 'social_send', url: 'A COMMENT on proposal 11, in your name.',
				alone: true }), { deadlineMs: 1500 }),
		new Promise((r) => setTimeout(() => r('still-waiting'), 12000)),
	]));
	const waited = Date.now() - t0;
	// Read BEFORE anything of this run's tidies up, or the tidying is what the check measures.
	const wentAway = await gone();
	// And then tidied, so a card the break left standing does not sit over the next check.
	await page.keyboard.press('Escape').catch(() => {});
	await page.waitForTimeout(200);
	check('(g) a publication nobody is there to answer declines itself, and says no',
		unattended === 'deny' && waited >= 1200 && waited < 12000, `${unattended} after ${waited}ms`);
	check('(g) and the card is gone rather than left standing on the screen', wentAway);
	check('(g) and nothing was published by the running out',
		opens().length - before === 0, `${opens().length - before} posts`);

	// The other direction, which is the one that would be the worse fault: a person who has just
	// typed the sentence that led here is reading a draft, and a card that withdrew itself from
	// under them is worse than one that waits. `isAttended` is true here -- this run has been
	// clicking the page for a minute -- so no deadline is armed at all.
	// Stamped deliberately: `isAttended` is foreground plus an interaction inside 90 s, and a
	// run that had spent its last minute in `page.evaluate` alone would read as walked-away and
	// measure the wrong branch. A key press is what a person at the device produces.
	await page.keyboard.press('Shift');
	const attended = page.evaluate(() => window.__daimondEgressAllowed(
		JSON.stringify({ tool: 'social_send', url: 'A PROPOSAL the user asked for.' }),
		{ deadlineMs: 1500 }));
	await page.waitForSelector('.modal.dlg[data-ask="publish"]', { timeout: 5000 });
	await page.waitForTimeout(3000);
	check('(g) a publication somebody IS there for keeps its card, however long they read it',
		!(await gone()));
	await page.click('.modal.dlg .dlg-cancel', { force: true });
	check('(g) and Cancel is still the no it always was', (await attended) === 'deny');
	await shot(s, 'socialpost-publish-wait' + (BREAK ? '-' + BREAK : ''));

	// A THIRD DIRECTION, and the one proposal 11 actually was (2026-09-15): attended
	// at the MOMENT the card rose -- `isAttended` only ever asks about the last 90
	// seconds -- and then genuinely left. Nobody presses Cancel, nobody touches the
	// page again, and the turn held there for a day. `publishAskDeadline`'s own
	// bound never arms here (`req.alone || !isAttended()` reads false at the
	// moment of raising, exactly as the check above proves), so what has to close
	// this card is the OTHER half of the fix: `armIdleBound` inside `dialog()`
	// itself, which answers ANY standing dialog once nobody has touched the page
	// for `DIALOG_IDLE_MS`. Driven fast through `window.__daimondDialogIdleMs`,
	// the same downward-only test hook `netAskDeadline`/`publishAskDeadline`
	// already use for their own deadlines.
	await page.evaluate(() => { window.__daimondDialogIdleMs = 1200; });
	await page.keyboard.press('Shift');            // attended at the moment it is raised
	before = opens().length;
	const t1 = Date.now();
	const abandoned = page.evaluate(() => Promise.race([
		window.__daimondEgressAllowed(
			JSON.stringify({ tool: 'social_send', url: 'A PROPOSAL, then nobody answers it.' })),
		new Promise((r) => setTimeout(() => r('still-waiting'), 8000)),
	]));
	await page.waitForSelector('.modal.dlg[data-ask="publish"]', { timeout: 5000 });
	// And then nothing: no more keys, no more clicks, past the idle bound above.
	const abandonedResult = await abandoned;
	const waitedAbandoned = Date.now() - t1;
	const wentAwayAbandoned = await gone();
	check('(g) attended when it was raised, then genuinely left, declines itself too',
		abandonedResult === 'deny' && waitedAbandoned < 8000, `${abandonedResult} after ${waitedAbandoned}ms`);
	check('(g) and the card does not stand for ever once nobody is answering it any more',
		wentAwayAbandoned);
	check('(g) and nothing was published by the idle bound running out',
		opens().length - before === 0, `${opens().length - before} posts`);
	await page.evaluate(() => { window.__daimondDialogIdleMs = 0; });   // back to the real 30 minutes

	const errs = errors(s).filter(e => !/Failed to load resource/.test(e));
	check('nothing above was reached by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log(`\nforge opens: ${opens().length}`);
console.log(`\nsocialpost: ${ok.length} ok, ${bad.length} failed`);
if (bad.length) { for (const b of bad) console.log('  FAILED: ' + b); process.exit(1); }
