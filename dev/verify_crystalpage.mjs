// verify_crystalpage.mjs — a Diamond's crystal is rendered by a page a MODEL
// wrote, and that page is a stranger in the house.
//
// The page is the first thing in this app that runs code the user never saw,
// written by a model that may itself have been steered by a web page it read a
// moment ago — and unlike every other injection surface here, this one PERSISTS.
// A hostile line in a page is exempt from the cap, absent from the standing
// context, unseen by the reducer and unseen by the fold diff: the one injection
// in Daimond that survives a turn, and it syncs to every device the user owns.
//
// TWO mechanisms hold it, and they close different halves of the problem.
//
// The SANDBOX stops the page READING. `allow-scripts` and nothing else, which is
// easy to lose: the page is served from a `blob:` URL, and a blob URL INHERITS
// OUR ORIGIN. Add `allow-same-origin` and the page is not sandboxed at all — it
// runs as Daimond, reads the `localStorage` the account key lives in, and reaches
// OPFS. Nothing about the screen would look different.
//
// The CONTENT SECURITY POLICY stops the page SENDING, and the sandbox does
// nothing about that. The page is handed the whole crystal by design, so without
// a policy a model-authored page can beacon it to a third party on every render,
// on every device, silently, with no egress gate anywhere near it. That is the
// same shape of risk that removed the `ask` verb, and `mount` answers it by
// injecting `default-src 'none'` into any page that did not bring its own.
//
// What is pinned here, in the order of how much damage its absence does:
//
//   1. The frame is sandboxed, and the sandbox is REAL — asserted by the parent
//      being unable to reach into the frame, not only by reading an attribute.
//   2. The page cannot reach the network. Asserted by the page TRYING, from
//      inside, and reporting that it was stopped.
//   3. There is no `ask` verb and no write verb. The channel is pull-only, and a
//      message claiming otherwise changes nothing. A parent cannot verify user
//      activation across the boundary, so a timer is indistinguishable from a
//      click; that is why `ask()` was dropped and why the ask-the-daimon box
//      lives in app chrome BELOW the frame, where a click is provably a person.
//   4. A message that is not from the frame's own `contentWindow`, or does not
//      carry `{dc:1, v:1}`, is ignored. Any script on the page can postMessage.
//   5. `asset` reads this Diamond's own files and nothing else.
//   6. A page that never answers falls back to the built-in view, visibly. This
//      is what a syntax error looks like from outside an opaque origin: there is
//      no error to see, only silence. So does a page that answers and reports
//      rendered keys NOT covering the data's content-carrying keys — the case a
//      naive test misses, and the one that catches a page rendering three
//      sections of seven after a key rename. So does a page that says `ready` and
//      never reports at all, and a page that navigates itself somewhere else.
//      (The Claude Artifacts lesson: the sandbox is not the hard part; everything
//      it forbids fails silently.)
//   7. Nothing is dropped. An unknown top-level key survives the built-in view
//      and a round trip through the form editor. Home Assistant is the precedent
//      — Lovelace's structured editor silently deletes `card_mod` config it
//      cannot express, and an LLM is not more careful than a form editor.
//   8. A link goes through the egress gate, and the gate is asked AGAIN for the
//      same host, because one reasonable approval must not let the page walk the
//      crystal out in URL fragments. A link to Daimond's own address never gets
//      that far: `egressAllowed` answers `allow` for our own host before any
//      field can influence it, so `crystal.js` refuses it itself.
//   9. The editor refuses unparseable JSON and says so. Today `editCrystal`
//      writes a textarea straight through — harmless for markdown, which has no
//      parse failure, and a data-loss path for JSON.
//
// THE INSTRUMENT, and why it is trustworthy. Most of these are assertions that
// NOTHING happened, and a probe that never fired satisfies every one of them. So
// the harness supplies each Diamond's page itself: a page that relays whatever
// the harness asks it to say, so a message under test genuinely originates in the
// frame's own `contentWindow` — nothing else can produce one. It also reports on
// its own document from the inside, which is the only place the injected policy
// and the resulting quirks mode can honestly be read. The egress check runs FIRST
// and proves the relay reaches the app; every "nothing happened" check below it
// is therefore about the app's answer and not about a dead probe.
//
// `DaimondCrystal._state()` exists for this file. It is used for the machine
// half of each fallback — which of the two reasons fired — and never on its own:
// a module agreeing with itself proves nothing about what a person sees, so every
// fallback is also read off the screen.
//
// How these go red (this lane could not run a browser, so the lead's batched pass
// is the first time they are exercised):
//
//   * add `allow-same-origin` to the sandbox → checks 1a and 1c go red, and 1c
//     stays red even if the attribute is later split across two `setAttribute`
//     calls that a string comparison would miss;
//   * skip the policy injection → the beacon check goes red and every other
//     check in the file stays green, which is exactly why it is here;
//   * put the injected `<meta>` ahead of the doctype → the quirks-mode check goes
//     red and the policy check stays green;
//   * accept a message without comparing `e.source` → the three source checks go
//     red and nothing else does;
//   * drop the coverage half of the fallback rule → the partial check goes red
//     and the timeout check stays green, which is the shape of the naive build;
//   * make the coverage rule "every key" rather than "every key that carries
//     content" → the sparse control goes red;
//   * memoise the egress answer per host → the second-time check goes red.
//
//   node dev/verify_crystalpage.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM: nothing
// here runs a turn.
import fs from 'node:fs';
import { open, scratch, signInAs, APP } from './harness.mjs';

const PROFILE = scratch('pw', 'crystalpage');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Apostrophes and runs of whitespace, flattened.
///
/// A string compared against what is on screen must survive the difference
/// between a typewriter apostrophe and a typographic one, and between a newline
/// in the source and a space in `innerText`. Neither difference is the property.
const norm = (x) => String(x == null ? '' : x)
	.replace(/[‘’ʼ´]/g, "'")
	.replace(/\s+/g, ' ')
	.trim();

/// The policy `mount` injects into a page that arrived without one.
///
/// READ FROM THE APP, not copied. A literal here goes green for ever the moment the
/// policy is tightened or loosened, which is the one thing a check on a security
/// property must not do -- it would have said "the page is given a policy" about
/// whatever string happened to be there. `DaimondCrystal.PAGE_CSP` is exported for
/// exactly this.
///
/// Reading it from the app makes THIS check self-consistent, so it cannot be the
/// only one: `admitsNoHost` below asserts the property the policy exists for, and
/// the beacon check asserts the consequence by trying the network from inside the
/// frame and being stopped. Those two are the evidence; this one only says the
/// page was given the app's policy rather than some other.
let POLICY = null;

/// Whether a policy admits no network origin at all.
///
/// The only sources allowed to appear are the ones that cannot reach a host:
/// `'none'`, `'self'` is NOT among them, `'unsafe-inline'`, and `data:`. Anything
/// naming a scheme, a wildcard or a domain is a way out, and the whole point of the
/// policy is that a page handed the crystal has none.
const admitsNoHost = (policy) => String(policy)
	.split(';')
	.map((d) => d.trim())
	.filter(Boolean)
	.every((d) => d.split(/\s+/).slice(1)
		.every((src) => /^('none'|'unsafe-inline'|data:)$/.test(src)));
