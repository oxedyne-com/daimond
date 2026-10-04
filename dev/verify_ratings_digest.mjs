// gateway: none
// verify_ratings_digest.mjs -- V1 of the 5.3.2 plan (specs/daimond_optimiser_532_plan_20261004.md section 5, V1): the Ratings section
// of system/usage/digest.md (U5a/U5b) holds only figures, the figures are right, and the index is a pure function of the transcripts.
// World 88, headless. A seeded account goes into the real ChatStore (3 chats, 2 Diamonds, 2 models), the page's own digest writer
// (`DaimondDiamond.usageDigest`) writes system/usage/digest.md, and the verifier reads the FILE back through the wasm store.
//
//   RD1  the digest holds no word of any rating's note, chat name, answer text, file path, custom tag or tool path, on a provoking
//        fixture (notes full of distinctive words and strong language), in the file and in `digestText` itself                  [J4]
//   RD2  the cells equal a hand count on the seeded account: 3 chats, 2 Diamonds, 2 models, a superseded and a cleared rating, a
//        neutral one and a file rating. Whole rows are compared: counts and exposure and "N more" are written here as literals, the
//        shrunk estimate, the share and its 90% interval by an oracle written here (fading by newer ratings, O1; prior 0)       [U5a]
//   RD3  no message of any seeded chat (its `msgSig` and its whole JSON), no summary row's seed, fp, msgCount, standing or
//        updatedAt moves across a digest write, and the write did walk the ratings (so it is not vacuous)                       [J1]
//   RD4  a cold rebuild equals the warm memo byte for byte. Cold: each stored chat is read once, one at a time, and none is made
//        resident. Warm: no read. After one new rating only that chat is read again (counted at ChatStore.loadMessages, and by
//        the store's own loadCount). A reload (a cold page) gives the warm section again                                         [J2, C3]
//   RD3b a chat whose legacy row is ahead of its chunks and whose summary holds an fp is read by the walk and left as it was found:
//        no chunk rewritten, no row put back, fp kept; the control is the healing reader, which does change it (round F, Opus A F4)
//   RD5  a second context holding the same chats (seeded in the other order, with other row stamps) writes a byte-identical
//        Ratings section                                                                                                          [J2]
//
//   node dev/verify_ratings_digest.mjs [--only RD1,RD2]
//   node dev/verify_ratings_digest.mjs --break notetext   # copy each note into the digest: red in RD1 only
//   node dev/verify_ratings_digest.mjs --break nomemo     # rebuild every chat on every pass: red in RD4 only
//
// A break whose every anchor does not match exactly once in its file exits 2. Sections run in the order RD1 RD2 RD3 RD5 RD4 RD3b:
// RD4 adds a rating, which RD2's hand count and RD5's comparison must not see, and RD3b writes a leftover row, which RD4's reads must not meet.
import { open, scratch, signInAs } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const arg = (flag, dflt = '') => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : dflt; };
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const BREAK = arg('--break');
const WWW = new URL('../www', import.meta.url).pathname;

// ── The breaks: every edit's `from` must occur exactly once in its file ──
const BREAKS = {
	// A note reaches the digest: the head keeps it, the roll carries it beside the cells (no count moves), the text quotes it.
	notetext: { red: 'RD1', file: 'js/ratingroll.js', edits: [
		{ from: "via: p.via === 'command' ? 'command' : '',\n",
		  to:   "via: p.via === 'command' ? 'command' : '', note: str(r.note),\n" },
		{ from: 'var out = { v: 1, sides: sides, products:',
		  to:   "var out = { v: 1, notes: recs.map(function (r) { return r.note || ''; }), sides: sides, products:" },
		{ from: "L.push('### Account, every Diamond and chat'); L.push('');",
		  to:   "L.push('Notes quoted: ' + (roll.notes || []).join(' / ')); L.push('');\n\t\tL.push('### Account, every Diamond and chat'); L.push('');" },
	] },
	// The per-chat memo is never hit: every chat is read on every pass.
	nomemo: { red: 'RD4', file: 'js/daimond.js', edits: [
		{ from: 'if (hit && hit.key === key) {', to: 'if (false) {' },
	] },
};
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
let patched = null;
if (BREAK) {
	const b = BREAKS[BREAK];
	let src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	for (const e of b.edits) {
		const n = src.split(e.from).length - 1;
		if (n !== 1) { console.error(`break '${BREAK}': anchor matched ${n} times, not once, in ${b.file}: ${JSON.stringify(e.from)}`); process.exit(2); }
		src = src.replace(e.from, () => e.to);
	}
	patched = { file: b.file, src };
	console.log(`\n*** RUNNING UNDER --break ${BREAK}: only ${b.red} may go red ***\n`);
}

