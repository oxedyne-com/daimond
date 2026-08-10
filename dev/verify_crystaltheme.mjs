// verify_crystaltheme — a page written before the palette fix is brought up to date,
// and a page nobody recognises is not touched.
//
// WHY THIS EXISTS. `theme()` lives inside the crystal page, not in the app: a page is copied
// from the shipped default when a Diamond first renders and is the user's own thereafter. So
// fixing the default reached no existing Diamond, and every page in a real workspace still
// applied the app's palette with `setProperty` on `documentElement` -- an inline style, which
// beats the page's own `:root{--bg:#fff}` rule. A user asked a daimon for a calendar widget and
// a white background in the same turn and got the widget: markup edits stuck, colour edits were
// overwritten a message later.
//
// The migration substitutes ONE block, matched byte for byte. The two properties that matter are
// therefore: it MUST reach an old page, and it MUST NOT touch a page it does not recognise --
// a page a model rewrote in its own style has widgets in it that no substitution should guess at.
//
// Each check is proved against the broken code before it is trusted: the mutation section at the
// end breaks the migration in the live page and requires the checks to go red.
import { open, shot } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const s = await open({ name: 'crystaltheme', signIn: true, connect: true, defaults: false });
const { page } = s;

// The exact block every page written before the fix carries.
const OLD = [
	'function theme(t){if(!t)return;var m={bg:"--bg",surface:"--sf",text:"--tx",',
	'muted:"--mu",border:"--bd",accent:"--ac",accentText:"--at",font:"--fo",',
	'mono:"--mo",size:"--fs",radius:"--rd"};',
	'for(var k in m)if(m.hasOwnProperty(k)&&t[k])',
	'document.documentElement.style.setProperty(m[k],t[k]);}',
].join('\n');

// ── The pure function, before any Diamond is involved ────────────────
const pure = await page.evaluate((OLD) => {
	const C = window.DaimondCrystal;
	if (!C || !C.upgrade) return { missing: true };
	// A page as it was written before the fix.
	const before = '<!doctype html><html><head><style>:root{--bg:#fff}</style></head>'
		+ '<body><select id="mine"><option>A</option></select><script>' + OLD + '<\/script></body></html>';
	const after = C.upgrade(before);
	return {
		missing: false,
		changed:  after !== null,
		keptWidget: after ? after.indexOf('<select id="mine">') !== -1 : false,
		oldGone:  after ? after.indexOf('documentElement.style.setProperty') === -1 : false,
		newThere: after ? after.indexOf('dc-theme') !== -1 : false,
		// A page that does not carry the block, byte for byte.
		strangerUntouched: C.upgrade('<!doctype html><html><body>hand written<\/body></html>') === null,
		// The shipped default is already current, so it is not rewritten on every render.
		defaultUntouched: C.upgrade(C.DEFAULT_PAGE) === null,
	};
}, OLD);

check('the app exposes the page upgrade at all', !pure.missing);
check('an old page is recognised and changed', pure.changed === true);
check('THE WIDGETS SURVIVE — only the theme block is substituted', pure.keptWidget === true);
check('the inline-style theme is gone', pure.oldGone === true);
check('and the style-element theme is in its place', pure.newThere === true);
check('A PAGE IT DOES NOT RECOGNISE IS RETURNED UNTOUCHED', pure.strangerUntouched === true);
check('the current default is not rewritten on every render', pure.defaultUntouched === true);

// ── End to end: an old page on a real Diamond is upgraded on disk ────
//
// The Diamond is made through the UI so the rail opens it, exactly as a person would; then its
// page is replaced with a pre-fix one and the face re-entered. Creating it through the wasm API
// alone leaves the rail unaware of it, the face never mounts, and the checks below then report
// on a Diamond nobody opened -- which reads as a broken migration and is a broken test.
await page.click('#new-diamond-btn', { force: true }).catch(() => {});
await page.waitForTimeout(900);
await page.fill('.dlg-input', 'ThemeMigrate').catch(() => {});
await page.click('.dlg-ok', { force: true }).catch(() => {});
await page.waitForTimeout(2500);

