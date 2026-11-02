// gateway: live
// verify_commitmerged.mjs -- a device commits a chunk index only once it has merged the account's
// whole index at the version it commits at (lane CMG, specs/daimond_fixbrief_r53_commitmerged_20260927.md).
//
// THE FAULT (2026-09-13). argonaut, folder-mounted, had only ever merged its shared folder's paths
// out of the phone's index. It lost the folder's handle mid-turn, dropped to the browser sandbox,
// became a committer, offloaded its sandbox files and declared its own view as the account's live
// set at the current version: the gateway swept 611 of the phone's chunks and the phone lost 222
// files. FB3's reading (decision 4) is the same fault reached by the Browser chip: a folder device
// switched to the Browser commits before it has merged anything whole.
//
// Each arm is its own account on the gateway this world runs (fresh store per run). The phone is a
// stand-in: its parcels are sealed under the account's key and posted to the real mailbox, and its
// commit goes through the real chunk door, so argonaut's pulls, merges, pushes and commits are the
// page's own. Every commit the page makes is recorded from its request body.
//
//   L S A G and U2 RETIRED (D-20261031-11): each picked a machine folder, and the page mounts none now.
//   F  (QA82-ARM, U2's successor; `--arms=F`, run by verify_folderbehind) the upgrade of a former folder
//      desktop: its folder record seeded as an older build leaves it (the `daimond-fsa` handle database,
//      or the folder-ever mark), no folder mounted. It is not seeded and waits for a whole parcel;
//      then it commits naming the phone's chunks, and the gateway keeps them all.
//   U  the upgrade: a device with no mark (the first load of this build) that synced before in
//      the sandbox is seeded and commits.
//   K  the phone asleep (lane CMG2): argonaut in a folder pushes twice while the phone sleeps. K1:
//      the versions it skipped are all argonaut's own, so it is still whole and still commits.
//      K2: a third device's version is among them, merged by argonaut in its folder: no commit
//      without that device's chunks.
//   E  (inside K) QCMG2's E1: a phone that may not commit does not free its only copy of an upload
//      (nothing the gateway keeps names it); a whole one does.
//   T  two tabs of one device (lane CMG2, QCMG's S6): a tab that pushes over a foreign version its
//      sibling took says so in its `chunkedFrom`, rather than vouching for it as its own.
//   R  a rollback and re-upgrade (lane CMG3b, QCMG3b's R): the build before wrote the cursor bare over this
//      build's mark and records; loading this build again seeds the device and it sends chunkedOld.
//   M  mixed versions (lane CMG2; `--arms=M` with CMG_OLD_APP, the 5.2.1 page's origin on the same
//      gateway): a 5.2.1 page and this page on one account, either one first (M2: the old page's
//      files already in the mailbox; this page waits while new, and is re-seeded after a reload).
import fs from 'node:fs';
import { open, scratch, signInAs, APP } from './harness.mjs';
import { makePagePro, GW_URL } from './pro.mjs';
import { GWDIR } from './gwbin.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLY = (process.argv.find((a) => a.startsWith('--arms=')) || '--arms=UKTR').slice(7);

