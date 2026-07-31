// verify_sync.mjs — a user's work travels between devices through the gateway's
// encrypted mailbox, and two devices editing at once converge rather than clobber.
//
// This drives the real client engine (sync.js) against the REAL gateway (/api/sync),
// so it needs the dev stack up: the app on :8777 and the gateway on :9002.
//
//   1. Sign in, make a chat, push. The mailbox holds a version >= 1, and its blob
//      is ciphertext — the plaintext codeword must NOT appear in it.
//   2. Simulate a second device: wipe local chats and the version cursor, pull, and
//      confirm the chat's transcript comes back decrypted and merged.
//   3. Conflict: another device bumps the mailbox out of band, then this device
//      pushes from its now-stale version; the engine must 409, pull, merge and retry
//      to success — the version advances, no work lost.
//   4. Diamonds travel too. A Diamond is a DIRECTORY, not a record, so the whole
//      of it must arrive — name, tags, crystal, log, links, and which model it
//      thinks with. A deletion must travel and STAY travelled, the freshest copy
//      must win, and a parcel from a device that predates any of this must still
//      apply.
//   5. The identity export bundle carries the salt, without which a second device
//      could never derive the key to open any of this.
//   6. A parcel the gateway refuses as too large (413) is SAID so — on the sync
//      chip, held, with the reason on hover — and the stall clears on the next
//      push that works.
//   7. A parked tab converges on window focus, without a reload, and a focus
//      storm coalesces into one pull.
//   8. Provider keys and model lists travel too: sealed keys only, deterministic
//      to the byte, freshest-wins per provider, and a union so neither device
//      loses a provider the other has never seen.
import { open, chat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Push, and wait until the parcel has actually LANDED. A single push() call is
/// not enough: one that finds another in flight (or the app busy) only
/// reschedules and returns, so awaiting it proves nothing — the pull that
/// follows then reads a stale blob and the Diamond checks flake. The server
/// version advancing is the only honest signal a push made it.
async function pushLanded(pg) {
	const landed = await pg.evaluate(async () => {
		const v0 = window.DaimondSync.state().version;
		const t0 = Date.now();
		while (window.DaimondSync.state().version <= v0 && Date.now() - t0 < 8000) {
			await window.DaimondSync.push();
			await new Promise(r => setTimeout(r, 150));
		}
		return window.DaimondSync.state().version > v0;
	});
	if (!landed) console.log('  note  pushLanded: version did not advance within 8s');
}

const s = await open({ name: 'sync', signIn: true, connect: true });
const { page } = s;

// The engine and its dependencies must be live and the session authed.
await page.waitForFunction(
	() => !!window.DaimondSync && !!window.DaimondCore && !!window.DaimondGateway
		&& DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	const authed = await page.evaluate(() => DaimondGateway.state().authed);
	check('gateway session is authed (sync can reach its mailbox)', authed);

	// Sync IS the Pro capability under test, so the account has to hold Pro:
	// without it the gateway answers 402 and there is nothing below to measure.
	const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
	const lic = await makePagePro(page, GWDIR);
	check('the account holds Pro, so sync may run at all',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);
	// A refusal must never put anything over the app -- that dialog is gone, and
	// this is what keeps it gone.
	const overlay = await page.evaluate(() =>
		[...document.querySelectorAll('.modal')]
			.filter(m => getComputedStyle(m).display !== 'none')
			.map(m => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)));
	check('no dialog was raised over the app on the way here', overlay.length === 0,
		overlay.join(' | '));

	// A distinctive codeword, carried in a real message so it lands in the synced
	// transcript. We then hunt for it in the ciphertext to prove it is sealed.
	const MARK = 'ZEBRA-' + '7788';
	await chat(s, 'Remember the codeword ' + MARK + ' for later.');

	// Push and read the mailbox straight back.
	const pushed = await page.evaluate(async () => {
		await window.DaimondSync.push();
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return { version: j.version, present: j.present, blob: j.blob || '' };
	});
	check('after a push the mailbox holds a version >= 1', pushed.present && pushed.version >= 1,
		'version=' + pushed.version);

	// The blob is ciphertext: the plaintext codeword must not be in it, and it must
	// not decode to readable JSON.
	check('the stored blob is ciphertext (plaintext codeword absent)', !pushed.blob.includes(MARK));
	const looksEncrypted = await page.evaluate((blob) => {
		try { const t = atob(blob); return !(t.trim().startsWith('{') || t.includes('"chats"') || t.includes('messages')); }
		catch (e) { return true; }
	}, pushed.blob);
	check('the blob does not decode to plaintext JSON', looksEncrypted);

	// (2) Second device: wipe local chats + version cursor, then pull.
	const restored = await page.evaluate(async () => {
		localStorage.removeItem('daimond-chats');
		localStorage.removeItem('daimond-sync-version');
		const v = await window.DaimondSync.pull();
		const arr = JSON.parse(localStorage.getItem('daimond-chats') || '[]');
		const text = JSON.stringify(arr);
		return { version: v, chatCount: arr.length, text };
	});
	check('a fresh device pulls and decrypts the chat transcript back',
		restored.chatCount >= 1 && restored.text.includes(MARK),
		'chats=' + restored.chatCount);

	// (3) Conflict: another device bumps the mailbox out of band (a garbage blob is
	// fine — the gateway is opaque and checks only the version), so THIS device's
	// known version is now stale. Its next push must 409, pull, merge and retry.
	const conflict = await page.evaluate(async () => {
		const before = window.DaimondSync.version();
		// The "other device" pushes over the current version, advancing it by one.
		const bump = await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: before, device: 'other-device', blob: 'AAAABBBBCCCCDDDD' }),
		});
		const bumpJson = await bump.json();
		// Make a genuine local change so the push is not skipped as a no-op: append
		// a new message (a fresh id survives the union-merge deterministically).
		const arr = JSON.parse(localStorage.getItem('daimond-chats') || '[]');
		if (arr.length) {
			arr[0].messages = arr[0].messages || [];
			arr[0].messages.push({ role: 'user', content: 'conflict-note', mid: 'conflicttest-' + Date.now(), ts: Date.now() });
			localStorage.setItem('daimond-chats', JSON.stringify(arr));
		}
		// This device still thinks the version is `before`. Push the fresh change.
		await window.DaimondSync.push();		// base=before → 409 → pull → retry → success.
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return { before, bumped: bumpJson.version, after: j.version };
	});
	check('the out-of-band write advanced the mailbox', conflict.bumped === conflict.before + 1,
		'before=' + conflict.before + ' bumped=' + conflict.bumped);
	check('a stale push reconciles (409 → pull → retry) and advances past the conflict',
		conflict.after > conflict.bumped, 'bumped=' + conflict.bumped + ' after=' + conflict.after);
	// After reconciling, the mailbox is this device's real (decryptable) state again.
	const reopened = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		try { const plain = await window.DaimondIdentity.unwrap(j.blob); JSON.parse(plain); return true; }
		catch (e) { return false; }
	});
	check('the reconciled blob is this device’s own decryptable state', reopened);

	// (3b) Workspace files travel too: write one, push, confirm it is sealed, then
	// delete it locally and pull it back.
	const FILEMARK = 'FILEMARK-' + '5566';
	const filePush = await page.evaluate(async (mark) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'sync-note.txt', content: 'workspace ' + mark }));
		await window.DaimondSync.push();
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return { version: j.version, blob: j.blob || '' };
	}, FILEMARK);
	check('a workspace file is sealed in the pushed blob (content absent from ciphertext)',
		!filePush.blob.includes(FILEMARK));

	const fileRestore = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_delete', JSON.stringify({ path: 'sync-note.txt' }));
		const gone = await app.run_tool('file_read', JSON.stringify({ path: 'sync-note.txt' }));
		localStorage.removeItem('daimond-sync-filebase');		// a fresh device has no baseline.
		await window.DaimondSync.pull();
		const back = await app.run_tool('file_read', JSON.stringify({ path: 'sync-note.txt' }));
		return { gone: String(gone), back: String(back) };
	});
	check('a deleted workspace file is restored by pull',
		fileRestore.back.includes(FILEMARK) && /error|not found|no such/i.test(fileRestore.gone),
		'back=' + fileRestore.back.slice(0, 40));

	// (3c) A deletion on another device propagates here (an unchanged local copy
	// is removed; an edit would have beaten the delete).
	const delProp = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'DELME.txt', content: 'delete me across devices' }));
		localStorage.removeItem('daimond-sync-filebase');
		await window.DaimondSync.push();								// agree on DELME.txt; it enters the baseline.
		const present = await app.run_tool('file_read', JSON.stringify({ path: 'DELME.txt' }));
		// The OTHER device deletes DELME.txt and pushes the reduced state.
		const state = await window.DaimondCore.collectSync();
		delete state.files['DELME.txt'];
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		const ver = window.DaimondSync.version();
		await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: ver, device: 'other', blob: blob }),
		});
		await window.DaimondSync.pull();							// honour the remote deletion.
		const after = await app.run_tool('file_read', JSON.stringify({ path: 'DELME.txt' }));
		return { present: String(present), after: String(after) };
	});
	check('a file deleted on another device is removed here',
		delProp.present.includes('delete me') && /error|not found|no such/i.test(delProp.after),
		'after=' + delProp.after.slice(0, 40));

	// ── (4) Diamonds ───────────────────────────────────────────────────
	// A Diamond is a directory in OPFS, so "it synced" means the whole directory
	// arrived: the crystal and its versions, the metadata that carries the name
	// and the tags, the append-only log, and the link sidecar. Each of those is a
	// separate file, and a merge that carried only some of them would look like a
	// working sync right up until the user asked the Graph pane a question.
	const DMARK = 'DIAMOND-' + '3344';

	/// Reach the real wasm on the page's own OPFS — the same store the app reads,
	/// not a copy of it.
	const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
	}, { src: fn.toString(), arg });

	/// Make a Diamond the way a person does: the rail's button, the dialog, the
	/// name, Create. Going through the UI is what records the model choice, which
	/// is half of what this section is checking travels.
	const newDiamond = async (name) => {
		await page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await page.waitForSelector('.dlg-card', { timeout: 8000 });
		const r = await page.evaluate((nm) => {
			const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
			if (!card) return 'no dialog';
			const inp = card.querySelector('input.dlg-input');
			if (!inp) return 'no name field';
			inp.value = nm;
			inp.dispatchEvent(new Event('input', { bubbles: true }));
			const btn = card.querySelector('.dlg-ok');
			if (!btn) return 'no create button';
			btn.click();
			return 'ok';
		}, name);
		await page.waitForTimeout(1000);
		return r;
	};

	/// Delete the named Diamond through its own × button, answering the confirm —
	/// the call site that has to write the tombstone.
	const removeDiamond = async (name) => {
		const found = await page.evaluate((nm) => {
			const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
			if (!box) return false;
			box.querySelector('.session-box-close').click();
			return true;
		}, name);
		if (!found) return 'not in the rail';
		await page.waitForSelector('.dlg-card', { timeout: 8000 });
		await page.evaluate(() => {
			const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
			card.querySelector('.dlg-ok').click();
		});
		await page.waitForTimeout(1000);
		return 'ok';
	};

	/// What another device would have pushed: this device's own state with one
	/// Diamond's entry rewritten to a different crystal at a different stamp,
	/// sealed under the shared key, written over the current version and pulled
	/// straight back — which is the merge under test.
	///
	/// The stamp is set in BOTH the places a real export carries it: the entry
	/// the merge compares, and the `meta.json` inside the packed directory. A
	/// real device's two copies always agree, so a fixture whose copies disagree
	/// would be testing a state that cannot occur.
	const otherDeviceShifts = (id, crystal, delta) => page.evaluate(async (arg) => {
		const state = await window.DaimondCore.collectSync();
		const e = (state.diamonds || []).find(d => d.id === arg.id);
		if (!e) return 'no entry for that Diamond';
		const pack = JSON.parse(e.data);
		pack.files['crystal.md'] = arg.crystal;
		const meta = JSON.parse(pack.files['.daimond/meta.json']);
		meta.updated = (e.updated || 0) + arg.delta;
		pack.files['.daimond/meta.json'] = JSON.stringify(meta);
		e.updated = meta.updated;
		e.data    = JSON.stringify(pack);
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'other', blob: blob }),
		});
		await window.DaimondSync.pull();
		return 'ok';
	}, { id, crystal, delta });

	/// One Diamond's whole visible state, read back from the store.
	const readDiamond = (id) => wasm(async (app, id) => {
		const list = JSON.parse(await app.list_diamonds()).find(d => d.id === id) || null;
		if (!list) return null;
		return {
			name:    list.name,
			tags:    list.tags || [],
			version: list.crystal_version,
			updated: list.updated,
			crystal: await app.read_crystal(id),
			log:     JSON.parse(await app.log_read(id)).length,
			links:   JSON.parse(await app.links_touching('diamond:' + id)),
		};
	}, id);

	// The fixture: two Diamonds, one of them tagged, steered (so its log has an
	// edit record beside the create) and linked to the other.
	await newDiamond('Sync-Alpha');
	await newDiamond('Sync-Bravo');
	const ids = await wasm(async (app, mark) => {
		const list = JSON.parse(await app.list_diamonds());
		const find = (n) => (list.find(d => d.name === n) || {}).id || '';
		const A = find('Sync-Alpha'), B = find('Sync-Bravo');
		if (!A || !B) return { A, B };
		await app.set_tags(A, JSON.stringify(['travel', 'sync']));
		await app.write_crystal(A, '# Alpha\n\ncrystal ' + mark + '\n');
		await app.add_link(A, 'diamond:' + A, 'diamond:' + B, 'part-of', 'bravo sits under alpha', 'user');
		return { A, B };
	}, DMARK);
	check('the fixture Diamonds were made through the rail', !!(ids.A && ids.B),
		'alpha=' + (ids.A || '-') + ' bravo=' + (ids.B || '-'));

	const before = await readDiamond(ids.A);
	// What the fixture actually laid down, before any of it travels. Without this
	// a fixture that quietly failed to write reads afterwards as a sync that
	// quietly failed to carry, and the two want opposite fixes.
	check('the fixture took locally before anything synced',
		!!before && before.tags.join(',') === 'travel,sync' && before.crystal.includes(DMARK)
			&& before.log >= 2 && before.links.length >= 1,
		before ? 'tags=[' + before.tags.join(',') + '] v' + before.version
			+ ' log=' + before.log + ' links=' + before.links.length : 'absent');
	await pushLanded(page);

	// A second device: it has never seen these Diamonds, holds no per-Diamond
	// model choice, and has no version cursor. Wiping all three is what "another
	// device" means here.
	const arrived = await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		for (const d of JSON.parse(await app.list_diamonds())) await app.delete_diamond(d.id);
		localStorage.removeItem('daimond-diamond-models');
		localStorage.removeItem('daimond-sync-version');
		const gone = JSON.parse(await app.list_diamonds()).length;
		await window.DaimondSync.pull();
		const models = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		return { gone: gone, model: models[id] || null };
	}, ids.A);
	check('the second device really started without them', arrived.gone === 0, 'held=' + arrived.gone);

	const after = await readDiamond(ids.A);
	check('a Diamond arrives on the second device at all', !!after,
		after ? after.name : 'absent');
	check('its name and tags arrive with it',
		!!after && after.name === 'Sync-Alpha' && after.tags.join(',') === 'travel,sync',
		after ? after.name + ' [' + after.tags.join(',') + ']' : 'absent');
	check('its crystal arrives, at the version it was left at',
		!!after && after.crystal.includes(DMARK) && after.version === before.version,
		after ? 'v' + after.version + ' len=' + after.crystal.length : 'absent');
	check('its log arrives whole (the create record and the edit)',
		!!after && after.log === before.log && after.log >= 2,
		after ? 'records=' + after.log : 'absent');
	check('the link to the other Diamond arrives, and is found from this end',
		!!after && after.links.some(l => l.other === 'diamond:' + ids.B && l.rel === 'part-of'),
		after ? JSON.stringify(after.links.map(l => l.other + '/' + l.rel)) : 'absent');
	check('the model the Diamond thinks with arrives with it',
		!!(arrived.model && arrived.model.model), JSON.stringify(arrived.model));
	// The other Diamond came too, or the rail below has nothing to delete.
	const bravoBack = await readDiamond(ids.B);
	check('the second Diamond arrives as well', !!bravoBack && bravoBack.name === 'Sync-Bravo',
		bravoBack ? bravoBack.name : 'absent');

	// (4b) Deleting through the rail must leave a tombstone in the parcel —
	// without one the other device still holds the Diamond and hands it straight
	// back on the next pull.
	const removed = await removeDiamond('Sync-Bravo');
	const parcel = await page.evaluate(async (id) => {
		const state = await window.DaimondCore.collectSync();
		return {
			v:      state.v,
			tombed: !!(state.diamondTombs && state.diamondTombs[id]),
			listed: (state.diamonds || []).some(d => d.id === id),
			count:  (state.diamonds || []).length,
		};
	}, ids.B);
	check('a Diamond deleted in the rail is tombstoned in the parcel',
		removed === 'ok' && parcel.tombed, removed + ', tombed=' + parcel.tombed);
	check('and is no longer offered as a live Diamond',
		!parcel.listed, 'diamonds carried=' + parcel.count);
	check('the parcel declares itself v2', parcel.v === 2, 'v=' + parcel.v);

	// (4c) A deletion made on ANOTHER device reaches this one, and does not come
	// back on the cycle after — the failure a tombstone-less delete would show as
	// a Diamond that reappears every time the app is opened.
	const delCycle = await page.evaluate(async (id) => {
		const post = async (state) => {
			const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
			await fetch('/api/sync', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
				body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'other', blob: blob }),
			});
			await window.DaimondSync.pull();
		};
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const here = async () => JSON.parse(await app.list_diamonds()).some(d => d.id === id);
		const held = await here();
		// The other device deletes it: gone from its Diamonds, present in its tombs.
		const state = await window.DaimondCore.collectSync();
		state.diamonds = (state.diamonds || []).filter(d => d.id !== id);
		state.diamondTombs = state.diamondTombs || {};
		state.diamondTombs[id] = Date.now();
		await post(state);
		const afterPull = await here();
		// A full cycle later — this device pushes its own view, then pulls again.
		await window.DaimondSync.push();
		await window.DaimondSync.pull();
		const afterCycle = await here();
		return { held, afterPull, afterCycle };
	}, ids.A);
	check('a Diamond deleted on another device is deleted here',
		delCycle.held === true && delCycle.afterPull === false,
		'held=' + delCycle.held + ' after=' + delCycle.afterPull);
	check('and does not resurrect on the next cycle', delCycle.afterCycle === false,
		'after a push+pull, present=' + delCycle.afterCycle);

	// (4d) Freshest wins, wholesale, and the comparison is STRICT: an equal stamp
	// keeps what is here, so an unchanged Diamond is not rewritten on every pull.
	await newDiamond('Sync-Charlie');
	const cid = await wasm(async (app, mark) => {
		const list = JSON.parse(await app.list_diamonds());
		const id = (list.find(d => d.name === 'Sync-Charlie') || {}).id || '';
		if (id) await app.write_crystal(id, 'HERE-' + mark);
		return id;
	}, DMARK);
	await pushLanded(page);

	const crystalNow = () => wasm((app, id) => app.read_crystal(id), cid);

	const shifted = await otherDeviceShifts(cid, 'OLDER-COPY', -60000);
	const keptOlder = await crystalNow();
	await otherDeviceShifts(cid, 'EQUAL-COPY', 0);
	const keptEqual = await crystalNow();
	await otherDeviceShifts(cid, 'NEWER-COPY', 60000);
	const tookNewer = await crystalNow();
	check('the freshest-wins fixture reached the other device', shifted === 'ok', shifted);
	check('an older copy from another device does not overwrite this one',
		keptOlder === 'HERE-' + DMARK, keptOlder.slice(0, 30));
	check('an equally-stamped copy keeps what is here (the comparison is strict)',
		keptEqual === 'HERE-' + DMARK, keptEqual.slice(0, 30));
	check('a fresher copy from another device replaces this one',
		tookNewer === 'NEWER-COPY', tookNewer.slice(0, 30));

	// (4e) A device that predates all of this sends a v1 parcel: no `diamonds`,
	// no `diamondTombs`. It must apply as it always did, and touch nothing.
	const v1 = await page.evaluate(async (id) => {
		const state = await window.DaimondCore.collectSync();
		delete state.diamonds;
		delete state.diamondTombs;
		state.v = 1;
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'old-device', blob: blob }),
		});
		let threw = '';
		try { await window.DaimondCore.applySync(JSON.parse(await window.DaimondIdentity.unwrap(blob))); }
		catch (e) { threw = String(e && e.message || e); }
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return { threw, still: JSON.parse(await app.list_diamonds()).some(d => d.id === id) };
	}, cid);
	check('a v1 parcel (no diamonds section) applies without error',
		v1.threw === '', v1.threw);
	check('and leaves this device’s Diamonds exactly where they were', v1.still === true);

	// ── (6) A parcel the gateway refuses as too large is VISIBLE ───────
	// A 413 used to log to the console and stop, so sync simply stopped working
	// and nothing on the screen said so. The refusal is stubbed rather than
	// provoked: the real ceiling is 32 MB, and building that in the browser to
	// test a status chip would cost more than the behaviour it proves.
	const tooBig = await page.evaluate(async () => {
		const chip = () => {
			const c = document.getElementById('sync-chip');
			if (!c) return null;
			return {
				state:  c.dataset.state || '',
				text:   (c.querySelector('.stext') || {}).textContent || '',
				title:  c.title || '',
				shown:  c.style.display !== 'none',
			};
		};
		// A genuine local change, or the push is skipped as a no-op and nothing
		// reaches the (stubbed) gateway at all.
		const bump = (tag) => {
			const a = JSON.parse(localStorage.getItem('daimond-chats') || '[]');
			if (!a.length) return false;
			a[0].messages = a[0].messages || [];
			a[0].messages.push({ role: 'user', content: tag, mid: tag, ts: Date.now() });
			a[0].updatedAt = Date.now();
			localStorage.setItem('daimond-chats', JSON.stringify(a));
			return true;
		};
		const real = window.fetch;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && o && o.method === 'POST') {
				return Promise.resolve(new Response(
					JSON.stringify({ ok: false, error: 'Sync blob exceeds the size limit' }),
					{ status: 413, headers: { 'content-type': 'application/json' } }));
			}
			return real.apply(this, arguments);
		};
		const changed = bump('too-big-1');
		await window.DaimondSync.push();
		const stalled = chip();
		const api = window.DaimondSync.state ? window.DaimondSync.state() : null;
		window.fetch = real;
		// And a later successful push clears it — a stall that outlives its cause
		// is the same lie the other way round.
		bump('too-big-2');
		await window.DaimondSync.push();
		const after = chip();
		return { changed, stalled, api, after };
	});
	check('a 413 push shows a stalled state on the sync chip, held (not a flash)',
		!!(tooBig.stalled && tooBig.stalled.shown && tooBig.stalled.state === 'stalled'),
		JSON.stringify(tooBig.stalled));
	check('and says on hover that the parcel is too large, naming what makes it large',
		!!(tooBig.stalled && /too large/i.test(tooBig.stalled.title)
			&& /(Diamond|file)/i.test(tooBig.stalled.title)),
		(tooBig.stalled && tooBig.stalled.title || '').slice(0, 120));
	check('the engine reports the stall through its own surface too',
		!!(tooBig.api && tooBig.api.stalled === true), JSON.stringify(tooBig.api));
	check('a later successful push clears the stall',
		!!(tooBig.after && tooBig.after.state === 'synced'), JSON.stringify(tooBig.after));
	const lastLine = await page.evaluate(() => {
		const c = document.getElementById('sync-chip');
		return { title: c ? c.title : '', at: (window.DaimondSync.state ? DaimondSync.state().lastSyncedAt : 0) };
	});
	check('a successful sync records when it happened, and the chip can say so',
		lastLine.at > 0 && /synced/i.test(lastLine.title),
		JSON.stringify(lastLine).slice(0, 120));

	// ── (7) A parked tab converges on focus, without a reload ──────────
	// Sync fired on idle, on the tab going away, and on auth. A device left open
	// on the desk therefore never caught up until it was reloaded. Coming back to
	// a window is exactly the moment its owner expects to see the other device's
	// work.
	const focus = await page.evaluate(async () => {
		const mark = 'FOCUSMARK-' + Date.now();
		const state = await window.DaimondCore.collectSync();
		state.chats = (state.chats || []).concat([{
			id: 'focus-' + Date.now(), title: mark, updatedAt: Date.now(),
			messages: [{ role: 'user', content: mark, mid: 'fm-' + Date.now(), ts: Date.now() }],
		}]);
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		const r = await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'other', blob: blob }),
		});
		const posted = r.status;
		const before = (localStorage.getItem('daimond-chats') || '').indexOf(mark) !== -1;
		// Count the pulls, so a focus STORM is proved to coalesce into one.
		const real = window.fetch;
		let gets = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && (!o || !o.method || o.method === 'GET')) gets++;
			return real.apply(this, arguments);
		};
		for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		await new Promise(res => setTimeout(res, 2500));
		const after = (localStorage.getItem('daimond-chats') || '').indexOf(mark) !== -1;
		const storm = gets;
		// And a focus arriving straight back is refused by the throttle.
		window.dispatchEvent(new Event('focus'));
		await new Promise(res => setTimeout(res, 1200));
		const again = gets;
		window.fetch = real;
		return { posted, before, after, storm, again };
	});
	check('the other device’s push landed on the mailbox', focus.posted === 200, 'HTTP ' + focus.posted);
	check('this device did not already hold it', focus.before === false);
	check('focus pulls the other device’s work in, with no reload', focus.after === true);
	check('a focus storm coalesces into ONE pull', focus.storm === 1, 'pulls=' + focus.storm);
	check('a focus straight afterwards is throttled, not another pull',
		focus.again === focus.storm, 'pulls=' + focus.again);

	// ── (8) Models and API keys travel with the work ───────────────────
	// A second device that holds the account holds the same identity, so a key
	// sealed under it opens on both. That is what makes carrying keys safe, and
	// it is the only reason this is allowed at all: what travels is `keyEnc`,
	// never a readable key.
	const M = await page.evaluate(async () => {
		const S = window.DaimondModels;
		const r = { api: typeof S.exportSync === 'function' && typeof S.applySync === 'function' };
		if (!r.api) return r;
		const now = Date.now();
		const PLAIN = 'LOCAL-KEY-' + '4242';
		const def0 = S.getDefault();		// put the app's own default back afterwards

		S.addProvider('groq', { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions' });
		await S.setKey('groq', PLAIN);

		const e1 = JSON.stringify(S.exportSync());
		const e2 = JSON.stringify(S.exportSync());
		r.deterministic  = e1 === e2;
		r.carriesKeyEnc  = !!(S.exportSync().providers.groq || {}).keyEnc;
		r.plaintextAbsent = e1.indexOf(PLAIN) === -1;
		r.noMintedRow    = !Object.prototype.hasOwnProperty.call(S.exportSync().providers, 'credits');

		// A provider only the other device has arrives; one only this device has
		// survives. (The union is what makes a second device usable at all.)
		await S.applySync({
			v: 2, def: { provider: '', model: '' }, defAt: 0,
			providers: { together: {
				name: 'Together AI', url: 'https://api.together.xyz/v1/chat/completions',
				models: ['m-b', 'm-a'], fetched: now, touched: now, keyEnc: 'REMOTE-SEALED',
			} },
		});
		let ex = S.exportSync();
		r.remoteArrived = !!ex.providers.together && ex.providers.together.keyEnc === 'REMOTE-SEALED';
		r.localSurvived = !!ex.providers.groq;
		r.modelsSorted  = !!ex.providers.together
			&& ex.providers.together.models.join(',') === 'm-a,m-b';

		// An OLDER remote copy must not clobber a newer local one.
		const stamp = ex.providers.groq.touched;
		await S.applySync({ v: 2, providers: { groq: {
			name: 'Stale', url: 'https://stale.example/v1/chat/completions',
			models: [], fetched: 0, touched: stamp - 60000, keyEnc: 'STALE-SEALED',
		} } });
		let g = S.exportSync().providers.groq;
		r.olderIgnored = g.keyEnc !== 'STALE-SEALED' && g.url.indexOf('groq.com') !== -1;

		// A fresher one wins, wholesale.
		await S.applySync({ v: 2, providers: { groq: {
			name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions',
			models: ['fresh-1'], fetched: now + 60000, touched: stamp + 60000, keyEnc: 'FRESH-SEALED',
		} } });
		g = S.exportSync().providers.groq;
		r.newerWon = g.keyEnc === 'FRESH-SEALED' && g.models.join(',') === 'fresh-1';

		// The live session keeps the key it is running on: a merge must not lock
		// a working device out mid-turn.
		r.sessionKeyKept = S.keyFor('groq') === PLAIN;

		// The default follows the freshest side, and only to somewhere real.
		S.setDefault('groq', 'fresh-1');
		const defAt = S.exportSync().defAt;
		await S.applySync({ v: 2, def: { provider: 'nowhere', model: 'x' }, defAt: defAt + 60000, providers: {} });
		r.defGuarded = S.getDefault().provider === 'groq';
		await S.applySync({ v: 2, def: { provider: 'together', model: 'm-a' }, defAt: defAt + 120000, providers: {} });
		r.defFreshest = S.getDefault().provider === 'together' && S.getDefault().model === 'm-a';
		await S.applySync({ v: 2, def: { provider: 'groq', model: 'fresh-1' }, defAt: 1, providers: {} });
		r.defOlderIgnored = S.getDefault().provider === 'together';

		// Enumeration order must not reach the wire: the push-skip comparison is a
		// string compare, so a store that enumerates differently would push for ever.
		S.addProvider('zzz-probe', { name: 'Z', url: 'https://z.example/v1/chat/completions' });
		S.addProvider('aaa-probe', { name: 'A', url: 'https://a.example/v1/chat/completions' });
		const ks = Object.keys(S.exportSync().providers);
		r.sortedKeys = JSON.stringify(ks) === JSON.stringify(ks.slice().sort());

		// An old parcel carries no models section at all, and must still apply.
		let threw = '';
		try {
			await S.applySync(undefined);
			await S.applySync({});
			await S.applySync({ v: 1 });
		} catch (e) { threw = String((e && e.message) || e); }
		r.oldParcelNoop = threw === '' && !!S.exportSync().providers.groq;

		['groq', 'together', 'zzz-probe', 'aaa-probe'].forEach(function (id) { S.removeProvider(id); });
		S.setDefault(def0.provider, def0.model);
		return r;
	});
	check('models.js offers exportSync/applySync for the parcel', M.api === true);
	check('two exports of one store are byte-identical', M.deterministic === true);
	check('the export lists providers in sorted order (enumeration never reaches the wire)',
		M.sortedKeys === true);
	check('a model list travels sorted, for the same reason', M.modelsSorted === true);
	check('a sealed key travels', M.carriesKeyEnc === true);
	check('a readable key never does', M.plaintextAbsent === true);
	check('the minted credits row does not travel (it is minted per device)',
		M.noMintedRow === true);
	check('a provider only the other device has arrives, key and all', M.remoteArrived === true);
	check('a provider only this device has survives the merge', M.localSurvived === true);
	check('an older remote provider does not clobber a newer local one', M.olderIgnored === true);
	check('a fresher remote provider replaces the local one', M.newerWon === true);
	check('the running session keeps the key it holds', M.sessionKeyKept === true);
	check('the default follows the freshest side', M.defFreshest === true);
	check('an older default is ignored', M.defOlderIgnored === true);
	check('a default naming a provider nobody has is refused', M.defGuarded === true);
	check('a parcel with no models section applies as a no-op', M.oldParcelNoop === true);

	// The plaintext-at-rest key exists only where there is no identity to seal
	// under — and sync only runs WITH one. It is still checked, because the store
	// on disk may predate the identity and the export must not carry it out.
	const atRest = await page.evaluate(() => {
		const S = window.DaimondModels;
		if (typeof S.exportSync !== 'function') return { absent: false, noField: false };
		const raw = localStorage.getItem('daimond-models-v2');
		localStorage.setItem('daimond-models-v2', JSON.stringify({
			v: 2, def: { provider: 'plainprov', model: 'm' },
			providers: { plainprov: {
				name: 'Plain', url: 'https://plain.example/v1/chat/completions',
				key: 'AT-REST-PLAIN-9876', keyEnc: '', models: ['m'], fetched: 1, touched: 1,
			} },
		}));
		S.init({});
		const ex = S.exportSync();
		const out = {
			absent:  JSON.stringify(ex).indexOf('AT-REST-PLAIN-9876') === -1,
			noField: !Object.prototype.hasOwnProperty.call(ex.providers.plainprov || {}, 'key'),
		};
		if (raw === null) localStorage.removeItem('daimond-models-v2');
		else localStorage.setItem('daimond-models-v2', raw);
		S.init({});
		return out;
	});
	check('a plaintext-at-rest key is left behind by the export',
		atRest.absent === true && atRest.noField === true, JSON.stringify(atRest));

	// (5) The export bundle carries the salt (without it, no second device could decrypt).
	const bundle = await page.evaluate(() => {
		const b = window.DaimondIdentity.exportBundle();
		return b ? { hasSalt: !!b.salt, hasPriv: !!b.priv, hasPub: !!b.pub, v: b.v } : null;
	});
	check('identity export bundle carries salt + wrapped key + pubkey',
		!!bundle && bundle.hasSalt && bundle.hasPriv && bundle.hasPub && bundle.v === 1);

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|409|426|502|Unauthorized/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_sync ran without throwing', false, String(e && e.message || e));
} finally {
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
