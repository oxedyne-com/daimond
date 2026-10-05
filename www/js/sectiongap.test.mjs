// The by-role gate's section-gap check (r535 U3, dev/sectiongap.mjs): one white-space value above a
// section head, one for a head under a title row, a stray more than 1.5px off its mode is a fault.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGaps, measureGaps } from '../../dev/sectiongap.mjs';

const SURF = 'desk-obsidian/panel_x', PANEL = 'aside#p.panel';
// An item at y with height h; `role` is the by-role name the report would have given it.
const it = (role, y, h = 20, o = {}) => ({ roleName: role, surface: SURF, panel: PANEL, view: 1, r: [10, y, 200, h], sig: 'div.' + role + y, text: role + y, ...o });
// A panel of `gaps.length` heads, each `gap` below a 20px row, so head i sits after row i.
const panel = (gaps, o = {}) => {
	const out = []; let y = 0;
	for (const g of gaps) { out.push(it('list-row', y, 20, o)); y += 20 + g; out.push(it('section-head', y, 20, o)); y += 20; }
	return out;
};

test('a head off the canonical gap is a fault, the mode is the canonical', () => {
	const r = checkGaps(panel([14, 14, 14, 20]));
	assert.equal(r.faults.length, 1);
	assert.equal(r.faults[0].kind, 'section-gap');
	assert.equal(r.faults[0].canon, '14px');
	assert.equal(r.faults[0].v, '20px');
});

test('a head within 1.5px of the canonical is not a fault', () => {
	assert.equal(checkGaps(panel([14, 14, 15, 13])).faults.length, 0);
});

test('an exempt head is let through with its reason, and does not vote', () => {
	const items = panel([14, 14, 30, 30, 30]);
	const strays = items.filter((x) => x.roleName === 'section-head').slice(2).map((x) => x.sig);
	const r = checkGaps(items, (h) => strays.includes(h.sig) ? 'a card title' : null);
	assert.equal(r.faults.length, 0);
	assert.equal(r.allowed.length, 3);
	assert.equal(r.allowed[0].why, 'a card title');
	assert.equal(r.canon['section-gap|desk-obsidian'], 14);
});

test('a head with nothing above it in its panel is first and has no gap', () => {
	const items = [it('section-head', 0), ...panel([14, 14])];
	items.slice(1).forEach((x) => { x.r[1] += 40; });
	assert.equal(measureGaps(items).length, 2);
	assert.equal(checkGaps(items).faults.length, 0);
});

test('a head under a title row is a head-gap, voted apart from section-gap', () => {
	// Title with its close button on the same line (the close button ends lower), then three heads each 8 under a title row.
	const mk = (y0, gap, panelName) => [
		it('dialog-title', y0, 20, { panel: panelName }), it('close-button', y0, 30, { panel: panelName }),
		it('section-head', y0 + 30 + gap, 20, { panel: panelName }),
	];
	const items = [...mk(0, 8, 'a.panel'), ...mk(200, 8, 'b.panel'), ...mk(400, 8, 'c.panel'), ...panel([14, 14, 14])];
	const rows = measureGaps(items);
	assert.equal(rows.filter((r) => r.kind === 'head-gap').length, 3);
	const r = checkGaps(items);
	assert.equal(r.faults.length, 0);
	assert.equal(r.canon['head-gap|desk-obsidian'], 8);
	assert.equal(r.canon['section-gap|desk-obsidian'], 14);
	// One of them 6px further down is a head-gap fault, not a section-gap one.
	const moved = [...mk(0, 8, 'a.panel'), ...mk(200, 8, 'b.panel'), ...mk(400, 14, 'c.panel')];
	const f = checkGaps(moved).faults;
	assert.equal(f.length, 1);
	assert.equal(f[0].kind, 'head-gap');
});