/// The instruments, installed in the page (again after a reload: arm F): every commit the page makes,
/// recorded from its request body, and the stand-in devices.
const instrument = () => {
	window.__commits = [];
	const real = window.fetch;
	window.fetch = async function (u, o) {
		const r = await real.apply(this, arguments);
		try {
			const url = String(u && u.url || u);
			if (/\/api\/chunk/.test(url) && o && typeof o.body === 'string' && /"op":"commit"/.test(o.body)) {
				const b = JSON.parse(o.body), j = await r.clone().json().catch(() => ({}));
				window.__commits.push({ at: b.blob_version, addrs: (b.chunks || []).map((c) => c.addr),
					token: !!b.sweep_token, swept: j.swept, held: j.sweep_held_back || 0, phone: !!window.__asPhone });
			}
		} catch (e) { /* the instrument never breaks a request */ }
		return r;
	};
	// The phone, standing in: its chunks through the real door, its parcel sealed under this
	// account's key onto the real mailbox, its commit under its own name.
	const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
	window.__phone = { id: hex(16), ix: {} };
	window.__phoneFiles = async function (n, tag) {
		for (let i = 0; i < n; i++) {
			const bytes = new TextEncoder().encode(tag + ' ' + i + ' ' + hex(64) + '\n'.repeat(3000));
			const m = await DaimondChunks.offloadBytes('phone/' + tag + i + '.bin', bytes);
			__phone.ix['phone/' + tag + i + '.bin'] = { v: m.v, size: m.size, bytes: m.size, mtime: 0,
				hash: m.key, key: m.key, chunks: m.chunks, at: 0 };
		}
		return Object.values(__phone.ix).flatMap((m) => m.chunks.map((c) => c.addr));
	};
	// `x-cmg-standin` lets a stand-in's call through while the page's own sync is held (arm K).
	async function mailbox(method, body) {
		const r = await DaimondGateway.gwFetch('/api/sync', { method, credentials: 'same-origin',
			headers: { 'x-daimond-api': String(DaimondGateway.clientApi()), 'content-type': 'application/json',
				'x-cmg-standin': '1' },
			body: body ? JSON.stringify(body) : undefined });
		return { status: r.status, json: await r.json().catch(() => null) };
	}
	// Other devices standing in (arm K): each its own files, parcel and commit. `from` is the
	// parcel's `chunkedFrom` as a 5.3 page sends it: the last version its writer took from
	// another device, so every version after it up to this parcel is the writer's own.
	window.__ix = {};
	window.__standFiles = async function (who, n, tag) {
		const ix = (__ix[who] = __ix[who] || {});
		const out = [];
		for (let i = 0; i < n; i++) {
			const bytes = new TextEncoder().encode(who + tag + ' ' + i + ' ' + hex(64) + '\n'.repeat(3000));
			const m = await DaimondChunks.offloadBytes(who + '/' + tag + i + '.bin', bytes);
			ix[who + '/' + tag + i + '.bin'] = { v: m.v, size: m.size, bytes: m.size, mtime: 0,
				hash: m.key, key: m.key, chunks: m.chunks, at: 0 };
			m.chunks.forEach((c) => out.push(c.addr));
		}
		return out;
	};
	// `o.theirs`: the writer merged the page's index whole (a sandbox device), so its parcel and
	// commit carry the page's own files too, as a real whole device's would.
	window.__standPush = async function (who, o) {
		const ix = Object.assign({}, __ix[who] || {});
		if (o.theirs) {
			const t = DaimondCloud.index();
			Object.keys(t).forEach((k) => { if (!/^@/.test(k) && !t[k].peer && !ix[k]) ix[k] = t[k]; });
		}
		for (let i = 0; i < 12; i++) {
			const g = await mailbox('GET');
			const base = (g.json && g.json.version) | 0;
			const parcel = { v: 3, chats: [], tombs: {}, msgTombs: {}, files: {}, filesComplete: false,
				fileTombs: {}, chunked: ix, chunkedTombs: {}, diamonds: [], diamondsComplete: false, diamondTombs: {},
				chunkedFull: !!o.full };
			if (o.from !== undefined) parcel.chunkedFrom = (o.from === 'base') ? base : o.from;
			const blob = await DaimondIdentity.wrap(JSON.stringify(parcel));
			const r = await mailbox('POST', { base_version: base, device: who, blob });
			if (r.status === 200 && r.json && r.json.ok) {
				if (o.commit) {
					window.__asPhone = true;
					try { await DaimondChunks.commit(ix, r.json.version | 0, null); }
					finally { window.__asPhone = false; }
				}
				return r.json.version | 0;
			}
			await new Promise((q) => setTimeout(q, 300));
		}
		return -1;
	};
	// A whole device's parcel: its own files, and (as a whole device would after merging
	// argonaut's) argonaut's own file manifests. `full` is what a 5.3 page sends.
	window.__phonePush = async function (withTheirs, full) {
		const ix = Object.assign({}, __phone.ix);
		if (withTheirs) {
			const theirs = DaimondCloud.index();
			Object.keys(theirs).forEach((k) => { if (!/^@/.test(k) && !theirs[k].peer && !ix[k]) ix[k] = theirs[k]; });
		}
		const parcel = { v: 3, chats: [], tombs: {}, msgTombs: {}, files: {}, filesComplete: false,
			fileTombs: {}, chunked: ix, chunkedTombs: {}, diamonds: [], diamondsComplete: false, diamondTombs: {} };
		if (full) parcel.chunkedFull = true;
		const blob = await DaimondIdentity.wrap(JSON.stringify(parcel));
		for (let i = 0; i < 12; i++) {
			const g = await mailbox('GET');
			const base = (g.json && g.json.version) | 0;
			const r = await mailbox('POST', { base_version: base, device: 'phone', blob });
			if (r.status === 200 && r.json && r.json.ok) {
				window.__asPhone = true;
				try { await DaimondChunks.commit(ix, r.json.version | 0, null); }
				finally { window.__asPhone = false; }
				return r.json.version | 0;
			}
			await new Promise((q) => setTimeout(q, 300));
		}
		return -1;
	};
};

/// Bring a page up signed in, with Pro (the chunk store accepts uploads) and the instruments.
/// `o.app` serves it from another build's origin (arm M: a 5.2.1 page); `o.pairWith` makes it a
/// second device of that page's account rather than an account of its own.
async function device(name, o = {}) {
	const profile = scratch('pw', 'cmg-' + name);
	fs.rmSync(profile, { recursive: true, force: true });
	const own = !o.app && !o.pairWith;
	const s = await open({ name: 'cmg-' + name, profile, signIn: own, connect: false });
	const p = s.page;
	if (o.app) await p.goto(o.app, { waitUntil: 'domcontentloaded' });
	if (o.pairWith) {
		await p.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 });
		const code = await o.pairWith.page.evaluate(() => DaimondPairing.create());
		await p.evaluate((c) => DaimondPairing.redeem(c), code.code);
		await p.reload({ waitUntil: 'domcontentloaded' });
	}
	if (!own) await signInAs(s, o.pairWith ? o.pairWith.name : s.name);
	await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondSync && window.DaimondChunks
		&& window.DaimondCloud && window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: 30000 });
	if (!o.pairWith) {
		const lic = await makePagePro(p, GWDIR, GW_URL);
		if (!lic.pro) throw new Error('no Pro for ' + name + ': ' + JSON.stringify(lic));
	}
	await p.evaluate(instrument);
	return s;
}