const tally = { ok: 0, bad: [] };
const check = (sec, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(sec);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${sec}  ${what}${detail !== undefined && detail !== '' ? ' -- ' + String(detail).slice(0, 700) : ''}`); };

// ── The seeded account, written down by hand ──
// Every event carries `q`, its place in one global order; a rating's ts is base + q * 1000, so the head rule (greatest ts) and the
// fading (newest first) are the fixture's own and not read from the page. `HEADS` lists, by hand, the records that must be the
// head of their product at the end (a superseded record and a cleared product are NOT in it): that list and the literals below
// are the hand count.
const MODELS = {
	'glm-5.2':   { m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', fam: 'glm-5',   cls: 'open-frontier' },
	'kimi-k2.7': { m: 'accounts/fireworks/models/kimi-k2p7', pv: 'fireworks', fam: 'kimi-k2', cls: 'open-frontier' },
};
const STAMP = { k: 'answer', fi: false, role: 'chat', sp: 'sp1:3f9a0c12', dev: 'd-4f2a', at: 1790000000000, run: '', via: '' };
const BASE_TS = 1790000000000;
let Q = 0;
const FIX = [];
const prodModel = {};
const chatSpec = (id, name, d) => { const c = { id, name, d, ev: [] }; FIX.push(c); return c; };
const ans  = (c, p, cm) => { prodModel[c.id + '/' + p] = cm; c.ev.push({ k: 'ans', p, cm, q: ++Q }); };
const file = (c, p, cm, fpath) => { prodModel[c.id + '/' + p] = cm; c.ev.push({ k: 'file', p, cm, path: fpath, q: ++Q }); };
const rate = (c, p, s, o = {}) => { const e = Object.assign({ k: 'rate', p, s, q: ++Q, c: c.id, d: c.d, cm: prodModel[c.id + '/' + p] }, o); c.ev.push(e); return e; };

const NOTE = 'ZEBRAWORD kumquat_secret, this is bloody useless crap, damn it, hunter2';
// Chat A, in Diamond 'opt', model glm-5.2: five answers (x5 never rated) and one changed file (f1).
const cA = chatSpec('rdchatA', 'QUOKKATITLE alpha', 'opt');
ans(cA, 'x1', 'glm-5.2');  const hx1 = rate(cA, 'x1', 1,  { note: NOTE });
ans(cA, 'x2', 'glm-5.2');  const hx2 = rate(cA, 'x2', 2,  { note: NOTE, tags: ['correct'] });
ans(cA, 'x3', 'glm-5.2');  const hx3 = rate(cA, 'x3', -1, { note: NOTE, tags: ['long'] });
ans(cA, 'x4', 'glm-5.2');  rate(cA, 'x4', 1, { note: NOTE, tags: ['style'] });
const hx4 = rate(cA, 'x4', -1, { note: NOTE, tags: ['long', 'wrong'] });			// supersedes the first: the head, once
ans(cA, 'x5', 'glm-5.2');
file(cA, 'f1', 'glm-5.2', 'secret/QUOLLPATH.txt');
const hf1 = rate(cA, 'f1', -1, { note: NOTE, tags: ['emutag99'] });					// a person's own tag, and a file rating
// Chat B, in Diamond 'help', model kimi-k2.7: four answers.
const cB = chatSpec('rdchatB', 'QUOKKATITLE beta', 'help');
ans(cB, 'y1', 'kimi-k2.7'); const hy1 = rate(cB, 'y1', 1, { note: NOTE });
ans(cB, 'y2', 'kimi-k2.7'); const hy2 = rate(cB, 'y2', 1, { note: NOTE });
ans(cB, 'y3', 'kimi-k2.7'); rate(cB, 'y3', 1, { note: NOTE });
rate(cB, 'y3', 0, { clear: true });														// withdrawn: no head, no count
ans(cB, 'y4', 'kimi-k2.7'); const hy4 = rate(cB, 'y4', -2, { note: NOTE, tags: ['wrong'] });
// Chat C, no Diamond, both models: four answers, the newest rating last.
const cC = chatSpec('rdchatC', 'QUOKKATITLE gamma', '');
ans(cC, 'z1', 'glm-5.2');   const hz1 = rate(cC, 'z1', 1, { note: NOTE });
ans(cC, 'z2', 'kimi-k2.7'); const hz2 = rate(cC, 'z2', -1, { note: NOTE });
ans(cC, 'z3', 'glm-5.2');   const hz3 = rate(cC, 'z3', -1, { note: NOTE });
ans(cC, 'z4', 'kimi-k2.7'); const hz4 = rate(cC, 'z4', 0, { note: NOTE });					// neutral: counted, neither up nor down
const HEADS = [hx1, hx2, hx3, hx4, hf1, hy1, hy2, hy4, hz1, hz2, hz3, hz4];
const CHAT_IDS = FIX.map((c) => c.id);

// Hand counts: model, scope -> [n, up, down, neutral, made, N more, open negatives, fixed points, leading tags].
// Account glm-5.2: heads x1 +, x2 +2, x3 -, x4 -, f1 - (chat A), z1 +, z3 - (chat C): 7 rated, 3 up, 4 down; made 5 answers + 1 file + 2 = 8.
// Account kimi-k2.7: y1 +, y2 +, y4 -2 (chat B), z2 -, z4 0 (chat C): 5 rated, 2 up, 2 down, 1 neutral; made 4 + 2 = 6.
// Floors are 10 and 6 effective ratings; fading makes 11 and 7 the smallest counts that reach them, so 'more' is 11-7, 11-5, 7-5, 7-3.
const HAND = {
	'3|glm-5.2':   { n: 7, up: 3, down: 4, zero: 0, made: 8, more: 4, open: 0, fixed: 1, tags: 'long 2, correct 1, wrong 1' },
	'3|kimi-k2.7': { n: 5, up: 2, down: 2, zero: 1, made: 6, more: 6, open: 1, fixed: 0, tags: 'wrong 1' },
	'2opt|glm-5.2':    { n: 5, up: 2, down: 3, zero: 0, made: 6, more: 2, open: 0, fixed: 1, tags: 'long 2, correct 1, wrong 1' },
	'2help|kimi-k2.7': { n: 3, up: 2, down: 1, zero: 0, made: 4, more: 4, open: 1, fixed: 0, tags: 'wrong 1' },
};

// ── The oracle: theta, the positive share and its 90% Wilson interval, from the head list alone ──
const Z90 = 1.6448536269514722;
function oracle(list, H) {
	const r = list.slice().sort((a, b) => b.q - a.q);
	let w = 0, ws = 0, dw = 0, dw2 = 0, dp = 0;
	r.forEach((x, k) => { const wt = H === Infinity ? 1 : Math.pow(2, -k / H); w += wt; ws += wt * x.s; if (x.s !== 0) { dw += wt; dw2 += wt * wt; } if (x.s > 0) dp += wt; });
	const p = dp / dw, n = dw * dw / dw2, z2 = Z90 * Z90, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d;
	const h = Z90 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
	return { theta: ws / (w + 5), share: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
const num = (x) => { const t = (Math.round(x * 100) / 100).toFixed(2); return t === '-0.00' ? '0.00' : t; };
const pct = (x) => Math.round(x * 100) + '%';
function rowOf(cm, level, scopeKey) {
	const H = level === 3 ? 50 : 25, hd = HEADS.filter((e) => e.cm === cm && (level === 3 || e.d === scopeKey));
	const o = oracle(hd, H), a = HAND[(level === 3 ? '3' : '2' + scopeKey) + '|' + cm];
	return '| ' + [cm, a.n + ' of ' + a.made + ' made',
		a.up + ' up, ' + a.down + ' down' + (a.zero ? ', ' + a.zero + ' neutral' : ''),
		num(o.theta), pct(o.share) + ' (' + pct(o.lo) + ' to ' + pct(o.hi) + ')',
		'not enough yet, ' + a.more + ' more', a.tags, String(a.open), String(a.fixed), '-'].join(' | ') + ' |';
}

// ── Words that must never reach the digest (J4). Each occurs in a note, a name, a body, a path, a tag or a tool path ──
const POISON = ['ZEBRAWORD', 'kumquat_secret', 'hunter2', 'bloody', 'crap', 'damn', 'QUOKKATITLE', 'PLATYPUSBODY', 'QUOLLPATH', 'emutag99', 'QUAGGATOOL', 'rdchat'];

// ── The page ──
// Everything the page needs is built in the page, from the real DaimondRatings.build/message, so the transcript holds the records a
// person's taps make. `spec.ids` maps 'opt'/'help' to the Diamond ids, `spec.rev` seeds the chats and rows in the other order.
async function seed(page, ids, rev) {
	return page.evaluate(async (spec) => {
		const R = window.DaimondRatings, st = DaimondCore.chatStore();
		const out = spec.fix.map((c) => {
			const dId = c.d ? spec.ids[c.d] : '', msgs = [], prod = {}, last = {};
			c.ev.slice().sort((a, b) => a.q - b.q).forEach((e) => {
				const ts = spec.base + e.q * 1000;
				if (e.k === 'ans' || e.k === 'file') {
					const mid = (e.k === 'ans' ? 'a-' : 'f-') + e.p, isFile = e.k === 'file';
					const h = isFile ? 'p1:file:' + (dId || 'chat:' + c.id) + '/v1/' + e.path : 'p1:answer:' + c.id + '/' + mid;
					const stamp = Object.assign({}, spec.stamp, spec.models[e.cm], { cm: e.cm, h: h, k: isFile ? 'file' : 'answer', d: dId, c: c.id, t: 'm' + e.p, hash: isFile ? 'sha-' + e.p : '' });
					prod[e.p] = stamp;
					msgs.push(isFile
						? { role: 'files_log', mid: mid, ts: ts, content: 'changed ' + e.path, prod: [stamp] }
						: { role: 'assistant', mid: mid, ts: ts, content: 'PLATYPUSBODY ' + e.p, prod: [stamp] });
				} else {
					const id = R.newId(ts, 'q' + e.q);
					const rec = R.build({ prod: prod[e.p], s: e.s, clear: e.clear === true, tags: e.tags || [], dims: {}, note: e.note || '', src: 'tap',
						sup: last[e.p] || '', burst: '', tools: 'web_fetch>QUAGGATOOL', len: 300 });
					last[e.p] = id;
					msgs.push(R.message(rec, id, ts));
				}
			});
			return { id: c.id, name: c.name, model: 'mock/fast', updatedAt: spec.base + spec.skew + c.ev[c.ev.length - 1].q * 1000, messages: msgs, session: null };
		});
		const list = st.stored();
		(spec.rev ? out.slice().reverse() : out).forEach((c) => list.push(c));
		await st.save(list);
		try { await st.settled(); } catch (e) { /* the alarm is up; the read is what there is */ }
		return out.map((c) => c.id);
	}, { fix: FIX, ids: ids, rev: !!rev, base: BASE_TS, skew: rev ? 777000 : 0, stamp: STAMP, models: MODELS });
}

async function diamondIds(page) {
	await page.evaluate(() => DaimondDiamond.seedDefaults());
	await page.waitForFunction(() => [...document.querySelectorAll('#diamond-list .session-box-name')].some((n) => /Daimond Optimiser/.test(n.textContent)), null, { timeout: 20000 }).catch(() => {});
	return page.evaluate(() => {
		const of = (re) => { const b = [...document.querySelectorAll('#diamond-list .diamond-box')].find((x) => re.test(x.textContent)); return b ? b.dataset.id : ''; };
		return { opt: of(/Daimond Optimiser/), help: of(/Daimond Help/) };
	});
}

// Count every transcript the store serves from here on, by either reader: the ids in order, the most that were ever in flight
// together, and how many were by `loadMessages`, the reader that heals (the walk must make none: round F, Opus A F4).
const instrument = (page) => page.evaluate(() => {
	const st = DaimondCore.chatStore();
	window.__rd = window.__rd || { reads: [], inflight: 0, max: 0, healing: 0 };
	if (!st.__orig) {
		const wrap = (orig, healing) => function (id) {
			const rec = window.__rd; rec.reads.push(id); rec.inflight++; rec.max = Math.max(rec.max, rec.inflight); if (healing) rec.healing++;
			return Promise.resolve(orig.call(st, id)).finally(() => { rec.inflight--; });
		};
		st.__orig = st.loadMessages;
		st.loadMessages = wrap(st.__orig, true);
		if (st.readMessages) { st.__origRead = st.readMessages; st.readMessages = wrap(st.__origRead, false); }
	}
});

// One digest write, with what it read: { text, reads, max, loadCount, resident }.
const writeDigest = (page) => page.evaluate(async () => {
	const st = DaimondCore.chatStore(), rec = window.__rd;
	rec.reads.length = 0; rec.max = 0; rec.healing = 0; st.resetLoadCount();
	await DaimondDiamond.usageDigest();
	const W = await import('/pkg/oxedyne_daimond.js');
	let text = ''; try { text = String(await W.store_read('system/usage/digest.md')); } catch (e) { text = ''; }
	return { text: text, reads: rec.reads.slice(), max: rec.max, healing: rec.healing, loadCount: st.loadCount(), resident: DaimondCore.chatResidency().filter((c) => c.loaded).map((c) => c.id).sort() };
});

const section = (text) => {
	const i = text.indexOf('\n## Ratings');
	if (i < 0) return '';
	const j = text.indexOf('\n## Before answer ratings', i);
	return text.slice(i, j < 0 ? undefined : j);
};
const rows = (sec, heading) => {		// the table rows under a '### ' heading, keyed by their first cell
	const i = sec.indexOf('\n### ' + heading);
	if (i < 0) return {};
	const j = sec.indexOf('\n### ', i + 5), block = sec.slice(i, j < 0 ? undefined : j), out = {};
	block.split('\n').forEach((l) => { if (l.startsWith('| ') && !l.startsWith('| model |') && !l.startsWith('|---')) { const k = l.slice(2).split(' | ')[0]; if (!(k in out)) out[k] = l; } });
	return out;
};

// Hash of a transcript as the page holds it: the whole JSON, and msgSig as the page defines it (daimond.js, `msgSig`, copied).
const snapshot = (page, ids) => page.evaluate(async (ids) => {
	const st = DaimondCore.chatStore(), orig = st.__orig || st.loadMessages;
	const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36) + ':' + s.length; };
	const sig = (m) => { const c = m.content == null ? '' : String(m.content);
		return (m.mid || '') + '#' + (m.role || '') + '#' + c.length + '#' + (m.elided || 0) + '#' + (m.outcome || '') + '#' + (m.interrupted ? 1 : 0)
			+ '#' + (m.why || '') + '#' + (m.folded || 0) + '#' + (m.kept || 0) + '#' + (m.ranOn || '') + '#' + (m.handoffFellBack ? 1 : 0) + '#' + (m.interject ? 1 : 0)
			+ '#' + (m.refused ? 1 : 0) + '#' + (m.handoffRefused ? 1 : 0) + '#' + (m.retryTo || '') + '#' + (m.toDevice || '') + '#' + (m.name || '') + '#' + (m.callId || ''); };
	const msgs = {};
	for (const id of ids) { const g = await orig.call(st, id); msgs[id] = { sigs: (g.messages || []).map(sig), json: (g.messages || []).map((m) => hash(JSON.stringify(m))), session: hash(JSON.stringify(g.session || null)) }; }
	const sums = st.stored().filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, seed: r.seed || '', fp: r.fp || '', msgCount: r.msgCount, standing: r.standing || '', updatedAt: r.updatedAt, bytes: r.bytes || 0 }))
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	return { msgs: msgs, sums: sums };
}, ids);

const reloadReady = async (page) => {
	await page.reload();
	await page.waitForFunction(() => !!(window.DaimondDiamond && DaimondDiamond.usageDigest && window.DaimondCore && DaimondCore.chatStore && DaimondCore.chatResidency), null, { timeout: 40000 });
	await page.evaluate(() => DaimondCore.chatStore().booted());
	await diamondIds(page);		// the Diamond list is what names a Diamond in the digest: wait for it, as a person's first write would
	await instrument(page);
};

// ── The run ──
const S = {};		// shared by the sections: the first context, its Diamond ids, the seeded chat ids, the base section
const route = (patched) ? async (page) => {
	await page.route((u) => u.pathname.endsWith('/' + patched.file), (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: patched.src }));
} : null;

async function context(name) {
	const s = await open({ name: name, signIn: false, connect: false, route: route, profile: scratch('pw', name + '-' + process.pid) });
	await signInAs(s, 'rdig');
	await s.page.waitForFunction(() => !!(window.DaimondDiamond && DaimondDiamond.usageDigest && window.DaimondCore && DaimondCore.chatStore), null, { timeout: 30000 });
	const ids = await diamondIds(s.page);
	if (!ids.opt || !ids.help) throw new Error('this world did not seed the two default Diamonds');
	await instrument(s.page);
	return { s: s, page: s.page, ids: ids };
}

// The first context, seeded and with its first digest written (the base section every other section starts from).
async function base() {
	if (S.A) return S.A;
	const A = S.A = await context('rdig-a');
	A.seeded = await seed(A.page, A.ids, false);
	try { await A.page.evaluate(() => Promise.race([DaimondCore.collectSync(), new Promise((r) => setTimeout(r, 15000))])); } catch (e) { A.collect = String(e && e.message || e); }	// gives the rows an fp where the page can
	A.first = await writeDigest(A.page);
	A.section = section(A.first.text);
	return A;
}

const SECTIONS = {
	RD1: async () => {
		const A = await base(), sec = section(A.first.text);
		check('RD1', sec.length > 0 && /\n## Ratings\n/.test(sec), 'the written digest has a Ratings section (so absence below is not vacuous)', sec ? '' : 'none in ' + A.first.text.length + ' bytes');
		const found = POISON.filter((w) => A.first.text.toLowerCase().indexOf(w.toLowerCase()) >= 0);
		check('RD1', sec.length > 0 && found.length === 0, 'the digest file holds no word of a note, a chat name, an answer, a file path, a custom tag or a tool path', found.join(' '));
		// The pure function over the same transcripts, so a leak is caught where it is made and not only where it is written.
		const pure = await A.page.evaluate(async (ids) => {
			const st = DaimondCore.chatStore(), parts = [];
			for (const id of ids) { const g = await (st.__orig || st.loadMessages).call(st, id); parts.push(DaimondRatingRoll.chatPart(g.messages || [])); }
			return DaimondRatingRoll.digestText(DaimondRatingRoll.cells(parts, { sides: null }), []);
		}, A.seeded).catch((e) => 'THREW ' + e.message);
		const fp = POISON.filter((w) => pure.toLowerCase().indexOf(w.toLowerCase()) >= 0);
		check('RD1', pure.length > 100 && fp.length === 0, 'and neither does DaimondRatingRoll.digestText over the same chats', fp.join(' ') || pure.slice(0, 120));
		const names = sec.split('\n').filter((l) => l.startsWith('### Diamond: ')).map((l) => l.slice(13));
		check('RD1', names.length === 2 && names.every((n) => /^Daimond (Optimiser|Help)$/.test(n)), 'Diamond names come from the Diamond list', JSON.stringify(names));
	},

	RD2: async () => {
		const A = await base(), sec = section(A.first.text);
		const acct = rows(sec, 'Account, every Diamond and chat'), d1 = rows(sec, 'Diamond: Daimond Optimiser'), d2 = rows(sec, 'Diamond: Daimond Help');
		const want = [
			['account glm-5.2',   acct['glm-5.2'],   rowOf('glm-5.2', 3)],
			['account kimi-k2.7', acct['kimi-k2.7'], rowOf('kimi-k2.7', 3)],
			['Diamond Optimiser glm-5.2',  d1['glm-5.2'],   rowOf('glm-5.2', 2, 'opt')],
			['Diamond Help kimi-k2.7',     d2['kimi-k2.7'], rowOf('kimi-k2.7', 2, 'help')],
		];
		for (const [what, got, exp] of want) check('RD2', got === exp, 'the ' + what + ' row equals the hand count (counts, exposure, N more, tags, open, fixed) and the oracle (theta, share, interval)', got === exp ? got : 'got ' + got + '  want ' + exp);
		check('RD2', Object.keys(d1).join() === 'glm-5.2' && Object.keys(d2).join() === 'kimi-k2.7', 'each Diamond lists only its own model, and the ordinary chat joins no Diamond', Object.keys(d1) + ' | ' + Object.keys(d2));
		const prod = (sec.match(/^products? ?.*$/m) || [''])[0];
		check('RD2', !/Nothing rated yet/.test(sec) && sec.indexOf('### Account') >= 0, 'the account table is there, not "Nothing rated yet"', prod);
	},

	RD3: async () => {
		const A = await base(), ids = A.seeded;
		const before = await snapshot(A.page, ids);
		const w = await writeDigest(A.page);
		const after = await snapshot(A.page, ids);
		check('RD3', section(w.text).indexOf('| glm-5.2 | 7 of 8 made') >= 0, 'the write walked the ratings (the account row for glm-5.2 is in it), so what follows is not vacuous', section(w.text).slice(0, 80));
		const J = JSON.stringify;
		const moved = ids.filter((id) => J(before.msgs[id]) !== J(after.msgs[id]));
		check('RD3', moved.length === 0 && Object.keys(before.msgs).length === 3 && before.msgs[ids[0]].sigs.length > 5, 'no message of any seeded chat moves, by msgSig, by whole JSON or in its session', moved.join(' ') || before.msgs[ids[0]].sigs.length + ' messages in chat A');
		const rowsMoved = before.sums.filter((r, i) => J(r) !== J(after.sums[i]));
		check('RD3', rowsMoved.length === 0 && before.sums.length === 3, 'no summary row moves: seed, fp, msgCount, standing, updatedAt, bytes', rowsMoved.length ? J(rowsMoved) + ' -> ' + J(after.sums) : before.sums.map((r) => r.id + ' fp=' + (r.fp ? 'set' : 'unset')).join(' ') + (A.collect ? '; collect: ' + A.collect : ''));
	},

	// Round F, Opus A F4: a chat whose legacy row is ahead of its chunks (a Stage-1 leftover) is HEALED by `loadMessages`, which rewrites
	// the chunks and clears the summary's fp. The digest's walk reads through `readMessages` and must leave the store as it found it.
	// The leftover is written raw, on a cold page, and the control is the healing reader itself (so the fixture is not vacuous).
	RD3b: async () => {
		const A = await base(), page = A.page, id = A.seeded[0];
		const setup = await page.evaluate(async (id) => {
			const ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || '', name = ns ? 'daimond-chats-' + ns : 'daimond-chats';
			const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			const get = (store, key) => new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			const put = (store, val) => new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val); t.oncomplete = res; t.onerror = () => rej(t.error); });
			const row = await get('chats', id), sum = await get('chatsum', id);
			if (!row || !sum) { db.close(); return { err: 'no row or no summary for ' + id + ' in ' + name }; }
			row.messages = row.messages.concat([{ role: 'assistant', mid: 'a-leftover', ts: (row.updatedAt || 0) + 1, content: 'LEFTOVER', prod: [] }]);
			sum.fp = 'fp-probe-1';
			await put('chats', row); await put('chatsum', sum);
			db.close();
			return { name: name, rowMsgs: row.messages.length };
		}, id);
		check('RD3b', !setup.err, 'a Stage-1 leftover and a stored fingerprint were written raw into chat ' + id, setup.err || setup.name + ', row now ' + setup.rowMsgs + ' messages');
		await reloadReady(page);			// a cold page: the mirror is read from the summaries, no chat resident, the memo empty
		const raw = () => page.evaluate(async (id) => {
			const ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || '', name = ns ? 'daimond-chats-' + ns : 'daimond-chats';
			const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			const get = (store, key) => new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			const all = (store) => new Promise((res, rej) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
			const row = await get('chats', id), sum = await get('chatsum', id), chunks = (await all('msgchunks')).filter((c) => c.chatId === id);
			db.close();
			const mirror = DaimondCore.chatStore().stored().find((r) => r.id === id);
			return { fpDb: sum ? sum.fp || '' : '?', fpMirror: mirror ? mirror.fp || '' : '?', chunkRows: chunks.map((c) => c.k).sort(), chunkMsgs: chunks.reduce((n, c) => n + (c.msgs || []).length, 0), rowMsgs: row ? row.messages.length : -1 };
		}, id);
		const before = await raw();
		check('RD3b', before.fpDb === 'fp-probe-1' && before.fpMirror === 'fp-probe-1' && before.rowMsgs > before.chunkMsgs, 'the fixture stands on the cold page: fp set in the mirror and the database, the row ahead of its chunks', JSON.stringify({ fp: before.fpMirror, row: before.rowMsgs, chunks: before.chunkMsgs }));
		const w = await writeDigest(page);
		const after = await raw();
		check('RD3b', w.reads.indexOf(id) >= 0 && w.healing === 0, 'the digest write walked that chat, by the reader that does not heal', w.reads.length + ' reads, ' + w.healing + ' by loadMessages');
		check('RD3b', JSON.stringify(after) === JSON.stringify(before), 'and left it as it found it: fp, chunk rows and legacy row all unmoved', JSON.stringify(before) === JSON.stringify(after) ? '' : JSON.stringify(before) + ' -> ' + JSON.stringify(after));
		await (page.evaluate((id) => DaimondCore.chatStore().__orig.call(DaimondCore.chatStore(), id), id));
		const healed = await raw();
		check('RD3b', healed.fpMirror === '' && healed.fpDb === '' && JSON.stringify(healed.chunkRows) !== JSON.stringify(before.chunkRows), 'control: the healing reader (loadMessages) does clear the fp and rewrite the chunks on this very fixture', JSON.stringify({ fp: healed.fpMirror, rows: healed.chunkRows.length + ' vs ' + before.chunkRows.length }));
	},

	RD5: async () => {
		const A = await base();
		const B = S.B = await context('rdig-b');
		await seed(B.page, B.ids, true);
		const wb = await writeDigest(B.page), sb = section(wb.text);
		check('RD5', sb.length > 0 && sb.indexOf('### Account') >= 0 && A.section.length > 0, 'both contexts wrote a Ratings section with an account table', sb.length + ' and ' + A.section.length + ' bytes');
		check('RD5', sb === A.section, 'two contexts holding the same chats (seeded in the other order, with other row stamps) write byte-identical Ratings sections', sb === A.section ? sb.length + ' bytes' : firstDiff(A.section, sb));
		check('RD5', B.ids.opt === A.ids.opt, 'the Diamond ids agree, so the two contexts did not differ in what they were rolling', A.ids.opt + ' ' + B.ids.opt);
	},

	// Last: it adds a rating.
	RD4: async () => {
		const A = await base(), page = A.page, ids = A.seeded;
		const cold = await (async () => {		// a cold page: reloaded, memo empty
			await reloadReady(page);
			const res0 = await page.evaluate(() => DaimondCore.chatResidency().filter((c) => c.loaded).map((c) => c.id).sort());
			const all = await page.evaluate(() => DaimondCore.chatStore().stored().map((r) => r.id).sort());
			const w = await writeDigest(page);
			return { w: w, res0: res0, all: all };
		})();
		const want = cold.all.filter((id) => !cold.res0.includes(id)).sort();
		check('RD4', section(cold.w.text).indexOf('| glm-5.2 | 7 of 8 made') >= 0, 'the cold pass produced the account section', section(cold.w.text).slice(0, 60));
		check('RD4', JSON.stringify(cold.w.reads.slice().sort()) === JSON.stringify(want) && cold.w.reads.length === want.length && want.length >= 2,
			'cold: every stored chat that is not resident is read exactly once (ChatStore.loadMessages, counted)', cold.w.reads.length + ' reads of ' + want.length + ' chats: ' + cold.w.reads.join(',') + (cold.res0.length ? ' (resident, read from memory: ' + cold.res0.join(',') + ')' : ''));
		check('RD4', cold.w.healing === 0, 'cold: the walk reads through the reader that does not heal (loadMessages called ' + cold.w.healing + ' times)', 'readMessages reads ' + (cold.w.reads.length - cold.w.healing));
		check('RD4', cold.w.max === 1 && cold.w.loadCount === cold.w.reads.length, 'cold: one at a time (never two in flight), and the store\'s own loadCount agrees', 'max in flight ' + cold.w.max + ', loadCount ' + cold.w.loadCount + ', reads ' + cold.w.reads.length);
		check('RD4', JSON.stringify(cold.w.resident) === JSON.stringify(cold.res0), 'cold: no chat was made resident by the rebuild', 'before ' + cold.res0 + ' after ' + cold.w.resident);
		check('RD4', section(cold.w.text) === A.section, 'a cold page rebuilds the base section byte for byte (nothing stored)', section(cold.w.text) === A.section ? '' : firstDiff(A.section, section(cold.w.text)));
		const warm = await writeDigest(page);
		check('RD4', warm.reads.length === 0 && warm.loadCount === 0, 'warm: the second pass reads no chat at all', warm.reads.length + ' reads: ' + warm.reads.join(','));
		check('RD4', section(warm.text) === section(cold.w.text), 'the warm memo equals the cold rebuild byte for byte', firstDiff(section(cold.w.text), section(warm.text)));
		// One new rating on chat B (a new answer and its rating, as a person would make): only that chat moves.
		await page.evaluate(async (a) => {
			const st = DaimondCore.chatStore(), R = window.DaimondRatings, list = st.stored();
			const rec = list.find((c) => c.id === 'rdchatB'), got = await (st.__orig || st.loadMessages).call(st, 'rdchatB');
			const ts = a.base + 900000 * 1000, ans = got.messages.find((m) => m.mid === 'a-y4'), prod = JSON.parse(JSON.stringify(ans.prod[0]));
			prod.h = 'p1:answer:rdchatB/a-y9'; prod.t = 'my9';
			const a9 = { role: 'assistant', mid: 'a-y9', ts: ts, content: 'PLATYPUSBODY y9', prod: [prod] };
			const id = R.newId(ts + 1000, 'q9999');
			const r9 = R.message(R.build({ prod: prod, s: -1, clear: false, tags: [], dims: {}, note: '', src: 'tap', sup: '', burst: '', tools: '', len: 300 }), id, ts + 1000);
			rec.messages = got.messages.concat([a9, r9]); rec.updatedAt = ts + 2000;
			await st.save(list);
			try { await st.settled(); } catch (e) { /* the alarm is up */ }
		}, { base: BASE_TS });
		const one = await writeDigest(page);
		const row = rows(section(one.text), 'Account, every Diamond and chat')['kimi-k2.7'] || '';
		check('RD4', one.reads.length === 1 && one.reads[0] === 'rdchatB' && one.loadCount === 1, 'after one new rating only that chat is read again', one.reads.length + ' reads: ' + one.reads.join(','));
		check('RD4', /^\| kimi-k2\.7 \| 6 of 7 made \| 2 up, 3 down, 1 neutral \|/.test(row) && section(one.text) !== section(warm.text), 'and the figures moved by exactly that rating (kimi-k2.7 6 of 7, one more down)', row.slice(0, 90));
		await reloadReady(page);
		const again = await writeDigest(page);
		check('RD4', section(again.text) === section(one.text), 'a cold page after the new rating rebuilds the warm memo byte for byte', firstDiff(section(one.text), section(again.text)));
	},
};
const ORDER = ['RD1', 'RD2', 'RD3', 'RD5', 'RD4', 'RD3b'];
function firstDiff(a, b) {
	if (a === b) return '';
	let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return 'first difference at ' + i + ': ' + JSON.stringify(a.slice(Math.max(0, i - 30), i + 60)) + ' vs ' + JSON.stringify(b.slice(Math.max(0, i - 30), i + 60));
}

try {
	// PRE: the module the sections read, on the first page. Absent on <LIVE>, which is the first red.
	const first = await base();
	const there = await first.page.evaluate(() => !!(window.DaimondRatingRoll && DaimondRatingRoll.digestText && DaimondCore.chatStore().loadCount)).catch(() => false);
	check('PRE', there, 'the roll-up module (window.DaimondRatingRoll.digestText) and the store\'s loadCount are on the page');
	for (const k of ORDER) if (!ONLY || ONLY.includes(k)) { console.log(`\n── ${k}`); await SECTIONS[k](); }
} catch (e) { tally.bad.push('threw'); console.log('  FAIL threw -- ' + (e && e.stack || e)); }
finally { for (const k of ['A', 'B']) { try { if (S[k]) await S[k].s.close(); } catch (e) { /* closed */ } } }
console.log(`\nverify_ratings_digest: ${tally.ok} ok, ${tally.bad.length} failed${tally.bad.length ? ' (' + [...new Set(tally.bad)].join(', ') + ')' : ''}`);
process.exit(tally.bad.length ? 1 : 0);