/// A page that brought its own. Deliberately short of `style-src`, so "the page
/// kept its own" and "the app added its own as well" are different strings.
const OWN_POLICY = "default-src 'none'; script-src 'unsafe-inline'; img-src data:";
/// Somewhere that certainly answers, so a blocked beacon means the policy and not
/// a dead host. `no-cors`, so CORS cannot be mistaken for the thing under test.
const BEACON = APP + '/index.html';

// ── The probe pages ──────────────────────────────────────────────────
//
// Each is a real page written into a real Diamond's `crystal.html`, so the whole
// path runs: the store reads it, the app mounts it, the channel carries it.

/// A page that speaks the protocol and relays anything the harness asks it to say.
///
/// The relay is the only way to produce a message whose `source` really is this
/// frame's `contentWindow`. The echo goes back out under a verb the parent does
/// not know, so the harness can watch the far side of the channel — including the
/// parent's own answers — without changing what the app does with them.
///
/// # Arguments
/// * `o.report` - Source of a function returning the keys to report as rendered;
///   omit it entirely for a page that says `ready` and then nothing.
/// * `o.csp` - A policy the page brings itself, for the case where `mount` must
///   leave it alone.
const probePage = (o) => {
	o = o || {};
	const own = o.csp
		? '<meta http-equiv="Content-Security-Policy" content="' + o.csp + '">'
		: '';
	return [
		'<!doctype html><meta charset="utf-8"><title>probe</title>' + own,
		'<body><div id="out">probe page</div>',
		'<script>',
		'(function () {',
		'	var send = function (m) { parent.postMessage(m, "*"); };',
		'	addEventListener("message", function (e) {',
		'		var d = e.data;',
		'		if (!d || typeof d !== "object") return;',
		'		if (d.__say) { send(d.__say); return; }',
		'		if (d.__nav) { location.href = "about:blank"; return; }',
		'		if (d.__self) {',
		'			var ms = [].slice.call(document.querySelectorAll(',
		'				"meta[http-equiv=\'Content-Security-Policy\']"));',
		'			var out = {',
		'				compat:   document.compatMode,',
		'				doctype:  !!document.doctype,',
		'				policies: ms.map(function (m) { return m.getAttribute("content") || ""; }),',
		'			};',
		'			var done = function (b) {',
		'				out.beacon = b;',
		'				send({ dc: 1, v: 1, cmd: "__probe_echo", self: out });',
		'			};',
		'			try {',
		'				fetch("' + BEACON + '", { mode: "no-cors" })',
		'					.then(function () { done("allowed"); }, function () { done("blocked"); });',
		'			} catch (err) { done("blocked"); }',
		'			return;',
		'		}',
		'		send({ dc: 1, v: 1, cmd: "__probe_echo", said: d });',
		'		if (d.dc === 1 && d.cmd === "data") {',
		'			var data = d.data || {};',
		'			var keys = Object.keys(data);',
		'			document.getElementById("out").textContent = keys.join(", ");',
		(o.report
			? '			send({ dc: 1, v: 1, cmd: "rendered", keys: (' + o.report + ')(data, keys) });'
			: '			/* deliberately silent: ready, and then nothing at all */'),
		'		}',
		'	});',
		'	send({ dc: 1, v: 1, cmd: "ready" });',
		'}());',
		'<\/script>',
	].join('\n');
};

/// Every key it was given.
const REPORT_ALL = 'function (d, k) { return k; }';
/// The title and nothing else: a page that renders one section of several.
const REPORT_TITLE = 'function (d, k) { return k.filter(function (x) { return x === "title"; }); }';
/// Every key that carries content, and only those.
///
/// A key holding an empty string or an empty list has nothing to render, so a
/// page that skips it has skipped nothing, and a parent that fell back over it
/// would fall back on most Diamonds. Nor does this page report the channel's own
/// keys, the ones with a leading underscore: they are not the Diamond's data and
/// a page is not failing by leaving them out.
const REPORT_CARRYING = 'function (d, k) { return k.filter(function (x) {'
	+ ' var v = d[x];'
	+ ' if (x.charAt(0) === "_") return false;'
	+ ' if (v === "" || v === null || v === undefined) return false;'
	+ ' if (Array.isArray(v) && !v.length) return false;'
	+ ' return true; }); }';

/// A page that cannot be parsed, which is the failure the parent CANNOT see: no
/// error crosses an opaque origin, so silence is the only symptom.
const PAGE_BROKEN = '<!doctype html><meta charset="utf-8"><title>broken</title>'
	+ '<body>a page that will not parse<script>this is not ) valid javascript(<\/script>';

/// A real, protocol-speaking page with a solid background it chose for itself --
/// what a page looks like after a person asked the daimon for one, or hand-edited
/// `crystal.html` directly. Content is deliberately ONE short line, so the page's
/// own measured height is far short of the panel: the property under test is
/// whether the REST of the panel picks up this colour or the app's ordinary
/// chrome shows through beneath it.
const SOLID_BG = '#ff00aa';
const PAGE_SOLID_BG = [
	'<!doctype html><meta charset="utf-8"><title>solid</title>',
	'<style>html,body{background:' + SOLID_BG + ';margin:0;padding:0}',
	'body{font-family:sans-serif;color:#fff;padding:8px}</style>',
	'<body><div id="r"></div><script>',
	'(function(){',
	'var R=document.getElementById("r"),last=-1;',
	'function post(o){o.dc=1;o.v=1;parent.postMessage(o,"*");}',
	'function measure(){var px=Math.ceil(Math.max(document.body.scrollHeight,',
	'R.getBoundingClientRect().height))+2;',
	'if(Math.abs(px-last)<2)return;last=px;post({cmd:"height",px:px});}',
	'addEventListener("message",function(e){if(e.source!==parent)return;',
	'var m=e.data;if(!m||m.dc!==1||m.v!==1)return;',
	'if(m.cmd==="data"){var d=m.data||{};',
	'var h="<h1>"+(d.title||"")+"</h1><p>"+(d.summary||"")+"</p>";',
	// `lines`, rendered one `<p>` per entry: how the TALL fixture below gets
	// genuine, measurable content height rather than a hard-coded number this
	// page would have to be trusted to report honestly.
	'(d.lines||[]).forEach(function(l){h+="<p>"+l+"</p>";});',
	'R.innerHTML=h;',
	'post({cmd:"rendered",keys:Object.keys(d)});measure();}});',
	'if(window.ResizeObserver)new ResizeObserver(measure).observe(document.body);',
	'post({cmd:"ready"});',
	'})();',
	'<\/script>',
].join('\n');

