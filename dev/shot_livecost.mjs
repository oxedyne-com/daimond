// shot_livecost.mjs — a worker's cost must show on its tile while it is still
// running, not only once it finishes. Drives a @toolslow worker: round one books
// token usage (the meter), round two streams slowly, so the tile is caught mid-run
// with a non-zero cost. Needs dev/serve.mjs + dev/mockllm.mjs (with @toolslow).
import { open, shot } from './harness.mjs';

const s = await open({ name: 'livecost-shot', signIn: true, connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);

await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Cost test');
await page.click('.dlg-ok');
await page.waitForSelector('#steer-input', { timeout: 10000 });
await pause(300);

// One worker: a tool call (books usage), then a slow stream.
await page.fill('#steer-input', '@tools spawn_agent {"name":"coster","task":"@toolslow"}');
await page.click('#steer-send');
await pause(500);
const okBtn = await page.$('.dlg-ok');
if (okBtn) { await okBtn.click(); await pause(300); }

// Wait for round one to book usage and round two to be streaming.
await pause(2600);
const live = await page.evaluate(() => {
	const c = document.querySelector('#agents-list .acard.running');
	if (!c) return { running: false };
	const arow = c.querySelector('.arow');
	return {
		running: true,
		rowText: arow ? arow.textContent.trim() : '',
	};
});
console.log('LIVE (running):', JSON.stringify(live));
await shot(s, 'livecost-running');

const realErrs = s.errs.filter(e => !/502|Bad Gateway|\/api\b/.test(e));
const ok =
	live.running === true
	&& /tok/.test(live.rowText)          // tokens shown while running
	&& /\$\d/.test(live.rowText)          // a dollar cost shown while running
	&& realErrs.length === 0;
console.log(ok ? '\n✅ PASS — a running worker shows its cost live on the tile' : '\n❌ FAIL — see above');
if (realErrs.length) console.log('PAGE ERRORS:', realErrs);
await s.close();
process.exit(ok ? 0 : 1);
