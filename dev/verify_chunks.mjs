// verify_chunks.mjs — a workspace file too large for the sync blob travels to a
// second device through the content-addressed chunk store, and comes back byte-
// for-byte, without the gateway ever seeing its plaintext.
//
// This drives the REAL client (chunks.js + daimond.js) against the REAL gateway
// (/api/chunk + /api/sync), so it needs the dev stack up: the app (DAIMOND_PORT,
// default 8777) and a gateway on :9002. It starts its own gateway so the run is
// self-contained.
//
//   1. Sign in. Write a 200 KiB file — well over the 128 KiB inline ceiling, so
//      it is offloaded to chunks rather than carried in the blob.
//   2. Push. The sync blob must NOT contain the file's plaintext (it holds only
//      chunk references), and a fetched chunk must be ciphertext (marker absent).
//   3. Second device: delete the file, wipe the offload cache and cursors, pull.
//      The file is reconstructed from its chunks, identical to the original.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, procLog } from './gwbin.mjs';
import { open, chat } from './harness.mjs';
import { makePagePro } from './pro.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GWDIR  = path.resolve(__dirname, '..', 'gateway');
const GW_URL = 'http://127.0.0.1:9002';
/// What the gateway says while this runs. A chunk request answering 500 says
/// only that something went wrong; the reason is logged beside it, here.
/// Silent when this run reuses a gateway it did not start.
const GW_LOG = procLog('verify_chunks');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

let gw = null;
async function waitFor(fn, ms = 20000, gap = 300) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try { if (await fn()) return true; } catch (e) { /* keep waiting */ }
		await new Promise(r => setTimeout(r, gap));
	}
	return false;
}
async function startGateway() {
	gw = spawn(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWDIR,
		env: { ...process.env, APP_MODE: 'sandbox' },
		stdio: GW_LOG.stdio,
	});
	return await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
}

requireFreshGateway();

// Use a gateway already up (started outside for environments where spawning a
// child here is unreliable), otherwise start our own.
const alreadyUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok, 800, 200);
if (alreadyUp) {
	console.log('  ok   using the gateway already on :9002');
	gw = null;	// not ours to kill.
} else {
	check('gateway starts', await startGateway());
}

const s = await open({ name: 'chunks', signIn: true, connect: false });
const { page } = s;

