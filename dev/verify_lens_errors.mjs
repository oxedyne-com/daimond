// gateway: none
// verify_lens_errors.mjs — what a daimon turn tells the Lens, read off the feed's own outbox.
//
// The Lens is how a fault on the owner's devices is diagnosed after the fact, so a row it
// never got, or got under the wrong turn, is a fault nobody can find. Three properties
// (Q8b/Q8c, D-20261008-02):
//
//   1. A REFUSED call says why. An over-cap `crystal.json` write is refused by the engine;
//      its `tool` row carries the refusal's head in `msg`, and the whole sentence rides in
//      the `ds error <mref>` chunk set the row names. A failing `file_edit` the same.
//   2. THE TURN IS THE TURN. Every daimon-path row is keyed by the turn's own id (the
//      person's message mid, `dumid` -- what a hand-off's lease holds), with the daimon
//      chat's id in `chat`. The chat id used to stand in as `turn`, so every steer a
//      Diamond ever ran was one "turn" in the Lens.
//   3. EVERY ROUND ARRIVES. A 14-round turn sends 14 `round` rows; the feed used to send
//      round 1, every 5th and the last only.
//
//   eval "$(bash dev/world.sh 88 --env)"; node dev/verify_lens_errors.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import { open, connectMock, scratch, steerDiamond } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const MODEL = 'accounts/fireworks/models/glm-5p2';

async function create(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	// The Diamond opens once its store write lands, which can take a while under load.
	for (let t0 = Date.now(); Date.now() - t0 < 15000; await p.waitForTimeout(300)) {
		if (await p.evaluate(() => !!(window.DaimondDiamond && DaimondDiamond.current()))) return;
	}
}

/// The feed's outbox as parsed rows: `{ tag, kind, ev }` for an `ev` row, `{ tag, data }` else.
async function outbox(p) {
	const rows = await p.evaluate(() => window.DEBUG_SHARE._outbox());
	return rows.map((r) => {
		const m = /^ev (\S+)$/.exec(r.tag || '');
		if (!m) return { tag: r.tag, data: r.data };
		let ev = null;
		try { ev = JSON.parse(r.data); } catch (e) { ev = null; }
		return { tag: r.tag, kind: m[1], ev };
	});
}

/// The whole text a `ds error <mref>` chunk set carries, or '' when a chunk is missing.
function errorText(rows, mref) {
	const parts = [];
	let n = 0;
	for (const r of rows) {
		const m = /^ds error (\S+) (\d+)\/(\d+)$/.exec(r.tag || '');
		if (!m || m[1] !== mref) continue;
		parts[Number(m[2]) - 1] = r.data;
		n = Number(m[3]);
	}
	if (!n || parts.filter(x => x != null).length !== n) return '';
	try { return JSON.parse(Buffer.from(parts.join(''), 'base64').toString('utf8')).text || ''; }
	catch (e) { return ''; }
}

/// Steer the Diamond and wait for the turn's `turn.end`; answer the new turn's id.
async function steer(p, text, ms = 60000) {
	const ends = async () => (await outbox(p)).filter(r => r.kind === 'turn.end').length;
	const before = await ends();
	await steerDiamond(s, text);
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await ends() > before) break;
		await p.waitForTimeout(400);
	}
	await p.waitForTimeout(600);
	const rows = await outbox(p);
	const end = rows.filter(r => r.kind === 'turn.end').slice(before)[0];
	return end ? String(end.ev.turn || '') : '';
}

