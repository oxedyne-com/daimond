#!/usr/bin/env node
// verify_turnfiles_chatlist.mjs — the changed-files tile from a daimon chat opened
// via the CHAT LIST (WS-HAND S-HAND #4 / #6-tile, the owner-hit bug), AND the
// render gap #22 found by driving: an ORDINARY turn (edits code, leaves
// REQUIREMENTS.md/STATE.md alone) gets TWO trailing user messages appended --
// the changed-files tail note (diamond_versions.rs tail_note, wasm/app.rs:2877)
// then `note_reconcile`'s RECONCILE_NOTE (compact.rs:2301) -- and the tile drew
// only when the tail note happened to be last, which is the RARE case (every
// never-forget file touched). This turn is built to leave them untouched, so
// RECONCILE_NOTE fires and lands last, which is the shape that used to hide the
// tile entirely.
//
// THE CLICK BUG (already fixed, still proved here). `_tailNoteTable` resolved the
// Diamond id from `currentDiamond`, which is NULL for a daimon chat opened from the
// chat-list row (selectChat sets it null). So `DaimondVersions.manifests('')` was
// empty, every row's hash undefined, and the name-click had no hash to fall back to
// -- the whole tile was DEAD on click. The fix resolves the id from `chat.diamondId`
// (the chat is the authority) and passes `chat` to the tile builder.
//
// THE RENDER BUG (this verifier's main proof). The JS used to assume the tail note
// was `after[after.length - 1]`; with RECONCILE_NOTE appended after it, that read
// the reconcile sentence instead, `_parseTailNote` rejected it, and NOTHING was
// pushed to `rec.messages` -- no tile, ever, for the ordinary case. The fix checks
// the last two messages for the one `_parseTailNote` accepts (daimond.js:~48826).
//
// THE PROOF that survives the pre-fix build: the tile RENDERS a row for a.md, and
// clicking it opens the Doc panel on the live `diamonds/<id>/…` file (editable,
// content present). Revert the fix (or force `after[after.length - 1]`) and the
// tile is absent -- `rows` comes back empty and every assertion after it is red.
//
// SINGLE CONTEXT, and it needs the wasm carrying `versions_body_path` for the store
// viewer door (dev/build-wasm.sh). The world: dev/serve.mjs + dev/mockllm.mjs.
//
//   node dev/verify_turnfiles_chatlist.mjs

import { open, connectMock, steerDiamond, scratch, shot, storedChats } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

async function until(p, fn, arg, ms = 60000, step = 400) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await p.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true; await p.waitForTimeout(step);
	}
	return false;
}

async function makeDiamond(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm; inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1200);
}