// ── The fixtures ─────────────────────────────────────────────────────
const D = {
	good:    { name: 'Page Good',    page: probePage({ report: REPORT_ALL }) },
	broken:  { name: 'Page Broken',  page: PAGE_BROKEN },
	partial: { name: 'Page Partial', page: probePage({ report: REPORT_TITLE }) },
	silent:  { name: 'Page Silent',  page: probePage({}) },
	sparse:  { name: 'Page Sparse',  page: probePage({ report: REPORT_CARRYING, csp: OWN_POLICY }) },
	renav:   { name: 'Page Renav',   page: probePage({ report: REPORT_ALL }) },
	extra:   { name: 'Page Extra',   page: PAGE_BROKEN },
	bgshort: { name: 'Page BgShort', page: PAGE_SOLID_BG },
	bgtall:  { name: 'Page BgTall',  page: PAGE_SOLID_BG },
};
D.good.data = {
	title:    'The good page',
	summary:  'Everything here is rendered.',
	sections: [{ heading: 'One', body: 'The first thing.' }],
	facts:    [{ k: 'state', v: 'open' }],
};
D.broken.data  = { title: 'BROKEN-PAGE-TITLE', summary: 'The data must still be readable.' };
D.partial.data = {
	title:    'PARTIAL-PAGE-TITLE',
	summary:  'Shown by nothing.',
	sections: [{ heading: 'Unrendered', body: 'A section the page never drew.' }],
};
D.silent.data = { title: 'SILENT-PAGE-TITLE', summary: 'The page said hello and nothing else.' };
// Two keys that carry nothing. A page that skips them has skipped nothing.
D.sparse.data = { title: 'SPARSE-PAGE-TITLE', summary: 'All of it, drawn.', facts: [], open: [] };
D.renav.data  = { title: 'RENAV-PAGE-TITLE', summary: 'Then it went somewhere else.' };
// One short line, deliberately: the whole point of this fixture is that its
// measured content height is a fraction of the panel's.
D.bgshort.data = { title: 'BgShort', summary: 'One short line.' };
// The other half of the same fix, on the same page format: content that is
// genuinely tall, measured by the page itself rather than asserted here.
D.bgtall.data = {
	title: 'BgTall', summary: 'Overflow probe.',
	lines: Array.from({ length: 150 }, (_, i) => 'Line ' + i + ' of a very long crystal page.'),
};
// The unknown key is an OBJECT, not a string: a form that keeps unknown keys by
// stringifying them passes the easy version of this check and mangles the real
// one. And it does NOT begin with an underscore — those belong to the channel
// itself (`_theme`, `_labels`), and are stripped by design rather than dropped.
D.extra.data = {
	title:      'Extra keys',
	summary:    'Holds a key nothing in this app knows about.',
	provenance: { from: 'PROVENANCE-KEEPSAKE', when: 7, tags: ['a', 'b'] },
};

// The English the contract fixes for each string, used when the key is not in the
// table yet. `tOr('key', 'English')` renders exactly this, so the comparison holds
// whether or not the i18n lane has landed.
const EN = {
	'crystal.page_failed':  'This Diamond\'s page did not load, so its data is shown instead.',
	'crystal.page_partial': 'This Diamond\'s page did not show everything it holds, so its data is shown instead.',
	'crystal.page_reset':   'Reset the page',
	'crystal.edit_json':    'Edit as JSON',
	'crystal.json_invalid': 'That is not valid JSON, so nothing was saved.',
	'crystal.other_fields': 'Other fields',
	'crystal.field_title':  'Title',
	'common.save':          'Save',
};

const s = await open({ name: 'crystalpage', profile: PROFILE, connect: false });
const p = s.page;

/// The app's own words for a key, falling back to the contract's English when the
/// string has not landed. `t()` returns the KEY itself when it finds nothing, and
/// a check comparing against a raw key name would be comparing against noise.
const T = async (key) => {
	const got = await p.evaluate((k) => {
		try { return window.DaimondI18n ? DaimondI18n.t(k) : k; } catch (e) { return k; }
	}, key);
	return (got === key) ? EN[key] : got;
};

/// Open a Diamond by name and put its crystal face up.
///
/// Reports rather than throws: one fixture missing from the rail must cost the
/// checks that need it, not the whole run.
const showDiamond = async (name) => {
	const r = await p.evaluate((nm) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((b) => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
		if (!box) {
			return { ok: false, saw: [...document.querySelectorAll('#diamond-list .session-box-name')]
				.map((n) => (n.textContent || '').trim()).join(' | ') };
		}
		box.click();
		return { ok: true, saw: '' };
	}, name);
	check(r.ok, 'the Diamond "' + name + '" is on the rail', r.ok ? '' : 'rail holds: ' + r.saw);
	await p.waitForTimeout(700);
	await p.evaluate(() => {
		const b = document.getElementById('dview-crystal');
		if (b && b.getAttribute('aria-pressed') !== 'true') b.click();
	});
	await p.waitForTimeout(300);
	return r.ok;
};

/// Say something to the parent AS THE FRAME. Throws if there is no frame, so a
/// probe can never quietly measure nothing.
const say = (msg) => p.evaluate((m) => {
	const f = document.querySelector('.crystal-frame');
	if (!f || !f.contentWindow) throw new Error('there is no crystal frame to speak from');
	f.contentWindow.postMessage({ __say: m }, '*');
	return true;
}, msg);

/// Ask the page about its own document, from the inside.
const selfReport = async () => {
	await p.evaluate(() => {
		const f = document.querySelector('.crystal-frame');
		if (!f || !f.contentWindow) throw new Error('there is no crystal frame to ask');
		f.contentWindow.postMessage({ __self: 1 }, '*');
	});
	await p.waitForTimeout(2000);		// the beacon has to be given time to fail
	const rows = await p.evaluate(() => window.__seen.slice());
	const hit = rows.filter((x) => x.data && x.data.self).pop();
	return hit ? hit.data.self : null;
};

/// Wait for a dialog, answer it, and report what it said. `null` if none came.
const answerDialog = async (yes, ms = 3500) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const seen = await p.evaluate(() => {
			const d = document.querySelector('.dlg .dlg-card');
			return d ? { text: (d.innerText || d.textContent || '').slice(0, 400) } : null;
		});
		if (seen) {
			await p.evaluate((ok) => {
				const d = document.querySelector('.dlg .dlg-card');
				if (!d) return;
				const btn = ok ? d.querySelector('.dlg-ok')
					: (d.querySelector('.dlg-cancel') || d.querySelector('.dlg-ok'));
				if (btn) btn.click();
			}, yes);
			await p.waitForTimeout(250);
			return seen;
		}
		await p.waitForTimeout(100);
	}
	return null;
};

