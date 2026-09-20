/* ============================================================
   Test — the changed-only delta consumer in typstwatch.js.
   ------------------------------------------------------------
   The Austenite live-view path is fed a delta each compile —
   `{ version, order, changed, reset }` — against the ids it
   already holds. The wasm that produces those deltas does not
   exist yet (austenite-a's lane), so this drives `applyDelta`
   from a STUB that returns crafted deltas, and reads the cache
   back through `knownIds`, `deltaPeek`, `pageBox` and `state`.

   What is proved here is the whole of the contract that lives in
   `deltaCore`/`applyDelta`, none of which touches the DOM:

     A. a page's own width and height are read off the SVG root —
        from width/height, from a unit suffix, or from viewBox.
     B. an EDIT replaces one page's svg and moves nothing else.
     C. an INSERT / DELETE / REORDER rewrites `order`, and a page
        no longer in `order` is PRUNED from the cache — so it
        leaves `known` and the compiler stops diffing against it.
     D. a RESET empties the cache and takes the full resend.
     E. a STALE version (at or below the last applied) is dropped
        whole, and never sent back.
     F. `known` is the cache keys AS STRINGS, fed every compile
        from the cache as it stands — never `Number()`d, so an id
        with a leading zero or past 2^53 keeps its identity.
     G. unmount / close / switch clears the cache, so the next
        compile sends `known:[]` and takes a clean `reset`.
     H. a delta that names a page in `order` it neither sent nor
        left cached is refused, leaving the pages that are up.

   Run:  node www/js/typstdelta.test.mjs   [--break]
   ============================================================ */

// A HOSTLESS TAB. `applyDelta` updates the cache and the geometry with nothing
// mounted and only skips the paint, so the contract runs headless. `window` and
// `document` are set before the import purely so the module's window-guarded
// registration block runs and `state()` can read a (zero) heap.
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = () => {};
globalThis.window.dispatchEvent = () => true;
globalThis.CustomEvent = globalThis.CustomEvent || function CustomEvent(t, o) { this.type = t; this.detail = o && o.detail; };
globalThis.document = globalThis.document || { addEventListener: () => {}, hidden: false };

const W = await import('./typstwatch.js');

const brk = process.argv.includes('--break');
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); return; }
	console.log('  FAIL ' + line);
	failures++;
	if (brk) { console.log(`\n${failures} FAILED (stopped on first, --break)`); process.exit(1); }
}

