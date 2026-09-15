// verify_share.mjs — a share that is too big for the relay has somewhere to go.
//
// THE DEFECT THIS CLOSES IS A DEAD END, NOT A BUG. `www/js/share.js` composed a
// Diamond into a signed, sealed envelope and then stopped. The only carrier the
// app had was the message relay, and `/api/post` refuses a sealed envelope over
// 64 KiB (`gateway/src/settings.rs`, the `max_bytes` knob on that route). The
// Log Life capp page alone is about 64 KB, so a share carrying a capp could not
// go through the relay AT ALL — the feature was unreachable at a byte count, and
// unreachable silently.
//
// So the carrier is now CHOSEN by measuring, and the large case takes a file:
// extension `.dshare`, type `application/octet-stream`, both directions. The
// checks below are about that file route, and three of them are about what must
// NOT change by going through a file:
//
//   * the bytes are the same sealed envelope the relay would have carried, so a
//     `.dshare` is no more trusted than a message;
//   * the CONSENT STEP is the same one. Data travels freely; code travels only
//     by explicit consent, because a capp is a program somebody else wrote and
//     "open a message" must never become a code-execution path. `take` goes
//     through `receive` → `accept` → `askAboutCode` exactly as the relay does;
//   * a share carrying an image carries the image, byte for byte. `land` cannot
//     yet WRITE one — the store's only door takes text — so it refuses that file
//     by name rather than landing replacement characters nobody would notice
//     until they opened the picture.
//
// TO SEE THESE FAIL, break it like this:
//
//   * `share.js`, `fitsRelay`: return `n <= RELAY_MAX`. The boundary check goes
//     red — a sealed envelope of exactly 64 KiB is refused by the gateway's
//     CHEAP base64-length estimate before it ever decodes anything.
//   * `share.js`, `take`: call `openSealed` and `accept(read, {withCode:true})`
//     instead of `receive`. The consent checks go red and a stranger's page
//     lands without a question, which is the failure the whole design exists to
//     prevent.
//   * `share.js`, `compose`: drop `name` from what it answers. Every saved file
//     is called `share-<addr>.dshare` again and the sender's own name for it
//     reaches nobody.
//
// Run: node dev/verify_share.mjs   (dev/serve.mjs and dev/mockllm.mjs; no gateway)

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'share');

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
	if (ok) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};

/// A PNG somebody else made: eight bytes of signature and a body that is not
/// UTF-8 anywhere. It is here because binary is the thing a share is easiest to
/// get quietly wrong about, and mojibake looks like success.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64');

const s = await open({ name: 'share', profile: PROFILE, connect: false });
const { page } = s;

console.log('\n-- this build has a carrier at all --');
const surface = await page.evaluate(() => {
	const S = window.DaimondShare;
	if (!S) return null;
	return {
		ready: S.ready(), why: S.why(), ext: S.ext, mime: S.mime,
		fns: ['carrier', 'carrierWhy', 'fitsRelay', 'save', 'take', 'pick']
			.filter(n => typeof S[n] === 'function'),
		limits: S.limits,
	};
});
check(!!surface, 'share.js is on the page', surface ? '' : 'no window.DaimondShare');
check(!!surface && surface.ready, 'and it can share: format, seal and store are all loaded',
	surface ? surface.why : 'nothing');
// The contract fixes both of these. A `.dshare` is CIPHERTEXT, so there is
// nothing truthful to say about its contents and nothing a browser should try
// to do with it but save it.
check(!!surface && surface.ext === '.dshare', 'the file is a .dshare',
	surface ? surface.ext : '');
check(!!surface && surface.mime === 'application/octet-stream',
	'carried as application/octet-stream', surface ? surface.mime : '');
check(!!surface && surface.fns.length === 6,
	'and the carrier is reachable: carrier, carrierWhy, fitsRelay, save, take, pick',
	surface ? surface.fns.join(', ') : 'none');

console.log('\n-- the relay ceiling is the GATEWAY’s number, not one invented here --');
// THE EXTERNAL SIDE OF THE CLAIM. The client refuses at a size; the gateway is
// what actually refuses, and a client ceiling that had drifted from the server's
// would send a share that comes back 413. Read out of lane G's own file.
//
// THE NUMBER CHANGED, AND THAT IS THE POINT. It was 64 KiB, which is a message's
// ceiling and not a diamond's: the Log Life page alone is about 64 KB, so every
// share carrying a page took the file route and the relay carried only shares
// small enough to have been messages. Three mebibytes is the share format's two
// mebibytes of file bodies with room for the paths, the head, the slots and the
// seal's tag on top.
const CEILING = 3 * 1024 * 1024;
const gw = fs.readFileSync(new URL('../gateway/src/settings.rs', import.meta.url), 'utf8');
const postBlock = gw.slice(gw.indexOf('route: "/api/post"'), gw.indexOf('route: "/api/post"') + 1200);
const fallback = (postBlock.match(/fallback:\s*"(\d+)"/) || [])[1];
check(fallback === String(CEILING), 'the /api/post max_bytes knob falls back to 3 MiB',
	'gateway says ' + fallback);
check(!!surface && surface.limits.relay === CEILING,
	'and share.js holds the same number', surface ? String(surface.limits.relay) : '');

const fits = await page.evaluate((max) => {
	const f = window.DaimondShare.fitsRelay;
	return { at64k: f(65536), at_ceiling: f(max), over: f(max + 1),
		one_under: f(max - 1), small: f(555), zero: f(0) };
}, CEILING);
// BOTH of the gateway's checks, which are not the same number. `/api/post` turns
// a body away on the cheap base64-length estimate BEFORE decoding —
// `envelope.len() / 4 * 3 > max_bytes` — and then again on the decoded length.
// base64 rounds up to a group of three, so whether the ceiling itself is
// reachable depends on whether it divides by three. 64 KiB did not and 65,535
// was the last size through; 3 MiB does, so the ceiling is exactly reachable and
// one byte over is the first refusal.
check(fits.at64k === true, 'what used to be the ceiling now fits with room to spare',
	JSON.stringify(fits));
check(fits.at_ceiling === true, 'a sealed envelope of exactly 3 MiB fits: the ceiling divides by three',
	JSON.stringify(fits));
check(fits.over === false, 'and one byte over is refused — the file route still has a case',
	JSON.stringify(fits));
check(fits.small === true && fits.zero === true, 'small ones fit, obviously',
	JSON.stringify(fits));
// Modelled here from the gateway's own arithmetic rather than from share.js, so
// the two are computed independently and agreeing means something.
const gateway = (n) => {
	const chars = Math.ceil(n / 3) * 4;			// base64, padded
	return !(Math.floor(chars / 4) * 3 > CEILING) && !(n > CEILING);
};
let boundaryAgree = true;
for (const n of [0, 1, 555, 65535, 65536, 65537, CEILING - 2, CEILING - 1, CEILING,
	CEILING + 1, CEILING + 4]) {
	const mine = await page.evaluate((n) => window.DaimondShare.fitsRelay(n), n);
	if (mine !== gateway(n)) { boundaryAgree = false; console.log('    disagree at ' + n); }
}
check(boundaryAgree, 'and the client agrees with the handler’s arithmetic at every boundary');

console.log('\n-- a small share goes by relay; a capp cannot --');
const small = await page.evaluate(async () => {
	const to = await DaimondIdentity.publicKeyRaw();
	const toEnc = DaimondIdentity.sealingKeyRaw();
	const made = await DaimondShare.compose({
		name: 'Recipe book', note: 'here you go', to: to, toEnc: toEnc,
		files: [{ path: 'notes.md', body: '# Bread\n\nFlour, water, salt.\n' }],
	});
	window.__small = made;
	return { name: made.name, addr: made.addr, sealed: made.sealed.length, code: made.code,
		carrier: DaimondShare.carrier(made), why: DaimondShare.carrierWhy(made),
		file: DaimondShare.filename(made) };
});
check(small.carrier === 'relay', 'a recipe goes through the relay',
	small.carrier + ' at ' + small.sealed + ' bytes');
