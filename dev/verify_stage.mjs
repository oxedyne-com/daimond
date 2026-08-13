// verify_stage.mjs — the stage seats as many panels as it has room for, and a
// document sits beside its own preview.
//
// Two changes are under test here and they are two halves of one ask: *"currently
// we can have 1-2 panels in the centre area, we need to allow 3 so i can have a pdf
// view and a text file view visible at once … up to 4 side by side panels."*
//
// A third seat alone would not have given him that. The Doc panel was a SINGLETON
// holding one of three renderings — a text view, a PDF and (since the live typeset
// pages were built) a third — with the others `display: none`. So a PDF and a text
// file could not both be on screen at four seats any more than at two: they were
// the same panel. The preview is therefore its own panel, and the file being edited
// is its own panel, and the seating engine can carry both.
//
// WHAT IS ASSERTED IS THE INVARIANT RATHER THAN THE CASE, and the invariant is the
// dock's own, because it is the defect that recurs on any tiling engine:
//
//   1. A SEAT THAT TAKES WIDTH HAS SOMETHING VISIBLE IN IT. Measured with
//      `getBoundingClientRect()` and `getClientRects()` and never the engine's own
//      bookkeeping: the dock's bug was a column the engine had finished with that
//      the browser was still drawing, and everything that read the engine's state
//      called the broken layout healthy.
//
//   2. THE SEATS FIT. Their widths and the dividers between them add up to the
//      stage and no more, at every width, so nothing is drawn half off the screen.
//
//   3. NARROWING CLOSES THE OVERFLOW; WIDENING DOES NOT RE-ADMIT IT. The asymmetry
//      is the design: a window dragged narrow has to give something up, but an app
//      that re-opens panels you closed is worse than one that makes you click.
//
//   4. A BOUNDARY THE USER MOVED IS WHERE THEY LEFT IT — after a reload, and after
//      a round trip through another tiling — and a drag moves ONE boundary.
//
//   5. AND THE THING HE ASKED FOR. Not "three panels" and not a count of anything:
//      the seat showing `notes.md` is beside the seat showing `paper.pdf`, both are
//      on screen, and the line-number toggle still belongs to the Markdown file.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file to the real page (through
// `page.route`, so the browser loads it as it loads any other script) and the run is
// expected to FAIL. A break that does not apply cleanly aborts rather than passing
// quietly: a check proved against code that was never broken is not proved at all.
//
//   node dev/verify_stage.mjs --break stagecap    # four seats, the dividers and the
//                                                 # author's own case: all gone at a
//                                                 # cap of 2
//   node dev/verify_stage.mjs --break nofit       # narrowing overflows, and nothing
//                                                 # is ever shed
//   node dev/verify_stage.mjs --break readmit     # narrowing is right; widening puts
//                                                 # back what the user shut
//   node dev/verify_stage.mjs --break seatshare   # a moved boundary is ignored
//   node dev/verify_stage.mjs --break seatsave    # it holds, and not across a reload
//   node dev/verify_stage.mjs --break seatall     # the drag moves the right seat by the
//                                                 # right amount and robs the wrong one
//   node dev/verify_stage.mjs --break onepanel    # the preview is the Doc panel again,
//                                                 # so the PDF takes the document's place
//   node dev/verify_stage.mjs --break docstate    # a preview clobbers the document's
//                                                 # state and the toggle stands down
//   node dev/verify_stage.mjs --break phoneseat   # the seating tiles a phone
//   node dev/verify_stage.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_stage.mjs
//
// Needs dev/serve.mjs only. No gateway, no mock traffic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'stage' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it. `find` must appear
// exactly once: a break that silently matched nothing would leave the run green
// against working code and prove the opposite of what it claims.
const BREAKS = {
	// The cap is the constant it used to be. Everything else — the derivation, the
	// dividers, the shares — still works; there are simply never more than two.
	stagecap: [{
		file: 'js/daimond.js',
		find: '\t\tvar STAGE_CAP = 4;',
		with: '\t\tvar STAGE_CAP = 2;',
	}],
	// Nothing is ever closed for want of room. The seats keep their widths and
	// overflow the stage, which is what a tiling engine does when it stops asking
	// whether what it is drawing fits.
	nofit: [{
		file: 'js/daimond.js',
		find: '\t\t\tvar max = stageMax(), closed = false;\n\t\t\twhile (stage.length > max) {',
		with: '\t\t\tvar max = stageMax(), closed = false;\n\t\t\twhile (false) {',
	}],
	// The tempting shape, and the one a reasonable person writes: the stage
	// "restores what fits" as it widens. Narrowing still looks exactly right — the
	// overflow is closed, properly, back to a chip — and the panels the user shut
	// come back on their own the moment the window is dragged out again.
	readmit: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\tif (fitStage()) apply(); else applySeats();',
		with: '\t\t\t\t\tif (fitStage()) { apply(); return; }\n'
			+ '\t\t\t\t\tvar room = false;\n'
			+ '\t\t\t\t\tPANELS.forEach(function (q) {\n'
			+ '\t\t\t\t\t\tif (q.zone !== \'stage\' || stage.indexOf(q.id) !== -1) return;\n'
			+ '\t\t\t\t\t\tif (!usedPanels()[q.id] || stage.length >= stageMax()) return;\n'
			+ '\t\t\t\t\t\topen[q.id] = true; stage.push(q.id); room = true;\n'
			+ '\t\t\t\t\t});\n'
			+ '\t\t\t\t\tif (room) apply(); else applySeats();',
	}],
	// A moved boundary is never honoured: every arrangement is an even share.
	seatshare: [{
		file: 'js/daimond.js',
		find: '\t\t\tvar shares = sharesOf(seats, stage) || stage.map(function () { return 1 / n; });',
		with: '\t\t\tvar shares = null || stage.map(function () { return 1 / n; });',
	}],
	// It is honoured, and never written down. The drag holds until the page is
	// reloaded, which is the failure a check that only drags cannot see.
	seatsave: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\twidths: widths, split: split, railSplit: railSplit, seats: seats,',
		with: '\t\t\t\t\twidths: widths, split: split, railSplit: railSplit,',
	}],
	// The seat under the hand gains exactly what it should, and what it gains is
	// taken from the far end of the stage instead of from its neighbour. Sharpened
	// deliberately: a break that also got the first number wrong would have failed
	// both checks and proved neither, since "40px" and "and from nobody else" are
	// different claims.
	seatall: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tpx[i] += dx; px[i + 1] -= dx;',
		with: '\t\t\t\tpx[i] += dx; px[px.length - 1] -= dx;',
	}],
	// The preview goes back to being a rendering of the Doc panel. The seating
	// engine is untouched and four seats still work — which is the point: seats
	// alone never gave him a PDF and a text file at once.
	onepanel: [{
		file: 'js/daimond.js',
		find: "\t\t\tDaimondPanels.markUsed('preview');\n\t\t\tDaimondPanels.show('preview');",
		with: "\t\t\tDaimondPanels.markUsed('doc');\n\t\t\tDaimondPanels.show('doc');",
	}],
	// The preview writes its file into the document's own state, the way it did
	// when they were one panel. Both are on screen and the toggle in the Doc
	// panel's header has stood down over a file that has lines.
	docstate: [{
		file: 'js/daimond.js',
		find: '\t\t\tpvFile = path; pvStore = !!store;',
		with: '\t\t\tpvFile = path; pvStore = !!store;\n\t\t\tcurFile = path; curContent = null; syncLineNo();',
	}],
	// The seat arithmetic runs on a phone instead of standing back for the sheet,
	// and it cuts the one panel on screen down to a desktop seat's width on a
	// 390px screen. Two edits, because the guard that catches a stage with no room
	// to divide would otherwise cover for the missing one.
	phoneseat: [
		{
			file: 'js/daimond.js',
			find: '\t\t\tif (isMobile()) {\n\t\t\t\tels.forEach',
			with: '\t\t\tif (false) {\n\t\t\t\tels.forEach',
		},
		{
			file: 'js/daimond.js',
			find: '\t\t\tif (room < MIN_W.stage * n) { even(); return; }',
			with: '\t\t\tif (false) { even(); return; }',
		},
	],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged sources, keyed by file, or a hard stop.
