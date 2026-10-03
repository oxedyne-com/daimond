// gateway: live
// verify_chatshape.mjs -- a chat the phone offloads and the desktop carries inline ends in ONE shape on both
// devices and on the head, without a reload, and an empty transcript is never offloaded (the chat shape law, F3b;
// specs/daimond_sync_f1_log.md sections 12 and 13). A computer and a phone, one tab each.
//
// A phone's inline room for transcripts is 256 kB against a desktop's 1 MB, so past the phone's room the rest of the
// chats ride as a reference from the phone and inline from the desktop. `applyChats` took a reference only for a
// brand-new, non-empty chat, so the desktop, holding every transcript already, never took the phone's manifest: it read
// the same chunks again on every pull (the S1 soak: a third of all reads were the 30-byte chunk of an empty transcript,
// the rest 1 kB transcripts read about 35 times each), and each device stood on its own last push. The law is F3's,
// for chats: at an equal transcript a reference stands over inline, one way and never back until the transcript moves
// (daimond.js, `shapeStands`, `shapeAdopts`, `shapeInlineSet`), and an empty transcript always travels inline.
//
//   C   (F3b-0) the chat record keeps its summary: after a pull and a collect a ~1 kB chat is inline on a device with room
//       to spare, and each store holds the chat's `bytes` before any collect (red on 40dbb627 and cd72283c).
//   A   the desktop makes three ~86 kB chats (they spend the phone's room), nine ~1 kB chats and nine empty ones;
//       the phone takes them, adds the one chat that leaves its room spent to the byte, and offloads what it cannot
//       hold. After calm every chat has the same shape on the desktop, the phone and the head (a reference carrying
//       the same manifest key), no empty transcript is a reference anywhere, the head stays put over further
//       rounds, and the phone's renames (a chat's name moves, its transcript does not) cost the desktop no chunk read.
//   B   A, then the desktop appends to a chat that is a reference: its transcript moves, so it is a candidate for
//       inline again, travels, and everything settles to one shape once more -- and the edit lands on the phone.
//
//   node dev/verify_chatshape.mjs [--arms=A,B]
//   node dev/verify_chatshape.mjs --break nofigures # F3b-0 off: the mirror loses its summary figures at every save
//   node dev/verify_chatshape.mjs --break nosticky   # a reference may go back to inline at its transcript
//   node dev/verify_chatshape.mjs --break noadopt    # an equal-transcript reference is not adopted
//   node dev/verify_chatshape.mjs --break noempty    # an empty transcript may be offloaded
//   node dev/verify_chatshape.mjs --break noshape    # all three: the build before F3b (40dbb627)
import { open, signInAs, scratch, newChat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// F3b-0 off: the store's save does not carry the summary figures across the mirror's replacement (the build before 4ee749fd).
	nofigures: [{ file: 'js/daimond.js', find: 'carryChatFigures(list, mirror);', with: '/* F3b-0 off */' }],
};
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'`); process.exit(2); }
const WWW = new URL('../www', import.meta.url).pathname;
const PATCHED = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const s0 = PATCHED.get(spec.file) ?? fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	if (s0.split(spec.find).length !== 2) { console.error(`break '${BREAK}': anchor not unique in ${spec.file}`); process.exit(2); }
	PATCHED.set(spec.file, s0.replace(spec.find, spec.with));
}
const route = PATCHED.size ? async (page) => {
	for (const [f, body] of PATCHED) await page.route('**/' + f, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
} : null;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const ARMS = ((process.argv.find((a) => a.startsWith('--arms=')) || '--arms=C,A,B').slice(7)).split(',').filter(Boolean);
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PHONE_ROOM = 256 * 1024;			// SYNC_INLINE_SOFT_MOBILE_MAX, the phone's inline room
const J = (x) => JSON.stringify(x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tally = { ok: 0, bad: [] };
const ctl = (arm, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(arm);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${arm}  ${what}${detail ? ' -- ' + String(detail).slice(0, 1400) : ''}`); };
const note = (t) => console.log('  note ' + String(t).slice(0, 3000));

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
async function paired(lead, name, label, extra = {}) {
	const d = await open({ name: name + '-' + label, signIn: false, connect: false, defaults: false,
		profile: scratch('pw', name + '-' + label), route, ...extra });
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, name);
	await ready(d);
	await sleep(2000);
	return d;
}
const push = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	const r = window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push();
	return r && typeof r === 'object' ? { ok: r.ok, version: r.version } : r;
}).then(async (r) => { await sleep(400); return r; }).catch((e) => 'threw ' + e);
const pull = (s) => s.page.evaluate(async () => {
	try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older build */ }
	return DaimondSync.pull();
}).then(() => sleep(400)).catch(() => {});
const settle = (s) => s.page.evaluate(() => window.DaimondCore.chatStore().settled()).catch(() => {});

/// What the device would send now, per chat id: inline, or the manifest key it names.
const shapeOf = (e) => e.messagesRef ? 'ref:' + String(e.messagesRef.key).slice(0, 12) : (Array.isArray(e.messages) ? 'inline' : 'none');
const shapes = (s) => s.page.evaluate(async () => {
	const p = await DaimondSync.parcel();
	const out = {};
	for (const e of (p.chats || [])) out[e.id] = e.messagesRef ? 'ref:' + String(e.messagesRef.key).slice(0, 12) : (Array.isArray(e.messages) ? 'inline' : 'none');
	return out;
});
/// What the head holds, opened: the latest parcel's chats per id, and its version.
const head = (s) => s.page.evaluate(async () => {
	const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) } });
	const g = await r.json().catch(() => null);
	if (!g || !g.blob) return null;
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const out = {};
	for (const e of (st.chats || [])) out[e.id] = e.messagesRef ? 'ref:' + String(e.messagesRef.key).slice(0, 12) : (Array.isArray(e.messages) ? 'inline' : 'none');
	return { v: g.version | 0, shapes: out };
});
const count = (m, f) => Object.values(m).filter(f).length;
const isRef = (x) => String(x).startsWith('ref:');

/// A turn of `words` characters sent to the mock (`@text` answers with the same words), as a person sends one.
const turn = async (s, words) => {
	const { page } = s;
	await page.fill('#chat-input', '@text ' + ('lorem ipsum dolor sit amet '.repeat(Math.ceil(words / 27))).slice(0, words));
	await page.click('#chat-send', { force: true });
	await sleep(300);
	for (let i = 0; i < 160; i++) {
		const busy = await page.evaluate(() => { const b = document.getElementById('chat-send');
			return !!b && (/stop/i.test((b.getAttribute('title') || '') + (b.className || '')) || b.disabled); });
		if (!busy) break;
		await sleep(250);
	}
	await sleep(500);
};
/// A chat made the way the app makes one: the "+" control, then `turns` turns of `words` characters, so the record lives in
/// the app's own `chats` array (hydrated, persisted by `persistChats`) and not only in the store. Answers its id.
const appChat = async (s, words, turns = 1) => {
	const id = await newChat(s);
	if (words) for (let i = 0; i < turns; i++) await turn(s, words);
	return id;
};
const exportHas = (s, id, needle) => s.page.evaluate(async ({ id, needle }) => {
	try { const got = await DaimondCore.chatStore().loadMessages(id); return JSON.stringify(got.messages).includes(needle); } catch (e) { return false; }
}, { id, needle });
/// The device's own account of a chat: its summary (bytes, message count).
const sums = (s) => s.page.evaluate(() => {
	const out = {};
	for (const c of (DaimondCore.chatStore().stored() || [])) out[c.id] = { bytes: c.bytes, n: c.msgCount };
	return out;
});
/// Count the chunk reads a device makes from now on.
const countReads = (s) => s.page.evaluate(() => {
	if (window.__reads === undefined) {
		window.__reads = 0;
		const o = DaimondChunks.materialiseBytes;
		DaimondChunks.materialiseBytes = function () { window.__reads++; return o.apply(this, arguments); };
	}
	return typeof DaimondChunks.materialiseBytes === 'function' && window.__reads === 0;
});
const reads = (s) => s.page.evaluate(() => window.__reads);
async function rounds(D, Ph, k) {
	for (let i = 0; i < k; i++) { await push(D); await pull(Ph); await push(Ph); await pull(D); await push(D); await pull(Ph); }
}
/// The three shapes side by side: where they differ, one line per chat.
async function compare(D, Ph) {
	const d = await shapes(D), p = await shapes(Ph), h = await head(D);
	const ids = new Set([...Object.keys(d), ...Object.keys(p), ...Object.keys((h && h.shapes) || {})]);
	const diff = [];
	for (const id of ids) {
		const a = d[id] || '-', b = p[id] || '-', c = ((h && h.shapes) || {})[id] || '-';
		if (a !== b || a !== c) diff.push(`${id}: desk ${a} phone ${b} head ${c}`);
	}
	return { d, p, h, diff, n: ids.size };
}

async function arm(tag) {
	console.log(`\n── ${tag}: ${tag === 'A' ? 'three ~86 kB, nine ~1 kB and nine empty chats made on the desktop, the phone offloads what its room cannot hold' : 'the desktop appends to a reference: the transcript moves and the chat settles once more'} ──`);
	const NAME = 'cshape' + tag.toLowerCase() + '-' + process.pid;
	let D = null, Ph = null;
	try {
		D = await open({ name: NAME, defaults: false, profile: scratch('pw', NAME + '-d'), route });
		await ready(D);
		ctl(tag, (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
		Ph = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
		ctl(tag, await countReads(D) && await countReads(Ph), 'the chunk reads are counted on both devices');

		// Made on the desktop through the app (the "+" control and a turn each), oldest first: the empty chats, then the 1 kB
		// chats, then the three big ones, which are the freshest and spend the phone's room.
		const SM = 9, EM = 9;
		const empty = [], small = [], big = [];
		for (let k = 0; k < EM; k++) empty.push({ id: await appChat(D, 0) });
		for (let k = 0; k < SM; k++) small.push({ id: await appChat(D, 450) });
		for (let k = 0; k < 3; k++) big.push({ id: await appChat(D, 42700) });
		await settle(D);
		const all = [...big, ...small, ...empty].map((r) => r.id);
		const ds = await sums(D);
		const bigB = big.map((r) => (ds[r.id] || {}).bytes | 0), smallB = small.map((r) => (ds[r.id] || {}).bytes | 0);
		note(`${tag}: the desktop's chats by the app -- big ${bigB.join('/')} B, small ${smallB.join('/')} B, empty ${empty.map((r) => (ds[r.id] || {}).bytes).join('/')}`);
		const own = await shapes(D);
		ctl(tag, all.every((id) => own[id] === 'inline'), 'setup: the desktop would send all 21 chats inline (its room is 1 MB)',
			all.filter((id) => own[id] !== 'inline').map((id) => `${id}:${own[id]}`).join(' '));

		await push(D); await pull(Ph);
		await shapes(Ph);
		const ph1 = await shapes(Ph), ps = await sums(Ph);
		const spent = Object.keys(ph1).filter((id) => ph1[id] === 'inline' && (ps[id] || {}).n > 0).reduce((a, id) => a + ((ps[id] || {}).bytes | 0), 0);
		note(`${tag}: the phone's inline chats spend ${spent} of ${PHONE_ROOM} bytes`);
		await push(Ph); await pull(D);
		const ph2 = await shapes(Ph);
		const splitSmall = small.map((r) => r.id).filter((id) => isRef(ph2[id]));
		const splitEmpty = empty.map((r) => r.id).filter((id) => isRef(ph2[id]));
		ctl(tag, splitSmall.length >= 1 && count(ph2, (x) => x === 'inline') >= 1,
			'setup: the phone has spent its room -- some chats inline, the rest references (the split)', J(ph2));
		note(`${tag}: the phone offloads ${splitSmall.length} of ${SM} one-kB chats and ${splitEmpty.length} of ${EM} empty ones`);
		const bigRef = big.map((r) => r.id).filter((id) => isRef(ph2[id]));
		ctl(tag, bigRef.length === 0, 'setup: the three big chats ride inline on the phone (they are what spends its room)', J(bigRef));

		await rounds(D, Ph, 4);
		let c = await compare(D, Ph);
		const split = [...splitSmall, ...splitEmpty];
		ctl(tag, c.n >= 22 && all.every((id) => c.d[id] !== undefined && c.p[id] !== undefined) && c.diff.length === 0,
			'calm: every chat has one shape on the desktop, the phone and the head, without a reload', c.diff.slice(0, 6).join(' | '));
		const refs = small.map((r) => r.id).filter((id) => isRef(ph2[id]));
		ctl(tag, refs.every((id) => isRef(c.d[id]) && c.d[id] === c.p[id] && c.p[id] === ((c.h || {}).shapes || {})[id] && c.p[id] === ph2[id]),
			'calm: each 1 kB chat the phone offloaded is a reference on all three, naming the manifest the phone made',
			refs.map((id) => `${id}: ${c.d[id]}/${c.p[id]}/${((c.h || {}).shapes || {})[id]} was ${ph2[id]}`).join(' | '));
		const emptyRef = empty.map((r) => r.id).filter((id) => isRef(c.d[id]) || isRef(c.p[id]) || isRef(((c.h || {}).shapes || {})[id]));
		ctl(tag, emptyRef.length === 0, 'calm: no empty transcript is a reference on the desktop, the phone or the head (each is two bytes inline)', emptyRef.join(' '));

		// The head stays where it is: no device owes another a push.
		const v0 = (await head(D)).v;
		await rounds(D, Ph, 2);
		const v1 = (await head(D)).v;
		ctl(tag, v1 === v0, 'calm: two more rounds move the head by nothing (no ping-pong)', `v${v0} -> v${v1}`);

		// The phone renames a chat it holds as a reference; the desktop reads the head each time and must not
		// materialise a transcript it already stands on.
		const r0 = await reads(D);
		const tickIds = refs.slice(0, 3);
		for (let i = 0; i < 3; i++) {
			await Ph.page.evaluate(async ({ id, i }) => {
				const store = DaimondCore.chatStore();
				const list = store.stored().map((c) => c.id === id ? Object.assign({}, c, { name: 'tick ' + i, metaAt: Date.now() + i }) : c);
				store.save(list);
				await store.settled();
			}, { id: tickIds[i % tickIds.length], i });
			await push(Ph); await pull(D); await push(D); await pull(Ph);
		}
		const dr = (await reads(D)) - r0;
		note(`${tag}: the desktop's chunk reads over three pulls of the phone's renames: ${dr}`);
		ctl(tag, dr === 0, 'the desktop reads no chunk of a reference it already stands on (three pulls)', `${dr} reads`);
		await rounds(D, Ph, 2);
		c = await compare(D, Ph);
		ctl(tag, c.diff.length === 0, 'after the renames: one shape again on all three', c.diff.slice(0, 6).join(' | '));

		if (tag === 'B') {
			// The desktop appends to a chat that is a reference everywhere: its transcript moves.
			const id = refs[0], mark = 'EDITED-' + process.pid;
			await D.page.evaluate(async ({ id, mark }) => {
				const store = DaimondCore.chatStore();
				const got = await store.loadMessages(id);
				const list = store.stored().map((c) => c.id === id
					? Object.assign({}, c, { messages: got.messages.concat([{ role: 'user', content: mark, mid: 'edit-m', ts: Date.now() }]), updatedAt: Date.now(), metaAt: Date.now() }) : c);
				store.save(list);
				await store.settled();
			}, { id, mark });
			const e0 = await shapes(D);
			ctl(tag, e0[id] === 'inline', 'the append moved the transcript: the desktop sends the chat inline again (a candidate once more)', e0[id]);
			await rounds(D, Ph, 4);
			c = await compare(D, Ph);
			ctl(tag, c.diff.length === 0, 'after the append: one shape on all three, without a reload', c.diff.slice(0, 6).join(' | '));
			note(`${tag}: the appended chat settles as ${c.d[id]} on the desktop, ${c.p[id]} on the phone`);
			ctl(tag, await exportHas(Ph, id, mark), 'the append reached the phone');
		}
	} catch (e) {
		ctl(tag, false, 'the run completes', (e && e.stack) || e);
	} finally {
		for (const d of [Ph, D]) if (d) await d.close().catch(() => {});
	}
}

/// C (F3b-0): the chat record keeps its summary, so a pull followed by a collect does not offload a small chat.
/// `ChatStore.save` is `mirror = list`, and every list it is handed is built from `slimChat` output (no `bytes`, no `fp`), so a
/// device that saved a chat, or merged one from a parcel, ranked it "too large to ride inline" at the next collect and sent it as
/// a reference whatever room it had.
async function armC() {
	const tag = 'C';
	console.log('\n── C (F3b-0): a pull followed by a collect keeps a ~1 kB chat inline on a device with room to spare ──');
	const NAME = 'cshapec-' + process.pid;
	let D = null, Ph = null;
	try {
		D = await open({ name: NAME, defaults: false, profile: scratch('pw', NAME + '-d'), route });
		await ready(D);
		ctl(tag, (await makePagePro(D.page, GWDIR, GW_URL)).pro === true, 'the account holds Pro');
		Ph = await paired(D, NAME, 'p', { ua: IPHONE, isMobile: true, touch: true });
		const small = [];
		for (let k = 0; k < 4; k++) small.push(await appChat(D, 450));
		const empty = [await appChat(D, 0), await appChat(D, 0)];
		await settle(D);
		const ds0 = await sums(D);
		ctl(tag, small.every((id) => typeof (ds0[id] || {}).bytes === 'number'),
			'the desktop\'s store holds a summary (bytes) for each chat the app saved, before any collect', small.map((id) => `${id}:${(ds0[id] || {}).bytes}`).join(' '));
		const own = await shapes(D);
		const sb = small.map((id) => (ds0[id] || {}).bytes | 0);
		note(`${tag}: the desktop's 1 kB chats are ${sb.join('/')} B`);
		ctl(tag, small.every((id) => own[id] === 'inline'), 'the desktop sends each 1 kB chat inline at its first collect (room 1 MB)', small.filter((id) => own[id] !== 'inline').map((id) => `${id}:${own[id]}`).join(' '));
		await push(D); await pull(Ph);
		const ps0 = await sums(Ph);
		ctl(tag, small.every((id) => typeof (ps0[id] || {}).bytes === 'number'),
			'the phone\'s store holds a summary (bytes) for each chat the pull merged, before its collect', small.map((id) => `${id}:${(ps0[id] || {}).bytes}`).join(' '));
		const ph = await shapes(Ph);
		const off = small.filter((id) => isRef(ph[id]));
		ctl(tag, off.length === 0, 'a pull followed by a collect leaves each 1 kB chat inline on the phone (256 kB of room, a few kB spent)', off.map((id) => `${id}:${ph[id]}`).join(' '));
		note(`${tag}: the phone's empty chats read ${empty.map((id) => ph[id]).join('/')} (F3b-1's rule, not this section's)`);
		await rounds(D, Ph, 3);
		const c = await compare(D, Ph);
		note(`${tag}: after three rounds ${c.diff.length} chat(s) differ in shape between desktop, phone and head${c.diff.length ? ': ' + c.diff.slice(0, 4).join(' | ') : ''}`);
	} catch (e) {
		ctl(tag, false, 'the run completes', (e && e.stack) || e);
	} finally {
		for (const d of [Ph, D]) if (d) await d.close().catch(() => {});
	}
}

for (const a of ARMS) await (a === 'C' ? armC() : arm(a));
const failed = tally.bad.length;
console.log(failed ? `\n${tally.ok} passed, ${failed} failed (${[...new Set(tally.bad)].join(',')})` : `\nall ${tally.ok} checks passed`);
process.exit(failed ? 1 : 0);
