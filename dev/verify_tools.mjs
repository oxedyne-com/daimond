// verify_tools.mjs — the Tools panel: does it say what Daimond can actually do?
//
// The two claims worth testing are the two that could quietly be lies: that the built-in
// list is the registry the agent really holds (not a copy kept in JavaScript), and that
// the price on the button is the gateway's, not the client's.
import { open, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'tools', connect: false, profile: '/tmp/daimond-compose-profile' });
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

// The Email pack: this account HAS it (granted for the compose run), so it must read as
// unlocked, and must not be offered for sale twice.
const body = await p.$eval('#tools-body', e => e.textContent);
check('the gateway’s unlock is reflected', /Unlocked/.test(body) && /Daimond Email/.test(body));
check('an owned tool is not also for sale', !/Unlock — /.test(body), 'no buy button while owned');

// And the count adds the gateway's tools to the browser's.
const counts = await p.evaluate(() => window.DaimondTools.counts());
check('the count is built-ins plus unlocks', counts.have === names.length + 1 && counts.all === counts.have,
	JSON.stringify(counts));

await shot(s, 'tools');
await s.close();

// ── The other half: an account that owns nothing. A fresh profile is a fresh identity,
// so the gateway mints it a new account with no unlock — which is what a new user is.
const s2 = await open({ name: 'tools-new', connect: false });
const q = s2.page;
await q.waitForTimeout(2000);

const newRow = await q.$eval('#astat-tools', e => e.textContent);
check('a new account is told what it is missing', /Tools · \d+ of \d+/.test(newRow), newRow);

await q.click('#astat-tools');
await q.waitForSelector('#panel-tools .tools-buy', { timeout: 10000 });
const buy = await q.$eval('.tools-buy', e => e.textContent);
// The price is the gateway's: app.jdat prices the email pack at 1000 minor units.
check('the price on the button is the gateway’s', /\$10\.00/.test(buy), buy);
const shopBody = await q.$eval('#tools-body', e => e.textContent);
check('the shop is a section inside Tools, not a room of its own',
	/Get more tools/.test(shopBody) && /Built in/.test(shopBody));
check('nothing renews, and it says so', /Nothing renews/.test(shopBody));

await shot(s2, 'tools-locked');
await s2.close();

console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404/.test(e)).slice(0, 4));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