test('the control: a head moved 6px in a clean panel fails on section-gap', () => {
	const clean = panel([14, 14, 14, 14]);
	assert.equal(checkGaps(clean).faults.length, 0);
	const heads = clean.filter((x) => x.roleName === 'section-head');
	const last = heads[heads.length - 1];
	last.r = [last.r[0], last.r[1] + 6, last.r[2], last.r[3]];
	const f = checkGaps(clean).faults;
	assert.equal(f.length, 1);
	assert.equal(f[0].kind, 'section-gap');
	assert.equal(f[0].v, '20px');
});

test('configurations vote apart', () => {
	const a = panel([14, 14, 14]), b = panel([20, 20, 20], { surface: 'phone-obsidian/p_x' });
	assert.equal(checkGaps([...a, ...b]).faults.length, 0);
});

test('an item out of view is not measured', () => {
	const items = panel([14, 14, 14, 40]); items[items.length - 1].view = 0;
	assert.equal(checkGaps(items).faults.length, 0);
});

// r535 U3 step 2: the three readings that were the gate's, not the page's.
const ANC = { dock: ['div.railhead', 'aside#panel-spend.panel.spend'], scroll: 'div#admin-scroll.admin-scroll' };

test('a head under a dock header row is first in its body: the railhead is chrome', () => {
	const items = [
		it('list-row', 90, 30, { sig: 'span', anc: ANC.dock }),
		it('section-head', 150, 19, { anc: ['div.spend-sec-head'] }), // 30 under the header text, as measured on the r533 capture
		...panel([14, 14]).map((x) => ({ ...x, r: [x.r[0], x.r[1] + 300, x.r[2], x.r[3]] })),
	];
	assert.equal(measureGaps(items).filter((r) => r.head.sig === items[1].sig).length, 0);
	assert.equal(checkGaps(items).faults.length, 0);
});

test('a status strip below the scroller is not above a head, the content above is', () => {
	const inScroll = (role, y, h, o = {}) => it(role, y, h, { anc: [ANC.scroll, 'div#admin.admin'], ...o });
	const items = [
		it('list-row', 300, 30, { sig: 'button#close', anc: ['div.admin-drawer-head', 'div#admin.admin'] }),
		inScroll('note', 640, 111), inScroll('section-head', 771, 27, { sig: 'h3#search-head' }),
		// The footer: ends 1px above the head's top, but is not in the scroller and ends below the scroller's top.
		it('list-row', 752, 20, { sig: 'button.copy-id', anc: ['div#admin-status', 'div#admin.admin'] }),
		...panel([14, 14]).map((x) => ({ ...x, r: [x.r[0], x.r[1] + 900, x.r[2], x.r[3]] })),
	];
	const row = measureGaps(items).find((r) => r.head.sig === 'h3#search-head');
	assert.equal(row.gap, 20); // from the note's 751, not -1 from the footer's 772
	assert.equal(row.prev.roleName, 'note');
});

test('a title row above the scroller still counts: the first head under it is a head-gap', () => {
	const items = [
		it('dialog-title', 100, 19, { sig: 'span#t', anc: ['div.admin-drawer-head', 'div#admin.admin'] }),
		it('section-head', 140, 25, { sig: 'h4#fieldhead', anc: [ANC.scroll, 'div#admin.admin'] }),
		it('note', 170, 30, { anc: [ANC.scroll, 'div#admin.admin'] }),
	];
	const row = measureGaps(items).find((r) => r.head.sig === 'h4#fieldhead');
	assert.equal(row.kind, 'head-gap');
	assert.equal(row.gap, 21);
});

test('a tick row is measured at its label box, not at the text inside it', () => {
	// Phone: the text ends at 583, the 44px row at 595, the head stands at 609. The white space is 14, not 26.
	const items = [
		it('body-text', 563, 20, { sig: 'span', lb: 595 }), it('section-head', 609, 30), ...panel([14, 14]).map((x) => ({ ...x, r: [x.r[0], x.r[1] + 400, x.r[2], x.r[3]] })),
	];
	const row = measureGaps(items).find((r) => r.head.sig === items[1].sig);
	assert.equal(row.gap, 14);
	assert.equal(checkGaps(items).faults.length, 0);
	delete items[0].lb; // without the label's bottom the same page reads as a 26px stray
	assert.equal(checkGaps(items).faults.length, 1);
});