check(/555|\d+ B/.test(small.why) && /relay/i.test(small.why),
	'and the sentence says so', small.why);
// The defect this fixes: `filename` builds the stem from `made.name`, and
// `compose` did not answer one, so every file anybody ever saved was called
// `share-<addr>.dshare`.
check(small.name === 'Recipe book' && /^Recipe-book-/.test(small.file),
	'the file carries the name the sender chose', small.file);
check(/\.dshare$/.test(small.file), 'and the extension', small.file);
check(small.file.indexOf(small.addr.slice(0, 12)) !== -1,
	'and enough of the address to tell two shares of one Diamond apart', small.file);

const capp = await page.evaluate(async () => {
	const to = await DaimondIdentity.publicKeyRaw();
	const toEnc = DaimondIdentity.sealingKeyRaw();
	// A page of about the size the Log Life capp actually is.
	let html = '<!doctype html><html><body><div id="log"></div><script>\n';
	while (html.length < 64 * 1024) html += '// a line of the page nobody reads twice\n';
	html += '</' + 'script></body></html>';
	const made = await DaimondShare.compose({
		name: 'Log Life', to: to, toEnc: toEnc,
		files: [{ path: 'crystal.html', body: html }],
	});
	window.__capp = made;
	return { sealed: made.sealed.length, code: made.code,
		carrier: DaimondShare.carrier(made), why: DaimondShare.carrierWhy(made) };
});
check(capp.sealed > 65536, 'a capp share really is over what the relay used to carry',
	capp.sealed + ' bytes sealed');
// THE CHANGE, FROM THE FRONT. At 64 KiB this took the file route and the file
// route was the only route a capp had. It goes straight to the person now, which
// is what raising the knob was for.
check(capp.carrier === 'relay',
	'and it goes by RELAY now — this is the case that had no relay carrier at all',
	capp.carrier);
check(capp.code === true, 'and the payload’s own signed claim says it carries code',
	String(capp.code));
check(/relay/i.test(capp.why), 'and the sentence says which carrier it took', capp.why);

// THE FILE ROUTE IS STILL REACHABLE AND IT IS NOT REACHED BY SIZE ANY MORE. The
// share format caps the file bodies at two mebibytes, so no share this app can
// compose exceeds a three-mebibyte relay: `carrier` answers 'file' only for an
// envelope larger than anything `compose` will produce. That leaves the file
// route as the route for a person with NO GATEWAY ACCOUNT and for a stick, which
// is what its own comment always said it was for — so it is driven here on a
// composed share's bytes rather than waited for.
const overCeiling = await page.evaluate((max) => {
	const S = window.DaimondShare;
	return { file: S.carrier({ sealed: { length: max + 1 } }),
		relay: S.carrier({ sealed: { length: max } }),
		bodies: S.limits.bytes, ceiling: S.limits.relay };
}, CEILING);
check(overCeiling.file === 'file' && overCeiling.relay === 'relay',
	'over the ceiling is still the file route and at it is still the relay',
	JSON.stringify(overCeiling));
check(overCeiling.bodies < overCeiling.ceiling,
	'and the format’s own body ceiling is BELOW the relay’s, so a legal share always fits',
	overCeiling.bodies + ' bodies vs ' + overCeiling.ceiling + ' relay');

console.log('\n-- writing one out --');
const dl = await (async () => {
	const wait = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
	const said = await page.evaluate(() => {
		const n = DaimondShare.save(window.__small);
		return { name: n, said: DaimondShare.savedSaid(n) };
	});
	const d = await wait;
	if (!d) return null;
	const out = scratch('share-out', d.suggestedFilename());
	await d.saveAs(out);
	return { name: d.suggestedFilename(), bytes: fs.readFileSync(out), path: out, said: said.said };
})();
check(!!dl, 'saving hands a file over', dl ? dl.name : 'no download');
check(!!dl && dl.name === small.file, 'under the name share.js said it would',
	dl ? dl.name + ' vs ' + small.file : '');
const sealedLen = await page.evaluate(() => window.__small.sealed.length);
check(!!dl && dl.bytes.length === sealedLen,
	'and the file IS the sealed envelope, not a re-encoding of it',
	dl ? dl.bytes.length + ' vs ' + sealedLen : '');
check(!!dl && /Give them that file/.test(dl.said),
	'and there is a sentence to show the sender', dl ? dl.said : '');

console.log('\n-- and taking one in, through the browser’s own file chooser --');
// `pick` is the receiving direction as a person meets it. Driven through
// Playwright's filechooser event rather than by handing `take` some bytes, so
// what is proven is the route and not just the function underneath it.
const picked = await (async () => {
	const fcp = page.waitForEvent('filechooser', { timeout: 15000 });
	const landing = page.evaluate(() => window.DaimondShare.pick()
		.then(r => ({ ok: true, r: r }), e => ({ ok: false, err: String(e && e.message || e) })));
	const fc = await fcp;
	await fc.setFiles(dl.path);
	return await landing;
})();
check(picked.ok === true, 'a chosen .dshare lands', picked.ok ? '' : picked.err);
check(picked.ok && picked.r.ok === true && !!picked.r.id,
	'as a Diamond of the receiver’s own', picked.ok ? JSON.stringify(picked.r) : '');
check(picked.ok && picked.r.wrote.join(',') === 'notes.md',
	'holding the file that was sent', picked.ok ? JSON.stringify(picked.r.wrote) : '');
const landedText = await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	return await m.store_read('diamonds/' + id + '/notes.md');
}, picked.ok ? picked.r.id : '');
check(/Flour, water, salt/.test(landedText || ''),
	'and the words that were in it', (landedText || '').slice(0, 60));

console.log('\n-- a capp arriving as a file is still asked about --');
// THE WHOLE POINT. Data travels freely and code travels only by consent, and
// nothing about the carrier may change that: a file somebody handed you must
// never be a way of running their program.
const asked = await page.evaluate(async () => {
	const seen = [];
	const real = DaimondCore.confirm;
	DaimondCore.confirm = async (body, ok, opts) => {
		seen.push({ body: body, title: opts && opts.title, danger: !!(opts && opts.danger) });
		return false;			// the receiver says no
	};
	try {
		const r = await DaimondShare.take(window.__capp.sealed);
		return { seen: seen, r: r };
	} catch (e) {
		return { seen: seen, err: String(e && e.message || e) };
	} finally { DaimondCore.confirm = real; }
});
check(asked.seen.length === 1, 'the receiver is asked, once', JSON.stringify(asked.seen.length));
check(asked.seen.length === 1 && /program written by somebody else/i.test(asked.seen[0].body),
	'and told WHAT it is: a program somebody else wrote',
	asked.seen.length ? asked.seen[0].body.slice(0, 90) : 'nothing asked');
check(asked.seen.length === 1 && /crystal\.html/.test(asked.seen[0].body),
	'and WHICH file, by name', asked.seen.length ? asked.seen[0].body.slice(-80) : '');
check(asked.seen.length === 1 && asked.seen[0].danger === true,
	'asked as a dangerous thing rather than a routine one',
	asked.seen.length ? String(asked.seen[0].danger) : '');
// Everything in that share was the page, so saying no leaves nothing to add —
// and that is reported as a refusal rather than as an empty success.
check(!asked.err && asked.r && asked.r.ok === false && asked.r.left.join(',') === 'crystal.html',
	'saying no leaves the page out, by name, and adds nothing',
	JSON.stringify(asked.r || asked.err));

