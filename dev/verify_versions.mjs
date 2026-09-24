// verify_versions.mjs — every change to a diamond's files can be walked back, and the
// small acts a user regrets in a second have five seconds and a button.
//
// Written against dev/VERSIONS_CONTRACT.md BEFORE the code, so lane A (Rust) and lane B
// (client) are measured against the same names they built to. Where a name below is one
// the contract fixes and the code has not yet met, the line carries a `// lane A:` or
// `// lane B:` marker naming the seam; nothing here is a guess dressed as a check.
//
// WHY THESE PROPERTIES AND NOT A CHECKLIST. "Undo" is a promise, and each property below is
// a way that promise could be false while the History panel looks perfectly right:
//
//   1. A TURN THAT CHANGED A FILE LEAVES A MANIFEST NAMING EXACTLY WHAT IT CHANGED, with
//      the body of each, and `was` null for a file that did not exist. A turn that wrote
//      nothing leaves nothing — an empty row is a row that says nothing (D2).
//   2. BODIES ARE STORED ONCE. A, B, A across three turns is three manifests and two bodies.
//      Without content addressing the 1 MiB cap is reached by re-saving one file.
//   3. THE USER'S OWN SAVE IS SNAPSHOTTED BEFORE THE TURN BEGINS, as a `user` manifest in
//      front of the turn's own: "before the daimon touched it" has to be true of a file
//      the user edited a minute earlier, or Restore returns the daimon's version of it.
//   4. SAVE A VERSION WRITES A `save` MANIFEST CARRYING THE NAME, and nothing when nothing
//      changed.
//   5. RESTORE IS BYTE-EXACT, per file and whole; the crystal comes back with the whole;
//      a path that did not exist at N is gone afterwards.
//   6. RESTORE CREATES A VERSION. The row count rises by one and the pre-restore bytes are
//      the newest row's `was`. Restore that destroys is the one thing this must never be.
//   7. PRUNING TAKES THE OLDEST TURNS FIRST AND THE USER'S SAVE LAST, and leaves no
//      manifest naming a body that is gone.
//   8. A BODY MISSING ON THIS DEVICE SAYS SO — in the row, with Restore greyed — and
//      nothing throws. The other device pruned it; this one must not pretend.
//   9. EVERY ACT WITH AN UNDO TOAST DOES BOTH HALVES: the act happened, and Undo within
//      the window puts it back — on the MESSAGES, not the label (verify_trash §2). Past the
//      window, or on tab hide, the destructive tail has run.
//  10. RETRY REPLACES THE LAST REPLY; EDIT & RESEND RUNS NOTHING UNTIL SEND.
//  11. A MARK FILE IS CAPTURED AND RESTORED THROUGH THE FENCE. A folder the fence no longer
//      covers is refused in the fence's own words and the file on disk is untouched.
//  12. THE PARCEL IS A FIXED POINT after a snapshot: two collects, identical.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a deliberately
// damaged copy of a file to the real page through `page.route`, and the run is expected
// to FAIL. Two kinds of damage, and the difference is stated because it matters:
//
//   * `js/versions.js`, `js/undo.js`: an OVERRIDE appended to the served module — the
//     wrong implementation a lane could plausibly have written, replacing the contract's
//     method by name. An anchor is the global's name; a module that does not define it
//     aborts the run rather than passing quietly.
//   * `pkg/oxedyne_daimond.js` (the wasm glue): the store logic is Rust and cannot be
//     patched in a browser, so the fault is injected AT THE STORE after the real turn —
//     the manifest emptied, a second body written, the save's protection stripped. That
//     proves the checks read the disk and would see the fault; the logic itself is proved
//     red natively by `cargo test -p daimond diamond_versions` (contract §12).
//
//   node dev/verify_versions.mjs --break nosnapshot       # 1: the turn recorded nothing
//   node dev/verify_versions.mjs --break nodedupe         # 2: a body per write
//   node dev/verify_versions.mjs --break restorenoversion # 6: restore writes the bytes and no manifest
//   node dev/verify_versions.mjs --break prunesave        # 7: the user's save goes first
//   node dev/verify_versions.mjs --break undolate         # 9: the tail runs before the window
//   node dev/verify_versions.mjs --break revertfence      # 11: restore writes past the fence
//   node dev/verify_versions.mjs                          # and then, clean
//
//   eval "$(bash dev/world.sh 3 --up)"
//   node dev/verify_versions.mjs
//
// Needs a world (dev/serve.mjs + dev/mockllm.mjs). No gateway, no hand: the machine half
// of §11 — the before body read through the hand's own `Read` and the bytes going back to
// disk — lives in dev/verify_handreal.mjs, which already has the whole chain up; the fence
// half is here, against a workspace folder, through the same `run_tool_outcome` door.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, signInAs, steerDiamond, storedChats } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const SRC  = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
let ran = 0;
const check = (name, pass, detail) => {
	ran++;
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const tag = BREAK ? '-' + BREAK : '';

// ── The breaks ───────────────────────────────────────────────────────
const GLUE = 'pkg/oxedyne_daimond.js';

/// Wrap the turn entry so that something runs AFTER the real turn, against the real store.
/// `steer_crystal(id, …)` — the id is the first argument (dev/verify_daimonreach.mjs drives
/// it the same way). `store_list`/`store_read`/`store_write` are the glue's own exports.
const afterTurn = (body) => `
;(function () {
	var orig = DaimondApp.prototype.steer_crystal;
	DaimondApp.prototype.steer_crystal = async function (id) {
		var r = await orig.apply(this, arguments);
		try {
			var dir = 'diamonds/' + id + '/versions';
			var names = (await store_list(dir)).split('\\n').map(function (l) { return l.split('\\t')[0]; })
				.filter(function (n) { return /^\\d+\\.files\\.json$/.test(n); }).sort();
			${body}
		} catch (e) { /* broken on purpose */ }
		return r;
	};
})();
`;

const BREAKS = {
	// The turn recorded nothing: the newest manifest is emptied after the write.
	nosnapshot: { file: GLUE, needs: 'steer_crystal', append: afterTurn(`
			if (!names.length) return r;
			var p = dir + '/' + names[names.length - 1];
			var m = JSON.parse(await store_read(p)); m.files = []; await store_write(p, JSON.stringify(m));`) },
	// A body per write: the store a lane without content addressing would hold.
	nodedupe: { file: GLUE, needs: 'steer_crystal', append: afterTurn(`
			if (!names.length) return r;
			var m = JSON.parse(await store_read(dir + '/' + names[names.length - 1]));
			for (var i = 0; i < (m.files || []).length; i++) {
				var e = m.files[i]; if (!e.hash) continue;
				await store_write(dir + '/b/' + e.hash + '-' + names.length, await store_read(dir + '/b/' + e.hash));
			}`) },
	// The user's save is not protected: its cause is flipped, so the REAL prune takes it as
	// the oldest turn on the next write that crosses the cap.
	prunesave: { file: GLUE, needs: 'steer_crystal', append: afterTurn(`
			for (var i = 0; i < names.length; i++) {
				var p = dir + '/' + names[i];
				var m = JSON.parse(await store_read(p));
				if (m.cause === 'save') { m.cause = 'turn'; await store_write(p, JSON.stringify(m)); }
			}`) },
	// Restore writes the old bytes straight into the file and no `restore` manifest: the
	// destructive restore, which is the one implementation somebody would write first.
	restorenoversion: { file: 'js/versions.js', needs: 'DaimondVersions', append: `
;(function () {
	DaimondVersions.restoreFile = async function (id, path, n) {
		var m = await import('/pkg/oxedyne_daimond.js');
		var app = window.DaimondCore.diamondApp();
		var st = JSON.parse(await app.versions_state(id, n));
		var e = st[path]; if (!e || !e.hash) return null;
		await m.store_write('diamonds/' + id + '/' + path, await app.versions_body(id, e.hash));
		return { version: 0, restored: [path], removed: [], refused: [] };
	};
})();
` },
	// Restore of a path outside the diamond goes through the ENGINE's own door — the one the
	// harness itself recommends for fixtures, because it is not fenced — instead of the
	// fenced tool door. A withdrawn mark then restores anyway.
	revertfence: { file: 'js/versions.js', needs: 'DaimondVersions', append: `
;(function () {
	var orig = DaimondVersions.restoreFile;
	DaimondVersions.restoreFile = async function (id, path, n) {
		if (/^diamonds\\//.test(path) || !/\\//.test(path)) return orig.call(DaimondVersions, id, path, n);
		var m = await import('/pkg/oxedyne_daimond.js');
		var app = window.DaimondCore.diamondApp();
		var st = JSON.parse(await app.versions_state(id, n));
		var e = st[path]; if (!e || !e.hash) return null;
		await m.write_file(path, await app.versions_body(id, e.hash));
		return { version: 0, restored: [path], removed: [], refused: [] };
	};
})();
` },
	// The toast shows and Undo still reverts, but the destructive tail already ran: the
	// tombstones are written and compacted before the user has had a second to look.
	undolate: { file: 'js/undo.js', needs: 'DaimondUndo', append: `
;(function () {
	var able = DaimondUndo.able;
	DaimondUndo.able = function (o) {
		try { if (o && typeof o.commit === 'function') o.commit(); } catch (e) { /* on purpose */ }
		return able.call(DaimondUndo, Object.assign({}, o, { commit: function () {} }));
	};
})();
` },
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged body, or a hard stop: a module that does not define the name the override
/// replaces was never broken, and the run below would prove nothing.
function damaged(spec) {
	const file = path.join(WWW, spec.file);
	if (!fs.existsSync(file)) {
		console.error(`break '${BREAK}': ${spec.file} does not exist, so nothing was broken.`);
		process.exit(2);
	}
	const src = fs.readFileSync(file, 'utf8');
	if (src.indexOf(spec.needs) < 0) {
		console.error(`break '${BREAK}': ${spec.file} does not define '${spec.needs}', `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src + spec.append;
}

async function breakInto(page) {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const body = damaged(spec);
	await page.route('**/' + spec.file, (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
}

// ── Page-side readers: the STORE, not the panel ──────────────────────
/// `store_list` lines of a store directory, as `[{name, dir, size}]`; `[]` when absent.
const listDir = (page, dir) => page.evaluate(async (d) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try {
		return (await m.store_list(d)).split('\n').filter(Boolean).map((l) => {
			const [name, kind, size] = l.split('\t');
			return { name, dir: kind === 'dir', size: Number(size) };
		});
	} catch (e) { return []; }
}, dir);

const readStore = (page, p) => page.evaluate(async (x) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return await m.store_read(x); } catch (e) { return null; }
}, p);

const writeStore = (page, p, body) => page.evaluate(async (a) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.store_write(a.p, a.body);
}, { p, body });

/// A workspace-root write through the engine's UNFENCED door — a fixture, not a turn.
const writeWorkspace = (page, p, body) => page.evaluate(async (a) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file(a.p, a.body);
}, { p, body });
const readWorkspace = (page, p) => page.evaluate(async (x) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return await m.read_file(x); } catch (e) { return null; }
}, p);