/// Wait for the page's sync to be at rest: nothing in flight or armed, twice running.
async function quiet(p, ms = 30000) {
	const until = Date.now() + ms;
	let calm = 0;
	while (Date.now() < until) {
		const q = await p.evaluate(() => { try { return DaimondSync.state().quiet; } catch (e) { return false; } });
		calm = q ? calm + 1 : 0;
		if (calm >= 3) return true;
		await sleep(400);
	}
	return false;
}
/// One round the way the app runs one: a pull, then a push that lands (and commits, if it may).
async function round(p) {
	await quiet(p, 15000);
	await p.evaluate(() => DaimondSync.pull());
	await p.evaluate(() => DaimondSync.flush());
	await quiet(p, 20000);
}
const commits = (p) => p.evaluate(() => window.__commits.filter((c) => !c.phone));
const names = (c, addrs) => addrs.every((a) => c.addrs.includes(a));
const why = (p) => p.evaluate(() => DaimondCore.syncCommitBlockedReason ? DaimondCore.syncCommitBlockedReason() : '?');

/// Files over the inline ceiling in the browser sandbox, which offload on the next collect.
const sandboxFiles = (p, tag, n) => p.evaluate(async ({ tag, n }) => {
	for (let i = 0; i < n; i++) await DaimondCloud.writeText('argo/' + tag + i + '.txt', (tag + i + ' ').repeat(60000));
}, { tag, n });

/// The mailbox as a build before this one leaves it: its head parcel reposted with no `chunkedFull` or
/// `chunkedFrom` (an old page sends neither), so no device can learn wholeness from its own last push.
const asOldPage = (p) => p.evaluate(async () => {
	const call = async (method, body) => {
		const r = await DaimondGateway.gwFetch('/api/sync', { method, credentials: 'same-origin',
			headers: { 'x-daimond-api': String(DaimondGateway.clientApi()), 'content-type': 'application/json', 'x-cmg-standin': '1' },
			body: body ? JSON.stringify(body) : undefined });
		return r.json().catch(() => null);
	};
	const g = await call('GET');
	const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
	const had = st.chunkedFull;
	delete st.chunkedFull;
	delete st.chunkedFrom;
	const r = await call('POST', { base_version: g.version | 0, device: 'old page', blob: await DaimondIdentity.wrap(JSON.stringify(st)) });
	return { had, ok: !!(r && r.ok), v: r && r.version };
});

async function armUpgrade() {
	console.log('\n── U: the first load of this build (no mark) ──');
	{
		const tag = 'U1';
		const s = await device(tag.toLowerCase());
		const p = s.page;
		try {
			await sandboxFiles(p, tag.toLowerCase(), 1);
			await round(p);
			// The mailbox as a build before this one leaves it: this device's own parcel, with no
			// `chunkedFull` or `chunkedFrom` (an old page sends neither).
			const stripped = await asOldPage(p);
			await quiet(p, 15000);
			// And the mark as that build leaves it: none, and never written.
			await p.evaluate(async () => {
				await DaimondDurable.del('daimond-cloud-merged');
				localStorage.removeItem('daimond-cloud-merged');
				localStorage.removeItem('daimond-cloud-merged-seen');
			});
			await p.reload({ waitUntil: 'domcontentloaded' });
			await signInAs(s, s.name);
			await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondSync && window.DaimondGateway
				&& DaimondGateway.state().authed), null, { timeout: 30000 });
			await p.evaluate(() => { window.__commits = []; const real = window.fetch; window.fetch = async function (u, o) {
				const r = await real.apply(this, arguments);
				try { if (/\/api\/chunk/.test(String(u && u.url || u)) && o && /"op":"commit"/.test(String(o.body))) window.__commits.push({ at: 0, addrs: [] }); } catch (e) {}
				return r; }; });
			const had = await p.evaluate(() => DaimondCloud.wholeAt ? DaimondCloud.wholeAt() : 'no mark here');
			await sandboxFiles(p, tag.toLowerCase() + 'x', 1);
			await round(p);
			const c = await commits(p);
			const w = await why(p);
			console.log(`  note ${tag}: the old page's parcel v${stripped.v} (flag was ${stripped.had}, now none), mark at load=${had}, commits=${c.length}, blocked=${w || 'none'}`);
			check('U1: a sandbox device that synced before is seeded, and commits', c.length > 0, 'commits ' + c.length);
		} finally { await s.close(); }
	}
}