///
/// EVERY EDIT TO ONE FILE IS APPLIED TO ONE COPY. Registering a `page.route` per
/// edit does not work and does not say so: two routes on the same URL leave the
/// last one serving, so a two-edit break silently shipped only its second edit.
/// That is how `--break readmit` came out GREEN — a break that proves nothing is
/// worse than no break at all, because it reads as proof.
function damagedFiles() {
	const out = {};
	for (const spec of (BREAKS[BREAK] || [])) {
		let src = out[spec.file];
		if (src === undefined) src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		out[spec.file] = src.replace(spec.find, spec.with);
	}
	return out;
}

async function routes(page) {
	if (!BREAK) return;
	const files = damagedFiles();
	for (const file of Object.keys(files)) {
		const body = files[file];
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

const s = await open({ name: 'stage', profile: PROFILE, connect: false, route: routes });
const p = s.page;
await p.waitForTimeout(1200);

// ── What the stage is actually doing ─────────────────────────────────
//
// Measured, never asked. `getClientRects()` for "is it drawn at all" and
// `getBoundingClientRect()` for "how much room is it taking", because the whole
// class of bug here is a seat the engine has finished with that the browser is
// still painting — and every reading of the engine's own state would call it
// healthy. `DaimondPanels.isOpen` appears in exactly one check below, and there it
// is the thing being tested rather than the instrument.
const geom = () => p.evaluate(() => {
	const st = document.getElementById('stage');
	const box = st.getBoundingClientRect();
	const kids = [...st.children].map((k) => {
		const r = k.getBoundingClientRect();
		return {
			panel:   k.dataset.panel || null,
			handle:  k.classList.contains('phandle'),
			drawn:   k.getClientRects().length > 0 && r.width > 0,
			w:       Math.round(r.width),
			left:    Math.round(r.left),
			right:   Math.round(r.right),
			// What is INSIDE it that the browser is drawing. A panel whose every
			// child is display:none is a seat with nothing in it however wide the
			// panel's own box happens to be.
			shows:   [...k.querySelectorAll(':scope > *')]
				.filter((c) => c.getClientRects().length > 0).length,
		};
	});
	return {
		width: Math.round(box.width),
		left:  Math.round(box.left),
		right: Math.round(box.right),
		seats: kids.filter((k) => k.drawn && !k.handle),
		hands: kids.filter((k) => k.drawn && k.handle),
		all:   kids,
	};
});

/// The complaint about a stage, or null when it is sound.
///
/// Three things at once, because they fail in different ways: a seat drawing
/// nothing, a seat narrower than a seat is allowed to be, and seats that together
/// take more room than there is.
const FLOOR  = 380;
const HANDLE = 10;
/// The width below which a panel is not a panel at all, whatever the stage is
/// trying to fit. Measured, in `dev/measure_seat.mjs`: at 180px the Web panel's
/// close button sits OUTSIDE the panel it closes, and at 205px it is back inside.
/// This is the line the squeeze may never cross, where 380 is the line it may not
/// cross when there is room to stay the right side of it.
const NEVER  = 205;
const faults = (g) => {
	const out = [];
	const n = g.seats.length;
	// Whether the stage could actually afford everyone a readable seat. Two seats
	// are the app's premise rather than a width — you should never have to leave
	// the conversation to do a thing — so below the room for two they are squeezed
	// evenly instead of one being shut. The floor is asserted where it is
	// affordable, and an equal share where it is not; both are real claims, and
	// asserting the floor everywhere would have been asserting the wrong one.
	const affords = g.width >= n * FLOOR + (n - 1) * HANDLE;
	g.seats.forEach((k) => {
		if (k.shows === 0) out.push(`${k.panel} is ${k.w}px wide with nothing in it`);
		if (n > 1 && affords && k.w < FLOOR - 1) {
			out.push(`${k.panel} is ${k.w}px in a stage with room for ${FLOOR}px each`);
		}
		if (k.w < NEVER) out.push(`${k.panel} is ${k.w}px, under the ${NEVER}px a panel needs to be one`);
		if (k.left < g.left - 1 || k.right > g.right + 1) {
			out.push(`${k.panel} sits ${k.left}..${k.right} outside the stage's ${g.left}..${g.right}`);
		}
	});
	if (n > 1 && !affords) {
		const lo = Math.min(...g.seats.map((k) => k.w)), hi = Math.max(...g.seats.map((k) => k.w));
		if (hi - lo > 4) out.push(`squeezed unevenly: ${g.seats.map((k) => k.w).join(' + ')}`);
	}
	const spent = [...g.seats, ...g.hands].reduce((a, k) => a + k.w, 0);
	if (spent > g.width + 2) out.push(`${spent}px of seats in a ${g.width}px stage`);
	return out.length ? out.join('; ') : null;
};

/// Ask for a set of stage panels, in order.
const wants = async (ids) => {
	await p.evaluate((list) => { list.forEach((x) => DaimondPanels.show(x)); }, ids);
	await p.waitForTimeout(600);
};

const at = async (w, h) => {
	await p.setViewportSize({ width: w, height: h || 950 });
	await p.waitForTimeout(700);
};

// ── 1. Four seats where there is room for four ───────────────────────
await at(2400);
await wants(['web', 'doc', 'msg']);
{
	const g = await geom();
	check('a wide stage seats four panels side by side',
		g.seats.length === 4,
		g.seats.map((k) => `${k.panel}:${k.w}`).join(' '));
	check('and every seat is a seat: something is drawn in it, at a width it can be read at',
		faults(g) === null, faults(g) || g.seats.map((k) => `${k.panel}:${k.w}`).join(' '));
	// A divider between each adjacent pair and nowhere else. This is the dock's
	// "a divider exists exactly where there is a boundary to move", turned sideways.
	check('with a divider between each adjacent pair, and none left over',
		g.hands.length === g.seats.length - 1,
		`${g.hands.length} divider(s) for ${g.seats.length} seats`);
	// Interleaved, not clustered: p h p h p h p.
	const order = g.all.filter((k) => k.drawn).map((k) => (k.handle ? 'h' : 'p')).join('');
	check('and they sit BETWEEN the seats rather than beside them',
		order === 'phphphp', order);
}
await shot(s, 'stage-four' + (BREAK ? '-' + BREAK : ''));

// ── 2. Narrowing closes the overflow rather than overflowing ─────────
//
// The ladder matters: the fault is not "it broke at one width" but "at some width
// it drew outside itself", so every rung is asked the same three questions.
{
	let worst = null;
	for (const w of [2400, 2000, 1800, 1600, 1400, 1200, 1000, 860]) {
		await at(w);
		const g = await geom();
		const f = faults(g);
		if (f && !worst) worst = `at ${w}px: ${f}`;
	}
	check('NARROWING NEVER OVERFLOWS THE STAGE — it closes what will not fit',
		worst === null, worst || 'sound at every width from 2400 down to 860');
}

// ── 3. And widening does not put them back ───────────────────────────
{
	await at(1400);
	const narrow = await geom();
	await at(2400);
	const wide = await geom();
	check('a narrowed stage really did shed seats',
		narrow.seats.length < 4, `${narrow.seats.length} seat(s) at 1400px`);
	check('WIDENING DOES NOT RE-ADMIT WHAT THE NARROWING CLOSED',
		wide.seats.length === narrow.seats.length,
		`${narrow.seats.length} seat(s) narrow, ${wide.seats.length} wide`);
	// The one place the engine's own bookkeeping is read, because "it went back to
	// being a chip" is a claim about that bookkeeping and not about pixels.
	const shut = await p.evaluate(() => DaimondPanels.model().panels
		.filter((x) => x.zone === 'stage' && !x.open).map((x) => x.id));
	check('and what it closed came back as a chip rather than vanishing',
		shut.length > 0, shut.join(' ') || 'nothing is closed');
}

// ── 4. A boundary the user moved ─────────────────────────────────────
//
// Dispatched pointer events rather than `page.mouse`, for the reason
// `verify_docking.mjs` sets out at length: headless Chromium drops the moves after
// a mousedown on one of these handles often enough that a real-mouse drag is not a
// usable oracle. Capture is the one thing a dispatched event cannot have, so it is
// stubbed for the length of the drag; the arithmetic under test is untouched.
const dragSeat = (i, dx) => p.evaluate(({ i, by }) => {
	const h = document.getElementById(i ? 'handle-stage-' + i : 'handle-stage');
	if (!h) return false;
	const r = h.getBoundingClientRect();
	const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
	const cap = Element.prototype.setPointerCapture, rel = Element.prototype.releasePointerCapture;
	Element.prototype.setPointerCapture = function () {};
	Element.prototype.releasePointerCapture = function () {};
	const fire = (type, cx) => h.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: cx, clientY: y,
	}));
	fire('pointerdown', x);
	for (let k = 1; k <= 10; k++) fire('pointermove', x + Math.round(by * k / 10));
	fire('pointerup', x + by);
	Element.prototype.setPointerCapture = cap;
	Element.prototype.releasePointerCapture = rel;
	return true;
}, { i, by: dx });

