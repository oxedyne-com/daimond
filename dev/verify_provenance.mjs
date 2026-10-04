// gateway: live
// verify_provenance.mjs — every product carries the record of who made it, and the
// record is the one the WIRE says (U1 of the per-product rating design,
// ~/usr/code/ai/claude/specs/daimond_product_rating_design_20260924.md §3 and §11).
//
// A rating is only worth its key. A record that names the model the page THINKS it
// used, rather than the one the request carried, files every rating under the wrong
// model and nothing on screen would ever say so. So each record here is compared with
// what the mock provider actually received -- the `model` of the request and the
// system message it was sent -- and never with a field this file has just set.
//
// Two paired devices of one Pro account on the real gateway: A is a phone, which hands
// its turns to B, the desktop that runs them. What is proved:
//
//   H  HAND-OFF. A's turn runs on B. Every streamed copy of the answer that reaches A --
//      the rows off the progress door and the provisional message A holds -- carries a
//      record byte-identical to the final copy's, and to B's own copy. `m` is the model
//      the request carried; `dev` is the runner; `sp` is a fingerprint of a block of text
//      the request's system message really holds.
//   C  CHAT `sp`. Stable across two turns; changed, and naming the new text, after
//      `prompts/chat.md` is edited; back to the first value when the file is removed.
//   F  FOLD. A fold asked for by hand leaves a `fold_log` carrying kind `crystal`, role
//      `compactor`, the compactor request's model and a fingerprint of its prompt.
//   M  MAIL. A `mail_draft` row is filed under its draft's path (`k:'mail'`), with the
//      turn's own provenance.
//   D  DIAMOND. A daimon answer names the Diamond's model (not the default); a turn that
//      writes a file itself and has a worker write another gives two manifest rows whose
//      `Entry.by` names each writer -- the worker by ITS model, as its request carried --
//      and the changed-files note carries one record per row. The daimon's `sp` behaves
//      as the chat's does, over `prompts/daimon.md`.
//   P  PROPOSAL. A triggered turn's reply raised on Pending carries the answer's record
//      under `p1:proposal:<id>`. Checked on the producing device only: Pending is
//      localStorage and does not sync.
//   R  RELAY. A chat's worker whose report lands while nobody is looking is relayed as
//      one message carrying one `worker` record per report.
//   O  OLD SHAPE. A message written with no record (as every build before U1 wrote them)
//      loads, renders, syncs and stays record-less: nothing stamps it after the fact.
//   S  SYNC. B's products reach A carrying byte-identical records, and a reload of B
//      reads back exactly what it wrote.
//   X  5.3.0 (U3, V1 of the rating U3+U4 plan, written RED on 5.2.9): X1 a call that writes outside a
//      capture is credited to its caller with `via: 'command'` (native-only, see the NOT COVERED line);
//      X2 a daimon turn on a Diamond that predates the seeded files lists none of the three and every
//      record carries `via`; X3 a chat turn appends one `files_log` whose records are the store's own rows
//      (hash and body, as on 5.2.9) and the undo toast says 2, as on 5.2.9;
//      X4 every Prod read anywhere in the run carries the 18 v2 keys in order.
//
// EACH CHECK FAMILY IS PROVED AGAINST BROKEN CODE. `--break <name>` serves a damaged
// `www/js/daimond.js` through `page.route` and runs the one section it damages; the run
// must go red there:
//
//   node dev/verify_provenance.mjs --break nolive        # H: the streamed row carries no record
//   node dev/verify_provenance.mjs --break defaultmodel  # D: a daimon answer names the default model
//   node dev/verify_provenance.mjs --break mailanswer    # M: a draft row filed as the answer
//   node dev/verify_provenance.mjs                       # and then, clean
//
// `--only H,C,…` runs the named sections (S and O need C and M's products to compare).
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT) and a gateway on
// DAIMOND_GW_PORT; the wasm must carry `prompt_fingerprint` (dev/build-wasm.sh).
//   eval "$(bash dev/world.sh N --env)"
//   node dev/verify_provenance.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, signInAs, newChat, connectMock, mockLog, errors, shot } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { checker, until, settle, storedMsgs, answersFor, placeholders, send, freshChat } from './handoffpair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

// ── Breaks ──────────────────────────────────────────────────────────────
const BREAKS = {
	nolive: { section: 'H',
		what: 'the live answer row a runner streams carries no record',
		from: '\t\tif (_liveProd[id]) live.prod = [_liveProd[id]];\n',
		to:   '' },
	defaultmodel: { section: 'D',
		what: 'a daimon answer names the starred default instead of the model its app was built on',
		from: "m: _diamondAppModel.get(fa) || '', pv: _diamondAppProvider.get(fa) || '',",
		to:   "m: (DaimondModels.getDefault() || {}).model || '', pv: _diamondAppProvider.get(fa) || ''," },
	mailanswer: { section: 'M',
		what: 'a mail_draft row carries the answer’s record rather than its own',
		from: "return DaimondProvenance.rekind(base, 'mail', DaimondProvenance.h.mail(d.path));",
		to:   'return base;' },
};
const arg = (flag) => { const i = process.argv.indexOf(flag); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };
const BREAK = arg('--break');
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
// Every break is matched on every run, so one whose anchor has drifted fails loudly
// rather than sitting there as a check that cannot fail.
{
	const src = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
	const stale = Object.entries(BREAKS).filter(([, b]) => src.split(b.from).length !== 2).map(([n]) => n);
	if (stale.length) { console.error('break(s) no longer match www/js/daimond.js once: ' + stale.join(', ')); process.exit(2); }
}
const ONLY = new Set((arg('--only') || (BREAK ? BREAKS[BREAK].section : 'H,C,N,F,M,D,P,R,O,S,X'))
	.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const on = (sec) => ONLY.has(sec);
let ROUTE = null;
if (BREAK) {
	const b = BREAKS[BREAK];
	const broken = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8').replace(b.from, b.to);
	console.log(`\n*** BREAK ${BREAK}: ${b.what} — failures below are the point ***\n`);
	ROUTE = async (page) => {
		await page.route('**/js/daimond.js*', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: broken }));
	};
}

const { ok, bad, check } = checker();
const GLM   = 'accounts/fireworks/models/glm-5p2';	// in the mock's list; glm-5.2 in the catalogue
const THINK = 'mock/thinker';
const J = (o) => JSON.stringify(o);
/// A single product's record: a message's `prod` is a list, and an answer, a fold, a mail row
/// or a proposal carries exactly one.
const PROD_KEYS = 'h,k,m,pv,cm,fam,fi,cls,role,sp,d,c,t,dev,at,hash,run';
/// The v2 record (U3 plan section 2): `via` last, '' or 'command'. checkRec's per-record check uses it (flipped at P1a's
/// 4b728825, as the lead asked): on 5.2.9 itself every section's declared-shape check is therefore red, and --only X is the
/// section that reads red there alone; the 135/0 baseline is the commit before this one (954ec67e).
const PROD_KEYS_V2 = PROD_KEYS + ',via';
const one = (m) => (m && Array.isArray(m.prod) && m.prod.length === 1) ? m.prod[0] : null;
/// An answer's words: the mock streams each with a trailing space, so `@text X` lands as "X ".
const said = (m) => String((m && m.content) || '').trim();

// ── The wire ────────────────────────────────────────────────────────────

/// `sp1:` and 8 hex of SHA-256 -- computed HERE, by node, not by the wasm under test.
const spOf = (text) => 'sp1:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