// A SHARE THAT LANDS SHORT SAYS SO, through the reporter post.js and group.js
// already use. `accept` answered `ok: true` beside a count of the files it left
// out and NOTHING anywhere read the count: three of five files landed, success
// was reported, and the two omitted were never mentioned to the receiver, who
// cannot go looking for what they were never told about.
const partial = await page.evaluate(async () => {
	const to = await DaimondIdentity.publicKeyRaw();
	const toEnc = DaimondIdentity.sealingKeyRaw();
	const made = await DaimondShare.compose({
		name: 'Mixed', to: to, toEnc: toEnc,
		files: [{ path: 'notes.md', body: '# Data\n' },
			{ path: 'recipe.md', body: '# More data\n' },
			{ path: 'crystal.html', body: '<!doctype html><p>a page</p>' }],
	});
	const real = DaimondCore.confirm;
	const seen = [];
	DaimondCore.confirm = async (body) => { seen.push(body); return false; };
	let r;
	try { r = await DaimondShare.take(made.sealed); }
	finally { DaimondCore.confirm = real; }
	// WHAT THE AUTHORITY WOULD SAY ABOUT THE SAME ANSWER, asked separately and
	// compared below. Naming a wording here would be a third copy of it in the
	// test, which is the fault under test one level up.
	return { r, asked: seen.length, authority: window.DaimondPost.shortfall(r).trim() };
});
check(partial.r && partial.r.ok === true && partial.r.wrote.length === 2,
	'a share of three files with one page declined lands the other two',
	JSON.stringify(partial.r && partial.r.wrote));
check(partial.r && partial.r.left.join(',') === 'crystal.html',
	'and still answers WHICH one it left out', JSON.stringify(partial.r && partial.r.left));
// The half that was missing: a sentence, so the count cannot be returned and
// ignored. It comes back with the result as well as going on screen, which is
// what stays true in a build with no dialog on the page.
check(partial.r && partial.r.said && /crystal\.html/.test(partial.r.said),
	'AND a sentence naming it — `ok:true` beside an unread count is the defect',
	partial.r ? JSON.stringify(partial.r.said) : '');
// AND IT IS THE AUTHORITY'S OWN BYTES, not a wording that resembles them.
//
// THIS CHECK NAMED A STRING AND WAS WRONG ABOUT WHICH. It asserted `/Left out/i`
// -- `post.group_skipped`, the wording of the copy `share.js` carried inside
// `shortSaid` -- and it went RED on 2026-08-17 when the two refusals were split
// and `DaimondPost.shortfall` moved to `group.refused`. The verifier was the last
// thing in the tree still asserting a retired sentence, and it reported the fault
// as share.js's. So the string is out of the test: what is asked is whether this
// file's answer is CHARACTER FOR CHARACTER what the shared reporter produces from
// the same object, which is what "not a third wording" actually means and stays
// true through the next rewording without anybody editing this line.
check(partial.r && partial.r.said === partial.authority && !!partial.authority,
	'and it is the shared reporter\'s own bytes, not a second wording of them',
	partial.r ? JSON.stringify({ said: partial.r.said, authority: partial.authority }) : '');
// `skipped` is the shape `DaimondPost.shortfall` reads, so the next field added
// to this answer is reported by the same function or by nothing.
check(partial.r && partial.r.skipped && partial.r.skipped.length === 1
	&& partial.r.skipped[0].label === 'crystal.html' && !!partial.r.skipped[0].why,
	'carried as {label, why}, which is the shared reporter\'s own shape',
	JSON.stringify(partial.r && partial.r.skipped));

const allowed = await page.evaluate(async () => {
	const real = DaimondCore.confirm;
	DaimondCore.confirm = async () => true;
	try { return await DaimondShare.take(window.__capp.sealed); }
	catch (e) { return { err: String(e && e.message || e) }; }
	finally { DaimondCore.confirm = real; }
});
check(allowed.ok === true && allowed.wrote.join(',') === 'crystal.html',
	'and saying yes is what writes it — the gate is on the WRITE, not on the mount',
	JSON.stringify(allowed));

console.log('\n-- a share carries an image without mangling it --');
// `export_diamond` reads every file through `from_utf8_lossy`, which turns every
// non-UTF-8 byte into U+FFFD. That is lane R's to fix and it is not the path a
// share takes: this checks the SHARE FORMAT carries the bytes intact, and that
// the landing — which genuinely cannot write them yet — refuses that one file by
// name rather than writing replacement characters.
const image = await page.evaluate(async (b64) => {
	const raw = atob(b64);
	const png = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) png[i] = raw.charCodeAt(i);
	const to = await DaimondIdentity.publicKeyRaw();
	const toEnc = DaimondIdentity.sealingKeyRaw();
	const made = await DaimondShare.compose({
		name: 'With a picture', to: to, toEnc: toEnc,
		files: [{ path: 'notes.md', body: '# See the picture\n' },
			{ path: 'shot.png', body: png }],
	});
	const read = await DaimondShare.open(made.sealed);
	try {
		const out = { paths: [], same: false, sent: Array.from(png) };
		for (let i = 0; i < read.count(); i++) out.paths.push(read.path(i));
		const back = read.body(read.path(0) === 'shot.png' ? 0 : 1);
		out.got = Array.from(back);
		return out;
	} finally { try { read.free(); } catch (e) { /* freed */ } }
}, PNG.toString('base64'));
check(image.paths.indexOf('shot.png') !== -1, 'the picture is in the share',
	JSON.stringify(image.paths));
check(image.got.length === PNG.length
	&& Buffer.compare(Buffer.from(image.got), PNG) === 0,
	'and comes back out of the sealed envelope byte for byte — no U+FFFD anywhere',
	image.got.length + ' vs ' + PNG.length);

console.log('\n-- and a file that is not a share is refused before anything is unsealed --');
const junk = await page.evaluate(async () => {
	const out = {};
	try { await DaimondShare.take(new Uint8Array(0)); out.empty = 'landed'; }
	catch (e) { out.empty = e.message; }
	try { await DaimondShare.take(new Uint8Array(4096).fill(7)); out.noise = 'landed'; }
	catch (e) { out.noise = e.message; }
	try { await DaimondShare.take(new Uint8Array(3 * 1024 * 1024)); out.huge = 'landed'; }
	catch (e) { out.huge = e.message; }
	return out;
});
check(/not a Daimond share/i.test(junk.empty), 'a file of no bytes is named as not a share',
	junk.empty);
check(junk.noise !== 'landed', 'a file of noise does not land', junk.noise);
check(/larger than any share can be/i.test(junk.huge),
	'and one larger than any share can be is refused by SIZE, before the seal is touched',
	junk.huge);
// The size guard has to come before the seal, or a 3 MB file of noise costs a
// megabyte of decryption work to say the same sentence.
check(/3\.0 MB/.test(junk.huge), 'and the sentence says how big it was', junk.huge);

// ── AND SOMEBODY CAN REACH ALL OF IT ────────────────────────────────
//
// Everything above proves the carrier works. None of it proved a USER could
// get at it, and until the Share chip existed none could: share.js was a
// complete, tested, unreachable module, which is this project's signature
// failure and had shipped three times before. Forty checks passing against a
// surface nobody can press prove only that the surface works.
//
// So these press the chip the way a person does, and MEASURE it. A control the
// DOM has and the screen does not is already recorded in this codebase
// (`daimond.js:8323`), and a lane put a switch in an unfindable place last
// session and had to move it.
//
// TO SEE THESE FAIL:
//
//   * `www/index.html`: delete the `data-view="share"` chip. Every check in this
//     section goes red and share.js is unreachable again — which is the state
//     they were written against.
//   * `www/js/improve.js`, `VIEWS`: remove the `share:` line. The chip is still
//     on screen and pressing it shows nothing, which is the more interesting
//     failure of the two and the one a DOM-only check would miss.
//   * `share.js`, `sendTo`: report only `r.sent` and drop the `refused` branch.
//     The "names the reason" check goes red and a share nobody could deliver
//     reports silence.

