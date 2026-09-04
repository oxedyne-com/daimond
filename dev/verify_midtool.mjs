// verify_midtool.mjs — a tool called BETWEEN two reasoning steps draws its Tool
// tile, in the flow, in BOTH Steps states.
//
// THE OWNER'S BUG (2026-09-04). A real turn reasoned, called a tool (mail_list),
// then reasoned again. The transcript showed TWO separate "Thinking" tiles with
// NO Tool tile between them, and the footer said "1 tool call". The tool WAS
// there in the DOM — but the Steps switch (`hide-tools`) set the whole tool tile
// to `display:none`, which orphaned the two reasoning bursts on either side of it
// (they no longer rolled up, since the tool node between them broke the run) and
// left a call with nothing to show for it. So a tool call really did draw no
// visible tile.
//
// THE FIX. Steps now hides the tool's DETAIL (its Sent→Result body), not the
// whole tile. The compact Tool label stays in the flow, so the turn reads
// [Thinking][Tool][Thinking][Daimond] whether Steps is on or off, and the two
// reasoning tiles do NOT roll up across the tool.
//
//   eval "$(bash dev/world.sh N --up)" ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_midtool.mjs
import { open, chat, newChat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const s = await open({ name: 'midtool', connect: true, defaults: true });
const { page } = s;

// The top-level transcript units, in order, with visibility measured as INK (a
// bounding rectangle) so a display:none tile reads as absent the way a reader
// sees it.
const flow = () => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const ink = (el) => { if (!el) return 0; const r = el.getBoundingClientRect(); return Math.round(r.width * r.height); };
	const units = [...out.children]
		.filter((n) => n.classList && (n.classList.contains('crollup') || n.classList.contains('ctile'))
			&& n.dataset.t !== 'wire')
		.map((n) => ({
			t: n.dataset.t,
			who: (n.querySelector('.ctile-who') || {}).textContent || '',
			ink: ink(n),
		}))
		.filter((u) => u.ink > 0);   // only what a reader can see
	const toolTile = out.querySelector('.ctile[data-t="tool"]');
	return {
		order: units.map((u) => u.who),
		hideTools: out.classList.contains('hide-tools'),
		toolLabelInk: ink(toolTile && toolTile.querySelector(':scope > .ctile-lbl')),
		toolBodyInk:  ink(toolTile && toolTile.querySelector(':scope > .ctile-body')),
		thinkTiles:   out.querySelectorAll('.crollup[data-t="think"]').length,
		toolResult:   (out.querySelector('.tool-result') || {}).textContent || '',
	};
});

await newChat(s);
// reason → call file_list → reason → answer (the owner's mail-refresh shape).
await chat(s, '@rtr Let me list the workspace first.;;file_list {"path":"."};;Now I can summarise.');
await page.waitForTimeout(1800);

// ── 1. Steps ON (default): the tool tile is in the flow, expandable ──
let f = await flow();
check('1a. the flow reads [Thinking][Tool][Thinking][Daimond] with Steps on',
	JSON.stringify(f.order) === JSON.stringify(['You', 'Thinking', 'Tools', 'Thinking', 'Daimond']),
	JSON.stringify(f.order));
check('1b. the two reasoning bursts are TWO tiles, not rolled up across the tool',
	f.thinkTiles === 2, `${f.thinkTiles} think rollups`);

// Expand the Tool tile with a REAL click on its label, and read Sent→Result.
await page.evaluate(() => {
	const tool = document.querySelector('#chat-output .ctile[data-t="tool"]');
	if (tool && tool.classList.contains('collapsed')) tool.querySelector('.ctile-lbl').click();
});
await page.waitForTimeout(300);
const expanded = await page.evaluate(() => {
	const tool = document.querySelector('#chat-output .ctile[data-t="tool"]');
	return {
		sent:   (tool.querySelector('.tool-args.sent') || {}).textContent || '',
		result: (tool.querySelector('.tool-result') || {}).textContent || '',
		bodyInk: (() => { const b = tool.querySelector(':scope > .ctile-body'); if (!b) return 0; const r = b.getBoundingClientRect(); return Math.round(r.width * r.height); })(),
	};
});
check('1c. the Tool tile expands to Sent → Result on a click',
	expanded.bodyInk > 0 && /path/.test(expanded.sent) && /diamonds|system|DAIMOND/.test(expanded.result),
	`sent=${JSON.stringify(expanded.sent)} result=${JSON.stringify(expanded.result.slice(0, 40))}`);
await shot(s, 'midtool-steps-on');

// ── 2. Steps OFF (real click on the Steps button): the tool STAYS in the flow ──
await page.click('#steps-toggle-btn', { force: true });
await page.waitForTimeout(300);
f = await flow();
check('2a. Steps off STILL reads [Thinking][Tool][Thinking][Daimond] — the tool is not orphaned',
	JSON.stringify(f.order) === JSON.stringify(['You', 'Thinking', 'Tools', 'Thinking', 'Daimond']),
	`hideTools=${f.hideTools}, order=${JSON.stringify(f.order)}`);
check('2b. the Tool LABEL is still drawn (a call with a tile, not a phantom)',
	f.toolLabelInk > 0, `label ink ${f.toolLabelInk}px²`);
check('2c. but its DETAIL body is withheld — that is what "hide steps" means now',
	f.toolBodyInk === 0, `body ink ${f.toolBodyInk}px²`);
await shot(s, 'midtool-steps-off');

const errs = errors(s).filter((e) => !/502|\/api\//.test(e));
check('3. nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