/// The block of `system` whose fingerprint is `sp`, or null. A block is any run between
/// paragraph breaks (`\n\n`), because the instructions are one layer of the message and
/// the layers are joined that way. Finding one proves the record fingerprints text the
/// request really carried.
function spanOf(system, sp) {
	const s = String(system || '');
	if (!sp) return null;
	const cuts = [0];
	for (let i = s.indexOf('\n\n'); i >= 0; i = s.indexOf('\n\n', i + 1)) { cuts.push(i); cuts.push(i + 2); }
	cuts.push(s.length);
	const starts = [0], ends = [s.length];
	for (let i = 1; i < cuts.length - 1; i += 2) { ends.push(cuts[i]); starts.push(cuts[i + 1]); }
	for (const a of starts) for (const e of ends) {
		if (e <= a) continue;
		const t = s.slice(a, e);
		if (spOf(t) === sp) return t;
	}
	// A DAIMON'S INSTRUCTIONS ARE TWO PIECES OF THE MESSAGE, not one. On the wire come the
	// role, the Diamond's own paragraph (`local`, which changes whenever its folder or crystal
	// does, and which nobody fingerprints), the user's standing instructions, and then the
	// engine's tool list and crystal. The record fingerprints the role and the standing
	// instructions joined as `with_instructions(role)` joins them, so the wire check is a
	// leading block joined to a block that starts at that heading: both pieces the request
	// really carried, and nothing else.
	const si = s.indexOf(STANDING);
	if (si > 0) {
		for (const e of ends) {
			if (e > si || e <= 0) continue;
			for (const f of ends) {
				if (f <= si) continue;
				const t = s.slice(0, e) + s.slice(si, f);
				if (spOf(t) === sp) return t;
			}
		}
	}
	return null;
}
const STANDING = '\n\n## Standing instructions from the user\n\n';
const lastUser = (e) => {
	const ms = (e && e.messages) || [];
	const l = ms.length ? ms[ms.length - 1] : null;
	return (l && l.role === 'user' && typeof l.content === 'string') ? l.content : '';
};
const sysOf = (e) => {
	const m = ((e && e.messages) || []).find((x) => x.role === 'system');
	return m ? (typeof m.content === 'string' ? m.content : J(m.content)) : '';
};
/// The first request since `from` whose last message is the user's `text` -- exactly, or
/// leading a message the page added to (a trigger's composed instruction, say).
const reqFor = (from, text) => {
	const reqs = mockLog().slice(from);
	return reqs.find((e) => lastUser(e) === text) || reqs.find((e) => lastUser(e).startsWith(text)) || null;
};

// ── The pair ────────────────────────────────────────────────────────────

/// Wait for the boot's gate, as `handoffpair.mjs` does, before signing in.
async function gateUp(s) {
	await s.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 90000 }).catch(() => {});
}

/// `handoffpair.mjs`'s pair, with this run's route on both devices so a break reaches the
/// runner as well as the phone.
async function pair(lead, mate) {
	const a = await open({ name: lead, touch: true, signIn: false, connect: false, route: ROUTE });
	a.account = lead; a.name = lead; a.touch = true;
	await gateUp(a);
	await signInAs(a, lead);
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, J(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	const b = await open({ name: mate, signIn: false, connect: false, route: ROUTE });
	b.account = lead; b.name = mate;
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(b);
	await signInAs(b, lead);
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	// Retried: under load the settings form's model fetch can miss the first time.
	for (let i = 0; i < 3; i++) {
		const got = await connectMock(b);
		if (got && got.model) break;
		await b.page.waitForTimeout(1500);
	}
	await b.page.waitForTimeout(2000);
	await settle(b.page);
	await until(b.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } }, null, 8000);
	await b.page.evaluate((n) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n), mate);
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	const aSeesB = await a.page.evaluate((self) => (window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);
	return { a, b, idA, idB };
}

// ── Reading a device ────────────────────────────────────────────────────

/// Every stored message of chat `cid` on `s`, in order.
const msgsOf = (s, cid) => s.page.evaluate(async (cid) => {
	try {
		const got = await window.DaimondCore.chatStore().loadMessages(cid);
		return (got && got.messages) || [];
	} catch (e) { return []; }
}, cid).catch(() => []);

/// Wait until chat `cid` on `s` holds a message `pred` accepts, and answer it.
async function waitMsg(s, cid, pred, ms = 60000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const m = (await msgsOf(s, cid)).find(pred);
		if (m) return m;
		await s.page.waitForTimeout(400);
	}
	return null;
}

/// The chat in focus on `s`.
const focusId = (s) => s.page.evaluate(() => {
	try { const f = window.DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; }
	catch (e) { return ''; }
});

/// One chat turn on `s`, answered by the mock with `@text <word>`: its answer, its request.
async function textTurn(s, cid, word) {
	const from = mockLog().length;
	const text = '@text ' + word;
	await chat(s, text, { timeout: 45000 });
	const ans = await waitMsg(s, cid, (m) => m.role === 'assistant' && said(m) === word, 30000);
	if (!ans && process.env.PROV_DEBUG) {
		const ms = await msgsOf(s, cid);
		console.log('  DEBUG textTurn', word, 'cid', cid, 'focus', await focusId(s), 'n', ms.length,
			J(ms.map((m) => [m.role, String(m.content || '').slice(0, 40), !!m.prod])).slice(0, 600));
	}
	return { ans, req: reqFor(from, text), text };
}

/// Write or remove a file in Daimond's own store, as `verify_prompts.mjs` does: through a
/// scratch engine's own file tools.
const storeWrite = (s, p, content) => s.page.evaluate(async ({ p, content }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	await app.run_tool('dir_create', JSON.stringify({ path: p.split('/')[0] }));
	return await app.run_tool('file_write', JSON.stringify({ path: p, content }));
}, { p, content });
const storeRemove = (s, p) => s.page.evaluate(async (p) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app.run_tool('file_delete', JSON.stringify({ path: p }));
}, p);
const refreshPrompts = async (s) => {
	await s.page.evaluate(() => window.DaimondPrompts.refresh());
	await s.page.waitForTimeout(600);
};

/// The record's fields other than its handle and kind, for comparing a product with the
/// answer it was cut from.
const sansHK = (p) => { const o = Object.assign({}, p || {}); delete o.h; delete o.k; delete o.at; return J(o); };

/// The standard checks of one record against the request that produced it.
function checkRec(tag, prod, req, want) {
	const p = prod || {};
	check(`${tag}: carries a record`, !!prod && typeof p.h === 'string' && p.h.startsWith('p1:'), J(p).slice(0, 160));
	if (!prod) return;
	// THE DECLARED SHAPE: every field of `Prod`, always, in order (U1 fix brief §3.1), since the
	// sync contract's record type is exact and has no optional field.
	check(`${tag}: carries every field of the declared Prod (v2: via last), in order`, Object.keys(p).join(',') === PROD_KEYS_V2
		&& typeof p.fi === 'boolean' && (p.via === '' || p.via === 'command'), Object.keys(p).join(','));
	check(`${tag}: kind ${want.k}, role ${want.role}`, p.k === want.k && p.role === want.role, p.k + '/' + p.role);
	if (want.h) check(`${tag}: handle ${want.h}`, p.h === want.h, p.h);
	check(`${tag}: m is the model the request carried`, !!req && p.m === req.model,
		'record ' + p.m + ', wire ' + (req ? req.model : '(no request found)'));
	if (want.m) check(`${tag}: which is ${want.m}, not the default`, p.m === want.m, p.m);
	if (want.dev) check(`${tag}: dev is the device that ran it`, p.dev === want.dev, p.dev);
	const span = req ? spanOf(sysOf(req), p.sp) : null;
	check(`${tag}: sp fingerprints a block of the system message actually sent`, !!span,
		p.sp + (span ? ' over ' + span.length + ' chars: ' + J(span.slice(0, 50)) : ' matched nothing'));
	return span;
}

