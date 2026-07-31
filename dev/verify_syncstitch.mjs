// verify_syncstitch.mjs — the providers ride in the parcel, through the core.
//
// `models.js` grew `exportSync`/`applySync` and they are tested hard next door (verify_sync drives
// them directly: the freshest-per-fact merge, the sealed key, the refused default). None of that
// mattered while the sync ENGINE did not carry the section, and nothing tested the join: a device
// could merge a providers parcel perfectly and never be handed one.
//
// So this drives the seam and only the seam. Two claims:
//
//   * `DaimondCore.collectSync()` puts the providers in the parcel, and puts them there
//     DETERMINISTICALLY. The engine skips a push whose serialisation matches the last one, so a
//     section that followed enumeration order rather than a sort would push for ever -- a battery
//     and bandwidth bug that looks like nothing at all.
//   * `DaimondCore.applySync(parcel)` hands the section to `models.js`, and a parcel that has no
//     such section (a device that predates it) still applies without complaint.
//
// No gateway: the parcel is collected and applied in one page, which is the whole of the seam.
// What travels between two devices is verify_sync's business.
import { open, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'syncstitch' });
const p = s.page;
await p.waitForTimeout(1200);

// ── Collect ─────────────────────────────────────────────────────────────

const out = await p.evaluate(async () => {
	const a = await window.DaimondCore.collectSync();
	const b = await window.DaimondCore.collectSync();
	return {
		hasField:  Object.prototype.hasOwnProperty.call(a, 'models'),
		providers: a.models ? Object.keys(a.models.providers || {}) : null,
		stable:    JSON.stringify(a.models) === JSON.stringify(b.models),
		v:         a.models ? a.models.v : null,
	};
});
check('the parcel carries a models section at all',
	out.hasField === true && out.providers !== null,
	'field present: ' + out.hasField);
check('and it holds the provider this device is configured with',
	Array.isArray(out.providers) && out.providers.length >= 1,
	JSON.stringify(out.providers));
check('collected twice, it serialises identically — so a push can be skipped',
	out.stable === true, 'v' + out.v);

// ── Apply ───────────────────────────────────────────────────────────────
//
// A provider this device has never held, stamped now, arriving inside a parcel the core applies.
// If the core drops the section on the floor, the provider simply is not there afterwards.

const merged = await p.evaluate(async () => {
	const parcel = await window.DaimondCore.collectSync();
	const now = Date.now();
	parcel.models = parcel.models || { v: 2, def: { provider: '', model: '' }, defAt: 0, providers: {} };
	parcel.models.providers['stitchtest'] = {
		name: 'Stitch Test', url: 'https://stitch.test/v1',
		models: ['s-two', 's-one'], fetched: now, touched: now,
		keyEnc: 'SEALED-BY-THE-OTHER-DEVICE',
	};
	let threw = '';
	try { await window.DaimondCore.applySync(parcel); } catch (e) { threw = String(e && e.message ? e.message : e); }
	const held = window.DaimondModels.providers().find(x => x.id === 'stitchtest') || null;
	const ex = window.DaimondModels.exportSync().providers['stitchtest'] || null;
	return {
		threw,
		arrived: !!held,
		name:    held ? held.name : '',
		sealed:  !!(ex && ex.keyEnc === 'SEALED-BY-THE-OTHER-DEVICE'),
		sorted:  ex ? (ex.models || []).join(',') : '',
	};
});
check('the core hands the models section to models.js', merged.arrived === true,
	merged.threw ? 'threw: ' + merged.threw : 'name: ' + merged.name);
check("and the other device's sealed key arrives with it", merged.sealed === true);
check('and the model list arrives sorted, as the export promises',
	merged.sorted === 's-one,s-two', merged.sorted);

// A device that predates the section. `applySync` reads every section by name, so an absent one
// must be a no-op rather than a throw -- otherwise an old device's parcel takes the chats down
// with it.
const old = await p.evaluate(async () => {
	const parcel = await window.DaimondCore.collectSync();
	delete parcel.models;
	parcel.v = 1;
	let threw = '';
	try { await window.DaimondCore.applySync(parcel); } catch (e) { threw = String(e && e.message ? e.message : e); }
	return { threw, stillHeld: !!window.DaimondModels.providers().find(x => x.id === 'stitchtest') };
});
check('a parcel with no models section applies without complaint',
	old.threw === '', old.threw);
check('and takes nothing away — an absence is "never had it", not "delete it"',
	old.stillHeld === true);

await shot(s, 'syncstitch');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
