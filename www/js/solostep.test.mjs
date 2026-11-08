// solostep.test.mjs — a turn whose work is one Thinking step shows that step (UNBLOCK-125).
//
// TURN-ACTIONS 4 widened the folded group's hide rule to every work group at rest but left out the
// `:not(.solo)` its display rule carries, so a solo group hid its one step; with the solo label hidden
// too the group drew 0 px and user→answer measured 4 + 4 = 8 (gaps_t29b_diagnosis_20261109.md, kind 1).
// Red before the fix: the step's display was none and its group 0 px high.
//
//   node --test www/js/solostep.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../dev/pw.mjs';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'css');
const style = ['app.css', 'skin-daylight.css'].map((f) => `<style>${readFileSync(join(CSS, f), 'utf8')}</style>`).join('');
const html = `<!doctype html><html data-skin="daylight"><head>${style}</head><body>
<div class="chat-output" id="chat-output" style="height:800px">
 <div class="ctile csel-unit chat-msg-user" data-t="user" id="u"><div class="ctile-lbl">You</div><div class="ctile-body">After a note.</div></div>
 <div class="crollup csel-unit solo collapsed" data-t="work" id="g"><div class="crollup-lbl">Work</div><div class="crollup-body"><div class="ctile collapsed" data-t="think" id="s"><div class="ctile-lbl"><span class="ctile-dot"></span><span class="ctile-who">Thinking</span><span class="ctile-peek">peek</span></div></div></div></div>
 <div class="ctile csel-unit chat-msg-assistant" data-t="assistant" id="a"><div class="ctile-lbl">Daimond</div><div class="ctile-body">Answer.</div></div>
</div></body></html>`;

test('a lone Thinking step is shown, 4 px from the message above and the answer below', async () => {
	const b = await chromium.launch();
	try {
		const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
		await p.setContent(html, { waitUntil: 'load' });
		const r = await p.evaluate(() => {
			const q = (id) => document.getElementById(id), R = (id) => q(id).getBoundingClientRect();
			return { display: getComputedStyle(q('s')).display, stepH: R('s').height, groupH: R('g').height,
				userToGroup: R('g').top - R('u').bottom, groupToAnswer: R('a').top - R('g').bottom };
		});
		assert.notEqual(r.display, 'none', JSON.stringify(r));
		assert.ok(r.stepH > 0 && r.groupH > 0, JSON.stringify(r));
		assert.equal(r.userToGroup, 4, JSON.stringify(r));
		assert.equal(r.groupToAnswer, 4, JSON.stringify(r));
	} finally { await b.close(); }
});
