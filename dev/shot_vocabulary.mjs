// shot_vocabulary.mjs — the cropped screenshots for the guide's visual glossary.
//
// One crop per term on `guide/improve.html`, taken from the running app rather
// than drawn, because the whole point of that page is that a reader can see the
// thing and recognise it again. A drawing of a chip proves nothing about what a
// chip looks like.
//
// Each crop is taken by SELECTOR, with a little air around it, so a control that
// moves keeps its picture and a control that is renamed loses it loudly: a
// selector that matches nothing is reported and the shot is skipped rather than
// a full window being written under a crop's name.
//
// Everything is captured at the default palette the harness boots into, which is
// the dark one. The zone diagram beside these is drawn in CSS variables and
// follows the reader's own palette; a photograph cannot, and pretending
// otherwise would mean eleven copies of every crop.
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/shot_vocabulary.mjs
//
// Writes into www/guide/shots/. Needs dev/serve.mjs and dev/mockllm.mjs up.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, chat } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT  = path.join(HERE, '..', 'www', 'guide', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const s = await open({ name: 'Vocab' });
const p = s.page;
const made = [], missed = [];

/// Crop by selector, with `pad` pixels of the surface around it.
///
/// Clipped to the viewport, because a clip that runs off the screen is refused
/// by the browser and takes the whole run with it.
async function grab(name, sel, { pad = 6, scale = 2 } = {}) {
	const clip = await p.evaluate(({ sel, pad }) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		return {
			x: Math.max(0, Math.round(r.x - pad)),
			y: Math.max(0, Math.round(r.y - pad)),
			width:  Math.min(Math.round(r.width  + pad * 2), window.innerWidth  - Math.max(0, Math.round(r.x - pad))),
			height: Math.min(Math.round(r.height + pad * 2), window.innerHeight - Math.max(0, Math.round(r.y - pad))),
		};
	}, { sel, pad });
	if (!clip) { missed.push(`${name} — ${sel} is not on screen`); console.log(`  MISS ${name} — ${sel}`); return false; }
	await p.screenshot({ path: path.join(OUT, name), clip, scale: scale > 1 ? 'device' : 'css', timeout: 10000 });
	console.log(`  ${name}  (${clip.width}x${clip.height})`);
	made.push(name);
	return true;
}

/// Crop `sel` but stop where `until` begins, for a container holding two things
/// the glossary names separately.
async function grabTo(name, sel, until, { pad = 8 } = {}) {
	const clip = await p.evaluate(({ sel, until, pad }) => {
		const el = document.querySelector(sel), u = document.querySelector(until);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const bottom = u ? Math.min(r.bottom, u.getBoundingClientRect().top) : r.bottom;
		if (!r.width || bottom - r.top <= 0) return null;
		return {
			x: Math.max(0, Math.round(r.x - pad)),
			y: Math.max(0, Math.round(r.y - pad)),
			width:  Math.round(r.width + pad * 2),
			height: Math.round(bottom - r.top + pad),
		};
	}, { sel, until, pad });
	if (!clip) { missed.push(`${name} — ${sel} is not on screen`); console.log(`  MISS ${name} — ${sel}`); return false; }
	await p.screenshot({ path: path.join(OUT, name), clip, scale: 'device', timeout: 10000 });
	console.log(`  ${name}  (${clip.width}x${clip.height})`);
	made.push(name);
	return true;
}

const pause = (ms) => p.waitForTimeout(ms);

// ── The scene ────────────────────────────────────────────────────────
// Tags first: they are set in the store and read back on a reload, which is the
// one path that agrees with what a person would see.
await pause(1200);
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const list = JSON.parse(await app.list_diamonds());
	const tags = [['project', 'urgent'], ['topic']];
	for (let i = 0; i < list.length && i < tags.length; i++) {
		await app.set_tags(list[i].id, JSON.stringify(tags[i]));
	}
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'Vocab');
await pause(1500);
await p.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
await pause(500);

// ── The rail ─────────────────────────────────────────────────────────
await grab('vocab-chips.png',      '#panel-tags', { pad: 8 });
await grab('vocab-everything.png', '#pptw-global-row', { pad: 8 });
await grab('vocab-head.png',       '.rail-top .railhead', { pad: 8 });
await grab('vocab-tile-diamond.png', '.diamond-list .session-box', { pad: 8 });
await grab('vocab-tagfilter.png',  '#diamond-filter', { pad: 8 });
await grab('vocab-cog.png',        '.diamond-list .session-box .tile-cog', { pad: 14 });
// The rail's own closer, which is the one that speaks for the whole rail.
await grab('vocab-closer.png',     '#pptw-global-row [data-close]', { pad: 14 });

// The divider between the two lists: a 2px rule that turns accent under the
// pointer, shown hovered with the Chats head below it, because at rest it is a
// hairline and a picture of a hairline teaches nobody its name.
await p.hover('#handle-rail-split', { force: true }).catch(() => {});
await pause(400);
await grab('vocab-divider.png', '#handle-rail-split', { pad: 26 });

