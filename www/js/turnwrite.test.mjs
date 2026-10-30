// The chat log's writing side on the tab (P2.3b, page/turnwrite.js), through the real engine
// codec: a Here turn's rows reach the log on send, rows written offline wait under their turn
// id and go once the gateway answers, a 409 `ended` stops the turn's writing, and a 413 halves.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', 'pkg');
const skip = !existsSync(join(PKG, 'oxedyne_daimond_bg.wasm')) && 'no www/pkg wasm here';

// `share` is another tab's `{gw, key}`: a second device of the account, its own writer
// (a module instance of its own) on the same log.
let tabs = 0;
async function rig(share) {
	const m = await import(join(PKG, 'oxedyne_daimond.js'));
	m.initSync({ module: readPage(join(PKG, 'oxedyne_daimond_bg.wasm')) });
	const tl = await import(join(HERE, 'page', 'turnwrite.js') + '?tab=' + (++tabs));
	const key = share ? share.key
		: await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
	const enc = new TextEncoder();
	const wrap = async (plain, aad) => {
		const iv = webcrypto.getRandomValues(new Uint8Array(12));
		const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
		const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
	};
	const unwrap = async (bytes, aad) => new Uint8Array(await webcrypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, key, bytes.slice(12)));
	const bridge = {
		rowAad:  () => m.row_aad(),
		rowSeal: (h, b) => m.row_seal(JSON.stringify(h), JSON.stringify(b)),
		rowWire: (h, s) => JSON.parse(m.row_wire(JSON.stringify(h), s)),
		logDiff: (w, msgs, end) => JSON.parse(m.log_diff(JSON.stringify(w || {}), JSON.stringify(msgs), end ? JSON.stringify(end) : '')),
		logRows: (t, d, n, c, p) => JSON.parse(m.log_rows(t, d || '', n, JSON.stringify(c), p)),
	};
	// The gateway's log (chatlog.rs `chatlog_append`): (turn, n) taken once, first end wins,
	// 409 for rows after an end, and an end for an open turn under a number already held
	// lands after the turn's last row.
	const gw = share ? share.gw
		: { up: true, rows: [], ended: {}, moved: {}, posts: 0, rowMax: 16384, batchMax: 262144, refuseBatchOver: Infinity, flushMs: 1, batches: [] };
	const append = async (chat, rows) => {
		gw.posts++;
		if (!gw.up) return { status: 0 };
		const meta = { row_max: gw.rowMax, batch_max: gw.batchMax, flush_ms: gw.flushMs };
		gw.batches.push(rows.length);
		if (rows.length > gw.refuseBatchOver) return { status: 413, json: meta };
		const last = (turn) => Math.max(0, ...gw.rows.filter(x => x.turn === turn).map(x => x.n));
		const keep = [];
		for (const r of rows) {
			const held = Math.max(last(r.turn), ...keep.filter(k => k.turn === r.turn).map(k => k.n));
			const ended = gw.ended[r.turn] || keep.some(k => k.turn === r.turn && k.kind === 'end');
			let n = r.n;
			if (ended) {
				if (n < held || (n === held && r.kind === 'end' && !gw.moved[r.turn])) continue;
			} else if (n <= held) {
				if (r.kind !== 'end') continue;
				n = held + 1;
			}
			if (ended) {
				return { status: 409, json: { ok: false, why: 'ended', turn: r.turn, ...meta } };
			}
			keep.push({ ...r, n, moved: n !== r.n });
		}
		for (const { moved, ...r } of keep) {
			gw.rows.push({ chat, ...r, seq: gw.rows.length + 1 });
			if (r.kind === 'end') { gw.ended[r.turn] = true; if (moved) gw.moved[r.turn] = true; }
		}
		return { status: 200, json: { ok: true, head: gw.rows.length, ...meta } };
	};
	let kept = [];
	const ends = [], landed = [];
	tl.configureTurnLog({ bridge, wrap, append,
		store: { load: () => kept, save: (r) => { kept = JSON.parse(JSON.stringify(r)); } },
		onEnded: (chat, turn) => ends.push(turn),
		onLanded: (chat, head) => landed.push([chat, head]) });
	// A turn as the log folds it, through the engine's TurnView.
	const fold = async (turn) => {
		let view = { turn };
		for (const w of gw.rows.filter(r => r.turn === turn)) {
			const plain = await unwrap(m.row_sealed(JSON.stringify(w)), m.row_aad());
			const row = m.row_open(JSON.stringify(w), plain);
			view = JSON.parse(m.turnview_apply(JSON.stringify(view), row)).view;
		}
		return view;
	};
	return { tl, gw, key, fold, ends, landed, kept: () => kept };
}