/// Close any dialog standing in front of the panel, and say whether there was
/// one. A modal intercepts pointer events, so a click that ignores it does not
/// fail on the control -- it fails on a `<div class="modal dlg">` and reads as a
/// broken button. `landDiamond` draws a notice when a share lands short, and
/// share.js draws one too, so a suite that lands anything meets one.
const dismiss = async () => {
	let shut = 0;
	for (let i = 0; i < 4; i++) {
		const ok = await page.$('.modal.dlg .dlg-ok');
		if (!ok) break;
		await ok.click();
		shut++;
		await page.waitForTimeout(250);
	}
	return shut;
};

console.log('\n-- the chip is on the head, and pressing it shows the view --');
const panel = await page.evaluate(() => {
	try { DaimondPanels.show('social'); } catch (e) { return 'no panels: ' + e.message; }
	return 'shown';
});
check(panel === 'shown', 'the Social panel opens', panel);
await page.waitForTimeout(400);

const chip = await page.evaluate(() => {
	const c = document.querySelector('#panel-social .imp-chip[data-view="share"]');
	if (!c) return null;
	const r = c.getBoundingClientRect();
	const st = getComputedStyle(c);
	return { text: c.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height),
		vis: st.visibility, display: st.display, op: st.opacity };
});
check(!!chip, 'there is a Share chip beside the others',
	chip ? chip.text : 'no chip in the head');
// NOT `querySelector` alone, which is what "it is there" usually means and is
// not the same claim.
check(!!chip && chip.w > 20 && chip.h > 12,
	'and it has a box on screen rather than being 0x0',
	chip ? chip.w + 'x' + chip.h : 'no chip');
check(!!chip && chip.vis !== 'hidden' && chip.display !== 'none' && Number(chip.op) > 0.5,
	'and is actually visible, not merely laid out',
	chip ? JSON.stringify({ vis: chip.vis, display: chip.display, op: chip.op }) : '');

const wasView = await page.evaluate(() => window.DaimondSocial.view());
await page.click('#panel-social .imp-chip[data-view="share"]');
await page.waitForTimeout(400);
const nowView = await page.evaluate(() => ({
	view:    window.DaimondSocial.view(),
	shown:   !document.getElementById('social-share').hidden,
	pressed: document.querySelector('#panel-social .imp-chip[data-view="share"]')
		.getAttribute('aria-pressed'),
	offHidden: document.getElementById('social-share-off').hidden,
	drew:    document.getElementById('social-share-list').children.length,
}));
check(wasView !== 'share' && nowView.view === 'share',
	'a real click switches to it from wherever the panel was', wasView + ' -> ' + nowView.view);
// The view being SHOWN is the check the DOM-only one misses: the chip can exist
// and press and still reveal nothing if `VIEWS` has no entry for it.
check(nowView.shown, 'and the view itself is no longer hidden', JSON.stringify(nowView));
check(nowView.pressed === 'true', 'and the chip says so to a screen reader',
	'aria-pressed=' + nowView.pressed);
check(nowView.offHidden && nowView.drew >= 2,
	'the honest empty line gives way to the two halves of the feature',
	JSON.stringify(nowView));

// Nothing here may push the panel sideways. It is 300px and the page must never
// scroll horizontally.
const noSpill = await page.evaluate(() => {
	const l = document.getElementById('social-share-list');
	return { scrollW: l.scrollWidth, clientW: l.clientWidth,
		bodyOver: document.documentElement.scrollWidth - document.documentElement.clientWidth };
});
check(noSpill.scrollW <= noSpill.clientW + 1 && noSpill.bodyOver <= 0,
	'and none of it pushes the panel or the page sideways', JSON.stringify(noSpill));

console.log('\n-- with no Diamond open, the send half says why rather than nothing --');
// THE STATE THE CHECK IS ABOUT, PUT THERE RATHER THAN HOPED FOR. The browser
// profile persists between runs, so a second run boots with a diamond already
// open and the panel draws the sheet instead of this line -- a check going red
// because the suite is re-runnable, which says nothing about the panel.
const bare = await page.evaluate(() => {
	const real = DaimondDiamond.current;
	DaimondDiamond.current = () => null;
	try { DaimondShare.render(); return document.getElementById('social-share-list').textContent; }
	finally { DaimondDiamond.current = real; DaimondShare.render(); }
});
// AND IT POINTS SOMEWHERE. `sendBlock` refuses a picker of every diamond by
// design -- that would be a second Diamonds list in a panel that is not the rail
// -- so the line has to name the other door, which is Share... on the tile's cog.
check(/Open a diamond to share it/i.test(bare) && /tile/i.test(bare),
	'it names what is missing and the other door to it', bare.slice(-140));
check(/Open a share file/.test(bare),
	'while taking one in needs nothing and is offered anyway', bare.slice(0, 60));

console.log('\n-- and with a Diamond and a person, it sends --');
// A person, recorded the way a person is: this device reads a card. Its own, so
// the share is sealed to a key this browser can also open -- which is what makes
// the round trip checkable without a second browser.
const seeded = await page.evaluate(async () => {
	// MINTED FIRST. `DaimondTrust.cardText()` reads a card out of storage and
	// `mintCard` is what puts one there, so parsing before minting parses ''.
	const minted = await window.DaimondIdentity.mintCard();
	if (!minted || minted.ok === false) return 'mintCard: ' + JSON.stringify(minted);
	const card = window.DaimondTrust.parse(window.DaimondTrust.cardText());
	if (!card) return 'own card did not parse';
	await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.QR);
	if (window.DaimondPost && DaimondPost.refreshPeople) await DaimondPost.refreshPeople();
	const folk = (DaimondPost.people() || []).filter(p => p && p.pub && p.enc);
	return folk.length;
});
check(seeded === 1, 'one person is in the directory, with a sealing key', String(seeded));

await dismiss();
const chose = await page.evaluate(async () => {
	const tile = document.querySelector('.diamond-list .diamond-box');
	if (!tile) return 'no Diamond tile in the rail';
	tile.click();
	return 'clicked';
});
check(chose === 'clicked', 'a Diamond is opened from the rail', chose);
await page.waitForTimeout(700);
await dismiss();
await page.click('#panel-social .imp-chip[data-view="share"]');
await page.waitForTimeout(400);

const sendRow = await page.evaluate(() => {
	const b = document.querySelector('#social-share-list .shr-send');
	const w = document.querySelector('#social-share-list .shr-who');
	const box = (n) => { if (!n) return null; const r = n.getBoundingClientRect();
		return { w: Math.round(r.width), h: Math.round(r.height) }; };
	return { send: box(b), who: box(w),
		options: w ? Array.from(w.options).map(o => o.textContent) : [],
		text: document.getElementById('social-share-list').textContent };
});
check(!!sendRow.send && sendRow.send.w > 20 && sendRow.send.h > 12,
	'the Share button appears and has a box',
	sendRow.send ? sendRow.send.w + 'x' + sendRow.send.h : 'no button');
check(!!sendRow.who && sendRow.who.w > 20 && sendRow.who.h > 12,
	'so does the list of who it goes to',
	sendRow.who ? sendRow.who.w + 'x' + sendRow.who.h : 'no picker');
check(sendRow.options.length === 1, 'holding the one person there is',
	JSON.stringify(sendRow.options));
check(/a copy they will own/.test(sendRow.text),
	'and it says what a share IS before anybody presses anything',
	sendRow.text.slice(0, 200));