/// Arm F: the upgrade of a former folder desktop (argonaut on 09-13), with no folder feature to pick one.
/// The record of the folder behind this device is seeded the way an older build leaves it: `fsa`, the
/// account's `daimond-fsa` handle database holding a handle row (what every desktop that last opened a
/// folder under a build before R1 carries; boot retires it into the history); `ever`, the
/// `daimond-sync-folder-ever` mark a 5.2.2+ folder collect wrote. Either way the first load of this
/// build must not seed the device as a committer: no commit until a whole parcel is merged, and then
/// one that names the phone's chunks, all of which the gateway still holds.
async function armFolderBehind() {
	console.log('\n── F: the first load of this build on a device with a machine folder behind it ──');
	for (const how of ['fsa', 'ever']) {
		const tag = 'F-' + how;
		const s = await device('f' + how);
		const p = s.page;
		try {
			await sandboxFiles(p, 'f' + how, 1);
			await round(p);
			// The phone, as an old page: its files, its parcel with neither flag, its commit.
			const phone = await p.evaluate(() => __phoneFiles(4, 'p'));
			const v1 = await p.evaluate(() => __phonePush(false, false));
			check(`${tag}: the phone's parcel and commit landed`, v1 > 0, 'v' + v1 + ', ' + phone.length + ' chunks');
			await round(p);
			const phoneIx = await p.evaluate(() => __phone.ix);
			// The build before is the last writer: this page's own sync is held from here until the
			// reload has replaced it, or it would push a `chunkedFull` parcel over the old page's (or
			// merge it and write the mark back) and the load would be whole by right.
			let holding = true;
			const hold = (route) => (holding && !route.request().headers()['x-cmg-standin'] ? route.abort() : route.continue());
			await p.route('**/api/sync**', hold);
			const stripped = await asOldPage(p);
			// The record of the folder behind it, as the build before leaves it; and no mark, as U1.
			const seeded = await p.evaluate(async (how) => {
				if (how === 'ever') localStorage.setItem('daimond-sync-folder-ever', '1');
				else {
					const ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) ? '-' + DaimondAccounts.opfsNs() : '';
					await new Promise((res, rej) => {
						const q = indexedDB.open('daimond-fsa' + ns, 1);
						q.onupgradeneeded = () => q.result.createObjectStore('handles');
						q.onerror = () => rej(q.error);
						q.onsuccess = () => {
							const db = q.result, tx = db.transaction('handles', 'readwrite');
							tx.objectStore('handles').put({ kind: 'directory', name: 'argonaut' }, 'sandbox');
							tx.oncomplete = () => { db.close(); res(); };
							tx.onerror = () => rej(tx.error);
						};
					});
				}
				await DaimondDurable.del('daimond-cloud-merged');
				localStorage.removeItem('daimond-cloud-merged');
				localStorage.removeItem('daimond-cloud-merged-seen');
				return { ever: localStorage.getItem('daimond-sync-folder-ever'),
					dbs: ((await indexedDB.databases()) || []).map((d) => d.name).filter((n) => /^daimond-(fsa|folders)/.test(n)) };
			}, how);
			check(`${tag}: [ctl] the record is seeded`, how === 'ever' ? seeded.ever === '1' : seeded.dbs.length === 1, JSON.stringify(seeded));
			await p.reload({ waitUntil: 'domcontentloaded' });
			holding = false;
			await p.unroute('**/api/sync**', hold);
			await signInAs(s, s.name);
			await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondSync && window.DaimondChunks
				&& window.DaimondCloud && window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: 30000 });
			await p.evaluate(instrument);
			await p.evaluate((ix) => { __phone.ix = ix; }, phoneIx);
			// Who moves the mark after the load, for the note when it is seeded.
			await p.evaluate(() => { window.__marks = []; const real = DaimondCloud.noteWhole;
				DaimondCloud.noteWhole = function (v) { window.__marks.push(v + '@' + DaimondSync.version() + ' ' + String(new Error().stack).split('\n').slice(2, 4).map((l) => l.trim().replace(/^at /, '').replace(/\(.*\/([^/]+)\)$/, '($1)')).join(' < ')); return real.apply(this, arguments); }; });
			const had = await p.evaluate(() => DaimondCloud.wholeAt ? DaimondCloud.wholeAt() : 'no mark here');
			await sandboxFiles(p, 'f' + how + 'x', 1);
			await round(p);
			const c = await commits(p);
			const w = await why(p);
			const left = await p.evaluate(async () => ({ ever: localStorage.getItem('daimond-sync-folder-ever'),
				dbs: ((await indexedDB.databases()) || []).map((d) => d.name).filter((n) => /^daimond-(fsa|folders)/.test(n)) }));
			console.log(`  note ${tag}: the old page's parcel v${stripped.v} (flag was ${stripped.had}), mark at load=${had}, after: ever=${left.ever} dbs=${JSON.stringify(left.dbs)}, commits=${c.length}, blocked=${w || 'none'}`);
			if (c.length) console.log(`  note ${tag}: marks after the load: ` + JSON.stringify(await p.evaluate(() => window.__marks)));
			check(`${tag}: a device with a machine folder behind it is not seeded, and waits`, c.length === 0 && w === 'index-not-merged',
				'commits ' + c.length + ', blocked=' + (w || 'none'));
			// The phone pushes a whole parcel: merged whole in the sandbox, it makes this device whole.
			const v2 = await p.evaluate(() => __phonePush(true, true));
			await round(p);
			await round(p);
			const later = await commits(p);
			console.log(`  note ${tag} after the phone's v${v2}: ` + later.map((x) => 'v' + x.at + ':' + x.addrs.length
				+ (names(x, phone) ? '+phone' : '-phone')).join(', ') + ' | blocked=' + (await why(p) || 'none'));
			check(`${tag}: after a whole parcel it commits, naming the phone's chunks`,
				later.length > 0 && later.every((x) => names(x, phone)), later.length + ' commits');
			const gone = await p.evaluate(async (a) => { const r = await DaimondChunks.presence(a); return r && r.ok ? r.missing.length : -1; }, phone);
			check(`${tag}: the gateway still holds every one of the phone's chunks`, gone === 0, gone + ' of ' + phone.length + ' missing');
		} finally { await s.close(); }
	}
}

/// The page's own sync held, as a phone asleep: its reads and pushes of the mailbox wait until
/// it wakes, and then go out as they were. A stand-in's calls (`x-cmg-standin`) pass.
async function asleep(s, on) {
	const p = s.page;
	if (on) {
		s.held = [];
		s.sleeper = (route) => (route.request().headers()['x-cmg-standin'] ? route.continue() : s.held.push(route));
		await p.route('**/api/sync**', s.sleeper);
		return;
	}
	await p.unroute('**/api/sync**', s.sleeper);
	for (const r of s.held.splice(0)) await r.continue().catch(() => {});
}

