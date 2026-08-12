// verify_wakerearm.mjs — re-arming the wake channel must not cost the news it
// was holding, nor the channel itself.
//
// The wake channel parks a request at the gateway for three quarters of a
// minute and is answered the moment another device pushes. Tearing the channel
// down (`wakeStop`, and therefore `wakeVia`, a sign-out, a tier change, the
// supervisor) bumps a generation counter so the loop stands down — but it
// CANNOT take back the request that loop is parked on. The gateway goes on
// holding it, and for as long as it does:
//
//   1. `wakePolling` stayed true, so the re-armed channel turned round at its
//      own front door (`if (wakePolling) return`) and parked NOTHING. Measured
//      at thirty seconds of a device with no channel at all, and it can be
//      fifty-five: the park's own wait, plus a supervisor tick.
//   2. When that request finally answered SAYING THE MAILBOX HAD MOVED, the
//      loop broke on the generation check BEFORE reading it, and the news went
//      in the bin. A version the gateway has moved past is a fact about the
//      ACCOUNT, not about the channel that happened to be holding the question.
//
// Both halves are asserted here as things that HAPPEN on the wire, not as flags:
// a fresh park is a request leaving the browser, and news acted on is a Diamond
// arriving with its new name. And the second is isolated rather than assumed —
// every park made after the re-arm is HELD OPEN by this file, so the only route
// by which the news can reach the device is the request that was already at the
// gateway when the re-arm happened.
//
//   node dev/verify_wakerearm.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT) AND the gateway on :9002: parking is the
// gateway's half and a stub cannot hold a request.
import { open, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Push until THIS device's own parcel is what the mailbox holds.
///
/// Lifted from verify_sync for the same reason it exists there: `push()` stands
/// aside over a live turn and answers its caller no differently than when it
/// sent, so awaiting one proves nothing, and the version advancing can be some
/// other round entirely.
async function pushLanded(pg) {
	return await pg.evaluate(async (ms) => {
		const mailbox = async () => {
			const res = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await res.json();
			if (!j.present) return null;
			try { return await window.DaimondIdentity.unwrap(j.blob); } catch (e) { return null; }
		};
		const mine = new Set();
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			await window.DaimondSync.push();
			mine.add(JSON.stringify(await window.DaimondSync.parcel()));
			const held = await mailbox();
			if (held !== null && mine.has(held)) return true;
			await new Promise(r => setTimeout(r, 200));
		}
		return false;
	}, 25000);
}

/// Return once the engine has stopped moving, so nothing already armed is left
/// to converge on the device's behalf.
async function quiesce(pg, ms = 20000) {
	let last = -1, stable = Date.now();
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await pg.evaluate(() => window.DaimondSync.state().version);
		if (v !== last) { last = v; stable = Date.now(); }
		else if (Date.now() - stable > 4000) return last;
		await pg.waitForTimeout(300);
	}
	return last;
}

const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
const s = await open({ name: 'rearm', signIn: true, connect: false, defaults: false });
const { page } = s;
let child = null;