test('a Here turn appends its rows on send and its end last', { skip }, async () => {
	const { tl, gw, fold } = await rig();
	const msgs = [
		{ mid: 'old', role: 'user', content: 'before' },
		{ mid: 'u1', role: 'user', content: 'hello', _local: 1 },
	];
	assert.ok(await tl.logTurn('c1', 'u1', tl.turnMessages(msgs, 'u1')));
	assert.equal(gw.rows.length, 1, 'the user row reached the log on send');
	msgs.push({ mid: 'a1', role: 'assistant', content: 'hi there', iturn: 'u1' });
	await tl.logTurn('c1', 'u1', tl.turnMessages(msgs, 'u1'), { status: 'done' });
	const v = await fold('u1');
	assert.deepEqual(v.rows.map(r => [r.mid, r.text]), [['u1', 'hello'], ['a1', 'hi there']]);
	assert.equal(v.end.status, 'done');
	assert.ok(!JSON.stringify(v).includes('_local'), 'a local field left the device');
	assert.ok(tl.turnLogEnded('u1'));
});

test('rows written offline wait under their turn id and go when the gateway answers', { skip }, async () => {
	const { tl, gw, fold, kept } = await rig();
	gw.up = false;
	const msgs = [{ mid: 'u2', role: 'user', content: 'offline ask' }];
	await tl.logTurn('c1', 'u2', tl.turnMessages(msgs, 'u2'));
	msgs.push({ mid: 'a2', role: 'assistant', content: 'offline answer' });
	await tl.logTurn('c1', 'u2', tl.turnMessages(msgs, 'u2'), { status: 'done' });
	assert.equal(gw.rows.length, 0);
	assert.equal(tl.turnLogPending(), 3);
	assert.equal(kept().length, 3, 'the outbox is kept across a reload');
	gw.up = true;
	await tl.flushTurnLog();
	assert.equal(tl.turnLogPending(), 0);
	assert.ok(gw.rows.every(r => r.turn === 'u2'));
	const v = await fold('u2');
	assert.equal(v.rows.length, 2);
	assert.equal(v.end.status, 'done');
});

test("a 409 'ended' stops the turn's writing and drops its rows", { skip }, async () => {
	const { tl, gw, ends } = await rig();
	const msgs = [{ mid: 'u3', role: 'user', content: 'ask' }];
	await tl.logTurn('c1', 'u3', tl.turnMessages(msgs, 'u3'));
	// Another device's detector ended the turn.
	gw.rows.push({ chat: 'c1', turn: 'u3', n: 2, kind: 'end', seq: gw.rows.length + 1 });
	gw.ended.u3 = true; gw.moved.u3 = true;
	msgs.push({ mid: 'a3', role: 'assistant', content: 'late' });
	await tl.logTurn('c1', 'u3', tl.turnMessages(msgs, 'u3'));
	await tl.flushTurnLog();
	assert.deepEqual(ends, ['u3']);
	assert.equal(tl.turnLogPending(), 0);
	assert.equal(await tl.logTurn('c1', 'u3', tl.turnMessages(msgs, 'u3'), { status: 'done' }), false,
		'a turn the log ended takes no more rows');
});

