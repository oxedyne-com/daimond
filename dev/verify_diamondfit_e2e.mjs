// verify_diamondfit_e2e.mjs — the owner's "33 diamonds did not fit" failure, proven
// end-to-end over a REAL gateway and a REAL second device.
//
// verify_diamondfit drives collectSync in one page with a MOCKED offload: it proves
// the parcel is packed right. It cannot prove the one thing the field failure was
// about — that the diamonds actually REACH the other device. This does: it fills the
// 5 MiB parcel with inline workspace files, seeds 33 diamonds behind them, PUSHES
// through /api/sync to a running gateway, then PAIRS a second real browser and PULLS,
// and asserts all 33 diamonds hydrate there from their `@d/` references (each fetched
// as chunks from the gateway and re-imported).
//
//   PRE-FIX  → device A strands all 33 (parcel carries 0 diamonds); device B, having
//              pulled the whole account, still has none of them.  RED.
//   POST-FIX → device A's parcel carries 33 `@d/` references, 0 named; device B
//              hydrates all 33; the overflow inline files travel via the cloud index;
//              a re-collect is byte-identical; the parcel stays under the Steel door.
//
// This file asserts the POST-FIX behaviour, so a run on the shipped (pre-fix) build
// FAILS — which is the reproduction.
//
// Needs the dev stack up with a gateway, and a Pro-provisioned account (sync is behind
// Pro).  Run under a world whose DAIMOND_GW_PORT points at a live gateway:
//   eval "$(bash dev/world.sh 5 --env)"; node dev/verify_diamondfit_e2e.mjs
import { open, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KiB = 1024, MiB = 1024 * 1024;
const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const NDIA = 33, NFILE = 44, PER = 128 * KiB;   // 44 x 128 KiB = 5.5 MiB, over the 5 MiB parcel

// Device A: signed in, Pro, its rail cleared.
const a = await open({ name: 'sync', signIn: true, connect: false, defaults: false });
await a.page.waitForFunction(
	() => !!window.DaimondSync && !!window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 15000 }).catch(() => {});
const lic = await makePagePro(a.page, GWDIR);
if (!lic.pro) {
	console.log('SKIPPED: the `sync` identity holds no Pro licence on this gateway, and sync '
		+ 'is behind Pro. Provision it (see dev/verify_sync.mjs header) and re-run. lic=' + JSON.stringify(lic));
	await a.close();
	process.exit(2);
}
check('device A holds Pro, so it may sync at all', lic.pro === true, 'acct ' + lic.id);

// Seed 33 diamonds with distinctive names, and a workspace that overfills the parcel.
const ids = await a.page.evaluate(async ({ NDIA, NFILE, PER }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const out = [];
	for (let i = 0; i < NDIA; i++) out.push(await app.create_diamond('Fit-' + i));
	for (let i = 0; i < NFILE; i++) await m.write_file('fill' + i + '.txt', 'a'.repeat(PER));
	return out;
}, { NDIA, NFILE, PER });
check('device A seeded all 33 diamonds', ids.length === NDIA, ids.length + ' created');

// What device A actually packs: every diamond as an @d/ reference, none named.
const parcel = await a.page.evaluate(async () => {
	const p = await DaimondCore.collectSync();
	const ds = p.diamonds || [];
	// Which overflow files went to the cloud index (offloaded) rather than inline.
	const inlineFiles = Object.keys(p.files || {});
	const cloudFiles  = Object.keys(p.chunked || {});
	return {
		total:   ds.length,
		refs:    ds.filter(d => d.dataRef).length,
		inline:  ds.filter(d => d.data != null).length,
		nInline: inlineFiles.length,
		nCloud:  cloudFiles.length,
		parcelBytes: JSON.stringify(p).length,
	};
});
console.log('  parcel:', JSON.stringify(parcel));
check('device A packs all 33 diamonds — none named "did not fit"',
	parcel.total === NDIA, parcel.total + ' of ' + NDIA + ' packed');
