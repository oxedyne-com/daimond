// dev/verify_feed.mjs -- the followers-only feed, client side: the wire it speaks,
// the screens it draws, and the three things it must never say.
//
// THE WIRE IS MOCKED AND SAID TO BE MOCKED. The gateway half of this feature is
// another lane's and is not built yet; every request below is answered by this
// file, on the contract that lane published (feed plan §2-§3). So nothing here is
// evidence that the gateway does any of it -- it is evidence that THIS CLIENT
// asks for exactly what the contract says, draws exactly what comes back, and
// keeps nothing it should not. The real-gateway run happens at integration.
//
// What is proved, and each of them is a thing that goes wrong silently:
//
//   1. A FOLLOW IS ASKED FOR ONCE AND ANSWERED IN THE TRAY. The request carries
//      the author's public key and nothing else; the relay row is drawn in the
//      tray with three buttons and NEVER in the message list; Approve reaches the
//      relay and IGNORE REACHES IT IN NO WAY AT ALL.
//   2. A BLOCK IS NOT INFERRABLE. The gateway answers a request identically
//      whether it stored it, deduped it or dropped it, so no screen and no cached
//      state here may say anything but "asked".
//   3. THE BADGE COUNTS WHAT NOBODY HAS LOOKED AT. A cadence read with the panel
//      shut lights it; drawing the rows on a view with real area clears it; a
//      hidden view clears nothing.
//   4. THE CADENCE MARK MOVES ONLY ON A COMPLETE PAGE. `more:true` means there
//      were rows above the mark that did not fit, and advancing past them once
//      loses them for ever.
//   5. NOTHING IS CACHED BUT IDS. A post its author deleted leaves nothing behind
//      on the follower's device -- which is what makes a deletion mean anything
//      on a feed the operator can read.
//   6. A REPORT ABOUT A POST CARRIES NO EVIDENCE. `{post:{author,id}, reason}`
//      and not one byte more: the operator holds the words already, and a client
//      that uploaded an artefact here would be inventing a ceremony.
//   7. THE WORDS NEVER SAY PUBLIC. Eight locales, and none of them promises an
//      audience this feature does not have.
//
// Proved against broken code first:
//
//   node dev/verify_feed.mjs --break nobadge        # 4  nothing announces an arrival
//   node dev/verify_feed.mjs --break sinceahead     # 5  the mark moves on a partial page
//   node dev/verify_feed.mjs --break blockinferred  # 1  a refusal is drawn as one
//
//   node dev/verify_feed.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');
const I18N = path.join(WWW, 'i18n');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The breaks ───────────────────────────────────────────────────────
//
// Each is a real edit to a real source file, served in place of it.
const BREAKS = {
	// Nothing says a post landed. The read still happens and the record is still
	// right, which is the point: this is the check that tells "it arrived" from
	// "somebody was told it arrived".
	nobadge: [{
		file: 'js/feed.js',
		find: '\t\t\twindow.dispatchEvent(new CustomEvent(ARRIVED, {',
		with: '\t\t\tif (true) return 0;\n\t\t\twindow.dispatchEvent(new CustomEvent(ARRIVED, {',
	}],
	// The mark moves on a page that said there was more above it. Everything else
	// about the read stays right, and the rows it steps over are simply never
	// fetched again.
	sinceahead: [{
		file: 'js/feed.js',
		find: '\t\tif (!got.more) await DaimondPost.feedSince(newest);',
		with: '\t\tawait DaimondPost.feedSince(newest);',
	}],
	// A block becomes visible: the relay's answer is read for a field that says
	// whether the request was stored, and the row draws it. Two edits, because
	// the oracle only exists if the transport passes it up.
	blockinferred: [
		{
			file: 'js/post.js',
			find: "\t\t\treturn { ok: false, status: r.status | 0,\n"
				+ "\t\t\t\twhy: (r.json && r.json.reason) || 'status_' + r.status };\n"
				+ '\t\t}\n\t\treturn { ok: true };',
			with: "\t\t\treturn { ok: false, status: r.status | 0,\n"
				+ "\t\t\t\twhy: (r.json && r.json.reason) || 'status_' + r.status };\n"
				+ '\t\t}\n\t\treturn { ok: true, blocked: r.json.blocked === true };',
		},
		{
			file: 'js/feed.js',
			find: "\t\t\tif (action === 'request') _follow[String(pub)] = 'requested';",
			with: "\t\t\tif (action === 'request') _follow[String(pub)] = r.blocked ? 'blocked' : 'requested';",
		},
	],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// One edit, or a hard stop. An anchor that is not there exactly once changed
/// nothing, and the run below would prove the opposite of what it claims.
function edit(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} time(s) in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// ONE BODY PER FILE: Playwright hands a request to the last route registered
/// for its URL, so a two-edit break registered twice ships only its second edit.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, edit(src, spec));
	}
	return byFile;
}
const served = damagedFiles();

