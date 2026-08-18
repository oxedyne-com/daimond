// dev/verify_group.mjs -- groups: a membership list with no group key.
//
// EVERY SECTION BELOW RUNS WITH NO GATEWAY IN THE PATH AT ALL. Three browsers,
// three profiles, three identities; the bytes are carried between them by this
// file, which is what a relay does and nothing more. That is the shape a group
// needs and it is how the two-party seal was proved (dev/verify_post.mjs §1) --
// if a group only works when a server is in the middle, the server is part of
// the cryptography and the whole design is a lie.
//
// The properties, each one a thing that could break silently:
//
//   0. THE SEAM IS IN THE APP. `<script src="js/group.js">` is in index.html and
//      post.js calls into it. Nothing here injects either.
//   1. ONE ENVELOPE, N SLOTS, THREE IDENTITIES. A roster A composes opens on B
//      and on C and NOT on D. The envelope carries one slot per member and no
//      recipient tag, so it says how many and never who.
//   2. THE ID IS THE AUTHORISATION. A roster is obeyed only where the id
//      recomputed from its OWN author and salt is the `to` its signature covers.
//      B cannot mint a roster for A's group; the negative is checked with B
//      holding every key and every module A holds.
//   3. JOINING SHOWS NOTHING EARLIER, and the sentence is on the screen BEFORE
//      the press. C, added after a message was sent, cannot open that message --
//      and is refused for the right reason.
//   4. REMOVING RETRACTS NOTHING, and that sentence is on the screen too. After
//      A drops C: C still holds every message; C's own record says left; and a
//      message C writes to the group is REFUSED BY B, because there is no group
//      key to rotate and every reader is where a removal is enforced.
//   5. A PERSON CANNOT WRITE A ROSTER. The marker line is refused at the one
//      door a person's own text comes through.
//   6. THE FAN-OUT ARITHMETIC IS AT THE FAN-OUT, in a comment, with the number
//      this build actually has rather than the one the plan assumed.
//   7. A KEY THIS DEVICE DOES NOT STAND BEHIND GETS NO SLOT, and the sender is
//      told who was left out. Counted in the envelope, not in a sentence.
//   8. ONE GROUP MESSAGE IS ONE EXPIRY NOTICE. The relay writes one per box; a
//      dozen identical rows would read as a dozen lost messages.
//   9. THE MERGE CONVERGES. A roster and a decision travel on separate clocks
//      with one writer each, so two parcels give one record in either order.
//  10. THE CREATOR'S PATH IS THE SHIPPED ONE, pressed rather than called.
//  11. A KEY THAT COULD NOT GO IN IS NAMED, and a duplicate is not the same fault.
//  12. A REFUSED DELIVERY IS DRAWN, for a message and for a roster.
//  13. A GROUP CAN BE CLOSED, ONCE, AND NO READER WILL REOPEN IT. Closing is the
//      creator writing the roster that names NOBODY -- because a group IS its
//      membership list. It travels the road every roster travels, it takes one
//      confirmation dialogue, it destroys nothing, and it cannot be undone: a
//      later roster from the creator's own key is refused by `consume` on every
//      device that already holds the empty one.
//
// ── WHY 10 EXISTS, WHICH IS THE ONLY INTERESTING THING IN THIS FILE ──────────
//
// This suite reported 88 assertions green over a build in which THE CREATOR OF A
// GROUP COULD NOT WRITE TO IT. `create` applied its own roster through `consume`,
// which filed an unknown group as `invited`, and `sealTo` then refused the creator
// with "Join this group before writing to it." Nothing in the app ever joined
// them: the panel's Make branch says how many people were told and stops.
//
// It passed because sections 3, 4 and 7 each called `DaimondGroup` `join()` on the
// creator's own page immediately after `create()` -- AND THAT IS A LINE THE
// APPLICATION DOES NOT HAVE. The test wrote the missing behaviour itself and then
// measured its own repair. Every assertion after it was true of a device no user
// can produce.
//
// So two rules hold here now, and the first is checked by section 10 against this
// file's own source rather than left as an instruction in a comment:
//
//   * NOTHING IN THIS FILE MAY CALL A METHOD TO PUT A DEVICE IN A STATE THE APP
//     PUTS IT IN ITSELF. A creator is joined by `create`, or the build is broken.
//     A member joins by PRESSING JOIN, through the same document listener the
//     panel's own control goes through.
//   * The press is dispatched on the real control rather than hit-tested, because
//     the Social panel is closed in a fresh profile and the group section is
//     therefore zero-sized. What is under test is group.js's own wiring, which the
//     dispatch drives in full; whether improve.js has the panel open is a
//     different file's property.
//
//   node dev/verify_group.mjs        # every section
//   node dev/verify_group.mjs 10 11  # by number, for proving one red
//
// ── PROVING THESE RED, MEASURED RATHER THAN REASONED ─────────────────────────
//
// Each break below was applied to `www/js/group.js`, run, and the sections it
// moved written down. Two of the answers were not the expected ones and both are
// kept here, because a break that reddens LESS than it should is a finding about
// the check and not about the code.
//
//   * `sealTo`, delete the `isClosed` branch  → 4 red, all in 13: the sender is
//     told "you are no longer in this group" about a group they closed.
//   * `consume`, delete `if (isClosed(rec)) return false;`  → 8 red, all in 13,
//     nothing in 0-12. This is the one that makes "it cannot be undone" a
//     property: without it a later roster from the creator revives the group on
//     every device that had already closed it.
//   * `roster`, delete its own `isClosed` guard  → 1 red. NOT the outcome check:
//     `setMembers` still fails, because `consume` refuses the read-back and
//     `roster` will not send a roster it could not apply. So that guard buys the
//     SENTENCE and not the refusal, which is written at the guard itself.
//   * `parseOp`, put `|| !j.members.length` back  → 10 red in 13 and NOTHING in
//     0-12, so relaxing it is invisible to every other roster. It also aborted
//     the section on `posts[0]`, which is why `closingEnv` exists below.
//   * `askClose`, ignore the answer and return true  → 4 red: the dialogue is
//     asked, dismissed, and the group closes anyway.
//   * `draw`, delete the settle loop  → 2 red: a record left saying `joined` over
//     an empty roster keeps offering a destination in `post.js`'s picker.
//   * `draw`, partition on `state` alone  → 4 red: a closed group is drawn by
//     `drawLeft`, so it says "you are no longer in this group" instead of what
//     happened, and carries no mark a stylesheet could reach.
//   * `roster`, count `bad.length + missing.length` in `group.err_no_card` again
//     → 1 red, and only in the fixture that supplies ONE OF EACH fault. The
//     one-fault fixtures cannot see it: with no bad key the arithmetic is right
//     by accident.
//   * `roster`, send `bad` through `group.err_no_card` instead of
//     `group.err_bad_keys`  → 5 red in 11.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP  = path.dirname(HERE);

let failures = 0;
function ok(cond, what, detail) {
	if (cond) { console.log(`  ok    ${what}`); return true; }
	failures++;
	console.log(`  FAIL  ${what}${detail !== undefined ? `  -- ${JSON.stringify(detail)}` : ''}`);
	return false;
}
function eq(got, want, what) {
	return ok(JSON.stringify(got) === JSON.stringify(want), what, { got, want });
}

/// Wait for the page the browser assembled. Nothing is injected: a missing
/// script tag is a failure to report, never a file to load from disk.
async function ready(s) {
	await s.page.waitForFunction(
		() => !!window.DaimondPost && !!window.DaimondTrust && !!window.DaimondGroup
			&& !!document.querySelector('#social-messages-list'),
		null, { timeout: 15000 }
	).catch(() => { throw new Error(
		'the page did not assemble: post.js, trust.js, group.js or '
		+ '#social-messages-list is missing from www/index.html.'); });
}

/// An identity with a sealing key and a card, exactly as a person's first
/// unlock makes one.
const card = (s) => s.page.evaluate(async () => {
	await window.DaimondIdentity.ensureSealingKey();
	await window.DaimondIdentity.mintCard();
	const raw = await window.DaimondIdentity.publicKeyRaw();
	let hex = '';
	for (const b of raw) hex += ('0' + b.toString(16)).slice(-2);
	return {
		text: window.DaimondTrust.cardText(),
		pub:  window.DaimondIdentity.publicKeyB64url(),
		key:  hex,
	};
});

/// Hand one card to one device, the way a paste does, through trust.js.
const take = (s, text) => s.page.evaluate(async (t) => {
	const c = window.DaimondTrust.parse(t);
	if (!c) return false;
	await window.DaimondTrust.record(c, window.DaimondTrust.ROUTE.PASTE);
	await window.DaimondPost.refreshPeople();
	return true;
}, text);

/// Hand one device one row, exactly as the relay hands one over.
///
/// THROUGH `DaimondPost.take`, which is the function a real `collect` calls for
/// every row it fetches. Nothing here opens an envelope itself or writes a
/// record itself: a helper that did would still pass on a build where `collect`
/// had stopped calling `take` at all, which is a check measuring less than the
/// run it stands in for.
let SEQ = 0;
const deliver = (s, env, addr) => s.page.evaluate(async ([e, a, seq]) => {
	const r = await window.DaimondPost.take({
		kind: 'post', addr: a, envelope: e, seq,
		ts: Math.floor(Date.now() / 1000), tray: false, expired: false, from_pub: '',
	});
	const rows = window.DaimondPost.list().concat(window.DaimondPost.tray());
	const held = rows.filter(m => m.addr === a).pop() || null;
	return {
		ok:    r.got > 0 || r.notes > 0,
		op:    r.notes > 0,
		moved: r.notes > 0,
		body:  held && !held.bad ? held.body : '',
		gid:   held ? (held.gid || '') : '',
		tray:  held ? !!held.tray : false,
		why:   (held && held.bad) || r.why || '',
	};
}, [env, addr, ++SEQ]);

/// Draw the group section, and wait for it: the roster is read out from under the
/// passphrase, so `render` returns before there is anything in the host.
const panel = (s) => s.page.evaluate(async () => {
	await window.DaimondPost.read();
	window.DaimondPost.render();
	const host = document.querySelector('#post-groups');
	for (let i = 0; i < 60 && host && !host.childElementCount; i++) {
		await new Promise(r => setTimeout(r, 25));
	}
	return { there: !!host, filled: !!host && host.childElementCount > 0,
		text: host ? host.textContent : '' };
});

/// The state this device holds for one group, or 'none'.
const stateOf = (s, gid) => s.page.evaluate(async (g) =>
	(await window.DaimondGroup.get(g) || {}).state || 'none', gid);

/// Press one control in the group section, and wait for the state it is meant to
/// produce. The handler is fire-and-forget -- a click returns before the record is
/// written -- so a press that did not settle is reported as a press, never as the
/// property it was standing in for.
async function press(s, sel, until) {
	const hit = await s.page.evaluate((q) => {
		const b = document.querySelector(q);
		if (!b) return false;
		b.click();
		return true;
	}, sel);
	if (!hit) return { hit: false, why: `no control matched ${sel}` };
	for (let i = 0; i < 80; i++) {
		if (await s.page.evaluate(until)) return { hit: true, settled: true };
		await new Promise(r => setTimeout(r, 50));
	}
	return { hit: true, settled: false };
}

