// verify_cappdelivery.mjs — the guide's capp delivery button, end to end (piece c).
//
// Not to be confused with `dev/verify_capp.mjs`, which is about what the app REFUSES
// an untrusted page. The guide's Capps page carries one button that asks the app for
// a furnished Diamond, and this drives that. What is asserted:
//
//   * the ask is answered with a dialog in APP chrome, not silently obeyed;
//   * saying yes leaves a Diamond called "Life log" with the template's page in
//     it, and opens it;
//   * asking twice does not make a second one -- the entries are in the first;
//   * a message from anywhere but the guide frame is ignored.
//
//   node dev/verify_cappdelivery.mjs
//
// It writes no path down: `harness.mjs` is imported relative to this file, and the
// profile and screenshot go to the harness scratch root — never into `www/`.
import { open, connectMock, scratch } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// The Diamonds as the store holds them, and what is inside one.
const diamonds = (p) => p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return JSON.parse(await app.list_diamonds()); } catch (e) { return []; }
});

/// Answer whichever confirm box is on screen.
const answer = async (p, yes) => {
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	const said = await p.evaluate(() => {
		const c = [...document.querySelectorAll('.dlg-card')].filter(x => x.getClientRects().length).pop();
		return c ? (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240) : '';
	});
	await p.evaluate((y) => {
		const c = [...document.querySelectorAll('.dlg-card')].filter(x => x.getClientRects().length).pop();
		const b = c.querySelector(y ? '.dlg-ok' : '.dlg-cancel') || c.querySelector('.dlg-ok');
		b.click();
	}, yes);
	await p.waitForTimeout(1500);
	return said;
};

/// Press the guide's own button, inside the guide frame.
const pressInGuide = async (p) => {
	const f = p.frames().find(fr => /guide\/capps\.html/.test(fr.url()));
	if (!f) throw new Error('the guide frame is not showing capps.html');
	await f.click('#make-lifelog');
};

const s = await open({ name: 'cappprobe', profile: scratch('pw', 'cappprobe-' + process.pid) });
const p = s.page;
try {
	await connectMock(s);
	await p.evaluate(() => DaimondWeb.guide('capps.html'));
	await p.waitForTimeout(2500);
	const framed = p.frames().some(f => /guide\/capps\.html/.test(f.url()));
	check(framed, 'the guide is showing its Capps page');

	// ── A stranger's message is not an instruction.
	await p.evaluate(() => window.postMessage({ daimondGuide: 'make', what: 'lifelog' }, '*'));
	await p.waitForTimeout(900);
	check(!(await p.$('.dlg-card')), 'a message from the page itself is ignored');

	// ── Refused.
	await pressInGuide(p);
	const said = await answer(p, false);
	console.log('  dialog: ' + said);
	check(/Life log/.test(said), 'the ask is answered with a dialog naming what it will make');
	check(!(await diamonds(p)).some(d => d.name === 'Life log'), 'saying no makes nothing');

	// ── Accepted.
	await pressInGuide(p);
	await answer(p, true);
	const made = (await diamonds(p)).filter(d => d.name === 'Life log');
	check(made.length === 1, 'saying yes makes exactly one Life log', made.length + ' found');

	if (made.length) {
		const inside = await p.evaluate(async (id) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			const out = {};
			try { out.page = (await app.read_crystal_page(id) || '').length; } catch (e) { out.page = 'threw: ' + e; }
			try { out.data = (await app.read_crystal_data(id) || '').length; } catch (e) { out.data = 'threw: ' + e; }
			return out;
		}, made[0].id);
		console.log('  inside: ' + JSON.stringify(inside));
		check(typeof inside.page === 'number' && inside.page > 500, 'with the template page in it', inside.page);
		check(typeof inside.data === 'number' && inside.data > 0,
			'AND A CRYSTAL, without which the face never mounts the page', inside.data);
	}

	// It is on screen, which is what "delivered" means.
	const showing = await p.evaluate(() => ({
		name: (document.getElementById('current-session-name') || {}).textContent || '',
		frame: !!document.querySelector('#crystal-frame-wrap'),
	}));
	console.log('  showing: ' + JSON.stringify(showing));
	check(/Life log/.test(showing.name), 'and it is the Diamond on screen');
	check(showing.frame, 'with its page mounted');
	await p.waitForTimeout(1200);
	await p.screenshot({ path: scratch('capp-made.png') });

	// ── Asked again: the first one, not a second.
	await p.evaluate(() => DaimondWeb.guide('capps.html'));
	await p.waitForTimeout(2000);
	await pressInGuide(p);
	const again = await answer(p, true);
	console.log('  second dialog: ' + again);
	check(/already have/i.test(again), 'the second ask offers to OPEN the one that exists');
	check((await diamonds(p)).filter(d => d.name === 'Life log').length === 1,
		'and there is still exactly one');
} catch (e) {
	console.log('  FAIL threw — ' + (e && e.message));
	failures++;
} finally {
	const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway|gateway/i.test(e));
	if (errs.length) console.log('  console errors: ' + errs.slice(0, 6).join(' | '));
	await s.close();
}
console.log(failures ? failures + ' failure(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