/// What is in the crystal panel now, as a person would find it.
const face = () => p.evaluate(() => {
	const wrap  = document.getElementById('crystal-frame-wrap');
	const frame = document.querySelector('.crystal-frame');
	const fb    = document.querySelector('.crystal-fallback');
	const note  = document.querySelector('.crystal-fallback-note');
	const reset = document.querySelector('.crystal-reset');
	const body  = document.getElementById('crystal-body');
	const seen  = (e) => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
	let st = null;
	try { st = window.DaimondCrystal ? DaimondCrystal._state() : null; } catch (e) { st = null; }
	return {
		hasWrap:   !!wrap,
		hasFrame:  !!frame,
		framed:    seen(frame),
		inWrap:    !!(frame && wrap && wrap.contains(frame)),
		sandbox:   frame ? frame.getAttribute('sandbox') : null,
		src:       frame ? String(frame.getAttribute('src') || '') : null,
		reachable: frame ? (frame.contentDocument !== null) : null,
		fallback:  seen(fb),
		note:      note ? (note.innerText || note.textContent || '') : null,
		reset:     reset ? (reset.innerText || reset.textContent || '') : null,
		text:      body ? (body.innerText || '') : '',
		mode:      st ? String(st.mode) : null,
		ready:     st ? !!st.ready : null,
		reason:    st ? (st.reason || '') : null,
		keys:      st ? (st.keys || []) : null,
	};
});

/// The crystal data as it is on disk, read through the store rather than through
/// whatever the panel believes it is showing.
const stored = (id) => p.evaluate(async (x) => {
	try { return await window.__probe.app.read_crystal_data(x); }
	catch (e) { return 'ERR ' + (e && e.message || e); }
}, id);

const ids = {};

