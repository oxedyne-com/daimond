// verify_tools.mjs — the Tools panel: does it say what Daimond can actually do?
//
// The two claims worth testing are the two that could quietly be lies: that the built-in
// list is the registry the agent really holds (not a copy kept in JavaScript), and that
// any price on a button is the gateway's, not the client's.
//
// The CATALOGUE is configuration, not a constant: `/api/checkout/pack` ships with
// `"tools": ""` (Email moved behind Pro on 2026-07-24), and an owner may set one
// from the console at any time. So the shop half below asks the gateway what is
// actually for sale and holds the panel to THAT — an empty catalogue must read as
// "nothing for sale" rather than a phantom price, and a stocked one must quote the
// gateway's figure. A test that hard-coded $10.00 was testing one configuration.
import { open, shot, scratch } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'tools', connect: false, profile: scratch('compose-profile') });
const p = s.page;
await p.waitForTimeout(1500);

// The rail row is how anyone finds this at all. This account owns everything there is,
// so it reads as a plain count: "of 17" out of 17 would be an odd way to say "all of them".
const rowText = await p.$eval('#astat-tools', e => e.textContent);
check('the rail says what Daimond holds', /^Tools · \d+$/.test(rowText.trim()), rowText);

await p.click('#astat-tools');
await p.waitForSelector('#panel-tools', { state: 'visible', timeout: 10000 });
await p.waitForTimeout(1200);

const staged = await p.evaluate(() => ({
	tools: !!document.querySelector('#panel-tools').offsetParent,
	ai:    !!document.querySelector('[data-panel="ai"]').offsetParent,
}));
check('it opens on the stage, beside the daimon', staged.tools && staged.ai);

// The built-ins must BE the registry: compare the panel against what the wasm reports.
const truth = await p.evaluate(() => JSON.parse(window.__builtins || '[]'));
const shown = await p.$$eval('.tools-card .tools-name', els => els.map(e => e.textContent));
const names = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return JSON.parse(mod.builtin_tools()).map(t => t.tool);
});
check('the built-ins are the registry itself',
	names.length > 0 && names.every(n => shown.includes(n)),
	names.length + ' tools: ' + names.slice(0, 4).join(', ') + '…');
check('the shell is not among them (there is no machine to run it on)', !names.includes('shell'));

// What the gateway says is for sale, which is what the panel must reflect.
//
// `reached` matters as much as the list: an empty catalogue and an unreachable
// gateway look identical from the client, and every claim below about "nothing
// for sale" would pass vacuously against a gateway that simply was not running.
const cat = await p.evaluate(async () => {
	try {
		const r = await fetch('/api/tools', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		if (!r.ok) return { reached: false, tools: [], why: 'HTTP ' + r.status };
		const j = await r.json();
		return { reached: true, tools: (j && j.tools) || [], why: '' };
	} catch (e) { return { reached: false, tools: [], why: String(e) }; }
});
check('the gateway answers /api/tools (or nothing below means anything)',
	cat.reached === true, cat.why || 'reached');
const catalogue = cat.tools;
const body = await p.$eval('#tools-body', e => e.textContent);
const held = catalogue.filter(t => t.unlocked);
if (held.length) {
	// A tool this account holds must read as unlocked, and must not be sold twice.
	check('the gateway’s unlock is reflected', /Unlocked/.test(body), body.slice(0, 80));
	check('an owned tool is not also for sale', !/Unlock — /.test(body), 'no buy button while owned');
} else {
	check('with nothing held from the gateway, nothing claims to be unlocked',
		!/Unlocked/.test(body), body.slice(0, 80));
}

// And the count adds whatever the gateway grants to the browser's own registry.
const counts = await p.evaluate(() => window.DaimondTools.counts());
check('the count is the built-ins plus what the gateway grants',
	counts.have === names.length + held.length, JSON.stringify(counts) + ` held=${held.length}`);

await shot(s, 'tools');
await s.close();

// ── The other half: an account that owns nothing. A fresh profile is a fresh identity,
// so the gateway mints it a new account with no unlock — which is what a new user is.
const s2 = await open({ name: 'tools-new', connect: false });
const q = s2.page;
await q.waitForTimeout(2000);

const forSale = await q.evaluate(async () => {
	try {
		const r = await fetch('/api/tools', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return ((j && j.tools) || []).filter(t => !t.unlocked);
	} catch (e) { return []; }
});
const newRow = await q.$eval('#astat-tools', e => e.textContent);
// "N of M" is a promise that there is more to have. It may only be made when the
// gateway is really selling something.
check(forSale.length
		? 'a new account is told what it is missing'
		: 'with an empty catalogue the row does not imply tools it cannot sell',
	forSale.length ? /Tools · \d+ of \d+/.test(newRow) : /^Tools · \d+$/.test(newRow.trim()),
	newRow + ` (${forSale.length} for sale)`);

await q.click('#astat-tools');
await q.waitForSelector('#tools-body', { timeout: 10000 });
await q.waitForTimeout(800);
const shopBody = await q.$eval('#tools-body', e => e.textContent);
if (forSale.length) {
	await q.waitForSelector('#panel-tools .tools-buy', { timeout: 10000 });
	const buy = await q.$eval('.tools-buy', e => e.textContent);
	// The figure is the gateway's, whatever the owner has set it to -- formatted
	// by the app's own money formatter so this compares presentation, not pennies.
	const want = await q.evaluate((t) =>
		window.DaimondGateway.fmtMoney(t.price_minor, t.currency), forSale[0]);
	check('the price on the button is the gateway’s',
		!!want && buy.includes(want), `${buy} vs gateway ${want}`);
	check('the shop is a section inside Tools, not a room of its own',
		/Get more tools/.test(shopBody) && /Built in/.test(shopBody));
	check('nothing renews, and it says so', /Nothing renews/.test(shopBody));
} else {
	check('an empty catalogue offers no buy button', !/Unlock — /.test(shopBody));
	check('and the built-ins are still listed', /Built in/.test(shopBody), shopBody.slice(0, 60));
}

await shot(s2, 'tools-locked');
await s2.close();

console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404/.test(e)).slice(0, 4));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