/// Every `NNNN.files.json` of a diamond, parsed, oldest first, with `v` the VERSION NUMBER
/// off the name and `schema` the manifest's own `v`.
///
/// The manifest carries a `v` of its own -- the schema version, which is 1 -- and merging it
/// OVER the number taken from the file name made every version look like version 1. Every
/// check that restored, pruned or compared by version was then aimed at a version that does
/// not exist, and said so in a sentence about restores rather than about this line.
async function manifests(page, id) {
	const dir = `diamonds/${id}/versions`;
	const names = (await listDir(page, dir)).map((e) => e.name)
		.filter((n) => /^\d+\.files\.json$/.test(n)).sort();
	const out = [];
	for (const n of names) {
		const text = await readStore(page, dir + '/' + n);
		let m = null;
		try { m = JSON.parse(text); } catch (e) { m = { parse_error: String(text).slice(0, 60) }; }
		out.push(Object.assign({}, m, { v: Number(n.split('.')[0]), schema: m && m.v, name: n }));
	}
	return out;
}
const bodies = async (page, id) => (await listDir(page, `diamonds/${id}/versions/b`)).map((e) => e.name);
const hasBody = async (page, id, hash) => (await bodies(page, id)).includes(hash);
const readBody = (page, id, hash) => readStore(page, `diamonds/${id}/versions/b/${hash}`);
const newest = (ms) => ms[ms.length - 1] || null;
const entry = (m, p) => ((m && m.files) || []).find((e) => e.path === p) || null;

/// The live engine — the History panel's own app — for the contract's exports.
const engine = (page, fn, ...args) => page.evaluate(async (a) => {
	const app = window.DaimondCore.diamondApp();
	try { return { ok: true, out: await app[a.fn](...a.args) }; }
	catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}, { fn, args });

const diamondId = (page, name) => page.evaluate(async (n) => {
	const app = window.DaimondCore.diamondApp();
	const d = JSON.parse(await app.list_diamonds()).find((x) => x.name === n);
	return d ? d.id : '';
}, name);

/// Remove whatever modal an earlier act left standing.
///
/// The acts below are driven by clicking into the cog dialog, and a dialog left open
/// puts a second `.dlg-card` and a second set of `.tile-dlg-*` controls in the DOM —
/// so the next act reads the stale one and says nothing about why it failed.
const closeModals = (page) => page.evaluate(() => {
	document.querySelectorAll('.modal').forEach((m) => m.remove());
	document.body.classList.remove('modal-open');
});

/// A Diamond, made the way a person makes one, waited until the STORE has it.
///
/// The wait used to be a flat 900 ms. The write and the rail redraw are both async and
/// on a cold first load they are not done in 900 ms: the run that found this lost the
/// Diamond, and every check after it failed against an empty id.
const newDiamond = async (page, name) => {
	await closeModals(page);
	// THE MODEL PULLDOWN HAS TO HAVE SOMETHING IN IT FIRST. `createDiamond`'s own
	// `validate` refuses an empty model with `rail.err_model`, so a dialog opened
	// before `DaimondModels` has read the provider config can never be accepted: OK
	// does nothing, the card stays up, and the poll below times out with no id and
	// no reason -- and every act afterwards drives the stale card. Three runs in four
	// lost it that way. Waited for rather than slept past.
	await page.waitForFunction(() => {
		try { const d = window.DaimondModels && DaimondModels.getDefault(); return !!(d && d.model); }
		catch (e) { return false; }
	}, null, { timeout: 20000 }).catch(() => {});
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	const t0 = Date.now();
	while (Date.now() - t0 < 15000) {
		if (await diamondId(page, name)) break;
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(400);
};
const selectDiamond = async (page, name) => {
	await page.evaluate((n) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((e) => (e.getAttribute('aria-label') || '') === n);
		if (box) box.click();
	}, name);
	await page.waitForTimeout(700);
};

/// A steer through the composer, waited to its end. The same path a person's turn takes,
/// which is what puts the dirty-set drain and the turn-end snapshot under test.
async function steer(s, text, timeout = 30000) {
	await steerDiamond(s, text);
	await s.page.waitForTimeout(300);
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await s.page.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await s.page.waitForTimeout(250);
	}
	await s.page.waitForTimeout(600);
}

const railChats = (page) => page.$$eval('#session-list .session-box .tile-when',
	(els) => els.map((e) => (e.textContent || '').trim()));
