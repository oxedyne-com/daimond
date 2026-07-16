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
//   4. The identity export bundle carries the salt, without which a second device
//      could never derive the key to open any of this.
import { open, chat } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

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

	// (4) The export bundle carries the salt (without it, no second device could decrypt).
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