const made = await page.evaluate(async (OLD) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'ThemeMigrate');
	if (!d) return '';
	await app.run_tool('file_write', JSON.stringify({
		path: 'diamonds/' + d.id + '/crystal.json',
		content: JSON.stringify({ title: 'Theme migrate', summary: 'An old page.' }),
	}));
	const old = '<!doctype html><html><head><style>:root{--bg:#ffffff;--tx:#111}'
		+ 'html,body{background:var(--bg);color:var(--tx)}</style></head><body>'
		+ '<select id="mine"><option>A</option></select><div id="r"></div><script>'
		+ 'var D={};' + OLD
		+ 'function post(o){o.dc=1;o.v=1;parent.postMessage(o,"*");}'
		+ 'addEventListener("message",function(e){var m2=e.data||{};'
		+ 'if(m2.cmd==="data"){D=m2.data||{};theme(D._theme);'
		+ 'post({cmd:"rendered",keys:Object.keys(D).filter(function(k){return k[0]!=="_";})});'
		+ 'post({cmd:"height",px:200});}});post({cmd:"ready"});'
		+ '<\/script></body></html>';
	await app.run_tool('file_write', JSON.stringify({
		path: 'diamonds/' + d.id + '/crystal.html', content: old,
	}));
	return d.id;
}, OLD);
check('a Diamond was made carrying a pre-fix page', !!made);

// Leave the face and come back, which is what re-reads the page from disk.
await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await page.waitForTimeout(1200);
await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
await page.waitForTimeout(3000);

const after = await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const html = await app.run_tool('file_read', JSON.stringify({
		path: 'diamonds/' + id + '/crystal.html' }));
	return {
		onDisk:     String(html),
		mode:       window.DaimondCrystal ? DaimondCrystal._state().mode : '?',
	};
}, made);

check('OPENING THE DIAMOND REWROTE ITS PAGE ON DISK',
	after.onDisk.indexOf('dc-theme') !== -1,
	after.onDisk.indexOf('dc-theme') === -1 ? 'still the old theme' : 'upgraded');
check('and the widget in it survived the upgrade',
	after.onDisk.indexOf('<select id="mine">') !== -1);
check('the page still runs after being rewritten', after.mode === 'frame', after.mode);

await shot(s, 'crystaltheme-upgraded');

// ── Proving the checks against broken code ───────────────────────────
console.log('\n--- self-test: break the migration and require the checks to notice');
const broke = await page.evaluate(() => {
	const C = window.DaimondCrystal;
	if (!C) return false;
	C.__realUpgrade = C.upgrade;
	// The commonest way to get this wrong: rewrite the whole page instead of one block.
	Object.defineProperty(C, 'upgrade', { value: () => C.DEFAULT_PAGE, configurable: true });
	return true;
});
if (broke) {
	const mutated = await page.evaluate(() => {
		const C = window.DaimondCrystal;
		const after = C.upgrade('<html><body><select id="mine"></select></body></html>');
		return { keptWidget: after ? after.indexOf('<select id="mine">') !== -1 : false };
	});
	check('[self-test] a migration that rewrites the whole page LOSES the widget, and is caught',
		mutated.keptWidget === false);
	await page.evaluate(() => {
		const C = window.DaimondCrystal;
		Object.defineProperty(C, 'upgrade', { value: C.__realUpgrade, configurable: true });
	});
	const restored = await page.evaluate(() => {
		const C = window.DaimondCrystal;
		return C.upgrade('<html><body>nothing to do</body></html>') === null;
	});
	check('[self-test] and the real one is quiet again once restored', restored === true);
}

console.log(`\n${ok} ok, ${bad} failed`);
await s.browser.close();
process.exit(bad ? 1 : 0);