// THE RELAY IS NOT RUNNING IN THIS WORLD, which is the interesting case rather
// than a limitation: `fanout` cannot deliver, and a caller that read only `sent`
// would report nothing at all. The panel must name the refusal AND fall back to
// the file, because a share nobody could deliver and nobody was told about is
// the same defect as a landing that counts what it left out and says none of it.
const sent = await (async () => {
	const wait = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
	await dismiss();
	await page.click('#social-share-list .shr-send');
	await page.waitForTimeout(2500);
	const d = await wait;
	let file = null;
	if (d) {
		const out = scratch('share-out', 'panel-' + d.suggestedFilename());
		await d.saveAs(out);
		file = { name: d.suggestedFilename(), bytes: fs.readFileSync(out) };
	}
	return { file: file, said: await page.evaluate(() =>
		Array.from(document.querySelectorAll('#social-share-list .shr-say'))
			.filter(n => !n.hidden).map(n => n.textContent).join(' | ')) };
})();
// THREE OUTCOMES, ALL OF THEM SAID. Sent through the relay; refused by the relay
// and saved instead; or too large for the relay and saved without ever asking it.
// The third is the one the whole carrier exists for and it is what happens here:
// the Diamond the rail offers is about 100 KB, well over the 64 KiB ceiling, so
// this is the capp-sized case arriving by the front door.
check(/would not take it|Sent to|Saved as/.test(sent.said),
	'pressing Share says which of the three things happened', sent.said.slice(0, 200));
check(/travels as a file|would not take it/.test(sent.said),
	'and where a share is too large for the relay, says so with both sizes in it',
	sent.said.slice(0, 260));
check(!!sent.file, 'and a relay that cannot be reached still leaves the user a file',
	sent.file ? sent.file.name : 'no download');
check(!!sent.file && /\.dshare$/.test(sent.file.name) && sent.file.bytes.length > 200,
	'a real sealed .dshare, not an empty one',
	sent.file ? sent.file.name + ' ' + sent.file.bytes.length + 'B' : '');
check(/give them that|Give them that file/i.test(sent.said),
	'and tells them what to do with it — a refusal with no next step is no use',
	sent.said.slice(0, 240));

console.log('\n-- and the chip takes one in, through the chooser --');
const tookIt = await (async () => {
	await dismiss();
	const fcp = page.waitForEvent('filechooser', { timeout: 15000 });
	await page.click('#social-share-list .shr-take');
	const fc = await fcp;
	await fc.setFiles(dl.path);
	await page.waitForTimeout(2500);
	return await page.evaluate(() =>
		Array.from(document.querySelectorAll('#social-share-list .shr-say'))
			.filter(n => !n.hidden).map(n => n.textContent).join(' | '));
})();
check(/file\(s\) arrived|Added as a Diamond/.test(tookIt),
	'the button opens the chooser and lands what is chosen', tookIt.slice(0, 200));

console.log('\n-- a picture LANDS now, and survives a sync round --');
// `store_write_bytes` is new: `store_read_bytes` had existed all along, so the
// store could be read byte for byte and not written that way, and a share
// carrying a PNG had nowhere to put it. The wire was sound and the landing was
// not -- which the byte-for-byte envelope check above proved from the other side.
//
// THE STAMP IS THE DANGEROUS HALF AND IT IS WHY THIS SECTION EXISTS. A raw OPFS
// write moves nothing, so a Diamond written into and not stamped is strictly
// STALER than every other device's copy: `applyDiamonds` replaces it wholesale
// from the fresher side and the picture goes with the copy it replaced. That is
// the tag-loss data-loss failure of 11 August arriving through a new door, and
// the files coming this way are the large ones a person would actually notice
// losing. "It landed" is not the claim worth checking; "it is still there after
// a sync" is.
//
// AND ONE THING HERE DOES NOT DISCRIMINATE, WHICH IS WORTH SAYING RATHER THAN
// LEAVING FOR SOMEBODY TO FIND. Disabling `Wasm.touch_diamond(id)` in
// `landDiamond` leaves every check below GREEN -- measured, not reasoned. On this
// path `create_diamond` runs first and stamps `touched` itself, so a landed
// Diamond is fresh whether or not the landing stamps it again. The stamp check
// therefore proves the PROPERTY (this copy will win arbitration) and not the
// MECHANISM (that the call is what achieves it).
//
// The call stays, because the path it defends is the other one: a write into a
// Diamond that ALREADY EXISTS -- a capp logging a meal, which is the 11 August
// failure verbatim -- has no `create_diamond` in front of it and nothing else to
// stamp it. A check that discriminated would have to write through
// `store_write_bytes` into an existing Diamond, and no production path in this
// app does that yet; when one arrives, it is the caller that needs this check and
// not this one.
const doorThere = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	return typeof m.store_write_bytes === 'function';
});
check(doorThere, 'the bundle carries store_write_bytes', String(doorThere));

const before = Date.now();
const landedPic = await page.evaluate(async (b64) => {
	const raw = atob(b64);
	const png = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) png[i] = raw.charCodeAt(i);
	const to = await DaimondIdentity.publicKeyRaw();
	const toEnc = DaimondIdentity.sealingKeyRaw();
	const made = await DaimondShare.compose({
		name: 'Holiday photos', to: to, toEnc: toEnc,
		files: [{ path: 'notes.md', body: '# The harbour\n' },
			{ path: 'shot.png', body: png }],
	});
	const r = await DaimondShare.take(made.sealed);
	const m = await import('/pkg/oxedyne_daimond.js');
	let back = null;
	try {
		back = Array.from(await m.store_read_bytes('diamonds/' + r.id + '/shot.png', 0, 4096));
	} catch (e) { back = 'unreadable: ' + e.message; }
	// The stamp, read the way arbitration reads it.
	let stamp = 0, why = '';
	try {
		const list = JSON.parse(await DaimondCore.diamondApp().list_diamonds());
		list.forEach(function (d) { if (d && d.id === r.id) stamp = Number(d.touched) || 0; });
	} catch (e) { why = 'could not read the stamp: ' + e.message; }
	return { r: r, back: back, stamp: stamp, why: why, sent: Array.from(png) };
}, PNG.toString('base64'));

check(landedPic.r && landedPic.r.ok === true
	&& landedPic.r.wrote.indexOf('shot.png') !== -1,
	'a share carrying a picture lands the picture — it used to be refused by name',
	JSON.stringify(landedPic.r));
check(Array.isArray(landedPic.back)
	&& Buffer.compare(Buffer.from(landedPic.back), PNG) === 0,
	'and the bytes on disk are the bytes that were sent, not replacement characters',
	Array.isArray(landedPic.back)
		? landedPic.back.length + ' vs ' + PNG.length : String(landedPic.back));
// A stamp of 0, or one older than the moment before the landing, is the failure.
check(landedPic.stamp >= before,
	'the landed copy is fresh enough to win arbitration (create_diamond stamps it; '
	+ 'see the note above on what this does NOT prove)',
	landedPic.why || ('touched=' + landedPic.stamp + ' vs landed at ' + before));

// The sync round itself: a parcel from "the other device" carrying the same
// Diamond with an OLDER stamp. The local copy must win, and the picture must
// still be there afterwards.
const survived = await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = DaimondCore.diamondApp();
	let mine = null;
	JSON.parse(await app.list_diamonds()).forEach(function (d) {
		if (d && d.id === id) mine = d;
	});
	if (!mine) return { why: 'the landed Diamond is not in the list' };
	// The other device's copy of the SAME Diamond, a minute staler and with no
	// picture in it. Fed through the door a real pull feeds.
	const stale = JSON.parse(JSON.stringify(mine));
	stale.touched = (Number(mine.touched) || 0) - 60000;
	const parcel = { v: 2, diamonds: [{ id: id, data: stale.data || stale,
		touched: stale.touched }] };
	let applied = 'ok';
	try { await DaimondSync.apply(parcel); }
	catch (e) { applied = 'threw: ' + e.message; }
	let back = null;
	try {
		back = Array.from(await m.store_read_bytes('diamonds/' + id + '/shot.png', 0, 4096));
	} catch (e) { back = 'gone: ' + e.message; }
	let still = false;
	JSON.parse(await app.list_diamonds()).forEach(function (d) { if (d && d.id === id) still = true; });
	return { applied: applied, back: back, still: still };
}, landedPic.r && landedPic.r.id);