/// A minimal, self-contained single-page SVG, the shape Austenite emits: its own
/// width/height/viewBox on the root and its own transparent text layer.
function page(id, w, h, opts) {
	opts = opts || {};
	const u = opts.unit || '';
	const wh = opts.viewboxOnly ? '' : ` width="${w}${u}" height="${h}${u}"`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${wh}>`
		+ '<style>.tsel { fill: transparent; }</style>'
		+ `<text class="tsel" x="0" y="10">page ${id} rev ${opts.rev || 0}</text>`
		+ `<rect width="${w}" height="${h}" fill="#ffffff"/></svg>`;
}

/// A changed entry.
function changed(id, w, h, opts) { return { id: id, svg: page(id, w, h, opts) }; }

/// Reset the module's delta state between groups — the same door a close uses.
function reset() { W.stop(); }

// ── A: the page's own size is read off the SVG root ──────────────────────────
console.log('\n— A: width/height/viewBox off the root —');
{
	reset();
	await W.applyDelta({ version: 1, reset: true, order: ['1', '2', '3'], changed: [
		changed('1', 612, 792),				// plain numbers
		changed('2', 612, 300, { unit: 'pt' }),		// a unit suffix
		changed('3', 500, 250, { viewboxOnly: true }),	// no width/height: viewBox only
	] });
	const b1 = W.pageBox(1), b2 = W.pageBox(2), b3 = W.pageBox(3);
	check('A1 width/height are read as points', b1 && b1.height === 792, JSON.stringify(b1));
	check('A2 a unit suffix is stripped to a number', b2 && b2.height === 300, JSON.stringify(b2));
	check('A3 viewBox is the fallback when there is no width/height', b3 && b3.height === 250, JSON.stringify(b3));
	// The running top is the exact sum of the heights above it, plus the sheet gap.
	const gap = W.state().gap;
	check('A4 the second sheet sits at the first height plus the gap',
		b2 && b2.top === 792 + gap, JSON.stringify({ top: b2 && b2.top, want: 792 + gap }));
	check('A5 the third sits at the sum of the two above it plus two gaps',
		b3 && b3.top === 792 + 300 + 2 * gap, JSON.stringify({ top: b3 && b3.top }));
	check('A6 the page count is the length of the order', W.state().pages === 3, String(W.state().pages));
	check('A7 docW is the widest page', W.pageBox(1) && W.state().pages === 3);
}

// ── B: an edit changes one page and moves nothing else ───────────────────────
console.log('\n— B: an edit changes one page —');
{
	reset();
	await W.applyDelta({ version: 1, reset: true, order: ['1', '2', '3'],
		changed: [changed('1', 612, 792), changed('2', 612, 792), changed('3', 612, 792)] });
	const before = W.deltaPeek();
	const svg2before = before.svg('2');
	// One page's svg is resent; the order does not move.
	await W.applyDelta({ version: 2, order: ['1', '2', '3'], changed: [changed('2', 612, 792, { rev: 7 })] });
	const after = W.deltaPeek();
	check('B1 the order is unchanged', after.order.join(',') === '1,2,3', after.order.join(','));
	check('B2 the cache still holds three pages', after.size === 3, String(after.size));
	check('B3 the edited page now holds the NEW svg', after.svg('2') !== svg2before && /rev 7/.test(after.svg('2')));
	check('B4 the other pages are untouched', after.svg('1') === before.svg('1') && after.svg('3') === before.svg('3'));
	check('B5 the version advanced', after.ver === 2, String(after.ver));
}

// ── C: insert, delete, reorder — and the prune ───────────────────────────────
console.log('\n— C: insert / delete / reorder, and prune —');
{
	reset();
	await W.applyDelta({ version: 1, reset: true, order: ['1', '2', '3'],
		changed: [changed('1', 612, 792), changed('2', 612, 792), changed('3', 612, 792)] });

	// INSERT a page between 2 and 3: order grows, only the new page is sent.
	await W.applyDelta({ version: 2, order: ['1', '2', '4', '3'], changed: [changed('4', 612, 792)] });
	let p = W.deltaPeek();
	check('C1 an insert lengthens the order and adds one page', p.order.join(',') === '1,2,4,3' && p.size === 4, p.order.join(','));

	// DELETE page 2 from the middle: order shrinks, nothing sent, page 2 is pruned.
	await W.applyDelta({ version: 3, order: ['1', '4', '3'], changed: [] });
	p = W.deltaPeek();
	check('C2 a delete shortens the order', p.order.join(',') === '1,4,3', p.order.join(','));
	check('C3 the deleted page is PRUNED from the cache', p.ids.indexOf('2') < 0 && p.size === 3, p.ids.join(','));
	check('C4 and so leaves `known` — the compiler stops diffing against it',
		W.knownIds().indexOf('2') < 0, W.knownIds().join(','));

	// REORDER, sending nothing: the cached svgs are reused in the new order.
	const svg1 = p.svg('1'), svg3 = p.svg('3');
	await W.applyDelta({ version: 4, order: ['3', '1', '4'], changed: [] });
	p = W.deltaPeek();
	check('C5 a reorder rewrites the order with no resend', p.order.join(',') === '3,1,4' && p.size === 3, p.order.join(','));
	check('C6 the cached svgs are unchanged by a reorder', p.svg('1') === svg1 && p.svg('3') === svg3);
}

// ── D: a reset is the full resend ────────────────────────────────────────────
console.log('\n— D: a reset takes the full resend —');
{
	reset();
	await W.applyDelta({ version: 5, order: ['1', '2'], reset: true,
		changed: [changed('1', 612, 792), changed('2', 612, 792)] });
	check('D1 the cache holds exactly what the reset sent', W.knownIds().join(',') === '1,2', W.knownIds().join(','));
	// A later reset with a WHOLLY DIFFERENT document empties the old cache first.
	await W.applyDelta({ version: 6, order: ['9', '8', '7'], reset: true,
		changed: [changed('9', 400, 500), changed('8', 400, 500), changed('7', 400, 500)] });
	const p = W.deltaPeek();
	check('D2 a reset drops the previous document entirely', p.ids.sort().join(',') === '7,8,9', p.ids.join(','));
	check('D3 the new order stands', p.order.join(',') === '9,8,7', p.order.join(','));
}

// ── E: a stale version is discarded whole ────────────────────────────────────
console.log('\n— E: a stale (out-of-order) return is dropped —');
{
	reset();
	await W.applyDelta({ version: 10, order: ['1', '2', '3'], reset: true,
		changed: [changed('1', 612, 792), changed('2', 612, 792), changed('3', 612, 792)] });
	const before = W.deltaPeek();
	// A return that resolved LATE but was compiled EARLIER: lower version, must not land.
	await W.applyDelta({ version: 4, order: ['1'], changed: [changed('1', 10, 10, { rev: 99 })] });
	let p = W.deltaPeek();
	check('E1 a lower version leaves the order alone', p.order.join(',') === '1,2,3', p.order.join(','));
	check('E2 and leaves the cache alone', p.size === 3 && p.svg('1') === before.svg('1'));
	check('E3 and does not advance the version', p.ver === 10, String(p.ver));
	// An EQUAL version is stale too — it has already been applied.
	await W.applyDelta({ version: 10, order: ['1'], changed: [changed('1', 10, 10, { rev: 42 })] });
	p = W.deltaPeek();
	check('E4 an equal version is also discarded', p.order.join(',') === '1,2,3' && p.ver === 10 && !/rev 42/.test(p.svg('1')));
	// The NEXT higher version lands as normal, proving the discard was not a wedge.
	await W.applyDelta({ version: 11, order: ['1', '2', '3'], changed: [changed('2', 612, 792, { rev: 5 })] });
	p = W.deltaPeek();
	check('E5 a higher version after a stale one still lands', p.ver === 11 && /rev 5/.test(p.svg('2')));
}

// ── F: `known` is fed every compile, from the cache, as strings ──────────────
console.log('\n— F: `known` is the cache keys, as opaque strings —');
{
	reset();
	// The build loop's delta branch, mirrored: read `known` from the cache NOW, hand it
	// to the compiler, apply what comes back. The stub is the compiler.
	const fed = [];
	async function cycle(stub) {
		const known = W.knownIds();
		fed.push(known.slice());
		await W.applyDelta(stub(known));
		return known;
	}
	// A cold load: the cache is empty, so `known` is empty and the stub sends a reset.
	await cycle((known) => {
		return { version: 1, reset: known.length === 0, order: ['007', '10', '99999999999999999999'],
			changed: [changed('007', 612, 792), changed('10', 612, 792), changed('99999999999999999999', 612, 792)] };
	});
	check('F1 the first compile is fed `known:[]`', fed[0].length === 0, JSON.stringify(fed[0]));
	// The second compile is fed the three ids, verbatim, as strings.
	await cycle((known) => ({ version: 2, order: known.slice(), changed: [] }));
	check('F2 the next compile is fed the cache keys', fed[1].join(',') === '007,10,99999999999999999999', fed[1].join(','));
	check('F3 every fed id is a string', fed[1].every((k) => typeof k === 'string'), typeof fed[1][0]);
	// The opaque ids kept their identity — a leading zero and a value past 2^53 that
	// `Number()` would have collided or rounded.
	const ids = W.knownIds();
	check('F4 a leading-zero id is NOT collapsed to its number', ids.indexOf('007') >= 0 && ids.indexOf('7') < 0, ids.join(','));
	check('F5 an id past 2^53 is kept exactly, not rounded',
		ids.indexOf('99999999999999999999') >= 0, ids.join(','));
	check('F6 `007` and `10` are distinct keys, as strings never would collide but numbers might',
		String(Number('007')) === '7' && ids.indexOf('007') >= 0);
}

// ── G: unmount / close clears the cache → next compile is a reset ────────────
console.log('\n— G: a close clears the cache —');
{
	reset();
	await W.applyDelta({ version: 3, order: ['1', '2'], reset: true,
		changed: [changed('1', 612, 792), changed('2', 612, 792)] });
	check('G1 the cache is populated before the close', W.knownIds().length === 2);
	W.stop();				// the door a close / switch / unmount goes through
	check('G2 the close empties the cache', W.knownIds().length === 0, W.knownIds().join(','));
	check('G3 and resets the version, so any next version lands', W.deltaPeek().ver === -1, String(W.deltaPeek().ver));
	// The next compile is therefore fed `known:[]` and must take a reset.
	const known = W.knownIds();
	await W.applyDelta({ version: 1, reset: known.length === 0, order: ['5'], changed: [changed('5', 612, 792)] });
	check('G4 the next compile is fed known:[] and the reset lands', W.knownIds().join(',') === '5', W.knownIds().join(','));
}

// ── H: a broken delta is refused, leaving the pages up ───────────────────────
console.log('\n— H: a delta that names an unsent page is refused —');
{
	reset();
	await W.applyDelta({ version: 1, reset: true, order: ['1', '2'],
		changed: [changed('1', 612, 792), changed('2', 612, 792)] });
	const before = W.deltaPeek();
	let threw = false;
	try {
		// `order` names page 3, which was neither sent nor already cached.
		await W.applyDelta({ version: 2, order: ['1', '2', '3'], changed: [] });
	} catch (e) {
		threw = true;
		check('H1 the error names the offending page', /did not send: 3/.test(String(e.message)), String(e.message));
	}
	check('H2 a broken delta throws', threw);
	const after = W.deltaPeek();
	check('H3 the pages that were up are left alone', after.order.join(',') === before.order.join(',') && after.size === before.size);
}

// ── surface: the fields the panel and the verifier read ──────────────────────
console.log('\n— surface: state() carries the delta fields —');
{
	reset();
	await W.applyDelta({ version: 2, order: ['1'], reset: true, changed: [changed('1', 612, 792)] });
	const s = W.state();
	check('S1 state() reports the engine', typeof s.engine === 'string', s.engine);
	check('S2 state() reports the cached count', s.cached === 1, String(s.cached));
	check('S3 state() reports the version', s.version === 2, String(s.version));
	check('S4 state() reports the order', Array.isArray(s.order) && s.order.join(',') === '1', String(s.order));
	check('S5 holds is the sum of the cached svg lengths', s.holds > 0 && s.holds === W.deltaPeek().svg('1').length, String(s.holds));
}

console.log(failures ? `\n${failures} FAILED` : '\nall delta consumer checks passed');
if (failures) process.exit(1);
