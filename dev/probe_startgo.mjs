// probe_startgo.mjs — is the empty chat's call to action the primary text button?
//
// THE FINDING (daimond-mail-b's by-role run, 26 Oct, consistency-c3). The filled
// step of START HERE (`.start-go`, "Connect a Model") is the page's one primary
// action, but verify_consistency counted it a plain text button, and its own
// `.empty-new-session` box (14px, 10px 18px, 41px) was not the role's (12px,
// 3px 10px, 27px). Fixed by role: it is a member of the primary text button in
// skin-daylight.css and of the primary pattern in the classifier, so it wears
// the role's size and the role's fill, and no exception names it.
//
//   eval "$(node dev/rig/gateclock.mjs env probe_startgo)"
//   DAIMOND_LEASE_BAND=66-80 node dev/probe_startgo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;
const check = (name, ok, detail) => { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : '  (' + detail + ')')); };

// The classifier: the primary pattern is the one whose reason names the primary action.
const cons = fs.readFileSync(path.join(HERE, 'verify_consistency.mjs'), 'utf8');
const line = cons.split('\n').find((l) => /role: '\*', m: \/\\\.dlg-ok\\b/.test(l)) || '';
const m = /m: \/(.*)\/, p:/.exec(line);
const PRIMARY = m ? new RegExp(m[1]) : null;
check('the classifier has its primary pattern', !!PRIMARY);
check('and `.start-go` is a member of it', !!PRIMARY && PRIMARY.test('button.empty-new-session.start-go'));

// The page: the empty chat with no model connected draws the step as the button.
const s = await open({ name: 'startgo', connect: false });
const p = s.page;
await p.waitForSelector('.start-go', { timeout: 20000 });
for (const look of ['obsidian', 'porcelain']) {
	await p.evaluate((l) => document.documentElement.setAttribute('data-theme', l), look);
	const got = await p.evaluate(() => {
		const css = (el) => {
			const c = getComputedStyle(el), r = el.getBoundingClientRect();
			return { fs: c.fontSize, pad: c.padding, lh: c.lineHeight, rad: c.borderRadius, h: Math.round(r.height), bg: c.backgroundColor, col: c.color, w: Math.round(r.width), mh: c.minHeight };
		};
		const go = css(document.querySelector('.start-go'));
		// The role's own members, side by side with it: a plain and a primary text button.
		// Out of the step's narrow list item, so a reference does not wrap.
		const host = document.createElement('div');
		host.style.cssText = 'position:fixed;left:0;top:0;display:flex;align-items:flex-start;gap:8px;width:max-content;white-space:nowrap';
		document.body.appendChild(host);
		const mk = (cls) => { const b = document.createElement('button'); b.className = cls; b.textContent = 'Connect a Model'; host.appendChild(b); return b; };
		const plain = mk('crystal-act'), prim = mk('pro-buy');
		const out = { go, plain: css(plain), prim: css(prim) };
		host.remove();
		return out;
	});
	for (const k of ['fs', 'pad', 'lh', 'rad', 'h']) {
		check(`${look}: .start-go ${k} is the text button's`, got.go[k] === got.plain[k], `${got.go[k]} vs ${got.plain[k]} (${JSON.stringify(got.plain)})`);
	}
	check(`${look}: and it is filled as the primary text button`, got.go.bg === got.prim.bg && got.go.col === got.prim.col,
		`${got.go.bg}/${got.go.col} vs ${got.prim.bg}/${got.prim.col}`);
}
await s.close();
console.log(bad ? `startgo: ${bad} failure(s)` : 'startgo: all ok');
process.exit(bad ? 1 : 0);