/// K: THE PHONE ASLEEP. The owner's account is a phone in the browser sandbox and argonaut in a
/// machine folder, whose parcels are never whole (it merges only its shares), and a phone is
/// asleep most of the time. While it sleeps argonaut pushes more than once, so the phone wakes to
/// a version it did not stand at the one before. K1: argonaut's run of its own pushes since the
/// phone's version: the phone, whole at that version, is whole after merging the last, and goes on
/// committing (the rule before this build committed there, so not doing so would leave the
/// phone's new uploads declared by nobody). K2: a third device Q pushed in between and argonaut
/// merged it in its folder, leaving Q's files out: the phone must not commit a live set without
/// Q's chunks.
/// R: A ROLLBACK AND RE-UPGRADE (QCMG3b's R). A sandbox device of this build, whole, sleeps while another
/// page on this build pushes twice, neither whole and each just after a foreign take, so its mark cannot
/// chain across them. Then the build before runs on it: it writes the cursor bare and knows nothing of the
/// mark or `daimond-sync-old`, which stay as this build left them. Loading this build again is an upgrade
/// whatever mark is left: the device is seeded and commits, and sends that cursor as `chunkedOld`.
/// Red on `16c1c37f`, which read "the build before wrote it" from a record that survives the rollback.
async function armRollback() {
	console.log('\n── R: a rollback to the build before, and back ──');
	const s = await device('r1');
	const p = s.page;
	const head = () => p.evaluate(async () => {
		const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
			headers: { 'x-daimond-api': String(DaimondGateway.clientApi()), 'x-cmg-standin': '1' } });
		const g = await r.json();
		const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
		return { v: g.version | 0, from: st.chunkedFrom, old: st.chunkedOld, full: st.chunkedFull };
	});
	try {
		await sandboxFiles(p, 'r1a', 1);
		await round(p);
		const m = await p.evaluate(() => DaimondCloud.wholeAt());
		await asleep(s, true);
		for (let i = 0; i < 2; i++) await p.evaluate(async () => {
			const call = async (method, body) => {
				const r = await DaimondGateway.gwFetch('/api/sync', { method, credentials: 'same-origin',
					headers: { 'x-daimond-api': String(DaimondGateway.clientApi()), 'content-type': 'application/json', 'x-cmg-standin': '1' },
					body: body ? JSON.stringify(body) : undefined });
				return r.json().catch(() => null);
			};
			const g = await call('GET');
			const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
			st.chunkedFull = false; st.chunkedFrom = (g.version | 0) + 1; delete st.chunkedOld;
			await call('POST', { base_version: g.version | 0, device: 'argonaut', blob: await DaimondIdentity.wrap(JSON.stringify(st)) });
		});
		await asleep(s, false);
		await round(p);
		const mid = { at: await p.evaluate(() => DaimondCloud.wholeAt()), v: await p.evaluate(() => DaimondSync.version()), why: await why(p) };
		check('R: [ctl] asleep through two pushes it cannot chain across, the device is not whole', mid.at === m && mid.why === 'index-not-merged',
			'whole at ' + m + ' before; ' + JSON.stringify(mid));
		// The build before ran here: the cursor bare, the mark and daimond-sync-old left as they were.
		const cur = await p.evaluate(() => { const c = DaimondSync.version(); localStorage.setItem('daimond-sync-version', String(c)); return c; });
		await p.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(s, s.name);
		await p.waitForFunction(() => !!(window.DaimondCore && window.DaimondSync && window.DaimondGateway
			&& DaimondGateway.state().authed), null, { timeout: 30000 });
		await p.evaluate(() => { window.__commits = []; const real = window.fetch; window.fetch = async function (u, o) {
			const r = await real.apply(this, arguments);
			try { if (/\/api\/chunk/.test(String(u && u.url || u)) && o && /"op":"commit"/.test(String(o.body))) window.__commits.push({ at: 0, addrs: [] }); } catch (e) {}
			return r; }; });
		const at0 = await p.evaluate(() => DaimondCloud.wholeAt());
		await sandboxFiles(p, 'r1b', 1);
		await round(p);
		const c = await commits(p), w = await why(p), h = await head();
		console.log(`  note R: loaded this build at the bare cursor ${cur} with mark ${at0}; ${c.length} commits, blocked=${w || 'none'}; head v${h.v} chunkedOld=${h.old} chunkedFrom=${h.from} chunkedFull=${h.full}`);
		check('R: loading this build over the build before\'s cursor is an upgrade: seeded, it commits', c.length > 0 && !w,
			c.length + ' commits, blocked=' + (w || 'none') + ', mark ' + at0 + ' at load');
		check('R: and it sends that cursor as chunkedOld', h.old === cur && h.from === cur, 'chunkedOld=' + h.old + ', chunkedFrom=' + h.from + ', cursor ' + cur);
	} finally { await s.close(); }
}

