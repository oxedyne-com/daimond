// verify_cloud.mjs — cloud storage is where the workspace lives, and the device
// holds as much of it as it can.
//
// The load-bearing test here is the FIRST one. The gateway sweeps every chunk
// the committed index does not name, and the client used to rebuild that index
// by walking its own sandbox — so a device that was not holding a file omitted
// it, and the sweep deleted it for everyone. Under a residency model, where a
// file is MEANT to live in cloud storage alone, that is straightforward data
// loss. The index is merged state now, and a device that lacks a file must
// still carry it forward.
//
// Drives the REAL client (cloud.js + chunks.js + daimond.js) against the REAL
// gateway (/api/chunk + /api/sync). Starts its own gateway, or uses one already
// on :9002.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GWDIR  = path.resolve(__dirname, '..', 'gateway');
const GW_URL = 'http://127.0.0.1:9002';

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
const alreadyUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok, 800, 200);
if (alreadyUp) {
	console.log('  ok   using the gateway already on :9002');
} else {
	gw = spawn(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWDIR, env: { ...process.env, APP_MODE: 'sandbox' }, stdio: 'ignore',
	});
	check('gateway starts', await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok));
}

const s = await open({ name: 'cloud', signIn: true, connect: false });
const { page } = s;

await page.waitForFunction(
	() => !!window.DaimondSync && !!window.DaimondChunks && !!window.DaimondCloud
		&& !!window.DaimondCore && !!window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	check('the cloud module and an authed session are live',
		await page.evaluate(() => !!window.DaimondCloud && DaimondGateway.state().authed));

	// Two large files, so one can be evicted while the other is pinned.
	const MARK = 'CLOUDMARK-7788';
	await page.evaluate(async (mark) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const body = (n) => { let b = ''; while (b.length < n) b += mark + ' the quick brown fox jumps. '; return b; };
		await app.run_tool('file_write', JSON.stringify({ path: 'papers/alpha.txt', content: body(200 * 1024) }));
		await app.run_tool('file_write', JSON.stringify({ path: 'papers/beta.txt',  content: body(160 * 1024) }));
		await window.DaimondSync.push();
	}, MARK);

	const seeded = await page.evaluate(() => ({
		alpha: !!window.DaimondCloud.manifest('papers/alpha.txt'),
		beta:  !!window.DaimondCloud.manifest('papers/beta.txt'),
	}));
	check('both large files are recorded in the cloud index', seeded.alpha && seeded.beta);

	// ── The regression: a device that lacks a file must not delete it ──
	// Simulate the smallest device. Drop alpha locally, keep the merged index,
	// push. The gateway must still hold alpha's chunks afterwards.
	const survived = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const mani = window.DaimondCloud.manifest('papers/alpha.txt');
		const addr = mani.chunks[0].addr;
		// The body is gone from this device, but the file is NOT deleted — this is
		// eviction, which must never be mistaken for a delete.
		const root = await navigator.storage.getDirectory();
		const dir  = await root.getDirectoryHandle('papers');
		await dir.removeEntry('alpha.txt');
		await window.DaimondCloud.refreshPaths();
		await window.DaimondSync.push();
		const g = await fetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ op: 'get', addr }),
		});
		const gj = await g.json();
		return { held: !!gj.present, stillIndexed: !!window.DaimondCloud.manifest('papers/alpha.txt') };
	});
	check('a push from a device NOT holding the file keeps its chunks in cloud storage', survived.held);
	check('and keeps it in the index, because absence is not deletion', survived.stillIndexed);

	// ── Fetching it back ──
	const round = await page.evaluate(async (mark) => {
		const res = await window.DaimondCloud.fetch('papers/alpha.txt');
		let back = null;
		try {
			const root = await navigator.storage.getDirectory();
			const dir  = await root.getDirectoryHandle('papers');
			back = await (await (await dir.getFileHandle('alpha.txt')).getFile()).text();
		} catch (e) { back = null; }
		return { res, size: back ? back.length : 0, hasMark: !!back && back.includes(mark) };
	}, MARK);
	check('fetching brings it back byte-for-byte', round.hasMark && round.size > 128 * 1024,
		'size=' + round.size);

	// ── Freeing space keeps the file, and a pin refuses ──
	const freed = await page.evaluate(async () => {
		window.DaimondCloud.pin('papers/beta.txt', true);
		const evictBeta  = await window.DaimondCloud.evict('papers/beta.txt');
		const evictAlpha = await window.DaimondCloud.evict('papers/alpha.txt');
		const away = window.DaimondCloud.awayPaths();
		return {
			pinRefused:   evictBeta.indexOf('OK') !== 0,
			alphaFreed:   evictAlpha.indexOf('OK') === 0,
			alphaAway:    Object.prototype.hasOwnProperty.call(away, 'papers/alpha.txt'),
			alphaKnown:   !!window.DaimondCloud.manifest('papers/alpha.txt'),
			betaStillHere: !Object.prototype.hasOwnProperty.call(away, 'papers/beta.txt'),
		};
	});
	check('a pinned file refuses to be freed', freed.pinRefused);
	check('freeing space drops the local copy', freed.alphaFreed && freed.alphaAway);
	check('but the file remains in cloud storage', freed.alphaKnown);
	check('the pinned file is still on this device', freed.betaStillHere);

	// ── Non-ASCII must be freeable too ──
	// Every recorded length must be BYTES on disk. Mixing in a character count
	// once made eviction compare the two, and since they agree only for pure
	// ASCII, a single accented character marked the file permanently "edited" and
	// it could never be freed. The pipeline is byte-shaped throughout now, so the
	// test's job is to hold it that way.
	const accented = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		let body = '';
		while (body.length < 200 * 1024) body += 'naïve café façade — Ünicode, mesure de qualité. ';
		await app.run_tool('file_write', JSON.stringify({ path: 'papers/accented.txt', content: body }));
		await window.DaimondSync.push();
		const m = window.DaimondCloud.manifest('papers/accented.txt');
		const onDisk = (await window.DaimondCloud.fileAt('papers/accented.txt')).size;
		const res = await window.DaimondCloud.evict('papers/accented.txt');
		return { res, chars: body.length, size: m && m.size, bytes: m && m.bytes, onDisk };
	});
	check('a non-ASCII file records its length in bytes, not characters',
		accented.size === accented.onDisk && accented.bytes === accented.onDisk
			&& accented.onDisk > accented.chars,
		'chars=' + accented.chars + ' bytes=' + accented.onDisk);
	check('and can still be freed', accented.res.indexOf('OK') === 0, accented.res.slice(0, 80));

	// ── The agent sees it, and is told plainly ──
	const agentView = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const listing = String(await app.run_tool('file_list', JSON.stringify({ path: 'papers' })));
		const read    = String(await app.run_tool('file_read', JSON.stringify({ path: 'papers/alpha.txt' })));
		return { listing, read };
	});
	check('file_list shows the away file, marked as in cloud storage',
		/alpha\.txt\s+\(\d+ bytes, in cloud storage\)/.test(agentView.listing),
		agentView.listing.replace(/\n/g, ' | ').slice(0, 100));
	check('file_read refuses honestly and names the remedy',
		/in cloud storage/i.test(agentView.read) && /file_fetch/.test(agentView.read),
		agentView.read.slice(0, 90));

	// ── The gateway refuses to sweep for a stale device ──
	const stale = await page.evaluate(async () => {
		const r = await fetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ op: 'commit', chunks: [], blob_version: 0 }),
		});
		return { status: r.status, json: await r.json().catch(() => null) };
	});
	check('the gateway refuses a commit derived from a stale view', stale.status === 409,
		'status=' + stale.status);
	const stillThere = await page.evaluate(async () => {
		const mani = window.DaimondCloud.manifest('papers/alpha.txt');
		const g = await fetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ op: 'get', addr: mani.chunks[0].addr }),
		});
		return (await g.json()).present;
	});
	check('and the empty index it sent swept nothing', !!stillThere);

	// ── Save a copy must write the WHOLE file ──
	// The export once read through file_read, which truncates at 60 KB, so every
	// larger file was silently shortened on the way to the user's disk. The
	// folder picker is native and cannot be driven, but an OPFS directory handle
	// implements the same interface — so stub the picker with one and read back
	// exactly what a real folder would have received. The destination is dotted so
	// the walk skips it: a real folder is on disk, outside OPFS, and can never be
	// inside the tree being copied.
	await page.evaluate(() => { try { DaimondPanels.open('work'); } catch (e) { /* already */ } });
	await page.waitForTimeout(800);
	const exported = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		let big = '';
		while (big.length < 150 * 1024) big += 'export fidelity matters, every byte of it. ';
		await app.run_tool('file_write', JSON.stringify({ path: 'out/big.txt', content: big }));

		const root = await navigator.storage.getDirectory();
		const dest = await root.getDirectoryHandle('.export_target', { create: true });
		const realPicker = window.showDirectoryPicker;
		window.showDirectoryPicker = async () => dest;
		try {
			const btns = Array.from(document.querySelectorAll('#panel-work .files-mode-btn'));
			const save = btns.find(b => /Save a copy/i.test(b.textContent));
			if (!save) return { ran: false };
			save.click();
			// Give the walk time to finish; it writes file by file.
			for (let i = 0; i < 60; i++) {
				await new Promise(r => setTimeout(r, 250));
				try {
					const d = await dest.getDirectoryHandle('out');
					const f = await (await d.getFileHandle('big.txt')).getFile();
					if (f.size >= big.length) return { ran: true, wrote: f.size, want: big.length };
				} catch (e) { /* not there yet */ }
			}
			let got = 0;
			try {
				const d = await dest.getDirectoryHandle('out');
				got = (await (await d.getFileHandle('big.txt')).getFile()).size;
			} catch (e) { got = 0; }
			return { ran: true, wrote: got, want: big.length };
		} finally { window.showDirectoryPicker = realPicker; }
	});
	check('save a copy writes the file whole, not truncated at the tool cap',
		exported.ran && exported.wrote === exported.want,
		'wrote=' + exported.wrote + ' want=' + exported.want);

	// ── The agent cannot download without limit ──
	const budget = await page.evaluate(async () => {
		const before = window.DaimondCloud.agentAllowance();
		// Pretend the agent has already pulled its fill this window.
		localStorage.setItem('daimond-cloud-agent-fetches',
			JSON.stringify([{ at: Date.now(), n: 200 * 1024 * 1024 }]));
		const after = window.DaimondCloud.agentAllowance();
		const refusal = await window.__daimondCloudFetch('papers/alpha.txt')
			.catch(e => String(e));
		localStorage.removeItem('daimond-cloud-agent-fetches');
		// The user is not subject to the agent's budget.
		return { before, after, refusal };
	});
	check('the agent has a download allowance', budget.before > 0, 'bytes=' + budget.before);
	check('and is refused once it is spent, told to come back through the user',
		budget.after === 0 && /past what may be downloaded automatically/.test(budget.refusal),
		String(budget.refusal).slice(0, 80));

	// ── Binary files travel, byte for byte ──
	// The workspace was text-only until now: anything binary was silently
	// skipped, so a picture stayed on the one device that made it. The pipeline
	// carries bytes end to end, so the test uses bytes that are NOT valid text —
	// every value 0-255, NULs included — and demands them back identically.
	const binary = await page.evaluate(async () => {
		const N = 700 * 1024;
		const src = new Uint8Array(N);
		for (let i = 0; i < N; i++) src[i] = (i * 7 + (i >> 8)) & 0xff;
		await window.DaimondCloud.writeBlob('media/pattern.bin', new Blob([src]));

		await window.DaimondSync.push();
		const m = window.DaimondCloud.manifest('media/pattern.bin');
		if (!m) return { offloaded: false };

		// Drop it locally and bring it back down from cloud storage.
		await window.DaimondCloud.evict('media/pattern.bin');
		const away = !!window.DaimondCloud.awayPaths()['media/pattern.bin'];
		const res  = await window.DaimondCloud.fetch('media/pattern.bin');

		const back = new Uint8Array(await (await window.DaimondCloud.fileAt('media/pattern.bin')).arrayBuffer());
		let same = back.length === src.length;
		if (same) for (let i = 0; i < src.length; i++) { if (back[i] !== src[i]) { same = false; break; } }
		return { offloaded: true, v: m.v, chunks: m.chunks.length, away, res, size: back.length, same };
	});
	check('a binary file is offloaded to cloud storage rather than skipped', binary.offloaded);
	check('it is sealed chunk by chunk, not as one whole-file blob', binary.v === 2,
		'v=' + binary.v + ' chunks=' + binary.chunks);
	check('it can be freed like any other file', binary.away);
	check('and comes back byte-for-byte identical, NULs and all',
		binary.same && binary.size === 700 * 1024, 'size=' + binary.size + ' identical=' + binary.same);

	// ── Only changed chunks are re-uploaded ──
	// A seal draws a fresh IV each time, so without the plaintext-chunk map an
	// edit to a large file would re-encrypt and re-send all of it.
	const partial = await page.evaluate(async () => {
		const before = window.DaimondCloud.manifest('media/pattern.bin');
		const src = new Uint8Array(await (await window.DaimondCloud.fileAt('media/pattern.bin')).arrayBuffer());
		src[src.length - 5] ^= 0xff;						// touch the LAST chunk only.
		await window.DaimondCloud.writeBlob('media/pattern.bin', new Blob([src]));
		await window.DaimondSync.push();
		const after = window.DaimondCloud.manifest('media/pattern.bin');
		let held = 0;
		for (let i = 0; i < Math.min(before.chunks.length, after.chunks.length); i++) {
			if (before.chunks[i].addr === after.chunks[i].addr) held++;
		}
		return { n: after.chunks.length, held, keyChanged: before.key !== after.key };
	});
	check('editing one chunk of a file leaves the others at their old addresses',
		partial.held === partial.n - 1 && partial.n > 1,
		'unchanged=' + partial.held + '/' + partial.n);
	check('and the file identity changes with the edit', partial.keyChanged);

	// ── The free tier must survive a lapse ──
	// At the end of grace the gateway evicts the paid tier and keeps the free
	// one. The client used to tag every chunk paid, which would have taken a
	// lapsed account's whole store instead of its overflow.
	const tiers = await page.evaluate(async () => {
		// Pretend the gateway granted a small allowance, enough for one file.
		window.DaimondCloud.setAllowance(250 * 1024);
		const ix = window.DaimondCloud.index();
		// Make one file plainly the most recently used.
		window.DaimondCloud.touch('papers/beta.txt');
		const plan = window.DaimondCloud.tierPlan(window.DaimondCloud.allowance());
        const free = Object.keys(plan).filter(k => plan[k] === 'f');
        const paid = Object.keys(plan).filter(k => plan[k] === 'p');
		return { free, paid, n: Object.keys(ix).length };
	});
	check('the most recently used file is tagged free, inside the allowance',
		tiers.free.includes('papers/beta.txt'), 'free=' + JSON.stringify(tiers.free));
	check('and the rest is paid overflow, so a lapse takes only the overflow',
		tiers.paid.length > 0 && tiers.free.length < tiers.n,
		'free=' + tiers.free.length + ' paid=' + tiers.paid.length);

	// ── An explicit delete DOES remove it ──
	const deleted = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const out = String(await app.run_tool('file_delete', JSON.stringify({ path: 'papers/alpha.txt' })));
		return { out, known: !!window.DaimondCloud.manifest('papers/alpha.txt') };
	});
	check('deleting an away file succeeds and forgets it', !deleted.known,
		deleted.out.slice(0, 80));
} catch (e) {
	check('no exception during the run', false, String(e && e.message || e));
} finally {
	try { await s.browser.close(); } catch (e) { /* ignore */ }
	if (gw) { try { gw.kill('SIGTERM'); } catch (e) { /* ignore */ } }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