/// JOIN A GROUP THE WAY A PERSON DOES: press Join on the invitation.
///
/// The one repair this file is allowed to perform on a device, because it is the
/// one the panel performs. See the header: calling the module's own `join` was how
/// a creator who could not write to their own group passed 88 assertions.
async function joinByPress(s, gid) {
	await panel(s);
	const r = await press(s,
		`#post-groups [data-gid="${gid}"] [data-act="group-join"]`,
		() => true);
	if (!r.hit) return r;
	for (let i = 0; i < 80; i++) {
		if (await stateOf(s, gid) === 'joined') return { hit: true, settled: true };
		await new Promise(x => setTimeout(x, 50));
	}
	return { hit: true, settled: false, state: await stateOf(s, gid) };
}

/// Press a control, read the confirmation dialogue it opens, and answer it.
///
/// THROUGH THE APP'S OWN MODAL, `daimond.js`'s one dialog frame, driven by
/// clicking its own buttons. Stubbing `DaimondCore.confirm` would be quicker and
/// would pass on a build whose dialogue never opens at all -- which is half of
/// what "one confirmation dialogue" is asked to mean, and the half a stub cannot
/// see. `share.js` stubs it in `verify_share.mjs` for a case that is about the
/// ANSWER; this one is about the asking.
///
/// `answer` true presses the accepting button, false the way out. The card's own
/// text comes back so a caller asserts the WORDS a reader is shown.
async function pressAndAnswer(s, sel, answer) {
	const hit = await s.page.evaluate((q) => {
		const b = document.querySelector(q);
		if (!b) return false;
		b.click();
		return true;
	}, sel);
	if (!hit) return { hit: false, why: `no control matched ${sel}` };
	let card = null;
	for (let i = 0; i < 80; i++) {
		card = await s.page.evaluate(() => {
			const back = document.querySelector('.modal.dlg');
			if (!back) return null;
			const ok = back.querySelector('.dlg-ok');
			return {
				title:  (back.querySelector('h2') || {}).textContent || '',
				text:   back.textContent || '',
				ok:     ok ? ok.textContent : '',
				danger: !!ok && ok.classList.contains('danger'),
				cancel: !!back.querySelector('.dlg-cancel'),
			};
		});
		if (card) break;
		await new Promise(r => setTimeout(r, 50));
	}
	if (!card) return { hit: true, asked: false };
	await s.page.evaluate((yes) => {
		const back = document.querySelector('.modal.dlg');
		const b = back && back.querySelector(yes ? '.dlg-ok' : '.dlg-cancel');
		if (b) b.click();
	}, !!answer);
	// AND IT GOES AWAY. A dialogue that answered and stayed would leave the next
	// press finding two, and the second press in this section would drive the first
	// one's card.
	for (let i = 0; i < 40; i++) {
		if (!await s.page.evaluate(() => !!document.querySelector('.modal.dlg'))) break;
		await new Promise(r => setTimeout(r, 25));
	}
	return { hit: true, asked: true, card };
}

/// `sealGroup`'s answer carries the composed envelope under `made`; these two keep
/// the reach into it in one place.
const made2env  = (r) => (r && r.made && r.made.envelope) || '';
const made2addr = (r) => (r && r.made && r.made.addr) || '';

/// THE RELAY, PLAYED BY A FUNCTION, for the two sections that need a delivery to
/// either land or be refused.
///
/// Every section in this file runs with no gateway in the path, and this does not
/// change that: it is the least a relay can be and still be one. It records what
/// it was handed -- so a press can be followed by carrying the bytes on -- and it
/// answers PER RECIPIENT, which is the only way a partial fan-out exists to be
/// reported at all. A stub that refused everybody would leave `ok:true` beside a
/// list of refusals untested, and that is precisely the case nothing drew.
///
/// `fullFor` is the base64url key whose box answers 507. '' is a relay that takes
/// everything, which is the negative control.
const stubRelay = (s, fullFor) => s.page.evaluate((full) => {
	window.__posts = [];
	if (!window.__realFetch) window.__realFetch = window.DaimondGateway.gwFetch;
	window.DaimondGateway.gwFetch = async (q, opts) => {
		let body = null;
		try { body = JSON.parse(opts && opts.body); } catch (e) { body = null; }
		if (!body || !body.envelope) return await window.__realFetch(q, opts);
		window.__posts.push({ to: String(body.to), addr: String(body.addr),
			envelope: String(body.envelope) });
		// 507 is a full box: the relay's answer about a member who has not
		// collected their mail, and the one that must not silence a group.
		const status = (full && String(body.to) === full) ? 507 : 200;
		return { status, json: async () => (status === 200 ? { ok: true } : { ok: false }) };
	};
}, fullFor || '');

/// What the stub was handed, oldest first.
const handed = (s) => s.page.evaluate(() => (window.__posts || []).slice());

/// Put the real one back, so a section cannot leak a relay into the next.
const realRelay = (s) => s.page.evaluate(() => {
	if (window.__realFetch) window.DaimondGateway.gwFetch = window.__realFetch;
});

/// MAKE A GROUP THE WAY A PERSON DOES: the name box, the picker, the Make button,
/// and then whatever the panel's own status line says about it. Nothing else --
/// no `create`, and above all nothing afterwards.
async function makeByPress(s, name, keys) {
	await panel(s);
	return await s.page.evaluate(async ([nm, ks]) => {
		const box = document.querySelector('#group-make');
		if (!box) return { err: 'the Make box is not drawn' };
		const field = document.querySelector('#group-name');
		const pick  = document.querySelector('#group-members');
		if (!field || !pick) return { err: 'the Make box has no name or no picker' };
		field.value = nm;
		const offered = [...pick.options].map(o => o.value);
		[...pick.options].forEach((o) => { o.selected = ks.indexOf(o.value) >= 0; });
		const chose = [...pick.selectedOptions].map(o => o.value);
		const btn = box.querySelector('[data-act="group-make"]');
		if (!btn) return { err: 'the Make box has no Make control' };
		btn.click();
		let note = '';
		for (let i = 0; i < 100; i++) {
			note = (document.querySelector('#group-note') || {}).textContent || '';
			if (note && !/^Making/.test(note)) break;
			await new Promise(r => setTimeout(r, 50));
		}
		const gs = await window.DaimondGroup.list();
		return { note, offered, chose,
			groups: gs.map(g => ({ gid: g.gid, state: g.state, n: g.members.length })) };
	}, [String(name), keys]);
}

// ── 0. The seam is in the app ────────────────────────────────