const widthsOf = async () => (await geom()).seats.map((k) => k.w);

await at(2400);
await wants(['web', 'doc', 'msg']);
{
	const before = await widthsOf();
	// 40px, and the size is chosen rather than round: the seat on the right is
	// 427px and may not go under the 380px floor, so a 120px drag would move 47px
	// and the check would be asserting the clamp instead of the drag.
	await dragSeat(1, 40);             // the boundary between the 2nd and 3rd seats
	await p.waitForTimeout(400);
	const after = await widthsOf();
	check('a divider dragged 40px gives its left-hand seat 40px',
		Math.abs((after[1] - before[1]) - 40) <= 6,
		`${before.join(' + ')} then ${after.join(' + ')}`);
	check('and takes it from the seat on its right, and from nobody else',
		Math.abs((after[2] - before[2]) + 40) <= 6
			&& Math.abs(after[0] - before[0]) <= 2 && Math.abs(after[3] - before[3]) <= 2,
		`${before.join(' + ')} then ${after.join(' + ')}`);

	// A round trip through another tiling: a seat leaves, and the boundary the user
	// moved is waiting when it comes back. This is the dock's own test of its stacks,
	// and it is why the shares are keyed by OCCUPANCY rather than by seat number.
	const tuned = await widthsOf();
	await p.evaluate(() => DaimondPanels.hide('msg'));
	await p.waitForTimeout(500);
	await p.evaluate(() => DaimondPanels.show('msg'));
	await p.waitForTimeout(600);
	const back = await widthsOf();
	check('a boundary survives a seat leaving and coming back',
		back.length === tuned.length && back.every((w, i) => Math.abs(w - tuned[i]) <= 3),
		`${tuned.join(' + ')} then ${back.join(' + ')}`);

	await shot(s, 'stage-dragged' + (BREAK ? '-' + BREAK : ''));

	// And across a reload, which is the half a drag-only check cannot see.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(500);
	const { signInAs } = await import('./harness.mjs');
	await signInAs(s, 'stage');
	await p.waitForTimeout(1200);
	const reloaded = await widthsOf();
	check('AND IT IS STILL THERE AFTER A RELOAD',
		reloaded.length === tuned.length && reloaded.every((w, i) => Math.abs(w - tuned[i]) <= 6),
		`${tuned.join(' + ')} then ${reloaded.join(' + ')}`);
}