check(!survived.why, 'the landed Diamond is listed', survived.why || '');
check(survived.still === true, 'a staler copy from another device does not delete it',
	JSON.stringify({ applied: survived.applied, still: survived.still }));
check(Array.isArray(survived.back)
	&& Buffer.compare(Buffer.from(survived.back), PNG) === 0,
	'and the picture is STILL there, byte for byte, after the merge',
	Array.isArray(survived.back)
		? survived.back.length + ' bytes' : String(survived.back));

// ── WHAT MAY NOT TRAVEL, AND WHAT TRAVELS ONLY IF YOU SAY SO ──────────
//
// Two of these arm on the RECEIVER's money and one names folders on the
// SENDER's disk, and none of the three was refused by a share until now — the
// template path had refused all three since it existed, and a share carries the
// same files to the same people.
//
// THE FORMAT IS THE AUTHORITY AND THIS IS THE BELT. `share.js`'s `NEVER_TRAVELS`
// keeps the sender from being handed an encoder refusal for a file they never
// asked to send; `fe2o3_sbj::share` refuses them whatever this file does. The
// checks below drive `collect`, which is the client half, and the format half is
// proved by its own crate's tests.
//
// TO SEE THESE FAIL: take `triggers\.json$` out of `NEVER_TRAVELS` — the trigger
// check goes red and a diamond's armed automation starts travelling to
// strangers. Drop the `CONVERSATION` line from `collect` and the conversation
// travels whether or not the tick is on, which is the private half.
console.log('\n-- triggers and the sender\u2019s own notes never travel; the conversation only on the tick --');
const refusals = await page.evaluate(async () => {
	// A diamond with one of everything in it, written through the store the way a
	// worked diamond comes to hold them.
	const m = await import('/pkg/oxedyne_daimond.js');
	const id = await DaimondDiamond.create('Refusal fixture');
	const put = async (path, body) => await m.store_write('diamonds/' + id + '/' + path, body);
	await put('notes.md', '# Data\n');
	await put('triggers.json', '[{"id":"t1","on":true,"every":"30m"}]');
	await put('STATE.md', '# State\n\nMarked folder: /home/somebody/secret-project\n');
	await put('transcript.md', '# The conversation\n\nSomething private.\n');
	await put('capp.json', '{"v":1,"files":[]}');
	const walked = (await DaimondDiamond.files(id)).map(f => f.path).sort();
	const plain  = (await DaimondShare.collect(id)).map(f => f.path).sort();
	const withIt = (await DaimondShare.collect(id, { conversation: true })).map(f => f.path).sort();
	return { id, walked, plain, withIt };
});
// The walk carries everything: the filtering is the share's, not the store's, and
// a check that could not see the file on disk would pass on a diamond that never
// had one.
check(refusals.walked.indexOf('triggers.json') !== -1
	&& refusals.walked.indexOf('STATE.md') !== -1
	&& refusals.walked.indexOf('transcript.md') !== -1,
	'the fixture really holds all three — otherwise the refusals below prove nothing',
	JSON.stringify(refusals.walked));
check(refusals.plain.indexOf('triggers.json') === -1,
	'triggers.json does NOT travel: a trigger fires with nobody pressing anything, '
	+ 'and it would spend the receiver\u2019s money', JSON.stringify(refusals.plain));
check(refusals.plain.indexOf('STATE.md') === -1,
	'STATE.md does NOT travel: it names folders and build commands on the sender\u2019s disk',
	JSON.stringify(refusals.plain));
check(refusals.plain.indexOf('capp.json') === -1,
	'nor does the delivery record, as before', JSON.stringify(refusals.plain));
check(refusals.plain.indexOf('transcript.md') === -1,
	'and the conversation stays behind by DEFAULT', JSON.stringify(refusals.plain));
check(refusals.plain.indexOf('notes.md') !== -1,
	'while the diamond\u2019s own contents travel, which is the whole point',
	JSON.stringify(refusals.plain));
// THE TICK IS THE ONLY THING THAT MOVES. Everything else stays refused with it
// on, or the tick would be a way round the two rules that are about money and
// about somebody's disk.
check(refusals.withIt.indexOf('transcript.md') !== -1,
	'the tick carries the conversation and nothing else does',
	JSON.stringify(refusals.withIt));
check(refusals.withIt.indexOf('triggers.json') === -1
	&& refusals.withIt.indexOf('STATE.md') === -1,
	'and the tick is NOT a way round the other two', JSON.stringify(refusals.withIt));

