// verify_trust.mjs — first contact, with no server in the path at all.
//
// This is the phase's own proof and it is shaped like the claim: two devices,
// two identities, no gateway. The gateway is not merely unused, it is NOT
// RUNNING; the cards cross between the two browsers through this script, the
// way a camera carries them across a table, and each side computes the safety
// number for itself and the two are compared here rather than by either of them.
//
// What each block settles:
//
//   A  Two devices agree on a sixty-digit number that neither of them sent
//      anywhere. The number is a function of BOTH keys, and no request either
//      browser made carried either key or the number.
//   B  The three transports carry one artefact, and a card with a byte changed
//      does not parse.
//   C  The TrustEdge is signed, the log is hash chained, and the replay CHECKS
//      the signature — an edge with its signature scribbled out projects the
//      person back to "new" rather than keeping a state it cannot justify.
//   D  Decision 4: a card that arrived asynchronously is never offered
//      "Mark matched now". A card read by this device's own camera is.
//   E  A look-alike label WARNS beside a key and never blocks it.
//   F  Rotation is a claim and not a transfer: a new key naming a matched one
//      as its predecessor is "changed", loudly, and messages are held.
//   G  The two-axis wording: never "verified", never "trusted", and drawn as a
//      LINE UNDER THE NAME rather than a badge beside it — checked by geometry,
//      which no translation can defeat, and by reading all eight locale files.
//   H  Reachability: the panel seam is fed, and index.html loads the file.
//   I  Finding somebody by handle, with THIS SCRIPT standing in for the
//      gateway behind `sync.js`'s own fetch. That is not a shortcut: a
//      stand-in is precisely the thing the ceiling exists for, and what it
//      proves is that a card handed over by something in the middle is drawn
//      NEW, is offered no way up, and is refused outright when it has been
//      bent or when the fingerprint served beside it names another key.
//   J  "Send my code" hands over the LINK, with the string form under it, and
//      the link on its own adds the person who pastes it.
//
// Needs the dev server only (DAIMOND_PORT). Deliberately no gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';
import { GW_PORT, GW_URL } from './ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Bring a session up with trust.js loaded, an unlocked identity and a card.
async function device(name) {
	const s = await open({ name, signIn: true, connect: false });
	s.seen = [];
	s.page.on('request', r => {
		let body = '';
		try { body = r.postData() || ''; } catch (e) { /* not a body we can read */ }
		s.seen.push(r.url() + ' ' + body);
	});
	await s.page.waitForFunction(() => !!window.DaimondCrypto, null, { timeout: 20000 });
	await s.page.addScriptTag({ url: 'js/trust.js' });
	await s.page.waitForFunction(() => !!window.DaimondTrust, null, { timeout: 10000 });
	await s.page.evaluate(async () => {
		await window.DaimondIdentity.ensureSealingKey();
		await window.DaimondIdentity.mintCard();
	});
	s.key = await s.page.evaluate(() => {
		const b64 = window.DaimondIdentity.publicKeyB64url().replace(/-/g, '+').replace(/_/g, '/');
		return Array.from(atob(b64)).map(c => (c.charCodeAt(0) + 256).toString(16).slice(1)).join('');
	});
	return s;
}

/// Was there a gateway to lean on at all? The answer wanted is "no".
let gatewayUp = false;
try {
	const r = await fetch(`${GW_URL}/`, { signal: AbortSignal.timeout(800) });
	gatewayUp = !!r;
} catch (e) { gatewayUp = false; }

const A = await device('trustb-a');
const B = await device('trustb');			// the label a look-alike will imitate
// A stranger, never matched, so the offers a card gets can be read without a
// prior match already having answered the question.
const S = await device('trust8');			// "trust8" folds onto "trustb": 8 → b