const railDiamonds = (page) => page.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box')].map((e) => e.getAttribute('aria-label')));
const storedSaid = async (s, name) => {
	const c = (await storedChats(s)).find((x) => x.name === name);
	return c ? (c.messages || []).map((m) => m.content) : null;
};
const pending = (page) => page.evaluate(() => {
	try { return window.DaimondUndo ? DaimondUndo.pending() : 'no module'; } catch (e) { return 'threw: ' + e; }
});
const pressUndo = async (page) => {
	// The BUTTON, as a person has it; the seam only when the element is not drawn.
	const pressed = await page.evaluate(() => {
		const b = document.querySelector('#daimond-undo .daimond-undo-btn');
		if (b && b.getClientRects().length) { b.click(); return 'button'; }
		try { DaimondUndo.undo(); return 'seam'; } catch (e) { return 'none'; }
	});
	await page.waitForTimeout(900);
	return pressed;
};
/// The message of the dialog now on top.
///
/// The LAST visible card, as `answer` below already takes the last visible button. A
/// stale dialog sits in front of the new one in DOM order, so taking the first read
/// the wrong card — and an empty message is indistinguishable from a dialog that did
/// not ask at all.
const dialogMsg = (page) => page.evaluate(() => {
	const card = [...document.querySelectorAll('.modal.dlg .dlg-card')].filter((c) => c.getClientRects().length).pop();
	return card ? (card.querySelector('.dlg-msg') || {}).textContent || '' : null;
});
const answer = (page, cls) => page.evaluate((c) => {
	const btns = [...document.querySelectorAll('.modal.dlg .' + c)].filter((b) => b.getClientRects().length);
	const b = btns[btns.length - 1];
	if (b) b.click();
	return !!b;
}, cls);
/// A DAIMON FOLDING INTO ITS OWN DIAMOND, off `#chat-fold-btn` on its chat face.
///
/// That button is the whole of the self-fold path: it is drawn only on a daimon's chat
/// face (`syncFoldBtn`) and calls `foldChatInto(current, current.diamondId)` with no
/// picker, because the destination is fixed. Polled rather than clicked once: the
/// transcript may be non-resident after a reload, and the button is hidden until the
/// record it reads has been loaded.
const onDaimonChatFace = async (page, name) => {
	await closeModals(page);
	await selectDiamond(page, name);
	await page.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await page.waitForTimeout(600);
};
const selfFoldNow = async (page, name) => {
	await onDaimonChatFace(page, name);
	const t0 = Date.now();
	while (Date.now() - t0 < 8000) {
		const hit = await page.evaluate(() => {
			const b = document.getElementById('chat-fold-btn');
			if (!b || b.style.display === 'none' || b.disabled || !b.getClientRects().length) return false;
			b.click(); return true;
		});
		if (hit) return true;
		await sleep(300);
	}
	return false;
};

const clickTile = (page, name, cls) => page.evaluate((a) => {
	const box = [...document.querySelectorAll('#session-list .session-box')]
		.find((e) => ((e.querySelector('.tile-when') || {}).textContent || '').trim() === a.name);
	const b = box && box.querySelector(a.cls);
	if (b) b.click();
	return !!b;
}, { name, cls });

// The transcripts whose exact words are the oracle for every undo.
const SAID = {
	Ledger: ['what does the ledger owe', 'four pounds and ninepence', 'and to whom'],
	Recipe: ['how long do I proof it', 'ninety minutes, covered'],
	Spare:  ['is this one kept', 'yes, and folded later'],
};
const seedChats = (page, records) => page.evaluate((rows) => new Promise((res) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const t = req.result.transaction('chats', 'readwrite');
		rows.forEach((r) => t.objectStore('chats').put(r));
		t.oncomplete = () => res(true);
		t.onerror    = () => res(false);
	};
	req.onerror = () => res(false);
}), records);
function chatRecords() {
	const base = Date.parse('2026-09-01T00:00:00Z');
	return Object.keys(SAID).map((name, i) => ({
		id: 'vc' + (i + 1), name,
		messages: SAID[name].map((text, j) => ({
			role: j % 2 === 0 ? 'user' : 'assistant', content: text,
			mid: `vm-${i}-${j}`, iturn: `vm-${i}-${j - (j % 2)}`, ts: base + j,
		})),
		model: 'mock/fast', provider: '', diamondId: '', status: 'active',
		promptTokens: 0, completionTokens: 0, updatedAt: base + 1000 * (i + 1),
	}));
}

// ── Section 10 is lifted, not driven ─────────────────────────────────
// The real functions out of www/js/daimond.js, run against stubs, exactly as
// dev/verify_continue_resume.mjs does for `continueTurn`. Before the browser, so it still
// answers when the heavier half cannot.
function grabFn(sig) {
	const start = SRC.indexOf(sig);
	if (start < 0) return '';
	const o = SRC.indexOf('{', start);
	let depth = 0, i = o;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return SRC.slice(start, i);
}
console.log('10. Retry replaces the last reply; Edit & resend runs nothing until Send');
{
	const RT = grabFn('function retryTurn(');			// lane B: contract §9
	const ER = grabFn('function editResend(');		// lane B: contract §9
	check('daimond.js defines retryTurn(chat, iturn, text)', !!RT, RT ? '' : 'not found');
	check('and editResend(chat, iturn, text)', !!ER, ER ? '' : 'not found');
	const names = ['loadMsgTombs', 'msgTombstone', 'touchChat', 'persistChats', 'renderHistory',
		'runTurn', 'ChatStore', 'window', 'DaimondJournal', 'DaimondPeer', 'DaimondLease',
		'selfDeviceId', 'chatInput'];
	const spies = () => {
		const calls = { runTurn: [], msgTombstone: [], compact: [] };
		const stubs = {
			loadMsgTombs: () => ({}), msgTombstone: (m) => calls.msgTombstone.push(m),
			touchChat: () => {}, persistChats: () => {}, renderHistory: () => {},
			runTurn: (chat, text) => calls.runTurn.push({ text }),
			ChatStore: { compact: (id) => calls.compact.push(id) },
			window: { DaimondJournal: true }, DaimondJournal: { clearTurn: () => {} },
			DaimondPeer: null, DaimondLease: null, selfDeviceId: () => 'me',
			chatInput: { value: '', focus() { this.focused = true; } },
		};
		return { stubs, calls };
	};
	const build = (fnSrc, name, stubs) => {
		try { return new Function(...names, fnSrc + '\nreturn ' + name + ';')(...names.map((n) => stubs[n])); }
		catch (e) { return null; }
	};
	const fresh = () => ({
		_generating: false, app: { marker: 1 },
		messages: [
			{ role: 'user',      iturn: 'T0', mid: 'u0', content: 'earlier' },
			{ role: 'assistant', iturn: 'T0', mid: 'a0', content: 'earlier answer' },
			{ role: 'user',      iturn: 'T1', mid: 'u1', content: 'What is the capital of France?' },
			{ role: 'assistant', iturn: 'T1', mid: 'a1', content: 'Lyon.' },
		],
	});
	{
		const { stubs, calls } = spies();
		const retry = RT ? build(RT, 'retryTurn', stubs) : null;
		const chat = fresh();
		if (retry) { try { retry(chat, 'T1', 'What is the capital of France?'); } catch (e) { note('retryTurn threw: ' + e.message); } }
		check('Retry dispatches the SAME prompt again',
			!!retry && calls.runTurn.length === 1 && calls.runTurn[0].text === 'What is the capital of France?',
			JSON.stringify(calls.runTurn));
		check('and the old reply is TOMBSTONED — replaced, not kept beside a second answer (D7)',
			!!retry && calls.msgTombstone.some((m) => m.includes('a1') && m.includes('u1')),
			JSON.stringify(calls.msgTombstone));
		check('and dropped from this tab, leaving the earlier turn untouched',
			!!retry && chat.messages.every((m) => m.iturn !== 'T1') && chat.messages.some((m) => m.mid === 'a0'),
			JSON.stringify(chat.messages.map((m) => m.mid)));
		check('and chat.app is nulled so the session is rebuilt without the retracted turn',
			!!retry && chat.app === null);
	}
	{
		const { stubs, calls } = spies();
		const edit = ER ? build(ER, 'editResend', stubs) : null;
		const chat = fresh();
		if (edit) { try { edit(chat, 'T1', 'What is the capital of France?'); } catch (e) { note('editResend threw: ' + e.message); } }
		check('Edit & resend puts the prompt in the composer and focuses it',
			!!edit && stubs.chatInput.value === 'What is the capital of France?' && stubs.chatInput.focused === true,
			JSON.stringify(stubs.chatInput));
		check('and runs NOTHING and tombstones NOTHING until Send',
			!!edit && calls.runTurn.length === 0 && calls.msgTombstone.length === 0,
			`runTurn ${calls.runTurn.length}, tombstone ${calls.msgTombstone.length}`);
		check('and remembers which turn Send replaces', !!edit && chat._editing === 'T1', String(chat._editing));
	}
	{
		const { stubs, calls } = spies();
		const retry = RT ? build(RT, 'retryTurn', stubs) : null;
		const chat = fresh(); chat._generating = true;
		if (retry) { try { retry(chat, 'T1', 'x'); } catch (e) { /* counted below */ } }
		check('a chat mid-generation is not retried on top of itself', !!retry && calls.runTurn.length === 0);
	}
	// The peer guard, read off the source: the tile is built where `ctile` is and hidden
	// on `peer-held` by the same test `continueTurn` makes.
	const tileSrc = grabFn('function mountTurnActions(');			// lane B: contract §9
	check('the Retry / Edit controls are withheld while a peer holds the lease',
		!!tileSrc && /peer-held/.test(tileSrc) && /ctile-retry/.test(tileSrc) && /ctile-edit/.test(tileSrc),
		tileSrc ? '' : 'no mountTurnActions in daimond.js');
}