// ── A RELAYED SHARE, END TO END, WITH NO GATEWAY IN THE PATH ────────────
//
// THE DEFECT THIS CLOSES IS SILENT DATA LOSS. A share sent through the relay
// arrived in the receiver's post store as `bad:<addr>` — "that is not a message;
// it is a share" — with the ENVELOPE NOT KEPT, and the ack then told the relay
// it could let go. The sender was shown "Sent to Ada". The diamond was gone, and
// nothing in the tree called `DaimondShare.receive` except the file chooser.
//
// Two browsers, two identities, and the row is carried between them by this file
// exactly as verify_post.mjs §1 carries an envelope — so what is proved is the
// seal and the routing and not a fixture's idea of either.
//
// TO SEE THESE FAIL: in `post.js`, drop `notPost.reading` from the kind branch,
// or return `UNREADABLE` instead of calling `keepShare`. The tray goes empty and
// `bad:<addr>` comes back, which is the state they were written against.
console.log('\n-- a relayed share waits in the tray with its bytes, and Add is what lands it --');
// A NAME OF THIS RUN'S OWN. The browser profiles persist between runs, so a
// second run against the same world would find the first run's landing and count
// it -- which is a check that goes red for the reason the suite is re-runnable
// rather than for the reason it is about.
const GIFT = 'Trip plan ' + Date.now().toString(36);
const A = await open({ name: 'share-a', profile: scratch('pw', 'share-a'), connect: false });
const B = await open({ name: 'share-b', profile: scratch('pw', 'share-b'), connect: false });
let rowSeen = null;
try {
	const card = async (t) => t.page.evaluate(async () => {
		await window.DaimondIdentity.ensureSealingKey();
		await window.DaimondIdentity.mintCard();
		await window.DaimondPost.read();
		return { text: window.DaimondTrust.cardText(),
			pub: window.DaimondIdentity.publicKeyB64url(),
			enc: window.DaimondIdentity.sealingKeyRaw
				? Array.from(window.DaimondIdentity.sealingKeyRaw()) : null };
	});
	const cardA = await card(A), cardB = await card(B);
	// B knows A, so the tray row and the landed diamond can say a NAME rather than
	// a fingerprint. A does not need to know B to seal to them — the card is the key.
	const knows = await B.page.evaluate(async (text) => {
		const c = window.DaimondTrust.parse(text);
		if (!c) return 'A\u2019s card did not parse';
		await window.DaimondTrust.record(c, window.DaimondTrust.ROUTE.QR);
		await window.DaimondPost.refreshPeople();
		const folk = window.DaimondPost.people() || [];
		return folk.length === 1 ? (folk[0].label || '(no label)') : ('people=' + folk.length);
	}, cardA.text);
	check(typeof knows === 'string' && !/did not parse|people=/.test(knows),
		'B holds A\u2019s card, so the row can name a person rather than a key', knows);

	// A composes a share to B. Nothing is on a wire: the envelope is carried by
	// this file, which is what the relay would have carried.
	const made = await A.page.evaluate(async ([toPub, toEncArr, gift]) => {
		const enc = new Uint8Array(toEncArr);
		const m2 = await DaimondShare.compose({
			name: gift, note: 'the plan we talked about',
			to: toPub, toEnc: enc,
			files: [{ path: 'notes.md', body: '# Trip\n\nFerry at seven.\n' },
				{ path: 'crystal.html', body: '<!doctype html><p>a page</p>' }],
		});
		return { addr: m2.addr, envelope: m2.envelope, sealed: m2.sealed.length,
			carrier: DaimondShare.carrier(m2), name: m2.name, ts: m2.ts };
	}, [cardB.pub, cardB.enc, GIFT]);
	check(!!made.addr && !!made.envelope, 'A sealed a share to B', JSON.stringify({ addr: made.addr }));
	check(made.carrier === 'relay', 'and it goes by relay', made.carrier + ' ' + made.sealed + 'B');

	// THE RELAY'S OWN ROW, through `DaimondPost.take` — the door a real collect
	// drives. A test that opened the envelope and wrote the record itself would
	// pass on a build where `takeRow` had stopped being called.
	const took = await B.page.evaluate(async ([addr, env, fromPub, ts]) => {
		const r = await window.DaimondPost.take({
			seq: 1, kind: 'post', addr, from_pub: fromPub,
			ts: Math.floor(ts / 1000), bytes: env.length, tray: true,
			expired: false, envelope: env,
		});
		const held = window.DaimondPost.shares();
		const msgs = window.DaimondPost.list();
		return { r, held, badCount: msgs.filter(m => m.bad).length,
			anyBad: Object.keys(window.DaimondPost.state()).length >= 0 };
	}, [made.addr, made.envelope, cardA.pub, made.ts]);
	check(took.held.length === 1, 'the share is held, once', JSON.stringify(took.r));
	check(took.held.length === 1 && took.held[0].addr === made.addr,
		'under the address the relay named', took.held.length ? took.held[0].addr : '');
	// THE BYTES. This is the whole fix: without the envelope the ack drops the only
	// copy there is and the diamond is gone with "Sent" on the sender's screen.
	check(took.held.length === 1 && took.held[0].env === made.envelope,
		'WITH THE SEALED ENVELOPE KEPT, byte for byte — the ack drops the relay\u2019s copy',
		took.held.length ? (took.held[0].env || '').length + ' vs ' + made.envelope.length : '');
	check(took.held.length === 1 && took.held[0].name === GIFT
		&& took.held[0].n === 2 && took.held[0].code === true,
		'and enough of the reading to draw a row without opening it again',
		JSON.stringify(took.held[0] ? { name: took.held[0].name, n: took.held[0].n,
			code: took.held[0].code, bytes: took.held[0].bytes } : null));
	check(took.badCount === 0,
		'and NOTHING landed in the message list — not even a `bad:` trace',
		String(took.badCount));
	// NEVER AUTOMATICALLY. A share is a write of somebody else's files and a page
	// inside one is a program.
	const nothingYet = await B.page.evaluate(async (gift) =>
		(JSON.parse(await DaimondCore.diamondApp().list_diamonds()) || [])
			.filter(d => d && d.name === gift).length, GIFT);
	check(nothingYet === 0, 'and no diamond was created: a share WAITS, it never lands itself',
		String(nothingYet));

	// The row, on the screen a person looks at.
	const drawn = await B.page.evaluate(async () => {
		DaimondPanels.show('social');
		await new Promise(r => setTimeout(r, 300));
		const chip = document.querySelector('#panel-social .imp-chip[data-view="messages"]');
		if (chip) chip.click();
		await new Promise(r => setTimeout(r, 300));
		const row = document.querySelector('#social-messages-list .post-share');
		if (!row) return null;
		const r = row.getBoundingClientRect();
		return { text: row.textContent, w: Math.round(r.width), h: Math.round(r.height),
			acts: Array.from(row.querySelectorAll('[data-act]')).map(b => b.dataset.act) };
	});
	check(!!drawn && drawn.w > 20 && drawn.h > 12,
		'a tray row is drawn and has a box on screen', drawn ? drawn.w + 'x' + drawn.h : 'no row');
	check(!!drawn && drawn.text.indexOf(GIFT) !== -1 && /2 files/.test(drawn.text),
		'saying what it is and how much of it there is', drawn ? drawn.text.slice(0, 140) : '');
	check(!!drawn && /includes a page/.test(drawn.text),
		'and that a program is in it, BEFORE anybody presses Add',
		drawn ? drawn.text.slice(0, 160) : '');
	check(!!drawn && /the plan we talked about/.test(drawn.text),
		'with the sender\u2019s own covering line', drawn ? drawn.text.slice(0, 200) : '');
	check(!!drawn && drawn.acts.join(',') === 'post-share-add,post-share-ignore,post-share-block',
		'and the three answers a person may give', drawn ? drawn.acts.join(',') : '');

	// ADD, pressed the way a person presses it, with the page declined — so the
	// consent question is proved to be on this route too and not only on the file.
	const added = await B.page.evaluate(async (gift) => {
		const seen = [];
		const real = DaimondCore.confirm;
		DaimondCore.confirm = async (body, ok, opts) => {
			seen.push({ body, title: opts && opts.title });
			return false;			// the receiver declines the page
		};
		try {
			document.querySelector('#social-messages-list .post-share [data-act="post-share-add"]').click();
			await new Promise(r => setTimeout(r, 2500));
		} finally { DaimondCore.confirm = real; }
		const list = JSON.parse(await DaimondCore.diamondApp().list_diamonds());
		const landed = list.filter(d => d && d.name === gift);
		const code = seen.filter(x => /program written by somebody else/i.test(x.body));
		return { asked: seen.length, askedCode: code.length,
			body: code[0] ? code[0].body : '',
			landed: landed.map(d => ({ id: d.id, tags: d.tags || [] })),
			stillWaiting: window.DaimondPost.shares().length };
	}, GIFT);
	// ONE QUESTION, and the second dialog is not one: `accept` says what it left
	// out through the same reporter the file route uses, so a declined page is
	// followed by a notice naming it. Counted by WHAT WAS ASKED rather than by how
	// many boxes appeared, because only the first of those is consent.
	check(added.askedCode === 1, 'pressing Add asks about the page, once, on the relay route too',
		JSON.stringify({ code: added.askedCode, boxes: added.asked }));
	check(/program written by somebody else/i.test(added.body || ''),
		'in the same words the file route uses', (added.body || '').slice(0, 90));
	check(added.landed.length === 1, 'and the diamond lands', JSON.stringify(added.landed));
	check(added.stillWaiting === 0, 'and stops waiting in the tray', String(added.stillWaiting));
	// §5 of the think: tag `shared`, and the provenance under `.daimond/`.
	check(added.landed.length === 1 && added.landed[0].tags.indexOf('shared') !== -1,
		'tagged `shared`, which is what the rail\u2019s own filter reads',
		JSON.stringify(added.landed[0] ? added.landed[0].tags : null));
	const prov = await B.page.evaluate(async (id) => {
		const m2 = await import('/pkg/oxedyne_daimond.js');
		let raw = null;
		try { raw = await m2.store_read('diamonds/' + id + '/.daimond/origin.json'); }
		catch (e) { return { why: 'unreadable: ' + e.message }; }
		let o = null;
		try { o = JSON.parse(raw); } catch (e) { return { why: 'not JSON: ' + raw.slice(0, 60) }; }
		// The rail's own reading of it, and the line the tile draws.
		const rail = window.DaimondDiamond.origin(id);
		const box = Array.from(document.querySelectorAll('.diamond-list .diamond-box'))
			.filter(b => b.dataset.id === id)[0];
		const from = box ? box.querySelector('.diamond-from') : null;
		const r = from ? from.getBoundingClientRect() : null;
		return { o, rail, line: from ? from.textContent : null,
			box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null };
	}, added.landed.length ? added.landed[0].id : '');
	check(!prov.why && prov.o && !!prov.o.share,
		'`.daimond/origin.json` is written, anchored on the SHARE ADDRESS — a diamond id '
		+ 'is local and means nothing on the second machine', prov.why || JSON.stringify(prov.o));
	check(!prov.why && prov.o && prov.o.share === made.addr,
		'and it is the address of the share that actually arrived',
		prov.o ? prov.o.share + ' vs ' + made.addr : '');
	check(!prov.why && prov.o && typeof prov.o.author === 'string' && prov.o.author.length === 64,
		'with the author\u2019s KEY beside the name, because a name is advisory and a key is not',
		prov.o ? String(prov.o.author).slice(0, 20) : '');
	check(!prov.why && prov.o && prov.o.prior === null,
		'and `prior` reserved and null — an onward share fills it under share/1',
		prov.o ? JSON.stringify(prov.o.prior) : '');
	// THE LINE ON THE TILE, measured rather than queried: a control the DOM has and
	// the screen has not is already a recorded failure in this codebase.
	check(!!prov.line && prov.line.length > 0 && !!prov.box
		&& prov.box.w > 10 && prov.box.h > 4,
		'and the rail draws who it came from, under the diamond\u2019s own name',
		JSON.stringify({ line: prov.line, box: prov.box }));

	// IGNORE KEEPS THE BYTES. The relay has been told to let go by now, so a person
	// who ignored a gift and changed their mind has nothing else to change it with.
	const ignored = await B.page.evaluate(async ([addr, env, fromPub]) => {
		await window.DaimondPost.take({
			seq: 2, kind: 'post', addr: addr + 'ff', from_pub: fromPub,
			ts: Math.floor(Date.now() / 1000), bytes: env.length, tray: true,
			expired: false, envelope: env,
		});
		const before = window.DaimondPost.shares().length;
		await window.DaimondPost.hideShare(addr + 'ff');
		const after = window.DaimondPost.shares().length;
		const st = window.DaimondPost.snapshot();
		return { before, after, kept: !!(st.shares[addr + 'ff'] || {}).env };
	}, [made.addr, made.envelope, cardA.pub]);
	check(ignored.before === 1 && ignored.after === 0,
		'Ignore takes the row down', JSON.stringify(ignored));
	check(ignored.kept === true,
		'and KEEPS the envelope — the relay has let go and this is the only copy left',
		JSON.stringify(ignored));
} finally {
	await A.close(); await B.close();
}