async function armAsleep() {
	console.log('\n── K: the phone asleep while argonaut, in a folder, pushes ──');
	for (const third of [false, true]) {
		const tag = third ? 'K2' : 'K1';
		const s = await device(tag.toLowerCase());
		const p = s.page;
		try {
			await sandboxFiles(p, tag.toLowerCase(), 1);
			await round(p);
			const c0 = await commits(p);
			check(`${tag}: the phone, whole, commits`, c0.length > 0, c0.length + ' commits, blocked=' + (await why(p) || 'none'));
			const at = await p.evaluate(() => DaimondSync.version());
			await asleep(s, true);
			let q = [], vq = -1;
			if (third) {
				// Q, whole (a 5.3 sandbox device), merged the phone's version and pushes its own file.
				q  = await p.evaluate(() => __standFiles('q', 1, 'q'));
				vq = await p.evaluate((from) => __standPush('q', { full: true, from, commit: true, theirs: true }), at);
			}
			// argonaut, in its folder: its own file, twice, over the phone's version (or Q's, which it
			// merged in the folder: Q's file is outside its share, so its parcel leaves it out).
			const from = third ? vq : at;
			const argo = await p.evaluate(() => __standFiles('argo', 1, 'a'));
			const va = await p.evaluate((f) => __standPush('argo', { full: false, from: f }), from);
			await p.evaluate(() => __standFiles('argo', 1, 'b'));
			const vb = await p.evaluate((f) => __standPush('argo', { full: false, from: f }), from);
			await asleep(s, false);
			console.log(`  note ${tag}: the phone slept at v${at}; ${third ? 'Q v' + vq + ', ' : ''}argonaut v${va}, v${vb}`);
			await round(p);
			const n1 = (await commits(p)).length;
			await sandboxFiles(p, tag.toLowerCase() + 'x', 1);		// the phone's new upload
			await round(p);
			const later = (await commits(p)).slice(n1);
			const w = await why(p);
			console.log(`  note ${tag}: after waking at v${await p.evaluate(() => DaimondSync.version())}: `
				+ later.map((c) => 'v' + c.at + ':' + c.addrs.length + (names(c, argo) ? '+argo' : '-argo')
				+ (third ? (names(c, q) ? '+q' : '-q') : '') + (c.swept ? ' swept ' + c.swept : '') + (c.held ? ' held ' + c.held : '')).join(', ')
				+ ' | blocked=' + (w || 'none') + ', whole at ' + await p.evaluate(() => DaimondCloud.wholeAt ? DaimondCloud.wholeAt() : 'n/a'));
			// E (QCMG2's E1): freeing the phone's only copy of its upload, whole or not.
			const fx = 'argo/' + tag.toLowerCase() + 'x0.txt';
			const ev = await p.evaluate((f) => DaimondCloud.evict(f), fx);
			// The refusal in the table's words (`files.free_undeclared`), never the bare key.
			const want = await p.evaluate(() => 'Error: ' + DaimondI18n.t('files.free_undeclared'));
			const kept = await p.evaluate((f) => DaimondCloud.isHeld(f), fx);
			const rc = await p.evaluate(() => DaimondCloud.reclaim(true));
			console.log(`  note ${tag}: evict ${fx}: ${String(ev).slice(0, 110)}; held after: ${kept}; reclaim: ${JSON.stringify(rc)}`);
			if (!third) {
				check('K1: woken past argonaut\'s own run of pushes, the phone still commits', later.length > 0,
					later.length + ' commits, blocked=' + (w || 'none'));
				check('K1: and its commits name argonaut\'s chunks', later.every((c) => names(c, argo)), later.length + ' commits');
				check('E: [ctl] a whole phone frees a committed file\'s copy', /^OK: freed/.test(String(ev)) && kept === false, String(ev).slice(0, 80));
			} else {
				check('E: a phone that may not commit keeps its copy, and says why', String(ev) === want && !/files\.free_undeclared/.test(want) && kept === true,
					String(ev).slice(0, 110));
				check('E: and "Free up space" frees nothing, for that reason', rc.evicted.length === 0 && rc.why === 'undeclared', JSON.stringify(rc));
				const blind = later.filter((c) => !names(c, q));
				check('K2: no commit declares a live set without Q\'s chunks', blind.length === 0,
					blind.length + ' of ' + later.length + ' commits left them out');
				const gone = await p.evaluate(async (a) => { const r = await DaimondChunks.presence(a); return r && r.ok ? r.missing.length : -1; }, q);
				check('K2: the gateway still holds Q\'s chunks', gone === 0, gone + ' of ' + q.length + ' missing');
			}
		} finally { await s.close(); }
	}
}

/// The chunk addresses of this page's own files under `argo/<tag>`, as its index names them.
const ownAddrs = (p, tag) => p.evaluate((t) => {
	const ix = DaimondCloud.index();
	return Object.keys(ix).filter((k) => k.indexOf('argo/' + t) === 0 && !ix[k].peer)
		.flatMap((k) => (ix[k].chunks || []).map((c) => c.addr));
}, tag);
const held = (p, addrs) => p.evaluate(async (a) => { const r = await DaimondChunks.presence(a); return r && r.ok ? r.missing.length : -1; }, addrs);