// The one chat that carries the engine's tail note, read from the durable store.
async function noteChat(s) {
	const cs = await storedChats(s);
	return (cs || []).find(c => (c.messages || [])
		.some(m => /^\[Daimond: this turn changed /.test(String(m.content || '')))) || null;
}

const s = await open({ name: 'turnfiles', profile: scratch('pw', 'turnfiles-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s);
	await p.waitForFunction(() => !!window.DaimondVersions && !!window.Files, null, { timeout: 20000 }).catch(() => {});

	await makeDiamond(p, 'TurnFiles ' + Date.now().toString(36));
	const diamondId = await p.evaluate(() => {
		var d = window.DaimondDiamond && window.DaimondDiamond.current();
		return d ? d.id : '';
	});
	check('the new Diamond is current, so its id is in hand', !!diamondId);

	// A daimon turn that WRITES a workspace file -- so steer_crystal lands the engine's
	// tail note (`[Daimond: this turn changed 1 file (vN): diamonds/<id>/code/x/a.md ...]`)
	// in the chat. The path MUST carry `diamonds/<id>/`: the daimon's fence is built from
	// `diamond_bounds("diamonds/<id>", ...)` (src/tools.rs), so a bare `code/x/a.md` is
	// outside it and the write is refused before it ever reaches disk -- which used to
	// leave this whole verifier measuring a refusal it never noticed.
	//
	// This ALSO means REQUIREMENTS.md/STATE.md are untouched, so `note_reconcile` fires
	// (compact.rs) and RECONCILE_NOTE lands as the LAST message, one after the tail note
	// -- the exact shape #22's render-gap bug needs to prove (see daimond.js:~48826).
	await steerDiamond(s, '@tools file_write {"path":"diamonds/' + diamondId
		+ '/code/x/a.md","content":"# Alpha\\n\\nthe changed file body, line two.\\n"}');

	const noted = await until(p, async () => {
		try {
			const req = indexedDB.open('daimond-chats');
			return await new Promise((res) => {
				req.onsuccess = () => {
					try {
						const all = req.result.transaction('chats', 'readonly').objectStore('chats').getAll();
						all.onsuccess = () => res((all.result || []).some(c => (c.messages || [])
							.some(m => /this turn changed/.test(String(m.content || '')))));
						all.onerror = () => res(false);
					} catch (e) { res(false); }
				};
				req.onerror = () => res(false);
			});
		} catch (e) { return false; }
	}, null, 80000);
	check('a daimon turn wrote a file and the engine left its tail note', noted);

	const chat = await noteChat(s);
	check('the note lives in a chat carrying a diamondId', !!(chat && chat.id && chat.diamondId),
		JSON.stringify({ id: chat && chat.id, diamondId: chat && chat.diamondId }));
	if (!chat) throw new Error('no tail-note chat found in the store');
	if (process.env.DUMP_ORDER) {
		console.log('--- rec.messages (visible transcript) ---');
		for (const m of chat.messages) console.log(m.role + ': ' + String(m.content || '').slice(0, 90));
		console.log('--- rec.session.msgs (raw, sent back to the model) ---');
		for (const m of ((chat.session && chat.session.msgs) || [])) console.log(m.role + ': ' + String(m.content || '').slice(0, 100));
	}

	// OPEN THE SAME CHAT FROM THE CHAT LIST. A reload restores the last-open chat through
	// the boot's `selectChat(openChat)` -- the same door a chat-list click takes -- which
	// sets `currentDiamond = null`. That is the exact state of the bug.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => !!window.DaimondVersions && !!window.Files, null, { timeout: 20000 }).catch(() => {});
	await p.waitForTimeout(1800);

	// The tile drew (a row per changed file). Rows alone do not prove the fix -- they are
	// parsed from the note text -- but the CLICK below does.
	const rows = await p.evaluate(() => Array.from(document.querySelectorAll('.turn-files-rows .turn-file-name')).map(n => n.textContent));
	check('the changed-files tile drew a row for a.md via the chat-list path',
		rows.some(n => /a\.md$/.test(n)), 'rows=' + JSON.stringify(rows));

	// CLICK a.md -> `openTurnFile` tries the live file first (a `diamonds/…` store path
	// always resolves), so the Doc panel opens on the LIVE file, editable.
	const clicked = await p.evaluate(() => {
		const nm = Array.from(document.querySelectorAll('.turn-files-rows .turn-file-name')).find(n => /a\.md$/.test(n.textContent || ''));
		if (!nm) return false; nm.click(); return true;
	});
	check('the a.md row is clickable', clicked);
	const opened = clicked && await until(p, () => {
		const name = document.getElementById('doc-name');
		const body = document.querySelector('pre.files-view-body');
		return !!(name && body && /a\.md/.test(name.textContent || '') && (body.textContent || '').length > 0);
	}, null, 15000);
	check('clicking a.md opened the Doc panel with the file content (THE FIX: id from chat.diamondId)', !!opened);

	// The shown text CONTAINS DaimondVersions.body(diamondId, hash) -- proving the id
	// resolved. Not strict equality: `pre.files-view-body` now carries a line-number
	// gutter (one prefix per line), so the rendered text is the store body PLUS that
	// gutter, not the store body verbatim.
	const bodyMatch = await p.evaluate(async (did) => {
		try {
			const ms = await window.DaimondVersions.manifests(did);
			const mv = (ms || []).slice().reverse().find(m => (m.files || []).some(f => /a\.md$/.test(f.path)));
			const e = mv && mv.files.find(f => /a\.md$/.test(f.path));
			const hash = e && (e.hash || '');
			const body = hash ? await window.DaimondVersions.body(did, hash) : null;
			const shown = (document.querySelector('pre.files-view-body') || {}).textContent || '';
			const bodyLines = String(body || '').split('\n').filter(Boolean);
			const contains = !!body && bodyLines.length > 0 && bodyLines.every(function (ln) { return shown.indexOf(ln) >= 0; });
			return { hash, ok: contains, shownLen: shown.length, bodyLen: body ? body.length : 0 };
		} catch (e) { return { err: String(e) }; }
	}, chat.diamondId);
	check('the shown text CONTAINS the version-store body for a.md (the id resolved from the chat)',
		bodyMatch && bodyMatch.ok, JSON.stringify(bodyMatch));

	const noFffd = await p.evaluate(() => !/�/.test((document.querySelector('pre.files-view-body') || {}).textContent || ''));
	check('the snapshot text carries no U+FFFD replacement characters', noFffd);

	// The Doc panel opened on the LIVE `diamonds/<id>/...` store path (not a version-store
	// snapshot route), so it is editable -- the Edit control being visible here is correct,
	// not a defect: a live file opens editable, same as any other file under the store.
	const editVisible = await p.evaluate(() => {
		const b = document.querySelector('.files-view-head [data-act="edit"]');
		return !!b && b.style.display !== 'none';
	});
	check('the Doc panel on a live diamonds/… path shows the Edit control', editVisible);

	await shot(s, 'turnfiles_chatlist_' + (bad.length ? 'RED' : 'GREEN'));

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	await s.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