// ── 5. The thing he actually asked for ───────────────────────────────
//
// A PDF and a text file on screen at the same time. Asserted by MEANING and never
// by a count: the seat holding notes.md is beside the seat holding paper.pdf, both
// are drawing, and neither has taken the other's place.
await at(2400);
{
	await p.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.run_tool('file_write', JSON.stringify({
			path: 'notes.md',
			content: '# Notes\n\nThe document, in the panel that edits it.\n',
		}));
		// A small but genuinely openable PDF, so the browser's own viewer draws it.
		const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
			+ '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
			+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
			+ 'trailer<</Root 1 0 R>>\n%%EOF\n';
		await app.write_bytes('paper.pdf', new Uint8Array([...pdf].map((c) => c.charCodeAt(0))));
	});
	// Opened the way the user opens them: through the one door that decides which
	// panel a file belongs in.
	await p.evaluate(() => window.DaimondDoc.show('notes.md'));
	await p.waitForTimeout(1000);
	await p.evaluate(() => window.DaimondDoc.show('paper.pdf'));
	await p.waitForTimeout(1600);

	const both = await p.evaluate(() => {
		const rect = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right),
				drawn: el.getClientRects().length > 0 && r.width > 0 };
		};
		const doc = document.getElementById('panel-doc');
		const pv  = document.getElementById('panel-preview');
		const body = document.querySelector('#doc-view .files-view-body');
		const emb  = document.querySelector('#pv-view .fileview embed');
		return {
			doc:     rect(doc),
			pv:      rect(pv),
			docText: body ? body.textContent.slice(0, 40) : null,
			docName: (document.getElementById('doc-name') || {}).textContent || '',
			pvName:  (document.getElementById('pv-name') || {}).textContent || '',
			pdfDrawn: emb ? emb.getClientRects().length > 0 && emb.getBoundingClientRect().width > 0 : false,
			// The toggle belongs to the file in the editor, and a preview opened
			// beside it must not have taken it away.
			lineno:  (document.getElementById('doc-lineno') || {}).style.display,
		};
	});
	check('THE SEAT SHOWING notes.md IS BESIDE THE SEAT SHOWING paper.pdf, AND BOTH ARE ON SCREEN',
		!!(both.doc && both.pv && both.doc.drawn && both.pv.drawn)
			&& /Notes/.test(both.docText || '')
			&& both.pvName === 'paper.pdf' && both.docName === 'notes.md',
		JSON.stringify({ doc: both.doc && both.doc.w, pv: both.pv && both.pv.w,
			docName: both.docName, pvName: both.pvName }));
	check('and the PDF is really drawn in its own seat, not merely present in the DOM',
		both.pdfDrawn && both.pv && both.pv.w >= FLOOR - 1,
		`${both.pv ? both.pv.w : 0}px, embed drawn: ${both.pdfDrawn}`);
	check('and they are two seats rather than one panel taking turns',
		!!(both.doc && both.pv) && (both.doc.right <= both.pv.left + 1
			|| both.pv.right <= both.doc.left + 1),
		both.doc && both.pv ? `doc ${both.doc.left}..${both.doc.right}, `
			+ `preview ${both.pv.left}..${both.pv.right}` : 'a panel is missing');
	check('and the line-number toggle still belongs to the Markdown file beside it',
		both.lineno !== 'none', `display: ${JSON.stringify(both.lineno)}`);
	const g = await geom();
	check('and the stage is still sound with them both in it',
		faults(g) === null, faults(g) || g.seats.map((k) => `${k.panel}:${k.w}`).join(' '));
}
await shot(s, 'stage-doc-and-preview' + (BREAK ? '-' + BREAK : ''));