/// M: A 5.2.1 PAGE AND THIS PAGE ON ONE ACCOUNT (`CMG_OLD_APP`, the old build's origin on the same
/// gateway). The old page sends no `chunkedFull` or `chunkedFrom` and commits by the rule before
/// this one. M1: this page starts the account (whole from the empty mailbox), the old page is paired
/// and pushes; this page chains over its parcel and commits naming its chunks, and after sleeping
/// through two of its pushes it waits, while the old page's own commits name this page's uploads. (This
/// page was new to the account when it loaded, so the transition rule, which re-seeds a device that
/// stands on an old page's parcel, does not take it; QCMG's cmgqa_attack G3 is that rule's arm.)
/// M2: the old page starts the account and pushes its files, and then this page is paired (the
/// pairing reloads it before its first sync). New to the account on this load, it waits, and the old
/// page's commits cover it. After a reload it is one of the account's devices, and standing on the old
/// page's parcel in the sandbox the transition rule re-seeds it (G1n): it commits, naming the old
/// page's chunks. (Until 16c1c37f this arm paired first: the old page had pushed nothing, so this
/// page met an empty mailbox, was whole by that, and ran M1's chain instead.)
async function armMixed() {
	const OLD = process.env.CMG_OLD_APP;
	console.log('\n── M: a 5.2.1 page and this page on one account ──');
	if (!OLD) { console.log('  note M: skipped, CMG_OLD_APP (the old page\'s origin) is not set'); return; }
	for (const oldFirst of [false, true]) {
		const tag = oldFirst ? 'M2' : 'M1', t = tag.toLowerCase();
		let n = null, o = null;
		try {
			if (oldFirst) {
				// The mailbox has held only the old page's parcels, its files in them, when this page joins.
				o = await device(t + 'o', { app: OLD });
				await round(o.page);
				await sandboxFiles(o.page, t + 'o', 2);
				await round(o.page);
				n = await device(t + 'n', { pairWith: o });
			}
			else { n = await device(t + 'n'); o = await device(t + 'o', { app: OLD, pairWith: n }); }
			const build = await o.page.evaluate(() => typeof DaimondCloud.wholeAt);
			console.log(`  note ${tag}: the old page's cloud.js ${build === 'undefined' ? 'has no mark (5.2.1)' : 'HAS a mark: not an old page'}`);
			await round(n.page); await round(o.page); await round(n.page);
			await sandboxFiles(o.page, t + 'o', 2);
			await round(o.page);
			const oa = await ownAddrs(o.page, t + 'o');
			const n0 = (await commits(n.page)).length;
			await round(n.page);
			await sandboxFiles(n.page, t + 'n', 1);
			await round(n.page);
			const na = await ownAddrs(n.page, t + 'n');
			const nc = (await commits(n.page)).slice(n0);
			const nw = await why(n.page);
			console.log(`  note ${tag}: this page's commits after the old page's parcel: ` + nc.map((c) => 'v' + c.at + ':'
				+ c.addrs.length + (names(c, oa) ? '+old' : '-old')).join(', ') + ' | blocked=' + (nw || 'none')
				+ ', whole at ' + await n.page.evaluate(() => DaimondCloud.wholeAt()) + ' v' + await n.page.evaluate(() => DaimondSync.version()));
			check(`${tag}: no commit of this page leaves out the old page's chunks`, nc.every((c) => names(c, oa)), nc.length + ' commits');
			if (!oldFirst) check('M1: this page chains over the old page\'s flagless parcel and commits', nc.length > 0, 'blocked=' + (nw || 'none'));
			else check('M2: this page, new to an account only an old page has written, waits', nc.length === 0 && nw === 'index-not-merged', 'blocked=' + (nw || 'none'));
			if (!oldFirst) {
				// This page asleep while the old page pushes twice: a flagless parcel forgives no skip.
				await asleep(n, true);
				await sandboxFiles(o.page, t + 'p', 1); await round(o.page);
				await sandboxFiles(o.page, t + 'q', 1); await round(o.page);
				await asleep(n, false);
				const n1 = (await commits(n.page)).length;
				await round(n.page);
				await sandboxFiles(n.page, t + 'r', 1);
				await round(n.page);
				const nc2 = (await commits(n.page)).slice(n1), nw2 = await why(n.page);
				const oa2 = [...oa, ...await ownAddrs(o.page, t + 'p'), ...await ownAddrs(o.page, t + 'q')];
				console.log(`  note M1: after sleeping through two of the old page's pushes: ${nc2.length} commits, blocked=${nw2 || 'none'}`);
				check('M1: and no commit of this page after that sleep leaves out the old page\'s chunks', nc2.every((c) => names(c, oa2)), nc2.length + ' commits');
			}
			// The old page, by its own rule, commits this page's uploads once it has merged them.
			const o0 = (await commits(o.page)).length;
			await round(o.page);
			await sandboxFiles(o.page, t + 's', 1);
			await round(o.page);
			const na2 = [...na, ...(oldFirst ? [] : await ownAddrs(n.page, t + 'r'))];
			const oc = (await commits(o.page)).slice(o0);
			console.log(`  note ${tag}: the old page's commits: ` + oc.map((c) => 'v' + c.at + ':' + c.addrs.length
				+ (names(c, na2) ? '+new' : '-new') + (c.swept ? ' swept ' + c.swept : '') + (c.held ? ' held ' + c.held : '')).join(', '));
			check(`${tag}: the old page commits by its own rule, naming this page's uploads`, oc.length > 0 && oc.every((c) => names(c, na2)), oc.length + ' commits');
			const gone = (await held(n.page, oa)) + (await held(n.page, na2));
			check(`${tag}: the gateway holds every chunk either page uploaded`, gone === 0, gone + ' missing');
			if (oldFirst) {
				// A reload makes it one of the account's devices; the head is the old page's parcel.
				await n.page.reload({ waitUntil: 'domcontentloaded' });
				await signInAs(n, o.name);
				await n.page.waitForFunction(() => !!(window.DaimondCore && window.DaimondSync && window.DaimondCloud
					&& window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: 30000 });
				await n.page.evaluate(() => { window.__commits = []; const real = window.fetch; window.fetch = async function (u, o) {
					const r = await real.apply(this, arguments);
					try {
						if (/\/api\/chunk/.test(String(u && u.url || u)) && o && typeof o.body === 'string' && /"op":"commit"/.test(o.body)) {
							const b = JSON.parse(o.body);
							window.__commits.push({ at: b.blob_version, addrs: (b.chunks || []).map((c) => c.addr) });
						}
					} catch (e) { /* the instrument never breaks a request */ }
					return r; }; });
				await round(n.page);
				await sandboxFiles(n.page, t + 'r', 1);
				await round(n.page);
				const oa3 = [...oa, ...await ownAddrs(o.page, t + 's')];
				const nc3 = await commits(n.page), nw3 = await why(n.page);
				console.log(`  note M2: after its reload: ` + nc3.map((c) => 'v' + c.at + ':' + c.addrs.length + (names(c, oa3) ? '+old' : '-old')).join(', ')
					+ ' | blocked=' + (nw3 || 'none') + ', whole at ' + await n.page.evaluate(() => DaimondCloud.wholeAt()));
				check('M2: after a reload, one of the account\'s devices on the old page\'s parcel is re-seeded and commits', nc3.length > 0 && !nw3,
					nc3.length + ' commits, blocked=' + (nw3 || 'none'));
				check('M2: and every commit names the old page\'s chunks', nc3.every((c) => names(c, oa3)), nc3.length + ' commits');
			}
		} finally {
			if (n) await n.close();
			if (o) await o.close();
		}
	}
}