// The user doors call `dirty`, read off the source: a drain proved in §3 is only half the
// property if the door it drains never marks.
console.log('\n3a. the user\'s own doors mark the file dirty');
{
	const w = grabFn('function writeOpenFile(');
	check('writeOpenFile calls DaimondVersions.dirty', /DaimondVersions\.dirty\(/.test(w), w ? '' : 'not found');
	// The FILES PANEL's delete, which is the one that keeps a body — not the sync
	// helper that propagates another device's deletion, which is the first of the four
	// `file_delete` calls in the file and has nothing to undo. Anchored on the
	// panel's own folder door, `Wasm.delete_folder`, which only the × handler calls;
	// its file branch is the `file_delete` beside it.
	const site = SRC.indexOf('Wasm.delete_folder(full)');
	const around = site > 0 ? SRC.slice(site - 1500, site + 1500) : '';
	check('the Files-panel delete captures the body and offers Undo',
		/undoAble\(/.test(around) && /DaimondVersions\.dirty\(/.test(around),
		site > 0 ? '' : 'no Files-panel file_delete site');
}

// ── The world ────────────────────────────────────────────────────────
const PROFILE = scratch('pw', 'versions' + tag);
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'versions', profile: PROFILE, defaults: false, route: breakInto });
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp), null, { timeout: 15000 });
	const mods = await page.evaluate(() => ({
		versions: !!window.DaimondVersions, undo: !!window.DaimondUndo,
		exports: ['versions_list', 'versions_state', 'versions_body', 'versions_restore', 'versions_prune',
			'versions_save_user', 'versions_mark_dirty'].filter((n) => typeof DaimondCore.diamondApp()[n] !== 'function'),
	}));
	check('js/versions.js and js/undo.js are loaded', mods.versions && mods.undo, JSON.stringify(mods));	// lane B
	check('the engine exports the seven versions_* calls', mods.exports.length === 0,
		mods.exports.length ? 'missing: ' + mods.exports.join(', ') : '');					// lane A

	await newDiamond(page, 'Ledger Life');
	const id = await diamondId(page, 'Ledger Life');
	// The dialog's own words when it refused, because "no id" on its own names
	// nothing: `rail.err_model` and `rail.err_no_key` are different faults.
	check('a diamond to version', !!id, id || ('refused: ' + JSON.stringify(await page.evaluate(() =>
		[...document.querySelectorAll('.modal.dlg .dlg-err, .modal.dlg .dlg-msg')]
			.filter((e) => e.getClientRects().length).map((e) => e.textContent)))));
	await selectDiamond(page, 'Ledger Life');
	const D = `diamonds/${id}`;
	// THE MANIFEST NAMES THE PATH THE DOOR WROTE, WHOLE. The plan said diamond-relative;
	// `versions_changes` takes the paths "as they were given" and `versionsPath` puts a
	// store path in unrewritten, so one spelling reaches the manifest, the walk and the
	// restore alike. The checks below read the store, so they say what the store says.
	const P = (rel) => `${D}/${rel}`;
	const req0 = await readStore(page, `${D}/REQUIREMENTS.md`);

	// ── 1. Turn snapshot ────────────────────────────────────────────
	console.log('\n1. a turn that changed files leaves a manifest naming exactly those files');
	const before1 = await manifests(page, id);
	await steer(s, `@tools file_write {"path":"${D}/notes/a.md","content":"alpha one"} ;; `
		+ `file_write {"path":"${D}/REQUIREMENTS.md","content":"# Requirements\\n- [ ] T1 write the ledger\\n"}`);
	const after1 = await manifests(page, id);
	const m1 = newest(after1);
	check('ONE manifest was written for the turn', after1.length === before1.length + 1 && !!m1,
		`${before1.length} → ${after1.length}`);
	// `turn` is always "" on this build: the mid is minted inside the chat and the store's
	// hook is handed the ledger, not the message. The field is carried so a later build
	// can fill it; demanding it here would be checking the plan and not the code.
	check('its cause is "turn" and the turn field is carried', !!m1 && m1.cause === 'turn' && typeof m1.turn === 'string',
		m1 ? `${m1.cause} ${JSON.stringify(m1.turn)}` : 'none');
	const paths1 = m1 ? (m1.files || []).map((e) => e.path).sort() : [];
	check('it names EXACTLY the two files the turn wrote, as the door wrote them',
		JSON.stringify(paths1) === JSON.stringify([P('REQUIREMENTS.md'), P('notes/a.md')]), JSON.stringify(paths1));
	const ea = entry(m1, P('notes/a.md')), er = entry(m1, P('REQUIREMENTS.md'));
	// ABSENT rather than null where there was nothing before: `Entry::to_json` leaves the
	// field out, so a new file and a file whose prior bytes could not be read are
	// different rows.
	check('the new file has no was at all, the existing one carries the hash of what it was',
		!!ea && ea.was == null && !!er && er.was === (req0 == null ? undefined : sha(req0)),
		`a.was=${ea && ea.was} req.was=${er && String(er.was).slice(0, 8)} expected=${req0 == null ? 'null' : sha(req0).slice(0, 8)}`);
	check('the after-hash IS sha256 of the content', !!ea && ea.hash === sha('alpha one') && ea.bytes === 9,
		ea ? `${ea.hash.slice(0, 8)} ${ea.bytes}` : 'none');
	check('and the bodies are on disk under b/<hash>',
		!!ea && !!er && await hasBody(page, id, ea.hash) && await hasBody(page, id, er.hash)
			&& (er.was ? await hasBody(page, id, er.was) : true));
	check('and the body reads back as the bytes written', !!ea && (await readBody(page, id, ea.hash)) === 'alpha one');
	// THE LAST-KNOWN STATE IS DERIVED, NOT A SECOND COPY ON DISK. The plan kept it in
	// `versions/index.json`; lane A folds the manifests instead, so there is no second
	// fact for a prune to leave behind. That the fold is right is §2's third manifest,
	// whose `was` is the hash of the write before it.
	const idx = await readStore(page, `${D}/versions/index.json`);
	check('the last-known state is derived from the manifests, not kept beside them', idx === null,
		idx === null ? '' : String(idx).slice(0, 80));
	// ONE ROW, whatever wrote it. A files-only version mints its own record with kind
	// "files"; a version the CRYSTAL minted already has a row, and a second would show the
	// same turn twice -- so what History owes here is a row at that version, not a kind.
	const log1 = JSON.parse((await engine(page, 'log_read', id)).out || '[]');
	check('History has a row for it: one log record at that version',
		log1.filter((r) => r.crystal_version === m1.v).length === 1, JSON.stringify(log1.map((r) => [r.kind, r.crystal_version])));

	await steer(s, '@text nothing to write here');
	const after1b = await manifests(page, id);
	check('A TURN THAT WROTE NOTHING LEAVES NO MANIFEST (D2)', after1b.length === after1.length,
		`${after1.length} → ${after1b.length}`);
	const V1 = m1 ? m1.v : 0;

	// ── 2. Dedupe ───────────────────────────────────────────────────
	console.log('\n2. bodies are stored once');
	const b0 = (await bodies(page, id)).length;
	const n0 = (await manifests(page, id)).length;
	for (const c of ['delta A', 'delta B', 'delta A']) {
		await steer(s, `@tool file_write {"path":"${D}/notes/d.md","content":"${c}"}`);
	}
	const b1 = (await bodies(page, id)).length;
	const n1 = (await manifests(page, id)).length;
	check('A, B, A across three turns is THREE manifests', n1 === n0 + 3, `${n0} → ${n1}`);
	check('and TWO bodies — the third write of a content already held writes nothing', b1 === b0 + 2, `${b0} → ${b1}`);
	const mA = newest(await manifests(page, id));
	check('the third manifest still names the file, with was = B and hash = A',
		!!entry(mA, P('notes/d.md')) && entry(mA, P('notes/d.md')).hash === sha('delta A')
			&& entry(mA, P('notes/d.md')).was === sha('delta B'),
		JSON.stringify(entry(mA, P('notes/d.md'))));

	// ── 3. User snapshot ────────────────────────────────────────────
	console.log('\n3. the user\'s own edit is snapshotted before the turn begins');
	await writeStore(page, `${D}/notes/u.md`, 'typed by hand');
	await page.evaluate((a) => window.DaimondVersions.dirty(a.id, a.p), { id, p: `${D}/notes/u.md` });	// the door's call, contract §2
	const n3 = (await manifests(page, id)).length;
	await steer(s, `@tool file_write {"path":"${D}/notes/u.md","content":"then the daimon"}`);
	const ms3 = await manifests(page, id);
	const userM = ms3[ms3.length - 2], turnM = ms3[ms3.length - 1];
	check('TWO manifests: the user\'s, then the turn\'s', ms3.length === n3 + 2, `${n3} → ${ms3.length}`);
	check('the first is cause "user" naming the hand-edited path', !!userM && userM.cause === 'user' && !!entry(userM, P('notes/u.md')),
		userM ? `${userM.cause} ${JSON.stringify((userM.files || []).map((e) => e.path))}` : 'none');
	check('with the user\'s bytes as its body — what "before the turn" means',
		!!userM && !!entry(userM, P('notes/u.md')) && entry(userM, P('notes/u.md')).hash === sha('typed by hand')
			&& (await readBody(page, id, sha('typed by hand'))) === 'typed by hand');
	check('and the turn\'s manifest carries was = the user\'s hash',
		!!turnM && turnM.cause === 'turn' && !!entry(turnM, P('notes/u.md')) && entry(turnM, P('notes/u.md')).was === sha('typed by hand'),
		JSON.stringify(entry(turnM, P('notes/u.md'))));

	// ── 4. Explicit save ────────────────────────────────────────────
	console.log('\n4. Save a version');
	await writeStore(page, `${D}/notes/s.md`, 'kept on purpose');
	const saved = await page.evaluate((a) => window.DaimondVersions.save(a.id, a.name), { id, name: 'before lunch' });
	const mS = newest(await manifests(page, id));
	check('Save a version writes a "save" manifest carrying the name',
		!!mS && mS.cause === 'save' && mS.note === 'before lunch' && !!entry(mS, P('notes/s.md')),
		mS ? `${mS.cause} ${JSON.stringify(mS.note)}` : 'none');
	check('and answers the version it made', !!saved && saved.version === mS.v, JSON.stringify(saved));
	const nS = (await manifests(page, id)).length;
	const saved2 = await page.evaluate((a) => window.DaimondVersions.save(a.id, a.name), { id, name: 'again' });
	check('saving with nothing changed writes nothing and says so', saved2 === null && (await manifests(page, id)).length === nS,
		JSON.stringify(saved2));
	const VS = mS ? mS.v : 0;

	// ── 5. Restore per file, and whole ──────────────────────────────
	console.log('\n5. restore is byte-exact');
	await steer(s, `@tool file_write {"path":"${D}/notes/a.md","content":"alpha changed since"}`);
	check('the file has moved on since v' + V1, (await readStore(page, `${D}/notes/a.md`)) === 'alpha changed since');
	const rf = await page.evaluate((a) => window.DaimondVersions.restoreFile(a.id, a.p, a.n), { id, p: `${D}/notes/a.md`, n: V1 });
	check('Restore file brings back the bytes as at v' + V1 + ', byte for byte',
		(await readStore(page, `${D}/notes/a.md`)) === 'alpha one', JSON.stringify(await readStore(page, `${D}/notes/a.md`)));
	check('and answers what it restored', !!rf && Array.isArray(rf.restored) && rf.restored.includes(P('notes/a.md')), JSON.stringify(rf));

	// A file that did not exist at V1, and a crystal edit since, so the whole restore has
	// something to remove and something to bring back beside the files.
	await steer(s, `@tool file_write {"path":"${D}/notes/late.md","content":"born after v1"}`);
	const crystalNow = '{"title":"Ledger Life","summary":"edited after v1","sections":[]}';
	await engine(page, 'write_crystal_data', id, crystalNow);
	const crystalAtV1 = (await engine(page, 'read_version', id, V1)).out;
	// THE WHOLE VERSION IS THE EMPTY PATH, not a glob: `versions_restore` reads one path
	// or, given nothing, everything — and `*` is a path it has no record of.
	const whole = await engine(page, 'versions_restore', id, V1, '');
	check('whole-version restore answers', whole.ok, whole.err || '');
	check('the file that did not exist at v' + V1 + ' is GONE afterwards', (await readStore(page, `${D}/notes/late.md`)) === null);
	check('and the file that did is back to its v' + V1 + ' bytes', (await readStore(page, `${D}/notes/a.md`)) === 'alpha one');
	// THE ENGINE RESTORES FILES AND TOUCHES NO CRYSTAL, deliberately — it has no business
	// minting a crystal version. `restoreWholeVersion` in the panel writes the crystal
	// and the page back in ONE version afterwards, which is why "Restore v12" leaves one
	// row and not two. What is checked here is the seam that makes that possible: the
	// crystal as it stood is still readable for the panel to write.
	check('the engine leaves the crystal to the panel, which can still read what it was',
		(await readStore(page, `${D}/crystal.json`)) === crystalNow && whole.ok && crystalAtV1 !== crystalNow,
		JSON.stringify(String(crystalAtV1 === undefined ? 'read_version threw' : crystalAtV1).slice(0, 60)));

	// ── 6. Restore creates a version ────────────────────────────────
	console.log('\n6. restore is never destructive');
	await steer(s, `@tool file_write {"path":"${D}/notes/a.md","content":"alpha moved again"}`);
	const preHash = sha('alpha moved again');
	// What the turn above actually left on disk. A restore that finds the file already at
	// the version asked for records nothing, and every check below then passes or fails
	// for a reason that has nothing to do with restores.
	const preState = await readStore(page, `${D}/notes/a.md`);
	const rowsBefore = (await manifests(page, id)).length;
	await page.evaluate((a) => window.DaimondVersions.restoreFile(a.id, a.p, a.n), { id, p: `${D}/notes/a.md`, n: V1 });
	const ms6 = await manifests(page, id);
	const m6 = newest(ms6);
	check('THE ROW COUNT RISES BY ONE', ms6.length === rowsBefore + 1,
		`${rowsBefore} → ${ms6.length}; on disk before the restore: ${JSON.stringify(preState)}`);
	check('the newest row is cause "restore"', !!m6 && m6.cause === 'restore', m6 ? m6.cause : 'none');
	check('and its was IS the pre-restore hash, with the body kept — so the restore can itself be restored',
		!!m6 && !!entry(m6, P('notes/a.md')) && entry(m6, P('notes/a.md')).was === preHash && await hasBody(page, id, preHash),
		m6 ? JSON.stringify(entry(m6, P('notes/a.md'))) : 'none');
	check('and the file is at v' + V1 + ' again', (await readStore(page, `${D}/notes/a.md`)) === 'alpha one');

	// ── 12. Fixed point (here, while the store is rich) ─────────────
	console.log('\n12. the parcel is a fixed point after a snapshot');
	const fixed = await page.evaluate(async () => {
		const x = JSON.stringify((await DaimondCore.collectSync()).diamonds);
		await new Promise((r) => setTimeout(r, 1500));
		const y = JSON.stringify((await DaimondCore.collectSync()).diamonds);
		return { same: x === y, len: x.length };
	});
	check('two collects after a snapshot are the same bytes in the diamonds section', fixed.same, `${fixed.len} bytes`);

	// ── 7. Cap pruning ──────────────────────────────────────────────
	console.log('\n7. pruning takes the oldest turns first and the save last');
	// ON THE APP, NOT ON THE MODULE. The plan put the setter beside the module's own
	// functions; lane A hung it on `DaimondApp` with the other ceilings, which is the
	// object the settings panel already holds.
	const capSet = await page.evaluate(async () => {
		const app = window.DaimondCore.diamondApp();
		if (typeof app.set_versions_cap !== 'function') return 'no set_versions_cap';		// lane A: contract §4
		app.set_versions_cap(64 * 1024);
		return 'set';
	});
	check('the test setter exists', capSet === 'set', capSet);
	const firstTurnV = V1;
	for (let i = 0; i < 30; i++) {
		const filler = ('p' + i + ' ').repeat(1024).slice(0, 4096 - 8) + String(i).padStart(8, '0');
		await steer(s, `@tool file_write {"path":"${D}/notes/p.md","content":"${filler}"}`, 20000);
	}
	const ms7 = await manifests(page, id);
	const bs7 = await bodies(page, id);
	check('the oldest turn manifests are gone', !ms7.some((m) => m.v === firstTurnV),
		`still holding v${firstTurnV}: ${ms7.some((m) => m.v === firstTurnV)}; ${ms7.length} manifests`);
	check('THE USER\'S SAVE IS STILL THERE', ms7.some((m) => m.v === VS && m.cause === 'save'),
		`v${VS}: ${JSON.stringify((ms7.find((m) => m.v === VS) || {}).cause)}`);
	let dangling = [];
	for (const m of ms7) {
		for (const e of (m.files || [])) {
			if (e.hash && !e.skipped && !bs7.includes(e.hash)) dangling.push(`v${m.v}:${e.path}`);
			if (e.was && !bs7.includes(e.was)) dangling.push(`v${m.v}:${e.path}(was)`);
		}
	}
	check('and no remaining manifest names a body that is gone', dangling.length === 0, dangling.slice(0, 4).join(' '));
	const total7 = bs7.length && (await listDir(page, `${D}/versions/b`)).reduce((a, e) => a + e.size, 0);
	check('the bodies are under the cap', total7 <= 64 * 1024, `${total7} bytes`);
	// `versions_list` is the ROWS; the gauge is `versions_state`, which is what the
	// History bar draws its bar from.
	const gauge = (await engine(page, 'versions_state', id));
	let gaugeObj = null; try { gaugeObj = JSON.parse(gauge.out); } catch (e) { gaugeObj = null; }
	check('versions_state reports the bytes and the cap the gauge draws', !!gaugeObj && gaugeObj.cap === 64 * 1024 && gaugeObj.bytes === total7,
		gauge.ok ? String(gauge.out).slice(0, 80) : gauge.err);

	// ── 8. Not on this device ───────────────────────────────────────
	console.log('\n8. a body missing here says so');
	const mLast = newest(await manifests(page, id));
	const ghost = 'f'.repeat(64);
	if (mLast) {
		const copy = JSON.parse(JSON.stringify(mLast)); delete copy.v; delete copy.name;
		copy.files = copy.files.map((e) => (e.path === P('notes/p.md') ? Object.assign({}, e, { hash: ghost }) : e));
		await writeStore(page, `${D}/versions/${mLast.name}`, JSON.stringify(copy));
	}
	// AN EMPTY ANSWER, NOT A THROW. The plan had it reject with `missing:<hash>`; lane A
	// answers the empty string, because a body another device pruned is a row the panel
	// draws and not an error it has to catch. `DaimondVersions.body` turns it into null.
	const missing = await engine(page, 'versions_body', id, ghost);
	check('versions_body answers empty for a body this device has not got', missing.ok && missing.out === '',
		missing.ok ? JSON.stringify(missing.out) : missing.err);
	await page.evaluate(() => {
		const b = [...document.querySelectorAll('.crystal-act')].find((x) => /History/.test(x.textContent));
		if (b) b.click();
	});
	await page.waitForTimeout(1200);
	await page.evaluate(() => { const c = document.querySelector('.hist-row .hist-files-n'); if (c) c.click(); });
	await page.waitForTimeout(400);
	const row = await page.evaluate((a) => {
		const r = [...document.querySelectorAll('.hist-file')].find((x) => x.dataset.path === a.p);
		if (!r) return null;
		const b = r.querySelector('.hist-file-restore');
		return { disabled: !!(b && b.disabled), why: (r.querySelector('.hist-file-why') || {}).textContent || '' };
	}, { p: P('notes/p.md') });
	check('the row says "Not on this device" and Restore is greyed', !!row && row.disabled && /Not on this device/.test(row.why), JSON.stringify(row));
	await shot(s, 'versions-history' + tag);
	await page.evaluate(() => { const b = document.querySelector('.crystal-bar .crystal-act'); if (b) b.click(); });

	// ── 11. A mark file, through the fence ──────────────────────────
	console.log('\n11. a marked folder is captured and restored through the fence, and refused past it');
	await writeWorkspace(page, 'live/site.txt', 'v1 on the site');
	await page.evaluate(() => DaimondPanels.show('work'));
	await page.waitForTimeout(700);
	await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await page.waitForTimeout(1000);
	const clip = async () => {
		for (const r of await page.$$('#panel-work .files-row')) {
			const nm = await r.$eval('.files-name', (e) => e.textContent).catch(() => '');
			if (nm.replace(/^[^A-Za-z0-9._-]+/, '').trim() === 'live') {
				const c = await r.$('.attach-btn');
				if (c) { await c.click({ force: true }); return true; }
			}
		}
		return false;
	};
	check('the folder could be marked into the diamond through the paperclip', await clip());
	await page.waitForTimeout(1000);
	await selectDiamond(page, 'Ledger Life');
	await steer(s, '@tool file_write {"path":"live/site.txt","content":"v2 by the daimon"}');
	const m11 = newest(await manifests(page, id));
	const e11 = entry(m11, 'live/site.txt');
	check('the manifest names the file by the path the tool used, with was = the bytes before',
		!!e11 && e11.was === sha('v1 on the site') && e11.hash === sha('v2 by the daimon'), JSON.stringify(e11));
	check('and the before body is kept', !!e11 && (await readBody(page, id, e11.was)) === 'v1 on the site');
	const r11 = await page.evaluate((a) => window.DaimondVersions.restoreFile(a.id, a.p, a.n), { id, p: 'live/site.txt', n: m11 ? m11.v - 1 : 0 });
	check('Restore file writes the old bytes back through the fenced door', (await readWorkspace(page, 'live/site.txt')) === 'v1 on the site',
		JSON.stringify(r11));
	// Withdraw the mark, the way it was made.
	await page.evaluate(() => DaimondPanels.show('work'));
	await page.waitForTimeout(600);
	check('and the mark can be withdrawn the same way', await clip());
	await page.waitForTimeout(1000);
	await selectDiamond(page, 'Ledger Life');
	await writeWorkspace(page, 'live/site.txt', 'v3 after the mark went');
	const mNow = newest(await manifests(page, id));
	const r11b = await page.evaluate((a) => window.DaimondVersions.restoreFile(a.id, a.p, a.n), { id, p: 'live/site.txt', n: m11 ? m11.v : 0 });
	check('A FOLDER THE FENCE NO LONGER COVERS IS REFUSED, in the fence\'s own words',
		!!r11b && Array.isArray(r11b.refused) && r11b.refused.some((x) => x.path === 'live/site.txt' && /not this diamond|outside|reach/i.test(x.why)),
		JSON.stringify(r11b));
	check('and the file on disk is untouched', (await readWorkspace(page, 'live/site.txt')) === 'v3 after the mark went',
		JSON.stringify(await readWorkspace(page, 'live/site.txt')));
	check('and no restore manifest was written for a refusal', newest(await manifests(page, id)).v === (mNow ? mNow.v : -1));

	// ── 9. The undo toast ───────────────────────────────────────────
	console.log('\n9. every act with an undo toast does both halves');
	await seedChats(page, chatRecords());
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'versions');
	await page.waitForTimeout(1500);
	check('the chats are on the rail', (await railChats(page)).length === 3, (await railChats(page)).join(', '));

	// delete chat
	await clickTile(page, 'Ledger', '.tile-x');
	await page.waitForTimeout(600);
	let p9 = await pending(page);
	check('deleting a chat shows ONE undo toast naming it', !!p9 && typeof p9 === 'object' && /Ledger/.test(p9.text), JSON.stringify(p9));
	check('and the chat is off the rail', !(await railChats(page)).includes('Ledger'));
	check('and the toast has a button a person can press', await page.evaluate(() => !!document.querySelector('#daimond-undo .daimond-undo-btn')));
	await pressUndo(page);
	check('Undo puts it back on the rail', (await railChats(page)).includes('Ledger'), (await railChats(page)).join(', '));
	check('WITH ITS TRANSCRIPT, word for word', JSON.stringify(await storedSaid(s, 'Ledger')) === JSON.stringify(SAID.Ledger),
		JSON.stringify(await storedSaid(s, 'Ledger')));
	check('and no toast is pending', (await pending(page)) === null);
	// past the window
	await clickTile(page, 'Ledger', '.tile-x');
	await page.waitForTimeout(5600);
	check('after 5 s the toast is gone and the deletion stands, in the trash',
		(await pending(page)) === null && !(await railChats(page)).includes('Ledger')
			&& (await page.evaluate(async () => (await DaimondCore.trashList()).map((x) => x.name))).includes('Ledger'));

	// one at a time
	await clickTile(page, 'Recipe', '.tile-x');
	await page.waitForTimeout(300);
	await clickTile(page, 'Spare', '.tile-x');
	await page.waitForTimeout(500);
	p9 = await pending(page);
	check('a second act commits the first at once: one toast, the newer act', !!p9 && /Spare/.test(p9.text) && !/Recipe/.test(p9.text), JSON.stringify(p9));
	await pressUndo(page);
	check('and Undo restores only the newer one', (await railChats(page)).includes('Spare') && !(await railChats(page)).includes('Recipe'),
		(await railChats(page)).join(', '));
	await page.evaluate(async () => { const l = await DaimondCore.trashList(); for (const x of l) await DaimondCore.trashRestore(x.id); });
	await page.waitForTimeout(1200);

	// commit on tab hide
	await clickTile(page, 'Recipe', '.tile-x');
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); } catch (e) { /* engine */ }
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await page.waitForTimeout(400);
	check('hiding the tab commits the pending act', (await pending(page)) === null && !(await railChats(page)).includes('Recipe'));
	await page.evaluate(() => { try { delete document.visibilityState; } catch (e) { /* engine */ } });
	await page.evaluate(async () => { const l = await DaimondCore.trashList(); for (const x of l) await DaimondCore.trashRestore(x.id); });
	await page.waitForTimeout(1200);
	await clickTile(page, 'Recipe', '.tile-x');
	await page.waitForTimeout(400);
	await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
	await page.waitForTimeout(400);
	check('and so does pagehide', (await pending(page)) === null && !(await railChats(page)).includes('Recipe'));
	await page.evaluate(async () => { const l = await DaimondCore.trashList(); for (const x of l) await DaimondCore.trashRestore(x.id); });
	await page.waitForTimeout(1200);

	// rename chat
	await clickTile(page, 'Ledger', '.tile-cog');
	await page.waitForTimeout(700);
	await page.evaluate(() => {
		const i = [...document.querySelectorAll('.tile-dlg-name-input')].filter((x) => x.getClientRects().length).pop();
		if (i) { i.value = 'Accounts'; i.dispatchEvent(new Event('change', { bubbles: true })); }
	});
	await page.waitForTimeout(600);
	await page.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => m.remove()); document.body.classList.remove('modal-open'); });
	p9 = await pending(page);
	check('renaming shows an undo toast and the new name is on the rail', !!p9 && /Renamed/.test(p9.text) && (await railChats(page)).includes('Accounts'), JSON.stringify(p9));
	await pressUndo(page);
	check('Undo puts the old name back', (await railChats(page)).includes('Ledger') && !(await railChats(page)).includes('Accounts'),
		(await railChats(page)).join(', '));

	// rename diamond
	await page.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')].find((e) => e.getAttribute('aria-label') === 'Ledger Life');
		const cog = box && box.querySelector('.tile-cog'); if (cog) cog.click();
	});
	await page.waitForTimeout(700);
	await page.evaluate(() => {
		const i = [...document.querySelectorAll('.tile-dlg-name-input')].filter((x) => x.getClientRects().length).pop();
		if (i) { i.value = 'Ledger Death'; i.dispatchEvent(new Event('change', { bubbles: true })); }
	});
	await page.waitForTimeout(1200);
	await page.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => m.remove()); document.body.classList.remove('modal-open'); });
	p9 = await pending(page);
	check('renaming a diamond shows the toast and the store has the new name',
		!!p9 && /Renamed/.test(p9.text) && !!(await diamondId(page, 'Ledger Death')), JSON.stringify(p9));
	await pressUndo(page);
	await page.waitForTimeout(800);
	check('Undo renames it back in the STORE, not only on the rail', !!(await diamondId(page, 'Ledger Life')) && !(await diamondId(page, 'Ledger Death')));

	// delete diamond
	await newDiamond(page, 'Doomed');
	await closeModals(page);
	const doomedId = await diamondId(page, 'Doomed');
	await page.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')].find((e) => e.getAttribute('aria-label') === 'Doomed');
		const cog = box && box.querySelector('.tile-cog'); if (cog) cog.click();
	});
	await page.waitForTimeout(700);
	await page.evaluate(() => { const d = [...document.querySelectorAll('.tile-dlg-delete')].filter((b) => b.getClientRects().length).pop(); if (d) d.click(); });
	await page.waitForTimeout(1200);
	p9 = await pending(page);
	check('deleting a diamond shows the toast and takes it off the rail', !!p9 && /Doomed/.test(p9.text) && !(await railDiamonds(page)).includes('Doomed'), JSON.stringify(p9));
	await pressUndo(page);
	await page.waitForTimeout(800);
	check('Undo puts the diamond back, same id', (await railDiamonds(page)).includes('Doomed') && (await diamondId(page, 'Doomed')) === doomedId);
	await closeModals(page);

	// fold
	//
	// A DAIMON SELF-FOLD, AND NOT AN ORDINARY CHAT'S FOLD. Only a daimon folding into
	// its OWN diamond clears the conversation -- `selfFold` in `foldChatInto`, the
	// owner's decision of 2026-09-04 (32ae49ed): the fold absorbs the whole transcript
	// into the crystal and the chat begins again empty, which is what replaced "Fresh
	// daimon". An ordinary chat keeps its thread, so its fold commits nothing and has
	// nothing to put back, and the three checks below asked it to clear one anyway --
	// measuring the plan against the code and calling the code wrong.
	//
	// The daimon's own record is the one `steerDiamond` has been talking to since §1,
	// so its transcript is real rather than seeded, and the oracle is what it holds at
	// this moment rather than a constant.
	const daimonChat = (await storedChats(s)).find((c) => c.diamondId === id) || { messages: [] };
	const foldMids = (daimonChat.messages || []).map((m) => m.mid);
	const daimonSaid = await storedSaid(s, daimonChat.name);
	// What the RAIL holds, beside what the store holds: the fold reads the live chat
	// object, and "this chat is empty" is a sentence about that object and not about
	// the transcript on disk.
	note('into the fold: ' + JSON.stringify(await page.evaluate((cid) => {
		try {
			const stored = DaimondCore.chatStore().stored()
				.filter((c) => c && c.id === cid).map((c) => (c.messages || []).length);
			return { stored, diamonds: [...document.querySelectorAll('#diamond-list .diamond-box')].map((e) => e.getAttribute('aria-label')) };
		} catch (e) { return 'threw: ' + e.message; }
	}, daimonChat.id)) + ' said: ' + (daimonSaid || []).length);
	// The thread as the user has it, counted before the fold empties it. The MESSAGE
	// tiles only: `#chat-output` also holds the wire band -- role prompt, safety
	// clause, tool schemas -- as seven collapsed `.ctile`s that belong to the Diamond
	// and not to the conversation, and they stand whether or not a word was ever said.
	const tiles = (pg) => pg.evaluate(() =>
		document.querySelectorAll('#chat-output .ctile.chat-msg-user, #chat-output .ctile.chat-msg-assistant').length);
	// Counted on the face BEFORE the button is pressed: the fold is a reducer round and
	// takes seconds, so reading it afterwards happens to work and is still a race.
	await onDaimonChatFace(page, 'Ledger Life');
	const tilesBefore = await tiles(page);
	await selfFoldNow(page, 'Ledger Life');
	const t0 = Date.now();
	while (Date.now() - t0 < 25000) {
		const p = await pending(page);
		if (p && typeof p === 'object' && /Folded/.test(p.text)) break;
		await sleep(300);
	}
	p9 = await pending(page);
	// A fold that never starts and a fold that fails look the same from `pending`, so the
	// dialog the app put up instead is part of the answer.
	// CLEARED IS THE RECORD AND THE SCREEN, NOT YET THE BYTES. `clearDaimonSession`
	// empties `rec.messages` and persists; the mids are tombstoned and the chunks
	// compacted only once the window closes (`commitDaimonClear`), so the store row
	// still physically holds the words at this moment -- which is what makes the undo
	// two checks below possible at all. So the oracle here is the thread the user is
	// looking at, and the bytes are the tombstone check's. `tilesBefore` is asserted
	// too: a face that was already empty would let an unread 0 pass for a clearing.
	const tilesAfter = await tiles(page);
	check('folding shows "Folded into …" and the transcript is cleared',
		!!p9 && /Folded into/.test(p9.text) && tilesBefore > 0 && tilesAfter === 0,
		JSON.stringify(p9) + ` — turns on screen ${tilesBefore} → ${tilesAfter}`
			+ (p9 ? '' : ' — dialog: ' + JSON.stringify(await dialogMsg(page))));
	const tombsNow = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-msgs-deleted') || '{}'); } catch (e) { return {}; } });
	check('AND NOTHING IS TOMBSTONED YET — the destructive tail waits for the window',
		!foldMids.some((m) => tombsNow[m]), `tombstoned: ${foldMids.filter((m) => tombsNow[m]).join(',') || 'none'}`);
	const vBeforeUndo = (await engine(page, 'log_read', id)).out;
	await pressUndo(page);
	await page.waitForTimeout(1500);
	check('Undo brings the transcript back, word for word', JSON.stringify(await storedSaid(s, daimonChat.name)) === JSON.stringify(daimonSaid),
		`${(await storedSaid(s, daimonChat.name) || []).length} of ${(daimonSaid || []).length} back`);
	check('and the crystal is a NEW version equal to the parent — never a delete',
		JSON.parse((await engine(page, 'log_read', id)).out || '[]').length > JSON.parse(vBeforeUndo || '[]').length);
	// and past the window
	await selfFoldNow(page, 'Ledger Life');
	const t1 = Date.now();
	while (Date.now() - t1 < 25000) { const p = await pending(page); if (p && typeof p === 'object') break; await sleep(300); }
	await page.waitForTimeout(5600);
	const tombsLate = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('daimond-msgs-deleted') || '{}'); } catch (e) { return {}; } });
	check('after 5 s the fold is committed: the messages are tombstoned', foldMids.every((m) => !!tombsLate[m]) && (await pending(page)) === null,
		`tombstoned: ${foldMids.filter((m) => tombsLate[m]).length}/${foldMids.length}`);

	// delete all
	await closeModals(page);
	await page.evaluate(() => { const b = document.getElementById('chats-menu-btn'); if (b) b.click(); });
	await page.waitForTimeout(500);
	await page.evaluate(() => { const i = [...document.querySelectorAll('.railhead-menu-item')].find((b) => /Delete all/.test(b.textContent)); if (i) i.click(); });
	await page.waitForTimeout(600);
	const ask = await dialogMsg(page);
	check('Delete all chats still asks first (B18)', !!ask && /\d/.test(ask), JSON.stringify(ask));
	await answer(page, 'dlg-ok');
	await page.waitForTimeout(900);
	p9 = await pending(page);
	check('then one toast naming the count, and the rail is empty', !!p9 && /\d/.test(p9.text) && (await railChats(page)).length === 0, JSON.stringify(p9));
	await pressUndo(page);
	await page.waitForTimeout(800);
	// ALL THREE, and the number is read off the act rather than assumed: the checks
	// above empty the trash back onto the rail after each one, so every seeded chat is
	// standing when Delete all is pressed -- the dialog and the toast both said three.
	// The count was 2 here, which no run has ever produced.
	const backSaid = { Ledger: await storedSaid(s, 'Ledger'), Recipe: await storedSaid(s, 'Recipe'), Spare: await storedSaid(s, 'Spare') };
	check('Undo brings every chat back, transcripts intact',
		(await railChats(page)).length === 3 && Object.keys(SAID).every((n) => JSON.stringify(backSaid[n]) === JSON.stringify(SAID[n])),
		(await railChats(page)).join(', ') + ' — '
			+ (Object.keys(SAID).filter((n) => JSON.stringify(backSaid[n]) !== JSON.stringify(SAID[n])).join(', ')
				|| 'every transcript word for word'));
	await shot(s, 'versions-undo' + tag);

	// The toast is styled to be pressed and to be read.
	const toastA11y = await page.evaluate(() => {
		const el = document.getElementById('daimond-undo');
		if (!el) return null;
		const cs = getComputedStyle(el);
		return { role: el.getAttribute('role'), pe: cs.pointerEvents };
	});
	check('the toast element is role=status with pointer-events auto', !!toastA11y && toastA11y.role === 'status' && toastA11y.pe === 'auto', JSON.stringify(toastA11y));

	const errs = errors(s).filter((e) => !/favicon/i.test(e) && !/Failed to load resource/.test(e) && !/502 \(Bad Gateway\)/.test(e));
	check('nothing was done by way of an unhandled error', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
} finally {
	await s.close();
}

// ── The count is pinned ──────────────────────────────────────────────
// Every check above runs whatever an earlier one said, so the number is a constant of
// this file and a displaced case trips it (memory: assert the count rose).
const EXPECTED = 92;
check(`exactly ${EXPECTED} checks ran — a displaced case trips this`, ran === EXPECTED, `ran ${ran}`);

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