// ═══════════════════════════════════════════════════════════════════════
let a, b, idA = '', idB = '', DEF = '';
const keep = {};			// B's products, by name, for the sync comparison
try {
	({ a, b, idA, idB } = await pair('provlead', 'provmate'));
	check('A and B are distinct devices', !!idA && !!idB && idA !== idB);
	DEF = await b.page.evaluate(() => (window.DaimondModels.getDefault() || {}).provider || '');
	check('B has a default provider to run on', !!DEF, DEF);

	// ══ H. A hand-off: every streamed copy carries the final copy's record ══
	if (on('H')) {
		await a.page.evaluate(() => {
			window.__prov = [];
			const P = window.DaimondPeer, real = P.foldProvisional;
			P.foldProvisional = function (msgs, turnId, rows) {
				// The rows as they came off the door, then the provisional messages A keeps.
				try {
					(rows || []).forEach((r) => {
						if (r && r.role === 'assistant') window.__prov.push({ src: 'frame', mid: String(r.mid),
							len: String(r.content || '').length, prod: r.prod ? JSON.stringify(r.prod) : '' });
					});
				} catch (e) { /* observation only */ }
				const out = real.apply(this, arguments);
				try {
					(out || []).forEach((m) => {
						if (m && m.provisional && m.role === 'assistant') window.__prov.push({ src: 'held',
							mid: String(m.mid), len: String(m.content || '').length, prod: m.prod ? JSON.stringify(m.prod) : '' });
					});
				} catch (e) { /* observation only */ }
				return out;
			};
		});
		const prompt = '@long 60';
		await freshChat(a);
		const hcid = await focusId(a);
		const from = mockLog().length;
		await send(a.page, prompt);
		let ph = null;
		for (let i = 0; i < 120 && !ph; i++) {
			ph = placeholders(await storedMsgs(a)).find((m) => m.itext === prompt) || null;
			if (!ph) await a.page.waitForTimeout(250);
		}
		check('H: A handed the turn off (a dispatched placeholder)', !!ph);
		const tid = ph ? String(ph.iturn) : '';
		let fin = null;
		for (let i = 0; i < 600 && !fin; i++) {
			fin = answersFor(await storedMsgs(a), tid).find((m) => /chunk-60/.test(m.content)) || null;
			if (!fin) await a.page.waitForTimeout(250);
		}
		check('H: the finished answer reached A', !!fin);
		const seen = await a.page.evaluate(() => window.__prov || []);
		const mine = fin ? seen.filter((r) => r.mid === String(fin.mid)) : [];
		const early = fin ? mine.filter((r) => r.len < String(fin.content).length) : [];
		check('H: A folded streamed copies of the answer before it finished', early.length > 0,
			mine.length + ' streamed row(s), ' + early.length + ' mid-stream');
		const want = fin && fin.prod ? J(fin.prod) : '';
		check('H: the final copy on A carries a record', !!want, want.slice(0, 120));
		check('H: every streamed copy (door rows and held rows) carries it byte for byte',
			mine.length > 0 && mine.every((r) => r.prod === want),
			mine.filter((r) => r.prod !== want).length + ' differ of ' + mine.length
			+ (mine.find((r) => r.prod !== want) ? ': ' + (mine.find((r) => r.prod !== want).prod || '(none)').slice(0, 100) : ''));
		const bCopy = fin ? (await storedMsgs(b)).find((m) => String(m.mid) === String(fin.mid)) : null;
		check('H: B, which ran it, holds the same record', !!bCopy && J(bCopy.prod) === want,
			bCopy ? (J(bCopy.prod) || '(none)').slice(0, 100) : 'B has no copy');
		const req = reqFor(from, prompt);
		checkRec('H answer', one(fin), req, { k: 'answer', role: 'chat', dev: idB,
			h: fin && hcid ? `p1:answer:${hcid}/${fin.mid}` : '' });
		const au = (await msgsOf(a, hcid)).find((m) => m.role === 'user' && m.content === prompt);
		check('H: t names the turn', !!fin && !!one(fin) && (one(fin).t === tid || (au && one(fin).t === String(au.mid))),
			't ' + (one(fin) ? one(fin).t : '') + ', turn ' + tid + ', user mid ' + (au ? au.mid : ''));
	}

	// ══ C. The chat's fingerprint, and F. the fold ══════════════════════
	let ccid = '';
	if (on('C') || on('F') || on('S')) {
		ccid = await newChat(b);
		const c1 = await textTurn(b, ccid, 'C-ONE');
		const c2 = await textTurn(b, ccid, 'C-TWO');
		checkRec('C1', one(c1.ans), c1.req, { k: 'answer', role: 'chat', dev: idB,
			h: c1.ans ? `p1:answer:${ccid}/${c1.ans.mid}` : '' });
		checkRec('C2', one(c2.ans), c2.req, { k: 'answer', role: 'chat', dev: idB });
		const sp1 = one(c1.ans) ? one(c1.ans).sp : '', sp2 = one(c2.ans) ? one(c2.ans).sp : '';
		check('C: sp is stable across two turns', !!sp1 && sp1 === sp2, sp1 + ' / ' + sp2);
		check('C: B ran them itself', !!c1.ans && !!one(c1.ans) && one(c1.ans).dev === idB);

		const MARK_C = 'You are PROVMARK-C, and you answer in as few words as will do.';
		await storeWrite(b, 'prompts/chat.md', MARK_C);
		await refreshPrompts(b);
		const c3 = await textTurn(b, ccid, 'C-THREE');
		const span3 = checkRec('C3', one(c3.ans), c3.req, { k: 'answer', role: 'chat' });
		const sp3 = one(c3.ans) ? one(c3.ans).sp : '';
		check('C: an edited prompts/chat.md was sent', !!c3.req && sysOf(c3.req).includes('PROVMARK-C'));
		check('C: and moved sp', !!sp3 && sp3 !== sp1, sp1 + ' -> ' + sp3);
		check('C: to a fingerprint of text holding the edit', !!span3 && span3.includes('PROVMARK-C'));
		await storeRemove(b, 'prompts/chat.md');
		await refreshPrompts(b);
		const c4 = await textTurn(b, ccid, 'C-FOUR');
		const sp4 = one(c4.ans) ? one(c4.ans).sp : '';
		check('C: removing the file puts sp back where it was', !!sp4 && sp4 === sp1, sp4 + ' vs ' + sp1);
		keep.chat = { cid: ccid, mids: [c1, c2, c3, c4].map((t) => t.ans && String(t.ans.mid)).filter(Boolean) };

		if (on('F') || on('S')) {
			// A FOLD NEEDS SOMETHING TO CUT. A hand fold cuts only what lies behind the kept tail,
			// and the tail is a share of the budget (`Limits::tail_budget`): at the shipped
			// 120k ceiling a chat of short turns fits it whole, and "Fold now" answers "Nothing to
			// fold" with no request at all. So the ceiling is lowered to its 16k floor through the
			// user's own control (`#cfg-context-cap`, which rebuilds every agent), and three turns
			// of ~12 KB each, then three short ones, put the bulk behind the tail. Those turns may
			// fold on their own on the way -- the same `foldProd` stamps either fold -- so the first
			// fold_log after them is the one checked, against the first tool-less request that
			// the engine did not decline.
			const from = mockLog().length;
			const setCap = (k) => b.page.evaluate((k) => {
				const sel = document.getElementById('cfg-context-cap');
				if (!sel) return 'no context ceiling control';
				if (![...sel.options].some((o) => o.value === k)) {
					const o = document.createElement('option'); o.value = k; o.textContent = k + 'k'; sel.appendChild(o);
				}
				sel.value = k;
				sel.dispatchEvent(new Event('change', { bubbles: true }));
				return '';
			}, k);
			// AND A SUMMARY THAT IS SHORTER THAN WHAT IT REPLACES. The mock's default answer to a
			// fold echoes the transcript back, which the engine rightly declines as a fold that
			// changed nothing ("Nothing to fold", no fold_log); its structured mode answers a
			// note in the layout the compactor asks for (`dev/mockllm.mjs` `foldMode`).
			const foldFile = String(process.env.DAIMOND_MOCK_LOG || '') + '.fold';
			if (process.env.DAIMOND_MOCK_LOG) {
				fs.writeFileSync(foldFile, 'structured');
				// Gone however this run ends, so the world's mock is not left folding in a mode
				// the next verifier did not ask for.
				process.on('exit', () => { try { fs.unlinkSync(foldFile); } catch (e) { /* already gone */ } });
			}
			const capped = await setCap('16');
			check('F: the context ceiling is lowered to its floor for the fold', capped === '', capped);
			const before = (await msgsOf(b, ccid)).length;
			const filler = Array.from({ length: 3000 }, (_, i) => 'w' + (i % 97)).join(' ');
			for (let i = 1; i <= 3; i++) {
				await chat(b, '@text BULK-' + i + ' ' + filler, { timeout: 90000 });
				await waitMsg(b, ccid, (m) => m.role === 'assistant' && said(m).startsWith('BULK-' + i + ' '), 60000);
			}
			// Then three short turns, so the bulk is BEHIND the six messages a fold always keeps
			// (`compact::MIN_KEEP_MESSAGES`): a fold whose note outweighs what it cut is declined
			// as one that made the conversation bigger.
			for (let i = 1; i <= 3; i++) await textTurn(b, ccid, 'F-SHORT-' + i);
			const foldSince = async () => (await msgsOf(b, ccid)).slice(before).find((m) => m.role === 'fold_log') || null;
			let fl = await foldSince();
			if (process.env.PROV_DEBUG) {
				const ms = await msgsOf(b, ccid);
				console.log('  DEBUG F errors', J(errors(b).slice(-6)).slice(0, 1200));
				console.log('  DEBUG F after bulk', before, ms.length, J(ms.slice(Math.max(0, before - 2)).map((m) => [m.role, String(m.content || '').slice(0, 24), m.folded || 0])));
			}
			if (!fl) {
				// An ordinary chat folds from its tile dialog (`#chat-fold-btn` is a daimon chat's,
				// and folds INTO the Diamond, which is the reducer's act and not this one).
				const pressed = await b.page.evaluate((cid) => new Promise((res) => {
					const box = document.querySelector(`.session-box.chat-box[data-id="${cid}"]`);
					const cog = box && box.querySelector('.tile-cog');
					if (!cog) { res('no cog on the chat tile'); return; }
					cog.click();
					setTimeout(() => {
						const card = [...document.querySelectorAll('.modal.dlg .dlg-card')].find((c) => c.getClientRects().length);
						const btn = card && [...card.querySelectorAll('.tile-dlg-level')].find((x) => /fold now/i.test(x.textContent || ''));
						if (!btn) { res('no fold-now button'); return; }
						btn.click();
						res('');
					}, 300);
				}), ccid);
				check('F: the chat’s tile dialog offers Fold now', pressed === '', pressed);
				await b.page.waitForTimeout(700);
				const okd = await b.page.evaluate(() => {
					const btns = [...document.querySelectorAll('.modal .dlg-ok')].filter((x) => x.getClientRects().length);
					const btn = btns[btns.length - 1];
					if (!btn) return 'no visible OK';
					btn.click();
					return '';
				});
				check('F: the fold is confirmed', okd === '', okd);
				if (process.env.PROV_DEBUG) {
					await b.page.waitForTimeout(2500);
					console.log('  DEBUG F', J(await b.page.evaluate(() => ({
						modals: [...document.querySelectorAll('.modal')].filter((x) => x.getClientRects().length).map((x) => (x.innerText || '').slice(0, 160)),
						toasts: [...document.querySelectorAll('.toast, [class*="toast"]')].map((x) => (x.innerText || '').slice(0, 160)).filter(Boolean),
					}))));
				}
				const t0 = Date.now();
				while (!fl && Date.now() - t0 < 60000) { await b.page.waitForTimeout(400); fl = await foldSince(); }
				await b.page.evaluate(() => {
					const x = [...document.querySelectorAll('.modal.dlg .tile-dlg-x')].find((e) => e.getClientRects().length);
					if (x) x.click();
				});
			} else {
				console.log('  ..    a turn folded on its own at the lowered ceiling; that fold is the one checked');
			}
			check('F: a fold_log landed', !!fl, fl ? String(fl.content).slice(0, 80) : '');
			const creq = mockLog().slice(from).find((e) => !(e.tools || []).length) || null;
			check('F: the compactor was asked (a tool-less request)', !!creq, creq ? creq.model : '');
			checkRec('F fold_log', one(fl), creq, { k: 'crystal', role: 'compactor', dev: idB,
				h: fl ? `p1:crystal:${ccid}/${fl.mid}` : '' });
			if (one(fl)) keep.fold = { cid: ccid, mid: String(fl.mid) };
			try { if (process.env.DAIMOND_MOCK_LOG) fs.unlinkSync(foldFile); } catch (e) { /* already gone */ }
			const restored = await setCap('0');
			check('F: and the ceiling is put back to the default', restored === '', restored);
		}
	}

	// ══ N. A steering note moves sp when it is activated, and at no other time (5.3.2, plan C5) ══════
	// `sp` fingerprints the composed prompt, so a note that reaches the prompt moves it once, when it is kept; a note for another
	// model, a turn, a rating landing and a reload leave it; retiring the note puts the first value back.
	if (on('N')) {
		const NL = 'Reply in plain sentences, without a heading, unless a heading is asked for.', NO = 'Name the file you changed at the end of every change.';
		const havePage = await b.page.evaluate(() => !!(window.DaimondNotes && DaimondNotes.add && DaimondNotes.retire));
		check('N: the page can keep a note (DaimondNotes.add, retire)', havePage);
		const ncid = await newChat(b);
		const spOf2 = (t) => (one(t.ans) ? one(t.ans).sp : '');
		const n1 = await textTurn(b, ncid, 'N-ONE'), n2 = await textTurn(b, ncid, 'N-TWO');
		const s1 = spOf2(n1);
		check('N: with no note sp is stable across two turns', !!s1 && s1 === spOf2(n2), s1 + ' / ' + spOf2(n2));
		if (havePage) {
			const other = await b.page.evaluate((l) => DaimondNotes.add({ level: 3, scope: '', cm: 'a-model-nobody-runs', tag: 'tool', line: l, at: { t: 3, n: 9 } }), NO);
			const n3 = await textTurn(b, ncid, 'N-THREE');
			check('N: a note for another model leaves sp where it was, and the wire holds no block', spOf2(n3) === s1 && !!n3.req && !sysOf(n3.req).includes('## Standing notes from this user'), spOf2(n3));
			const mine = await b.page.evaluate((l) => DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'long', line: l, at: { t: 7, n: 20 } }), NL);
			const n4 = await textTurn(b, ncid, 'N-FOUR');
			const span4 = checkRec('N4', one(n4.ans), n4.req, { k: 'answer', role: 'chat', dev: idB });
			const s4 = spOf2(n4);
			check('N: keeping a note for the model moves sp', !!s4 && s4 !== s1, s1 + ' -> ' + s4);
			check('N: to a fingerprint of text holding the note', !!span4 && span4.includes(NL) && !span4.includes(NO));
			const n5 = await textTurn(b, ncid, 'N-FIVE');
			check('N: and the next turn, with no change, keeps it', spOf2(n5) === s4, s4 + ' / ' + spOf2(n5));
			const mid = n5.ans ? String(n5.ans.mid) : '';
			await b.page.locator(`#chat-output .ctile[data-mid="${mid}"] .ctile-rate-up >> visible=true`).first().click({ force: true });
			let rated = false; for (let i = 0; i < 40 && !rated; i++) { rated = (await msgsOf(b, ncid)).some((m) => m.role === 'rating_log'); if (!rated) await b.page.waitForTimeout(500); }
			const n6 = await textTurn(b, ncid, 'N-SIX');
			check('N: a rating landing between turns leaves sp where it was', rated && spOf2(n6) === s4, 'rated ' + rated + ', ' + s4 + ' / ' + spOf2(n6));
			await b.page.evaluate((n) => DaimondNotes.retire({ level: 3, scope: '', id: n.id }, { t: 7, n: 40 }), mine);
			await b.page.evaluate((n) => DaimondNotes.retire({ level: 3, scope: '', id: n.id }, { t: 3, n: 29 }), other);
			const n7 = await textTurn(b, ncid, 'N-SEVEN');
			check('N: retiring the notes puts the first sp back', spOf2(n7) === s1, s1 + ' vs ' + spOf2(n7));
		}
	}

	// ══ M. A mail draft is its own product ══════════════════════════════
	if (on('M') || on('S')) {
		await b.page.evaluate(async () => {
			const pass = await window.DaimondIdentity.wrap('not-a-real-password');
			// Seeded, as verify_compose.mjs seeds one: a draft is written to disk and nothing is
			// sent, so the mailbox needs no server. Port 1 answers nobody if anything tries.
			localStorage.setItem('daimond-mail', JSON.stringify({
				accounts: [{ address: 'prov@test.local', host: '127.0.0.1', port: 1, security: 'plain',
					smtpHost: '127.0.0.1', smtpPort: 1, smtpSecurity: 'plain', user: 'prov@test.local', pass,
					uidValidity: 0, lastUid: 0, lastSync: 0 }],
				sel: 'prov@test.local',
			}));
			window.DaimondMail.reload();
		});
		const mcid = await newChat(b);
		const from = mockLog().length;
		const text = '@tool mail_draft ' + J({ to: 'bob@test.local', subject: 'Provenance', body: 'A draft for the record.' });
		await chat(b, text, { timeout: 45000 });
		const row = await waitMsg(b, mcid, (m) => m.role === 'tool_log' && m.name === 'mail_draft', 30000);
		check('M: the mail_draft ran and filed a draft', !!row && row.outcome === 'done',
			row ? (row.outcome + ': ' + String(row.content).slice(0, 90)) : 'no row');
		const ans = await waitMsg(b, mcid, (m) => m.role === 'assistant' && !!m.prod, 20000);
		const dp = (String(row && row.content || '').match(/Draft saved to (\S+\.eml)/) || [])[1] || '';
		checkRec('M mail row', one(row), reqFor(from, text), { k: 'mail', role: 'chat', dev: idB,
			h: dp ? 'p1:mail:' + dp : '' });
		check('M: filed under a path in the mailbox’s drafts', /^mail\/prov@test\.local\/.*draft-[^/]+\.eml$/.test(dp), dp);
		check('M: with its turn’s own provenance', !!ans && !!row && !!one(row) && sansHK(one(row)) === sansHK(one(ans)),
			row && row.prod && ans ? '' : 'missing a record');
		if (one(row)) keep.mail = { cid: mcid, mid: String(row.mid) };
	}

	// ══ D. A Diamond: its daimon, its files and its worker ══════════════
	let D = '', rcid = '';
	if (on('D') || on('P')) {
		await b.page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await b.page.waitForSelector('.dlg-card', { timeout: 8000 });
		await b.page.evaluate((nm) => {
			const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
			const inp = card.querySelector('input.dlg-input');
			inp.value = nm; inp.dispatchEvent(new Event('input', { bubbles: true }));
			card.querySelector('.dlg-ok').click();
		}, 'Provenance ' + Date.now().toString(36));
		await b.page.waitForTimeout(1500);
		D = await b.page.evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
		check('D: a Diamond is made and on screen', !!D, D);
		// Its daimon on one model and its workers on another, neither the default, so a record
		// that read the wrong one is caught by the wire.
		await b.page.evaluate(({ D, DEF, THINK, GLM }) => {
			const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
			all[D] = { provider: DEF, model: THINK, workerProvider: DEF, workerModel: GLM,
				visionProvider: '', visionModel: '' };
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
		}, { D, DEF, THINK, GLM });
		rcid = await b.page.evaluate((D) => { const r = window.DaimondDiamond.conversation(D); return r ? r.id : ''; }, D);

		const daimonTurn = async (text, pred, ms = 90000) => {
			const from = mockLog().length;
			await b.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
			await b.page.waitForTimeout(400);
			await b.page.fill('#chat-input', text);
			await b.page.click('#chat-send', { force: true });
			await until(b.page, (D) => { try { return window.DaimondCore.diamondBusy(D); } catch (e) { return false; } }, D, 8000);
			await until(b.page, (D) => { try { return !window.DaimondCore.diamondBusy(D); } catch (e) { return true; } }, D, ms, 500);
			await b.page.waitForTimeout(800);
			const rec = await b.page.evaluate((D) => {
				const r = window.DaimondDiamond.conversation(D);
				return r ? { id: r.id, messages: JSON.parse(JSON.stringify(r.messages || [])) } : { id: '', messages: [] };
			}, D);
			rcid = rec.id || rcid;
			const ui = rec.messages.map((m) => m.role === 'user' && m.content === text).lastIndexOf(true);
			if (process.env.PROV_DEBUG) console.log('  DEBUG daimonTurn', text.slice(0, 30), 'ui', ui, J(rec.messages.slice(-6).map((m) => [m.role, String(m.content || '').slice(0, 40), !!m.prod])));
			const after = ui >= 0 ? rec.messages.slice(ui + 1) : [];
			return { ans: after.find((m) => m.role === 'assistant' && pred(m)) || null, after,
				user: ui >= 0 ? rec.messages[ui] : null, req: reqFor(from, text), from };
		};

		const wtask = '@tool file_write ' + J({ path: `diamonds/${D}/code/w.md`, content: '# Worker\n\nwritten by the worker.\n' });
		const steer1 = '@tools file_write ' + J({ path: `diamonds/${D}/code/d.md`, content: '# Daimon\n\nwritten by the daimon.\n' })
			+ ' ;; spawn_agent ' + J({ name: 'provwk', task: wtask })
			+ ' ;; gather ' + J({ names: ['provwk'], timeout_s: 60 });
		const d1 = await daimonTurn(steer1, () => true, 120000);
		checkRec('D1 answer', one(d1.ans), d1.req, { k: 'answer', role: 'daimon', m: THINK, dev: idB,
			h: d1.ans ? `p1:answer:${rcid}/${d1.ans.mid}` : '' });
		check('D1: its t is the steer’s own message', !!d1.ans && !!one(d1.ans) && !!d1.user && one(d1.ans).t === String(d1.user.mid),
			(one(d1.ans) ? one(d1.ans).t : '') + ' vs ' + (d1.user ? d1.user.mid : ''));
		check('D1: and d the Diamond', !!d1.ans && !!one(d1.ans) && one(d1.ans).d === D);

		const tail = d1.after.find((m) => m.role === 'user' && /^\[Daimond: this turn changed /.test(String(m.content || ''))) || null;
		check('D1: the turn left its changed-files note', !!tail, tail ? String(tail.content).slice(0, 100) : '');
		const v = tail ? Number((String(tail.content).match(/\(v(\d+)\)/) || [])[1] || 0) : 0;
		const mv = await b.page.evaluate(async ({ D, v }) => {
			const ms = await window.DaimondVersions.manifests(D);
			return (ms || []).find((m) => m && m.version === v) || null;
		}, { D, v });
		const row = (name) => ((mv && mv.files) || []).find((f) => f.path && f.path.endsWith('/' + name)) || null;
		const rd = row('d.md'), rw = row('w.md');
		check('D1: the manifest holds both files', !!rd && !!rw, J(((mv && mv.files) || []).map((f) => f.path)));
		check('D1: d.md’s entry names the daimon, on the Diamond’s model',
			!!rd && !!rd.by && rd.by.role === 'daimon' && rd.by.m === THINK, J(rd && rd.by));
		const wreq = mockLog().slice(d1.from).find((e) => (e.messages || []).some((m) => m.role === 'user' && m.content === wtask)) || null;
		check('D1: the worker’s request went out on the worker model', !!wreq && wreq.model === GLM, wreq ? wreq.model : '(none)');
		check('D1: w.md’s entry names the worker, by the model its request carried',
			!!rw && !!rw.by && rw.by.role === 'worker' && !!wreq && rw.by.m === wreq.model, J(rw && rw.by));
		check('D1: and by its run, provider and fingerprint',
			!!rw && !!rw.by && /^w-/.test(rw.by.run || '') && rw.by.pv === DEF && !!wreq && !!spanOf(sysOf(wreq), rw.by.sp),
			J(rw && rw.by));
		const tp = (tail && Array.isArray(tail.prod)) ? tail.prod : [];
		const tw = tp.find((p) => p.role === 'worker') || null, td = tp.find((p) => p.role === 'daimon') || null;
		check('D1: the note carries one record per attributed row', tp.length === 2, tp.length + ' record(s)');
		check('D1: the worker’s file record', !!tw && !!rw && tw.k === 'file' && tw.m === GLM
			&& tw.h === `p1:file:${D}/v${v}/${rw.path}` && tw.hash === rw.hash && tw.run === rw.by.run, J(tw).slice(0, 200));
		check('D1: the daimon’s file record', !!td && !!rd && td.k === 'file' && td.m === THINK
			&& td.h === `p1:file:${D}/v${v}/${rd.path}` && td.hash === rd.hash, J(td).slice(0, 200));

		const d2 = await daimonTurn('@text D-TWO', (m) => said(m) === 'D-TWO');
		checkRec('D2 answer', one(d2.ans), d2.req, { k: 'answer', role: 'daimon', m: THINK });
		const dsp1 = one(d1.ans) ? one(d1.ans).sp : '', dsp2 = one(d2.ans) ? one(d2.ans).sp : '';
		check('D: sp is stable across two daimon turns', !!dsp1 && dsp1 === dsp2, dsp1 + ' / ' + dsp2);
		if (d1.req && d2.req) {
			console.log('  ..    the two daimon turns’ system messages '
				+ (sysOf(d1.req) === sysOf(d2.req) ? 'are the same' : 'DIFFER, and sp did not move with them'));
		}
		const MARK_D = 'You are PROVMARK-D, the daimon of this Diamond.';
		await storeWrite(b, 'prompts/daimon.md', MARK_D);
		await refreshPrompts(b);
		const d3 = await daimonTurn('@text D-THREE', (m) => said(m) === 'D-THREE');
		const dspan3 = checkRec('D3 answer', one(d3.ans), d3.req, { k: 'answer', role: 'daimon', m: THINK });
		const dsp3 = one(d3.ans) ? one(d3.ans).sp : '';
		check('D: an edited prompts/daimon.md was sent', !!d3.req && sysOf(d3.req).includes('PROVMARK-D'));
		check('D: and moved sp, to a fingerprint of text holding the edit',
			!!dsp3 && dsp3 !== dsp1 && !!dspan3 && dspan3.includes('PROVMARK-D'), dsp1 + ' -> ' + dsp3);
		await storeRemove(b, 'prompts/daimon.md');
		await refreshPrompts(b);
		const d4 = await daimonTurn('@text D-FOUR', (m) => said(m) === 'D-FOUR');
		const dsp4 = one(d4.ans) ? one(d4.ans).sp : '';
		check('D: removing the file puts sp back where it was', !!dsp4 && dsp4 === dsp1, dsp4 + ' vs ' + dsp1);
		keep.daimon = { cid: rcid, mids: [d1, d2, d3, d4].map((t) => t.ans && String(t.ans.mid)).filter(Boolean),
			tail: tail ? String(tail.mid) : '' };

		// The daimon's sp moves when a Diamond's note is kept, and not otherwise (5.3.2 plan C5; the engine records it as the turn composes).
		if (await b.page.evaluate(() => !!(window.DaimondNotes && DaimondNotes.add && DaimondNotes.retire))) {
			const DN = 'Keep every reply to this Diamond under two short paragraphs.';
			const dn = await b.page.evaluate(({ D, l }) => DaimondNotes.add({ level: 2, scope: D, cm: 'all', tag: 'long', line: l, at: { t: 5, n: 14 } }), { D, l: DN });
			const d5 = await daimonTurn('@text D-FIVE', (m) => said(m) === 'D-FIVE'), d6 = await daimonTurn('@text D-SIX', (m) => said(m) === 'D-SIX');
			const dsp5 = one(d5.ans) ? one(d5.ans).sp : '', dsp6 = one(d6.ans) ? one(d6.ans).sp : '';
			const dspan5 = d5.req ? spanOf(sysOf(d5.req), dsp5) : null;
			check('D: keeping a Diamond note moves the daimon’s sp, to a fingerprint of text holding the note', !!dsp5 && dsp5 !== dsp1 && !!dspan5 && dspan5.includes(DN), dsp1 + ' -> ' + dsp5);
			check('D: and the next daimon turn, with no change, keeps it', !!dsp6 && dsp6 === dsp5, dsp5 + ' / ' + dsp6);
			await b.page.evaluate(({ D, n }) => DaimondNotes.retire({ level: 2, scope: D, id: n.id }, { t: 5, n: 34 }), { D, n: dn });
			const d7 = await daimonTurn('@text D-SEVEN', (m) => said(m) === 'D-SEVEN');
			check('D: retiring it puts the daimon’s first sp back', (one(d7.ans) ? one(d7.ans).sp : '') === dsp1, dsp1 + ' vs ' + (one(d7.ans) ? one(d7.ans).sp : ''));
		}

		// ══ P. A proposal carries its answer's record ═══════════════════
		if (on('P')) {
			const HEAD = 'PROV-HEAD the ledger has a gap';
			const BODY = 'PROV-BODY 3 of 4 rows name nobody.';
			const from = mockLog().length;
			await b.page.evaluate(async ({ D, says }) => {
				const T = window.DaimondTriggers;
				const ta = T.blank('activity');
				ta.minutes = 1; ta.offScreen = true; ta.instruction = says;
				await window.DaimondCore.triggerSet(D, ta);
				const got = (window.DaimondTriggersOf(D) || [])[0];
				window.DaimondPause.set(T.node(D, got.id), true);
				window.DaimondPause.set(window.DaimondPause.id('root', 'diamonds', D, 'self'), true);
			}, { D, says: '@text ' + HEAD + '\n' + BODY });
			let prop = null;
			for (let i = 0; i < 6 && !prop; i++) {
				await b.page.evaluate(async () => { window.DaimondTriggers.noteActivity(); await window.DaimondTriggerTick(); });
				await b.page.waitForTimeout(500);
				prop = (await b.page.evaluate(() => window.DaimondPendingView.items()))
					.find((x) => x.kind === 'proposal' && x.headline === 'PROV-HEAD the ledger has a gap') || null;
			}
			check('P: the triggered reply is raised as a proposal', !!prop, prop ? prop.headline : '');
			const pans = await b.page.evaluate(({ D, HEAD }) => {
				const r = window.DaimondDiamond.conversation(D);
				const m = (r && r.messages || []).filter((x) => x.role === 'assistant' && String(x.content).startsWith(HEAD)).pop();
				return m ? JSON.parse(JSON.stringify(m)) : null;
			}, { D, HEAD });
			const preq = mockLog().slice(from).find((e) => (e.messages || []).some((m) => m.role === 'user'
				&& typeof m.content === 'string' && m.content.includes(HEAD))) || null;
			checkRec('P proposal', one(prop), preq, { k: 'proposal', role: 'daimon', m: THINK, dev: idB,
				h: prop ? `p1:proposal:${prop.id}` : '' });
			check('P: it is the answer’s record under its own handle', !!one(prop) && !!one(pans)
				&& sansHK(one(prop)) === sansHK(one(pans)) && one(prop).at === one(pans).at, '');
			await b.page.evaluate((D) => {
				(window.DaimondTriggersOf(D) || []).forEach((t) => window.DaimondPause.set(window.DaimondTriggers.node(D, t.id), false));
			}, D);
		}
	}

	// ══ R. A worker's report relayed with nobody looking ════════════════
	if (on('R')) {
		const rc = await newChat(b);
		const from = mockLog().length;
		const task = '@slow 5000';
		await chat(b, '@tool spawn_agent ' + J({ name: 'provrelay', task }), { timeout: 45000 });
		await newChat(b);			// look elsewhere, so the report is relayed rather than read by a turn
		// Every product's `prod` is a list now, so the relay is the message whose records are workers'.
		const relay = await waitMsg(b, rc, (m) => m.role === 'assistant' && Array.isArray(m.prod)
			&& m.prod.some((p) => p && p.k === 'worker'), 60000);
		check('R: the report was relayed as one message with a record list', !!relay,
			relay ? String(relay.content).slice(0, 80) : 'no relay');
		const wp = relay && relay.prod.length === 1 ? relay.prod[0] : null;
		const wreq = mockLog().slice(from).find((e) => (e.messages || []).some((m) => m.role === 'user' && m.content === task)) || null;
		checkRec('R worker record', wp, wreq, { k: 'worker', role: 'worker', dev: idB });
		check('R: named by its run', !!wp && /^p1:worker:w-/.test(wp.h) && wp.c === rc, wp ? wp.h : '');
		if (relay) keep.relay = { cid: rc, mid: String(relay.mid) };
	}

	// ══ O. A record-less message, written as a build before U1 wrote them ══
	let ocid = '';
	if (on('O')) {
		ocid = await newChat(b);
		await b.page.evaluate(() => { window.__provSaved = window.DaimondProvenance; window.DaimondProvenance = undefined; });
		const o = await textTurn(b, ocid, 'OLD-SHAPE');
		await b.page.evaluate(() => { window.DaimondProvenance = window.__provSaved; });
		check('O: the answer was written with no record', !!o.ans && !('prod' in o.ans), o.ans ? Object.keys(o.ans).join(',') : 'no answer');
		if (o.ans) keep.old = { cid: ocid, mid: String(o.ans.mid) };
	}

	// ══ X. 5.3.0: credit at the source, the chat's Files row, the v2 record (written red on 5.2.9) ═══
	if (on('X')) {
		// X1 is native-only. file_write, file_edit, file_delete, file_move, doc_edit, sheet_write, web_fetch, typst_compile and
		// capture_view all capture; Shell, Run, Verify and SpawnAgent are the opaque set, Shell is refused in the browser, and Run
		// and Verify need a hand whose mock writes no files (hand/install/mock_host.py:198). E1a's cargo tests carry it.
		console.log('  NOT COVERED  X1: a command window\'s credit (via "command") has no world-testable caller; E1a\'s native tests carry it');
		const mkDiamond = async (label) => {
			await b.page.evaluate(() => document.getElementById('new-diamond-btn').click());
			await b.page.waitForSelector('.dlg-card', { timeout: 8000 });
			await b.page.evaluate((nm) => {
				const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
				const inp = card.querySelector('input.dlg-input'); inp.value = nm; inp.dispatchEvent(new Event('input', { bubbles: true }));
				card.querySelector('.dlg-ok').click();
			}, label + ' ' + Date.now().toString(36));
			await b.page.waitForTimeout(1500);
			return b.page.evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
		};
		// ── X2. A Diamond that predates the seeded files: a daimon turn lists none of the three ──
		const XD = await mkDiamond('Seeded');
		check('X2: a Diamond is made and on screen', !!XD, XD);
		await b.page.evaluate(({ XD, DEF, THINK, GLM }) => {
			const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
			all[XD] = { provider: DEF, model: THINK, workerProvider: DEF, workerModel: GLM, visionProvider: '', visionModel: '' };
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
		}, { XD, DEF, THINK, GLM });
		const SEEDED = ['STATE.md', 'REQUIREMENTS.md', 'DECISIONS.md'];
		for (const f of SEEDED) await storeRemove(b, `diamonds/${XD}/${f}`).catch(() => {});	// as a Diamond made before them
		const xfrom = mockLog().length;
		await b.page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
		await b.page.waitForTimeout(400);
		// A turn holding an opaque call (a spawn) is the one the turn-end walk runs after, which is how the seeded files reached the note.
		const xwk = '@tool file_write ' + J({ path: `diamonds/${XD}/code/xw.md`, content: '# XW\n\nby the worker.\n' });
		await b.page.fill('#chat-input', '@tools file_write ' + J({ path: `diamonds/${XD}/code/x.md`, content: '# X\n\nwritten by the daimon.\n' })
			+ ' ;; spawn_agent ' + J({ name: 'xwk', task: xwk }) + ' ;; gather ' + J({ names: ['xwk'], timeout_s: 60 }));
		await b.page.click('#chat-send', { force: true });
		await until(b.page, (D) => { try { return window.DaimondCore.diamondBusy(D); } catch (e) { return false; } }, XD, 8000);
		await until(b.page, (D) => { try { return !window.DaimondCore.diamondBusy(D); } catch (e) { return true; } }, XD, 90000, 500);
		await b.page.waitForTimeout(800);
		const xrec = await b.page.evaluate((D) => { const r = window.DaimondDiamond.conversation(D); return r ? JSON.parse(JSON.stringify(r.messages || [])) : []; }, XD);
		const xtail = xrec.find((m) => m.role === 'user' && /^\[Daimond: this turn changed /.test(String(m.content || ''))) || null;
		check('X2: the turn left its changed-files note', !!xtail, xtail ? String(xtail.content).slice(0, 100) : 'no note');
		const listed = xtail ? String(xtail.content) : '';
		const seen = SEEDED.filter((f) => listed.includes(f));
		check('X2: the note lists none of STATE.md, REQUIREMENTS.md, DECISIONS.md (J3: seeded files are nobody\'s product)', !!xtail && seen.length === 0, 'listed: ' + (seen.join(', ') || '(none)') + ' in ' + listed.slice(0, 160));
		const xp = (xtail && Array.isArray(xtail.prod)) ? xtail.prod : [];
		check('X2: every record in the note carries via, last, and it is empty for a file tool', xp.length > 0 && xp.every((p) => Object.keys(p).join(',') === PROD_KEYS_V2 && p.via === ''), xp.map((p) => Object.keys(p).slice(-2).join('|') + '=' + p.via).join(' ; ') || 'no records');

		// ── X3. A chat turn appends one files_log, its records the store's existing rows (the lead's ruling, Fri ~10:35) ──
		const xcid = await newChat(b);
		const scratch = await b.page.evaluate((c) => window.DaimondAttach.chatScratch(c), xcid);
		await chat(b, '@tools file_write ' + J({ path: scratch + '/o.md', content: 'old bytes\n' }), { timeout: 45000 });
		await b.page.waitForTimeout(800);
		const nBefore = (await msgsOf(b, xcid)).filter((m) => m.role === 'files_log').length;
		await chat(b, '@tools file_write ' + J({ path: scratch + '/n.md', content: 'a new file\n' }) + ' ;; file_write ' + J({ path: scratch + '/o.md', content: 'new bytes\n' }), { timeout: 45000 });
		await b.page.waitForTimeout(1500);
		const logs = (await msgsOf(b, xcid)).filter((m) => m.role === 'files_log').slice(nBefore);
		check('X3: the turn appended exactly one files_log', logs.length === 1, logs.length + ' new');
		const fl = logs[0] || null;
		check('X3: it is { role, mid, ts, prod, delta } with no content (P3: the counts ride the message, so the row draws them with no store)', !!fl && J(Object.keys(fl)) === J(['role', 'mid', 'ts', 'prod', 'delta']), fl ? J(Object.keys(fl)) : 'none');
		const fp = (fl && fl.prod) || [];
		const rn = fp.find((p) => /\/n\.md$/.test(p.h)), ro = fp.find((p) => /\/o\.md$/.test(p.h));
		check('X3: two records, n.md and o.md', fp.length === 2 && !!rn && !!ro, fp.map((p) => p.h).join(' ; '));
		check('X3: handles are p1:file:chat:<chat>/v<N>/<path> and kind file', !!rn && !!ro && [rn, ro].every((p) => p.k === 'file' && p.h.startsWith('p1:file:chat:' + xcid + '/v')), fp.map((p) => p.h).join(' ; '));
		const mans = await b.page.evaluate((c) => window.DaimondVersions.manifests('chat:' + c), xcid);
		const ents = (mans || []).flatMap((m) => m.files || []);
		const en = ents.find((e) => /\/n\.md$/.test(e.path)), eo = ents.find((e) => /\/o\.md$/.test(e.path));			// manifests come newest first
		check('X3: each record carries its manifest row\'s hash', !!rn && !!ro && !!en && !!eo && rn.hash === en.hash && ro.hash === eo.hash, J({ rn: rn && rn.hash, en: en && en.hash, ro: ro && ro.hash, eo: eo && eo.hash }));
		const bodyOf = (hash) => b.page.evaluate(({ c, hash }) => window.DaimondVersions.body('chat:' + c, hash), { c: xcid, hash });
		check('X3: the store holds a body for o.md\'s old bytes', !!eo && !!eo.was && (await bodyOf(eo.was)) !== null, eo ? 'was ' + eo.was : 'no o.md row');
		// The lead's ruling (Fri ~10:35): 5.2.9's chat store already keeps a new file's body, so the row's record is that existing
		// row, read as it stands. E1b changes nothing the store holds, and the toast is as on 5.2.9.
		check('X3: the store still holds n.md\'s body under its hash, as on 5.2.9 (the record is the existing row, not a new kind)', !!en && !!en.hash && (await bodyOf(en.hash)) !== null, en ? 'hash ' + en.hash : 'no n.md row');
		const toast = await b.page.evaluate(() => { try { return window.DaimondUndo.pending(); } catch (e) { return null; } });
		check('X3: the undo toast says 2, exactly as on 5.2.9 (J4: o.md\'s copy and n.md\'s)', !!toast && /: 2$/.test(String(toast.text).trim()), J(toast));
	}

	// ══ S. B's products on A, and B after a reload ══════════════════════
	if (on('S')) {
		const bBefore = {};
		for (const m of await storedMsgs(b)) if (m && m.mid) bBefore[String(m.mid)] = m;
		const wanted = [];
		if (keep.chat)   keep.chat.mids.forEach((mid) => wanted.push({ what: 'chat answer', mid }));
		if (keep.fold)   wanted.push({ what: 'fold_log', mid: keep.fold.mid });
		if (keep.mail)   wanted.push({ what: 'mail row', mid: keep.mail.mid });
		if (keep.daimon) keep.daimon.mids.forEach((mid) => wanted.push({ what: 'daimon answer', mid }));
		if (keep.daimon && keep.daimon.tail) wanted.push({ what: 'changed-files note', mid: keep.daimon.tail });
		if (keep.relay)  wanted.push({ what: 'worker relay', mid: keep.relay.mid });
		if (keep.old)    wanted.push({ what: 'record-less answer', mid: keep.old.mid, none: true });
		await b.page.evaluate(() => window.DaimondSync.push());
		await settle(b.page);
		let aHas = {};
		const t0 = Date.now();
		while (Date.now() - t0 < 90000) {
			await a.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
			await settle(a.page);
			aHas = {};
			for (const m of await storedMsgs(a)) if (m && m.mid) aHas[String(m.mid)] = m;
			if (wanted.every((w) => aHas[w.mid])) break;
			await a.page.waitForTimeout(2000);
		}
		for (const w of wanted) {
			const bm = bBefore[w.mid], am = aHas[w.mid];
			if (w.none) {
				check(`S: the ${w.what} reached A and is still record-less`, !!am && !('prod' in am), am ? '' : 'not on A');
			} else {
				check(`S: the ${w.what} reached A with a byte-identical record`, !!am && !!bm && !!bm.prod && J(am.prod) === J(bm.prod),
					!am ? 'not on A' : (J(am.prod) || '(none)').slice(0, 90));
			}
		}
		// B reloaded: the store holds what was written, and nothing was stamped after the fact.
		await b.page.evaluate(() => window.DaimondSync.flush && window.DaimondSync.flush()).catch(() => {});
		await b.page.reload({ waitUntil: 'domcontentloaded' });
		await gateUp(b);
		await signInAs(b, b.account);
		await b.page.waitForFunction(() => !!window.DaimondSync, null, { timeout: 20000 }).catch(() => {});
		await b.page.waitForTimeout(1500);
		const bAfter = {};
		for (const m of await storedMsgs(b)) if (m && m.mid) bAfter[String(m.mid)] = m;
		const moved = wanted.filter((w) => J((bAfter[w.mid] || {}).prod) !== J((bBefore[w.mid] || {}).prod));
		check('S: after a reload B reads back every record exactly as it wrote it', moved.length === 0 && wanted.length > 0,
			moved.map((w) => w.what).join(', '));
		if (keep.old) {
			await b.page.evaluate((cid) => {
				const box = document.querySelector(`.session-box.chat-box[data-id="${cid}"]`);
				if (box) box.click();
			}, keep.old.cid);
			const drawn = await until(b.page, () => /OLD-SHAPE/.test((document.getElementById('chat-output') || {}).innerText || ''), null, 15000);
			check('O: the record-less transcript opens and renders after a reload', drawn);
		}
	}

	// ══ X4. Every Prod read anywhere in the run is a v2 record: 18 keys, via last ══
	if (on('X')) {
		const prods = [];
		for (const s of [a, b]) {
			const all = await s.page.evaluate(async () => {
				const out = [];
				const take = (m) => { if (m && Array.isArray(m.prod)) m.prod.forEach((p) => out.push(p)); if (m && m.rating && m.rating.prod) out.push(m.rating.prod); };
				try { for (const c of window.DaimondCore.chatStore().stored()) { const g = await window.DaimondCore.chatStore().loadMessages(c.id); ((g && g.messages) || []).forEach(take); } } catch (e) { /* none */ }
				try { for (const d of (window.DaimondDiamond.list ? window.DaimondDiamond.list() : [])) { const r = window.DaimondDiamond.conversation(d.id); ((r && r.messages) || []).forEach(take); } } catch (e) { /* none */ }
				return JSON.parse(JSON.stringify(out));
			}).catch(() => []);
			prods.push(...all);
		}
		const wrong = prods.filter((p) => Object.keys(p).join(',') !== PROD_KEYS_V2 || (p.via !== '' && p.via !== 'command'));
		check('X4: records were read (so the sweep looked at some)', prods.length >= 3, prods.length + ' read');
		check('X4: every Prod read anywhere carries the 18 v2 keys in order, via last', prods.length > 0 && wrong.length === 0,
			wrong.length + ' of ' + prods.length + ' differ, e.g. ' + (wrong[0] ? Object.keys(wrong[0]).slice(-3).join(',') : ''));
	}

	await shot(b, 'provenance_' + (bad.length ? 'RED' : 'GREEN'));
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e).slice(0, 600));
} finally {
	for (const [n, s] of [['A', a], ['B', b]]) {
		if (!s) continue;
		const errs = errors(s).filter((x) => /prod|provenance|stamp/i.test(x));
		check(`${n}: no page error about records`, errs.length === 0, errs.slice(0, 2).join(' | '));
	}
	await a?.close().catch(() => {});
	await b?.close().catch(() => {});
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed` + (bad.length ? '' : ' — NOTHING FAILED, so the checks prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