try {
	await p.waitForTimeout(1500);

	// ── Build the fixtures through the store ─────────────────────
	const built = await p.evaluate(async (fix) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const absent = ['write_crystal_data', 'write_crystal_page', 'read_crystal_data']
			.filter((fn) => typeof app[fn] !== 'function');
		if (absent.length) return { absent };
		const out = {};
		for (const key of Object.keys(fix)) {
			const id = await app.create_diamond(fix[key].name);
			await app.write_crystal_data(id, JSON.stringify(fix[key].data));
			await app.write_crystal_page(id, fix[key].page);
			out[key] = id;
		}
		// A file of this Diamond's own, for the `asset` verb to find.
		await app.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + out.good + '/note.md', content: 'ASSET-IN-SCOPE\n' }));
		return { absent: [], ids: out };
	}, D);

	check(built.absent.length === 0, 'the engine can store a Diamond\'s data and its page',
		built.absent.length ? 'missing: ' + built.absent.join(', ') : '');
	Object.assign(ids, built.ids || {});

	// The rail is redrawn from disk the way a person would see it.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'crystalpage');
	await p.waitForFunction(() => !!window.DaimondCrystal && !!window.__daimondEgressAllowed,
		null, { timeout: 20000 }).catch(() => {});
	await p.waitForTimeout(1500);

	POLICY = await p.evaluate(() => (window.DaimondCrystal || {}).PAGE_CSP || '');
	check(!!POLICY, 'the app publishes the policy it injects, so this file need not keep a copy',
		'DaimondCrystal.PAGE_CSP was ' + JSON.stringify(POLICY));
	// The property, asserted independently of what the string happens to say. A
	// policy that admitted one host would still be "a policy", and the page is
	// handed the whole crystal.
	check(admitsNoHost(POLICY), 'and that policy admits no network origin anywhere in it',
		POLICY);

	const hasModule = await p.evaluate(() => !!(window.DaimondCrystal
		&& typeof DaimondCrystal.mount === 'function'
		&& typeof DaimondCrystal.parse === 'function'
		&& typeof DaimondCrystal._state === 'function'));
	check(hasModule, 'the crystal module is loaded, with the verifier hook',
		hasModule ? '' : 'window.DaimondCrystal is not there, or has no _state()');

	const FALLBACK_MS = await p.evaluate(() =>
		(window.DaimondCrystal && DaimondCrystal.FALLBACK_MS) || 1500);
	// Long enough that a slow machine is not mistaken for a silent page. A page
	// that says `ready` and then nothing is given TWO windows, because that is the
	// rule: the second one starts when the first is answered.
	const settle  = FALLBACK_MS + 2500;
	const settle2 = FALLBACK_MS * 2 + 3000;

	// The instruments. Reinstalled after the reload, because the reload took the
	// previous window with it — `__probe` included, which is why the store handle
	// is rebuilt here rather than reused from the fixture build above.
	await p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		window.__probe = {
			mod,
			app: new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
		};
		window.__gate = [];
		const realGate = window.__daimondEgressAllowed;
		window.__daimondEgressAllowed = function (payload) {
			window.__gate.push(String(payload));
			return realGate ? realGate.apply(this, arguments) : Promise.resolve('deny');
		};
		// A refused link must not be opened anyway. Stubbed rather than watched,
		// because a real tab in a headless run is a hang, not a failure.
		window.__opened = [];
		window.open = function (u) { window.__opened.push(String(u)); return null; };
		// Everything the frame says, and whether it really came from the frame.
		window.__seen = [];
		window.addEventListener('message', function (e) {
			let mine = false;
			try {
				const f = document.querySelector('.crystal-frame');
				mine = !!(f && e.source === f.contentWindow);
			} catch (x) { /* an opaque origin refuses the comparison */ }
			try { window.__seen.push({ mine, data: JSON.parse(JSON.stringify(e.data)) }); }
			catch (x) { window.__seen.push({ mine, data: null }); }
		});
	});
	const resetProbes = () => p.evaluate(() => {
		window.__gate = []; window.__opened = []; window.__seen = [];
		return true;
	});
	const probes = () => p.evaluate(() => ({
		gate:   window.__gate.slice(),
		opened: window.__opened.slice(),
		seen:   window.__seen.slice(),
	}));

	// ══ 1. The frame, and the sandbox ═══════════════════════════
	await resetProbes();
	await showDiamond(D.good.name);
	await p.waitForTimeout(settle);
	let f = await face();

	check(f.hasFrame && f.inWrap && f.framed,
		'a Diamond with a page shows it in a frame inside #crystal-frame-wrap',
		JSON.stringify({ frame: f.hasFrame, wrap: f.hasWrap, inWrap: f.inWrap, shown: f.framed }));
	// 1a. The attribute in full, so ADDING a token fails the check. A test for the
	// absence of `allow-same-origin` alone would wave through `allow-popups` and
	// `allow-top-navigation`, either of which lets the page act on the user's
	// behalf somewhere else.
	check(norm(f.sandbox) === 'allow-scripts',
		'the frame is sandboxed with allow-scripts and NOTHING else',
		JSON.stringify(f.sandbox));
	// 1b. And named, so a failure says which token arrived rather than printing
	// two strings and leaving the reader to diff them.
	const forbidden = String(f.sandbox || '').split(/\s+/).filter(Boolean)
		.filter((x) => x !== 'allow-scripts');
	check(forbidden.length === 0, 'no other sandbox token was granted', forbidden.join(', '));
	// 1c. THE PROPERTY, not the attribute. A frame in an opaque origin refuses the
	// parent's reach; a blob-URL frame with `allow-same-origin` hands its whole
	// document over. This is the check that survives the sandbox being set
	// somewhere the string comparison above is not looking.
	check(f.reachable === false,
		'and the sandbox is real: the parent cannot reach into the frame\'s document',
		'contentDocument reachable: ' + String(f.reachable));
	check(String(f.src).slice(0, 5) === 'blob:',
		'the page is served from a blob URL, which is why the sandbox matters',
		String(f.src).slice(0, 40));
	// 1d. The handshake completed. Everything below that asserts NOTHING happened
	// depends on this: a page that never loaded satisfies every negative check in
	// this file, and this is the positive that stops them being vacuous.
	check(!f.fallback && f.ready === true && !f.reason,
		'a page that answers and renders everything is left alone',
		JSON.stringify({ fallback: f.fallback, ready: f.ready, reason: f.reason }));
	const frameMode = f.mode;
	// 1e. And it was handed the crystal unprompted, which is the half of the
	// handshake nothing else here would notice: a parent that answered `ready` with
	// silence would leave a correct page drawing an empty document, and the page
	// would report no keys and be blamed for it.
	const handed = await p.evaluate(() => {
		const said = window.__seen.map((x) => x.data)
			.filter((d) => d && d.said && d.said.cmd === 'data').pop();
		return said ? Object.keys(said.said.data || {}) : null;
	});
	check(!!handed && handed.includes('title') && handed.includes('sections'),
		'and it was handed the crystal, unprompted, as soon as it said it was ready',
		JSON.stringify(handed));

	// ── The blob URL is spent once the page has it ───────────────
	// It inherits our origin, so anything else on the origin could fetch the page
	// back out of it for as long as it lives. The control fetch first, because a
	// `blob:` fetch that fails for some unrelated reason would make the real check
	// pass having proved nothing.
	const blob = await p.evaluate(async (src) => {
		const mine = URL.createObjectURL(new Blob(['control'], { type: 'text/html' }));
		let control = 'unknown', spent = 'unknown';
		try { await fetch(mine); control = 'fetchable'; } catch (e) { control = 'refused'; }
		URL.revokeObjectURL(mine);
		try { await fetch(src); spent = 'fetchable'; } catch (e) { spent = 'refused'; }
		return { control, spent };
	}, f.src);
	check(blob.control === 'fetchable', 'a live blob URL can be fetched from this page',
		blob.control);
	check(blob.spent === 'refused', 'and the page\'s own blob URL has already been revoked',
		blob.spent);

	// ══ 2. The page cannot reach the network ════════════════════
	//
	// The sandbox stops the page reading our storage and does nothing to stop it
	// SENDING, and the page is handed the whole crystal by design. Read from
	// inside the frame, because that is the only place the injected policy exists.
	await resetProbes();
	const self = await selfReport();
	check(!!self, 'the page can be asked about its own document',
		self ? '' : 'no self report came back from the frame');
	if (self) {
		check(self.beacon === 'blocked',
			'a page that tries to send the crystal to a third party is stopped',
			'the beacon was ' + String(self.beacon));
		check(self.policies.some((x) => norm(x) === norm(POLICY)),
			'because a page that brought no policy is given one',
			JSON.stringify(self.policies));
		// A `<meta>` ahead of the doctype puts the whole authored page into quirks
		// mode, which changes how every model-written stylesheet lays out.
		check(self.doctype === true && self.compat === 'CSS1Compat',
			'and the policy went in AFTER the doctype, so the page is not in quirks mode',
			'compatMode ' + String(self.compat) + ', doctype ' + String(self.doctype));
	}

	// ══ 3. `asset` reads this Diamond, and only this Diamond ════
	await resetProbes();
	await say({ dc: 1, v: 1, cmd: 'asset', id: 'in', path: 'note.md' });
	await say({ dc: 1, v: 1, cmd: 'asset', id: 'out', path: '../' + ids.extra + '/crystal.json' });
	await p.waitForTimeout(1500);
	let pr = await probes();
	const answered = (id) => {
		const hit = pr.seen.map((x) => x.data)
			.filter((d) => d && d.said && d.said.id === id).pop();
		return hit ? hit.said : null;
	};
	const inScope = answered('in');
	const escaped = answered('out');
	check(!!inScope && typeof inScope.text === 'string' && /ASSET-IN-SCOPE/.test(inScope.text),
		'a page may read a file of its own Diamond\'s',
		JSON.stringify(inScope).slice(0, 140));
	check(!!escaped && !escaped.text && !!escaped.error,
		'and a path climbing out of it is answered with an error, not a file',
		JSON.stringify(escaped).slice(0, 140));
	check(!/Extra keys|PROVENANCE/.test(JSON.stringify(escaped || {})),
		'so no other Diamond\'s crystal comes back through the channel');

	// ══ 4. A link goes through the egress gate ══════════════════
	//
	// Run before the "nothing happened" probes, because it is the one that proves
	// the relay reaches the app at all.
	await resetProbes();
	await say({ dc: 1, v: 1, cmd: 'open', href: 'https://elsewhere.test/one' });
	const askedOnce = await answerDialog(false);
	pr = await probes();
	check(!!askedOnce, 'a link the page asks to follow puts the question to the user',
		askedOnce ? askedOnce.text.slice(0, 80) : 'no dialog appeared within 3.5s');
	// THE DIALOG IS THE INSTRUMENT, not `window.__daimondEgressAllowed`. That global
	// is the bridge the WASM side calls, and it deliberately asks the gate without
	// the strict flag; a page's link goes through `pageEgressAllowed`, which calls
	// the gate directly and strictly. Hooking the global therefore watched a door
	// this traffic does not use, and the check passed or failed on the plumbing
	// rather than on the property.
	//
	// What the property actually is: the user is asked, and the question NAMES THE
	// DESTINATION. A dialog that asked "allow this link?" without saying where would
	// satisfy "the user was asked" and be worth nothing, since the whole risk is a
	// host that carries the crystal out in its path.
	check(/elsewhere\.test/.test(askedOnce ? askedOnce.text : ''),
		'and the question names the address, so the user can see where it goes',
		askedOnce ? askedOnce.text.slice(0, 160) : 'no dialog');
	check(pr.opened.length === 0, 'declining it opens nothing', pr.opened.join(', '));

	// The same host again. The gate remembers a host for ordinary fetches, which is
	// right for an agent reading a documentation site and wrong here: one yes about
	// a host would license every later `host/<the whole crystal>`.
	await resetProbes();
	await say({ dc: 1, v: 1, cmd: 'open', href: 'https://elsewhere.test/two' });
	const askedTwice = await answerDialog(false);
	pr = await probes();
	check(!!askedTwice, 'the SAME host is asked about again, with no memoisation',
		askedTwice ? '' : 'the second link went through without asking');
	check(/elsewhere\.test/.test(askedTwice ? askedTwice.text : ''),
		'and the second question names the address too',
		askedTwice ? askedTwice.text.slice(0, 160) : 'no dialog');

	// Daimond's own address gets no free pass — and cannot be given one at the
	// gate, which answers `allow` for our own host before any field of the request
	// can influence it. So the refusal has to happen before the gate is asked.
	// Non-vacuous because the two probes above went down the identical path and
	// did reach it.
	await resetProbes();
	const ownHref = await p.evaluate(() =>
		location.origin + '/guide/index.html?carried=' + 'x'.repeat(40));
	await say({ dc: 1, v: 1, cmd: 'open', href: ownHref });
	const askedOwn = await answerDialog(false);
	pr = await probes();
	// NOT VACUOUS: the two hrefs above went down the identical path and each raised a
	// dialog naming its host, so "no dialog" here is the refusal and not a broken
	// relay. It has to be refused BEFORE the gate, because the gate answers `allow`
	// for our own host before any field of the request can influence it -- so there
	// is no question that could be put to it that it would answer correctly.
	check(!askedOwn,
		'a link to Daimond\'s own address is refused before the gate, which would allow it',
		askedOwn ? askedOwn.text.slice(0, 160) : '');
	check(pr.opened.length === 0, 'and nothing is opened for it', pr.opened.join(', '));

	// ══ 5. No ask verb, and no write verb ═══════════════════════
	//
	// The relay is now known to reach the app, so a message that changes nothing is
	// the app refusing rather than the probe misfiring.
	const beforeVerbs = await stored(ids.good);
	await resetProbes();
	await say({ dc: 1, v: 1, cmd: 'ask', text: 'Type your passphrase to continue', id: 'a1' });
	await say({ dc: 1, v: 1, cmd: 'prompt', text: 'Anything at all' });
	const askedByPage = await answerDialog(false, 1500);
	check(!askedByPage, 'a page that claims an `ask` verb puts no question on screen',
		askedByPage ? askedByPage.text.slice(0, 120) : '');

	for (const verb of [
		{ dc: 1, v: 1, cmd: 'write', path: 'crystal.json', content: '{"title":"OWNED"}' },
		{ dc: 1, v: 1, cmd: 'save',  data: { title: 'OWNED' } },
		{ dc: 1, v: 1, cmd: 'set',   key: 'title', value: 'OWNED' },
		// `data` is the PARENT's verb. A handler keyed on the name alone, without
		// caring which way the message was travelling, would take this as a write.
		{ dc: 1, v: 1, cmd: 'data',  data: { title: 'OWNED' } },
	]) {
		await say(verb);
	}
	await p.waitForTimeout(1200);
	const afterVerbs = await stored(ids.good);
	check(afterVerbs === beforeVerbs, 'and no message from the page can write the crystal',
		String(afterVerbs).slice(0, 120));
	f = await face();
	check(f.hasFrame && !f.fallback,
		'the frame is still standing after all of that, so nothing threw',
		JSON.stringify({ frame: f.hasFrame, fallback: f.fallback, reason: f.reason }));

	// ══ 6. Who is speaking, and in what envelope ════════════════
	//
	// Any script on the page can postMessage, and the app's own window is the
	// easiest source of all to be.
	await resetProbes();
	await p.evaluate(() => window.postMessage(
		{ dc: 1, v: 1, cmd: 'open', href: 'https://topwindow.test/x' }, '*'));
	await p.waitForTimeout(900);
	pr = await probes();
	check(!pr.gate.some((x) => /topwindow\.test/.test(x)),
		'a message from the app\'s own window is not the page speaking, and is ignored',
		pr.gate.join(' | ').slice(0, 160));

	await resetProbes();
	await p.evaluate(() => {
		const f2 = document.createElement('iframe');
		f2.id = 'probe-stranger';
		f2.style.cssText = 'width:1px;height:1px;position:absolute;left:-9999px';
		f2.srcdoc = '<script>parent.postMessage('
			+ '{dc:1,v:1,cmd:"open",href:"https://stranger.test/x"}, "*");<\/script>';
		document.body.appendChild(f2);
	});
	await p.waitForTimeout(1200);
	pr = await probes();
	await p.evaluate(() => { const x = document.getElementById('probe-stranger'); if (x) x.remove(); });
	check(!pr.gate.some((x) => /stranger\.test/.test(x)),
		'nor is another frame on the page, however well it knows the protocol',
		pr.gate.join(' | ').slice(0, 160));

	await resetProbes();
	await say({ cmd: 'open', href: 'https://noenvelope.test/x' });
	await say({ dc: 1, cmd: 'open', href: 'https://noversion.test/x' });
	await p.waitForTimeout(900);
	pr = await probes();
	check(!pr.gate.some((x) => /noenvelope\.test/.test(x)),
		'a message with no `dc` marker is ignored even from the frame itself',
		pr.gate.join(' | ').slice(0, 160));
	check(!pr.gate.some((x) => /noversion\.test/.test(x)),
		'and so is one with no protocol version', pr.gate.join(' | ').slice(0, 160));
	// The control for the three above: the relay still works, so their silence is
	// the app's judgement and not a broken probe.
	await resetProbes();
	await say({ dc: 1, v: 1, cmd: 'open', href: 'https://stillworks.test/x' });
	const stillAsked = await answerDialog(false);
	pr = await probes();
	check(!!stillAsked || pr.gate.some((x) => /stillworks\.test/.test(x)),
		'while a properly addressed message from the frame still gets through, so '
		+ 'the four checks above are the app refusing and not the probe failing');

	// ══ 7. Falling back, visibly, for four different reasons ════
	const wantFailed  = await T('crystal.page_failed');
	const wantPartial = await T('crystal.page_partial');
	const wantReset   = await T('crystal.page_reset');

	await showDiamond(D.broken.name);
	await p.waitForTimeout(settle);
	const bro = await face();
	check(bro.fallback, 'a page that never answers is replaced by the built-in view',
		'still framed: ' + String(bro.framed));
	check(bro.reason === 'timeout', 'and the module knows why: it timed out',
		JSON.stringify(bro.reason));
	check(bro.mode !== frameMode, 'which is a different state from showing the page',
		JSON.stringify({ frame: frameMode, now: bro.mode }));
	check(bro.note !== null, 'the reason is on screen, not swallowed', 'no .crystal-fallback-note');
	check(norm(bro.note).includes(norm(wantFailed)),
		'saying the page did not load', JSON.stringify(String(bro.note).slice(0, 140)));
	check(bro.reset !== null && norm(bro.reset).includes(norm(wantReset)),
		'with a way to put the standard page back', JSON.stringify(bro.reset));
	check(/BROKEN-PAGE-TITLE/.test(bro.text),
		'and the Diamond\'s data is readable in it, which is the point of falling back');

	await showDiamond(D.partial.name);
	await p.waitForTimeout(settle);
	const par = await face();
	check(par.fallback && par.reason === 'partial',
		'a page that answers but renders only some of what it holds ALSO falls back',
		JSON.stringify({ fallback: par.fallback, reason: par.reason, keys: par.keys }));
	check(norm(par.note || '').includes(norm(wantPartial)),
		'and says THAT, rather than reporting a page that did not load',
		JSON.stringify(String(par.note).slice(0, 140)));
	// Two reasons, two notes. If the app shows one message for both, the user is
	// told to look for a load failure in a page that loaded perfectly well.
	check(norm(par.note || '') !== norm(bro.note || ''),
		'the two failures do not share one note', JSON.stringify(String(par.note).slice(0, 80)));
	check(/PARTIAL-PAGE-TITLE/.test(par.text), 'the data is readable in that one too');

	// A page that says hello and then nothing is UNVERIFIABLE, and unverifiable is
	// treated as broken. It is the rule most likely to be "fixed" later by somebody
	// who reads it as a bug, so it is pinned on its own.
	await showDiamond(D.silent.name);
	await p.waitForTimeout(settle2);
	const sil = await face();
	check(sil.fallback && sil.reason === 'partial',
		'a page that says `ready` and never reports what it drew falls back too',
		JSON.stringify({ fallback: sil.fallback, reason: sil.reason }));
	check(/SILENT-PAGE-TITLE/.test(sil.text), 'showing the data it never drew');

	// The control. Without it, "always fall back" passes every check above and the
	// page is never used at all.
	await showDiamond(D.sparse.name);
	await p.waitForTimeout(settle);
	const spa = await face();
	check(!spa.fallback && spa.hasFrame,
		'a page that renders every key CARRYING CONTENT is left alone, though it '
		+ 'reported nothing for the empty ones',
		JSON.stringify({ reason: spa.reason, keys: spa.keys }));
	// And that page brought its own policy, which must be left alone as well: a
	// second injected policy is not additive, it is the intersection, and it would
	// silently break a page that asked for something the default forbids.
	await resetProbes();
	const ownSelf = await selfReport();
	check(!!ownSelf && ownSelf.policies.some((x) => norm(x) === norm(OWN_POLICY)),
		'a page that brought its own policy keeps it',
		JSON.stringify(ownSelf && ownSelf.policies));
	// AND IS GIVEN OURS AS WELL. Two policies on one document are enforced
	// conjunctively -- a resource must satisfy both -- so ours can only ever
	// tighten what the page brought and can never widen it. Skipping injection for
	// a page that carries a policy of its own would hand the decision to the page,
	// which is written by the model this is defending against: it would only have
	// to declare a permissive policy of its own to be spared the real one.
	check(!!ownSelf && ownSelf.policies.some((x) => norm(x) === norm(POLICY)),
		'and is given ours as well, because two policies restrict and never widen',
		JSON.stringify(ownSelf && ownSelf.policies));

	// A page that navigates itself away has broken the channel: a reply must be
	// posted to `'*'`, because an opaque origin cannot be named, so whatever is in
	// the frame now would receive the next one.
	await showDiamond(D.renav.name);
	await p.waitForTimeout(settle);
	const before = await face();
	check(!before.fallback, 'the page that will navigate is showing first',
		JSON.stringify({ reason: before.reason }));
	await p.evaluate(() => {
		const fr = document.querySelector('.crystal-frame');
		if (fr && fr.contentWindow) fr.contentWindow.postMessage({ __nav: 1 }, '*');
	});
	await p.waitForTimeout(2500);
	const nav = await face();
	check(nav.fallback && nav.reason === 'partial',
		'a page that navigates itself somewhere else loses the channel and falls back',
		JSON.stringify({ fallback: nav.fallback, reason: nav.reason }));

	// ══ 8. Nothing is dropped ═══════════════════════════════════
	await showDiamond(D.extra.name);
	await p.waitForTimeout(settle);
	const ext = await face();
	check(ext.fallback, 'the Diamond with unknown keys is showing the built-in view',
		'the fixture needs the fallback up to read it');
	check(/PROVENANCE-KEEPSAKE/.test(ext.text),
		'and an unknown top-level key is rendered there rather than skipped',
		ext.text.slice(0, 160));

	const wantOther = await T('crystal.other_fields');
	const wantTitle = await T('crystal.field_title');
	const wantSave  = await T('common.save');
	const wantJson  = await T('crystal.edit_json');
	const wantBad   = await T('crystal.json_invalid');

	/// Click a control in the crystal panel by the words on it.
	const clickByText = async (words, what) => {
		const found = await p.evaluate((arg) => {
			const root = document.getElementById('crystal-view')
				|| document.getElementById('crystal-body');
			if (!root) return { ok: false, saw: 'no crystal panel' };
			const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
			const btns = [...root.querySelectorAll('button, [role="button"], a')];
			const hit = btns.find((b) => flat(b.textContent).indexOf(flat(arg.words)) >= 0);
			if (!hit) return { ok: false, saw: btns.map((b) => flat(b.textContent)).join(' | ') };
			hit.click();
			return { ok: true, saw: '' };
		}, { words });
		check(found.ok, 'the crystal offers ' + what, found.ok ? '' : 'controls on screen: ' + found.saw);
		await p.waitForTimeout(500);
		return found.ok;
	};

	const wasStored = await stored(ids.extra);
	if (await clickByText('✎', 'the ✎ editor')) {
		const form = await p.evaluate(() => {
			const f2 = document.querySelector('.crystal-form');
			const extra = document.querySelector('.crystal-form-extra');
			const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim();
			return {
				hasForm:  !!f2,
				hasExtra: !!extra,
				formTxt:  f2 ? flat(f2.innerText || f2.textContent) : '',
				extraTxt: extra ? flat(extra.innerText || extra.textContent) : '',
			};
		});
		check(form.hasForm, 'the ✎ editor is a form built from the core keys',
			form.hasForm ? '' : 'no .crystal-form');
		check(form.hasExtra, 'with a place for the fields it does not know',
			form.hasExtra ? '' : 'no .crystal-form-extra');
		check(/PROVENANCE-KEEPSAKE/.test(form.extraTxt),
			'and the unknown key is shown there, so nothing vanishes silently',
			form.extraTxt.slice(0, 160));
		check(norm(form.formTxt).includes(norm(wantOther)),
			'under a heading that says what those fields are',
			JSON.stringify(form.formTxt.slice(0, 120)));

		// A real edit, so the save is known to have written something. Saving an
		// untouched form and finding the file unchanged proves nothing at all: a
		// save that does nothing passes it.
		const typed = await p.evaluate((arg) => {
			const flat = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
			const rows = [...document.querySelectorAll('.crystal-form-row')];
			const row = rows.find((r) => {
				const lab = r.querySelector('label');
				return flat(lab ? lab.textContent : '').indexOf(flat(arg.title)) === 0;
			});
			const box = row ? row.querySelector('input, textarea') : null;
			if (!box) return { ok: false, saw: rows.map((r) => flat(r.textContent).slice(0, 30)).join(' | ') };
			box.value = 'Extra keys, retitled';
			box.dispatchEvent(new Event('input', { bubbles: true }));
			box.dispatchEvent(new Event('change', { bubbles: true }));
			return { ok: true, saw: '' };
		}, { title: wantTitle });
		check(typed.ok, 'the form has a field for the title, named as such',
			typed.ok ? '' : 'rows on screen: ' + typed.saw);

		await clickByText(wantSave, 'a way to save the form');
		await p.waitForTimeout(1200);
		const now = await stored(ids.extra);
		const kept = await p.evaluate((arg) => {
			const a = DaimondCrystal.parse(arg.was), b = DaimondCrystal.parse(arg.now);
			if (!a.ok || !b.ok) return { ok: false, why: 'one side did not parse' };
			return {
				wrote:   b.data.title === 'Extra keys, retitled',
				same:    JSON.stringify(a.data.provenance) === JSON.stringify(b.data.provenance),
				got:     JSON.stringify(b.data.provenance),
				had:     JSON.stringify(a.data.provenance),
				title:   String(b.data.title),
				summary: String(b.data.summary || ''),
			};
		}, { was: wasStored, now });
		check(kept.wrote, 'saving the form writes the change that was typed',
			'title on disk: ' + JSON.stringify(kept.title));
		check(kept.same, 'AND the unknown key comes back exactly as it went in',
			'was ' + kept.had + ', now ' + kept.got);
		check(/Holds a key nothing/.test(kept.summary || ''),
			'with the core keys it did not touch left alone', JSON.stringify(kept.summary));
	}

	// ══ 9. The editor refuses unparseable JSON ══════════════════
	const beforeJson = await stored(ids.extra);
	if (await clickByText('✎', 'the ✎ editor a second time')) {
		if (await clickByText(wantJson, 'raw JSON behind a second click')) {
			const put = await p.evaluate(() => {
				const ta = document.querySelector('.crystal-json');
				if (!ta) return false;
				ta.value = '{ "title": "half a document"';
				ta.dispatchEvent(new Event('input', { bubbles: true }));
				ta.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			});
			check(put, 'the raw JSON is in a .crystal-json box', put ? '' : 'no .crystal-json');
			await clickByText(wantSave, 'a way to save the raw JSON');
			await p.waitForTimeout(900);
			const said = await p.evaluate(() => ({
				body: (document.body.innerText || ''),
				dlg:  (document.querySelector('.dlg .dlg-card') || {}).innerText || '',
			}));
			check(norm(said.body + ' ' + said.dlg).includes(norm(wantBad)),
				'saving unparseable JSON says so',
				JSON.stringify(String(said.dlg || said.body).slice(-160)));
			const afterJson = await stored(ids.extra);
			check(afterJson === beforeJson,
				'and nothing is saved, which is the difference between markdown and data',
				String(afterJson).slice(0, 120));
			await answerDialog(true, 1200);
		}
	}

	// ══ 10. A page shorter than the panel still fills the panel ═══════
	//
	// notes4.txt: "When I changed the background of a crystal, it did not take
	// up the whole useable area of the panel." `PAGE_SOLID_BG` is one short
	// line on a solid colour it chose for itself -- so its OWN measured height
	// is a fraction of the panel's, and what is asked is whether the REST of
	// the panel picks up that colour or shows the app's ordinary chrome
	// beneath it.
	//
	// Measured, not eyeballed, and measured so the check DISCRIMINATES: a probe
	// that only asked "is the frame present" or "is SOME colour showing" would
	// read the same whether the frame fills the panel or stops a hundred pixels
	// in — coverage, the frame's height as a fraction of the panel's, is the
	// number that tells the two apart. Run against the code as it shipped
	// before this fix (`.crystal-frame` pinned to `height: <content px>`) this
	// reads about 12%; the fix (`height: 100%` floored by a `min-height` the
	// content sets) reads at or near 100%.
	await showDiamond(D.bgshort.name);
	await p.waitForTimeout(900);
	const cover = await p.evaluate(() => {
		const body  = document.getElementById('crystal-body');
		const frame = document.querySelector('.crystal-frame');
		const b = body ? body.getBoundingClientRect() : null;
		const f = frame ? frame.getBoundingClientRect() : null;
		return {
			bodyH:  b ? b.height : 0,
			frameH: f ? f.height : 0,
			// The colour a page too short to reach the bottom of `crystal-body`
			// would leave exposed there, sampled where the frame USED to stop.
			// `getComputedStyle` on an element outside the sandboxed frame --
			// this reads the app's own chrome, never the page's.
			belowColor: (b && f) ? getComputedStyle(body).backgroundColor
				: null,
		};
	});
	const coverage = cover.bodyH ? (cover.frameH / cover.bodyH) : 0;
	// A LITTLE under 100%, not exactly: a scrollbar or a sub-pixel layout
	// rounding is not the property under test. 85% is well clear of both —
	// and worlds away from the ~12% the code shipped with before this fix.
	check(coverage > 0.85,
		'a page far shorter than the panel still fills nearly all of it',
		`frame ${cover.frameH.toFixed(0)}px of ${cover.bodyH.toFixed(0)}px available `
			+ `(${(coverage * 100).toFixed(0)}%)`);

	// A page taller than the panel must still scroll rather than being
	// squashed down to the panel's own height -- the other half of the same
	// fix, on the same page format so the only variable is content length.
	await showDiamond(D.bgtall.name);
	await p.waitForTimeout(900);
	const tall = await p.evaluate(() => {
		const body  = document.getElementById('crystal-body');
		const frame = document.querySelector('.crystal-frame');
		return {
			bodyClientH: body ? body.clientHeight : 0,
			bodyScrollH: body ? body.scrollHeight : 0,
			frameH:      frame ? frame.getBoundingClientRect().height : 0,
		};
	});
	check(tall.frameH > tall.bodyClientH * 1.5,
		'a page much TALLER than the panel is not squashed down to fit it',
		`frame ${tall.frameH.toFixed(0)}px, panel ${tall.bodyClientH.toFixed(0)}px`);
	check(tall.bodyScrollH > tall.bodyClientH,
		'and the panel scrolls to reach the rest of it',
		`scrollHeight ${tall.bodyScrollH.toFixed(0)}px, clientHeight ${tall.bodyClientH.toFixed(0)}px`);

	// A resource the browser could not load is the dev stack, not the page: no
	// gateway runs here, so its probes answer 401 or 502 and neither is a throw.
	// The refused beacon and the spent blob URL are this file's own doing, and the
	// frame's own console never reaches us, which is the point of §5.
	//
	// `PAGE_BROKEN`'s parse error is NOT noise in the ordinary sense -- it is the
	// subject of check 6. A syntax error is the whole of what a page that never
	// answers looks like, and this file writes one deliberately to produce it. It
	// surfaces here because Playwright reports a frame's `pageerror` against the
	// page that holds the frame, so an error raised inside the opaque origin is
	// indistinguishable at this level from one the app raised. Matched on the
	// fixture's own text rather than on "SyntaxError", so a real syntax error
	// anywhere else -- in `crystal.js`, in the shipped page, in a page a model
	// wrote -- still fails this check, which is the only reason it exists.
	const noise = s.errs.filter((e) =>
		!/favicon|ERR_ABORTED|net::ERR|Failed to load resource|i18n: no string|Content Security Policy|Refused to connect/i.test(e)
		&& !/Unexpected identifier 'is'|Unexpected token '\)'/.test(e));
	check(noise.length === 0, 'the app threw nothing along the way', noise.slice(0, 3).join(' | '));

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