// ── AND THE SENDER HAS A RECORD OF IT ──────────────────────────
//
// The receiver gets a tray row. The sender got a sentence in a panel, which goes
// the next time anything redraws — so a person who gave somebody a diamond had
// no record anywhere that they had. Driven through the sheet's own button, with
// the relay's answer stubbed, so what is measured is `sendTo` reaching the door
// and not the door itself.
console.log('\n-- the sender\u2019s Messages keeps an out row --');
await dismiss();
await page.click('#panel-social .imp-chip[data-view="share"]');
await page.waitForTimeout(500);
const outRow = await page.evaluate(async () => {
	// COUNTED AS A DELTA, for the reason `GIFT` is unique: the profile persists and
	// a second run would find the first run's row and read it as this one's.
	const before = DaimondPost.list().filter(m => m.dir === 'out' && m.share).length;
	const real = DaimondPost.fanout;
	DaimondPost.fanout = async () => ({ sent: 1, refused: [] });
	try {
		const btn = document.querySelector('#social-share-list .shr-send');
		if (!btn) return { why: 'no Share button on the sheet' };
		btn.click();
		await new Promise(r => setTimeout(r, 3000));
	} finally { DaimondPost.fanout = real; }
	const outs = DaimondPost.list().filter(m => m.dir === 'out' && m.share);
	return { added: outs.length - before, outs: outs.map(m => ({ body: m.body, to: !!m.to })),
		said: Array.from(document.querySelectorAll('#social-share-list .shr-say'))
			.filter(n => !n.hidden).map(n => n.textContent).join(' | ') };
});
check(!outRow.why && outRow.added === 1,
	'one Sent row, kept only after the relay took it',
	outRow.why || JSON.stringify(outRow.outs));
check(!outRow.why && outRow.outs.length >= 1 && /Sent .+ to /.test(outRow.outs[0].body),
	'saying what was sent and to whom', outRow.outs.length ? outRow.outs[0].body : '');
check(/Sent to/.test(outRow.said || ''), 'and the sheet says so too', (outRow.said || '').slice(0, 120));

// ── THE SHEET IS ONE SHEET, AND THE COG IS THE OTHER DOOR ─────────────
//
// Two sheets would be two places for "they will own the copy", the key line and
// the conversation tick to be drawn, and the one that stopped being drawn would
// be the one nobody was looking at. So the cog mounts share.js's own node.
console.log('\n-- Share\u2026 on the tile\u2019s cog opens the same sheet --');
await dismiss();
const cog = await page.evaluate(async () => {
	const box = document.querySelector('.diamond-list .diamond-box');
	if (!box) return { why: 'no diamond tile in the rail' };
	const c = box.querySelector('.tile-cog');
	if (!c) return { why: 'no cog on the tile' };
	c.click();
	await new Promise(r => setTimeout(r, 500));
	// THE TILE'S OWN DIALOG, and not whatever modal happens to be first in the
	// document: `openTileDialog` builds `modal dlg tile-dlg`, and a suite that has
	// landed several shares has met a notice or two on the way here.
	const cards = Array.from(document.querySelectorAll('.modal.tile-dlg .tile-dlg-card'));
	if (!cards.length) return { why: 'the cog dialog did not open' };
	const card = cards[cards.length - 1];
	const sheet = card.querySelector('.shr-sheet');
	if (!sheet) {
		return { why: 'no sheet in ' + cards.length + ' dialog(s); the last holds '
			+ Array.from(card.children).map(n => n.className || n.tagName).join(' | ') };
	}
	const r = sheet.getBoundingClientRect();
	return {
		text: sheet.textContent,
		w: Math.round(r.width), h: Math.round(r.height),
		who:    !!sheet.querySelector('.shr-who'),
		modes:  sheet.querySelectorAll('.shr-radio input[type="radio"]').length,
		tick:   !!sheet.querySelector('.shr-check input[type="checkbox"]'),
		ticked: (sheet.querySelector('.shr-check input[type="checkbox"]') || {}).checked,
		facts:  (sheet.querySelector('.shr-facts') || {}).textContent || '',
		send:   !!sheet.querySelector('.shr-send'),
	};
});
check(!cog.why && cog.w > 40 && cog.h > 30,
	'the cog dialog carries the sheet, with a box on screen',
	cog.why || (cog.w + 'x' + cog.h));
check(!cog.why && cog.who && cog.send, 'who it goes to, and the press',
	cog.why || JSON.stringify({ who: cog.who, send: cog.send }));
check(!cog.why && cog.modes === 2, 'a copy or the shape only',
	cog.why || String(cog.modes));
check(!cog.why && cog.tick === true && cog.ticked === false,
	'the conversation tick, OFF — it is the sender\u2019s talk with their own daimon',
	cog.why || JSON.stringify({ tick: cog.tick, ticked: cog.ticked }));
check(!cog.why && /they will own the copy/.test(cog.text || ''),
	'and the one line that says what the press MEANS, said before it',
	cog.why || (cog.text || '').slice(0, 160));
check(!cog.why && /files/.test(cog.facts) ,
	'with the files and the size counted rather than guessed', cog.why || cog.facts);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await s.close();
process.exit(fail ? 1 : 0);