// ── The chat ─────────────────────────────────────────────────────────
await chat(s, 'Which zone is the dock in?');
await pause(1200);
await grab('vocab-tile-chat.png', '.session-list .session-box', { pad: 8 });
await grab('vocab-chead.png',     '#panel-ai .chead', { pad: 8 });
await grab('vocab-composer.png',  '#panel-ai .chat-input-bar', { pad: 8 });
await grab('vocab-spendrow.png',  '#spend-row', { pad: 10 });

// ── The admin panel ──────────────────────────────────────────────────
await p.evaluate(() => { const b = document.getElementById('settings-btn'); if (b) b.click(); });
await pause(900);
await p.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
await pause(500);
// Stopped above the spend row, which has a crop of its own: one picture per
// term, or a reader cannot tell which part of it the word names.
await grabTo('vocab-rows.png', '#admin-status', '#spend-row');

// ── A Diamond's two faces ────────────────────────────────────────────
await p.evaluate(() => {
	const t = document.querySelector('.diamond-list .session-box');
	if (t) t.click();
});
await pause(1500);
await grab('vocab-face.png', '#diamond-view', { pad: 10 });

// ── The paperclip ────────────────────────────────────────────────────
// On every row of the Workspace panel, and drawn only while something has the
// focus to attach to -- so this follows the Diamond above rather than standing
// on its own.
await p.evaluate(() => { if (window.DaimondPanels) DaimondPanels.show('work'); });
await pause(1500);
// The clip is `visibility: hidden` until the pointer is on its row, so the row
// is hovered and the WHOLE row is cropped: a paperclip on its own on a black
// square teaches a reader nothing about where to find one.
await p.hover('.files-row:has(.attach-btn)', { force: true }).catch(() => {});
await pause(400);
await grab('vocab-paperclip.png', '.files-row:has(.attach-btn)', { pad: 8 });

// ── The Go to box ────────────────────────────────────────────────────
// Ctrl-K is deliberately ignored while the caret is in a text field, and after
// the steps above it is in the composer.
await p.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
await p.keyboard.press('Control+k');
await pause(900);
// Left empty: the box's own placeholder says what it is for, and the resting
// list is panels, which is what a reader will have come to it for.
await grab('vocab-goto.png', '.pal-box', { pad: 10 });
await p.keyboard.press('Escape');
await pause(400);

// ── A dialog ─────────────────────────────────────────────────────────
// A chat tile's own cog dialog, which is the shape every dialog in the app has:
// a title, a closer on the same row, and the settings under it.
await p.evaluate(() => { const c = document.querySelector('.session-list .session-box .tile-cog'); if (c) c.click(); });
await pause(1000);
await grab('vocab-dialog.png', '.dlg-card', { pad: 10 });
await p.keyboard.press('Escape');
await pause(400);

// ── The gallery ──────────────────────────────────────────────────────
// The "⋯" chip only exists once the row cannot hold every chip, so the window is
// narrowed to make one rather than a panel being unpinned behind the reader's
// back.
await p.setViewportSize({ width: 1000, height: 900 });
await pause(800);
await p.evaluate(() => { const b = document.getElementById('panel-more'); if (b) b.click(); });
await pause(700);
await grab('vocab-gallery.png', '#panel-gallery', { pad: 10 });
await p.keyboard.press('Escape');
await pause(400);

// ── The phone shell: the drawer and the sheet ────────────────────────
// Reloaded at the phone size rather than resized into it. A window taken from
// 1500 to 1000 and then to 390 leaves the rail `display: none` and open at the
// same time, which is a layout the phone shell never reaches on its own and not
// what a reader would be looking at.
await p.setViewportSize({ width: 390, height: 844 });
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'Vocab');
await pause(2000);
await p.evaluate(() => { if (window.DaimondPanels) DaimondPanels.show('rail'); });
await pause(600);
await p.click('#drawer-btn', { force: true }).catch(() => {});
await pause(1000);
// The hamburger toggles, so a rail that was already open when the window
// narrowed ends up shut. Asked for by state rather than by another press.
await p.evaluate(() => { if (!document.body.classList.contains('drawer-open')) { const b = document.getElementById('drawer-btn'); if (b) b.click(); } });
await pause(900);
await grab('vocab-drawer.png', '#panel-rail', { pad: 0 });
await p.evaluate(() => { const sc = document.getElementById('scrim'); if (sc) sc.click(); });
await pause(800);
await p.evaluate(() => { if (window.DaimondSheet) DaimondSheet.open('work'); });
await pause(1500);
await grab('vocab-sheet.png', '#msheet', { pad: 0 });

console.log(`\n${made.length} crops written to www/guide/shots/`);
if (missed.length) { console.log('MISSED:'); missed.forEach((m) => console.log('  ' + m)); }
await s.close();
process.exit(missed.length ? 1 : 0);