// ── 6. A phone draws one panel, whatever the stage is holding ────────
//
// Below 760px `#stage` is `display: contents` and the phone shell decides what is
// on screen: the chat is the floor and a guest rises over it as a sheet. So what
// is asserted here is that the SEATING DOES NOT REACH IN — one panel drawn, no
// dividers, and the panel taking the width of the screen rather than the width of
// a desktop seat.
{
	await at(390, 780);
	const g = await p.evaluate(() => {
		const drawn = [...document.querySelectorAll('.panel[data-zone="stage"]')]
			.filter((k) => k.getClientRects().length > 0)
			.map((k) => ({ panel: k.dataset.panel, w: Math.round(k.getBoundingClientRect().width),
				inline: k.style.width }));
		const hands = [...document.querySelectorAll('.phandle')]
			.filter((k) => k.getClientRects().length > 0).length;
		return { drawn, hands, screen: window.innerWidth };
	});
	check('A PHONE DRAWS ONE STAGE PANEL, and the sheet carries the rest',
		g.drawn.length === 1 && g.hands === 0,
		`${g.drawn.length} panel(s): ${g.drawn.map((k) => k.panel).join(' ')}, ${g.hands} divider(s)`);
	// No inline width, rather than a width equal to the screen: the phone's own
	// stylesheet decides how wide a panel is there, and what is being asserted is
	// that the seating left nothing behind for it to fight. A 427px desktop seat
	// still written on the one panel a 390px screen has is the engine reaching into
	// a layout that is not its own.
	check('and the seating leaves no desktop width behind on it',
		g.drawn.length === 1 && !g.drawn[0].inline,
		g.drawn.length ? `${g.drawn[0].w}px of ${g.screen}px`
			+ (g.drawn[0].inline ? `, inline width ${g.drawn[0].inline}` : ', no inline width')
			: 'nothing drawn');
}
await at(1500);

// The gateway is not part of this world: nothing here is bought, sent or synced,
// so its refusals are noise from a service the stage knows nothing about.
const errs = s.errs.filter((e) => !/\b(401|402|502)\b|Bad Gateway|Unauthorized|Payment Required|net::ERR/.test(e));
check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log(bad.map((b) => '  - ' + b).join('\n'));
await s.close();
process.exit(bad.length ? 1 : 0);
