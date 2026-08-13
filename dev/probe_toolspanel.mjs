// probe_toolspanel.mjs — look at the Tools panel, in the states a reader meets it.
//
// Not a check: a set of screenshots for ink-level QC. Three states (as shipped, with a
// pack for sale, with one bought) and a narrow stage seat, because the panel is a stage
// guest and the stage can be half a phone wide.
//
//   eval "$(bash dev/world.sh 5 --env)"
//   node dev/probe_toolspanel.mjs
import { open, shot, scratch } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'toolsprobe');
fs.rmSync(PROFILE, { recursive: true, force: true });

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (b) => ({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });

let catalogue = [];

const s = await open({ name: 'toolsprobe', profile: PROFILE, signIn: false, connect: false });
const p = s.page;

await p.route('**/api/account',        r => r.fulfill(json({ ok: true })));
await p.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'c', challenge_id: 'i' })));
await p.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
await p.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
await p.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, held: true, currency: 'usd' })));
await p.route('**/api/tools',          r => r.fulfill(json({ ok: true, credits_minor: 5000, tools: catalogue })));

await p.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'toolsprobe');
await p.waitForTimeout(2500);

const draw = async (label, toShelf) => {
	await p.evaluate(() => { window.DaimondPanels.show('tools'); window.DaimondTools.reload(); });
	await p.waitForTimeout(1000);
	if (toShelf) {
		await p.evaluate(() => {
			const secs = [...document.querySelectorAll('#tools-body > .tools-sec')];
			if (secs.length > 1) secs[secs.length - 1].scrollIntoView({ block: 'start' });
		});
		await p.waitForTimeout(300);
	}
	// The rail row, and the rail row after `DaimondAdmin.status()` has been asked again by
	// hand. If the second differs from the first the row is not being redrawn on its own,
	// which is a defect in daimond.js and not in this panel — `status()` returns early
	// when the money rows draw, and `proRow()`, `tools()` and `storage()` sit after it.
	const rail = await p.evaluate(() => {
		const r = document.getElementById('astat-tools');
		return r ? r.innerText.replace(/\s+/g, ' ').trim() : '(no row)';
	});
	const forced = await p.evaluate(() => {
		if (window.DaimondAdmin && DaimondAdmin.status) DaimondAdmin.status();
		const r = document.getElementById('astat-tools');
		return r ? r.innerText.replace(/\s+/g, ' ').trim() : '(no row)';
	});
	if (forced !== rail) console.log('  ! the rail is stale:', rail, '→', forced, 'once status() is re-asked');
	console.log(label, '— rail:', rail, '— counts:',
		JSON.stringify(await p.evaluate(() => window.DaimondTools.counts())));
	await shot(s, label);
};

try {
	await draw('toolspanel-shipped');

	// Opened, which is the state the disclosure exists for.
	await p.evaluate(() => {
		for (const c of document.querySelectorAll('#tools-body .cap')) {
			const b = c.querySelector('.cap-more');
			if (b && c.getAttribute('data-cap') === 'browsing') b.click();
		}
	});
	await p.waitForTimeout(300);
	await shot(s, 'toolspanel-open');

	catalogue = [
		{ tool: 'typst', name: 'Typesetting', blurb: 'Daimond typesets a document into a finished PDF.', price_minor: 2500, unlocked: false, currency: 'usd' },
		{ tool: 'research', name: 'Research', blurb: 'Daimond runs a line of enquiry: searching, reading, and keeping what it found where you can check it.', price_minor: 4500, unlocked: false, currency: 'usd' },
	];
	await draw('toolspanel-shelf', true);

	catalogue[0].unlocked = true;
	await draw('toolspanel-owned', true);

	// A narrow stage seat, which is where a long capability name and a Buy button fight.
	await p.setViewportSize({ width: 720, height: 950 });
	await p.waitForTimeout(600);
	await draw('toolspanel-narrow', true);

	// Overflow: nothing on this panel may push the body sideways.
	const over = await p.evaluate(() => {
		const b = document.getElementById('tools-body');
		return { scroll: b.scrollWidth, client: b.clientWidth };
	});
	console.log('tools-body overflow:', JSON.stringify(over));
} finally {
	await s.close();
}