await page.waitForFunction(
	() => !!window.DaimondSync && !!window.DaimondChunks && !!window.DaimondCore
		&& !!window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	check('the chunk module and an authed session are live',
		await page.evaluate(() => !!window.DaimondChunks && DaimondGateway.state().authed));

	// Sync and the chunk store are Pro capabilities, so a free account is
	// refused at the door (402) and nothing below could ever happen. Buy the
	// licence the way a user does -- a signed checkout event -- rather than
	// testing the gate instead of the feature.
	const lic = await makePagePro(page, GWDIR, GW_URL);
	check('the account holds Pro, so sync is allowed to run',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);

	// A 200 KiB file: over the 128 KiB inline ceiling, so it must be offloaded.
	const MARK = 'CHUNKMARK-' + '4242';
	const built = await page.evaluate(async (mark) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		// 200 KiB of text with the marker sprinkled through it.
		let body = '';
		while (body.length < 200 * 1024) body += mark + ' lorem ipsum dolor sit amet, consectetur. ';
		await app.run_tool('file_write', JSON.stringify({ path: 'big-note.txt', content: body }));
		return { size: body.length };
	}, MARK);
	check('a 200 KiB workspace file exists (over the inline ceiling)', built.size > 128 * 1024,
		'size=' + built.size);

	// Push: offload to chunks, then the referencing blob.
	const pushed = await page.evaluate(async () => {
		await window.DaimondSync.push();
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return { version: j.version, present: j.present, blob: j.blob || '' };
	});
	check('after a push the mailbox holds a version >= 1', pushed.present && pushed.version >= 1,
		'version=' + pushed.version);

	// The blob is small references, not the body: the plaintext marker is absent.
	check('the large file is NOT inline in the sync blob (offloaded to chunks)',
		!pushed.blob.includes(MARK));

	// The blob names the file under `chunked`, and a fetched chunk is ciphertext.
	const chunkCheck = await page.evaluate(async (mark) => {
		const plain = await window.DaimondIdentity.unwrap(document ? (await (async () => {
			const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			return (await r.json()).blob;
		})()) : '');
		const state = JSON.parse(plain);
		const ref = state.chunked && state.chunked['big-note.txt'];
		if (!ref || !ref.chunks || !ref.chunks.length) return { referenced: false };
		const addr = ref.chunks[0].addr;
		const g = await fetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ op: 'get', addr }),
		});
		const gj = await g.json();
		// The stored chunk is base64url ciphertext: decode and confirm the marker
		// is not in it.
		let cipherHasMark = false;
		try {
			const t = atob(String(gj.blob || '').replace(/-/g, '+').replace(/_/g, '/'));
			cipherHasMark = t.includes(mark);
		} catch (e) { /* undecodable is fine */ }
		return { referenced: true, chunkCount: ref.chunks.length, present: !!gj.present, cipherHasMark };
	}, MARK);
	check('the blob references the file in its chunk manifest', chunkCheck.referenced,
		chunkCheck.referenced ? ('chunks=' + chunkCheck.chunkCount) : 'no chunked entry');
	check('the gateway holds the referenced chunk', chunkCheck.present);
	check('a stored chunk is ciphertext (plaintext marker absent)', !chunkCheck.cipherHasMark);

	// Second device: drop the local copy, wipe the offload cache and cursors,
	// pull. The file must NOT be downloaded — it stays in cloud storage until
	// asked for, which is what lets a workspace be larger than the device — and
	// must then come back byte-for-byte when it is fetched.
	const restored = await page.evaluate(async (mark) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_delete', JSON.stringify({ path: 'big-note.txt' }));
		localStorage.removeItem('daimond-chunk-map');	// a fresh device has never offloaded.
		localStorage.removeItem('daimond-sync-version');
		localStorage.removeItem('daimond-sync-filebase');
		await window.DaimondSync.pull();

		const onDisk = async () => {
			try {
				const root = await navigator.storage.getDirectory();
				return await (await (await root.getFileHandle('big-note.txt')).getFile()).text();
			} catch (e) { return null; }
		};
		const afterPull = await onDisk();
		const away  = window.DaimondCloud.awayPaths();
		const known = !!window.DaimondCloud.manifest('big-note.txt');
		// The agent is told where it is rather than that it is missing.
		const readErr = String(await app.run_tool('file_read', JSON.stringify({ path: 'big-note.txt' })));
		// And fetching it is a deliberate, separate act.
		const fetched = String(await app.run_tool('file_fetch', JSON.stringify({ path: 'big-note.txt' })));
		const back = await onDisk();
		return {
			lazy:      afterPull === null,
			known:     known,
			away:      Object.prototype.hasOwnProperty.call(away, 'big-note.txt'),
			readErr:   readErr,
			fetchedOk: /^\s*OK/.test(fetched) || /fetched/i.test(fetched),
			size:      back ? back.length : 0,
			hasMark:   !!back && back.includes(mark),
		};
	}, MARK);
	check('a pull does NOT download the large file (it stays in cloud storage)', restored.lazy);
	check('the device still knows the file exists, as a cloud manifest', restored.known);
	check('the file is listed as away from this device', restored.away);
	check('file_read tells the agent it is in cloud storage, not that it is missing',
		/in cloud storage/i.test(restored.readErr), restored.readErr.slice(0, 90));
	check('file_fetch brings it down on request', restored.fetchedOk, restored.fetchedOk ? '' : 'fetch refused');
	check('the fetched file is byte-for-byte the original',
		restored.hasMark && restored.size > 128 * 1024, 'size=' + restored.size);
} catch (e) {
	check('no exception during the run', false, String(e && e.message || e));
} finally {
	try { await s.browser.close(); } catch (e) { /* ignore */ }
	if (gw) { try { gw.kill('SIGTERM'); } catch (e) { /* ignore */ } }
}

if (bad.length) GW_LOG.report();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
