/* ============================================================
   Test -- A DAIMON'S CHANGE ON THE PLAIN ROUTE, AS A PENDING CARD (D-20261106-13 (1))
   (www/js/page/pending.js, "A daimon's change on the plain route"; runner-a's plain/1 body,
   verify/runner_compat/plain_v1.)  Harness as submitpending.test.mjs.

   Each check is proven able to fail (each break must fail at least one case):

     node www/js/plainpending.test.mjs --break flag     # the page-code line never shown
     node www/js/plainpending.test.mjs --break level    # every level drawn as Bypass
     node www/js/plainpending.test.mjs --break check    # the body's fields not checked against the card
     node www/js/plainpending.test.mjs --break review   # approve 0 still offers Approve
     node www/js/plainpending.test.mjs --break status   # no "Approved" after his tap
     node www/js/plainpending.test.mjs --break go       # Bypass's link does not ask for the passkey on load
     node www/js/plainpending.test.mjs --break runner   # the Kimberlite-code line never shown
     node www/js/plainpending.test.mjs --break diamond  # the diamond shown by its id, not its name
     node www/js/plainpending.test.mjs --break address  # the approve address a literal, not the gateway's
     node www/js/plainpending.test.mjs                  # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import { makeWindow, liftSource } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ALERTS_SRC = readFileSync(join(HERE, 'alerts.js'), 'utf8');
const LOAD_ALERTS = new Function('window', 'with (window) {\n' + ALERTS_SRC + '\n}\n//# sourceURL=alerts.js');
const PV1 = JSON.parse(readFileSync(join(HERE, '../../verify/runner_compat/plain_v1/vectors.json'), 'utf8'));

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
const KNOWN = ['flag', 'level', 'check', 'review', 'status', 'go', 'runner', 'diamond', 'address'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

function patch(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	if (BREAK === 'flag')   swap("if (b.page_code) submitLine(box, 'flag', t('pending.plain.page_code'));\n\t\tif (b.runner_code)", 'if (b.runner_code)');
	if (BREAK === 'runner') swap("if (b.runner_code) submitLine(box, 'flag', t('pending.plain.runner_code'));", '');
	if (BREAK === 'diamond') swap("t('pending.plain.diamond', { name: b.diamond_name })", "t('pending.plain.diamond', { name: b.diamond })");
	if (BREAK === 'address') swap("var net = window.DaimondNet, base = (net && net.runnerApprove && net.runnerApprove()) || '';", "var base = 'https://runner.daimond.app/approve';");
	if (BREAK === 'level')  swap("DaimondHandMode.get() === 'bypass'", 'true');
	if (BREAK === 'check')  swap("if (b.plain) return { state: plainCheck(b) ? 'plain' : 'card', k: 0, n: 0 };", "if (b.plain) return { state: 'plain', k: 0, n: 0 };");
	if (BREAK === 'review') swap("if (url && ck && !bad && b.approve && g.e.done !== true && !sh) {", "if (url && ck && !bad && g.e.done !== true && !sh) {");
	if (BREAK === 'status') swap("else if (_submitTaps[n] && g.e.answered) submitLine(box, 'status', t('pending.plain.approved'));", '');
	if (BREAK === 'go')     swap("runnerApproveUrl(bypass ? '?go' : '?details', n)", "runnerApproveUrl(bypass ? '' : '?details', n)");
	return src;
}

const NAMES = ['Pending', 'runnerPoll', 'runnerSettle', 'submitTile', 'submitOpenDiff', 'submitChallenge', 'submitBody'];
const OWN = /^(runner|RUNNER_|_runner|submit|SUBMIT_|_submit|plain|PLAIN_|_plain|ship|SHIP_|_ship|relay|_relay)/;
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

function el(tag) {
	return { tag, className: '', textContent: '', children: [], attrs: {}, on: {},
		appendChild(c) { this.children.push(c); return c; }, addEventListener(t, f) { this.on[t] = f; }, setAttribute(k, v) { this.attrs[k] = v; } };
}
const walk = (e, out = []) => { out.push(e); for (const c of e.children) walk(c, out); return out; };

function page(o) {
	o = o || {};
	const win = makeWindow();
	const st = { fetches: [], list: [], whole: {}, install: o.install === undefined ? INSTALL : o.install, unlocked: o.locked ? false : true, level: o.level || 'bypass' };
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
	win.DaimondHandMode = { get: () => st.level };
	win.DaimondNet = { runnerApprove: () => (o.approve === undefined ? 'https://runner.test.daimond.app/approve' : o.approve) };
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
		toast: () => {}, diamonds: o.diamonds || [], currentDiamond: null, selectDiamond: async () => {}, turnHold: () => null, confirmHold: async () => {},
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

/// The body Kimberlite's plain route posts for vector `v` (runner-a 19:02), `extra` over it.
function plainBody(v, extra) {
	return Object.assign({
		v: 'plain/1', card: v.card_b64u, summary: v.summary, branch: v.branch, commit: v.commit, repo: v.repo,
		release_ref: v.commit, page_code: String(v.page_code), runner_code: String(v.runner_code), approve: '1',
		chat: v.chat, diamond: v.diamond, diamond_name: v.diamond_name,
		seq: String(v.seq), checks: v.checks.map((c) => ({ name: c.name, result: String(c.result), runs: String(c.runs) })),
	}, extra || {});
}
/// One plain entry on the relay, read whole by its nonce as the listing gives flags alone.
function plainEntry(pg, tag, v, extra) {
	const nn = nonce(tag, 1), text = JSON.stringify(plainBody(v, extra));
	pg.st.whole[nn] = { nonce: nn, kind: 'submit', install: INSTALL, body: text, answered: false, alarmed: false, expires_in: 600, answers: [] };
	return { list: [{ nonce: nn, kind: 'submit', answered: false, alarmed: false, expires_in: 600 }], nonce1: nn, seq: Number(v.seq) < 1e12 ? Number(v.seq) : 0 };
}
const texts = (els) => els.map((e) => e.textContent).filter(Boolean);
const approveOf = (els) => els.find((e) => String(e.className).indexOf('pend-submit-approve') >= 0);
const detailsOf = (els) => els.find((e) => String(e.className).indexOf('pend-plain-details') >= 0);
const V0 = PV1.vectors[0];
async function shown(o, v, extra) {
	const pg = page(o);
	const s = plainEntry(pg, 'P', v || V0, extra);
	pg.st.list = s.list;
	await pg.fns.runnerPoll();
	const it = pg.tiles()[0];
	return { pg, s, it, els: it ? await pg.draw(it) : [] };
}

console.log("a daimon's change on the plain route as a Pending card (D-20261106-13 (1))");

await kase('one plain entry, no chunks, makes one tile headed "A daimon is changing Daimond: <summary>"', async () => {
	const { pg, s, it } = await shown();
	eq(pg.A.live().filter((a) => a.diamond === pg.A.RUNNER).map((a) => a.key), ['submit.' + s.nonce1 + '.' + s.seq], 'one synced item');
	eq(it && it.headline, 'pending.plain.headline|summary=' + V0.summary, 'headline');
});

await kase('on Bypass: Approve and Details only; the details show after a further tap', async () => {
	const { pg, it, els } = await shown();
	const tx = texts(els);
	ok(approveOf(els), 'Approve offered: ' + JSON.stringify(tx));
	eq(approveOf(els).href, 'https://runner.test.daimond.app/approve?go#' + it.submit.nonce, 'approve link: ?go, no ?details');
	ok(detailsOf(els), 'Details offered');
	ok(!tx.some((x) => x.indexOf('pending.plain.check|') === 0 || x.indexOf('pending.plain.where|') === 0), 'no details before the tap: ' + JSON.stringify(tx));
	ok(!tx.some((x) => x.indexOf('pending.submit.see_diff') === 0), 'no diff on the phone');
	detailsOf(els).on.click();
	const t2 = texts(await pg.draw(it));
	ok(t2.indexOf('pending.plain.where|branch=' + V0.branch + ',commit=' + V0.commit.slice(0, 12) + ',repo=' + V0.repo) >= 0, 'where: ' + JSON.stringify(t2));
	ok(t2.indexOf('pending.plain.check|name=node --test www/js,result=pending.submit.passed,runs=1233') >= 0, 'checks');
	ok(t2.indexOf('pending.plain.chat|chat=' + V0.chat) >= 0, 'source chat');
});

await kase('on a stricter level the details show first, and the approve page is asked to open them', async () => {
	for (const level of ['guard', 'ask']) {
		const { it, els } = await shown({ level });
		const tx = texts(els);
		ok(tx.some((x) => x.indexOf('pending.plain.check|') === 0), level + ': checks first: ' + JSON.stringify(tx));
		ok(!detailsOf(els), level + ': no Details button');
		eq(approveOf(els) && approveOf(els).href, 'https://runner.test.daimond.app/approve?details#' + it.submit.nonce, level + ' link');
	}
});

await kase('the page-code line shows exactly when the card sends page_code 1', async () => {
	const a = texts((await shown()).els);
	ok(a.indexOf('pending.plain.page_code') >= 0, 'flag shown for page_code 1');
	const b = texts((await shown({}, PV1.vectors[1])).els);
	ok(b.indexOf('pending.plain.page_code') < 0, 'no flag for page_code 0');
});

await kase('the Kimberlite-code line shows exactly when the card sends runner_code 1', async () => {
	ok(texts((await shown({}, PV1.vectors[2])).els).indexOf('pending.plain.runner_code') >= 0, 'line shown for runner_code 1');
	ok(texts((await shown()).els).indexOf('pending.plain.runner_code') < 0, 'no line for runner_code 0');
});

await kase('the diamond is shown by the name the card signs, over this page\'s own name for it, never by its id', async () => {
	const named = texts((await shown({ diamonds: [{ id: V0.diamond, name: 'Weekday work' }] })).els);
	ok(named.indexOf('pending.plain.diamond|name=' + V0.diamond_name) >= 0, 'signed name: ' + JSON.stringify(named));
	for (const v of PV1.vectors) {
		const sent = texts((await shown({}, v)).els);
		ok(sent.indexOf('pending.plain.diamond|name=' + v.diamond_name) >= 0, v.name + ': ' + JSON.stringify(sent));
	}
});

await kase("the approve address is the gateway's; with none named, no Approve and a line says why", async () => {
	const { els } = await shown({ approve: null });
	ok(!approveOf(els), 'no Approve without an address');
	ok(texts(els).indexOf('pending.runner.no_approve') >= 0, 'says why: ' + JSON.stringify(texts(els)));
});

await kase('pending.js holds no approve address of its own (D-20261026-02)', async () => {
	const code = readFileSync(join(HERE, 'page/pending.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
	ok(!/https?:\/\/[^'"\s]*runner/.test(code), 'a runner address literal is in pending.js');
});

await kase('approve 0: "review: pending" and no Approve', async () => {
	const { els } = await shown({}, V0, { approve: '0' });
	ok(texts(els).indexOf('pending.plain.review_pending') >= 0, 'review pending shown');
	ok(!approveOf(els), 'no Approve');
});

await kase('every shown field is checked against the decoded card: a mismatch says so and offers no Approve', async () => {
	const edits = { repo: { repo: 'fe2o3' }, branch: { branch: 'live' }, commit: { commit: 'ab'.repeat(20) },
		summary: { summary: 'Something harmless.' }, chat: { chat: 'other' }, seq: { seq: '2' }, page_code: { page_code: '0' },
		diamond: { diamond: 'Other' }, diamond_name: { diamond_name: 'Other garden' }, runner_code: { runner_code: '1' },
		release_ref: { release_ref: 'ab'.repeat(20) },
		check: { checks: [{ name: 'node --test www/js', result: '2', runs: '1233' }, { name: 'cargo test --lib', result: '1', runs: '6456' }] },
		card: { card: V0.card_b64u.slice(0, -2) } };
	for (const k in edits) {
		const { els } = await shown({}, V0, edits[k]);
		ok(texts(els).indexOf('pending.plain.card_bad') >= 0 && !approveOf(els), k + ': refused: ' + JSON.stringify(texts(els)));
	}
	for (const v of PV1.vectors) {
		const { els } = await shown({}, v);
		ok(texts(els).indexOf('pending.plain.card_bad') < 0 && approveOf(els), v.name + ': vector accepted');
	}
});

await kase('after his tap: Approved, then Deployed ... proof pending; never Live', async () => {
	const { pg, s, it, els } = await shown();
	approveOf(els).on.click();
	pg.st.whole[s.nonce1].answered = true;
	pg.st.list = [{ ...s.list[0], answered: true }];
	await pg.fns.runnerPoll();
	const t1 = texts(await pg.draw(pg.tiles()[0]));
	ok(t1.indexOf('pending.plain.approved') >= 0, 'approved: ' + JSON.stringify(t1));
	pg.st.list = [{ ...s.list[0], answered: true, done: true }];
	await pg.fns.runnerPoll();
	const t2 = texts(await pg.draw(pg.tiles()[0]));
	ok(t2.indexOf('pending.submit.deployed|commit=' + V0.commit.slice(0, 12)) >= 0, 'deployed: ' + JSON.stringify(t2));
	ok(!t1.concat(t2).some((x) => /\bLive\b/.test(x)), 'never Live');
});

console.log((failures ? 'FAIL' : 'PASS') + ' plainpending: ' + (cases - failures) + '/' + cases + (BREAK ? ' (break ' + BREAK + ')' : ''));
if (failures) process.exitCode = 1;