try {
	await page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const lic = await makePagePro(page, GWDIR);
	check('the account holds Pro, so the mailbox will take a push at all',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);

	// A second REAL device, so the wake has something to be woken BY. How it got
	// the identity is not what is under test here, so it is paired in the plain
	// way.
	child = await open({ name: 'rearmmate', signIn: false, connect: false });
	await child.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 20000 });
	const code = await page.evaluate(() => DaimondPairing.create());
	await child.page.evaluate(c => DaimondPairing.redeem(c), code.code);
	await child.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(child, 'rearm');
	await child.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const same = await child.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	const mine = await page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	check('a second device holds the same account', same === mine, same.slice(0, 12));

	const shared = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return await app.create_diamond('Rearm-Subject');
	});
	check('a Diamond exists for the two of them to disagree about', !!shared, shared);
	check('and the first device gets it into the mailbox', await pushLanded(page));
	await child.page.evaluate(() => window.DaimondSync.pull());

	/// One Diamond's name, as this device's own store reads it.
	const nameOn = (pg) => pg.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return ((JSON.parse(await app.list_diamonds()).find(d => d.id === id)) || {}).name || '(absent)';
	}, shared);
	const nameSettles = async (pg, want, ms) => {
		const t0 = Date.now();
		let seen = '';
		do {
			seen = await nameOn(pg);
			if (seen === want) return seen;
			await pg.waitForTimeout(150);
		} while (Date.now() - t0 < ms);
		return seen;
	};
	const rename = (to) => page.evaluate(async (arg) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.rename_diamond(arg.id, arg.to);
	}, { id: shared, to });

	// ── Every park the second device makes, and when it was answered ──
	// Attached before the channel is switched over: a park lasts three quarters
	// of a minute, and a listener added later would miss the one already open.
	const parks = [];
	const above  = (p) => p ? ((p.url.match(/[?&]above=(\d+)/) || [])[1] | 0) : -1;
	const budget = (p) => p ? ((p.url.match(/[?&]ms=(\d+)/)    || [])[1] | 0) : 0;
	const onPark = (r) => {
		if (r.url().includes('/api/sync?above=')) {
			parks.push({ r, url: r.url(), began: Date.now(), ended: 0, body: null });
		}
	};
	const onDone = (r) => {
		const p = parks.find(q => q.r === r && !q.ended);
		if (!p) return;
		p.ended = Date.now();
		p.body  = r.response().then(res => res.text()).catch(() => '');
	};
	child.page.on('request', onPark);
	child.page.on('requestfinished', onDone);

	// ── (1) A park that is genuinely being HELD ───────────────────────
	const mode = await child.page.evaluate(() => window.DaimondSync.wakeVia('poll'));
	check('the second device is put onto parked requests', mode === 'poll', mode);
	await quiesce(child.page);
	await quiesce(page);
	// Held, rather than merely made: still unanswered a second after it left,
	// which no answer served out of the store on arrival ever is, and with more
	// of its declared wait left than anything below can take.
	const held = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < 60000) {
			const openOnes = parks.filter(q => !q.ended);
			const p = openOnes.length ? openOnes[openOnes.length - 1] : null;
			if (p && Date.now() - p.began >= 1000 && p.began + budget(p) - Date.now() > 25000) return p;
			await sleep(200);
		}
		return null;
	})();
	check('the gateway is HOLDING a park of the second device’s own, unanswered',
		!!held, held ? `above ${above(held)}, open ${Date.now() - held.began}ms of ${budget(held)}ms`
			: 'no park of the channel’s own stayed open long enough in 60s');

	// ── (2) Nothing made after the re-arm may deliver the news ────────
	// Every park from here on is held open by this file and never answered, so
	// the ONLY route by which the mailbox's news can reach this device is the
	// request that was already at the gateway when the re-arm happened. Without
	// this the re-armed loop's own park would carry it, and the check below would
	// pass whether or not the abandoned one was read.
	let attempted = 0;
	const hung = [];
	// A predicate, not a glob: `?` is a wildcard in a URL pattern, and what has to
	// be caught here is exactly the parked shape and nothing else the engine sends
	// to the same path.
	const isPark = (url) => (url.pathname + url.search).indexOf('/api/sync?above=') === 0;
	await child.page.route(isPark, async (route) => {
		attempted++;
		hung.push(route);				// never fulfilled: the request stays pending
	});

	const wakesBefore = await child.page.evaluate(() => {
		window.__probe = { focus: 0, vis: 0, idle: 0 };
		window.addEventListener('focus', () => window.__probe.focus++, true);
		document.addEventListener('visibilitychange', () => window.__probe.vis++, true);
		window.addEventListener('daimond:idle', () => window.__probe.idle++, true);
		return { wake: window.DaimondSync.wake(), version: window.DaimondSync.state().version };
	});

	// ── (3) The re-arm ────────────────────────────────────────────────
	const rearmAt = Date.now();
	await child.page.evaluate(() => window.DaimondSync.wakeVia('poll'));
	const parked = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < 3000) {
			if (attempted > 0) return Date.now() - rearmAt;
			await sleep(50);
		}
		return -1;
	})();
	check('re-arming while a park is outstanding parks a FRESH request, at once',
		parked >= 0, parked >= 0
			? `a new park left the browser ${parked}ms after the re-arm`
			: 'no park was even attempted in the 3s after the re-arm — the channel is shut '
				+ 'and the flag says otherwise: ' + JSON.stringify(
					await child.page.evaluate(() => window.DaimondSync.wake())));

	// ── (4) And the abandoned park's news is still acted on ───────────
	const renamed = 'Woken-Through-The-Rearm';
	await rename(renamed);
	const pushedAt = Date.now();
	check('the first device gets the rename into the mailbox', await pushLanded(page));
	const arrived = await nameSettles(child.page, renamed, 8000);
	const after = await child.page.evaluate(() => ({
		wake:    window.DaimondSync.wake(),
		version: window.DaimondSync.state().version,
		probe:   window.__probe,
	}));
	// The answer to the park that was outstanding at the re-arm: it must say the
	// mailbox moved, and it must have been answered AFTER the push rather than
	// having run its own wait out beforehand.
	let answer = null;
	for (let i = 0; i < 100 && held && !held.ended; i++) await sleep(100);
	try { answer = held && held.body ? JSON.parse(await held.body) : null; } catch (e) { answer = null; }
	check('the gateway answers the abandoned park with the news',
		!!answer && answer.waited === true && answer.changed === true
			&& (answer.version | 0) > above(held) && held.ended > pushedAt,
		held ? `held on ${above(held)} for ${held.ended - held.began}ms, answered `
			+ `${held.ended - pushedAt}ms after the push: ${JSON.stringify(answer)}` : 'nothing was parked');
	check('and the device ACTS on it — the news is not thrown away with the loop',
		arrived === renamed && after.version > wakesBefore.version,
		`name "${arrived}", version ${wakesBefore.version} -> ${after.version}`);
	check('with nothing happening on the device itself to explain it',
		after.probe.focus === 0 && after.probe.vis === 0 && after.probe.idle === 0,
		JSON.stringify(after.probe));
	check('and the channel counts the pull as its own doing',
		after.wake.wakes > wakesBefore.wake.wakes && after.wake.heard > wakesBefore.version,
		`wakes ${wakesBefore.wake.wakes} -> ${after.wake.wakes}, heard ${after.wake.heard} `
			+ `while holding ${wakesBefore.version}`);

	// ── (5) The probe has the same shape, and the same fix ────────────
	// The one-shot park the channel makes before reaching for a socket is guarded
	// by a flag of its own. Held open, it blocked a re-arm exactly as the loop
	// did — briefly, because it is a one-second wait, but a device that reaches
	// for a channel and is told one is already being opened by a generation that
	// has stood down is the same fault in a smaller window.
	const probesBefore = attempted;
	await child.page.evaluate(() => window.DaimondSync.wakeVia(''));		// probe #1, hung by the route
	await sleep(1500);
	const first = attempted - probesBefore;
	await child.page.evaluate(() => window.DaimondSync.wakeVia(''));		// re-arm on top of it
	const second = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < 3000) {
			if (attempted - probesBefore >= first + 1) return Date.now() - t0;
			await sleep(50);
		}
		return -1;
	})();
	check('a probe left hanging does not block the next attempt at a channel either',
		first >= 1 && second >= 0,
		`${first} probe(s) before the re-arm, the next attempted ${second >= 0 ? second + 'ms after it' : 'never'}`);

	// Let the hung requests go before the page is asked to close.
	await child.page.unroute(isPark);
	for (const r of hung) { try { await r.abort(); } catch (e) { /* the page may have gone */ } }
	child.page.off('request', onPark);
	child.page.off('requestfinished', onDone);

	const noise = /WebSocket connection to '[^']*\/api\/sync\/ws/;
	const clean = (errs) => errs.filter(e =>
		!/favicon|ERR_|Failed to load resource|401|402|409|426|502|Unauthorized/.test(e) && !noise.test(e));
	check('no unexpected console errors on the woken device', clean(child.errs).length === 0,
		clean(child.errs).slice(0, 3).join(' | '));
	check('no unexpected console errors on the pushing device', clean(s.errs).length === 0,
		clean(s.errs).slice(0, 3).join(' | '));
} catch (e) {
	check('verify_wakerearm ran without throwing', false, String(e && e.message || e));
} finally {
	await child?.close?.().catch?.(() => {});
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