test('a 413 halves the batch and the rows still arrive in order', { skip }, async () => {
	const { tl, gw, fold } = await rig();
	gw.up = false;
	const msgs = [{ mid: 'u4', role: 'user', content: 'q' }];
	for (let i = 0; i < 6; i++) msgs.push({ mid: 'a4' + i, role: 'tool_log', content: 'x' + i });
	await tl.logTurn('c1', 'u4', tl.turnMessages(msgs, 'u4'), { status: 'done' });
	gw.up = true; gw.refuseBatchOver = 2;
	await tl.flushTurnLog();
	const v = await fold('u4');
	assert.equal(v.rows.length, 7);
	assert.deepEqual(gw.rows.map(r => r.n), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('streamed answer text goes once per flush_ms, not once per delta', { skip }, async () => {
	const { tl, gw, fold } = await rig();
	gw.flushMs = 40;
	const msgs = [{ mid: 'u5', role: 'user', content: 'tell me' }];
	await tl.logTurn('c1', 'u5', tl.turnMessages(msgs, 'u5'));
	assert.equal(gw.rows.length, 1, 'the prompt goes on send');
	// The live answer, called in on every delta the way runTurn does.
	let text = '';
	for (let i = 0; i < 30; i++) {
		text += 'w' + i + ' ';
		await tl.logTurn('c1', 'u5', tl.turnMessages(msgs, 'u5').concat([{ mid: 'a5', role: 'assistant', content: text }]));
	}
	assert.equal(gw.rows.length, 1, 'no delta went on its own');
	await new Promise(r => setTimeout(r, 120));
	assert.equal(gw.rows.length, 2, 'one row for the whole flush');
	for (let i = 0; i < 5; i++) {
		text += 'z' + i + ' ';
		await tl.logTurn('c1', 'u5', tl.turnMessages(msgs, 'u5').concat([{ mid: 'a5', role: 'assistant', content: text }]));
	}
	msgs.push({ mid: 'a5', role: 'assistant', content: text });
	await tl.logTurn('c1', 'u5', tl.turnMessages(msgs, 'u5'), { status: 'done' });
	assert.deepEqual(gw.rows.map(r => r.kind), ['msg', 'msg', 'more', 'end']);
	const v = await fold('u5');
	assert.deepEqual(v.rows.map(r => [r.mid, r.text]), [['u5', 'tell me'], ['a5', text]]);
	assert.equal(v.end.status, 'done');
});

test("logEnd ends a turn this device wrote without tombing its rows", { skip }, async () => {
	const { tl, fold } = await rig();
	const msgs = [{ mid: 'u6', role: 'user', content: 'ask' }, { mid: 'a6', role: 'assistant', content: 'part' }];
	await tl.logTurn('c1', 'u6', tl.turnMessages(msgs, 'u6'));
	await tl.logEnd('c1', 'u6', { status: 'interrupted' });
	const v = await fold('u6');
	assert.deepEqual(v.rows.map(r => r.mid), ['u6', 'a6']);
	assert.equal(v.end.status, 'interrupted');
});

// ── The one dead-writer detector (design §2 [F3]) ──

const endsOf = (gw, turn) => gw.rows.filter(r => r.turn === turn && r.kind === 'end').length;

test('a lease past its deadline with no end gets exactly one interrupted end', { skip }, async () => {
	const a = await rig();
	const msgs = [{ mid: 'u5', role: 'user', content: 'run long' }, { mid: 'a5', role: 'assistant', content: 'part' }];
	await a.tl.logTurn('c1', 'u5', a.tl.turnMessages(msgs, 'u5'));
	await a.tl.flushTurnLog();
	// The tab that ran it died; another device reads its lease dead, on two looks.
	const b = await rig(a);
	const dead = [{ turnId: 'u5', chatId: 'c1' }];
	assert.equal(await b.tl.endDeadTurns(dead), 1);
	assert.equal(await b.tl.endDeadTurns(dead), 0, 'a second look writes nothing');
	assert.equal(endsOf(a.gw, 'u5'), 1);
	const v = await a.fold('u5');
	assert.equal(v.end.status, 'interrupted');
	assert.deepEqual(v.rows.map(r => r.mid), ['u5', 'a5'], 'the end lands after the rows the run wrote');
	// A turn the log has ended already is left as it ended.
	await a.tl.logTurn('c1', 'u6', [{ mid: 'u6', role: 'user', content: 'x' }], { status: 'done' });
	await b.tl.endDeadTurns([{ turnId: 'u6', chatId: 'c1' }]);
	assert.equal(endsOf(a.gw, 'u6'), 1);
	assert.equal((await a.fold('u6')).end.status, 'done');
});

test('two detectors write one end: the first end wins', { skip }, async () => {
	const a = await rig();
	await a.tl.logTurn('c1', 'u7', [{ mid: 'u7', role: 'user', content: 'y' }]);
	await a.tl.flushTurnLog();
	const b = await rig(a), c = await rig(a);
	const dead = [{ turnId: 'u7', chatId: 'c1' }];
	await Promise.all([b.tl.endDeadTurns(dead), c.tl.endDeadTurns(dead)]);
	assert.equal(endsOf(a.gw, 'u7'), 1);
	assert.equal((await a.fold('u7')).end.status, 'interrupted');
	// The writer, back, is refused and stops.
	assert.equal(await a.tl.logTurn('c1', 'u7', [{ mid: 'u7', role: 'user', content: 'y' },
		{ mid: 'a7', role: 'assistant', content: 'late' }]), true);
	await a.tl.flushTurnLog();
	assert.deepEqual(a.ends, ['u7']);
	assert.ok(a.tl.turnLogEnded('u7'));
});

test('a detector end that lands tells this device\'s reader, which no tap will (P2.3c3 c)', { skip }, async () => {
	// The gateway taps every device but the writer (sync.rs log_put), so the end this device's
	// detector wrote reaches its own screen only if the writer says so.
	const a = await rig();
	await a.tl.logTurn('c1', 'u8', [{ mid: 'u8', role: 'user', content: 'z' }]);
	await a.tl.flushTurnLog();
	assert.deepEqual(a.landed, [], 'a run\'s own rows are drawn by the run, not read back');
	const b = await rig(a), c = await rig(a);
	assert.equal(await b.tl.endDeadTurns([{ turnId: 'u8', chatId: 'c1' }]), 1);
	assert.deepEqual(b.landed, [['c1', a.gw.rows.length]], 'the end taken: read the chat to its head');
	// A second detector refused 409 'ended': the end is there, so it reads too.
	await c.tl.endDeadTurns([{ turnId: 'u8', chatId: 'c1' }]);
	assert.equal(endsOf(a.gw, 'u8'), 1);
	assert.deepEqual(c.landed.map((l) => l[0]), ['c1']);
});

test("the reader's ended check stops the detector before it writes (P2.3c1)", { skip }, async () => {
	const a = await rig();
	await a.tl.logTurn('c1', 'u8', [{ mid: 'u8', role: 'user', content: 'z' }], { status: 'done' });
	const b = await rig(a);
	const asked = [];
	b.tl.readerEnded((chat, turn) => { asked.push(chat + ':' + turn); return turn === 'u8'; });
	const posts = a.gw.posts;
	assert.equal(await b.tl.endDeadTurns([{ turnId: 'u8', chatId: 'c1' }]), 0);
	assert.deepEqual(asked, ['c1:u8']);
	assert.equal(a.gw.posts, posts, 'nothing sent for a turn the reader saw end');
	b.tl.readerEnded(null);
});

// P2.3a3: a turn not run ends with its reason as the end's own `not_run` field (engine
// `End.not_run`), the set fields only; `endTurnNotRun`, which every not-run ending (the
// hand-back, the `abi` refusal, the backstop) passes through, writes it.
test("a not-run end carries its reason in the end's not_run", async () => {
	const tl = await import(join(HERE, 'page', 'turnwrite.js') + '?tab=nr');
	assert.deepEqual(tl.notRunEnd('Not run: iphone runs an older engine.', { cause: 'abi', to: 'dev9', name: 'iphone', said: '' }),
		{ status: 'not_run', not_run: { why: 'Not run: iphone runs an older engine.', cause: 'abi', to: 'dev9', name: 'iphone' } });
	assert.deepEqual(tl.notRunEnd('handed back', null), { status: 'not_run', not_run: { why: 'handed back' } });
	const src = readFileSync(join(HERE, 'page', 'handoff.js'), 'utf8');
	const body = src.slice(src.indexOf('function endTurnNotRun('), src.indexOf('function handBackNote('));
	assert.match(body, /logEnd\(chat\.id, tid, notRunEnd\(why, cause\)\)/);
});