const routeBreaks = async (pg) => {
	if (!BREAK) return;
	for (const [file, body] of served) {
		const at = file === 'index.html'
			? (u) => u.pathname === '/' || u.pathname === '/index.html'
			: '**/' + file;
		await pg.route(at, r => r.fulfill({
			status: 200,
			contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript',
			body,
		}));
	}
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── A relay in the test, so the requests can be watched ──────────────

/// Install a mock relay, a mock report door and the state both answer out of.
///
/// The state object is handed back and is MUTATED by the sections below: one
/// browser per party for the whole run, with the gateway's answers changed under
/// it, which is what a real session looks like from the client's side.
async function mockWire(s, cfg = {}) {
	const log = [];
	const st = {
		merged: [], mine: [], followers: [], pending: [], following: [], collect: [],
		more: false, feedStatus: 200, feedReason: 'not_following',
		postStatus: 200, postReason: 'too_long', postAnswer: {},
		followAnswer: { ok: true }, handle: 'amber-fox-9k2q',
		...cfg,
	};
	const json = (route, status, obj) => route.fulfill({
		status, contentType: 'application/json', body: JSON.stringify(obj) });

	await s.page.route('**/api/post*', async (route) => {
		const req  = route.request();
		const url  = new URL(req.url());
		const op   = url.searchParams.get('op') || '';
		const view = url.searchParams.get('view') || '';
		const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
		if (req.method() === 'GET' && url.searchParams.has('above')) {
			log.push({ what: 'park' });
			return json(route, 200, { ok: true, waited: true, seq: 0, changed: false });
		}
		if (req.method() === 'GET' && view === 'feed') {
			const author = url.searchParams.get('author') || '';
			const since  = Number(url.searchParams.get('since') || 0);
			log.push({ what: author ? 'feed-author' : 'feed-merged', since, author });
			if (st.feedStatus !== 200) {
				return json(route, st.feedStatus, { ok: false, reason: st.feedReason, error: 'no' });
			}
			if (author) {
				return json(route, 200, { ok: true, mine: true, handle: author,
					rows: st.mine.filter(r => r.ts > since), more: false,
					followers: st.followers.length, pending: st.pending.length });
			}
			return json(route, 200, { ok: true, mine: false,
				rows: st.merged.filter(r => r.ts > since), more: !!st.more });
		}
		if (req.method() === 'GET' && view === 'followers') {
			log.push({ what: 'followers' });
			return json(route, 200, { ok: true, approved: st.followers, pending: st.pending });
		}
		if (req.method() === 'GET' && view === 'following') {
			log.push({ what: 'following' });
			return json(route, 200, { ok: true, authors: st.following });
		}
		if (req.method() === 'GET') {
			const since = Number(url.searchParams.get('since') || 0);
			const rows  = st.collect.filter(r => (r.seq | 0) > since);
			log.push({ what: 'collect', since });
			return json(route, 200, { ok: true,
				seq: rows.length ? rows[rows.length - 1].seq : since, rows, more: false });
		}
		log.push({ what: op || 'deliver', body });
		if (op === 'feed') {
			if (st.postStatus !== 200) {
				return json(route, st.postStatus, { ok: false, reason: st.postReason, error: 'no' });
			}
			return json(route, 200, { ok: true, id: 7, ts: 1700, followers: 12, ...st.postAnswer });
		}
		if (op === 'feed_delete') return json(route, 200, { ok: true, deleted: true });
		if (op === 'follow')      return json(route, 200, st.followAnswer);
		if (op === 'connect')     return json(route, 200, { ok: true });
		if (op === 'ack')         return json(route, 200, { ok: true, dropped: 1 });
		return json(route, 200, { ok: true, accepted: true });
	});

	await s.page.route('**/api/report*', async (route) => {
		const req = route.request();
		if (req.method() !== 'POST') {
			return json(route, 200, { ok: true, reasons: ['abuse', 'spam', 'illegal'] });
		}
		log.push({ what: 'report', body: JSON.parse(req.postData() || '{}') });
		return json(route, 200, { ok: true, fresh: true });
	});
	return { log, st };
}

/// Put the page in the state a signed-in account with a handle is in. The
/// harness opens with no gateway, so without this every read returns before it
/// makes a request -- and every assertion below would pass for the wrong reason.
async function signedIn(s, handle) {
	await s.page.evaluate(async (h) => {
		const state = window.DaimondGateway.state;
		window.DaimondGateway.state = () => Object.assign({}, state(), { authed: true });
		if (window.DaimondSync) window.DaimondSync.handle = () => h;
		await window.DaimondIdentity.ensureSealingKey();
		await window.DaimondPost.read();
	}, handle);
}

/// Open the Social panel at one view and let it settle.
async function showView(s, view) {
	await s.page.evaluate((v) => {
		window.DaimondPanels.show('social');
		window.DaimondSocial.show(v);
	}, view);
	await sleep(450);
}

const row = (o) => ({ author: 'acctA', author_handle: 'amber-fox-9k2q',
	author_pub: 'PUBA', id: 1, ts: 1000, bytes: 10, removed: '', body: 'x', ...o });

let A = null, B = null;
try {

// ── 0. The seams, asserted rather than supplied ──────────────────────

console.log('\n0. the seams are in the app, not in this file');
// A PROFILE PER RUN, which the harness gives a session that names none: this
// file's state is the record it writes during the run, and a profile kept from
// the run before would have the marks already moved and every count below would
// read as nothing having arrived.
A = await open({ name: 'feed-a', connect: false, route: routeBreaks });
const wireA = await mockWire(A);
await A.page.waitForFunction(() => !!window.DaimondFeed && !!window.DaimondPost, null, { timeout: 15000 })
	.catch(() => { throw new Error('the page did not assemble: js/feed.js is missing from www/index.html'); });

const seams = await A.page.evaluate(async () => {
	const html = await (await fetch('/index.html')).text();
	const tag = n => new RegExp('<script[^>]+src=["\']js/' + n + '\\.js["\']').test(html);
	return {
		script: tag('feed'),
		host:   !!document.querySelector('#social-feed-list'),
		chips:  [...document.querySelectorAll('#panel-social .imp-chip[data-view]')].map(c => c.dataset.view),
		view:   !!document.getElementById('social-feed'),
	};
});
check('index.html loads js/feed.js', seams.script);
check('and carries the region that lane owns, #social-feed-list', seams.host && seams.view);
check('the head carries six chips, with Feed in Settings\' old slot',
	JSON.stringify(seams.chips) === JSON.stringify(['messages', 'people', 'groups', 'feed', 'share', 'proposals']),
	seams.chips);

await signedIn(A, 'amber-fox-9k2q');

// THE RECORD'S VERSION, AND THE STEP THAT GOES WITH IT. A bump without a step
// empties every device's messages; this walks a real v4 record up and counts
// what survived.
const walked = await A.page.evaluate(async () => {
	// A WRITE FIRST, so the key exists whether or not this profile is a fresh one.
	// `feedSaw` saves unconditionally, which is why it is the one used.
	await window.DaimondPost.feedSaw('seed', [], true);
	const key = Object.keys(localStorage).find(k => k.indexOf('daimond-post') !== -1);
	if (!key) return { why: 'no store key' };
	const v4 = { v: 4, through: 3, acked: 0, tries: 0,
		msgs: { abc: { addr: 'abc', dir: 'in', read: 0, body: 'kept' } },
		notes: {}, groups: {}, shares: {} };
	localStorage.setItem(key, await window.DaimondIdentity.wrap(JSON.stringify(v4)));
	window.DaimondPost.forget();
	const r = await window.DaimondPost.read();
	return { v: r.v, feed: !!(r.feed && r.feed.read && r.feed.new), msgs: Object.keys(r.msgs).length,
		through: r.through };
});
check('the record is at version 5', walked.v === 5, walked);
check('and a v4 record walks up with feed.read present', walked.feed === true, walked);
check('and the bump did not empty the store: the message and the watermark survived',
	walked.msgs === 1 && walked.through === 3, walked);

// AND PUT THE STORE BACK. The record above is this file's fixture, not the
// app's; leaving its one message in place would make every count below read a
// message this run invented.
await A.page.evaluate(async () => {
	const key = Object.keys(localStorage).find(k => k.indexOf('daimond-post') !== -1);
	localStorage.setItem(key, await window.DaimondIdentity.wrap(JSON.stringify({
		v: 5, through: 0, acked: 0, tries: 0, msgs: {}, notes: {}, groups: {}, shares: {},
		feed: { since: 0, read: {}, new: {} },
	})));
	window.DaimondPost.forget();
	await window.DaimondPost.read();
});

// ── 1. A follow: asked for once, answered in the tray ────────────────

console.log('\n1. follow -> tray -> approve, and Ignore reaches the relay in no way at all');
B = await open({ name: 'feed-b', connect: false, route: routeBreaks });
const wireB = await mockWire(B);
await B.page.waitForFunction(() => !!window.DaimondFeed, null, { timeout: 15000 });
await signedIn(B, 'quiet-heron-22aa');

// A's card reaches B the way a paste does, so B has a People row to press.
const cardA = await A.page.evaluate(async () => {
	await window.DaimondIdentity.mintCard();
	return { text: window.DaimondTrust.cardText(), pub: window.DaimondIdentity.publicKeyB64url() };
});
await B.page.evaluate(async (text) => {
	const card = window.DaimondTrust.parse(text);
	await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.PASTE);
}, cardA.text);

// The gateway says B follows nobody yet; the row must therefore offer Follow.
wireB.st.following = [];
wireB.st.followAnswer = { ok: true, blocked: true };	// the oracle a client must not read
await B.page.evaluate(() => window.DaimondFeed.followingList());
await showView(B, 'people');
const beforeAsk = wireB.log.filter(r => r.what === 'follow').length;
const pressed = await B.page.evaluate(() => {
	const b = document.querySelector('#social-people-list .trust-follow');
	if (!b) return { why: 'no Follow control on the People row' };
	b.click();
	return { label: b.textContent };
});
await sleep(400);
const asks = wireB.log.filter(r => r.what === 'follow');
check('pressing Follow on a People row sends exactly one request',
	asks.length - beforeAsk === 1, { pressed, asks });
check('and it carries the author\'s key and the word request',
	!!asks.length && asks[asks.length - 1].body
	&& asks[asks.length - 1].body.peer === cardA.pub
	&& asks[asks.length - 1].body.action === 'request',
	asks[asks.length - 1] && asks[asks.length - 1].body);
const stateAfter = await B.page.evaluate((pub) => {
	const by = window.DaimondFeed.follows() || {};
	const b  = document.querySelector('#social-people-list .trust-follow');
	return { held: by[pub] || '', label: b ? b.textContent : '' };
}, cardA.pub);
// 2. A BLOCK IS NOT INFERRABLE. The mock answered the request with a field
// saying it was dropped; nothing on the screen or in the module may read it.
check('the request is held as asked, never as refused', stateAfter.held === 'requested', stateAfter);
check('and no screen and no state anywhere says blocked',
	!/block/i.test(JSON.stringify(stateAfter)), stateAfter);

// A's relay box now carries the row the request wrote.
wireA.st.collect = [{ seq: 11, kind: 'follow', from_pub: 'PUBB', envelope: 'quiet-heron-22aa',
	addr: '', ts: 1200, bytes: 0, expired: false, tray: true }];
await A.page.evaluate(() => window.DaimondPost.collect());
await showView(A, 'messages');
const tray = await A.page.evaluate(() => ({
	rows:   document.querySelectorAll('#post-tray .post-follow').length,
	said:   (document.querySelector('#post-tray .post-follow .post-body') || {}).textContent || '',
	msgs:   document.querySelectorAll('#post-list .post-msg').length,
	acts:   [...document.querySelectorAll('#post-tray .post-follow .post-btn')].map(b => b.textContent),
}));
check('the follow row is drawn in the tray', tray.rows === 1, tray);
check('and it says who wants to follow, in the reader\'s own words',
	/quiet-heron-22aa/.test(tray.said) && /follow/i.test(tray.said), tray.said);
check('and it is NEVER drawn in the message list', tray.msgs === 0, tray);
check('with three answers on it', JSON.stringify(tray.acts) === JSON.stringify(['Approve', 'Ignore', 'Block']),
	tray.acts);

const beforeIgnore = wireA.log.filter(r => r.what === 'follow' || r.what === 'connect').length;
await A.page.evaluate(() => document.querySelector('[data-act="post-follow-ignore"]').click());
await sleep(350);
check('Ignore writes nothing to the relay at all',
	wireA.log.filter(r => r.what === 'follow' || r.what === 'connect').length === beforeIgnore,
	wireA.log.slice(-3));
check('and the row goes off this device\'s tray',
	await A.page.evaluate(() => document.querySelectorAll('#post-tray .post-follow').length) === 0);

// A second ask, approved this time.
wireA.st.collect = [{ seq: 12, kind: 'follow', from_pub: 'PUBB', envelope: 'quiet-heron-22aa',
	addr: '', ts: 1300, bytes: 0, expired: false, tray: true }];
await A.page.evaluate(() => window.DaimondPost.collect());
await sleep(300);
await A.page.evaluate(() => document.querySelector('[data-act="post-follow-approve"]').click());
await sleep(400);
const approved = wireA.log.filter(r => r.what === 'follow').pop();
check('Approve reaches the relay as one `op=follow` with action approve',
	!!approved && approved.body.action === 'approve' && approved.body.peer === 'PUBB', approved);

// ── 2. Posting ───────────────────────────────────────────────────────

console.log('\n2. a post, its audience, and a refusal that keeps the draft');
wireA.st.followers = [{ acct: 'acctB', handle: 'quiet-heron-22aa', pub: 'PUBB', since: 900 }];
wireA.st.mine = [];
await showView(A, 'feed');
await A.page.evaluate(() => window.DaimondFeed.tab('mine'));
await A.page.evaluate(() => window.DaimondFeed.refresh());
await sleep(400);
const count = await A.page.evaluate(() => (document.querySelector('.feed-count') || {}).textContent || '');
check('the box says who can read it, by number', /1 follower/.test(count), count);

const WORDS = 'File viewer fix is out. Thanks to everybody who wrote.';
await A.page.evaluate((w) => {
	const ta = document.getElementById('feed-box');
	ta.value = w;
	ta.dispatchEvent(new Event('input'));
	document.querySelector('[data-act="feed-post"]').click();
}, WORDS);
await sleep(500);
const posted = wireA.log.filter(r => r.what === 'feed').pop();
check('pressing Post sends the words on `op=feed`', !!posted && posted.body.body === WORDS, posted);
check('and the request carries nothing but the body',
	!!posted && JSON.stringify(Object.keys(posted.body)) === JSON.stringify(['body']), posted && posted.body);
check('and the box is emptied, because the words left',
	await A.page.evaluate(() => (document.getElementById('feed-box') || {}).value) === '');

// 413, and the draft must survive it.
wireA.st.postStatus = 413;
wireA.st.postReason = 'too_long';
await A.page.evaluate(() => {
	const ta = document.getElementById('feed-box');
	ta.value = 'x'.repeat(50);
	ta.dispatchEvent(new Event('input'));
	document.querySelector('[data-act="feed-post"]').click();
});
await sleep(500);
const refused = await A.page.evaluate(() => ({
	said:  (document.getElementById('feed-say') || {}).textContent || '',
	draft: (document.getElementById('feed-box') || {}).value || '',
}));
check('a refusal draws the length in words, and keeps the draft',
	/characters/i.test(refused.said) && refused.draft.length === 50, refused);
wireA.st.postStatus = 200;

// ── 3. Reading somebody else's feed ──────────────────────────────────

console.log('\n3. the merged read, and the handle that goes to People');
wireB.st.merged = [
	row({ id: 4, ts: 1400, body: 'Relay maintenance Sunday.' }),
	row({ id: 3, ts: 1300, body: WORDS }),
];
await showView(B, 'feed');
await sleep(500);
const read = wireB.log.filter(r => r.what === 'feed-merged').pop();
check('opening the view reads the merged feed from the mark',
	!!read && read.since === 0, read);
const drawn = await B.page.evaluate(() => ({
	rows:  document.querySelectorAll('#social-feed-list .feed-row').length,
	who:   (document.querySelector('#social-feed-list .feed-who') || {}).textContent || '',
	body:  (document.querySelector('#social-feed-list .post-body') || {}).textContent || '',
	links: document.querySelectorAll('#social-feed-list a[href]').length,
}));
check('two posts are drawn, newest first, under the author\'s handle',
	drawn.rows === 2 && drawn.who === 'amber-fox-9k2q' && /Relay maintenance/.test(drawn.body), drawn);
check('and nothing in a post is drawn as a link', drawn.links === 0, drawn);

const looked = await B.page.evaluate(() => {
	let asked = '';
	const real = window.DaimondTrust.findHandle;
	window.DaimondTrust.findHandle = (h) => { asked = h; return real(h); };
	document.querySelector('#social-feed-list .feed-who').click();
	window.DaimondTrust.findHandle = real;
	return asked;
});
check('pressing the handle looks that person up in People', looked === 'amber-fox-9k2q', looked);

// ── 4. Unread, the badge, and the mark ───────────────────────────────

console.log('\n4. the badge counts what nobody has looked at, and the mark moves once');
await showView(B, 'messages');			// the feed view is now shut
await B.page.evaluate(() => { window.DaimondBadge.seen('social'); });
wireB.st.merged = [row({ id: 5, ts: 1500, body: 'Back on Monday.' })].concat(wireB.st.merged);
const arrival = await B.page.evaluate(async () => {
	let heard = null, times = 0;
	const on = (e) => { times++; heard = e.detail; };
	window.addEventListener('daimond:post-arrived', on);
	await window.DaimondFeed.poll();
	await new Promise(r => setTimeout(r, 300));
	window.removeEventListener('daimond:post-arrived', on);
	return { times, heard, unread: window.DaimondFeed.unread(), badge: window.DaimondBadge.count('social') };
});
check('a post folded with the panel shut is announced exactly once',
	arrival.times === 1 && arrival.heard && arrival.heard.kind === 'feed', arrival);
check('it counts as one unread', arrival.unread === 1, arrival);
check('and the Social badge carries it', arrival.badge >= 1, arrival);

// A HIDDEN VIEW MARKS NOTHING. The rows are drawn into a region with no area.
const blind = await B.page.evaluate(async () => {
	await window.DaimondFeed.render();
	return { unread: window.DaimondFeed.unread() };
});
check('drawing into a hidden view clears nothing', blind.unread === 1, blind);

await showView(B, 'feed');
await sleep(500);
const cleared = await B.page.evaluate(() => ({
	unread: window.DaimondFeed.unread(), badge: window.DaimondBadge.count('social') }));
check('opening the view, where the rows have real area, clears it',
	cleared.unread === 0, cleared);

// 4b. THE MARK MOVES ONLY ON A COMPLETE PAGE.
const marks = await B.page.evaluate(async () => {
	const before = window.DaimondPost.feedState().since;
	return { before };
});
wireB.st.more = true;
wireB.st.merged = [row({ id: 6, ts: 9000, body: 'More above this.' })].concat(wireB.st.merged);
await B.page.evaluate(() => window.DaimondFeed.poll());
const held = await B.page.evaluate(() => window.DaimondPost.feedState().since);
check('a page that says there is more above it does not move the mark',
	held === marks.before, { before: marks.before, held });
wireB.st.more = false;
await B.page.evaluate(() => window.DaimondFeed.poll());
const moved = await B.page.evaluate(() => window.DaimondPost.feedState().since);
check('and a complete page does', moved === 9000, { held, moved });

// ── 5. Delete, and what is left behind ───────────────────────────────

console.log('\n5. a delete, and the nothing it leaves on the follower\'s device');
wireA.st.mine = [{ id: 7, ts: 1700, bytes: 12, removed: '', body: WORDS }];
await showView(A, 'feed');
await A.page.evaluate(() => window.DaimondFeed.tab('mine'));
await A.page.evaluate(() => window.DaimondFeed.refresh());
await sleep(400);
await A.page.evaluate(() => document.querySelector('[data-act="feed-delete"]').click());
await sleep(450);
const deleted = wireA.log.filter(r => r.what === 'feed_delete').pop();
check('Delete names the post and nothing else', !!deleted && deleted.body.id === 7
	&& JSON.stringify(Object.keys(deleted.body)) === JSON.stringify(['id']), deleted);

wireB.st.merged = wireB.st.merged.filter(r => r.body !== 'Back on Monday.');
await B.page.evaluate(() => window.DaimondFeed.refresh());
await sleep(400);
const afterDelete = await B.page.evaluate(() => {
	const rec = JSON.stringify(window.DaimondPost.feedState());
	return { rows: document.querySelectorAll('#social-feed-list .feed-row').length,
		drawn: /Back on Monday/.test(document.getElementById('social-feed-list').textContent),
		body: /Back on Monday/.test(rec) || /Relay maintenance/.test(rec) };
});
check('the follower\'s next read simply does not have it',
	afterDelete.rows === wireB.st.merged.length && !afterDelete.drawn, afterDelete);
check('and no post body was ever in the record to go stale', afterDelete.body === false, afterDelete);

// ── 6. Reporting a post ──────────────────────────────────────────────

console.log('\n6. a report about a post carries the post\'s name and no evidence');
await B.page.evaluate(() => document.querySelector('[data-act="feed-report"]').click());
await sleep(500);
const sheet = await B.page.evaluate(() => ({
	up:   !!document.getElementById('report-sheet'),
	head: (document.querySelector('#report-sheet h2') || {}).textContent || '',
	rule: (document.querySelector('#report-sheet .report-rule') || {}).textContent || '',
	body: (document.getElementById('report-body') || {}).textContent || '',
}));
check('the sheet says it is about a post, and what travels',
	sheet.up && /post/i.test(sheet.head) && /operator/i.test(sheet.rule), sheet);
check('and it shows the words the reader is deciding about', sheet.body.length > 5, sheet.body);
await B.page.evaluate(() => document.querySelector('#report-sheet .report-send').click());
await sleep(500);
const filed = wireB.log.filter(r => r.what === 'report').pop();
check('the report names the post by author and id, with a reason',
	!!filed && !!filed.body.post && typeof filed.body.post.author === 'string'
	&& typeof filed.body.post.id === 'number' && typeof filed.body.reason === 'string', filed);
check('and carries no artefact, no envelope and no content key',
	!!filed && !('artefact' in filed.body) && !('envelope' in filed.body) && !('ckey' in filed.body),
	filed && Object.keys(filed.body));
await B.page.evaluate(() => window.DaimondReport.close());

// ── 7. The operator took one down ────────────────────────────────────

console.log('\n7. a post removed by the operator is a notice, never a message');
wireA.st.collect = [{ seq: 20, kind: 'feedgone', from_pub: '', envelope: '7 spam',
	addr: '', ts: 1800, bytes: 0, expired: false }];
await A.page.evaluate(() => window.DaimondPost.collect());
await showView(A, 'messages');
const notice = await A.page.evaluate(() => ({
	said: (document.querySelector('#post-notices .post-notice') || {}).textContent || '',
	msgs: document.querySelectorAll('#post-list .post-msg').length,
}));
check('it is drawn as a notice, with the operator\'s reason in it',
	/removed/i.test(notice.said) && /spam/.test(notice.said), notice);
check('and never as a message', notice.msgs === 0, notice);

wireA.st.mine = [{ id: 7, ts: 1700, bytes: 12, removed: 'operator', body: '' }];
await showView(A, 'feed');
await A.page.evaluate(() => window.DaimondFeed.tab('mine'));
await A.page.evaluate(() => window.DaimondFeed.refresh());
await sleep(400);
const mineRemoved = await A.page.evaluate(() =>
	(document.querySelector('#social-feed-list .post-bad') || {}).textContent || '');
check('and the author\'s own entry says so where the words were',
	/removed/i.test(mineRemoved) && /spam/.test(mineRemoved), mineRemoved);

// ── 8. Letting go, from either end ───────────────────────────────────

console.log('\n8. unfollow, and removing a follower');
wireA.st.followers = [{ acct: 'acctB', handle: 'quiet-heron-22aa', pub: 'PUBB', since: 900 }];
await A.page.evaluate(() => window.DaimondFeed.refresh());
await sleep(400);
const named = await A.page.evaluate(() =>
	(document.querySelector('#feed-followers .post-name') || {}).textContent || '');
check('the author, and only the author, is shown who follows them',
	named === 'quiet-heron-22aa', named);
await A.page.evaluate(() => document.querySelector('[data-act="feed-remove"]').click());
await sleep(400);
const removed = wireA.log.filter(r => r.what === 'follow').pop();
check('Remove on a follower row sends `op=follow remove`',
	!!removed && removed.body.action === 'remove' && removed.body.peer === 'PUBB', removed);

await B.page.evaluate((pub) => window.DaimondFeed.follow(pub, 'unfollow'), cardA.pub);
await sleep(300);
const unfollowed = wireB.log.filter(r => r.what === 'follow').pop();
check('and unfollowing sends `op=follow unfollow` with their key',
	!!unfollowed && unfollowed.body.action === 'unfollow' && unfollowed.body.peer === cardA.pub,
	unfollowed);

// ── 9. A read the gateway refuses ────────────────────────────────────

console.log('\n9. a refusal is drawn as a refusal, with no rows behind it');
wireB.st.feedStatus = 403;
wireB.st.feedReason = 'not_following';
const refusedRead = await B.page.evaluate(async () => {
	const r = await window.DaimondFeed.mine();
	return { ok: r.ok, why: r.why || '' };
});
check('an author read this account may not make answers with words, not rows',
	refusedRead.ok === false && refusedRead.why.length > 0, refusedRead);
wireB.st.feedStatus = 200;

// ── 10. The caps, on the screen ──────────────────────────────────────

console.log('\n10. the caps say what happened, in one line');
wireA.st.postAnswer = { dropped: 1 };
await showView(A, 'feed');
await A.page.evaluate(() => window.DaimondFeed.tab('mine'));
await A.page.evaluate(() => {
	const ta = document.getElementById('feed-box');
	ta.value = 'one more';
	ta.dispatchEvent(new Event('input'));
	document.querySelector('[data-act="feed-post"]').click();
});
await sleep(500);
const dropSaid = await A.page.evaluate(() => (document.getElementById('feed-say') || {}).textContent || '');
check('a post that pushed the oldest one out says so', /oldest/i.test(dropSaid), dropSaid);
wireA.st.postAnswer = {};

// 507: the author has as many followers as the gateway will hold.
wireA.st.followAnswer = { ok: false, reason: 'followers_full', error: 'no' };
const fullSaid = await A.page.evaluate(async () => {
	const r = await window.DaimondFeed.follow('PUBX', 'approve');
	return r.why || '';
});
check('an approval refused for room says so, without naming an allowance',
	/followers/i.test(fullSaid) && !/\d/.test(fullSaid), fullSaid);
wireA.st.followAnswer = { ok: true };

// ── 11. What never leaves the browser ────────────────────────────────

console.log('\n11. nothing on the wire but a body, a key and a reason');
const fields = [...wireA.log, ...wireB.log]
	.filter(r => r.body && typeof r.body === 'object' && r.what !== 'report')
	.flatMap(r => Object.keys(r.body));
const allowed = ['body', 'id', 'peer', 'action', 'to', 'addr', 'envelope', 'seq', 'through'];
check('every feed request carries only the fields the contract names',
	fields.every(f => allowed.includes(f)), [...new Set(fields)]);
const reportFields = wireB.log.filter(r => r.what === 'report').flatMap(r => Object.keys(r.body));
check('and a report carries only the post and the reason',
	reportFields.every(f => ['post', 'reason'].includes(f)), [...new Set(reportFields)]);

// ── 12. The words, in eight languages ────────────────────────────────

console.log('\n12. eight locales, and none of them promises a public');
const en = fs.readFileSync(path.join(I18N, 'en.js'), 'utf8');
const keys = [...en.matchAll(/'(feed\.[a-z_0-9]+)':/g)].map(m => m[1]);
check('en.js carries the feed\'s own strings', keys.length >= 30, keys.length);
const locales = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const missing = [];
for (const loc of locales) {
	const src = fs.readFileSync(path.join(I18N, loc + '.js'), 'utf8');
	for (const k of keys) if (!src.includes(`'${k}':`)) missing.push(loc + ' ' + k);
}
check('and every one of them is in all seven translations', missing.length === 0, missing.slice(0, 5));
// The English is the one that can be read here for what it promises. A
// translation saying "public" is a review question, not a string match.
const enFeed = keys.map(k => (en.match(new RegExp("'" + k + "':\\s*'([^']*)'")) || [])[1] || '').join(' | ');
check('none of the English says public, anyone, or Diamond with a capital',
	!/\bpublic\b/i.test(enFeed) && !/\banyone\b/i.test(enFeed) && !/Diamond/.test(enFeed), enFeed.slice(0, 120));

// ── 13. Settings, now that no chip opens it ──────────────────────────

console.log('\n13. the Settings view kept its door when it lost its chip');
const cog = await A.page.evaluate(async () => {
	document.getElementById('settings-btn').click();
	await new Promise(r => setTimeout(r, 400));
	const b = document.getElementById('admin-social-settings');
	if (!b) return { row: false };
	b.click();
	await new Promise(r => setTimeout(r, 400));
	const v = document.getElementById('social-settings');
	return { row: true, shown: !!v && !v.hidden, view: window.DaimondSocial.view() };
});
check('the cog drawer carries the row that opens Social settings', cog.row === true, cog);
check('and pressing it shows the view the chip used to', cog.shown === true && cog.view === 'settings', cog);
const doorbell = await A.page.evaluate(() =>
	!!document.querySelector('#improve-settings .admin-item, #improve-settings .imp-voice'));
check('and the posting name and the doorbell are still what it draws', doorbell === true);

} finally {
	for (const s of [A, B]) {
		if (!s) continue;
		await shot(s, 'feed-' + (s === A ? 'a' : 'b') + (BREAK ? '-' + BREAK : ''));
		const errs = s.errs.filter(e => !/Failed to load resource|status of 4\d\d|status of 5\d\d/.test(e));
		check('no console errors in the ' + (s === A ? 'author' : 'follower') + '\'s session',
			errs.length === 0, errs.slice(0, 2));
		await s.close();
	}
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) {
	console.log('failed: ' + bad.join('; '));
	process.exit(1);
}
if (BREAK) {
	console.log(`\nbreak '${BREAK}' produced a GREEN run, which means the check it is `
		+ 'aimed at is not checking anything.');
	process.exit(1);
}