try {
	console.log(`\n── A. Two devices, no server ${'─'.repeat(40)}`);
	check('the gateway was not running for any of this', !gatewayUp,
		gatewayUp ? `something answered on :${GW_PORT} — the wire checks below still hold`
			: `nothing on :${GW_PORT}`);

	// The cards cross through this script and through nothing else. Neither
	// browser was asked to fetch anything to obtain the other's key.
	const aCard = await A.page.evaluate(() => window.DaimondTrust.cardText());
	const bCard = await B.page.evaluate(() => window.DaimondTrust.cardText());
	const aUrl  = await A.page.evaluate(() => window.DaimondTrust.cardUrl());

	const aSees = await A.page.evaluate(async (text) => {
		const card = window.DaimondTrust.parse(text);
		if (!card) return null;
		await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.QR);
		return { key: card.key, fp: card.fp, label: card.label };
	}, bCard);
	const bSees = await B.page.evaluate(async (text) => {
		const card = window.DaimondTrust.parse(text);
		if (!card) return null;
		await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.QR);
		return { key: card.key, fp: card.fp, label: card.label };
	}, aCard);
	check('each device read the other\'s card', !!aSees && !!bSees,
		aSees && bSees ? `${aSees.fp} / ${bSees.fp}` : 'a card did not verify');
	check('the key each read is the key the other holds',
		aSees && bSees && aSees.key === B.key && bSees.key === A.key);

	// Computed independently, on each device, and compared HERE.
	const aNum = await A.page.evaluate(k => window.DaimondTrust.safetyNumber(k), B.key);
	const bNum = await B.page.evaluate(k => window.DaimondTrust.safetyNumber(k), A.key);
	check('both devices computed the same safety number', !!aNum && aNum === bNum,
		aNum ? aNum.slice(0, 23) + '…' : 'none');
	const groups = String(aNum).split(/\s+/).filter(Boolean);
	check('sixty digits in twelve groups of five',
		groups.length === 12 && groups.every(g => /^[0-9]{5}$/.test(g)),
		`${groups.length} groups, ${groups.join('').length} digits`);
	// A number that ignored one of the two keys would pass every check above.
	const otherNum = await A.page.evaluate(() =>
		window.DaimondTrust.safetyNumber('11'.repeat(32)));
	check('the number is a function of BOTH keys', !!otherNum && otherNum !== aNum);
	// And symmetric under the order of the pair, which is what lets two people
	// compare without first agreeing who is first.
	const symmetric = await A.page.evaluate(async (bk) => {
		const mine = await window.DaimondIdentity.publicKeyRaw();
		const theirs = Uint8Array.from(bk.match(/../g).map(h => parseInt(h, 16)));
		return window.DaimondCrypto.safetyNumber(mine, theirs)
			=== window.DaimondCrypto.safetyNumber(theirs, mine);
	}, B.key);
	check('and symmetric whichever key is given first', symmetric);

	// THE WIRE. Nothing either browser asked for carried the other's key or the
	// number they agreed on.
	const wire = [...A.seen, ...B.seen].join('\n');
	const leaked = [A.key, B.key, aNum, aNum.replace(/\s+/g, '')]
		.filter(v => v && wire.indexOf(v) >= 0);
	check('no request from either browser carried a key or the number', leaked.length === 0,
		`${A.seen.length + B.seen.length} requests seen`);

	console.log(`\n── B. The transports ${'─'.repeat(48)}`);
	check('the paste form is DMND-ID1.', aCard.slice(0, 9) === 'DMND-ID1.', aCard.slice(0, 20) + '…');
	check('the URL form is a fragment, so it reaches no server', /#c=/.test(aUrl) && !/\?c=/.test(aUrl));
	const viaUrl = await B.page.evaluate(u => {
		const c = window.DaimondTrust.parse(u);
		return c ? c.key : '';
	}, aUrl);
	check('the URL form parses to the same key as the paste form', viaUrl === A.key);
	// One byte changed anywhere in the artefact and it is not a card.
	const damaged = await B.page.evaluate(t => {
		const b64 = t.slice(9).replace(/-/g, '+').replace(/_/g, '/');
		const raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
		const bytes = Array.from(raw).map(c => c.charCodeAt(0));
		const hits = [];
		for (const at of [20, Math.floor(bytes.length / 2), bytes.length - 3]) {
			const copy = bytes.slice();
			copy[at] ^= 0x01;
			const s = btoa(String.fromCharCode.apply(null, copy))
				.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
			hits.push(!!window.DaimondTrust.parse('DMND-ID1.' + s));
		}
		return hits;
	}, aCard);
	check('a card with one byte changed does not parse', damaged.every(h => h === false),
		`parsed ${damaged.filter(Boolean).length} of ${damaged.length} damaged copies`);

	// SHOWING is a caller, not a build: the one QR drawer in the app is
	// pairing.js's, and this proves the card reaches it and comes out as ink.
	const shown = await A.page.evaluate(async () => {
		document.querySelectorAll('.pair-scrim').forEach(n => n.remove());
		window.DaimondTrust.showCard();
		await new Promise(r => setTimeout(r, 600));
		const c = document.querySelector('.pair-scrim canvas.pair-qr');
		if (!c) return { drawn: false };
		const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		let black = 0, white = 0;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) black++;
			else if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) white++;
		}
		const paste = (document.querySelector('.pair-scrim textarea') || {}).value || '';
		document.querySelectorAll('.pair-scrim').forEach(n => n.remove());
		return { drawn: true, px: c.width, black, white, paste };
	});
	check('showing my code draws a real symbol through the app\'s one QR drawer',
		shown.drawn && shown.black > 100 && shown.white > 100,
		shown.drawn ? `${shown.px}px, ${shown.black} dark / ${shown.white} light` : 'no canvas');
	check('and the same screen offers the paste form beside it',
		String(shown.paste).slice(0, 9) === 'DMND-ID1.');

	console.log(`\n── C. The edge, the log, and what the replay checks ${'─'.repeat(18)}`);
	await A.page.evaluate(k => window.DaimondTrust.markMatched(k, window.DaimondTrust.METHOD.QR), B.key);
	await B.page.evaluate(k => window.DaimondTrust.markMatched(k, window.DaimondTrust.METHOD.QR), A.key);
	const edge = await A.page.evaluate(() => {
		const log = window.DaimondTrust.log();
		const e = log.filter(x => x.k === 'edge').pop();
		return e || null;
	});
	check('an edge was written', !!edge, edge ? `${edge.method}, scope ${edge.scope}` : 'none');
	check('its scope is IDENTITY and there is no other arm', edge && edge.scope === 'identity');
	check('its method names an act on a KEY, not a claim about a person',
		edge && ['in_person_qr', 'safety_number'].indexOf(edge.method) >= 0, edge && edge.method);
	check('it carries a nonce and a signature', edge && !!edge.nonce && !!edge.sig);
	const chainOk = await A.page.evaluate(() => window.DaimondTrust.chainBreak());
	check('the log\'s hash chain is intact', chainOk === -1, `break at ${chainOk}`);

	const matched = await A.page.evaluate(async k => {
		const p = await window.DaimondTrust.person(k);
		return p ? { state: p.state, method: p.method, words: window.DaimondTrust.keyWords(p) } : null;
	}, B.key);
	check('the projection reads that key as matched', matched && matched.state === 'matched',
		matched ? matched.words : 'no person');

	// THE CHECK WITH TEETH. Scribble out the signature and replay: an assertion
	// that merely read `edge.method` would still say "matched".
	const tampered = await A.page.evaluate(async k => {
		const log = JSON.parse(localStorage.getItem('daimond-trust-log'));
		const keep = JSON.stringify(log);
		for (const e of log) if (e.k === 'edge') e.sig = e.sig.slice(0, -4) + 'AAAA';
		localStorage.setItem('daimond-trust-log', JSON.stringify(log));
		window.DaimondTrust.forget();
		const p = await window.DaimondTrust.person(k);
		const state = p ? p.state : 'gone';
		localStorage.setItem('daimond-trust-log', keep);
		window.DaimondTrust.forget();
		const back = await window.DaimondTrust.person(k);
		return { state, restored: back ? back.state : 'gone' };
	}, B.key);
	check('an edge whose signature was changed no longer matches anybody',
		tampered.state === 'new', `state became "${tampered.state}"`);
	check('and the untouched log still reads matched', tampered.restored === 'matched');

	// The same question of the card half.
	const cardTampered = await A.page.evaluate(async k => {
		const log = JSON.parse(localStorage.getItem('daimond-trust-log'));
		const keep = JSON.stringify(log);
		for (const e of log) {
			if (e.k !== 'card') continue;
			const raw = atob(e.a);
			const bytes = Array.from(raw).map(c => c.charCodeAt(0));
			bytes[Math.floor(bytes.length / 2)] ^= 0x01;
			e.a = btoa(String.fromCharCode.apply(null, bytes));
		}
		localStorage.setItem('daimond-trust-log', JSON.stringify(log));
		window.DaimondTrust.forget();
		const p = await window.DaimondTrust.person(k);
		localStorage.setItem('daimond-trust-log', keep);
		window.DaimondTrust.forget();
		return p ? p.state : 'gone';
	}, B.key);
	check('a card whose bytes were changed is no claim at all', cardTampered === 'gone',
		`projected as "${cardTampered}"`);

	const broke = await A.page.evaluate(async () => {
		const log = JSON.parse(localStorage.getItem('daimond-trust-log'));
		const keep = JSON.stringify(log);
		log[0].t = (log[0].t || 0) + 1;
		localStorage.setItem('daimond-trust-log', JSON.stringify(log));
		const at = await window.DaimondTrust.chainBreak();
		localStorage.setItem('daimond-trust-log', keep);
		return at;
	});
	check('editing an entry in place breaks the chain, at a named position', broke === 0, `break at ${broke}`);

	// Blocking, and its removal, are both APPENDED. Nothing in this log deletes.
	const blocked = await A.page.evaluate(async k => {
		const before = window.DaimondTrust.log().length;
		await window.DaimondTrust.setBlocked(k, true);
		const on = (await window.DaimondTrust.person(k)).state;
		const onWords = window.DaimondTrust.keyWords(await window.DaimondTrust.person(k));
		await window.DaimondTrust.setBlocked(k, false);
		const off = (await window.DaimondTrust.person(k)).state;
		return { on, off, onWords, grew: window.DaimondTrust.log().length - before,
			chain: await window.DaimondTrust.chainBreak() };
	}, B.key);
	check('blocking a key shows on the row, and unblocking takes it off',
		blocked.on === 'blocked' && blocked.off === 'matched', `"${blocked.onWords}"`);
	check('both the block and its removal were APPENDED, not edited away',
		blocked.grew === 2 && blocked.chain === -1, `the log grew by ${blocked.grew}`);

	const noTools = await A.page.evaluate(async k => {
		const before = window.DaimondTrust.log().length;
		const got = await window.DaimondTrust.markMatched(k, 'tools');
		return { got: got, grew: window.DaimondTrust.log().length - before };
	}, B.key);
	check('there is no TOOLS scope to write, and the attempt writes nothing',
		noTools.got === null && noTools.grew === 0);

	console.log(`\n── D. Decision 4: a lookup can never rise on its own ${'─'.repeat(17)}`);
	// The offer a card gets depends entirely on how it arrived, and this reads
	// the ACTUAL DIALOG — the buttons a person would see — rather than a flag
	// that says which branch was taken.
	const sUrl = await S.page.evaluate(() => window.DaimondTrust.cardUrl());
	const dialogFor = (route) => A.page.evaluate(async ([u, r]) => {
		document.querySelectorAll('.pair-scrim').forEach(n => n.remove());
		if (r === 'link') {
			// The arrival a phone's camera produces: the app opens at the URL and
			// the hash handler takes it from there.
			location.hash = u.slice(u.indexOf('#'));
			window.dispatchEvent(new HashChangeEvent('hashchange'));
		} else {
			// The arrival THIS device's own camera produces. The scanner hands the
			// text it read to the same door, with the route that says so.
			window.DaimondTrust.offer(window.DaimondTrust.parse(u), r);
		}
		await new Promise(res => setTimeout(res, 400));
		const box = document.querySelector('.pair-box');
		const text = box ? box.textContent : '';
		const buttons = box ? [...box.querySelectorAll('button')].map(b => b.textContent) : [];
		document.querySelectorAll('.pair-scrim').forEach(n => n.remove());
		return { text, buttons };
	}, [sUrl, route]);

	const linkOffer = await dialogFor('link');
	check('a card arriving by link offers no "Mark matched now"',
		linkOffer.buttons.length > 0 && linkOffer.buttons.every(b => !/matched now/i.test(b)),
		`buttons: ${linkOffer.buttons.join(' | ') || 'NONE — the dialog did not open'}`);
	check('and it offers the safety number instead',
		linkOffer.buttons.some(b => /safety number/i.test(b)));
	check('and it says why, in words', /middle/i.test(linkOffer.text));

	const qrOffer = await dialogFor('qr');
	check('a card this device\'s own camera read DOES offer it',
		qrOffer.buttons.some(b => /matched now/i.test(b)),
		`buttons: ${qrOffer.buttons.join(' | ') || 'NONE'}`);

	// A third identity mints a card naming B's key as the one it supersedes —
	// which is exactly what somebody who stole B's old key could also do. Minted
	// now and used after E, because the rotation takes B out of the matched set
	// and the look-alike below is a comparison against it.
	const C = await device('trust-carol');
	const rotated = await C.page.evaluate(async (prevHex) => {
		const id = window.DaimondIdentity, b = window.DaimondCrypto;
		const enc = id.sealingKeyRaw();
		const prev = Uint8Array.from(prevHex.match(/../g).map(h => parseInt(h, 16)));
		const payload = b.cardEncode('carol', enc, prev);
		const author = await id.publicKeyRaw();
		const when = Date.now();
		const sigB64 = await id.sign(b.signingInput(payload, 'daimond/card/0', author, when));
		const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
		const art = b.assemble(payload, 'daimond/card/0', author, when, sig);
		let s = '';
		for (const byte of art) s += String.fromCharCode(byte);
		return 'DMND-ID1.' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}, B.key);

	console.log(`\n── E. A look-alike warns, and never blocks ${'─'.repeat(27)}`);
	const sCard = await S.page.evaluate(() => window.DaimondTrust.cardText());
	const lookalike = await A.page.evaluate(async ([text, dk]) => {
		const card = window.DaimondTrust.parse(text);
		await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.PASTE);
		const p = await window.DaimondTrust.person(dk);
		const folds = [window.DaimondTrust.fold('trust8'), window.DaimondTrust.fold('trustb')];
		return p ? { state: p.state, warn: p.warn, warnFp: p.warnFp, label: p.label, folds } : null;
	}, [sCard, S.key]);
	check('a name that folds onto a matched one is flagged',
		lookalike && lookalike.warn === 'lookalike',
		lookalike ? `"${lookalike.label}" folds to ${lookalike.folds[0]}` : 'no person');
	check('the folding is what caught it', lookalike && lookalike.folds[0] === lookalike.folds[1]);
	check('and it is a WARNING: the key is still listed, still new',
		lookalike && lookalike.state === 'new');

	// And the other way of matching, which the list below then carries a row of:
	// the two methods must read as two statements about an ACT, and neither may
	// read as a statement about a person.
	const byNumber = await A.page.evaluate(async k => {
		await window.DaimondTrust.markMatched(k, window.DaimondTrust.METHOD.NUMBER);
		const p = await window.DaimondTrust.person(k);
		return p ? { state: p.state, method: p.method, words: window.DaimondTrust.keyWords(p) } : null;
	}, S.key);
	check('a key matched by safety number says so, and says only that',
		byNumber && byNumber.state === 'matched' && /safety number/i.test(byNumber.words),
		byNumber && byNumber.words);

	console.log(`\n── F. Rotation is a claim, never a transfer ${'─'.repeat(26)}`);
	const changed = await A.page.evaluate(async ([text, bk]) => {
		const card = window.DaimondTrust.parse(text);
		await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.PASTE);
		const p = await window.DaimondTrust.person(card.key);
		const old = await window.DaimondTrust.person(bk);
		return p ? {
			state: p.state, key: p.key, prevKey: p.prevKey, chain: p.chain.length,
			words: window.DaimondTrust.keyWords(p),
			oldSame: old && old.key === p.key,
		} : null;
	}, [rotated, B.key]);
	check('a card naming a matched key as its predecessor joins that chain',
		changed && changed.chain === 2 && changed.prevKey === B.key);
	check('the match does NOT carry across to the new key',
		changed && changed.state === 'changed', changed ? `state "${changed.state}"` : 'none');
	check('and the words say a different key, loudly',
		changed && /different key/i.test(changed.words), changed && changed.words);
	check('the old key now resolves to the same person', changed && changed.oldSame);
	await C.close();

	console.log(`\n── G. Two axes, and they never share a badge or a word ${'─'.repeat(15)}`);
	// Somebody recorded and never matched, so the list carries all three states
	// at once and the words for each can be read off one screen.
	const N = await device('trust-nell');
	const nCard = await N.page.evaluate(() => window.DaimondTrust.cardText());
	await A.page.evaluate(async (text) => {
		await window.DaimondTrust.record(window.DaimondTrust.parse(text),
			window.DaimondTrust.ROUTE.LOOKUP);
	}, nCard);
	await N.close();
	// Draw the real list into the real panel, then MEASURE it.
	const drawn = await A.page.evaluate(async () => {
		try { window.DaimondSocial.open('people'); } catch (e) { /* no panel */ }
		await new Promise(r => setTimeout(r, 300));
		await window.DaimondTrust.refresh();
		await new Promise(r => setTimeout(r, 200));
		const host = document.getElementById('social-people-list');
		if (!host) return { host: false };
		const rows = [...host.querySelectorAll('.trust-row')];
		const out = rows.map(row => {
			const name = row.querySelector('.trust-name, .trust-claim');
			const line = row.querySelector('[data-key-state]');
			if (!name || !line) return { bad: 'missing' };
			const n = name.getBoundingClientRect(), l = line.getBoundingClientRect();
			return {
				state: line.getAttribute('data-key-state'),
				words: line.textContent,
				nameH: n.height, lineH: l.height,
				below: l.top >= n.bottom - 1,
				flushLeft: Math.abs(l.left - n.left) <= 2,
				display: getComputedStyle(line).display,
			};
		});
		return { host: true, rows: out };
	});
	check('the People list is drawn into the panel\'s own container', drawn.host && drawn.rows.length > 0,
		drawn.host ? `${drawn.rows.length} rows` : '#social-people-list not found');
	// A geometry check on a hidden panel measures nothing and passes on everything,
	// so the rows are proved to have been ON SCREEN before anything is concluded.
	const measurable = drawn.rows && drawn.rows.every(r => r.nameH > 0 && r.lineH > 0);
	check('the rows were actually on screen when measured', measurable,
		measurable ? '' : 'a rect was zero — the checks below would have been vacuous');
	check('every row carries a key line', drawn.rows && drawn.rows.every(r => !r.bad));
	check('the key line is a block, so nothing can sit beside it',
		drawn.rows && drawn.rows.every(r => r.display === 'block'));
	check('the key line is BELOW the name, never beside it',
		measurable && drawn.rows.every(r => r.below));
	check('and starts at the name\'s own left edge', measurable && drawn.rows.every(r => r.flushLeft));
	const words = (drawn.rows || []).map(r => r.words).join(' | ');
	check('no key line says "verified" or "trusted"',
		!/verif|trust(ed)?\b/i.test(words), words);
	check('an unmatched key says "new", not "unverified"',
		drawn.rows.some(r => r.state === 'new' && /new key/i.test(r.words)));

	// The guard, proved rather than assumed: a table that says the wrong thing
	// must not reach the screen.
	const guarded = await A.page.evaluate(() => {
		const real = window.DaimondI18n.t;
		window.DaimondI18n.t = function (k) {
			if (k === 'trust.key_new') return 'Verified — you can trust this one';
			return real.apply(this, arguments);
		};
		const node = window.DaimondTrust.drawKeyLine({ state: 'new' });
		window.DaimondI18n.t = real;
		return node.textContent;
	});
	check('a locale table saying "Verified" for a key is refused, not drawn',
		!/verif/i.test(guarded), `drew "${guarded}"`);

	// And the eight tables themselves, read from disk.
	const FORBIDDEN = {
		'en.js':      ['verified', 'unverified', 'trusted', 'untrusted'],
		'de.js':      ['verifiziert', 'vertrauenswürdig', 'vertraut'],
		'es.js':      ['verificado', 'verificada', 'confiable'],
		'fr.js':      ['vérifié', 'vérifiée', 'certifié', 'confiance'],
		'ja.js':      ['認証済', '検証済', '信頼'],
		'ko.js':      ['인증됨', '검증됨', '신뢰'],
		'pt-BR.js':   ['verificado', 'verificada', 'confiável'],
		'zh-Hans.js': ['已验证', '已认证', '可信', '信任'],
	};
	let offenders = [], defined = 0;
	for (const file of Object.keys(FORBIDDEN)) {
		const p = path.join(WWW, 'i18n', file);
		if (!fs.existsSync(p)) continue;
		for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
			if (!/'trust\.key_/.test(line)) continue;
			defined++;
			const low = line.toLowerCase();
			for (const w of FORBIDDEN[file]) {
				if (low.indexOf(w.toLowerCase()) >= 0) offenders.push(`${file}: ${line.trim()}`);
			}
		}
	}
	check('no locale table spells a key state with the other axis\'s word',
		offenders.length === 0,
		defined ? `${defined} key-state strings across the eight files` : 'none defined yet (Lane F)');

	console.log(`\n── I. Finding somebody by handle ${'─'.repeat(37)}`);
	// The gateway is STILL not running. What stands in for it is this script,
	// through the one door `sync.js` fetches with -- which is exactly the shape
	// of the thing the ceiling exists for: something in the middle, handing over
	// a card that verifies perfectly and proves nothing about who holds the key.
	const F = await device('trust-fern');
	const fCard = await F.page.evaluate(() => window.DaimondTrust.cardText());
	const fFp   = await F.page.evaluate(() => window.DaimondIdentity.fingerprint());
	await F.close();

	/// The base64 a gateway would serve, out of the string a paste carries.
	const served = (paste) => {
		const b64url = paste.replace(/^DMND-ID1\./i, '');
		return b64url.replace(/-/g, '+').replace(/_/g, '/')
			+ '='.repeat((4 - (b64url.length % 4)) % 4);
	};
	const bendCard = (b64) => {
		const bin = Buffer.from(b64, 'base64');
		bin[bin.length - 1] ^= 0x01;
		return bin.toString('base64');
	};

	/// Put a stand-in gateway behind `sync.js`, answering one handle.
	async function standIn(session, answers) {
		await session.page.evaluate((rows) => {
			const gw = window.DaimondGateway;
			window.__lookups = [];
			gw.state = () => ({ authed: true });
			if (typeof gw.clientApi !== 'function') gw.clientApi = () => 1;
			gw.gwFetch = async (path) => {
				window.__lookups.push(path);
				const m = /[?&]handle=([^&]+)/.exec(path);
				const want = m ? decodeURIComponent(m[1]) : '';
				const row = rows[want];
				if (!row) {
					return new Response(JSON.stringify({ ok: false, found: false }),
						{ status: 404, headers: { 'content-type': 'application/json' } });
				}
				return new Response(JSON.stringify(Object.assign({ ok: true, found: true }, row)),
					{ status: 200, headers: { 'content-type': 'application/json' } });
			};
		}, answers);
	}

	await standIn(A, {
		'quiet-fern-0001': { handle: 'quiet-fern-0001', fingerprint: fFp, card: served(fCard) },
		'bent-fern-0002':  { handle: 'bent-fern-0002',  fingerprint: fFp, card: bendCard(served(fCard)) },
		'other-fern-0003': { handle: 'other-fern-0003', fingerprint: 'AAAA-BBBB-CCCC-DDDD', card: served(fCard) },
		'quiet-mute-0004': { handle: 'quiet-mute-0004', fingerprint: fFp, card: '' },
	});

	const found = await A.page.evaluate(() => window.DaimondTrust.lookup('quiet-fern-0001')
		.then(r => ({ found: r.found, why: r.why || '', key: r.card && r.card.key,
			fp: r.card && r.card.fp, label: r.card && r.card.label })));
	check('a lookup returns a card that verifies', found.found && !!found.key,
		found.found ? found.fp : `why "${found.why}"`);
	check('and the key it carries is the key that person holds', found.key === F.key);

	const bent = await A.page.evaluate(() => window.DaimondTrust.lookup('bent-fern-0002')
		.then(r => ({ found: r.found, why: r.why || '' })));
	check('a tampered card is refused, not drawn', !bent.found && bent.why === 'bad',
		`found=${bent.found} why="${bent.why}"`);

	// The one check the card cannot make about itself: the account record and
	// the card have to be about ONE key, or the name and the key are two claims
	// about two different people wearing one row.
	const crossed = await A.page.evaluate(() => window.DaimondTrust.lookup('other-fern-0003')
		.then(r => ({ found: r.found, why: r.why || '' })));
	check('a card whose fingerprint is not the one served is refused',
		!crossed.found && crossed.why === 'bad', `why "${crossed.why}"`);

	const nocard = await A.page.evaluate(() => window.DaimondTrust.lookup('quiet-mute-0004')
		.then(r => ({ found: r.found, why: r.why || '' })));
	check('a name whose holder has published nothing says so', !nocard.found && nocard.why === 'nocard',
		`why "${nocard.why}"`);

	const missing = await A.page.evaluate(() => window.DaimondTrust.lookup('nobody-at-all-9z')
		.then(r => ({ found: r.found, why: r.why || '' })));
	check('a name nobody holds comes back 404, and reads as "no such name"',
		!missing.found && missing.why === 'none', `why "${missing.why}"`);
	const asked = await A.page.evaluate(() => window.__lookups.slice());
	check('every one of those went to /api/account?handle=',
		asked.length >= 5 && asked.every(u => /\/api\/account\?handle=/.test(u)),
		`${asked.length} requests`);

	// THE FINDER, DRAWN. Typed into the real field, pressed with the real button,
	// and then measured: a looked-up key must reach the screen as NEW and must
	// never be offered the in-person act.
	const drawnFind = await A.page.evaluate(async () => {
		try { window.DaimondSocial.open('people'); } catch (e) { /* no panel */ }
		await new Promise(r => setTimeout(r, 200));
		const host = document.getElementById('social-people-list');
		const field = host.querySelector('.trust-find input');
		const go    = host.querySelector('.trust-find button');
		if (!field || !go) return { seam: false };
		field.value = 'quiet-fern-0001';
		go.click();
		await new Promise(r => setTimeout(r, 600));
		const box  = host.querySelector('.trust-found');
		const line = box && box.querySelector('[data-key-state]');
		const name = box && box.querySelector('.trust-name, .trust-claim');
		const n = name && name.getBoundingClientRect();
		const l = line && line.getBoundingClientRect();
		return {
			seam:    true,
			state:   line && line.getAttribute('data-key-state'),
			words:   line && line.textContent,
			below:   !!(n && l) && l.top >= n.bottom - 1 && l.height > 0,
			digits:  box ? [...box.querySelectorAll('.trust-number span')].map(e => e.textContent) : [],
			buttons: box ? [...box.querySelectorAll('button')].map(b => b.textContent) : [],
		};
	});
	check('the People view carries a field for a handle', drawnFind.seam);
	check('a looked-up key is drawn NEW', drawnFind.state === 'new' && /new key/i.test(drawnFind.words || ''),
		drawnFind.words);
	check('and its line is under the name here too, like every other row', drawnFind.below);
	check('the sixty digits are on the result, not behind a second press',
		drawnFind.digits.length === 12 && drawnFind.digits.every(g => /^[0-9]{5}$/.test(g)),
		`${drawnFind.digits.length} groups`);
	check('the result offers no way to mark a key matched',
		!(drawnFind.buttons || []).some(b => /matched/i.test(b)),
		(drawnFind.buttons || []).join(' · '));

	const added = await A.page.evaluate(async () => {
		const host = document.getElementById('social-people-list');
		const box  = host.querySelector('.trust-found');
		const add  = box && [...box.querySelectorAll('button')][0];
		if (!add) return null;
		add.click();
		await new Promise(r => setTimeout(r, 500));
		return null;
	});
	void added;
	const inList = await A.page.evaluate(async (k) => {
		await window.DaimondTrust.refresh();
		const p = await window.DaimondTrust.person(k);
		return p ? { state: p.state, route: p.route, method: p.method } : null;
	}, F.key);
	check('"Add" puts them in People', !!inList, inList ? `state "${inList.state}"` : 'not there');
	check('and they are NEW, by the route they came in on',
		inList && inList.state === 'new' && inList.route === 'lookup' && !inList.method,
		inList ? `route "${inList.route}"` : '');

	// Decision 4, at the one place it could still be got wrong: a lookup must not
	// be able to reach the in-person offer even by being handed to the same door
	// the camera uses.
	const offered = await A.page.evaluate(async (text) => {
		const card = window.DaimondTrust.parse(text);
		await window.DaimondTrust.offer(card, window.DaimondTrust.ROUTE.LOOKUP);
		await new Promise(r => setTimeout(r, 200));
		const box = document.querySelector('.pair-scrim');
		const words = box ? [...box.querySelectorAll('button')].map(b => b.textContent) : [];
		const close = box && box.querySelector('button');
		if (close) close.click();
		return words;
	}, fCard);
	check('a card offered as a lookup is never offered "Mark matched now"',
		!offered.some(w => /matched/i.test(w)), offered.join(' · '));

	console.log(`\n── J. Send my code ${'─'.repeat(50)}`);
	// BOTH OF WHAT "Show my code" SHOWS, because that is what the two surfaces
	// must not drift apart on: the symbol is drawn from `cardUrl` and the
	// textarea from `cardText`, and "Send my code" used to hand over the second
	// alone. A string leaves the reader to find the app and press Add somebody;
	// a link opens the app with the card already loaded, and for somebody who
	// has never seen Daimond it opens Daimond.
	const sent = await A.page.evaluate(async () => {
		const grabbed = [];
		if (!navigator.clipboard) Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
		navigator.clipboard.writeText = async (t) => { grabbed.push(['clipboard', t]); };
		Object.defineProperty(navigator, 'share', {
			value: async (d) => { grabbed.push(['share', d.text]); }, configurable: true,
		});
		const url    = window.DaimondTrust.cardUrl();
		const shown  = window.DaimondTrust.cardText();
		const answer = await window.DaimondTrust.sendCard();
		return { url, shown, answer, grabbed };
	});
	const copied = (sent.grabbed.find(g => g[0] === 'clipboard') || [])[1];
	const shared = (sent.grabbed.find(g => g[0] === 'share') || [])[1];
	const lines  = String(copied || '').split('\n');
	check('"Send my code" hands over the LINK the symbol carries',
		!!copied && !!sent.url && lines[0] === sent.url,
		copied ? lines[0].slice(0, 36) + '…' : 'nothing reached the clipboard');
	check('with the string form on its own line under it',
		lines.length === 2 && lines[1] === sent.shown,
		`${lines.length} line(s)`);
	check('the share sheet is offered the same two lines, and nothing wrapped round them',
		shared === copied);
	check('and it answers with what it sent', sent.answer === copied);
	// WHAT THE RECIPIENT DOES WITH IT. The link alone, pasted by a device that
	// has never met this key, adds the person -- which is the whole claim the
	// link form makes over the string form. Read by S, a stranger to A.
	const byLink = await S.page.evaluate(async (url) => {
		const card = window.DaimondTrust.parse(url);
		if (!card) return null;
		await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.LINK);
		await window.DaimondTrust.refresh();
		const them = await window.DaimondTrust.person(card.key);
		return { key: card.key, listed: !!them, route: them ? them.route : '' };
	}, sent.url);
	check('pasting the link alone adds the person', !!byLink && byLink.key === A.key
		&& byLink.listed, byLink ? `route "${byLink.route}"` : 'the link did not parse');
	// And the whole payload pasted at once is the same card, not two halves or a
	// parse failure: somebody copying a message copies both lines.
	const bothLines = await S.page.evaluate(async (payload) => {
		const card = window.DaimondTrust.parse(payload);
		return card ? card.key : '';
	}, copied);
	check('and so does the whole payload, pasted as it arrives',
		bothLines === A.key, bothLines ? bothLines.slice(0, 16) + '…' : 'it did not parse');
	const button = await A.page.evaluate(() => {
		const host = document.getElementById('social-people-list');
		return [...host.querySelectorAll('.trust-acts button')].map(b => b.textContent);
	});
	check('the button sits beside "Show my code"',
		button.some(b => /show my code/i.test(b)) && button.some(b => /send my code/i.test(b)),
		button.join(' · '));

	console.log(`\n── H. Reachability ${'─'.repeat(50)}`);
	const tagged = await A.page.evaluate(async () => {
		const html = await (await fetch('/index.html')).text();
		return new RegExp('<script[^>]+src=["\']js/trust\\.js["\']').test(html);
	});
	check('index.html loads js/trust.js (Lane F)', tagged,
		tagged ? '' : 'NOT YET — everything above ran on an injected copy');
	const seam = await A.page.evaluate(() => ({
		social: !!window.DaimondSocial,
		host:   !!document.getElementById('social-people-list'),
		off:    (document.getElementById('social-people-off') || {}).hidden,
	}));
	check('the Social panel\'s People seam exists and was fed', seam.social && seam.host);
	check('the panel\'s empty line came down once rows were drawn', seam.off === true,
		`hidden=${seam.off}`);

	await shot(A, 'trust-people');
} finally {
	for (const s of [A, B, S]) {
		const errs = errors(s).filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
		if (errs.length) console.log(`  console errors (${s.name}):`, errs.slice(0, 5));
		await s.close();
	}
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAIL ' + b)); process.exit(1); }
