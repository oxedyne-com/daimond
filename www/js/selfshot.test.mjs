/* ============================================================
   Test — the freeze fix for the self-capture rasteriser.
   ------------------------------------------------------------
   BUG (proven live): invoking `capture` froze the app's main thread.
   `rasterise()` clones the target subtree and inlines ~350-400
   computed-style properties onto EVERY descendant -- O(nodes x
   props) -- with no node or pixel cap, and `target()` defaults to
   `document.body` (the whole app, transcript included) when the
   selector is blank. A throw anywhere in that synchronous prelude
   escaped `capture()` uncaught and, through the wasm binding
   (src/wasm/shot.rs, `#[wasm_bindgen(method)]`, no catch), became a
   TRAP that aborted the daimon runtime.

   This drives the REAL www/js/selfshot.js in a minimal DOM stub
   (Node has none), so the gates are proved against the shipped
   code, not a description of it:

     (a) a subtree above MAX_NODES REJECTS, cheaply, before any
         clone or style work;
     (b) a blank selector (document.body) over the cap rejects the
         same way;
     (c) a small scoped element under the cap PASSES the gate and
         rasterises to completion (the fake canvas/Image resolve);
     (d) an oversized target REJECTS at the pixel gate, naming
         "max_w";
     (e) a throw from deep inside `rasterise` (not the two gates)
         still surfaces as a REJECTED PROMISE, never an uncaught
         exception -- the fix for the trap itself.

   Run:  node www/js/selfshot.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

// ---- a DOM just complete enough for selfshot.js, nothing more ----

let seq = 0;
class FakeNode {
	constructor(tag) {
		this.tagName = String(tag || 'DIV').toUpperCase();
		this.children = [];
		this.parentNode = null;
		this.attrs = {};
		this.style = { setProperty() {} };
		this.id = '_n' + (seq++);
		this._rect = { width: 100, height: 50 };
	}
	get nodeType() { return 1; }
	get childNodes() { return this.children; }
	get parentElement() { return this.parentNode; }
	appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
	removeChild(c) {
		const i = this.children.indexOf(c);
		if (i >= 0) this.children.splice(i, 1);
		c.parentNode = null;
		return c;
	}
	replaceChild(nc, oc) {
		const i = this.children.indexOf(oc);
		if (i >= 0) { this.children[i] = nc; nc.parentNode = this; oc.parentNode = null; }
		return oc;
	}
	setAttribute(k, v) { this.attrs[k] = v; }
	getAttribute(k) { return this.attrs[k]; }
	// Only '*' is ever asked of this stub -- every descendant, document order.
	querySelectorAll(sel) {
		const out = [];
		(function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(this);
		return out;
	}
	cloneNode(deep) {
		const c = new FakeNode(this.tagName);
		c.attrs = Object.assign({}, this.attrs);
		c._rect = this._rect;
		if (deep) for (const ch of this.children) c.appendChild(ch.cloneNode(true));
		return c;
	}
	getBoundingClientRect() { return this._rect; }
	// Canvas surface, harmless on any other element.
	getContext() { return { fillStyle: null, fillRect() {}, drawImage() {} }; }
	toDataURL() { return 'data:image/png;base64,QUFBQQ=='; }
}

function leaves(n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(new FakeNode('SPAN'));
	return out;
}

const registry = new Map();
function registerById(id, el) { registry.set(id, el); return el; }

const body = new FakeNode('BODY');
const doc = {
	body,
	createElement:   (tag) => new FakeNode(tag),
	createElementNS: (ns, tag) => new FakeNode(tag),
	querySelector:   (sel) => {
		const s = String(sel);
		const m = /^\.panel\[data-panel="([^"]+)"\]$/.exec(s);
		if (m) return panels.find((p) => p.attrs['data-panel'] === m[1]) || null;
		return s.charAt(0) === '#' ? (registry.get(s.slice(1)) || null) : null;
	},
	querySelectorAll: (sel) => (String(sel) === '.panel[data-panel]' ? panels.slice() : []),
};
const panels = [];

// getComputedStyle: no properties to copy (length 0), an opaque background so
// `backdrop()` resolves on the first probe without needing a real cascade.
function getComputedStyle(el) {
	return { length: 0, backgroundColor: el && el._bg ? el._bg : 'rgb(255,255,255)', getPropertyValue: () => '',
		display: el && el._hidden ? 'none' : 'block', visibility: 'visible' };
}

let lastSvg = null;
class FakeXMLSerializer {
	serializeToString(n) { lastSvg = n; return '<svg-stub/>'; }
}
function tagsIn(n, out = []) { out.push(n.tagName); for (const c of n.children || []) tagsIn(c, out); return out; }

// Image: resolves onload (or onerror) on a macrotask, so the Promise executor
// in `rasterise` is genuinely exercised rather than short-circuited.
let imageMode = 'ok';		// 'ok' | 'error', read when each Image is built.
class FakeImage {
	constructor() { this.onload = null; this.onerror = null; this._mode = imageMode; }
	set src(v) {
		this._src = v;
		const self = this;
		setTimeout(() => {
			if (self._mode === 'error') { if (self.onerror) self.onerror(); }
			else { if (self.onload) self.onload(); }
		}, 0);
	}
	get src() { return this._src; }
}

const win = { innerWidth: 1280, innerHeight: 800 };
function loadScript(rel) {
	const body_ = readFileSync(join(HERE, rel), 'utf8');
	const fn = new Function('window', 'document', 'getComputedStyle', 'XMLSerializer', 'Image', body_);
	fn(win, doc, getComputedStyle, FakeXMLSerializer, FakeImage);
}
loadScript('selfshot.js');
const Shot = win.DaimondShot;

async function main() {
	check('module loaded', !!Shot && typeof Shot.capture === 'function');

	// ---- (a) a scoped selector above the node cap rejects, no clone attempted ----
	const bigEl = registerById('big', new FakeNode('DIV'));
	for (const l of leaves(3500)) bigEl.appendChild(l);	// 3500 > MAX_NODES (3000).
	let threwSync = false;
	let r;
	try { r = Shot.capture(JSON.stringify({ selector: '#big' })); }
	catch (e) { threwSync = true; }
	check('capture() over the node cap does not throw synchronously', !threwSync);
	let err = null;
	try { await r; } catch (e) { err = e; }
	check('a 3500-node selector REJECTS', !!err);
	check('the rejection names the count', !!err && /3500/.test(err.message), err && err.message);
	check('the rejection asks for a selector', !!err && /selector/i.test(err.message));

	// ---- (b) document.body over the cap rejects the same way ----
	for (const l of leaves(4000)) body.appendChild(l);	// document.body now 4000 deep.
	let bodyErr = null;
	try { await Shot.capture('{}'); } catch (e) { bodyErr = e; }	// blank selector -> body.
	check('a blank selector (document.body) over the cap REJECTS', !!bodyErr);
	check('the body rejection also names the count', !!bodyErr && /4000/.test(bodyErr.message));

	// ---- (c) a small scoped element passes the gate and rasterises ----
	const smallEl = registerById('small', new FakeNode('DIV'));
	for (const l of leaves(5)) smallEl.appendChild(l);
	smallEl._rect = { width: 100, height: 50 };
	imageMode = 'ok';
	let smallJson = null, smallErr = null;
	try { smallJson = await Shot.capture(JSON.stringify({ selector: '#small' })); }
	catch (e) { smallErr = e; }
	check('a small element under the cap does NOT hit the node gate', !smallErr, smallErr && smallErr.message);
	const parsed = smallJson && JSON.parse(smallJson);
	check('and rasterises through to a PNG envelope', !!parsed && parsed.ok === true);

	// ---- (d) the pixel gate rejects an oversized target, naming max_w ----
	const hugeEl = registerById('huge', new FakeNode('DIV'));
	for (const l of leaves(2)) hugeEl.appendChild(l);		// well under the node cap.
	hugeEl._rect = { width: 9000, height: 9000 };
	let pxErr = null;
	try { await Shot.capture(JSON.stringify({ selector: '#huge', max_w: 20000 })); }
	catch (e) { pxErr = e; }
	check('an oversized target REJECTS at the pixel gate', !!pxErr, pxErr && pxErr.message);
	check('the pixel-gate message names "max_w"', !!pxErr && /max_w/.test(pxErr.message));

	// ---- (e) a throw from deep inside rasterise -- not either gate -- still
	//          becomes a rejected promise, never an uncaught exception ----
	class BoomNode extends FakeNode {
		getBoundingClientRect() { throw new Error('boom-rect: layout blew up'); }
	}
	const boomEl = registerById('boom', new BoomNode('DIV'));
	for (const l of leaves(2)) boomEl.appendChild(l);
	let boomThrewSync = false;
	let boomPromise;
	try { boomPromise = Shot.capture(JSON.stringify({ selector: '#boom' })); }
	catch (e) { boomThrewSync = true; }
	check('a synchronous throw deep in rasterise does not escape capture()', !boomThrewSync);
	let boomErr = null;
	try { await boomPromise; } catch (e) { boomErr = e; }
	check('it surfaces as a rejected promise instead', !!boomErr && /boom-rect/.test(boomErr.message),
		boomErr && boomErr.message);

	// ---- (f) capture by view name (2026-10-12): the daimon names what it wants to see ----
	// The Typst preview: a panel whose pages are an <svg> in a shadow root, as typstwatch.js mounts it.
	const preview = new FakeNode('ASIDE');
	preview.attrs['data-panel'] = 'preview';
	preview._rect = { left: 640, top: 40, right: 1280, bottom: 800, width: 640, height: 760 };
	const host = new FakeNode('DIV');
	host._rect = { left: 640, top: 40, right: 1280, bottom: 800, width: 640, height: 760 };
	const page = new FakeNode('SVG');
	page._rect = { left: 660, top: 60, right: 1260, bottom: 780, width: 600, height: 720 };
	host.shadowRoot = { childNodes: [page] };
	preview.appendChild(host);
	const hiddenDoc = new FakeNode('ASIDE');
	hiddenDoc.attrs['data-panel'] = 'doc';
	hiddenDoc._hidden = true;
	panels.push(preview, hiddenDoc);
	check('the views on screen are the shown panels, then screen', Shot.views().join(',') === 'preview,screen', Shot.views().join(','));
	let vErr = null, vJson = null;
	try { vJson = await Shot.capture(JSON.stringify({ in: 'preview' })); } catch (e) { vErr = e; }
	check('in:"preview" captures the preview panel', !vErr && !!vJson && JSON.parse(vJson).ok === true, vErr && vErr.message);
	check('at the panel\'s size on screen', !!vJson && JSON.parse(vJson).w === 640 && JSON.parse(vJson).h === 760, vJson && vJson.slice(0, 0) + (vJson ? JSON.parse(vJson).w + 'x' + JSON.parse(vJson).h : ''));
	check('and the shadow root\'s pages are drawn, not an empty box', !!lastSvg && tagsIn(lastSvg).includes('SVG') && tagsIn(lastSvg).filter((t) => t === 'SVG').length >= 2,
		lastSvg && tagsIn(lastSvg).join(' '));
	let uErr = null;
	try { await Shot.capture(JSON.stringify({ in: 'document-viewer' })); } catch (e) { uErr = e; }
	check('an unknown view is refused, listing the views on screen', !!uErr && /Views on screen now: preview, screen/.test(uErr.message), uErr && uErr.message);
	let hErr = null;
	try { await Shot.capture(JSON.stringify({ in: 'doc' })); } catch (e) { hErr = e; }
	check('a panel that is not shown is not a view', !!hErr && /No view called "doc"/.test(hErr.message), hErr && hErr.message);
	let sErr = null;
	try { await Shot.capture(JSON.stringify({ selector: '.doc-viewer' })); } catch (e) { sErr = e; }
	check('a guessed selector is refused, listing the views on screen', !!sErr && /Views on screen now: preview, screen/.test(sErr.message), sErr && sErr.message);
	let wErr = null;
	try { await Shot.capture('{}'); } catch (e) { wErr = e; }
	check('the whole page over the cap is refused, listing the views', !!wErr && /whole page/.test(wErr.message) && /Views on screen now/.test(wErr.message), wErr && wErr.message);
	let scErr = null, scJson = null;
	const kept = body.children.splice(0);
	body._rect = { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
	body.appendChild(preview);
	try { scJson = await Shot.capture(JSON.stringify({ in: 'screen' })); } catch (e) { scErr = e; }
	check('in:"screen" draws the window at its size', !scErr && !!scJson && JSON.parse(scJson).w === 1280 && JSON.parse(scJson).h === 800, scErr ? scErr.message : scJson && JSON.parse(scJson).w + 'x' + JSON.parse(scJson).h);
	body.children.splice(0); kept.forEach((k) => body.appendChild(k));

	// ---- (g) a see-through page is drawn over what is behind it in the app (2026-10-12) ----
	const clear = new FakeNode('BODY'); clear._bg = 'rgba(0, 0, 0, 0)';
	const savedBg = body._bg; body._bg = 'rgba(0, 0, 0, 0)';
	check('a see-through view takes the colour it is told is behind it', typeof Shot.backdrop === 'function'
		&& Shot.backdrop(clear, '', 'rgb(20, 24, 31)') === 'rgb(20, 24, 31)', Shot.backdrop && Shot.backdrop(clear, '', 'rgb(20, 24, 31)'));
	check('and white only when told nothing', !!Shot.backdrop && Shot.backdrop(clear, '') === '#ffffff');
	body._bg = savedBg;
	const csrc = readFileSync(join(HERE, 'crystal.js'), 'utf8');
	check('a crystal capture sends the app\'s colour behind the page as the fallback',
		/fallback: appBackdrop\(\)/.test(csrc) && /getElementById\('crystal-body'\)/.test(csrc) && /fallback:\s+typeof m\.fallback/.test(csrc));

	console.log(failures === 0 ? '\nALL PASS' : ('\n' + failures + ' FAILURE(S)'));
	if (failures) process.exitCode = 1;
}
main().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
