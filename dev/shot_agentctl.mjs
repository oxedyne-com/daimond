// shot_agentctl.mjs — behavioural check of the Agents panel's pause / resume /
// stop controls (header, acting on all) and the running/paused/queued tally.
//
// Drives the real UI: a fan-out of slow (@long) workers, then Pause-all →
// Resume-all → Stop-all, asserting the tiles' state and the header at each step.
// Needs dev/serve.mjs :8777 + dev/mockllm.mjs.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'agentctl-shot', signIn: true, connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);

async function newDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok');
	await page.waitForSelector('#steer-input', { timeout: 10000 });
	await pause(300);
}

async function fanOut(names) {
	// Each worker runs a slow @long stream, so it stays running long enough to
	// be caught and paused.
	const calls = names.map(n => `spawn_agent {"name":"${n}","task":"@long 60"}`).join(' ;; ');
	await page.fill('#steer-input', '@tools ' + calls);
	await page.click('#steer-send');
	// The governor's predictive dispatch gate may ask to confirm a fan-out that
	// would outpace the pace budget — accept it and let the workers run.
	await pause(500);
	const okBtn = await page.$('.dlg-ok');
	if (okBtn) { await okBtn.click(); await pause(300); }
}

// Snapshot the pane + header state.
const snap = () => page.evaluate(() => {
	const cards = [...document.querySelectorAll('#agents-list .acard')];
	const st = (cls) => cards.filter(c => c.classList.contains(cls)).length;
	const btn = (id) => { const b = document.getElementById(id); return b ? { shown: b.offsetParent !== null, disabled: !!b.disabled } : null; };
	const ctl = document.getElementById('agents-ctl');
	return {
		cards:   cards.length,
		running: st('running'), paused: st('paused'), stopped: st('stopped'), queued: st('queued'),
		stat:    (document.getElementById('agents-stat') || {}).textContent || '',
		statShown: (() => { const e = document.getElementById('agents-stat'); return e && e.offsetParent !== null; })(),
		ctlShown: ctl ? ctl.offsetParent !== null : false,
		holding:  ctl ? ctl.classList.contains('holding') : false,
		btnPause: btn('agents-pause'), btnPlay: btn('agents-play'), btnStop: btn('agents-stop'),
	};
});

// ── Fan out four slow workers ───────────────────────────────────────────
await newDiamond('Runaway test');
await fanOut(['worker-a', 'worker-b', 'worker-c', 'worker-d']);
await pause(1600);
const running = await snap();
console.log('RUNNING:', JSON.stringify(running));
await shot(s, 'agentctl-running');

// ── Pause all ───────────────────────────────────────────────────────────
await page.click('#agents-pause', { force: true });
await pause(900);
const paused = await snap();
console.log('PAUSED :', JSON.stringify(paused));
await shot(s, 'agentctl-paused');

// ── Resume all ──────────────────────────────────────────────────────────
await page.click('#agents-play', { force: true });
await pause(2200);
const resumed = await snap();
console.log('RESUMED:', JSON.stringify(resumed));
await shot(s, 'agentctl-resumed');

// ── Fan out again, then Stop all (the kill switch) ──────────────────────
await page.click('.diamond-box:has-text("Runaway test")', { force: true });
await page.waitForSelector('#steer-input', { timeout: 8000 });
await fanOut(['kill-a', 'kill-b', 'kill-c']);
await pause(1600);
const running2 = await snap();
console.log('RUNNING2:', JSON.stringify(running2));
await page.click('#agents-stop', { force: true });
await pause(900);
const stopped = await snap();
console.log('STOPPED:', JSON.stringify(stopped));
await shot(s, 'agentctl-stopped');

// ── Verdicts ────────────────────────────────────────────────────────────
const realErrs = s.errs.filter(e => !/502|Bad Gateway|\/api\b/.test(e));
const ok =
	// Four workers running, header visible with the right button states.
	running.running >= 3 && running.ctlShown
	&& running.btnPause.disabled === false && running.btnPlay.disabled === true
	&& /running/.test(running.stat)
	// Pause hangs them all up: paused tiles, resume enabled, pause disabled, held.
	&& paused.paused >= 3 && paused.running === 0
	&& paused.btnPause.disabled === true && paused.btnPlay.disabled === false
	&& paused.holding === true && /paused/.test(paused.stat)
	// Resume clears the paused state (they run on and finish).
	&& resumed.paused === 0
	// Stop-all finalises the second fan-out to stopped.
	&& running2.running >= 2
	&& stopped.stopped >= 2 && stopped.running === 0 && stopped.paused === 0
	&& realErrs.length === 0;
console.log(ok ? '\n✅ PASS — pause / resume / stop all work; counts track state' : '\n❌ FAIL — see above');
if (realErrs.length) console.log('PAGE ERRORS:', realErrs);
await s.close();
process.exit(ok ? 0 : 1);