async function seamIsReal() {
	console.log('\n0. the seam is in the app, not in this file');
	const s = await open({ name: 'group-seam', connect: false });
	try {
		const seen = await s.page.evaluate(async () => {
			const html = await (await fetch('/index.html')).text();
			return {
				tag:    /<script[^>]+src=["']js\/group\.js["']/.test(html),
				global: !!window.DaimondGroup,
				// post.js must actually reach into it, or group.js is a module
				// with no production caller -- which is what three lanes shipped
				// this week and called done.
				mounts: typeof window.DaimondGroup?.mount === 'function',
				seals:  typeof window.DaimondPost?.sealGroup === 'function',
				absorb: typeof window.DaimondPost?.absorbRoster === 'function',
				store:  typeof window.DaimondPost?.groups === 'function',
			};
		});
		ok(seen.tag,    '<script src="js/group.js"> is in www/index.html');
		ok(seen.global, 'window.DaimondGroup is up');
		ok(seen.mounts && seen.seals && seen.absorb && seen.store,
			'post.js reaches group.js through four published seams', seen);

		// And the region is drawn by post.js's own render, not by this file. The
		// draw is asynchronous -- the roster is read out from under the
		// passphrase -- so this waits for it rather than reading the frame
		// `render` returned in.
		const drawn = await s.page.evaluate(async () => {
			await window.DaimondIdentity.ensureSealingKey();
			await window.DaimondPost.read();
			window.DaimondPost.render();
			const host = document.querySelector('#post-groups');
			for (let i = 0; i < 40 && host && !host.childElementCount; i++) {
				await new Promise(r => setTimeout(r, 25));
			}
			return { there: !!host, filled: !!host && host.childElementCount > 0,
				text: host ? host.textContent.slice(0, 120) : '' };
		});
		ok(drawn.there && drawn.filled,
			'post.js renders the group section inside its own region', drawn);
	} finally { await s.close(); }
}

// ── 1. One envelope, N slots, three identities ───────────────

async function threeIdentities() {
	console.log('\n1. one roster, three identities, no server in the path');
	const a = await open({ name: 'group-a', connect: false });
	const b = await open({ name: 'group-b', connect: false });
	const c = await open({ name: 'group-c', connect: false });
	const d = await open({ name: 'group-d', connect: false });
	try {
		for (const s of [a, b, c, d]) await ready(s);
		const A = await card(a), B = await card(b), C = await card(c), D = await card(d);
		ok(await take(a, B.text) && await take(a, C.text),
			'A holds cards for B and C');

		const made = await a.page.evaluate(async ([kb, kc]) =>
			window.DaimondGroup.create('The file view', [kb, kc]), [B.key, C.key]);
		ok(made.ok, 'A made a group', made);
		eq(made.members, 3, 'the roster names three people, A included');

		// The envelope's own shape. One slot per member, and A's own Sent slot is
		// not a fourth: A is already in the roster.
		const shape = await a.page.evaluate((env) => {
			const bin = atob(env);
			const b = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
			return { magic: String.fromCharCode(b[0], b[1], b[2], b[3]), n: b[36],
				len: b.length };
		}, made.envelope);
		eq(shape.magic, 'DPS1', 'it is one sealed envelope and not three');
		eq(shape.n, 3, 'it carries one slot per member and no more');
		// 4 magic + 32 epk + 1 count + 3x60 slot + 12 iv, then the body. The
		// arithmetic is asserted rather than described, because the comment at the
		// fan-out is only worth having if the number in it is this one.
		ok(shape.len > 4 + 32 + 1 + 3 * 60 + 12,
			'and 60 bytes of slot each, which is the number the fan-out comment uses',
			shape);

		// B and C each open the SAME bytes. A group message is one envelope.
		const gotB = await deliver(b, made.envelope, made.addr);
		const gotC = await deliver(c, made.envelope, made.addr);
		ok(gotB.ok && gotB.op, 'B opened the roster', gotB);
		ok(gotC.ok && gotC.op, 'C opened the same bytes', gotC);

		const listB = await b.page.evaluate(() => window.DaimondGroup.list());
		eq(listB.length, 1, 'B holds one group');
		eq(listB[0] && listB[0].state, 'invited',
			'and it is an INVITATION, not a group B has been put in without asking');
		eq(listB[0] && listB[0].gid, made.gid, 'at the id A derived');

		// The negative that makes the positive mean something. D holds a sealing
		// key, a full bridge and the group module -- so a refusal about any of
		// those would be this assertion passing by accident.
		const gotD = await deliver(d, made.envelope, made.addr);
		ok(!gotD.ok, 'a fourth identity cannot open it', gotD);
		ok(/not sealed to any key/i.test(gotD.why || ''),
			'and is refused because no slot is theirs, not because it could not try',
			gotD.why);
		eq((await d.page.evaluate(() => window.DaimondGroup.list())).length, 0,
			'and holds no group as a result of having been sent one');
		return { A, B, C, D, gid: made.gid };
	} finally { await Promise.all([a.close(), b.close(), c.close(), d.close()]); }
}

// ── 2. The id is the authorisation ───────────────────────────

async function idIsTheAuthorisation() {
	console.log('\n2. only the creator can write a roster, and it is an identity');
	const a = await open({ name: 'group-auth-a', connect: false });
	const b = await open({ name: 'group-auth-b', connect: false });
	const c = await open({ name: 'group-auth-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const A = await card(a), B = await card(b), C = await card(c);
		for (const [who, texts] of [[a, [B.text, C.text]], [b, [A.text, C.text]],
			[c, [A.text, B.text]]]) {
			for (const t of texts) await take(who, t);
		}

		const made = await a.page.evaluate(async ([kb, kc]) =>
			window.DaimondGroup.create('A group of A\'s', [kb, kc]), [B.key, C.key]);
		ok(made.ok, 'A made a group');
		await deliver(b, made.envelope, made.addr);
		await deliver(c, made.envelope, made.addr);

		// The derivation is what the whole model rests on, so it is checked
		// directly: A's id comes out of A's key and nobody else's.
		const derived = await b.page.evaluate(async ([creator, gid]) => {
			const rec = (await window.DaimondGroup.get(gid));
			return {
				fromA: await window.DaimondGroup.deriveId(creator, rec.salt),
				fromB: await window.DaimondGroup.deriveId(
					(await (async () => {
						const raw = await window.DaimondIdentity.publicKeyRaw();
						let h = ''; for (const x of raw) h += ('0' + x.toString(16)).slice(-2);
						return h;
					})()), rec.salt),
				salt:  rec.salt,
			};
		}, [A.key, made.gid]);
		eq(derived.fromA, made.gid, 'the id recomputes from A\'s key and the salt');
		ok(derived.fromB !== made.gid,
			'and does not recompute from B\'s key with the same salt', derived);

		// B forges: same salt, same members, B's own signature, A's group id in
		// the signed `to`. B holds every key and every module A holds.
		const forged = await b.page.evaluate(async ([gid, salt, ka, kb, kc]) => {
			const unhex = (s) => {
				const u = new Uint8Array(s.length >> 1);
				for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16);
				return u;
			};
			const hex = (u) => { let h = ''; for (const x of u) h += ('0' + x.toString(16)).slice(-2); return h; };
			const people = await window.DaimondTrust.people();
			const encOf = (k) => (people.find(p => p.key === k) || {}).enc;
			const mineEnc = hex(window.DaimondIdentity.sealingKeyRaw());
			const members = [
				{ k: ka, e: encOf(ka), n: '' },
				{ k: kb, e: mineEnc,   n: '' },
				{ k: kc, e: encOf(kc), n: '' },
			];
			const body = window.DaimondGroup.MARK + '\n'
				+ JSON.stringify({ op: 'roster', salt, name: 'B\'s takeover', members });
			const made = await window.DaimondPost.compose({
				body,
				group: { id: unhex(gid), enc: [encOf(ka), encOf(kc)].map(unhex) },
			});
			return { addr: made.addr, envelope: made.envelope };
		}, [made.gid, derived.salt, A.key, B.key, C.key]);

		const seen = await deliver(c, forged.envelope, forged.addr);
		ok(!seen.ok, 'C refuses a roster B signed for A\'s group', seen);
		ok(/addressed to a different key/i.test(seen.why || ''),
			'and refuses it as an address that is not C\'s to open', seen.why);

		// AND NOTHING MOVED. A refusal that still applied the roster would be a
		// refusal in the log and a takeover in the record.
		const after = await c.page.evaluate(async (gid) => {
			const rec = await window.DaimondGroup.get(gid);
			return { name: rec.name, members: rec.members.length };
		}, made.gid);
		ok(after.name !== 'B\'s takeover',
			'and C\'s roster is still the one A wrote', after);
	} finally { await Promise.all([a.close(), b.close(), c.close()]); }
}

// ── 3. Joining shows nothing earlier ─────────────────────────

async function joiningShowsNothing() {
	console.log('\n3. joining shows nothing earlier, and the screen says so first');
	const a = await open({ name: 'group-join-a', connect: false });
	const b = await open({ name: 'group-join-b', connect: false });
	const c = await open({ name: 'group-join-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const A = await card(a), B = await card(b), C = await card(c);
		await take(a, B.text); await take(a, C.text);

		// A group of two: A and B. C is not in it yet.
		const first = await a.page.evaluate(async (kb) =>
			window.DaimondGroup.create('Just us', [kb]), [B.key]);
		ok(first.ok, 'A made a group of two');
		// A IS IN IT ALREADY, and nothing here puts them there. This used to be
		// `join()` on A's own page, which is the line that made the whole suite
		// green over a creator who could not write to their own group.
		eq(await stateOf(a, first.gid), 'joined',
			'and is in it by having made it, with nothing else called');
		await deliver(b, first.envelope, first.addr);
		ok((await joinByPress(b, first.gid)).settled, 'B pressed Join');

		// A message to the two of them.
		const EARLY = 'Said before anybody else was here.';
		const early = await a.page.evaluate(async ([gid, body]) =>
			window.DaimondPost.sealGroup(gid, { body }), [first.gid, EARLY]);
		ok(early.ok, 'A sealed a message to the group of two', early.why);
		eq((await deliver(b, early.made.envelope, early.made.addr)).body, EARLY,
			'B reads it');

		// Now C is added.
		const second = await a.page.evaluate(async ([gid, kb, kc]) =>
			window.DaimondGroup.setMembers(gid, null, [kb, kc]), [first.gid, B.key, C.key]);
		ok(second.ok, 'A added C', second);
		const invite = await deliver(c, second.envelope, second.addr);
		ok(invite.ok && invite.op && invite.moved,
			'C was sent the roster that adds them', invite);

		// THE SENTENCE IS ON THE SCREEN BEFORE THE PRESS, which is the whole of
		// why it is asserted here and not three lines further down. After the
		// press it would be an explanation; before it, it is a fact somebody can
		// act on. Read off the rendered DOM and never off the function that makes
		// it: a sentence a module can produce and never draws is on nobody's
		// screen, and that is a form this suite has been bitten by before.
		const before = await c.page.evaluate(async () => {
			await window.DaimondPost.read();
			window.DaimondPost.render();
			const host = document.querySelector('#post-groups');
			for (let i = 0; i < 40 && host && !host.childElementCount; i++) {
				await new Promise(r => setTimeout(r, 25));
			}
			return { text: host ? host.textContent : '',
				want: window.DaimondGroup.joiningSentence(),
				joins: !!host && !!host.querySelector('[data-act="group-join"]') };
		});
		ok(before.joins, 'the invitation is drawn with a Join control');
		ok(before.text.includes(before.want),
			'and the words "joining shows you nothing that was sent before" are on it, '
			+ 'BEFORE the press', before.want);

		ok((await joinByPress(c, first.gid)).settled, 'C pressed the control they were shown');
		eq(await stateOf(c, first.gid), 'joined', 'C joined');

		// THE PROPERTY. The earlier envelope was never sealed to C's key, so no
		// device can open it for them -- not the relay's fault, not a policy, and
		// not something a build could decide to relax.
		const late = await deliver(c, early.made.envelope, early.made.addr);
		ok(!late.ok, 'C cannot open what was sent before they joined', late);
		ok(/not sealed to any key/i.test(late.why || ''),
			'and the reason is that there was never a slot for them', late.why);

		return true;
	} finally { await Promise.all([a.close(), b.close(), c.close()]); }
}

// ── 4. Removing retracts nothing ─────────────────────────────

async function removingRetractsNothing() {
	console.log('\n4. removing retracts nothing, and it is enforced at the readers');
	const a = await open({ name: 'group-drop-a', connect: false });
	const b = await open({ name: 'group-drop-b', connect: false });
	const c = await open({ name: 'group-drop-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const A = await card(a), B = await card(b), C = await card(c);
		for (const [who, texts] of [[a, [B.text, C.text]], [b, [A.text, C.text]],
			[c, [A.text, B.text]]]) {
			for (const t of texts) await take(who, t);
		}

		const made = await a.page.evaluate(async ([kb, kc]) =>
			window.DaimondGroup.create('Three of us', [kb, kc]), [B.key, C.key]);
		ok(made.ok, 'A made a group of three', made);
		for (const s of [b, c]) {
			ok((await deliver(s, made.envelope, made.addr)).moved,
				'the roster reached a member');
		}
		// A IS IN IT BY HAVING MADE IT; B and C press the control they were sent.
		eq(await stateOf(a, made.gid), 'joined', 'A is in the group A made');
		for (const s of [b, c]) {
			ok((await joinByPress(s, made.gid)).settled, 'a member pressed Join');
			eq(await stateOf(s, made.gid), 'joined', 'and they joined');
		}

		// Something C receives while they are still in it.
		const KEPT = 'This one is already on C\'s device.';
		const kept = await a.page.evaluate(async ([gid, body]) =>
			window.DaimondPost.sealGroup(gid, { body }), [made.gid, KEPT]);
		const held = await deliver(c, kept.made.envelope, kept.made.addr);
		eq(held.body, KEPT, 'C received a message while they were in the group');

		// A drops C. The roster goes to B and TO C, so C is told rather than left
		// composing into a room that will refuse them.
		const after = await a.page.evaluate(async ([gid, kb]) =>
			window.DaimondGroup.setMembers(gid, null, [kb]), [made.gid, B.key]);
		ok(after.ok, 'A took C out', after);
		await deliver(b, after.envelope, after.addr);
		const toC = await deliver(c, after.envelope, after.addr);
		ok(toC.ok && toC.op, 'C was sent the roster that does not name them', toC);
		eq((await c.page.evaluate(async (g) =>
			(await window.DaimondGroup.get(g) || {}).state || 'none', made.gid)),
			'left', 'C\'s own record says they are out');

		// NOTHING WAS TAKEN BACK. The message C already had is still there, byte
		// for byte, and no code path exists that could remove it.
		const still = await c.page.evaluate(async (body) => {
			await window.DaimondPost.read();
			return window.DaimondPost.list().some(m => m.body === body)
				|| window.DaimondPost.tray().some(m => m.body === body);
		}, KEPT);
		ok(still, 'the message C already held is still on C\'s device');

		// AND THE SENTENCE IS ON A's SCREEN, beside the control, before the press.
		const shown = await a.page.evaluate(async () => {
			await window.DaimondPost.read();
			window.DaimondPost.render();
			await new Promise(r => setTimeout(r, 250));
			const host = document.querySelector('#post-groups');
			const btns = [...(host ? host.querySelectorAll('[data-act="group-drop"]') : [])];
			return {
				text:   host ? host.textContent : '',
				want:   window.DaimondGroup.removingSentence(),
				labels: btns.map(x => x.textContent),
				leave:  !!host && !!host.querySelector('[data-act="group-leave"]'),
			};
		});
		ok(shown.text.includes(shown.want),
			'the words "taking somebody out takes nothing back" are drawn', shown.want);
		ok(shown.labels.length > 0 && shown.labels.every(l => !/remove/i.test(l)),
			'and the control says "stop sending to", never "remove"', shown.labels);

		// AND THE CREATOR IS NOT OFFERED LEAVE, because `left` is a state their own
		// next roster contradicts: `roster` names them in everything it writes and
		// `consume` reads authorship, so the press would appear to work and the next
		// membership change would silently undo it. Both halves are checked -- the
		// absence of the control AND the refusal at the door -- because the panel is
		// one caller and the second half is what makes the invariant hold for the
		// others.
		ok(!shown.leave, 'the creator is not offered Leave on a group they made',
			{ leave: shown.leave, labels: shown.labels });
		const stuck = await a.page.evaluate(async (gid) => {
			const answer = await window.DaimondGroup.leave(gid);
			return { answer, state: (await window.DaimondGroup.get(gid) || {}).state };
		}, made.gid);
		eq(stuck.answer, false, 'and `leave` refuses them rather than pretending');
		eq(stuck.state, 'joined', 'so the creator is still in the group they made');
		// THE NEGATIVE CONTROL for the two above. B is in the same group, drawn by
		// the same function, and IS offered Leave -- so the absence above is about
		// authorship and not about a control this build stopped drawing at all.
		await panel(b);
		const bLeave = await b.page.evaluate(() => {
			const host = document.querySelector('#post-groups');
			return !!host && !!host.querySelector('[data-act="group-leave"]');
		});
		ok(bLeave, 'a member who did not make it IS offered Leave', { bLeave });

		// THE REMOVAL IS ENFORCED AT THE READERS, because there is nowhere else it
		// could be: no group key to rotate, and a relay that knows nothing about
		// groups. C composes anyway -- C's own record still holds the roster and
		// the sealing keys -- and B refuses it.
		const anyway = await c.page.evaluate(async (gid) => {
			const r = await window.DaimondPost.sealGroup(gid, { body: 'Still here.' });
			if (r.ok) return { composed: true, env: r.made.envelope, addr: r.made.addr };
			// Refused on C's own side, which is also a correct outcome -- but it
			// is a WEAKER one, so it is reported rather than counted as the same
			// thing: it would leave B's refusal untested.
			return { composed: false, why: r.why };
		}, made.gid);
		if (anyway.composed) {
			const atB = await deliver(b, anyway.env, anyway.addr);
			ok(!atB.ok, 'B refuses a message from somebody A took out', atB);
			ok(/addressed to a different key/i.test(atB.why || ''),
				'and refuses it because the author is not in the roster B holds', atB.why);
		} else {
			ok(true, 'C\'s own client refuses to compose to a group it has left',
				anyway.why);
			// The reader-side refusal still has to hold, so it is driven with an
			// envelope C composes while its own record has been put back. Without
			// this the section would pass having tested only the sender's half.
			const forced = await c.page.evaluate(async (gid) => {
				const rec = await window.DaimondGroup.get(gid);
				rec.state = 'joined';
				await window.DaimondPost.putGroup(gid, rec);
				const r = await window.DaimondPost.sealGroup(gid, { body: 'Still here.' });
				return r.ok ? { env: r.made.envelope, addr: r.made.addr } : { why: r.why };
			}, made.gid);
			ok(!!forced.env, 'C, believing itself still in, composes to the group', forced);
			if (forced.env) {
				const atB = await deliver(b, forced.env, forced.addr);
				ok(!atB.ok, 'and B refuses it, which is where a removal is enforced', atB);
			}
		}
	} finally { await Promise.all([a.close(), b.close(), c.close()]); }
}

// ── 5. A person cannot write a roster ────────────────────────

async function markerIsRefused() {
	console.log('\n5. a person\'s own words cannot be applied as a membership list');
	const a = await open({ name: 'group-mark-a', connect: false });
	const b = await open({ name: 'group-mark-b', connect: false });
	try {
		for (const s of [a, b]) await ready(s);
		const B = await card(b);
		await card(a);
		await take(a, B.text);

		// COUNTED, BECAUSE `ok:false` PROVES NOTHING HERE. There is no relay in
		// this suite, so every send fails and an assertion that the marker was
		// refused would pass on a build with the check deleted. What separates
		// the two is WHERE it was refused: the marker must be turned away at the
		// door, with nothing leaving the browser at all.
		let posts = 0;
		const count = (r) => { if (/\/api\/post/.test(r.url())) posts++; };
		a.page.on('request', count);

		const tried = await a.page.evaluate(async (to) => {
			const body = window.DaimondGroup.MARK + '\n{"op":"roster"}';
			return await window.DaimondPost.send({ body, to });
		}, B.pub);
		// `ok:false` is deliberately NOT asserted: with no relay it is true
		// whatever this build does, so a line asserting it would be a line that
		// cannot fail.
		ok(/membership list/i.test(tried.why || ''),
			'and the refusal names the reason, in words a person can act on', tried.why);
		eq(posts, 0, 'and NOTHING left the browser: it was refused at the door');

		// THE POSITIVE CONTROL, and it is what makes the count above mean
		// something. The same text one character further in is an ordinary
		// message: it composes, it reaches the relay, and it fails there instead
		// -- a different refusal, in different words, after a request.
		const fine = await a.page.evaluate(async (to) => {
			const body = '> ' + window.DaimondGroup.MARK + '\nnot a roster';
			return await window.DaimondPost.send({ body, to });
		}, B.pub);
		ok(!/membership list/i.test(fine.why || ''),
			'the same text one character in is not taken for a roster', fine.why);
		ok(posts > 0, 'and it got as far as the relay, which the marker never did',
			{ posts, why: fine.why });
		a.page.off('request', count);
	} finally { await Promise.all([a.close(), b.close()]); }
}

// ── 7. A key this device does not stand behind gets no slot ──

async function aChangedKeyGetsNoSlot() {
	console.log('\n7. a member whose key this device does not stand behind gets no slot');
	const a = await open({ name: 'group-key-a', connect: false });
	const b = await open({ name: 'group-key-b', connect: false });
	const c = await open({ name: 'group-key-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const A = await card(a), B = await card(b), C = await card(c);
		await take(a, B.text); await take(a, C.text);

		const made = await a.page.evaluate(async ([kb, kc]) =>
			window.DaimondGroup.create('Everybody', [kb, kc]), [B.key, C.key]);
		eq(await stateOf(a, made.gid), 'joined',
			'A can seal to the group A made, having done nothing else to it');

		// The baseline, so the counting below measures the skip and not the
		// arithmetic. Three members means two slots plus A's own.
		const whole = await a.page.evaluate(async ([gid]) =>
			window.DaimondPost.sealGroup(gid, { body: 'to everybody' }), [made.gid]);
		const slots = (s, env) => s.page.evaluate((e) => {
			const bin = atob(e);
			return bin.charCodeAt(36);
		}, env);
		eq(await slots(a, whole.made.envelope), 3, 'three members, three slots');

		// A BLOCKED KEY. The block is this account's own act, so offering to seal
		// to them anyway would be the interface arguing with the user.
		await a.page.evaluate((k) => window.DaimondTrust.setBlocked(k, true), C.key);
		await a.page.evaluate(() => window.DaimondPost.refreshPeople());
		const blocked = await a.page.evaluate(async ([gid]) =>
			window.DaimondGroup.sealTo(gid), [made.gid]);
		ok(blocked.ok, 'the message still goes to the rest of the group', blocked.why);
		eq((blocked.skipped || []).length, 1, 'and exactly one person is left out');
		ok(/blocked/i.test((blocked.skipped[0] || {}).why || ''),
			'named, with the reason, so the sender can act on it', blocked.skipped);
		const short = await a.page.evaluate(async ([gid]) =>
			window.DaimondPost.sealGroup(gid, { body: 'to everybody' }), [made.gid]);
		eq(await slots(a, short.made.envelope), 2,
			'AND THE ENVELOPE REALLY HAS ONE SLOT FEWER: a skip that only changed '
			+ 'a sentence would still have sealed the message to them');
		await a.page.evaluate((k) => window.DaimondTrust.setBlocked(k, false), C.key);
		await a.page.evaluate(() => window.DaimondPost.refreshPeople());

		// A ROSTER THAT DISAGREES WITH A HELD CARD. This is a key change arriving
		// by the group's own road: the creator asserts a sealing key for somebody
		// and this device holds a card saying otherwise. The card wins.
		//
		// The fixture IS the disagreement, and it is written through the app's own
		// published door rather than into storage, so the branch under test is
		// reached by the state a real disagreement produces.
		const wrong = await a.page.evaluate(async ([gid, kc]) => {
			const rec = await window.DaimondGroup.get(gid);
			rec.members = rec.members.map(m => m.k === kc
				? { ...m, e: '00'.repeat(32) } : m);
			await window.DaimondPost.putGroup(gid, rec);
			return await window.DaimondGroup.sealTo(gid);
		}, [made.gid, C.key]);
		ok(wrong.ok, 'the message still goes to the rest', wrong.why);
		eq((wrong.skipped || []).length, 1, 'and the disagreement leaves exactly one out');
		ok(/not the one you hold/i.test((wrong.skipped[0] || {}).why || ''),
			'named as a key this device does not stand behind', wrong.skipped);
	} finally { await Promise.all([a.close(), b.close(), c.close()]); }
}

// ── 8. One group message, one expiry notice ──────────────────

async function oneMessageIsOneNotice() {
	console.log('\n8. a group message that expires is ONE notice, not one per member');
	const s = await open({ name: 'group-notice', connect: false });
	try {
		await ready(s);
		// The relay writes the sender one expiry notice PER BOX, because it has no
		// notion of a group and each copy expires in its own box
		// (gateway/src/schema.rs, `Store::expire_post`). Twelve rows all naming
		// one address is what one uncollected group message looks like coming
		// back, and it is fed in here exactly as `collect` would take it.
		const seen = await s.page.evaluate(async () => {
			await window.DaimondPost.read();
			for (let i = 1; i <= 12; i++) {
				await window.DaimondPost.take({ kind: 'post', addr: 'post1group',
					envelope: '', seq: i, ts: 1786000000, tray: false, expired: true,
					from_pub: '' });
			}
			// And one ordinary message of its own, uncollected by its one
			// recipient. It must NOT be folded into the group's row.
			await window.DaimondPost.take({ kind: 'post', addr: 'post1alone',
				envelope: '', seq: 13, ts: 1786000001, tray: false, expired: true,
				from_pub: '' });
			window.DaimondPost.render();
			const rows = window.DaimondPost.notices();
			return {
				rows:  rows.map(r => ({ addr: r.addr, copies: r.copies })),
				drawn: [...document.querySelectorAll('#post-notices .post-notice')]
					.map(x => x.textContent),
			};
		});
		eq(seen.rows.length, 2, 'twelve copies and one single make two rows', seen.rows);
		const group = seen.rows.find(r => r.addr === 'post1group');
		const alone = seen.rows.find(r => r.addr === 'post1alone');
		eq(group && group.copies, 12, 'the group\'s row knows it was twelve');
		eq(alone && alone.copies, 1, 'and the one-to-one message is not folded into it');
		eq(seen.drawn.length, 2, 'and two rows are what the panel draws', seen.drawn);
		ok(seen.drawn.some(t => /12 of the people/.test(t)),
			'the group row says how many copies expired', seen.drawn);
		ok(seen.drawn.some(t => /never collected and the relay has let it go/.test(t)),
			'and the one-to-one row keeps its own wording', seen.drawn);
	} finally { await s.close(); }
}

// ── 9. Two clocks, one writer each, and it converges ─────────

async function theMergeConverges() {
	console.log('\n9. a roster and a decision merge on separate clocks, in any order');
	const a = await open({ name: 'group-merge', connect: false });
	try {
		await ready(a);
		const A = await card(a);
		const made = await a.page.evaluate(async () =>
			window.DaimondGroup.create('First name', []));
		ok(made.ok, 'a group exists to merge into', made);
		eq(await stateOf(a, made.gid), 'joined', 'and its creator is in it');

		// The two parcels another device might send, built off this one's own
		// snapshot so every field is a real one. Each moves ONE clock.
		const out = await a.page.evaluate(async (gid) => {
			const base  = window.DaimondPost.snapshot();
			const clone = () => JSON.parse(JSON.stringify(base));

			// A later roster from the creator: the roster half moves, and the
			// local half must not.
			const later = clone();
			later.groups[gid].at      = base.groups[gid].at + 1000;
			later.groups[gid].addr    = 'zzzz';
			later.groups[gid].name    = 'Second name';
			later.groups[gid].members = base.groups[gid].members.concat(
				[{ k: 'aa'.repeat(32), e: 'bb'.repeat(32), n: 'Late' }]);
			later.groups[gid].state   = 'left';		// must be ignored: older stateAt

			// This account's own later decision, from another of its devices: the
			// local half moves, and the roster half must not.
			const decided = clone();
			// NOT `| 0`: this fixture wrote `(x | 0) + 1000` and that truncation
			// made the stamp SMALLER than the one it was meant to beat, so the
			// assertion below failed for a reason that had nothing to do with the
			// merge. The bug it uncovered was real and is fixed in post.js; the
			// lesson kept here is that a fixture's own arithmetic is part of what
			// a check measures.
			decided.groups[gid].stateAt = base.groups[gid].stateAt + 1000;
			decided.groups[gid].state   = 'left';
			decided.groups[gid].name    = 'Never this';	// must be ignored: older at

			// And a record whose roster is not a list at all. `at` is a REAL
			// millisecond stamp: an earlier draft of this used 1e12, which `| 0`
			// truncated to a negative number, so the merge never reached the
			// guard and the assertion below was true whatever the guard did.
			const broken = clone();
			broken.groups[gid] = { gid, members: 'not a list',
				at: base.groups[gid].at + 5000, addr: 'zzzz' };

			const after = () => {
				const g = window.DaimondPost.snapshot().groups[gid];
				return { name: g.name, members: g.members.length, state: g.state,
					at: g.at, stateAt: g.stateAt };
			};
			const reset = async () => {
				const r = await window.DaimondGroup.get(gid);
				r.name = base.groups[gid].name;
				r.at = base.groups[gid].at;
				r.addr = base.groups[gid].addr;
				r.members = base.groups[gid].members;
				r.state = base.groups[gid].state;
				r.stateAt = base.groups[gid].stateAt;
				await window.DaimondPost.putGroup(gid, r);
			};

			window.DaimondPost.adopt(later);
			const rosterOnly = after();
			await reset();
			window.DaimondPost.adopt(decided);
			const localOnly = after();

			// ORDER INDEPENDENCE, which is the whole claim. Same two parcels, both
			// orders, same answer.
			await reset();
			window.DaimondPost.adopt(later);
			window.DaimondPost.adopt(decided);
			const forwards = after();
			await reset();
			window.DaimondPost.adopt(decided);
			window.DaimondPost.adopt(later);
			const backwards = after();

			// An older roster moves nothing at all.
			await reset();
			window.DaimondPost.adopt(later);
			const older = clone();
			older.groups[gid].at   = base.groups[gid].at - 1000;
			older.groups[gid].name = 'Stale';
			window.DaimondPost.adopt(older);
			const stale = after();

			await reset();
			let threw = '';
			try { window.DaimondPost.adopt(broken); }
			catch (e) { threw = String(e && e.message || e); }
			const guarded = after();

			// The stamps themselves, so a truncation shows up as the wrong number
			// rather than as ordering that happens to still work this month.
			const whole = { at: base.groups[gid].at, past32: base.groups[gid].at > 2 ** 31 };
			return { rosterOnly, localOnly, forwards, backwards, stale, guarded, threw, whole };
		}, made.gid);

		eq(out.rosterOnly.name, 'Second name', 'a later roster brings the new name');
		eq(out.rosterOnly.members, 2, 'and the person it adds');
		eq(out.rosterOnly.state, 'joined',
			'and does NOT carry the creator\'s idea of whether this device is in it');

		eq(out.localOnly.state, 'left', 'a later decision from another device lands');
		eq(out.localOnly.name, 'First name',
			'and does NOT drag an older roster along with it');

		eq(out.forwards, out.backwards,
			'and the two arriving in either order give the same record');
		eq(out.forwards.name, 'Second name', 'with the later roster');
		eq(out.forwards.state, 'left', 'and the later decision');

		eq(out.stale.name, 'Second name', 'an older roster moves nothing');

		ok(out.whole.past32,
			'the stamps this merges on are milliseconds, past what 32 bits hold',
			out.whole);
		eq(out.rosterOnly.at, out.whole.at + 1000,
			'and a merged stamp comes through whole rather than wrapped');
		eq(out.guarded.members, 1, 'a record whose roster is not a list is refused');
		eq(out.threw, '', 'and refused without throwing, which would jam the sync');
	} finally { await a.close(); }
}

// ── 10. The creator's path is the shipped one ────────────────

async function theShippedPath() {
	console.log('\n10. a group is made by pressing Make, and its maker can write to it');

	// FIRST, THIS FILE'S OWN SOURCE. The bug that got past 88 assertions was a
	// line in the test, not a line in the app, so the rule against it is checked
	// where it was broken. The needle is built rather than written out, or this
	// assertion would match itself.
	const self   = fs.readFileSync(path.join(HERE, 'verify_group.mjs'), 'utf8');
	const needle = 'DaimondGroup' + '.join(';
	ok(self.indexOf(needle) < 0,
		'nothing in this file joins a device the way the application cannot',
		self.split('\n').map((l, i) => l.indexOf(needle) >= 0 ? i + 1 : 0).filter(Boolean));

	const a = await open({ name: 'group-ship-a', connect: false });
	const b = await open({ name: 'group-ship-b', connect: false });
	try {
		for (const s of [a, b]) await ready(s);
		const B = await card(b);
		await card(a);
		ok(await take(a, B.text), 'A holds a card for B');
		await stubRelay(a, '');			// a relay that takes what it is given

		// THE WHOLE OF THE PATH A PERSON TAKES: fill the box, choose somebody,
		// press Make. Nothing after it.
		const made = await makeByPress(a, 'The shipped one', [B.key]);
		ok(!made.err, 'the Make box is drawn with a name field, a picker and a control',
			made.err);
		eq(made.chose, [B.key], 'B is chosen in the picker', made.offered);
		ok(/have been told/.test(made.note || ''),
			'and the panel reports the group was made', made.note);
		eq(made.groups.length, 1, 'one group is held afterwards', made.groups);
		const gid = (made.groups[0] || {}).gid || '';

		// THE PROPERTY, and the one this suite could not see. A creator is a member
		// of their own group BY CONSTRUCTION -- not because a test joined them.
		eq((made.groups[0] || {}).state, 'joined',
			'and its maker is IN it, with no join in the path at all');
		eq((made.groups[0] || {}).n, 2, 'the roster names A and B');

		// Which is only worth saying because of what it lets them do. `sealGroup`
		// is the half of a send with no relay in it, so this is the refusal the
		// creator used to get, asked directly.
		const write = await a.page.evaluate(async (g) =>
			window.DaimondPost.sealGroup(g, { body: 'The first word in my own group.' }), gid);
		ok(write.ok, 'A can write to the group A just made', write.why);
		ok(!/[Jj]oin this group before writing/.test(write.why || ''),
			'and is not told to join a group they made', write.why);

		// AND IT OPENS ON SOMEBODY ELSE'S DEVICE, so "can write" means an envelope
		// that reaches a reader and not merely a function that returned true. The
		// roster is the one the press sent -- taken off the relay stub rather than
		// composed a second time -- and B answers the invitation by pressing Join.
		const rows = await handed(a);
		eq(rows.length, 1, 'the press sent the roster to B', rows.map(r => r.to));
		const gotRoster = await deliver(b, rows[0].envelope, rows[0].addr);
		ok(gotRoster.op, 'B opened the roster the press sent', gotRoster);
		ok((await joinByPress(b, gid)).settled, 'B pressed Join');
		const seen = await deliver(b, made2env(write), made2addr(write));
		eq(seen.body, 'The first word in my own group.',
			'and B reads what the group\'s maker wrote in it');

		// THE PANEL DREW IT AS A GROUP, not as an invitation. A creator filed as
		// `invited` appeared under Group invitations with a Join control on it,
		// which is what the bug looked like on screen.
		const drawn = await panel(a);
		const where = await a.page.evaluate((g) => {
			const inv  = document.querySelector('#group-invites');
			const list = document.querySelector('#group-list');
			const sel  = `[data-gid="${g}"]`;
			return {
				invited: !!inv && !!inv.querySelector(sel),
				listed:  !!list && !!list.querySelector(sel),
				joins:   !!document.querySelector(`#post-groups ${sel} [data-act="group-join"]`),
			};
		}, gid);
		ok(drawn.filled, 'the section is drawn', drawn);
		ok(where.listed && !where.invited,
			'the group is under Groups and NOT under Group invitations', where);
		ok(!where.joins, 'and carries no Join control, because there is nothing to answer',
			where);
	} finally {
		await realRelay(a);
		await Promise.all([a.close(), b.close()]);
	}
}

// ── 11. A key that could not go in is named ──────────────────

async function aRejectedKeyIsNamed() {
	console.log('\n11. a key that is not a key is named, and a duplicate is not the same fault');
	const a = await open({ name: 'group-bad-a', connect: false });
	const b = await open({ name: 'group-bad-b', connect: false });
	const c = await open({ name: 'group-bad-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const B = await card(b), C = await card(c);
		await card(a);
		await take(a, B.text);			// a card for B, and deliberately none for C

		// A MALFORMED KEY. This read `if (!isHex(k, 32) || seen[k]) continue;` and
		// did not add it to `missing`, so the answer was `ok:true, members:1,
		// sent:0` -- A GROUP OF ONE, MADE SILENTLY, which is how the first caller
		// to reach this by hand made one and could not tell.
		const typo = B.key.toUpperCase() + 'zz';
		const bad = await a.page.evaluate(async ([kb, junk]) =>
			window.DaimondGroup.create('Typed wrong', [kb, junk]), [B.key, typo]);
		ok(!bad.ok, 'a key with the wrong spelling refuses the group', bad);
		ok(Array.isArray(bad.bad) && bad.bad.length === 1,
			'and exactly one key is reported as not being one', bad.bad);
		ok((bad.bad || []).some(x => x === typo.toLowerCase()),
			'named by its own spelling, which is the thing that can be corrected',
			bad.bad);
		ok(!/^ok/.test(String(bad.members)) && bad.members === undefined,
			'and no count of members comes back, because none were made', bad.members);
		// AND NOTHING WAS MADE. `ok:false` with a group in the record would be the
		// same fault wearing a refusal.
		eq((await a.page.evaluate(() => window.DaimondGroup.list())).length, 0,
			'nothing at all is in the record: not a group of one, not a group of two');

		// AND THE SENTENCE IS PLURAL, BECAUSE THE VALUE IS AN ARRAY. `group.err_bad_key`
		// was singular with one `{k}`, so it could not describe the case it was written
		// for, and the code was left on `group.err_no_card`'s count rather than
		// misusing it: the fault was reported precisely in the value and only
		// approximately in the words. `group.err_bad_keys` carries a joined list in
		// `{who}`, in the register `post.group_refused` already uses.
		const two = await a.page.evaluate(async ([kb, j1, j2]) =>
			window.DaimondGroup.create('Two wrong', [kb, j1, j2]),
			[B.key, 'not-a-key', 'ABC' + 'zz']);
		ok(!two.ok, 'two keys that are not keys refuse the group', two);
		eq((two.bad || []).length, 2, 'and both are reported', two.bad);
		ok(/These are not keys/.test(two.why || ''),
			'in a sentence that is plural, because the value it describes is a list',
			two.why);
		ok(/not-a-key/.test(two.why || '') && /abczz/.test(two.why || ''),
			'AND IT NAMES BOTH SPELLINGS, which is the thing that can be corrected -- '
			+ 'a count cannot be', two.why);
		ok(!/sealing key for/.test(two.why || ''),
			'and does not send the reader to scan a code for a typing mistake', two.why);
		// The key it replaced is gone, asked of the LIVE CATALOGUE rather than of the
		// file: a key present in `en.js` and unreachable at runtime is the same dead
		// weight, and this is the end that a reader meets.
		const keys = await a.page.evaluate(() => ({
			plural:   window.DaimondI18n.t('group.err_bad_keys'),
			singular: window.DaimondI18n.t('group.err_bad_key'),
		}));
		ok(keys.plural !== 'group.err_bad_keys' && /\{who\}/.test(keys.plural),
			'the plural key is in the catalogue and carries a list', keys);
		eq(keys.singular, 'group.err_bad_key',
			'and the singular one it replaced is retired: nothing names it, so it is '
			+ 'not carried in eight languages');

		// A KEY WITH NO CARD is the other half, and it is told apart. Both refuse,
		// and the two arrays are what says which fault it was.
		const noCard = await a.page.evaluate(async ([kb, kc]) =>
			window.DaimondGroup.create('No card for C', [kb, kc]), [B.key, C.key]);
		ok(!noCard.ok, 'somebody whose code has not been scanned refuses it too', noCard);
		eq((noCard.missing || []).length, 1, 'and is reported as missing, not as malformed');
		eq((noCard.bad || []).length, 0, 'with nothing in the malformed list', noCard.bad);
		ok(/sealing key for 1 of the people/.test(noCard.why || ''),
			'and the count in the sentence is the number of people it is about',
			noCard.why);

		// BOTH FAULTS AT ONCE, TOLD APART IN THE WORDS as well as in the arrays.
		// This is where the old single sentence was FALSE rather than merely vague:
		// `{n}` was `bad.length + missing.length`, so one typo beside one uncarded
		// person read as "no sealing key for 2 of the people chosen" -- a sentence
		// naming a repair for a fault that was not there.
		const both = await a.page.evaluate(async ([kc, junk]) =>
			window.DaimondGroup.create('One of each', [kc, junk]), [C.key, 'nope']);
		ok(!both.ok, 'one bad spelling and one missing card refuse the group', both);
		eq((both.bad || []).length, 1, 'one is a spelling');
		eq((both.missing || []).length, 1, 'and one is a person with no card');
		ok(/These are not keys/.test(both.why || ''),
			'both sentences are drawn: the spelling first', both.why);
		ok(/sealing key for 1 of the people/.test(both.why || ''),
			'AND THE COUNT IS 1, NOT 2 -- it counts the people it is about and not '
			+ 'the typing mistake as well', both.why);

		// A DUPLICATE IS NOT A FAULT. Naming somebody twice, or naming yourself,
		// asks for a roster this one already is: the caller gets the membership they
		// asked for, so it is counted and reported and refuses nothing. Reporting it
		// as a fault would refuse a group over a request that was granted.
		const mine = await a.page.evaluate(async () => {
			const raw = await window.DaimondIdentity.publicKeyRaw();
			let h = ''; for (const x of raw) h += ('0' + x.toString(16)).slice(-2);
			return h;
		});
		const twice = await a.page.evaluate(async ([kb, ka]) =>
			window.DaimondGroup.create('Named twice', [kb, kb, ka]), [B.key, mine]);
		ok(twice.ok, 'naming somebody twice makes the group anyway', twice.why);
		eq(twice.members, 2, 'with each person in it once');
		eq(twice.dupes, 2, 'and the repeats counted, said rather than swallowed');
		eq((twice.bad || []).length, 0, 'and not reported as a key that is not one');

		// THE POSITIVE CONTROL, which is what makes the three refusals above mean
		// something: the same call with every key well spelled and carded works.
		const fine = await a.page.evaluate(async (kb) =>
			window.DaimondGroup.create('All well', [kb]), B.key);
		ok(fine.ok, 'and a well-spelled key with a card makes a group', fine.why);
		eq(fine.members, 2, 'of two');

		// AND THE SAME FAULT ONE FUNCTION FURTHER DOWN. `create` reads its own
		// roster back through `consume`, which is what makes ONE path turn a roster
		// into a record -- and the answer to that read used to be a log line, so a
		// read-back that failed left the caller holding `ok:true` for a group in
		// nobody's record and a fan-out announcing it. The store is made to refuse
		// the write, which is what a device whose identity locked between the
		// compose and the record does.
		await stubRelay(a, '');
		const unapplied = await a.page.evaluate(async (kb) => {
			const real = window.DaimondPost.putGroup;
			window.DaimondPost.putGroup = async () => false;
			let r;
			try { r = await window.DaimondGroup.create('Never stored', [kb]); }
			finally { window.DaimondPost.putGroup = real; }
			const gs = await window.DaimondGroup.list();
			return { ok: r.ok, why: r.why || '', names: gs.map(g => g.name) };
		}, B.key);
		ok(!unapplied.ok, 'a roster this device could not store refuses the whole call',
			unapplied);
		ok(/could not apply|was not sent/.test(unapplied.why),
			'saying so rather than answering ok with nothing behind it', unapplied.why);
		ok(!unapplied.names.some(n => n === 'Never stored'),
			'and no such group is held', unapplied.names);
		eq((await handed(a)).length, 0,
			'AND NOTHING WAS SENT: a roster announced to people this device does not '
			+ 'itself hold would refuse every message sent to the group it announced');
		await realRelay(a);
	} finally { await Promise.all([a.close(), b.close(), c.close()]); }
}

// ── 12. A refused delivery is drawn ──────────────────────────

async function aRefusalIsDrawn() {
	console.log('\n12. a delivery the relay would not take is NAMED, not counted');

	const a = await open({ name: 'group-refuse-a', connect: false });
	const b = await open({ name: 'group-refuse-b', connect: false });
	const c = await open({ name: 'group-refuse-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const B = await card(b), C = await card(c);
		await card(a);
		await take(a, B.text); await take(a, C.text);

		// C's box is full. B's is not.
		await stubRelay(a, C.pub);

		// ── A ROSTER, first, because a person who never got it does not know the
		// group exists at all. This said "Made, and 5 people have been told" over a
		// fan-out that reached one.
		const made = await makeByPress(a, 'Half of them', [B.key, C.key]);
		ok(!made.err, 'the group was made through the panel', made.err);
		const gid = (made.groups[0] || {}).gid || '';
		const posts = await handed(a);
		eq(posts.length, 2, 'the roster was offered to both members',
			posts.map(p => p.to));
		// THE COUNT ITSELF, and not merely the shape of the sentence: `/told/`
		// matches "have been told" whatever number is in front of it, so it would
		// pass on the build that claimed both members had it.
		ok(/and 1 people have been told/.test(made.note || ''),
			'the panel says ONE was told, which is how many were', made.note);
		ok(/would not take it for/.test(made.note || ''),
			'AND NAMES THE ONE WHO WAS NOT: a roster that reached one of two used to '
			+ 'say two people had been told and nothing else', made.note);
		ok(/mailbox is full/.test(made.note || ''),
			'with the relay\'s reason as a clause, in the register a list needs',
			made.note);
		// The two halves are ONE assertion deliberately. `!/status_/` alone is true
		// of a build that draws nothing at all, which is the build this is here to
		// fail.
		ok(/would not take it for/.test(made.note || '') && !/status_/.test(made.note || ''),
			'and no machine text where the reason goes', made.note);

		// ── AND A MESSAGE, through the panel's own Send control, which is where the
		// hole was found: `sendGroup` answers `{ok:true, sent, refused}` and the
		// branch drew `sent` and dropped `refused`.
		await a.page.evaluate(() => { window.__posts = []; });
		const sent = await a.page.evaluate(async (g) => {
			const r = await window.DaimondPost.send({ group: g, body: 'To whoever can have it.' });
			return { ok: r.ok, sent: r.sent, refused: (r.refused || []).length,
				words: window.DaimondPost.shortfall(r), why: r.why || '' };
		}, gid);
		ok(sent.ok, 'the message goes to the rest of the group', sent);
		eq(sent.sent, 1, 'one member had it taken for them');
		eq(sent.refused, 1, 'and one did not');
		ok(/would not take it for/.test(sent.words || ''),
			'and the sentence the panel draws names them', sent.words);
		ok(/mailbox is full/.test(sent.words || ''),
			'with the reason the relay gave', sent.words);

		// ── BOTH FAULTS AT ONCE, TOLD APART. A key this device would not seal to is
		// a refusal HERE and the reader can lift it; a delivery the relay would not
		// take is a refusal ELSEWHERE and they can only wait. One list would be true
		// and would leave them to work out which of the two is theirs, which is the
		// distinction the eight translations were paid for. Also the `ok:false` half
		// of the hole: with nobody sealable and nobody reachable the panel used to
		// print `r.why` alone.
		await a.page.evaluate((k) => window.DaimondTrust.setBlocked(k, true), B.key);
		await a.page.evaluate(() => window.DaimondPost.refreshPeople());
		const both = await a.page.evaluate(async (g) => {
			const r = await window.DaimondPost.send({ group: g, body: 'To nobody, then.' });
			return { ok: r.ok, sent: r.sent | 0, why: r.why || '',
				skipped: (r.skipped || []).length, refused: (r.refused || []).length,
				words: window.DaimondPost.shortfall(r) };
		}, gid);
		eq(both.sent, 0, 'with one blocked and one full, the message reaches nobody');
		ok(!both.ok, 'which is a failure and is reported as one', both);
		ok(/reached nobody/.test(both.why), 'in its own words', both.why);
		ok(/Not sealed to/.test(both.words),
			'the person this device would not seal to is named as that', both.words);
		ok(/you blocked this key/.test(both.words),
			'with the reason being one the reader can lift', both.words);
		ok(/would not take it for/.test(both.words),
			'AND the relay\'s refusal is a SECOND sentence, not folded into the first',
			both.words);
		ok(both.words.indexOf('Not sealed to') < both.words.indexOf('would not take it for'),
			'this device\'s own refusal first, because it is the one they can act on',
			both.words);
		await a.page.evaluate((k) => window.DaimondTrust.setBlocked(k, false), B.key);
		await a.page.evaluate(() => window.DaimondPost.refreshPeople());

		// THE NEGATIVE CONTROL. Nobody's box is full, so the same send says nothing
		// about anybody -- or the sentence above is one this build always draws.
		await stubRelay(a, '');
		const clean = await a.page.evaluate(async (g) => {
			const r = await window.DaimondPost.send({ group: g, body: 'To everybody.' });
			return { ok: r.ok, sent: r.sent, words: window.DaimondPost.shortfall(r) };
		}, gid);
		ok(clean.ok && clean.sent === 2, 'with no full box, both members have it taken',
			clean);
		eq(clean.words, '', 'and nothing is drawn about anybody being left out');

		// AND THE STATUS TABLE IS ONE TABLE. The fan-out invented `status_507`
		// because the words lived inside the one-to-one branch; they are read from
		// one place now, so a status has the same words either way.
		const words = await a.page.evaluate(() => ({
			full:    window.DaimondPost.whyRefused(507),
			gone:    window.DaimondPost.whyRefused(404),
			off:     window.DaimondPost.whyRefused(0),
			other:   window.DaimondPost.whyRefused(500),
		}));
		ok(/mailbox is full/.test(words.full), 'a full box has words', words.full);
		ok(/No account holds that key/.test(words.gone), 'so has a key nobody holds', words.gone);
		ok(/could not reach the relay/.test(words.off), 'so has an unreachable relay', words.off);
		ok(/would not take/.test(words.other), 'and so has anything else', words.other);
		ok(new Set(Object.values(words)).size === 4,
			'and the four are four different sentences', words);

		// AND EACH HAS A SHORT FORM, because a whole sentence per member is what
		// makes a list of ten unreadable. Both registers are checked: the clause is
		// SHORTER and it is NOT the sentence, or the second argument does nothing.
		const clauses = await a.page.evaluate(() => ({
			full:  window.DaimondPost.whyRefused(507, true),
			gone:  window.DaimondPost.whyRefused(404, true),
			off:   window.DaimondPost.whyRefused(0, true),
			big:   window.DaimondPost.whyRefused(413, true),
			other: window.DaimondPost.whyRefused(500, true),
		}));
		ok(new Set(Object.values(clauses)).size === 5,
			'five statuses, five clauses', clauses);
		ok(Object.keys(clauses).every(k => !words[k] || clauses[k] !== words[k]),
			'and a clause is never the whole sentence', clauses);
		ok(clauses.full.length < words.full.length,
			'the clause is the shorter of the two, which is its whole purpose',
			{ clause: clauses.full, sentence: words.full });
		ok(Object.values(clauses).every(c => !/^[A-Z]/.test(c) && !/\.$/.test(c)),
			'and reads as a clause: no capital, no full stop, because it sits in '
			+ 'brackets after a name', clauses);
	} finally {
		await realRelay(a);
		await Promise.all([a.close(), b.close(), c.close()]);
	}
}

// ── 13. A group can be closed, and closing is final ──────────

async function closingIsFinal() {
	console.log('\n13. a creator can close a group, once, and no reader will reopen it');
	const a = await open({ name: 'group-close-a', connect: false });
	const b = await open({ name: 'group-close-b', connect: false });
	const c = await open({ name: 'group-close-c', connect: false });
	try {
		for (const s of [a, b, c]) await ready(s);
		const B = await card(b), C = await card(c);
		await card(a);
		for (const [who, texts] of [[a, [B.text, C.text]], [b, [C.text]], [c, [B.text]]]) {
			for (const t of texts) await take(who, t);
		}
		await take(b, (await card(a)).text);
		await take(c, (await card(a)).text);
		await stubRelay(a, '');

		const made = await a.page.evaluate(async ([kb, kc]) =>
			window.DaimondGroup.create('One to end', [kb, kc]), [B.key, C.key]);
		ok(made.ok, 'A made a group of three', made);
		const gid = made.gid;
		for (const s of [b, c]) {
			await deliver(s, made.envelope, made.addr);
			ok((await joinByPress(s, gid)).settled, 'a member pressed Join');
		}

		// Something everybody has BEFORE it closes, so "they keep the messages they
		// already have" is measured against a real message rather than asserted.
		const KEPT = 'Said while the group was open.';
		const kept = await a.page.evaluate(async ([g, body]) =>
			window.DaimondPost.sealGroup(g, { body }), [gid, KEPT]);
		eq((await deliver(b, made2env(kept), made2addr(kept))).body, KEPT,
			'B holds a message from before the close');

		// AND ONE B COMPOSES BUT DOES NOT SEND, kept back to be delivered AFTER the
		// close. It is the in-flight case, and it is checked because the answer is a
		// cost rather than a bug: what a member keeps is what they have COLLECTED,
		// and an envelope still on the relay when the group closes is refused by
		// every reader. Better measured and said than discovered.
		const inFlight = await b.page.evaluate(async (g) =>
			window.DaimondPost.sealGroup(g, { body: 'Still in the post.' }), gid);
		ok(inFlight.ok, 'B composed one that has not been delivered yet', inFlight.why);

		// ── THE CONTROL, AND THE SENTENCE ABOVE IT, BEFORE THE PRESS.
		const shown = await panel(a).then(() => a.page.evaluate((g) => {
			const host = document.querySelector('#post-groups');
			const row  = host && host.querySelector(`[data-gid="${g}"]`);
			return {
				there: !!row && !!row.querySelector('[data-act="group-close"]'),
				label: row && row.querySelector('[data-act="group-close"]')
					? row.querySelector('[data-act="group-close"]').textContent : '',
				text:  host ? host.textContent : '',
				want:  window.DaimondGroup.closingSentence(),
			};
		}, gid));
		ok(shown.there, 'the creator is offered a control that closes the group');
		ok(shown.text.includes(shown.want),
			'and the words "it cannot be undone" are on the screen BEFORE the press',
			shown.want);
		ok(!/delete|disband|remove/i.test(shown.label),
			'the control says CLOSE and not delete, disband or remove: nothing is '
			+ 'destroyed by it, and `stop_sending` refuses "remove" for the same reason',
			shown.label);
		// THE NEGATIVE CONTROL. B is in the same group, drawn by the same function,
		// and is NOT offered it -- so the presence above is about authorship and not
		// about a control this build draws on every row.
		await panel(b);
		const atB = await b.page.evaluate((g) => {
			const row = document.querySelector(`#post-groups [data-gid="${g}"]`);
			return { close: !!row && !!row.querySelector('[data-act="group-close"]'),
				leave: !!row && !!row.querySelector('[data-act="group-leave"]') };
		}, gid);
		ok(!atB.close, 'a member who did not make it is not offered it', atB);
		ok(atB.leave, 'and IS offered Leave, so the row itself is being drawn', atB);
		// AND THE DOOR REFUSES THEM TOO, because the panel is one caller.
		const bTried = await b.page.evaluate(async (g) =>
			window.DaimondGroup.close(g), gid);
		ok(!bTried.ok, 'and `close` refuses a member rather than pretending', bTried);
		ok(/who made a group can close it/.test(bTried.why || ''),
			'in its own sentence, not the one about changing who is in it',
			bTried.why);

		// ── ONE DIALOGUE, AND SAYING NO CLOSES NOTHING.
		await a.page.evaluate(() => { window.__posts = []; });
		const said = await pressAndAnswer(a,
			`#post-groups [data-gid="${gid}"] [data-act="group-close"]`, false);
		ok(said.asked, 'pressing it opens the app\'s own confirmation dialogue', said);
		ok(said.card && said.card.text.includes(shown.want),
			'which says the same sentence again, because a line read on the way past '
			+ 'is not consent for something irreversible', said.card && said.card.text);
		ok(said.card && /One to end/.test(said.card.text),
			'and names the group being closed', said.card && said.card.text);
		ok(said.card && said.card.danger,
			'with the accepting button marked as the dangerous one',
			said.card && said.card.ok);
		ok(said.card && said.card.cancel, 'and a way out of it', said.card);
		const after = await a.page.evaluate(async (g) => {
			const rec = await window.DaimondGroup.get(g);
			return { members: rec.members.length, state: rec.state,
				closed: window.DaimondGroup.isClosed(rec) };
		}, gid);
		eq(after.members, 3, 'saying no leaves the group exactly as it was');
		ok(!after.closed, 'and not closed', after);
		eq((await handed(a)).length, 0,
			'AND NOTHING LEFT THE BROWSER: a dialogue asked and then ignored would be '
			+ 'a dialogue for show');

		// ── AND SAYING YES CLOSES IT.
		const yes = await pressAndAnswer(a,
			`#post-groups [data-gid="${gid}"] [data-act="group-close"]`, true);
		ok(yes.asked, 'it asks again on the second press', yes);
		for (let i = 0; i < 80; i++) {
			if (await a.page.evaluate(async (g) =>
				window.DaimondGroup.isClosed(await window.DaimondGroup.get(g)), gid)) break;
			await new Promise(r => setTimeout(r, 50));
		}
		const closed = await a.page.evaluate(async (g) => {
			const rec = await window.DaimondGroup.get(g);
			return { members: rec.members.length, state: rec.state,
				closed: window.DaimondGroup.isClosed(rec),
				note: (document.querySelector('#group-note') || {}).textContent || '' };
		}, gid);
		ok(closed.closed, 'the group is closed', closed);
		eq(closed.members, 0,
			'and CLOSED IS THE ROSTER NAMING NOBODY -- not a flag beside a roster, '
			+ 'which is why it travels on the half of the record `adopt` already copies');
		eq(closed.state, 'left',
			'the creator is out of it too, which is what "nobody, you included" means');
		ok(/Closed, and 2 people have been told/.test(closed.note),
			'and the panel says how many were told', closed.note);

		// ── EVERYBODY WHO WAS IN IT WAS SENT IT.
		const posts = await handed(a);
		eq(posts.length, 2, 'the closing roster was offered to both members',
			posts.map(p => p.to));
		// AND THE REST OF THE SECTION DOES NOT DEPEND ON THAT HAVING WORKED. A break
		// that stopped the close being composed took this section down at
		// `posts[0].envelope` and the eight checks after it printed nothing -- the
		// exact shape this file's own header warns about, one level in.
		const closingEnv = posts.length ? posts[0] : { envelope: '', addr: '' };

		// ── THE CREATOR CANNOT WRITE TO IT, AND IS TOLD WHY IT IS CLOSED.
		const mine = await a.page.evaluate(async (g) =>
			window.DaimondPost.sealGroup(g, { body: 'One more thing.' }), gid);
		ok(!mine.ok, 'its own maker cannot write to it again', mine);
		ok(/has been closed/.test(mine.why || ''),
			'and the reason says it was CLOSED', mine.why);
		ok(!/no longer in this group/.test(mine.why || ''),
			'not that they are no longer in it -- true of the record and wrong about '
			+ 'what happened, and wrong in the direction that reads as blame',
			mine.why);
		ok(!/[Jj]oin this group before writing/.test(mine.why || ''),
			'and not the "join first" wording either', mine.why);

		// ── AND NO FURTHER ROSTER, so the membership controls cannot walk around it.
		const change = await a.page.evaluate(async ([g, kb]) =>
			window.DaimondGroup.setMembers(g, null, [kb]), [gid, B.key]);
		ok(!change.ok, 'and cannot change who is in it', change);
		ok(/has been closed/.test(change.why || ''), 'for the same stated reason',
			change.why);

		// ── THE MEMBERS CONVERGE ON IT, off the bytes the press sent.
		for (const [s, who] of [[b, 'B'], [c, 'C']]) {
			const got = await deliver(s, closingEnv.envelope, closingEnv.addr);
			ok(got.op, `${who} opened the roster that closes it`, got);
			const st = await s.page.evaluate(async (g) => {
				const rec = await window.DaimondGroup.get(g);
				return { closed: window.DaimondGroup.isClosed(rec), state: rec.state,
					why: (await window.DaimondPost.sealGroup(g, { body: 'hello' })).why };
			}, gid);
			ok(st.closed, `${who} holds it as closed`, st);
			eq(st.state, 'left', `and out of it`);
			ok(/has been closed/.test(st.why || ''),
				`and ${who} is told the group closed, not that they left`, st.why);
		}

		// ── AND KEEPS EVERY MESSAGE. Nothing is deleted anywhere: this is the whole
		// of "people keep the messages they already have".
		const still = await b.page.evaluate(async (body) => {
			await window.DaimondPost.read();
			return window.DaimondPost.list().some(m => m.body === body)
				|| window.DaimondPost.tray().some(m => m.body === body);
		}, KEPT);
		ok(still, 'B still holds every message from before it closed');

		// ── NOBODY CAN WRITE TO IT AGAIN, AND IT IS THE READERS THAT SAY SO. B's
		// envelope was composed while the group was open and is delivered after it
		// closed; C refuses it. There is no group key to rotate and the relay knows
		// nothing about groups, so the readers are the only place this could be.
		// THE COST IS REAL AND IS THE POINT OF MEASURING IT: what a member keeps is
		// what they have already collected, and an envelope still on the relay at
		// the moment of the close is lost.
		const late = await deliver(c, made2env(inFlight), made2addr(inFlight));
		ok(!late.ok, 'a message still in the post when it closed is refused', late);
		ok(/addressed to a different key/i.test(late.why || ''),
			'by the same walk of the roster a removal is enforced by: an empty roster '
			+ 'contains nobody', late.why);

		// ── IT CANNOT BE UNDONE, AND THAT IS A PROPERTY AT EVERY READER RATHER THAN
		// A PROMISE ON A DIALOGUE. A forges nothing here: the roster below is signed
		// with A's OWN key and carries A's own group id, so it is authorised by the
		// derivation that authorises every other roster of theirs. It is refused
		// anyway, by `consume`, on a device that is not A's.
		const reopen = await a.page.evaluate(async ([g, salt, ka, kb, kc]) => {
			const unhex = (s) => {
				const u = new Uint8Array(s.length >> 1);
				for (let i = 0; i < u.length; i++) u[i] = parseInt(s.substr(i * 2, 2), 16);
				return u;
			};
			const hex = (u) => { let h = ''; for (const x of u) h += ('0' + x.toString(16)).slice(-2); return h; };
			const people = await window.DaimondTrust.people();
			const encOf  = (k) => (people.find(p => p.key === k) || {}).enc;
			const members = [
				{ k: ka, e: hex(window.DaimondIdentity.sealingKeyRaw()), n: '' },
				{ k: kb, e: encOf(kb), n: '' },
				{ k: kc, e: encOf(kc), n: '' },
			];
			const body = window.DaimondGroup.MARK + '\n'
				+ JSON.stringify({ op: 'roster', salt, name: 'Back again', members });
			const made = await window.DaimondPost.compose({
				body, group: { id: unhex(g), enc: [encOf(kb), encOf(kc)].map(unhex) },
			});
			return { addr: made.addr, envelope: made.envelope };
		}, [gid, made.salt || (await a.page.evaluate(async (g) =>
			(await window.DaimondGroup.get(g)).salt, gid)),
			(await a.page.evaluate(async () => {
				const raw = await window.DaimondIdentity.publicKeyRaw();
				let h = ''; for (const x of raw) h += ('0' + x.toString(16)).slice(-2);
				return h;
			})), B.key, C.key]);
		const back = await deliver(c, reopen.envelope, reopen.addr);
		ok(!back.moved, 'a later roster from the creator does NOT reopen it', back);
		const cStill = await c.page.evaluate(async (g) => {
			const rec = await window.DaimondGroup.get(g);
			return { members: rec.members.length, name: rec.name,
				closed: window.DaimondGroup.isClosed(rec) };
		}, gid);
		ok(cStill.closed, 'and C\'s record is still closed', cStill);
		ok(cStill.name !== 'Back again',
			'with the roster it was closed with, not the one that tried to revive it',
			cStill);
		// AND THE OTHER DOOR. `leave` is what a stale Leave control would call, and it
		// refuses: there is nothing left to leave, so answering true would report an
		// act that did not happen. Asked directly because the panel is one caller --
		// section 4 asks the same question of a creator the same way.
		const door = await c.page.evaluate(async (g) => ({
			leave: await window.DaimondGroup.leave(g),
			state: (await window.DaimondGroup.get(g)).state,
		}), gid);
		eq(door.leave, false, '`leave` refuses a closed group');
		eq(door.state, 'left', 'and did not move the record');

		// `join` HAS THE SAME GUARD AND THIS DOES NOT DRIVE IT, deliberately, and the
		// gap is named rather than papered over. Section 10 forbids this file from
		// calling that method at all -- for a good reason, since a setup call to it
		// is what made 88 assertions green over a creator who could not write to
		// their own group -- and the application has no path to it on a closed row
		// either, because the row above carries no Join control. So what is checked
		// here is the REACHABLE property (no control) and the source of the guard
		// behind it. THE SECOND HALF PROVES THE LINE EXISTS AND NOT THAT IT RUNS.
		const gsrc = fs.readFileSync(path.join(APP, 'www/js/group.js'), 'utf8');
		const joinAt = gsrc.indexOf('async function join(gid)');
		ok(joinAt > 0 && /if \(isClosed\(rec\)\) return false;/
			.test(gsrc.slice(joinAt, joinAt + 260)),
			'`join` carries the same closed guard, read from the source because '
			+ 'nothing in the app or in this file may call it', { joinAt });

		// ── IT IS DRAWN AS CLOSED, WITH NO CONTROLS AT ALL, AND IT KEEPS ITS PLACE.
		// Not removed: `post.js` `drawMsg` puts this record's NAME over every message
		// of the group, so deleting the record would leave the transcript the feature
		// exists to keep under "A group · 3f2a91c4".
		await panel(c);
		const drawn = await c.page.evaluate((g) => {
			const host = document.querySelector('#post-groups');
			const row  = host && host.querySelector(`[data-gid="${g}"]`);
			const inv  = document.querySelector('#group-invites');
			return {
				listed:  !!document.querySelector(`#group-list [data-gid="${g}"]`),
				invited: !!inv && !!inv.querySelector(`[data-gid="${g}"]`),
				marked:  !!row && row.dataset.closed === '1',
				acts:    row ? [...row.querySelectorAll('[data-act]')].map(x => x.dataset.act) : ['?'],
				text:    row ? row.textContent : '',
				picker:  [...document.querySelectorAll('#post-to option')].map(o => o.value),
			};
		}, gid);
		ok(drawn.listed && !drawn.invited,
			'a closed group keeps its place on the list and is not an invitation', drawn);
		ok(drawn.marked, 'and is marked as closed for a stylesheet to reach', drawn);
		eq(drawn.acts, [], 'with NO controls on it: not Join, not Leave, not Close');
		ok(/closed by the person who made it/.test(drawn.text),
			'and says who closed it and that nothing was taken away', drawn.text);
		ok(!drawn.picker.some(v => v === 'g:' + gid),
			'AND IT IS OFF THE RECIPIENT PICKER, so nothing offers to write to it',
			drawn.picker);

		// ── THE ONE CASE THE LOCAL HALF CAN GET WRONG, AND THE REPAIR FOR IT.
		// The two halves of a record merge on separate clocks: the roster half moves
		// on the higher `at`, the local half on the higher `stateAt`. A member who
		// pressed Join on a device whose clock runs ahead of the creator's holds a
		// `stateAt` LATER than the closing roster's `at`, so a second device of
		// theirs adopts the empty roster and keeps `joined`. `post.js`
		// `joinedGroups` builds the picker from `state === 'joined'` alone, so that
		// record would offer a destination `sealTo` refuses. `draw` settles it.
		const skewed = await c.page.evaluate(async (g) => {
			const rec = await window.DaimondGroup.get(g);
			rec.state   = 'joined';
			rec.stateAt = rec.at + 100000;		// a clock that runs ahead
			await window.DaimondPost.putGroup(g, rec);
			const before = (await window.DaimondGroup.get(g)).state;
			await window.DaimondPost.read();
			window.DaimondPost.render();
			for (let i = 0; i < 60; i++) {
				if ((await window.DaimondGroup.get(g)).state === 'left') break;
				await new Promise(r => setTimeout(r, 25));
			}
			// A SECOND RENDER, because the picker is drawn in the same pass as the
			// settle: the record goes right on this render and the picker on the next.
			window.DaimondPost.render();
			await new Promise(r => setTimeout(r, 150));
			return { before, after: (await window.DaimondGroup.get(g)).state,
				picker: [...document.querySelectorAll('#post-to option')].map(o => o.value) };
		}, gid);
		eq(skewed.before, 'joined', 'a record can be left saying joined over an empty roster');
		eq(skewed.after, 'left', 'and the panel settles it rather than drawing round it');
		ok(!skewed.picker.some(v => v === 'g:' + gid),
			'so the picker does not offer a closed group even then', skewed.picker);

		// ── A GROUP OF ONE CAN BE CLOSED TOO, and it is here because the fan-out
		// reaches NOBODY: the closing roster has an empty slot list and an empty
		// reach, and `compose` allows that deliberately (see its own note on a group
		// of one). It is the case a guard written as "there must be somebody to tell"
		// would refuse, leaving a group nothing can be sent to and nothing can close.
		const alone = await a.page.evaluate(async () =>
			window.DaimondGroup.create('Only me', []));
		ok(alone.ok, 'a group of one exists', alone);
		const shut = await a.page.evaluate(async (g) => {
			const r = await window.DaimondGroup.close(g);
			const rec = await window.DaimondGroup.get(g);
			return { ok: r.ok, why: r.why || '', sent: r.sent,
				closed: window.DaimondGroup.isClosed(rec), state: rec.state };
		}, alone.gid);
		ok(shut.ok, 'and closing it succeeds with nobody to tell', shut);
		eq(shut.sent, 0, 'having told nobody, which is how many there were');
		ok(shut.closed && shut.state === 'left', 'and it is closed', shut);
	} finally {
		await realRelay(a);
		await Promise.all([a.close(), b.close(), c.close()]);
	}
}

// ── 6. The arithmetic is at the fan-out ──────────────────────

function arithmeticIsInTheCode() {
	console.log('\n6. the size arithmetic is in a comment at the fan-out');
	const src = fs.readFileSync(path.join(APP, 'www/js/post.js'), 'utf8');
	const at  = src.indexOf('THE FAN-OUT, AND WHERE IT ACTUALLY STOPS');
	ok(at > 0, 'the comment is in post.js');
	const near = src.slice(at, at + 2200);
	ok(/60 bytes/.test(near), 'and it names 60 bytes a slot, which is what SLOT is');
	ok(/255/.test(near), 'and 255 as the hard stop, because the slot count is one byte');
	// The comment must be AT the fan-out and not in the file's header, or it is a
	// document nobody reads next to the code.
	const compose = src.indexOf('async function compose(opts)');
	ok(compose > at && compose - at < 2600,
		'and it sits immediately above the function that builds the envelope',
		{ commentAt: at, composeAt: compose });
	// The numbers the comment claims are the numbers the code has.
	ok(/var SLOT = IV \+ 32 \+ 16;/.test(src), 'SLOT really is 12 + 32 + 16');
	ok(/var SLOTS_MAX = 255;/.test(src), 'and SLOTS_MAX really is 255');
}

// ── Run ──────────────────────────────────────────────────────

console.log('verify_group -- a membership list with no group key');

// Sections by number, so that proving one RED by mutating the implementation
// does not cost a whole run each time. With no argument every section runs, and
// that is what the suite means.
const SECTIONS = {
	0: seamIsReal,
	1: threeIdentities,
	2: idIsTheAuthorisation,
	3: joiningShowsNothing,
	4: removingRetractsNothing,
	5: markerIsRefused,
	6: async () => arithmeticIsInTheCode(),
	7: aChangedKeyGetsNoSlot,
	8: oneMessageIsOneNotice,
	9: theMergeConverges,
	10: theShippedPath,
	11: aRejectedKeyIsNamed,
	12: aRefusalIsDrawn,
	13: closingIsFinal,
};
const want = process.argv.slice(2).filter(a => /^\d+$/.test(a));
for (const n of (want.length ? want : Object.keys(SECTIONS))) {
	// A SECTION THAT THROWS IS ONE FAILURE, not the end of the run. It used to be
	// the end of it: a fixture reading `early.made.envelope` after the send it
	// depended on had failed took the process down with it, and every section
	// after that one printed nothing at all. Which mattered the first time this
	// suite was deliberately broken to see what turned red -- the answer was two
	// lines out of twelve sections, because the other ten never ran, and a
	// red-proof that cannot see its own reds is not one.
	try { await SECTIONS[n](); }
	catch (e) {
		failures++;
		console.log(`  FAIL  section ${n} threw and the rest of it did not run`
			+ `  -- ${String(e && e.message || e)}`);
	}
}

console.log(failures ? `\n${failures} failure(s)` : '\nall properties hold');
process.exit(failures ? 1 : 0);