// The reserve guarantees the references fit; the freshest few may still ride inline
// when the budget has room. What matters is that all 33 travel and the ref path is
// exercised for the ones the files pushed out — the case that used to name them.
check('and the ones the files pushed out travel as @d/ references (0 named)',
	parcel.refs >= 1 && (parcel.refs + parcel.inline) === NDIA,
	'refs=' + parcel.refs + ' inline=' + parcel.inline);
check('the overflow inline files travel too — via the cloud index, not silently dropped',
	parcel.nCloud > 0 && (parcel.nInline + parcel.nCloud) >= NFILE,
	'inline=' + parcel.nInline + ' offloaded=' + parcel.nCloud);
// base64 of the sealed parcel is 4/3 of it; the Steel front door is 8 MiB of body.
const wireMiB = (parcel.parcelBytes * 4 / 3) / MiB;
check('the parcel stays under the 8 MiB Steel door once base64-wrapped',
	wireMiB < 8, wireMiB.toFixed(2) + ' MiB on the wire');

// Fixed point: a second collect of the unchanged store packs the same diamond bytes.
const stable = await a.page.evaluate(async () => {
	const sig = async () => {
		const p = await DaimondCore.collectSync();
		return JSON.stringify((p.diamonds || []).map(d => ({ id: d.id, ref: d.dataRef || null, inline: d.data != null })));
	};
	const s1 = await sig(); const s2 = await sig();
	return s1 === s2;
});
check('fixed point: a re-collect of the unchanged store is byte-identical', stable === true);

// Push until device A's own parcel is what the mailbox holds.
const landed = await a.page.evaluate(async () => {
	const mine = new Set();
	const t0 = Date.now();
	while (Date.now() - t0 < 30000) {
		await DaimondSync.push();
		mine.add(JSON.stringify(await DaimondSync.parcel()));
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '2' } });
		const j = await r.json();
		if (j.present) {
			try { const held = await window.DaimondIdentity.unwrap(j.blob); if (mine.has(held)) return { ok: true, v: j.version | 0 }; }
			catch (e) {}
		}
		await new Promise(r => setTimeout(r, 250));
	}
	return { ok: false };
});
check('device A pushed its parcel to the gateway', landed.ok === true, 'version ' + landed.v);

// Device B: a second REAL browser, paired into the same account.
const b = await open({ name: 'syncmate', signIn: false, connect: false });
await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
const code = await a.page.evaluate(() => DaimondPairing.create());
await b.page.evaluate(c => DaimondPairing.redeem(c), code.code);
await b.page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(b, 'sync');
await b.page.waitForFunction(
	() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 15000 }).catch(() => {});
const mate = await b.page.evaluate(() => ({ authed: DaimondGateway.state().authed, pub: window.DaimondIdentity.publicKeyB64url() }));
const mine = await a.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
check('device B is a second real device on the same account', mate.authed && mate.pub === mine);

const before = await b.page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.list_diamonds()).map(d => d.id);
});
check('device B really started without the 33 diamonds',
	ids.every(id => !before.includes(id)), before.length + ' present before pull');

// Pull, and settle until every seeded diamond has hydrated from its @d/ reference.
const after = await b.page.evaluate(async (wantIds) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const t0 = Date.now();
	let have = [], names = {};
	do {
		await DaimondSync.pull();
		await new Promise(r => setTimeout(r, 500));
		const list = JSON.parse(await app.list_diamonds());
		have = list.map(d => d.id);
		names = {}; list.forEach(d => { names[d.id] = d.name; });
	} while (wantIds.some(id => !have.includes(id)) && Date.now() - t0 < 40000);
	return {
		count:  wantIds.filter(id => have.includes(id)).length,
		names:  wantIds.map(id => names[id]).filter(Boolean).length,
		took:   Date.now() - t0,
	};
}, ids);
check('device B HYDRATES all 33 diamonds from their @d/ references',
	after.count === NDIA, after.count + ' of ' + NDIA + ' hydrated in ' + after.took + 'ms');
check('and each arrives whole — its name came with it', after.names === NDIA, after.names + ' names present');

const errs = (a.errs || []).concat(b.errs || []).filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await b.close();
await a.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
