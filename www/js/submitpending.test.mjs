/* ============================================================
   Test -- A DAIMON'S CHANGE WAITING FOR HIS TAP, AS A PENDING CARD (SUBMIT-ROUTE SR7)
   (www/js/page/pending.js, "A daimon's change waiting for his tap"; the submit route design
   §1 UX and the SR7 row; kimberlite relay.rs `card`, `diff_aad`, `submit_body`.)
   ------------------------------------------------------------
   Lifted from the page's own text as runnerpending.test.mjs does (dev/syncprobe.mjs), and run
   as written. Stand-ins: the hand's install id, `fetch` (the relay: the listing by install,
   flags only, and each entry whole by its nonce, or 404), the account key (an AES-GCM key
   the test seals each chunk with, as Kimberlite's keeper does), and a small DOM for the tile.

   Each check is proven able to fail (each break must fail at least one case):

     node www/js/submitpending.test.mjs --break codec     # a check's count encoded as u16, not u32
     node www/js/submitpending.test.mjs --break first     # the tile sits on the first chunk listed, not chunk 1
     node www/js/submitpending.test.mjs --break group     # chunks grouped by nonce, not by their one body
     node www/js/submitpending.test.mjs --break label     # every check labelled "the daimon says"
     node www/js/submitpending.test.mjs --break writes    # the failing-first hash not shown
     node www/js/submitpending.test.mjs --break aad       # k and n swapped in the chunk's AAD
     node www/js/submitpending.test.mjs --break sealsha   # a sealed chunk's SHA-256 not checked
     node www/js/submitpending.test.mjs --break plainsha  # the joined diff's SHA-256 not checked
     node www/js/submitpending.test.mjs --break cardsha   # a card that is not the runner's still offered
     node www/js/submitpending.test.mjs --break status    # no "Deployed" status once the runner marks it done
     node www/js/submitpending.test.mjs --break withdraw  # a 404 by the nonce read as a relay down: the tile stays
     node www/js/submitpending.test.mjs                   # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { makeWindow, liftSource } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALERTS_SRC = readFileSync(join(HERE, 'alerts.js'), 'utf8');
const LOAD_ALERTS = new Function('window', 'with (window) {\n' + ALERTS_SRC + '\n}\n//# sourceURL=alerts.js');
const SV2 = JSON.parse(readFileSync(join(HERE, '../../verify/runner_compat/submit_v4/vectors.json'), 'utf8'));

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['codec', 'first', 'group', 'label', 'writes', 'aad', 'sealsha', 'plainsha', 'cardsha', 'status', 'withdraw'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

function patch(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	if (BREAK === 'codec')    swap('submitUint(c.result, 1), submitUint(c.count, 4)', 'submitUint(c.result, 1), submitUint(c.count, 2)');
	if (BREAK === 'first')    swap('if (k === 1) g.e = e;', 'if (!g.e) g.e = e;');
	if (BREAK === 'group')    swap('var g = byBody[e.body] = byBody[e.body] ||', 'var g = byBody[e.nonce] = byBody[e.nonce] ||');
	if (BREAK === 'label')    swap("(c && c.who === '1') ? t('pending.submit.fenced') : t('pending.submit.says')", "t('pending.submit.says')");
	if (BREAK === 'writes')   swap("if (b.write_path) submitLine(box, 'failing', t('pending.submit.failing_first', { hash: b.failing_first }));", '');
	if (BREAK === 'aad')      swap('challenge, submitUint(k, 4), submitUint(n, 4)', 'challenge, submitUint(n, 4), submitUint(k, 4)');
	if (BREAK === 'sealsha')  swap("if (sha !== b.diff_shas[k - 1]) return { state: 'bad', k: have, n: n };", '');
	if (BREAK === 'plainsha') swap('if (submitHexOf(await submitSha(all)) === b.diff_sha256) {', 'if (true) {');
	if (BREAK === 'cardsha')  swap('if (!c || c.cardSha !== b.card_sha256)', 'if (!c)');
	if (BREAK === 'status')   swap("}\n\t\tif (g.e.done === true) submitLine(box, 'status', t('pending.submit.deployed', { commit: b.commit.slice(0, 12) }));", '}');
	if (BREAK === 'withdraw') swap('if (r && r.status === 404) { _submitGone[n] = true; return null; }', '');
	return src;
}

const NAMES = ['Pending', 'runnerPoll', 'runnerSettle', 'submitTile', 'submitOpenDiff', 'submitChallenge', 'submitBody'];
const OWN = /^(runner|RUNNER_|_runner|submit|SUBMIT_|_submit|plain|PLAIN_|_plain)/;
const STUBS = liftSource(NAMES, []).ordered.filter((n) => !NAMES.includes(n) && !OWN.test(n));

const INSTALL = 'IiIiIiIiIiIiIiIiIiIiIg';
const nonce = (c, k) => (c + String(k)).padEnd(22, 'x');
const enc = new TextEncoder();
const hex = (u8) => Buffer.from(u8).toString('hex');
const b64u = (u8) => Buffer.from(u8).toString('base64url');
const sha = async (u8) => new Uint8Array(await webcrypto.subtle.digest('SHA-256', u8));
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); return b; };
const cat = (ps) => { const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of ps) { o.set(p, at); at += p.length; } return o; };
const KEY = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
async function seal(plain, aad) {
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	return cat([iv, new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, KEY, plain))]);
}

const WHO = { fenced: '1', daimon: '2' };
const RES = { failed: '0', passed: '1', skipped: '2' };
/// The body Kimberlite's `submit_body` writes for a vector case.
function bodyOf(c) {
	const m = c.manifest, k = c.card;
	return {
		id: 'x', seq: String(m.seq), commit: m.commit, base_commit: m.base_commit, pins: m.pins.map((x) => x.name + ':' + x.pin).join(';'),
		card_sha256: c.card_sha256, nets: m.nets.join(','),
		artefacts: m.artefacts.map((a) => [a.kind, a.sha256, a.size, a.target].join(':')).join(';'),
		title: k.title, summary: k.summary, branch: k.branch, diffstat: k.diffstat, diff_sha256: k.diff_sha256,
		diff_n: '1', diff_shas: '00'.repeat(32), write_path: m.write_path ? '1' : '0', failing_first: m.failing_first,
		write_paths: k.write_paths.join('\n'), page_code: k.page_code ? '1' : '0', review: k.review,
		checks: k.checks.map((x) => ({ name: x.name, who: WHO[x.who], result: RES[x.result], count: String(x.count) })),
	};
}

function el(tag) {
	return { tag, className: '', textContent: '', children: [], attrs: {}, on: {},
		appendChild(c) { this.children.push(c); return c; }, addEventListener(t, f) { this.on[t] = f; }, setAttribute(k, v) { this.attrs[k] = v; } };
}
const walk = (e, out = []) => { out.push(e); for (const c of e.children) walk(c, out); return out; };

function page(o) {
	o = o || {};
	const win = makeWindow();
	const st = { fetches: [], list: [], whole: {}, install: o.install === undefined ? INSTALL : o.install, unlocked: o.locked ? false : true };
	win.fetch = async (url) => {
		url = String(url); st.fetches.push(url);
		if (url.indexOf('?install=') >= 0) return { ok: true, status: 200, json: async () => ({ ok: true, entries: st.list.map((e) => Object.assign({}, e)) }) };
		const n = decodeURIComponent(url.split('?nonce=')[1] || '');
		const w = st.whole[n];
		if (w === 'down') return { ok: false, status: 503, json: async () => ({ ok: false }) };
		if (!w) return { ok: false, status: 404, json: async () => ({ ok: false }) };
		return { ok: true, status: 200, json: async () => Object.assign({ ok: true }, w) };
	};
	win.DaimondHand = { runnerInstall: () => st.install };
	win.DaimondNet = { runnerApprove: () => 'https://runner.test.daimond.app/approve' };
	win.DaimondIdentity = {
		isUnlocked: () => st.unlocked,
		unwrapBytesAadRaw: async (bytes, aad) => new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: aad }, KEY, bytes.slice(12))),
	};
	win.document.createElement = el;
	LOAD_ALERTS(win);
	const stub = {
		t: (k, v) => k + (v ? '|' + Object.keys(v).sort().map((x) => x + '=' + v[x]).join(',') : ''),
		readJson: (k, d) => { try { const v = win.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
		PENDING_KEY: 'daimond-pending', PRIORITIES: ['high', 'normal', 'low'], NOTICED_KEY: 'daimond-pending-noticed', NOTICED_MAX: 64,
		settleConsent: () => false, _parked: {}, relTime: () => 'now', nudgeSync: () => {}, steerTile: () => {}, steerRaise: () => {},
		toast: () => {}, diamonds: [], currentDiamond: null, selectDiamond: async () => {}, turnHold: () => null, confirmHold: async () => {},
		doSteer: async () => {}, steerPress: async () => {}, steerEdit: async () => {}, promptDialog: async () => null,
		sendMessage: async () => {}, newChat: async () => {}, DaimondPanels: { isOpen: () => true, show: () => {} },
		tombMapNow: () => ({}), DIAMOND_TOMBS_KEY: 'daimond-diamond-tombs', trashed: () => false,
	};
	let src = patch(liftSource(NAMES, STUBS).src);
	for (const n of STUBS) if (!(n in stub)) stub[n] = undefined;
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ') {\n' + src + '\nreturn { ' + NAMES.join(', ') + ' };\n}).apply(null, stubs); }';
	const fns = new Function('window', 'stubs', body)(win, sk.map((k) => stub[k]));
	fns.Pending.render = () => {};
	const tiles = () => { fns.Pending.fresh(); return fns.Pending.items.filter((x) => x.kind === 'submit'); };
	/// The tile drawn, once its keyless check has run, as its elements.
	const draw = async (it) => {
		fns.submitTile(el('div'), it);
		await new Promise((r) => setTimeout(r, 30));
		const box = el('div');
		fns.submitTile(box, it);
		return walk(box);
	};
	return { win, st, fns, tiles, draw, A: win.DaimondAlerts };
}

/// One submission on the relay: chunks `parts` of the diff sealed under KEY with their AAD, an
/// entry per chunk (nonces `tag`1..n), the body naming every hash. `o.flip` re-seals chunk k
/// (same plain, fresh IV) after the body names its hash; `o.diffSha` puts another hash in the
/// card; `o.cardSha` another card hash in the body.
async function submission(pg, tag, parts, o) {
	o = o || {};
	const c = SV2.cases[o.case === undefined ? 1 : o.case];
	const body = bodyOf(c);
	body.seq = String(o.seq || c.manifest.seq);
	body.diff_sha256 = o.diffSha || hex(await sha(enc.encode(parts.join(''))));
	const ch = await pg.fns.submitChallenge(pg.fns.submitBody({ body: JSON.stringify(body) }));
	body.card_sha256 = o.cardSha || ch.cardSha;
	const n = parts.length, sealed = [];
	for (let k = 1; k <= n; k++) sealed.push(await seal(enc.encode(parts[k - 1]), cat([enc.encode('kimberlite/submit-diff/v1\0'), ch.challenge, u32(k), u32(n)])));
	body.diff_n = String(n);
	body.diff_shas = (await Promise.all(sealed.map(async (s) => hex(await sha(s))))).join(',');
	if (o.flip) sealed[o.flip - 1] = await seal(enc.encode(parts[o.flip - 1]), cat([enc.encode('kimberlite/submit-diff/v1\0'), ch.challenge, u32(o.flip), u32(n)]));
	const text = JSON.stringify(body), out = [];
	for (let k = 1; k <= n; k++) {
		const nn = nonce(tag, k);
		pg.st.whole[nn] = { nonce: nn, kind: 'submit', install: INSTALL, body: text, diff_k: k, diff_n: n, diff_sealed: b64u(sealed[k - 1]),
			answered: false, alarmed: false, expires_in: 600, answers: [] };
		out.push({ nonce: nn, kind: 'submit', answered: false, alarmed: false, expires_in: 600 });
	}
	return { list: out, body, nonce1: nonce(tag, 1), seq: Number(body.seq) };
}
const texts = (els) => els.map((e) => e.textContent).filter(Boolean);
const approveOf = (els) => els.find((e) => String(e.className).indexOf('pend-submit-approve') >= 0);
const PARTS = ['--- a/x\n+++ b/x\n', '@@ -1 +1 @@\n-old\n', '+new\n'];

console.log("a daimon's change as a Pending card (SR7)");

await kase('the card and challenge rebuilt from the body equal every submit_v4 vector', async () => {
	const pg = page();
	for (const c of SV2.cases) {
		const r = await pg.fns.submitChallenge(pg.fns.submitBody({ body: JSON.stringify(bodyOf(c)) }));
		eq(r.cardSha, c.card_sha256, c.name + ' card sha');
		eq(hex(r.challenge), c.challenge, c.name + ' challenge');
	}
});

await kase('the chunks of one submission make ONE tile on chunk 1, a second submission its own', async () => {
	const pg = page();
	const s1 = await submission(pg, 'P', PARTS);
	const s2 = await submission(pg, 'Q', ['only\n'], { case: 0 });
	pg.st.list = [s1.list[2], s1.list[1], s2.list[0], s1.list[0]];
	await pg.fns.runnerPoll();
	const live = pg.A.live().filter((a) => a.diamond === pg.A.RUNNER).map((a) => a.key).sort();
	eq(live, ['submit.' + s1.nonce1 + '.' + s1.seq, 'submit.' + s2.nonce1 + '.' + s2.seq].sort(), 'one synced item per submission, on chunk 1');
	eq(pg.tiles().map((x) => x.submit.nonce).sort(), [s1.nonce1, s2.nonce1].sort(), 'two tiles');
});

await kase('the card shows the write paths, failing-first hash, review and the who-labels', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS);
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	const tx = texts(await pg.draw(pg.tiles()[0]));
	ok(tx.some((x) => x.indexOf('pending.submit.writes|paths=' + s.body.write_paths.split('\n').join(', ')) === 0), 'write paths: ' + JSON.stringify(tx));
	ok(s.body.write_path === '1' && tx.some((x) => x === 'pending.submit.failing_first|hash=' + s.body.failing_first), 'failing-first hash shown');
	ok(tx.some((x) => x === 'pending.submit.review|review=' + s.body.review), 'review verdict shown');
	ok(tx.some((x) => x.indexOf('pending.submit.check|') === 0 && x.indexOf('who=pending.submit.fenced') > 0), "fenced checks: this commit's tests, run in a fence");
	ok(!tx.some((x) => x.indexOf('who=pending.submit.says') > 0), 'no fenced check labelled as the daimon says');
	const s0 = await submission(pg, 'Q', ['only\n'], { case: 0 });
	pg.st.list = s0.list;
	await pg.fns.runnerPoll();
	const t0 = texts(await pg.draw(pg.tiles()[0]));
	ok(t0.filter((x) => x.indexOf('pending.submit.check|') === 0 && x.indexOf('who=pending.submit.says') > 0).length === 1, 'the one daimon-reported check: the daimon says');
	ok(t0.indexOf('pending.submit.writes_none') >= 0 && !t0.some((x) => x.indexOf('pending.submit.failing_first') === 0), 'no write path: none shown, no failing-first');
	ok(tx.some((x) => x === 'pending.submit.says: ' + s.body.summary), 'the summary under "the daimon says"');
	const en = readFileSync(join(HERE, '../i18n/en.js'), 'utf8');
	ok(en.indexOf("'pending.submit.fenced': 'this commit’s tests, run in a fence'") >= 0 && en.indexOf("'pending.submit.says': 'the daimon says'") >= 0, 'his labels in en.js');
});

await kase('See the diff opens every chunk under its own AAD, checks both hashes, and keeps Approve', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS);
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	const pre = texts(await pg.draw(pg.tiles()[0]));
	ok(pre.indexOf('pending.submit.diff_part|k=3,n=3') >= 0, 'diff 3 of 3 before opening: ' + JSON.stringify(pre));
	const r = await pg.fns.submitOpenDiff(s.nonce1);
	eq(r && r.state, 'ok', 'opened');
	eq(r && r.text, PARTS.join(''), 'the diff text');
	const els = await pg.draw(pg.tiles()[0]);
	ok(texts(els).indexOf('pending.submit.diff_ok') >= 0, 'says it matches');
	ok(els.some((e) => e.tag === 'pre' && e.textContent === PARTS.join('')), 'the diff shown as text');
	eq(approveOf(els) && approveOf(els).href, 'https://runner.test.daimond.app/approve#' + s.nonce1, 'Approve links chunk 1');
});

await kase('a chunk not yet listed reads "diff k of n"; a locked device opens nothing', async () => {
	const pg = page({ locked: true });
	const s = await submission(pg, 'P', PARTS);
	pg.st.list = [s.list[0], s.list[1]];
	await pg.fns.runnerPoll();
	ok(texts(await pg.draw(pg.tiles()[0])).indexOf('pending.submit.diff_part|k=2,n=3') >= 0, 'diff 2 of 3');
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	eq((await pg.fns.submitOpenDiff(s.nonce1)).state, 'locked', 'locked');
});

await kase('a sealed chunk not the one the body names: "diff does not match", no Approve', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS, { flip: 2 });
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	const r = await pg.fns.submitOpenDiff(s.nonce1);
	eq(r.state, 'bad', 'refused');
	const els = await pg.draw(pg.tiles()[0]);
	ok(texts(els).indexOf('pending.submit.diff_bad') >= 0, 'diff does not match');
	ok(!approveOf(els), 'Approve disabled');
});

await kase('a joined diff not the card\'s diff_sha256: "diff does not match", no Approve', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS, { diffSha: 'ab'.repeat(32) });
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	eq((await pg.fns.submitOpenDiff(s.nonce1)).state, 'bad', 'refused');
	const els = await pg.draw(pg.tiles()[0]);
	ok(texts(els).indexOf('pending.submit.diff_bad') >= 0 && !approveOf(els), 'diff does not match, Approve disabled');
});

await kase('a chunk sealed under another chunk\'s AAD does not open', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS);
	const w1 = pg.st.whole[nonce('P', 1)], w2 = pg.st.whole[nonce('P', 2)];
	[w1.diff_sealed, w2.diff_sealed] = [w2.diff_sealed, w1.diff_sealed];
	const shas = s.body.diff_shas.split(',');
	[shas[0], shas[1]] = [shas[1], shas[0]];
	const body = JSON.stringify(Object.assign({}, s.body, { diff_shas: shas.join(',') }));
	for (let k = 1; k <= 3; k++) pg.st.whole[nonce('P', k)].body = body;
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	eq((await pg.fns.submitOpenDiff(s.nonce1)).state, 'bad', 'moved chunks refused');
});

await kase('a card that is not the runner\'s is said, with no Approve', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS, { cardSha: 'cd'.repeat(32) });
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	const els = await pg.draw(pg.tiles()[0]);
	ok(texts(els).indexOf('pending.submit.card_bad') >= 0, 'card refused: ' + JSON.stringify(texts(els)));
	ok(!approveOf(els), 'no Approve');
});

await kase('after the tap: approved, then "Deployed … proof by a driven turn pending", never "Live"', async () => {
	const pg = page();
	const s = await submission(pg, 'P', PARTS);
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	let els = await pg.draw(pg.tiles()[0]);
	approveOf(els).on.click();
	pg.st.list = s.list.map((e, i) => (i === 0 ? Object.assign({}, e, { answered: true }) : e));
	await pg.fns.runnerPoll();
	els = await pg.draw(pg.tiles()[0]);
	ok(texts(els).indexOf('pending.submit.approved') >= 0, 'approved status: ' + JSON.stringify(texts(els)));
	eq(pg.tiles()[0].needs, false, 'his to do no more');
	pg.st.list = s.list.map((e, i) => (i === 0 ? Object.assign({}, e, { answered: true, done: true }) : e));
	await pg.fns.runnerPoll();
	els = await pg.draw(pg.tiles()[0]);
	ok(texts(els).indexOf('pending.submit.deployed|commit=' + s.body.commit.slice(0, 12)) >= 0, 'deployed status');
	ok(!approveOf(els), 'no Approve once deployed');
	for (const loc of ['en']) {
		const src = readFileSync(join(HERE, '../i18n/' + loc + '.js'), 'utf8');
		const lines = src.split('\n').filter((l) => l.indexOf("'pending.submit.") >= 0);
		ok(lines.length > 20 && !lines.some((l) => /\bLive\b/i.test(l)), loc + ': no submit string says Live');
		ok(lines.some((l) => l.indexOf("'pending.submit.deployed': 'Deployed: {commit}; proof by a driven turn pending.'") >= 0), 'his deployed words');
	}
});

await kase('withdrawn (404 by its nonce) drops the tile on a device with no runner; unlisted clears it on the runner', async () => {
	const ph = page({ install: '' });
	const s = await submission(ph, 'P', PARTS);
	ph.st.list = s.list;
	ph.A.raise(ph.A.RUNNER, 'submit.' + s.nonce1 + '.' + s.seq, 'daimon change', INSTALL + ' ' + s.body.title, true);
	await ph.fns.runnerPoll();
	eq(ph.tiles().length, 1, 'the phone shows it');
	// A relay that cannot be read takes nothing down.
	const keep = ph.st.whole;
	ph.st.whole = {};
	for (const k in keep) ph.st.whole[k] = 'down';
	await ph.fns.runnerPoll();
	eq(ph.tiles().length, 1, 'a relay down keeps the tile');
	// Withdrawn: still listed a moment, but its nonce answers 404 (a fresh page, nothing cached).
	const ph2 = page({ install: '' });
	await submission(ph2, 'P', PARTS);
	ph2.st.list = s.list;
	ph2.A.raise(ph2.A.RUNNER, 'submit.' + s.nonce1 + '.' + s.seq, 'daimon change', INSTALL + ' ' + s.body.title, true);
	ph2.st.whole = {};
	await ph2.fns.runnerPoll();
	eq(ph2.tiles().length, 0, 'withdrawn: the tile goes');
	// The runner's own machine: no longer listed, the synced item is cleared.
	const pg = page();
	const t = await submission(pg, 'P', PARTS);
	pg.st.list = t.list;
	await pg.fns.runnerPoll();
	eq(pg.tiles().length, 1, 'raised');
	pg.st.list = [];
	await pg.fns.runnerPoll();
	eq(pg.A.live().filter((a) => a.key.indexOf('submit.') === 0).length, 0, 'cleared when withdrawn');
});

console.log((failures ? 'FAIL' : 'PASS') + ' submitpending: ' + (cases - failures) + '/' + cases + (BREAK ? ' (break ' + BREAK + ')' : ''));
if (failures) process.exitCode = 1;