/// T: TWO TABS OF ONE DEVICE (QCMG's S6). `chunkedFrom` says "every version after this one is this
/// device's own push", and a sibling tab's parcel is this device's own. So a version the sibling took
/// from another device must travel to this tab with the sibling's parcel: a tab asleep while its
/// sibling took q's version, then waking onto the sibling's push, may not say it took nothing
/// foreign since before q. Red before: its parcel said `chunkedFrom` below q's version, so a phone
/// whole there would count q's version as vouched for (in a folder, the sibling's merge of q is by
/// its share, and the phone's commit then leaves q's files out).
async function armTabs() {
	console.log('\n── T: two tabs of one device, one asleep while the other takes a foreign version ──');
	const s = await device('t');
	const p = s.page;
	let p2 = null;
	try {
		await sandboxFiles(p, 't', 1);
		await round(p);
		p2 = await p.context().newPage();
		await p2.goto(APP, { waitUntil: 'domcontentloaded' });
		await signInAs({ page: p2, name: s.name }, s.name);
		await p2.waitForFunction(() => !!(window.DaimondSync && window.DaimondCloud && window.DaimondGateway
			&& DaimondGateway.state().authed), null, { timeout: 30000 });
		await round(p2); await round(p);
		const self = await p.evaluate(() => DaimondCore.syncSelfDeviceId());
		const self2 = await p2.evaluate(() => DaimondCore.syncSelfDeviceId());
		check('T: two tabs, one device', !!self && self === self2, self + ' / ' + self2);
		await asleep(s, true);
		// q, another device, pushes; the awake tab takes it and pushes over it.
		await p.evaluate(() => __standFiles('q', 1, 'q'));
		const vq = await p.evaluate(() => __standPush('q', { full: false, from: 'base' }));
		await round(p2);
		await sandboxFiles(p2, 't2', 1);
		await round(p2);
		const v2 = await p2.evaluate(() => DaimondSync.version());
		// The awake tab sleeps now, so the head below is the woken tab's push and not an answer to it.
		const s2 = { page: p2 };
		await asleep(s2, true);
		await asleep(s, false);
		// The sleeping tab wakes onto its sibling's push and pushes over it.
		await round(p);
		await sandboxFiles(p, 't3', 1);
		await round(p);
		const head = await p.evaluate(async (me) => {
			const r = await DaimondGateway.gwFetch('/api/sync', { method: 'GET', credentials: 'same-origin',
				headers: { 'x-daimond-api': String(DaimondGateway.clientApi()), 'x-cmg-standin': '1' } });
			const g = await r.json();
			const st = JSON.parse(await DaimondIdentity.unwrap(g.blob));
			return { v: g.version | 0, from: st.chunkedFrom, mine: !!(st.devices && st.devices[me] && st.devices[me].self),
				foreign: DaimondSync.foreignAt ? DaimondSync.foreignAt() : null };
		}, self);
		console.log(`  note T: q v${vq}, the awake tab's push v${v2}; the woken tab's parcel at v${head.v} (its own: ${head.mine}) says chunkedFrom=${head.from}, its foreignAt=${head.foreign}`);
		check('T: the woken tab pushed over its sibling\'s version', head.mine && head.v > v2, 'head v' + head.v);
		check('T: and its parcel does not vouch for the version its sibling took (chunkedFrom >= q\'s)',
			typeof head.from === 'number' && head.from >= vq, 'chunkedFrom=' + head.from + ', q at v' + vq);
		await asleep(s2, false);
	} finally {
		if (p2) await p2.close().catch(() => {});
		await s.close();
	}
}

try {
	if (ONLY.includes('R')) await armRollback();
	if (ONLY.includes('T')) await armTabs();
	if (ONLY.includes('M')) await armMixed();
	if (ONLY.includes('K')) await armAsleep();
	if (ONLY.includes('U')) await armUpgrade();
	if (ONLY.includes('F')) await armFolderBehind();
} catch (e) {
	check('the run finished', false, String(e && e.stack || e).slice(0, 500));
}
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