const s = await open({ name: 'lenserrors', profile: scratch('pw', 'lenserrors-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s, { model: MODEL });
	await create(p, 'Lens errors');
	const dia = await p.evaluate(() => (DaimondDiamond.current() || {}).id || '');
	if (!dia) console.log('  ..   dialogs: ' + await p.evaluate(() => [...document.querySelectorAll('.dlg-card')].map(c => c.innerText.slice(0, 200)).join(' | ')));
	check(!!dia, 'a Diamond to steer', dia);
	if (!dia) { await s.close(); process.exit(1); }
	await p.evaluate(() => { window.DEBUG_SHARE.setEnabled(true); });

	// ══ 1 and 2: refusals and failures, under the turn's own id ══════════
	const big = JSON.stringify({ notes: 'x'.repeat(50 * 1024) });
	const calls = [
		['file_write', { path: `diamonds/${dia}/crystal.json`, content: big }],
		['file_write', { path: `diamonds/${dia}/notes.md`, content: 'hello\n' }],
		['file_edit',  { path: `diamonds/${dia}/notes.md`, old_string: 'NOPE', new_string: 'x' }],
	];
	const turn1 = await steer(p, '@seq ' + calls.map(([n, a]) => n + ' ' + JSON.stringify(a)).join(' ;; '));
	let rows = await outbox(p);
	const ids = await p.evaluate((d) => {
		const rec = DaimondDiamond.conversation(d);
		// The person's own message, by its words: a later row of the record may be a user-role one too.
		const said = (rec && rec.messages || []).filter(m => m.role === 'user'
			&& typeof m.content === 'string' && m.content.startsWith('@seq '));
		return { chat: rec ? String(rec.id) : '', mid: said.length ? String(said[said.length - 1].mid) : '',
			tail: (rec && rec.messages || []).slice(-4).map(m => m.role + ':' + (m.mid || '') + ':'
				+ String(typeof m.content === 'string' ? m.content : '').slice(0, 24)).join(' | ') };
	}, dia);
	check(!!turn1, 'the steer ended with a turn.end', turn1);
	check(turn1 === ids.mid && turn1 !== ids.chat,
		'the turn is keyed by the person\'s message, not the daimon chat', `turn ${turn1}, mid ${ids.mid}, chat ${ids.chat}` + (turn1 === ids.mid ? '' : '; tail ' + ids.tail));
	const start = rows.find(r => r.kind === 'turn.start' && r.ev.turn === turn1);
	check(!!start && start.ev.chat === ids.chat, 'turn.start carries the turn and, apart, the chat',
		start ? `turn ${start.ev.turn}, chat ${start.ev.chat}` : 'no turn.start under the turn id');
	const tools = rows.filter(r => r.kind === 'tool' && r.ev.turn === turn1);
	check(tools.length === 3, 'every call of the turn has its tool row under the turn id',
		tools.map(r => r.ev.name + ':' + r.ev.out).join(' ') || 'none');
	const capRow = tools.find(r => r.ev.name === 'file_write' && r.ev.out !== 'done');
	check(!!capRow, 'the over-cap crystal write is not done', tools.map(r => r.ev.out).join(','));
	if (capRow) {
		check(/Refused: The crystal/.test(capRow.ev.msg || ''), 'its row says why, in msg (the refusal\'s head)', capRow.ev.msg);
		const full = capRow.ev.mref ? errorText(rows, capRow.ev.mref) : '';
		check(/may not exceed/.test(full) && /COLD section/.test(full),
			'and the whole refusal rides in the chunk set it names', full.length + ' chars');
		check(capRow.ev.dia === dia && capRow.ev.chat === ids.chat, 'it names the Diamond and the chat',
			`${capRow.ev.dia} / ${capRow.ev.chat}`);
	}
	const editRow = tools.find(r => r.ev.name === 'file_edit');
	check(!!editRow && editRow.ev.out !== 'done' && !!(editRow.ev.msg || '').trim(),
		'a failing file_edit says why', editRow ? editRow.ev.out + ': ' + editRow.ev.msg : 'no row');
	const stray = rows.filter(r => r.ev && r.ev.turn === ids.chat);
	check(stray.length === 0, 'no row of the turn is keyed by the chat id',
		stray.map(r => r.kind).join(',') || 'none');

	// ══ 3: every round of a 14-round turn ══════════════════════════════
	const turn2 = await steer(p, '@rounds 14 file_list {"path":"."}');
	rows = await outbox(p);
	const rounds = rows.filter(r => r.kind === 'round' && r.ev.turn === turn2).map(r => r.ev.r);
	check(!!turn2 && turn2 !== turn1, 'the second steer is a turn of its own', turn2);
	check(rounds.join(',') === '1,2,3,4,5,6,7,8,9,10,11,12,13,14', 'all 14 rounds reach the feed, once each',
		rounds.join(',') || 'none');
} finally {
	await s.close();
}
console.log(failures ? `\nverify_lens_errors: ${failures} FAILED` : '\nverify_lens_errors: all passed');
process.exit(failures ? 1 : 0);
