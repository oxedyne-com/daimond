// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Wasm } from './wasm.js';
import { daimonOnScreen, pg, sessionList } from './state.js';
import { appCfgFor, fmtCtx, friendlyError, mark, t } from './util.js';
import { ChatStore, bumpDiamonds, chatMsgCount, msgTombstone, newMid, persistChats, touchChat,
	touchChatModel } from './chatstore.js';
import { deviceId, loadDevices } from './parcel_collect.js';
import { shortModel } from './parcel_apply.js';
import { noteHerePrompt, selfDeviceId } from './handoff.js';
import { captureSession, ensureApp } from './send.js';
import { queueBadge } from './steer.js';
import { isMobile, mshow } from './layout.js';
import { turnModelOf } from './rating.js';
import { renderEffortStep } from './sourcemenu.js';
import { toast } from './passkey_phrase.js';
import { CLOSE_SVG, appendCompacted, buildId, idCopyBtn } from './turns.js';
import { closerFor, closerRow, confirmDialog, keepFocusIn, noticeDialog, refocus } from './consent.js';
import { chatPairInForce, deleteChat, keepAsDiamond, mountPause, openFoldPicker, renameChat,
	renameDiamondTo, renderPendingCentre, repaintPause, selectChat, setTilePref, storedPick, tileDetail,
	tilePref } from './chats.js';
import { Instructions, Prompts, SYSTEM_PROMPT, steerListMount } from './pending.js';
import { Triggers, _daimonApps, _diamondApps, diamondAppKey, diamondEffort, diamondFolder,
	diamondModel, diamondModels, folderInReach, forgetDiamondWebConsent, loadDiamonds, resetDiamondApps,
	setDiamondFolder, setDiamondModel, triggerLabel } from './diamonds.js';
import { selectDiamond } from './agentspanel.js';
import { refreshDiamondAfterChange } from './crystal.js';
import { tOr } from './settingsui.js';
// page-split: end imports

// ── A tile's own colours ──────────────────────────────────
//
// Notes3: *"allow the user to change the tile background colour and the tile
// text colour. The colouring will carry over onto the Graph."* So the pair
// lives in the tile preferences, where the Graph can read it, and is applied
// here as inline style rather than as a class: a colour chosen from a picker
// is a value, and there is no finite set of classes it could come from.
//
// The text colour is written onto the CHILDREN as well as the box. The
// stylesheet names them individually -- `.session-box-name`, `.tile-label`
// and the meta spans each set their own `color` -- so a colour on the box
// alone would be overridden by every rule that mentions a child, and the tile
// would take a background and keep its old text.

/// `#RRGGBB`, or `''` for anything that is not one. A stored value reaches the
/// DOM as style, so it is checked rather than trusted.
function tileHex(v) {
	return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : '';
}

/// Which elements inside a tile carry their own text colour.
var TILE_INK = '.session-box-name, .tile-label, .session-box-ctx, .session-box-time,'
	+ ' .session-box-cost, .session-box-spend, .tile-model-chip, .tile-row-label,'
	// A chat's identity and its opening line. Both set their own `color` in
	// the stylesheet — `.tile-when-sub` and `.tile-preview` are deliberately
	// quieter than the name beside them — so a tile given a colour would take
	// the background and leave these two in the theme's grey, which on a dark
	// chosen colour is the pair going invisible. Named here for the reason
	// the comment above gives: a colour on the box alone is overridden by
	// every rule that mentions a child.
	+ ' .tile-when, .tile-when-sub, .tile-preview';

/// Paint one tile box from the stored pair. Both empty restores the theme's
/// own colours, because clearing an inline style is how a value stops
/// applying.
export function paintTileColour(box, id) {
	if (!box) return;
	var p  = tilePref(id);
	var bg = tileHex(p.bg), fg = tileHex(p.fg);
	box.style.backgroundColor = bg;
	box.style.color = fg;
	// Also as custom properties, so anything drawn into the tile later can ask
	// the tile what it is rather than reading storage a second time.
	if (bg) box.style.setProperty('--tile-bg', bg); else box.style.removeProperty('--tile-bg');
	if (fg) box.style.setProperty('--tile-fg', fg); else box.style.removeProperty('--tile-fg');
	var ink = box.querySelectorAll(TILE_INK);
	for (var i = 0; i < ink.length; i++) ink[i].style.color = fg;
}

/// Repaint every box that stands for this id, wherever it is drawn.
function applyTileColour(id) {
	var boxes = document.querySelectorAll('.session-box[data-id="' + cssId(id) + '"]');
	for (var i = 0; i < boxes.length; i++) paintTileColour(boxes[i], id);
}

/// Say that a tile's colours moved, for the surfaces that draw the same
/// object somewhere else. The Graph is the one that asked for it; the event
/// is how it hears without the rail knowing the Graph exists.
function signalTileColour(id) {
	try {
		document.dispatchEvent(new CustomEvent('daimond-tile-colour-changed', { detail: { id: id } }));
	} catch (e) { /* best effort */ }
}

// A cog, drawn rather than typed. `⚙` is a font's idea of a cog and comes
// out as a smudge at 16px in the faces this app ships; the chevrons beside
// the composer were redrawn for the same reason.
//
// A toothed body, not a hub with spokes around it. The first drawing here was
// eight radial ticks that did not touch the centre disc, and magnified it was
// plainly a SUN -- the brightness control, on a settings button. Teeth join
// the body; rays do not. Same path as the mailbox gear, so the app has one
// cog rather than two.
export var COG_D = 'M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2v.2'
	+ 'a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1'
	+ 'a1.7 1.7 0 00-1.2-2.9H2.9a2 2 0 110-4H3a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1'
	+ 'a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V2.9a2 2 0 114 0V3'
	+ 'a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9'
	+ 'a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z';

/// The cog in a tile's top right. `name` is what the tile is called, so five
/// tiles do not announce as five identical "Settings".
export function tileCog(name, onOpen) {
	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'tile-cog';
	b.title = t('tile.settings');
	b.setAttribute('aria-label', t('tile.settings_named', { name: name || '' }));
	b.setAttribute('aria-haspopup', 'dialog');
	// A constant string: nothing here comes from the user or a model.
	b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
		+ '<circle cx="12" cy="12" r="3"/><path d="' + COG_D + '"/></svg>';
	b.addEventListener('click', function (e) {
		// The tile opens on click; the cog must not open it as well.
		e.stopPropagation();
		e.preventDefault();
		onOpen();
	});
	return b;
}

/// The × in a chat tile's top right, restored beside the cog (notes4,
/// "the closer came back"). It does not merely hide the tile: a chat is
/// ephemeral but not disposable, so `onClose` is `deleteChat`, the SAME
/// path the cog's own dialog offers at its foot -- one function that knows
/// how to end a chat, not two that could drift.
///
/// Titled "Delete" rather than "Close" (CHAT-13/B18): the glyph is a ×
/// everywhere else in this app, but "Close" reads as dismissing a panel,
/// not as moving a conversation to the Trash -- the same act the dialog's
/// own foot button already calls Delete.
///
/// `name` labels the button the way `tileCog` labels itself, so a screen
/// reader hears which chat a × belongs to rather than a bare "Delete".
function tileCloser(name, onClose) {
	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'tile-x';
	b.title = t('tile.dlg_delete');
	b.setAttribute('aria-label', t('tile.delete_named', { name: name || '' }));
	b.innerHTML = CLOSE_SVG;
	b.addEventListener('click', function (e) {
		// Same reason as the cog: the tile itself must not also open.
		e.stopPropagation();
		e.preventDefault();
		onClose();
	});
	return b;
}
// page-split: install 100

export function openTileDialog(opts) {
	var back = document.createElement('div');
	back.className = 'modal dlg tile-dlg';
	var card = document.createElement('div');
	card.className = 'modal-card dlg-card tile-dlg-card';
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-modal', 'true');

	// The title row: the object's name, and the way out beside it. `ui-head`
	// as well as `tile-dlg-title`, because this row is where the app's title
	// row was worked out and the rest of the app wears it now.
	var top = document.createElement('div');
	top.className = 'tile-dlg-title ui-head';
	var h = document.createElement('h2');
	h.textContent = opts.name || t('tile.settings');   // escaped via textContent (H5)
	// Named by its own heading. `a11y_report.md` §5 counts every dialog in the
	// app as an unlabelled div, so a new one does not join them: the words are
	// already on screen and this is what points the tree at them.
	h.id = 'tile-dlg-h-' + (++pg._tileDlgSeq);
	card.setAttribute('aria-labelledby', h.id);
	// Built by the shared factory, which is where the drawn cross, the spoken
	// name and the thumb floor now live. `tile-dlg-x` and `tile-dlg-done` ride
	// along: the second has never meant "the button that says Done" -- it
	// means "the control that finishes with this dialog", which is what the
	// rest of the app and the escapability checks reach for.
	var x = closerFor(opts.name || t('tile.settings'), 'tile-dlg-x tile-dlg-done');
	top.appendChild(h);
	top.appendChild(x);
	card.appendChild(top);

	// ── The order, and it is the same order for a Diamond and for a chat
	// (CRY-15): Name → Model → Colour → the act → Advanced → Delete. What a
	// person opened the cog to CHANGE is above the fold and what they opened
	// it to LOOK UP is behind the disclosure, so the cog means one thing
	// whichever tile it sits on. It used to open on the pause transport and
	// put the name — the one field anybody edits — below three model
	// pulldowns.
	//
	// The advanced half is built here and appended at the END, so a section
	// can be mounted into it from wherever it reads best above. Its own
	// contents go in in reading order, which is why the pause section is
	// filled in first and the name section written second.
	var adv = advancedBox();

	// ── Advanced. Running, the helper models, the triggers and the template:
	// four things worth reaching and none worth meeting.
	var sayPause = null;		// set only where a pause control was placed
	if (window.DaimondPause && opts.node) {
		adv.appendChild(secHead(t('tile.dlg_running')));
		var prow = document.createElement('div');
		prow.className = 'tile-dlg-pause';
		// The same widget as the rail and the tile, never a second drawing of
		// it: two pictures of one state drift the first time either changes.
		mountPause(prow, opts.node, opts.name || '');
		var pwords = document.createElement('span');
		pwords.className = 'tile-dlg-pause-words';
		sayPause = function () {
			var st = 'play';
			try { st = DaimondPause.state(opts.node) || 'play'; } catch (e) { /* module not up */ }
			pwords.textContent = t('pause.state_' + st);
		};
		sayPause();
		window.addEventListener('daimond:pause', sayPause);
		prow.appendChild(pwords);
		adv.appendChild(prow);
	}

	// ── Name, first for both kinds.
	if (opts.models === 'diamond') mountDiamondName(card, opts, h);
	// A chat's rename used to be the tile's own double-click, which put the
	// one gesture a chat obviously offered — pretending a throw-away
	// conversation is a kept thing — in front of everybody. The tile now
	// offers Keep instead, and this is the honest use: a chat somebody
	// genuinely is coming back to tomorrow. Empty puts the derived label
	// back rather than storing a blank name, so the field is also the undo.
	if (opts.chat) mountChatName(card, opts.chat, h);

	// ── Model. A Diamond's daimon model is here, its helper and images
	// models in `adv`, because they are answers to "what do the workers run
	// on", which nobody asks on the way past. A chat's model is here too: a
	// chat that can start is started at once (CHAT-01), so its tile never
	// shows the pending pulldown, and without this row a chat could only
	// ever run on the starred default.
	if (opts.models === 'diamond') mountDiamondModels(card, adv, opts);
	// ── Folder, a Diamond's own place on its runner (HATE-7).
	if (opts.models === 'diamond') mountDiamondFolder(card, opts);
	if (opts.chat) mountChatModel(card, opts.chat);

	// ── Colour, which the tile takes at once and the Graph takes with it.
	mountTileColour(card, opts);

	// ── Giving this Diamond to somebody, for a Diamond. Above the fold and
	// not inside it: a share is a thing a person came here to DO, and the
	// template below — the shape of it without the contents — is where they
	// go when there is nobody to send to.
	if (opts.models === 'diamond') mountShare(card, opts);

	// ── The two ways to turn a chat into a Diamond (CHAT-15), moved off the
	// row and into the cog: see `mountChatFoldKeep`. Acts, so they sit beside
	// Share rather than under Advanced.
	if (opts.chat) mountChatFoldKeep(card, opts.chat, close);

	// ── Context. Only for a chat, which is the only thing here that HAS a durable
	// conversation to fold; a Diamond's daimon has one from phase E. A reading,
	// so it belongs with the rest of what is looked up rather than changed.
	if (opts.chat) mountContextSection(adv, opts.chat);

	// ── Triggered actions, for a Diamond.
	if (opts.models === 'diamond') mountTriggers(adv, opts);

	// ── A template of this Diamond, for a Diamond. BELOW the triggers, because
	// the section immediately above is the one thing a template deliberately
	// leaves behind, and reading them in that order is the explanation.
	if (opts.models === 'diamond') mountTemplate(adv, opts);

	// Nothing to disclose, no disclosure: an empty "Advanced" is a control
	// that teaches people not to press the next one.
	if (adv.childNodes.length > 1) card.appendChild(adv);

	// ── The foot, which is now Delete and nothing else. Done has become the
	// closer cross above, so the destructive act no longer shares a row with
	// the thumb that meant to dismiss.
	var row = document.createElement('div');
	row.className = 'dlg-actions tile-dlg-foot';
	var del = document.createElement('button');
	del.type = 'button';
	// PLAIN, not the red pill it was (CRY-15). A Diamond deleted here goes to
	// the trash and can be restored, so the loudest control in the dialog was
	// the most reversible thing in it; the weight belongs on what the person
	// came to change. What it does, and whether it asks first, is unchanged.
	del.className = 'dlg-ok tile-dlg-delete';
	del.textContent = t('tile.dlg_delete');
	row.appendChild(del);
	card.appendChild(row);

	back.appendChild(card);
	document.body.appendChild(back);
	var lid = DaimondLayers.open(DaimondLayers.uid('dialog'), function () { close(); });

	var prev = document.activeElement;
	// Captured while the opener is still in the document: a panel that redraws
	// underneath replaces its CHILDREN and keeps its own box, so this survives
	// where `prev` does not. See `refocus`.
	var prevHost = (prev && prev.closest) ? prev.closest('[id]') : null;
	function close() {
		document.removeEventListener('keydown', onKey, true);
		if (sayPause) window.removeEventListener('daimond:pause', sayPause);
		back.remove();
		DaimondLayers.done(lid);
		refocus(prev, prevHost);
	}
	function onKey(e) {
		if (e.key === 'Tab') keepFocusIn(card, e);
	}
	document.addEventListener('keydown', onKey, true);
	back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
	x.addEventListener('click', close);
	del.addEventListener('click', async function () {
		// The dialog goes first: a confirm drawn over its own opener reads as
		// two modals, and the answer is about the tile, not about the dialog.
		close();
		await opts.onDelete();
	});
	// The way out takes the focus, as Done used to: it is the control a reader
	// arriving by keyboard most likely wants, and it is the one Escape mirrors.
	x.focus();
	return { card: card, close: close };
}

/// Give this Diamond to somebody: the share sheet, behind the cog.
///
/// BEHIND THE COG, for the reason `mountTemplate` gives: everything about ONE
/// Diamond is behind its cog, and "give this to somebody" is the most obvious
/// thing a person wants to do with the one in front of them. The Share view of
/// the Social panel keeps the same sheet for the Diamond that is open; this is
/// the door that names WHICH diamond, which is why the panel's own line now
/// points here when nothing is open.
///
/// THE SHEET IS share.js's AND IS NOT REBUILT HERE. A second one would be a
/// second place for the key line, the conversation tick and "they will own the
/// copy" to be drawn, and the one that stopped being drawn would be the one
/// nobody was looking at.
function mountShare(card, opts) {
	if (!window.DaimondShare || typeof DaimondShare.sheet !== 'function') return;
	card.appendChild(secHead(tOr('share.section', 'Share')));
	card.appendChild(DaimondShare.sheet({ id: opts.id, name: opts.name }));
}

/// Save this Diamond's shape as a template file.
///
/// BEHIND THE COG, because everything about ONE Diamond is behind its cog and
/// a person looking for "what can I do with this Diamond" looks there. Its
/// counterpart -- OPENING a template -- is in the Share view of the Social
/// panel instead: that act is about no Diamond in particular, and it is the
/// one place in the app where something arrives as a FILE and is asked about
/// before it is written.
///
/// The two facts a person cannot guess are said here rather than only in the
/// dialog the file route draws: a template leaves the triggers behind on
/// purpose, and opening one mints a new Diamond.
function mountTemplate(card, opts) {
	if (!window.DaimondShare || typeof DaimondShare.saveTemplate !== 'function') return;
	card.appendChild(secHead(tOr('tmpl.section', 'Template')));

	var note = document.createElement('p');
	note.className = 'tile-dlg-note';
	note.textContent = tOr('tmpl.dlg_help',
		'A template carries this diamond’s shape — the page it draws through, its '
		+ 'automation, and whatever a capp keeps beside itself — and none of what it has '
		+ 'recorded. Triggered actions are left out on purpose: a trigger fires with '
		+ 'nobody pressing anything, and one carried across would start work on somebody '
		+ 'else’s machine because they opened a file. Whoever opens it gets a NEW '
		+ 'diamond; nothing of theirs is written over.');
	card.appendChild(note);

	// The door back to a complete copy, off by default. It is a second decision
	// and a bigger one -- the memory, the kept conversation and a capp's entries
	// are the Diamond's CONTENTS, and a template is its shape.
	var row = document.createElement('div');
	row.className = 'tile-dlg-field tile-dlg-tmpl';
	var box = document.createElement('input');
	box.type = 'checkbox';
	box.className = 'tile-dlg-check';
	box.id = 'tile-tmpl-conv-' + pg._tileDlgSeq;
	var lab = document.createElement('label');
	lab.className = 'tile-dlg-label';
	lab.htmlFor = box.id;
	lab.textContent = tOr('tmpl.with_conversation', 'Include what it has recorded');
	lab.title = tOr('tmpl.with_conversation_help',
		'Carries everything instead: the memory, the kept conversation and a capp’s own '
		+ 'entries. Still a template, so it still opens as a new diamond.');
	row.appendChild(box);
	row.appendChild(lab);
	card.appendChild(row);

	var say = document.createElement('p');
	say.className = 'tile-dlg-note tile-dlg-say';
	say.hidden = true;

	var btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tile-dlg-tmpl-save';
	btn.textContent = tOr('tmpl.save', 'Save as a template…');
	btn.addEventListener('click', async function () {
		btn.disabled = true;
		say.hidden = false;
		say.classList.remove('warn');
		say.textContent = tOr('tmpl.saving', 'Making the template…');
		try {
			var json = await DaimondDiamond.template(opts.id, box.checked);
			// The name is the Diamond's, so two templates of two Diamonds do not
			// arrive as one file called "template".
			var file = DaimondShare.saveTemplate(opts.name || opts.id, json);
			say.textContent = tOr('tmpl.saved',
				'Saved as {file}. Anybody you give it to opens it as a diamond of their '
				+ 'own, from the Share view of the Social panel.', { file: file });
		} catch (e) {
			say.classList.add('warn');
			say.textContent = friendlyError(e);
		}
		btn.disabled = false;
	});
	card.appendChild(btn);
	card.appendChild(say);
}

/// The rename field in a Diamond's cog dialog. Same shape as `mountChatName`
/// below, but committing through `rename_diamond` rather than `renameChat` --
/// a Diamond's name lives in the store, not in a rail record kept locally.
function mountDiamondName(card, opts, h) {
	card.appendChild(secHead(tOr('tile.dlg_name', 'Name')));
	var row = document.createElement('div');
	row.className = 'tile-dlg-name';
	var input = document.createElement('input');
	input.type = 'text';
	input.className = 'tile-dlg-name-input';
	input.value = opts.name || '';
	input.spellcheck = false;
	input.setAttribute('autocomplete', 'off');
	input.setAttribute('data-1p-ignore', '');
	input.setAttribute('data-lpignore', 'true');
	input.setAttribute('aria-label', tOr('tile.dlg_name', 'Name'));
	input.addEventListener('change', function () {
		var nn = input.value.trim();
		if (!nn || nn === opts.name) { input.value = opts.name || ''; return; }
		renameDiamondTo(opts.id, opts.name, nn, function (n2) {
			opts.name = n2;
			input.value = n2;
			if (h) h.textContent = n2;
		}).catch(function (e2) {
			input.value = opts.name || '';
			noticeDialog(t('rail.rename_failed'), friendlyError(e2));
		});
	});
	input.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
	});
	row.appendChild(input);
	card.appendChild(row);
}

/// The folder field in a Diamond's cog dialog (HATE-7): a typed or pasted absolute path,
/// refused with one sentence when it is not absolute or lies outside every runner's reach.
/// Empty clears it. The browse picker waits on a runner that can list folders.
function mountDiamondFolder(card, opts) {
	card.appendChild(secHead(t('tile.dlg_folder')));
	var input = document.createElement('input');
	input.type = 'text';
	input.className = 'tile-dlg-name-input tile-dlg-folder-input';
	input.value = diamondFolder(opts.id);
	input.placeholder = t('tile.dlg_folder_ph');
	input.title = t('tile.dlg_folder_help');
	input.spellcheck = false;
	input.setAttribute('autocomplete', 'off');
	input.setAttribute('aria-label', t('tile.dlg_folder'));
	var say = document.createElement('p');
	say.className = 'tile-dlg-note tile-dlg-say warn';
	say.hidden = true;
	input.addEventListener('change', function () {
		var v = input.value.trim();
		var why = folderRefusal(v);
		say.hidden = !why;
		say.textContent = why;
		if (why) return;
		setDiamondFolder(opts.id, v);
		input.value = v;
	});
	card.appendChild(input);
	card.appendChild(say);
}

/// The sentence a typed folder is refused with, '' when it may be kept.
function folderRefusal(v) {
	if (!v) return '';
	if (v.charAt(0) !== '/') return t('tile.dlg_folder_abs');
	var pr = {};
	var P = window.DaimondPresence;
	try { pr = (P && P.snapshot && P.snapshot()) || {}; }
	catch (e) { pr = {}; }
	return folderInReach(v, pr) ? '' : t('tile.dlg_folder_reach', { path: v });
}

/// The two ways to turn a chat into a Diamond, off the row (CHAT-15) and
/// into the cog instead: `chat` is the same object the row's own buttons
/// used to act on, so pressing either here does exactly what pressing it on
/// the row always did.
///
/// FOLD AND KEEP ARE NOT THE SAME ACT. Fold runs the reducer on a Diamond
/// that already exists and writes a SUMMARY into its crystal, at the cost
/// of a paid round trip; Keep makes a NEW Diamond and carries the
/// transcript in whole, consults no model and costs nothing. Both are
/// offered because somebody reaching for the cog may want either.
function mountChatFoldKeep(card, chat, close) {
	var row = document.createElement('div');
	row.className = 'tile-dlg-actions';
	var fold = document.createElement('button');
	fold.type = 'button';
	fold.className = 'tile-fold' + (chat.foldedInto ? ' folded' : '');
	// Labelled by what pressing it walks you through rather than the
	// internal verb "Fold" (CHAT-15): the row's own tooltip already said
	// this, and now it is the word itself.
	fold.textContent = chat.foldedInto ? t('tile.folded')
		: tOr('tile.turn_into_diamond', 'Turn into a Diamond…');
	fold.title = chat.foldedInto
		? t('tile.folded_help', { name: chat.foldedInto.name })
		: t('tile.fold_all_help');
	// THE DIALOG GOES ONCE A DIAMOND IS CHOSEN, as it does for Delete. It is the
	// settings of a chat that is about to be folded and sent to the Trash, and
	// left open it covered the fold's outcome and its Undo row, which a dialog
	// covers like the rest of the page (UNDO-ROW, r547): the Undo was unreachable
	// for the whole of its window. Closed at the choice, not at the press, so a
	// person who backs out of the picker is still in their settings.
	fold.addEventListener('click', function () { openFoldPicker(chat, fold, undefined, close); });
	row.appendChild(fold);
	var keep = document.createElement('button');
	keep.type = 'button';
	keep.className = 'tile-keep';
	keep.textContent = tOr('tile.keep', 'Keep');
	keep.title = tOr('tile.keep_help',
		'Make a diamond of this chat, with the whole conversation as its first artefact.');
	keep.addEventListener('click', function () {
		keepAsDiamond(chat.id).catch(function (err) { toast(friendlyError(err), true); });
	});
	row.appendChild(keep);
	card.appendChild(row);
}

/// The rename field in a chat's cog dialog. See the call site for why it is
/// here and not on the tile.
///
/// # Arguments
/// * `card` - The dialog card to append to.
/// * `chat` - The chat being renamed.
/// * `h` - The dialog's own heading, which names the chat and has to follow.
function mountChatName(card, chat, h) {
	card.appendChild(secHead(tOr('tile.dlg_name', 'Name')));
	var row = document.createElement('div');
	row.className = 'tile-dlg-name';
	var input = document.createElement('input');
	input.type = 'text';
	input.className = 'tile-dlg-name-input';
	input.value = chat.name || '';
	input.spellcheck = false;
	input.setAttribute('autocomplete', 'off');
	input.setAttribute('data-1p-ignore', '');
	input.setAttribute('data-lpignore', 'true');
	input.setAttribute('aria-label', tOr('tile.dlg_name', 'Name'));
	// On `change`, so a name is committed when the field is left or Enter is
	// pressed rather than on every keystroke -- which would put a save and a
	// sync nudge behind each letter typed.
	input.addEventListener('change', function () {
		renameChat(chat, input.value);
		if (h) h.textContent = chatDisplayName(chat);
	});
	input.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
	});
	row.appendChild(input);
	card.appendChild(row);
}

/// The model a chat answers with, changed from its cog.
///
/// The same row as a Diamond's daimon: the search-filter field, and a Change
/// button that shows only while the pick differs from the model in force. The
/// conversation carries over -- the thread is the chat's, not the model's, and
/// `ensureApp` re-seeds the whole persisted history into the new model's
/// session on the next turn. Refused while a turn is running: the turn holds
/// the old session and would write its reply back over the switch.
function mountChatModel(card, chat) {
	if (!window.DaimondModels) return;
	card.appendChild(secHead(t('tile.dlg_models')));
	var r = document.createElement('div');
	r.className = 'tile-dlg-field tile-dlg-model tile-dlg-chat-model';
	var lab = document.createElement('label');
	lab.className = 'tile-dlg-label';
	lab.textContent = t('tile.model_chat');
	lab.htmlFor = 'tile-model-chat-' + pg._tileDlgSeq;
	var sel = document.createElement('select');
	sel.className = 'tile-model';
	sel.id = lab.htmlFor;
	sel.title = t('tile.model_chat_help');
	// The pair in force, the default's for a chat that follows it (U1c).
	var inForce = function () {
		return chatPairInForce(chat) || { provider: chat.provider || '', model: chat.model || '' };
	};
	populateModelSelect(sel, inForce().model, inForce().provider);

	var change = document.createElement('button');
	change.type = 'button';
	change.className = 'tile-dlg-apply';
	change.textContent = t('tile.model_change');
	change.title = t('tile.chat_model_change_help');
	change.hidden = true;
	var pendingPick = null;			// the pick awaiting a Change press, or null when it matches

	sel.addEventListener('change', function () {
		var p = DaimondModels.pick(sel);
		var plan = DaimondModels.planModelSwitch(inForce(), p, 0);
		pendingPick   = plan.changed ? { provider: p.provider || '', model: p.model || '' } : null;
		change.hidden = !plan.changed;
	});
	change.addEventListener('click', async function () {
		if (!pendingPick) return;
		var before = inForce();
		// The model moved in another tab, say: nothing to switch.
		if (!DaimondModels.planModelSwitch(before, pendingPick, 0).changed) {
			pendingPick = null; change.hidden = true; return;
		}
		if (chat._generating) {
			await noticeDialog(t('tile.chat_model_busy_title'), t('tile.chat_model_busy'));
			return;
		}
		// Only a pair some key can run: a sealed provider's rows are disabled in
		// the list, but the key may have been sealed since it was drawn.
		var res = DaimondModels.resolve(pendingPick.provider, pendingPick.model);
		if (!res) { toast(t('chat.no_key_start'), true); return; }
		// The workers go with the chat unless the user set them apart from it.
		var wk = DaimondModels.workerAfterSwitch(before, res,
			{ provider: chat.workerProvider || '', model: chat.workerModel || '' });
		// Stored as picks (U1c): the default chosen here is "follows", and workers equal
		// to the chat's model follow the chat.
		var own = storedPick(res, DaimondModels.getDefault());
		var wks = storedPick(wk, res);
		chat.model          = own.model;
		chat.provider       = own.provider;
		chat.workerModel    = wks.model;
		chat.workerProvider = wks.provider;
		// The Effort goes with the model only where the new one offers that level.
		var eff = DaimondModels.effortAfterSwitch(chat.effort || '', res.provider, res.model);
		chat.effort = eff.effort;
		// A DaimondApp's model and key are fixed at construction, so the cached one
		// goes and `ensureApp` builds the next on the new pair, history and all.
		chat.app = null;
		// The model half, on its own stamp (U1c), so a rename elsewhere is not lost.
		touchChatModel(chat);
		persistChats();
		pendingPick   = null;
		change.hidden = true;
		renderSessionList();
		// A pending chat that can now start, starts (CHAT-01).
		if (chat.status === 'pending' && pg.current === chat) renderPendingCentre(chat);
		if (pg.current === chat) renderEffortStep();
		toast(t('tile.chat_model_changed', {
			from: shortModel(before.model, before.provider) || t('tile.model_none'),
			to:   shortModel(res.model, res.provider),
		}) + effortClearedNote(eff, res.provider, res.model));
	});

	r.appendChild(lab); r.appendChild(sel);
	card.appendChild(r);
	DaimondModels.picker(sel);
	r.appendChild(change);
	// The chat's Effort is not here: it is in the composer row, turn by turn (D-20261014-08).
}

/// The quiet half-sentence a model change adds when it cleared an Effort the new model
/// does not offer, or '' when nothing was cleared.
export function effortClearedNote(eff, provider, model) {
	return (eff && eff.cleared) ? ' ' + t('tile.effort_cleared', { model: shortModel(model, provider) }) : '';
}

/// The tile's two colours, and a way back to the theme's own.
///
/// A native colour input is used rather than a palette of swatches. The
/// author asked for "the tile background colour and the tile text colour",
/// not for a set of approved ones, and every platform already has a picker
/// that people know how to drive — including one that reads out on a phone.
///
/// The tile behind the dialog changes as the picker moves, because a colour
/// described in a preview box is a colour you have to imagine against the
/// rail; the rail is right there.
function mountTileColour(card, opts) {
	card.appendChild(secHead(tOr('tile.dlg_colour', 'Colour')));

	/// One labelled picker. `field` is `'bg'` or `'fg'`.
	function pick(field, labelText, fallback) {
		var r = document.createElement('div');
		r.className = 'tile-dlg-field tile-dlg-colour';
		var lab = document.createElement('label');
		lab.className = 'tile-dlg-label';
		lab.textContent = labelText;
		lab.htmlFor = 'tile-col-' + field + '-' + pg._tileDlgSeq;
		var inp = document.createElement('input');
		inp.type = 'color';
		inp.className = 'tile-dlg-swatch';
		inp.id = lab.htmlFor;
		// An unset colour still has to show the picker something, so it shows
		// what the tile is drawn in now — which is what the user is changing
		// FROM, and the least surprising place for the picker to open.
		inp.value = tileHex(tilePref(opts.id)[field]) || fallback;
		inp.addEventListener('input', function () {
			setTilePref(opts.id, field, inp.value);
			applyTileColour(opts.id);
			signalTileColour(opts.id);
			sayContrast();
		});
		r.appendChild(lab); r.appendChild(inp);
		card.appendChild(r);
		return inp;
	}

	// Read off the tile itself rather than guessed, so the picker opens on the
	// colour actually on screen in whichever theme and skin is up.
	var box = document.querySelector('.session-box[data-id="' + cssId(opts.id) + '"]');
	var seen = box ? getComputedStyle(box) : null;
	var bgIn = pick('bg', tOr('tile.colour_bg', 'Background'), rgbHex(seen && seen.backgroundColor, '#1b1b1b'));
	var fgIn = pick('fg', tOr('tile.colour_fg', 'Text'),       rgbHex(seen && seen.color,           '#e6e6e6'));

	// Between the pickers and the way back to the theme's own colours, which is
	// the one-press remedy: the trouble, and then what undoes it.
	// `role="status"` so a reader who is not looking at the swatch is told the
	// sentence has appeared -- politely, and only when it changes.
	var faint = document.createElement('div');
	faint.className = 'tile-dlg-note warn';
	faint.setAttribute('role', 'status');
	faint.hidden = true;
	card.appendChild(faint);

	/// Say when the pair now on screen is hard to read, and stop saying it when
	/// it is not.
	///
	/// Whichever colour the user has NOT set is read off the tile rather than
	/// assumed: there are eleven palettes and both light and dark ink, so a
	/// guessed default would be wrong more often than right, and would warn
	/// about pairs that are perfectly legible in the theme that is up.
	function sayContrast() {
		var p    = tilePref(opts.id);
		var live = box ? getComputedStyle(box) : null;
		var bg   = tileHex(p.bg) || (box ? paintedBg(box) : '');
		var fg   = tileHex(p.fg) || rgbHex(live && live.color, '');
		// No tile on screen and nothing stored: there is no pair to judge, and a
		// warning drawn on a guess is worse than none.
		if (!bg || !fg) { faint.hidden = true; return; }
		var r = contrastRatio(bg, fg);
		if (r >= TILE_CONTRAST_MIN) { faint.hidden = true; return; }
		var words = tOr('tile.colour_faint',
			'These two contrast at {ratio}:1, below the usual {min}:1 floor for text '
				+ 'this size. Left as chosen.',
			{ ratio: r.toFixed(1), min: TILE_CONTRAST_MIN.toFixed(1) });
		if (faint.textContent !== words) faint.textContent = words;
		faint.hidden = false;
	}
	sayContrast();

	var row = document.createElement('div');
	row.className = 'tile-dlg-seg';
	var clear = document.createElement('button');
	clear.type = 'button';
	clear.className = 'tile-dlg-level tile-dlg-clear';
	clear.textContent = tOr('tile.colour_clear', 'Use the theme’s colours');
	clear.addEventListener('click', function () {
		setTilePref(opts.id, 'bg', null);
		setTilePref(opts.id, 'fg', null);
		applyTileColour(opts.id);
		signalTileColour(opts.id);
		// The pickers follow the tile back, or they would go on showing a
		// colour nothing is painted in.
		var now = box ? getComputedStyle(box) : null;
		bgIn.value = rgbHex(now && now.backgroundColor, bgIn.value);
		fgIn.value = rgbHex(now && now.color, fgIn.value);
		sayContrast();
	});
	row.appendChild(clear);
	card.appendChild(row);
}

// ── Whether a chosen pair can be read ─────────────────────
//
// The pickers take any two colours, and black on black is two valid answers.
// The ruling is to WARN AND ALLOW: the app does not argue with a deliberate
// act, and a colour is about as deliberate as an act gets. So nothing here
// blocks, overrides or nudges a value — it puts a sentence under the pickers
// and takes it away again when the pair is legible.

/// Below this ratio the dialog says so. WCAG's floor for ordinary text, and a
/// tile IS ordinary text: the name is 13px and the meta line 11px, nowhere
/// near the 18pt that would licence the looser 3:1. Warning at 3:1 would stay
/// silent through pairs no one can read at that size, and the cost of warning
/// too eagerly is one grey sentence, against a tile that cannot be read.
var TILE_CONTRAST_MIN = 4.5;

/// WCAG relative luminance of an `#RRGGBB`.
function srgbLum(hex) {
	var v = [1, 3, 5].map(function (i) {
		var c = parseInt(hex.substr(i, 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/// The WCAG ratio between two `#RRGGBB`, from 1 (the same colour) to 21.
function contrastRatio(a, b) {
	var la = srgbLum(a), lb = srgbLum(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/// What is actually painted behind an element: its own background, or the
/// first ancestor's that is not see-through.
///
/// A tile with no colour of its own has a TRANSPARENT background, so reading
/// `background-color` off it and stopping there would score every unset tile
/// against `rgba(0,0,0,0)` — black — and warn about pairs the reader can see
/// perfectly well. A partly transparent ground is taken at face value rather
/// than blended, which is close enough to decide a threshold on and is the
/// only case here that is an approximation.
function paintedBg(el) {
	for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
		var c = rgbHex(getComputedStyle(n).backgroundColor, '');
		if (c) return c;
	}
	return rgbHex(getComputedStyle(document.body).backgroundColor, '#1b1b1b');
}

/// A computed `rgb(...)` or `rgba(...)` as `#RRGGBB`, or `fallback` for
/// anything a colour input cannot open on: another colour space, or fully
/// transparent, whose channels are `0 0 0` and would offer black.
function rgbHex(v, fallback) {
	var m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(String(v || ''));
	if (!m) return fallback;
	if (m[4] !== undefined && Number(m[4]) === 0) return fallback;
	return '#' + [1, 2, 3].map(function (i) {
		return ('0' + (Number(m[i]) & 255).toString(16)).slice(-2);
	}).join('');
}

/// How full this conversation is, where it will fold, and a way to fold it now.
///
/// The figures existed and were unreachable: `FOLD_AT` is a constant in `compact.rs`,
/// and the window an agent is really folding against — which a provider's refusal can
/// have shrunk — had no getter at all. A user watching a meter climb could not tell
/// "nearly there" from "plenty of room", and had no way to act on it either way.
///
/// **Folding costs money.** The summary is written by a model, so the button says what
/// it is about to do rather than doing it and reporting afterwards.
function mountContextSection(card, chat) {
	if (chat.status === 'pending') return;   // nothing has been said yet
	card.appendChild(secHead(t('tile.dlg_context')));

	var line = document.createElement('div');
	line.className = 'tile-dlg-note';
	function say() {
		var win = chatWindow(chat);
		var last = chat.lastPrompt || 0;
		if (!win.window) { line.textContent = t('tile.context_unknown'); return; }
		line.textContent = t('tile.context_line', {
			used: fmtCtx(last),
			all:  fmtCtx(win.window),
			at:   Math.round(win.foldAt * 100),
		});
	}
	say();
	card.appendChild(line);

	var row = document.createElement('div');
	row.className = 'tile-dlg-seg';
	var fold = document.createElement('button');
	fold.type = 'button';
	fold.className = 'tile-dlg-level';
	fold.textContent = t('tile.fold_context');
	fold.title = t('tile.fold_context_help');
	fold.addEventListener('click', function () { return foldChatNow(chat, fold, say); });
	row.appendChild(fold);
	card.appendChild(row);
}

/// Has anything been said in this conversation?
///
/// The transcript on screen, or the model's own copy of it: either one is a
/// conversation, and the two are separate stores. Emphatically NOT `chat.app`, which
/// answers a different question -- "was an engine built during this page load" -- and
/// is null for every chat after a reload, however much was said before it.
export function chatSaid(chat) {
	if (!chat) return false;
	// `chatMsgCount`, not `messages.length`: a chat whose transcript is not resident
	// still has content, and reading the empty array alone would hide Fold on a
	// daimon conversation that plainly has one (seq 213, Stage 1).
	if (chatMsgCount(chat) > 0) return true;
	if (chat.session && chat.session.msgs && chat.session.msgs.length) return true;
	return (chat.sessionMsgs || 0) > 0;
}

// Mirrors `compact::MIN_KEEP_MESSAGES` (src/compact.rs) -- see `foldChatNow`,
// the one place this is read.
var FOLD_MIN_KEEP_MESSAGES = 6;

/// Fold a chat's context now, on the user's say-so.
///
/// One implementation, two callers: the tile dialog and the Fold button in
/// the chat header. Folding is an action taken MID-FLOW -- you do it when a
/// thread has grown heavy, not when you are configuring something -- so it
/// belongs on the surface as well as in the dialog, and both must be the
/// same fold.
///
/// # Arguments
/// * `chat` - The conversation to fold.
/// * `btn` - The control pressed, disabled while it runs.
/// * `onDone` - Run once the fold has landed. The dialog passes the function that
///   redraws its context line; the header has no line to redraw and passes nothing.
async function foldChatNow(chat, btn, onDone) {
	var fold = btn || {};
	if (chat._generating) { toast(t('tile.fold_mid_turn'), true); return; }
	// WHETHER THERE IS A CONVERSATION, not whether an engine object happens to exist.
	// The guard used to read `chat.app`, which `hydrateChat` nulls on every reload, so
	// a thread of two hundred messages was told nothing had been said in it. Where the
	// conversation is real and the engine is not, build one: `ensureApp` is idempotent,
	// seeds the persisted session back in, and is the same path a turn takes.
	if (!chatSaid(chat)) { toast(t('tile.fold_unavailable'), true); return; }
	// NOTHING TO FOLD IS CHECKED BEFORE ASKING -- and before building an engine
	// at all -- not after (B18/annoyance 15: a two-message chat used to be asked
	// "Fold this conversation?" and only THEN told there was nothing to do).
	// `MIN_KEEP_MESSAGES` (6) is `fold_by_hand`'s own floor in src/compact.rs --
	// below it there is no tail to cut, and neither the engine nor a provider
	// key is needed to know that. Not exhaustive: a handful of unusually bulky
	// messages can still fold above this count, and that heavier case still
	// builds the engine, still asks, and still pays for it, exactly as before --
	// this only catches the short, free, common one without making the user
	// answer a question -- or this app mint an engine -- for nothing.
	if (chatMsgCount(chat) <= FOLD_MIN_KEEP_MESSAGES) { toast(t('tile.fold_nothing')); return; }
	var app;
	// `ensureApp` constructs a wasm `DaimondApp` and can throw -- no key, no module --
	// which is why every other caller wraps it. A fold that cannot start says so with
	// the reason rather than dying in a rejection nobody sees.
	try { app = ensureApp(chat); }
	catch (e) { noticeDialog(t('tile.fold_failed'), friendlyError(e)); return; }
	// No check for `fold_now` itself beyond the above. An engine too old to have it
	// throws on the call below and is reported as the failure it is, which names the
	// real fault; refusing here would have to borrow `fold_unavailable`, and that
	// sentence is about a chat with nothing in it.
	var ok = await confirmDialog(t('tile.fold_context_body'), t('tile.fold_context_ok'),
		{ title: t('tile.fold_context_title'), danger: false });
	if (!ok) return;
	fold.disabled = true;
	var moved = false;
	try {
		// The same sink a turn uses, and the same handling: a fold the user asked
		// for is written into the thread and persisted exactly as an automatic one
		// is. Anything less would leave the transcript quietly shorter than it was,
		// which is the one thing `appendCompacted` exists to prevent.
		moved = await app.fold_now(function (ev) {
			if (!ev || ev.type !== 'compacted') return;
			var manualFoldTs = Date.now(), manualMid = newMid();
			var manualRow = { role: 'fold_log', content: ev.content || '',
				folded: ev.folded || 0, kept: ev.kept || 0, mid: manualMid, ts: manualFoldTs };
			var mfprod = foldProd(chat, app, ev, manualMid, '');
			if (mfprod) manualRow.prod = [mfprod];
			chat.messages.push(manualRow);
			if (pg.current && pg.current.id === chat.id) {
				appendCompacted(ev.content || '', ev.folded, ev.kept, manualFoldTs);
			}
		});
	} catch (e) {
		fold.disabled = false;
		noticeDialog(t('tile.fold_failed'), friendlyError(e));
		return;
	}
	fold.disabled = false;
	// A fold that moved nothing is said plainly rather than left as a button press
	// with no consequence: below `MIN_KEEP_MESSAGES` there is no tail to cut.
	if (!moved) { toast(t('tile.fold_nothing')); return; }
	// The session on record is now the folded one, so the stored copy has to
	// follow — otherwise a reload springs the conversation back to its full size
	// and the fold the user paid for is undone.
	try { chat.lastPrompt = app.last_prompt_tokens || chat.lastPrompt || 0; noteHerePrompt(chat); }
	catch (e) { /* mid-turn read is impossible here; the turn is not running */ }
	captureSession(chat, app);
	persistChats();
	// The dialog's context line, when the fold was asked for from the dialog. This
	// used to call `say()` outright, which does not exist here -- it belongs to the
	// SIBLING `mountContextSection` -- so every successful fold threw at this line,
	// and since nothing awaits this function it took `renderSessionList` down with it
	// in a rejection nobody ever saw.
	if (typeof onDone === 'function') onDone();
	renderSessionList();
}

/// A Diamond's triggered actions, in its own settings dialog.
///
/// Notes2 asks for exactly this shape and it is built as written: "new
/// triggered actions (TAs) can be added with a + icon, and selected for
/// editing from a pulldown", and "To avoid clutter, Instruction and Context
/// should just show an edit button and a copy button to facilitate copying
/// between TAs and diamonds."
///
/// So: one pulldown naming every action, one panel showing the chosen one,
/// and the two long texts behind Edit and Copy rather than two textareas
/// apiece. The clutter warning is the design — every action expanded at once
/// is a dialog nobody can read, and it gets worse with each action added.
///
/// The one thing the pulldown costs is the at-a-glance view of what is armed,
/// so the armed state rides in the option text: a reader looking at one
/// action can still see that another is running.
///
/// A Diamond with no actions shows a `+` and nothing else. Notes3: *"should
/// simply show the plus icon button when no TAs are registered, and reveal
/// the pulldown when clicked"*. Most Diamonds have no triggered actions ever,
/// and for those the section was three controls and a paragraph explaining
/// that none of them had anything to do.
function mountTriggers(card, opts) {
	if (!window.DaimondTriggers) return;
	card.appendChild(secHead(tOr('trig.section', 'Triggered actions')));

	var host = document.createElement('div');
	host.className = 'trig-list';
	card.appendChild(host);

	// Which action is open. Held by id and not by index, so a redraw after a
	// removal keeps the reader where they were rather than throwing them to
	// whatever action now sits in that slot.
	var chosen = null;
	// Whether the `+` has been pressed on an empty section. It reveals the
	// kind pulldown rather than creating something, because what sets an
	// action off is decided when it is made -- a `+` that silently chose one
	// would put the mail case behind an action you have to delete.
	var adding = false;

	// Judged on the action's terms, as it is when it fires: a release given here
	// to what the action said before an edit made outside this editor is not one.
	function armed(ta) {
		try { return !DaimondPause.isPaused(DaimondTriggers.node(opts.id, ta.id), DaimondTriggers.terms(ta)); }
		catch (e) { return false; }
	}

	function draw() {
		host.innerHTML = '';
		var list = Triggers.of(opts.id);
		if (list.length) {
			if (!list.some(function (x) { return x.id === chosen; })) chosen = list[0].id;
			var ta = list.filter(function (x) { return x.id === chosen; })[0];

			// ── The chooser ────────────────────────────────
			var pick = document.createElement('div');
			pick.className = 'trig-pick';
			// The light belongs beside the pulldown and not inside the panel:
			// it is the control the reader reaches for most, and it should not
			// move when the chosen action changes shape.
			mountPause(pick, DaimondTriggers.node(opts.id, ta.id), triggerLabel(ta));

			var sel = document.createElement('select');
			sel.className = 'tile-model trig-choose';
			sel.setAttribute('aria-label', t('trig.choose'));
			list.forEach(function (x) {
				var o = document.createElement('option');
				o.value = x.id;
				o.textContent = t(armed(x) ? 'trig.opt_on' : 'trig.opt_off',
					{ what: triggerLabel(x) });
				sel.appendChild(o);
			});
			sel.value = chosen;
			sel.addEventListener('change', function () { chosen = sel.value; draw(); });
			pick.appendChild(sel);

			pick.appendChild(trigBtn('✕', t('trig.remove'), async function () {
				// An action with nothing written in it and nothing armed is the
				// one the user just added by pressing `+`, and asking them to
				// confirm the deletion of an empty thing is the friction that
				// made `+` feel one-way. There is nothing to lose, so there is
				// nothing to ask. Anything with an instruction still asks.
				var blank = !armed(ta) && !(ta.instruction || '').trim()
					&& !(ta.context || '').trim();
				if (!blank) {
					var ok = await confirmDialog(t('trig.remove_body', { what: triggerLabel(ta) }),
						t('trig.remove'), { title: t('trig.remove'), danger: true });
					if (!ok) return;
				}
				await Triggers.remove(opts.id, ta.id);
				// No need to clear `chosen`: draw() falls back whenever it
				// names an action that is no longer there, which is the same
				// guard that survives an action removed on another device.
				// `adding` does have to be cleared, so that removing the last
				// action leaves the section as an empty one rather than as one
				// mid-way through an addition nobody asked for.
				adding = false;
				draw();
			}));
			host.appendChild(pick);
			// HOW TO START IT, said where the control is and only while it is
			// stopped. A held action is the ordinary state of a new one and the
			// shipped state of the Optimiser's, and the light that arms it is one
			// tap away and unlabelled -- so the app's own answer to "why has this
			// never run" was a red dot. It goes away the moment it is armed, so a
			// reader is not told twice.
			if (!armed(ta)) host.appendChild(secNote(t('trig.arm_note')));
			host.appendChild(triggerPanel(opts.id, ta, draw));
		}

		var add = document.createElement('div');
		add.className = 'trig-add';
		// Nothing registered and nothing asked for: one button, which is the
		// whole of the section until somebody wants an action.
		if (!list.length && !adding) {
			add.appendChild(trigBtn('+', t('trig.add'), function () { adding = true; draw(); }));
			host.appendChild(add);
			return;
		}
		var kind = document.createElement('select');
		kind.className = 'tile-model';
		kind.setAttribute('aria-label', t('trig.add_kind'));
		[['activity', 'trig.kind_activity'], ['mail', 'trig.kind_mail']].forEach(function (pair) {
			var o = document.createElement('option');
			o.value = pair[0]; o.textContent = t(pair[1]);
			kind.appendChild(o);
		});
		var plus = trigBtn('+', t('trig.add'), async function () {
			var ta = DaimondTriggers.blank(kind.value);
			ta.id = kind.value + '-' + Date.now().toString(36);
			// A NEW action starts off, and starting it off means seeding the
			// PAUSE TREE and nothing else. The tree is the one switch the app
			// has: the light writes it, `allowed` reads it at the moment of
			// firing, and a hold arriving from another device is honoured.
			//
			// The record's `on` is NOT written here, and the reason is what it
			// cost. `ready` honours a hand-edited `on: false` -- the file is the
			// setting, and a person may switch an action off in it -- so an
			// action born with `on: false` beside a held leaf had two switches,
			// and the light could only ever throw one of them. Press play and
			// the leaf was released, the light went green, the pulldown said ▶,
			// and `allowed` went on refusing on the record: a timer that could
			// not fire until somebody opened `triggers.json` by hand. Every
			// action made here was born that way, and so was the Optimiser's.
			await Triggers.set(opts.id, ta);
			try { DaimondPause.seedPaused(DaimondTriggers.node(opts.id, ta.id)); }
			catch (e) { /* pause module absent in a stripped build */ }
			// Added, and chosen: the pulldown is how an action is reached, so
			// the one just added had better be the one it is showing.
			chosen = ta.id;
			adding = false;
			draw();
		});
		add.appendChild(kind); add.appendChild(plus);
		host.appendChild(add);
	}

	draw();
}

/// The chosen action's own settings: what sets it off, and its two texts.
///
/// The trigger's own fields are inline and save as they are changed — a
/// number of minutes and a folder name are small enough that a Save button
/// would be more ceremony than the change. The two long texts are not: they
/// get the edit-and-copy pair notes2 asks for, so that an instruction
/// written once can be carried to another action or another Diamond.
function triggerPanel(diamondId, ta, done) {
	var panel = document.createElement('div');
	panel.className = 'trig-panel';

	function field(labelKey, el) {
		var wrap = document.createElement('label');
		wrap.className = 'trig-field';
		var lab = document.createElement('span');
		lab.className = 'trig-label';
		lab.textContent = t(labelKey);
		wrap.appendChild(lab); wrap.appendChild(el);
		panel.appendChild(wrap);
		return el;
	}
	async function patch(fn) {
		var next = Object.assign({}, ta);
		fn(next);
		await Triggers.set(diamondId, next);
		ta = next;
	}

	if (ta.kind === 'activity') {
		var mins = document.createElement('input');
		mins.type = 'number'; mins.min = '1'; mins.max = '1440';
		mins.value = String(ta.minutes || 30);
		mins.className = 'trig-input';
		mins.addEventListener('change', function () {
			patch(function (n) { n.minutes = Math.max(1, Math.round(Number(mins.value) || 30)); });
		});
		field('trig.minutes', mins);
		var mnote = document.createElement('div');
		mnote.className = 'tile-dlg-note';
		mnote.textContent = t('trig.minutes_note');
		panel.appendChild(mnote);
	}
	if (ta.kind === 'mail') {
		var box = document.createElement('select');
		box.className = 'trig-input';
		var boxes = [];
		try { boxes = (window.DaimondMail && DaimondMail.accounts && DaimondMail.accounts()) || []; }
		catch (e) { boxes = []; }
		if (!boxes.length) {
			var o0 = document.createElement('option');
			o0.value = ''; o0.textContent = t('trig.no_mailbox');
			box.appendChild(o0);
		}
		boxes.forEach(function (addr) {
			var o = document.createElement('option');
			o.value = addr; o.textContent = addr;
			box.appendChild(o);
		});
		if (ta.mailbox) box.value = ta.mailbox;
		box.addEventListener('change', function () {
			patch(function (n) { n.mailbox = box.value || ''; });
		});
		field('trig.mailbox', box);

		var fol = document.createElement('input');
		fol.type = 'text'; fol.className = 'trig-input';
		fol.value = ta.folder || 'INBOX';
		fol.placeholder = 'INBOX';
		fol.addEventListener('change', function () {
			patch(function (n) { n.folder = fol.value.trim() || 'INBOX'; });
		});
		field('trig.folder', fol);
	}

	panel.appendChild(longText('trig.instruction', 'trig.instruction_ph',
		function () { return ta.instruction || ''; },
		function (v) {
			return patch(function (n) { n.instruction = v; });
		}));

	panel.appendChild(longText('trig.context', 'trig.context_ph',
		function () { return ta.context || ''; },
		function (v) {
			return patch(function (n) {
				// A changed context has NOT been sent, whatever was sent before.
				// That is what a person means by changing it, and the alternative
				// -- keeping the old stamp -- is a context the daimon never hears.
				if ((v || '').trim() !== (ta.context || '').trim()) n.contextSent = '';
				n.context = v;
			});
		}));

	var cnote = document.createElement('div');
	cnote.className = 'tile-dlg-note';
	cnote.textContent = t('trig.context_note');
	panel.appendChild(cnote);

	/// One long text: what it says in a phrase, then Edit and Copy.
	function longText(labelKey, phKey, get, set) {
		var row = document.createElement('div');
		row.className = 'trig-text-row';

		var lab = document.createElement('span');
		lab.className = 'trig-label';
		lab.textContent = t(labelKey);
		row.appendChild(lab);

		// What is in there, in the smallest honest form: the opening words,
		// or a plain statement that it is empty. A row of two buttons with
		// nothing between them cannot be told from another row of two buttons.
		var gist = document.createElement('span');
		gist.className = 'trig-gist';
		var cur = (get() || '').trim();
		if (cur) {
			gist.textContent = cur.length > 60 ? cur.slice(0, 60) + '…' : cur;
			gist.title = cur;
		} else {
			gist.textContent = t('trig.nothing_written');
			gist.classList.add('empty');
		}
		row.appendChild(gist);

		row.appendChild(trigBtn('✎', t('trig.edit_this', { what: t(labelKey) }), async function () {
			var next = await editLongText(t(labelKey), get(), t(phKey));
			await set(next);
			if (done) done();
		}));
		row.appendChild(trigBtn('⧉', t('trig.copy_this', { what: t(labelKey) }), async function () {
			try {
				await navigator.clipboard.writeText(get());
				toast(t('trig.copied'));
			} catch (e) { toast(t('trig.copy_failed'), true); }
		}));
		return row;
	}

	return panel;
}

/// Edit one long text in a dialog of its own.
///
/// Closing keeps what was typed, including an empty box -- clearing an
/// instruction is a thing a person may mean to do. That is the contract
/// `openBodyDialog` already has everywhere else in this file (it has one
/// button and Escape means the same as pressing it), and a single dialog
/// that threw work away on Escape would be the surprising one.
async function editLongText(title, value, placeholder) {
	var body = document.createElement('div');
	body.className = 'trig-edit';
	var area = document.createElement('textarea');
	area.className = 'trig-area'; area.rows = 8;
	area.value = value || '';
	area.placeholder = placeholder || '';
	area.setAttribute('aria-label', title);
	body.appendChild(area);
	await openBodyDialog(t('trig.edit_title', { what: title }), body,
		{ okLabel: t('common.save') });
	return area.value;
}

function trigBtn(glyph, label, onClick) {
	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'trig-btn';
	b.textContent = glyph;
	b.title = label;
	b.setAttribute('aria-label', label);
	b.addEventListener('click', onClick);
	return b;
}

function secNote(words) {
	var d = document.createElement('div');
	d.className = 'tile-dlg-note';
	d.textContent = words;
	return d;
}

/// The editor for one triggered action.
/// The three models a Diamond runs on, in its own settings dialog.
///
/// Which model a Diamond thinks with has been stored since Diamonds had models and
/// shown nowhere, so the only way to see it was to read `localStorage` — and the only
/// way to change it was to delete the Diamond and make another.
///
/// The three are not the same KIND of setting, and the dialog does not pretend they
/// are:
///
///   * **The daimon** is persistent, so the change is taken deliberately: the
///     pulldown does not switch on its own, and a "Change" button beside it shows
///     only while the pick differs from the model in force. Pressing it points the
///     daimon's next turn at the new model and re-meters the context against its
///     window; it is written into the crystal's version history, where the
///     Diamond's other discontinuities are. The conversation is REUSED, never
///     ended — it belongs to the record, not to the model — and if the new window
///     is smaller the usual fold runs on the next turn.
///   * **The workers** may be changed at any time and apply to NEW agents only. A
///     worker already running keeps the model it was dispatched with, because moving
///     it would bill one conversation to two models.
///   * **The vision worker** is the second half of the same setting, keyed by
///     modality. Empty means "use the text model", which is a real answer rather than
///     a missing one.
function mountDiamondModels(card, adv, opts) {
	if (!window.DaimondModels) return;
	card.appendChild(secHead(t('tile.dlg_models')));

	var rec = diamondModels()[opts.id] || {};
	var own = diamondModel(opts.id);

	/// One labelled pulldown, on `host`. `onPick` gets `{provider, model}`.
	///
	/// The label is a `<label>`, not a `.tile-model-chip`. That class is what a
	/// model NAME is drawn in on the tile — a mono pill with a border — so
	/// wearing it here made three form labels look like three values, which is
	/// the "rushed" the author was pointing at. It also earns the click: the
	/// word now focuses the control it names.
	function row(host, labelKey, helpKey, provider, model, allowNone, onPick) {
		var r = document.createElement('div');
		r.className = 'tile-dlg-field tile-dlg-model';
		var lab = document.createElement('label');
		lab.className = 'tile-dlg-label';
		lab.textContent = t(labelKey);
		lab.htmlFor = 'tile-model-' + labelKey.replace(/[^a-z0-9]+/gi, '-') + '-' + pg._tileDlgSeq;
		var sel = document.createElement('select');
		sel.className = 'tile-model';
		sel.id = lab.htmlFor;
		sel.title = t(helpKey);
		populateModelSelect(sel, model || '', provider || '');
		if (allowNone) {
			// First, and selected when nothing is stored: "the same as the text one" is
			// this setting's default and has to be reachable again once it is left.
			var none = document.createElement('option');
			none.value = ''; none.dataset.provider = '';
			none.textContent = t('tile.model_same_as_text');
			sel.insertBefore(none, sel.firstChild);
			if (!model) sel.value = '';
		}
		sel.addEventListener('change', function () {
			var p = DaimondModels.pick(sel);
			// `pick` reads the selected option, so the "same as text" row comes back as
			// an empty model — which is exactly what the store wants for absent.
			onPick({ provider: p.provider || '', model: p.model || '' }, sel);
		});
		r.appendChild(lab); r.appendChild(sel);
		host.appendChild(r);
		DaimondModels.picker(sel);
		return sel;
	}

	// ── The daimon.
	//
	// The pulldown no longer switches on its own. A daimon's model is persistent, so
	// the change waits for the Change button beside it, and that button shows only
	// while the pick differs from the model the daimon runs on now. Picking the
	// current model back hides it again.
	var change = document.createElement('button');
	change.type = 'button';
	change.className = 'tile-dlg-apply';
	change.textContent = t('tile.model_change');
	change.title = t('tile.model_change_help');
	change.hidden = true;
	var pendingPick = null;			// the pick awaiting a Change press, or null when it matches

	var daimonSel = row(card, 'tile.model_daimon', 'tile.model_daimon_help',
		own.provider, own.model, false, function (p) {
			// The pulldown only relabels the button; the switch itself waits for Change.
			var plan = DaimondModels.planModelSwitch(diamondModel(opts.id), p, 0);
			pendingPick   = plan.changed ? p : null;
			change.hidden = !plan.changed;
		});

	change.addEventListener('click', async function () {
		if (!pendingPick) return;
		var p = pendingPick;
		var before = diamondModel(opts.id);
		// A pick that no longer differs (the model moved in another tab, say) switches
		// nothing and clears the button.
		if (!DaimondModels.planModelSwitch(before, p, 0).changed) {
			pendingPick = null; change.hidden = true; return;
		}
		// NO POPUP, DELIBERATELY, and the conversation is REUSED. The modal that once
		// stood in the switch path warned the conversation would not carry over; it
		// does. The thread lives on the record and travels as `prior`, so switching
		// only points the daimon's next turn at the new model and re-meters the
		// context against its window. A smaller window is folded on the next turn by
		// the engine, which is also the only thing that ever forces a fresh daimon --
		// never this button.
		await changeDiamondModel(opts.id, before, p);
		pendingPick   = null;			// the pulldown now matches the model in force
		change.hidden = true;
		renderEffortStep();				// the new model's levels, if this Diamond is on screen
		if (pg.currentDiamond && pg.currentDiamond.id === opts.id) {
			await refreshDiamondAfterChange();
		} else {
			bumpDiamonds(); await loadDiamonds();
		}
	});

	// The Change button, beside the model it thinks with.
	daimonSel.parentNode.appendChild(change);

	// How hard the daimon thinks is the composer's Effort step on the Diamond's face, and
	// only there: one door (D-20261014-08 F2).

	// The notes this model is told, and Remove: here, where a person looks after the model it thinks with.
	card.appendChild(secHead(t('steer.title')));
	var steerBody = document.createElement('div');
	card.appendChild(steerBody);
	steerListMount(steerBody, { diamond: opts.id, empty: 'tile-dlg-note' });
	// "Fresh daimon" removed (owner review 2026-09-04): a new model takes effect
	// on the next turn on its own, and the responding model now shows in the
	// Thinking and Daimond tile headers, so a button to force a fresh start was
	// redundant. `mountDaimonReset` is left defined but no longer mounted.

	// ── The helpers, text and images, BEHIND THE DISCLOSURE (CRY-15).
	//
	// They are a different question from the one above it. The daimon's model
	// is what this Diamond thinks with and is changed deliberately; these two
	// say what the workers it dispatches run on, which most people never set
	// and nobody sets on the way past. Their own heading, so the fold does not
	// open onto two unlabelled pulldowns.
	var host = adv || card;
	host.appendChild(secHead(t('tile.dlg_workers')));
	row(host, 'tile.model_workers', 'tile.worker_model_help',
		rec.workerProvider || own.provider, rec.workerModel || '', true, function (p) {
			setDiamondModel(opts.id, { workerProvider: p.provider, workerModel: p.model });
		});

	row(host, 'tile.model_vision', 'tile.model_vision_help',
		rec.visionProvider || '', rec.visionModel || '', true, function (p) {
			setDiamondModel(opts.id, { visionProvider: p.provider, visionModel: p.model });
		});

	var note = document.createElement('div');
	note.className = 'tile-dlg-note';
	note.textContent = t('tile.model_note');
	host.appendChild(note);
	return daimonSel;
}

/// The control that ends a daimon's conversation without folding it.
///
/// **Folding is the way a daimon's thread is meant to end**, and this is the exception, so it
/// is drawn as one: a quiet `.tile-dlg-clear` beside the model pulldown, two levels down in a
/// settings dialog, rather than a second button next to Fold in the crystal header. Beside
/// Fold it would read as the equally weighted other option and people would reach for it,
/// which is the opposite of what it is for. What it IS for is the thread folding does not
/// serve — an afternoon of testing, or a line of enquiry that went nowhere, which nobody wants
/// in the crystal.
///
/// **It is not offered when there is nothing to clear.** A control that does nothing when
/// pressed teaches people to distrust every control, and an empty daimon is the ordinary state
/// of a new Diamond.
///
/// The conversation goes; the SPEND STAYS. `costUsd` and the token totals are the record of
/// money this Diamond has actually cost, and clearing a conversation is not a refund — a reset
/// that zeroed them would make the Spending panel disagree with the ledger the gateway keeps.
/// `lastPrompt` does go, because it measures a context that no longer exists.
///
/// # Arguments
/// * `row` - The daimon's model row, which this sits at the end of.
/// * `id` - The Diamond whose daimon would be reset.
/// Clear a daimon's conversation to a FRESH SESSION, safely.
///
/// THE 2026-08-14 DATA-LOSS GUARD LIVES HERE, in one place. The discarded
/// messages are TOMBSTONED by id before the array is emptied, so
/// `persistChats`'s deliberate union does not put them straight back — and
/// because the ids are this conversation's own (minted from content, not
/// position), clearing THIS daimon does not shorten another. Both halves go:
/// `messages` is what the thread draws, `session.msgs` is what the next turn
/// sends — an EMPTY session, never `null`, or the union reads "this tab does not
/// know" and the stored conversation comes back. The web grant the ended
/// conversation held is forgotten with it; the Diamond's directory, crystal and
/// links are untouched — this ends a conversation, it does not undo what the
/// conversation did.
/// THE TAIL IS NOT HERE ANY MORE, and that is the change this file needed for
/// undo to mean anything. Emptying the record is reversible -- the messages are
/// in hand and can be put straight back. Tombstoning them is not: a tombstone
/// travels, and the other device acts on it. So the two halves came apart, and
/// `commitDaimonClear` below holds the half that cannot be taken back.
///
/// EVERY CALLER MUST COMMIT. A clear whose tombstone never runs is the
/// 2026-08-14 data loss inverted: `persistChats`'s union puts the whole
/// conversation back at the next save, and the screen that cleared fills again.
/// So a caller either commits at once (the reset button) or hands the commit to
/// the undo window (the fold), and there is no third way.
export function clearDaimonSession(rec, id) {
	if (!rec) return;
	rec.messages = [];
	rec.session = { v: 1, msgs: [], upto: '', uptoTs: 0 };
	rec.lastPrompt = 0;
	noteHerePrompt(rec);
	if (id) forgetDiamondWebConsent(id);
	touchChat(rec);
	persistChats();
}

/// Make a cleared daimon conversation final: the tombstone, and the compaction
/// that takes the bytes off the disk.
///
/// `mids` is the conversation as it stood BEFORE the clear, because by the time
/// this runs `rec.messages` is empty and the ids are only in the caller's hand.
///
/// A tombstone is how a deliberate removal survives `persistChats`'s deliberate
/// union -- the union is what stops an idle tab rolling back a turn another tab
/// has just taken -- and it travels in the sync parcel, so a daimon ended here
/// is ended on the other devices too. The tombstoned mids are hidden on read at
/// once, but they are still PHYSICALLY in this chat's append-only chunks;
/// compaction drops them from disk so they cannot resurrect once the tombstone
/// ages out (seq 214, Stage 2), and handles a non-resident daimon the save path
/// cannot compact on its own.
export function commitDaimonClear(rec, mids) {
	if (!rec) return;
	msgTombstone((mids || []).slice());
	persistChats();
	if (rec.id) ChatStore.compact(rec.id);
}

function mountDaimonReset(row, id) {
	if (!row || !id) return;
	var f = pg.diamonds.find(function (x) { return x.id === id; });
	if (!f) return;
	// `chats.find` and NOT `daimonChat(f)`: that one CREATES the record when there is none
	// and persists it, so asking it whether a conversation exists would bring one into being
	// — and the answer would always be "an empty one", which is the answer that hides the
	// button. A read must not write.
	var rec = pg.chats.find(function (c) { return c.diamondId === id; });
	// `chatMsgCount`, so a non-resident daimon with content still shows the reset
	// (seq 213, Stage 1); `sessionMsgs` covers the summary's session marker too.
	var held = rec ? (chatMsgCount(rec) + (rec._loaded
		? (((rec.session || {}).msgs) || []).length : (rec.sessionMsgs || 0))) : 0;
	if (!held) return;

	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'tile-dlg-clear';
	b.textContent = t('tile.daimon_reset');
	b.title = t('tile.daimon_reset_help');
	b.addEventListener('click', async function () {
		// NOT WHILE THE DAIMON IS MID-TURN, and the confirm is not even offered. A turn
		// writes its reply into `rec.messages` and the model's whole conversation into
		// `rec.session` when it ENDS, both by reference — so a clear taken while one is in
		// flight is undone a few seconds later by a turn that knew nothing about it, and
		// what the reader is left with is a "fresh" daimon holding half an answer to a
		// question that is no longer there. Measured, not supposed.
		//
		// Refused rather than repaired, because the repair is a decision about somebody's
		// money: stopping a turn they are paying for is not this control's to make. Stop is
		// already on the composer while it runs, and it reaches a daimon's turn.
		if (rec._generating) {
			await noticeDialog(t('tile.daimon_reset_busy_title'), t('tile.daimon_reset_busy'));
			return;
		}
		var ok = await confirmDialog(
			t('tile.daimon_reset_body', { n: (rec.messages || []).length }),
			t('tile.daimon_reset_ok'),
			{ title: t('tile.daimon_reset_title'), danger: true });
		if (!ok) return;
		// TOMBSTONED BEFORE IT IS EMPTIED, and this is the line the feature did not work
		// without. `persistChats` UNIONS this tab's transcript with the stored one, on
		// purpose — it is what stops an idle tab rolling back a turn another tab has just
		// taken — so emptying the array and saving merged the empty array with the whole
		// conversation and put every message straight back. The screen cleared, the store
		// did not, and the next reload had the testing conversation again. Reported as
		// *"the chat screen has not cleared, which was the entire point, to start fresh"*.
		// A tombstone is how a deliberate removal survives the union; it is the same
		// mechanism a replaced interrupted turn already uses, and it travels in the sync
		// parcel, so a daimon ended here is ended on the other devices too.
		// The safe clear, guard and all (see `clearDaimonSession`) -- and its
		// commit in the same breath. Reset is the deliberate end of a
		// conversation behind its own confirm, so nothing is held open for it.
		var wasMids = (rec.messages || []).map(function (m) { return m.mid; });
		clearDaimonSession(rec, id);
		commitDaimonClear(rec, wasMids);
		// The daimon's own directory, its crystal and its links are untouched. This ends a
		// conversation; it does not undo anything the conversation did.
		//
		// REDRAWN ONLY WHERE THE THREAD IS ACTUALLY ON SCREEN. This dialog overlays the
		// app, so whatever is behind it is stale until something repaints it, and closing
		// a dialog repaints nothing. On the CRYSTAL face there is no thread drawn to be
		// stale, and switching to the chat face renders from the record, which is already
		// empty -- so there is nothing to do there and nothing is done.
		//
		// `'chat'` cannot move the reader anywhere they did not ask to go, and that is
		// worth saying because it would be the obvious way to get this wrong: the guard
		// has ALREADY established that the chat face is the one up, so this re-selects
		// the face they are on. Widening the guard to the crystal face and keeping this
		// argument would silently walk them off the crystal they were reading.
		if (daimonOnScreen(rec)) {
			await selectDiamond(f, 'chat');
		}
		// Gone, because there is now nothing to clear — the same rule that kept it off an
		// empty daimon in the first place.
		b.remove();
		toast(t('tile.daimon_reset_done'));
	});
	row.appendChild(b);
}

/// Point a Diamond at another model, as the Change button does and as a Pending model switch
/// does (Rating U7b): record it, drop the cached client and say what moved. `before` is the
/// model in force until now; `p` is `{ provider, model }`. The history entry is the next turn's
/// to write (`noteModelInForce`), as it is for every other way the model in force moves.
export async function changeDiamondModel(id, before, p) {
	// The daimon's Effort goes with it only where the new model offers that level.
	var eff = DaimondModels.effortAfterSwitch(diamondEffort(id), p.provider || '', p.model || '');
	var pick = { provider: p.provider, model: p.model, effort: eff.effort,
		effortProvider: eff.effort ? (p.provider || '') : '', effortModel: eff.effort ? (p.model || '') : '' };
	// A record with no last-run pair (every Diamond on the day of deploy) takes `before` as
	// it, or the next turn, seeing no `ran`, would write no note of the move (QA B #1).
	var rec = diamondModels()[id] || {};
	if (!rec.ranModel && before && before.model) {
		pick.ranProvider = before.provider || ''; pick.ranModel = before.model;
	}
	setDiamondModel(id, pick);
	// A DaimondApp has no setter for its model, so the cached client for this
	// Diamond has to go; `diamondApp` builds the new one, with the new window, on
	// next use. The persisted session is untouched and is re-seeded into it.
	resetDiamondApps();
	// The receipt: what moved, and that the thread came with it. The one toast; no other
	// path that moves a Diamond's model says so per Diamond.
	toast(t('tile.model_changed', {
		from: shortModel(before.model, before.provider) || t('tile.model_none'),
		to:   shortModel(p.model, p.provider),
	}) + effortClearedNote(eff, p.provider, p.model));
}

/// A settings dialog for something that is not a tile: a title, a body somebody
/// else built, and Delete at the foot.
///
/// The mail module asked for this by name (`deps.bodyDialog`) and shipped a
/// stand-in of its own furniture because the alternative was a gear that opened
/// nothing. This is the real one, and it is deliberately the SAME dialog phase C
/// built: the same focus trap, the same Escape, the same Delete-on-the-left foot.
/// Notes2 asks for the mailbox's closer cross to become a Delete at the foot of
/// its settings dialog, which is the same sentence it uses about a tile — so it
/// had better be the same dialog, or the two will drift the first time either is
/// touched.
///
/// # Arguments
/// * `title` - The heading, which also names the dialog to the accessibility tree.
/// * `body` - An element to put under it.
/// * `opts.onDelete` - Async; called after the dialog closes. Omit for no Delete.
/// * `opts.deleteLabel` - What the destructive button says.
/// * `opts.hero` - An element ABOVE the heading, for a dialog that leads with
///   artwork rather than with words.
/// * `opts.quietTitle` - Draw no heading. The title still names the dialog to
///   the accessibility tree; it is only the pixels that go. For a dialog whose
///   artwork already says what it is, where a heading repeating it is furniture.
/// * `opts.cardClass` - An extra class on the card, for a dialog with a shape
///   of its own.
export function openBodyDialog(title, body, opts) {
	opts = opts || {};
	var back = document.createElement('div');
	back.className = 'modal dlg tile-dlg';
	var card = document.createElement('div');
	card.className = 'modal-card dlg-card tile-dlg-card' + (opts.cardClass ? ' ' + opts.cardClass : '');
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-modal', 'true');
	if (opts.hero) card.appendChild(opts.hero);
	var h = document.createElement('h2');
	// Marked, not merely set, exactly as `dialog()` marks its own -- this
	// helper is handed FINISHED strings, so nothing else in the app knows what
	// key to repaint it from, and a dialog left open while the language changes
	// stayed in the language it was opened in. `mark` looks the key up from the
	// words, so a title that is CONTENT rather than a table string (a mailbox
	// address, an object's name) is set and left unmarked, which is right.
	mark(h, '', title || '');
	h.id = 'body-dlg-h-' + (++pg._tileDlgSeq);
	// Clipped, not `display: none`: a heading taken out of the pixels must stay
	// in the accessibility tree, because it is what `aria-labelledby` points at.
	if (opts.quietTitle) h.className = 'vh';
	card.setAttribute('aria-labelledby', h.id);
	// The cross, beside the heading, exactly as the tile dialog wears it --
	// this is the same dialog with a caller-drawn body, and the two must not
	// offer different ways out. It carries `tile-dlg-done` because that class
	// has never meant "the button that says Done": it means "the control that
	// finishes with this dialog", which is what seven verifiers reach for, and
	// the cross is that control now.
	//
	// `close` is declared inside the promise below, so the cross reaches it
	// through `finish` rather than by name: one dismissal path, not a second
	// one written out here that could drift from it.
	var finish = null;
	card.appendChild(closerRow(h, title || t('common.close'),
		function () { if (finish) finish(true); }, 'tile-dlg-done'));
	if (body) card.appendChild(body);

	// The foot holds what the dialog DECIDES, and nothing else.
	//
	// It used to end with a full-width Done whatever the caller was doing,
	// which on About was "a massive close button at the bottom" -- a control
	// that costs a scroll and a long reach on a phone, takes the room the
	// content wants, and does exactly what the cross in the corner does. A
	// dismissal is not a decision and does not belong in the row of decisions.
	//
	// `okLabel` is therefore opt-IN and means "this dialog's foot chooses
	// something": `editLongText` passes Save, because a person who has typed
	// eight lines of instruction wants to press a word rather than trust a
	// corner. A caller that only wants out passes nothing.
	var row = document.createElement('div');
	row.className = 'dlg-actions tile-dlg-foot';
	var del = null;
	if (typeof opts.onDelete === 'function') {
		del = document.createElement('button');
		del.type = 'button';
		del.className = 'dlg-ok danger tile-dlg-delete';
		mark(del, '', opts.deleteLabel || t('tile.dlg_delete'));
		row.appendChild(del);
	}
	var done = null;
	if (opts.okLabel) {
		done = document.createElement('button');
		done.type = 'button';
		done.className = 'modal-close dlg-cancel';
		mark(done, '', opts.okLabel);
		row.appendChild(done);
	}
	if (row.children.length) card.appendChild(row);
	back.appendChild(card);
	document.body.appendChild(back);

	var prev = document.activeElement;
	// Captured while the opener is still in the document: a panel that redraws
	// underneath replaces its CHILDREN and keeps its own box, so this survives
	// where `prev` does not. See `refocus`.
	var prevHost = (prev && prev.closest) ? prev.closest('[id]') : null;
	return new Promise(function (resolve) {
		var lid = DaimondLayers.open(DaimondLayers.uid('dialog'), function () { close(true); });
		function close(v) {
			document.removeEventListener('keydown', onKey, true);
			back.remove();
			DaimondLayers.done(lid);
			refocus(prev, prevHost);
			resolve(v);
		}
		finish = close;			// the cross above, wired to the one way out
		function onKey(e) {
			if (e.key === 'Tab') keepFocusIn(card, e);
		}
		document.addEventListener('keydown', onKey, true);
		back.addEventListener('mousedown', function (e) { if (e.target === back) close(true); });
		if (done) done.addEventListener('click', function () { close(true); });
		if (del) del.addEventListener('click', async function () {
			// The dialog goes first: a confirm drawn over its own opener reads as
			// two modals, and the answer is about the mailbox, not about the dialog.
			close(false);
			await opts.onDelete();
		});
		// The keyboard starts on the foot's decision where there is one, and
		// otherwise on the cross -- which is the only control the dialog owns,
		// and is where a keyboard user needs to be able to get to first.
		(done || card.querySelector('.ui-close')).focus();
	});
}

// ── About ──────────────────────────────────────────────────
//
// Inkscape's shape, which is the one the user asked for: the splash artwork
// takes the top of the card and reaches its edges, the app's identity sits
// under it, and the small print is a quiet row along the foot.
//
// It is built on `openBodyDialog` and not on a modal of its own, so Escape,
// the backdrop, the focus trap and the return of focus to whatever opened it
// are the ones every other dialog in the app already has. A second modal
// written for one screen is a second modal to fix every time the first one
// is.
//
// The maker's badge is HERE rather than in the top bar because that is where
// its two claims can be read. In the bar it was a 36px lozenge with two
// invisible hit areas laid over it — a signature nobody could parse, dropped
// entirely on a phone for want of room. In the foot of this dialog each claim
// keeps its own hit area, its own name and its own destination, and the phone
// gets them too.

/// The maker's badge: one artwork, two claims, two links.
///
/// The artwork is a single file with no ids to hook, so the halves are laid
/// OVER it at 50% rather than cut out of it — see `verify_badge.mjs`, which
/// measures where the two marks actually sit and fails if the split stops
/// falling in the gap between them.
function makerBadge() {
	var span = document.createElement('span');
	span.className = 'made-by';
	var img = document.createElement('img');
	img.src = 'assets/made_by_oxedyne.svg';
	img.alt = '';                       // the two links below carry the words
	img.setAttribute('aria-hidden', 'true');
	span.appendChild(img);
	// Two separate claims, so two separate hit areas: the Oxedyne flame leads
	// to Oxedyne, and the AI-disclosure chip leads to the mark it is claiming,
	// at need2know.ai, where the disclosure is defined rather than merely
	// asserted. `noopener noreferrer` on both — an external target gets no
	// handle on this window and no referrer off it.
	[
		['mb-oxedyne', 'https://oxedyne.com', 'topbar.made_by'],
		['mb-ai', 'https://need2know.ai/mostly-ai/code', 'topbar.made_with_ai'],
	].forEach(function (spec) {
		var a = document.createElement('a');
		a.className = 'mb-hit ' + spec[0];
		a.href = spec[1];
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		DaimondI18n.bind(a, 'title', spec[2]);
		DaimondI18n.bind(a, 'aria-label', spec[2]);
		span.appendChild(a);
	});
	return span;
}

/// The About dialog.
///
/// Opened by the header's "i", which stands where the badge used to.
export function openAbout() {
	// ── The artwork, above the heading. The website's splash, copied into
	// `www/assets` so the app carries its own asset; it is fixed-colour and
	// brings its own black ground, so it takes no theme treatment and looks
	// the same on every palette.
	var hero = document.createElement('img');
	hero.className = 'about-splash';
	hero.src = 'assets/splash.svg';
	DaimondI18n.bind(hero, 'alt', 'about.splash_alt');

	var body = document.createElement('div');
	body.className = 'about-body';

	// ── The identity. A wordmark rather than the word, because the app's name
	// is drawn and not typed — the same asset the top bar and the unlock screen
	// use, in the same light/dark pair, because unlike the splash it IS palette
	// artwork and would vanish on the wrong ground.
	var id = document.createElement('div');
	id.className = 'about-id';
	[['wm-on-dark', 'daimond_word.svg'], ['wm-on-light', 'daimond_word_dark.svg'], ['wm-on-ink', 'daimond_word_ink.svg']].forEach(function (w) {
		var wm = document.createElement('img');
		wm.className = 'about-word brand-wordmark ' + w[0];
		wm.src = 'assets/' + w[1];
		// One of the pair is drawn and the other is not; only the drawn one may
		// speak, or a reader meets the app's name twice.
		if (w[0] === 'wm-on-dark') wm.alt = 'Daimond';
		else { wm.alt = ''; wm.setAttribute('aria-hidden', 'true'); }
		id.appendChild(wm);
	});
	body.appendChild(id);

	// ── What it is. The guide's opening paragraph, which is the house voice
	// and already says it: no second description to drift from the first.
	var said = document.createElement('p');
	said.className = 'about-said';
	DaimondI18n.bind(said, '', 'about.what');
	body.appendChild(said);

	// ── The build, shown the way the rail's status panel shows it: the version
	// row's words, the id in the mono face, and the app's one copy button
	// beside it. `buildId()` is what THIS TAB is running.
	var ver = document.createElement('div');
	ver.className = 'about-ver';
	var vlabel = document.createElement('span');
	vlabel.className = 'about-ver-label';
	DaimondI18n.bind(vlabel, '', 'rel.version');
	var vid = document.createElement('code');
	vid.className = 'about-build';
	var known = buildId();
	vid.textContent = known;
	ver.appendChild(vlabel);
	ver.appendChild(vid);
	ver.appendChild(idCopyBtn(tOr('copy.what_build', 'the build id'), function () { return vid.textContent; }));
	body.appendChild(ver);
	// Nothing has read `build.json` on a first boot, and the release log is
	// fetched later still — so an empty id is asked for directly rather than
	// leaving a blank line where the version belongs.
	if (!known) {
		fetch('build.json', { cache: 'no-store' }).then(function (r) { return r.json(); })
			.then(function (j) { if (j && j.build) vid.textContent = j.build; })
			.catch(function () { /* an unstamped dev tree has no build id to show */ });
	}

	// ── Check that this build is the published one.
	//
	// `verify.html` hashes what this origin actually served and compares it with
	// the sealed manifest of the open-source release, and it prints the commands
	// for doing the same thing from the public source with nothing of ours in the
	// loop. It is the one page that makes the transparency claim TESTABLE by the
	// person relying on it -- and nothing in the app linked it. Not About, not the
	// legal pages, not the guide; only the separate landing site did. So the only
	// people who could reach it were the ones who already knew it was there, who
	// are precisely the people who need it least.
	//
	// Directly under the build id, because that id is what it checks.
	//
	// A NEW TOP-LEVEL DOCUMENT rather than a panel: a page vouching for the bytes
	// this origin served should not be drawn by the scripts it is vouching for.
	// `noopener noreferrer` as on every other outbound link in this dialog.
	var check = document.createElement('a');
	// The drawer's "it leads somewhere, it does not do anything" row: the app's
	// one style for exactly that, so this needs no rule of its own.
	check.className = 'admin-console-link about-verify';
	check.href   = 'verify.html';
	check.target = '_blank';
	check.rel    = 'noopener noreferrer';
	// Written, not bound. A `data-i18n` mark naming a key the catalogue does not
	// hold paints the KEY over these words at the next language change, which is
	// worse than an untranslated sentence.
	check.textContent = tOr('about.verify', 'Check this build against the published source');
	body.appendChild(check);

	// ── The small print: who made it, and how. A quiet row along the foot,
	// under a rule, because it is a signature and not a feature.
	var foot = document.createElement('div');
	foot.className = 'about-maker';
	foot.appendChild(makerBadge());
	body.appendChild(foot);

	// The heading is drawn by the artwork and the wordmark, so it is not drawn
	// again in words — but it still names the dialog to a screen reader.
	// No foot button. About decides nothing, so its whole way out is the cross
	// in the corner: the full-width Close it shipped with was a control you
	// scrolled to in order to do what the corner already did, and it took the
	// room the splash and the signature wanted.
	return openBodyDialog(t('about.title'), body, {
		hero:       hero,
		quietTitle: true,
		cardClass:  'about-card',
	});
}

/// One section heading inside a tile dialog.
export function secHead(words) {
	var d = document.createElement('div');
	d.className = 'tile-dlg-head';
	d.textContent = words;
	return d;
}

/// The collapsed half of a tile dialog (CRY-15): what a reader looks up
/// rather than what they came to change.
///
/// A real `<details>`, so the open state, the keyboard route and the
/// disclosure triangle are the browser's and nothing here has to draw them.
/// It is returned DETACHED and the caller appends it, which is what lets a
/// section be mounted into it from wherever it reads best in the order
/// above -- and what lets an empty one be dropped rather than offered.
export function advancedBox() {
	var d = document.createElement('details');
	d.className = 'tile-dlg-adv';
	var sum = document.createElement('summary');
	// `tile-dlg-head` as well as its own class: it IS a section heading, and
	// the rest of the dialog's headings are drawn by that rule.
	sum.className = 'tile-dlg-head tile-dlg-adv-sum';
	sum.textContent = tOr('tile.dlg_advanced', 'Advanced');
	d.appendChild(sum);
	return d;
}

/// Escape an id for use inside an attribute selector. Chat and Diamond ids
/// are generated, but a quote in one would otherwise break the selector.
function cssId(id) { return String(id == null ? '' : id).replace(/["\\]/g, '\\$&'); }

/// WHICH LIST HOLDS THE FOCUS -- 'chats' or 'diamonds'.
///
/// The rail draws two selections and only one of them is what the Centre is
/// showing. Both used to take the accent, so two rows read as "current" at
/// once and nothing on screen said which of them the panel beside them
/// belonged to. `centreMode` already knows: the chat face is the chat's, and
/// both of a Diamond's faces -- its crystal and its daimon's conversation --
/// are the Diamond's.
export function railFocus() { return pg.centreMode === 'chat' ? 'chats' : 'diamonds'; }

/// Paint one row of either list. THE ONE PLACE THE ACCENT IS DECIDED.
///
/// The audit found a Diamond and a chat wearing the accent border at the same
/// time, so two rows read as "current" and nothing said which of them the
/// Centre belonged to. The cause is not that the app holds two selections at
/// once -- it does not, `selectChat` clears `currentDiamond` and `selectDiamond`
/// points `current` at the daimon's own conversation, which has no tile -- but
/// that each list cleared only its OWN accent. Select a Diamond, then a chat,
/// and the Diamond's row kept a class nobody came back for.
///
/// So the two painters are run together, from the face switch (`showCentre`),
/// which every route to either selection passes through. `aria-current` follows
/// the accent, since a screen reader offered two current items is in the
/// position the eye was.
export function paintRailRow(box, chosen, focused) {
	var on = !!chosen && focused;
	box.classList.toggle('active', on);
	if (on) box.setAttribute('aria-current', 'true');
	else box.removeAttribute('aria-current');
}

export function updateActiveSession() {
	var focused = railFocus() === 'chats';
	sessionList.querySelectorAll('.session-box').forEach(function (box) {
		paintRailRow(box, pg.current && box.dataset.id === pg.current.id, focused);
	});
}

// ── What a chat tile says it is ────────────────────────────
//
// A chat has no name, so the rail derives its identity from WHEN it was last
// touched. Two halves: a day heading, and a time on the tile.
//
// The heading is what makes this readable. Every tile carrying an absolute
// date would be a wall of dates; every tile carrying a relative one ("6 days
// ago") is precise where nobody needs it and vague where they do. Grouping by
// day puts the coarse fact in one place and leaves each tile saying only what
// distinguishes it from its neighbours — which under Today is the time of day
// and nothing else.
//
// IT IS THE SAME STAMP THE SORT USES AND THE SAME ONE EXPIRY USES. One
// number answers "where does this sit in the rail", "what does the tile say"
// and "when does it run out", so a user watching the order has already been
// shown which chat is closest to going. Three readings of one fact cannot
// drift; three fields would.

/// The day heading a chat belongs under: 'today', 'yesterday' or 'earlier'.
///
/// By CALENDAR day in the user's own zone, not by elapsed hours. Something at
/// half past eleven last night is "Yesterday" at nine this morning even
/// though it is nine hours old, because that is what the word means to the
/// person reading it.
export function dayBucket(ms, now) {
	var d = new Date(ms), n = new Date(now == null ? Date.now() : now);
	var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
	var diff = Math.round((day(n) - day(d)) / 86400000);
	if (diff <= 0) return 'today';
	if (diff === 1) return 'yesterday';
	return 'earlier';
}

/// What one tile says about itself.
///
/// Under Today, a relative phrase: "just now", "12 min ago". The heading has
/// already said which day, so the tile's job is the last few hours, and that
/// is the one range where relative reads better than a clock — "3 hr ago"
/// tells you what "11:42" makes you work out.
///
/// Under Yesterday, the clock time; the heading carries the day. Under
/// Earlier, the date, because the heading no longer says which day it was.
///
/// THE LOCALE IS THE APP'S, never the browser's. Left to `undefined`, a
/// reader who has put Daimond into German gets every other word in German
/// and this one in whatever their browser was installed as. js/trash.js
/// makes the same point about its own dates and for the same reason.
export function tileWhen(ms, now) {
	var bucket = dayBucket(ms, now);
	if (bucket === 'today') {
		var mins = Math.floor(((now == null ? Date.now() : now) - ms) / 60000);
		if (mins < 1)  return tOr('rail.when_now', 'just now');
		if (mins < 60) return tOr('rail.when_min', '{n} min ago', { n: mins });
		return tOr('rail.when_hr', '{n} hr ago', { n: Math.floor(mins / 60) });
	}
	return window.DaimondTime.fmtLocal(ms, bucket === 'yesterday' ? 'clock' : 'dayMonth');
}

/// The first thing the user said in a chat, trimmed to one line.
///
/// The FIRST user message and never the latest: it is the closest thing a
/// chat has to a subject, and it does not move underneath somebody who is
/// using the rail to find their way back to something. An interjection is
/// skipped — it belongs to a turn already in flight and is usually "stop".
export function chatOpening(s) {
	var msgs = (s && s.messages) || [];
	for (var i = 0; i < msgs.length; i++) {
		var m = msgs[i];
		if (!m || m.role !== 'user' || m.interject) continue;
		var line = String(m.content == null ? '' : m.content).replace(/\s+/g, ' ').trim();
		if (line) return line;
	}
	// NOT RESIDENT: a Stage 1 chat's transcript is loaded only when it is
	// opened, so a tile for anything else on the rail has no `messages` to
	// scan here — see `hydrateChat`. `opening` is the same line, captured
	// on the summary at the chat's last save, and is what lets a tile title
	// and preview a chat this session has never had to load in full.
	if (s && s.opening) return s.opening;
	return '';
}

/// What to call this chat in a sentence — a toast, an aria label, the centre
/// header — where a bare "2 hr ago" would not do.
///
/// The user's own name when they set one; then THE FIRST THING THEY SAID, cut to six
/// words; then "New chat". It used to answer "the chat from just now" for everything
/// unnamed, which reads as a sentence rather than a title and truncates on a phone to
/// "the chat from just…" — a rail of them says nothing about any of them (audit
/// CHAT-02). The opening line is the closest thing a chat has to a subject and it does
/// not move under somebody using the rail to find their way back.
///
/// Never the empty string, which would leave "Moved to the trash" naming nothing.
/// What a chat's icon default reads (js/avatar.js): its name, or its WHOLE opening line.
/// Not chatDisplayName's six-word cut, which leaves "Is it possible to build a…" for a
/// chat about a solar aircraft: all stop words, so every such chat drew the bubble (av-K).
export function chatIconName(s) {
	return (s && (s.name || chatOpening(s))) || chatDisplayName(s);
}
export function chatDisplayName(s) {
	if (s && s.name) return s.name;
	if (!s) return tOr('rail.a_chat', 'a chat');
	var opening = chatOpening(s);
	if (opening) {
		// SIX WORDS, then an ellipsis. Cut on words rather than characters so the title
		// never ends mid-word, and left whole when it is already short enough.
		var words = opening.split(' ');
		return words.length > 6 ? words.slice(0, 6).join(' ') + '…' : opening;
	}
	return tOr('rail.new_chat', 'New Chat');
}

export function renderSessionList() {
	// A turn aborted by the lock still runs its finally block, which asked for
	// a re-render — and repainted the chat list, names and spend, behind the
	// lock screen. Nothing draws while locked, no matter who asks.
	if (pg.locked) return;
	sessionList.innerHTML = '';
	// A daimon's conversation is a chat record and NOT a chat: it belongs to its
	// Diamond, is reached through that Diamond's chat view, and has no tile of its
	// own. This is the only place the difference shows — everything else that walks
	// `chats` (spend, the fold-model sweep, "is anything generating", the sync
	// parcel) wants it counted exactly like the rest.
	var loose = pg.chats.filter(function (c) { return !c.diamondId; });
	if (loose.length === 0) {
		var note = document.createElement('div');
		note.className = 'rail-note';
		note.textContent = t('rail.no_chats');
		sessionList.appendChild(note);
		repaintPause();
		return;
	}
	// Newest touched first (notes4: "the ordering is weird"). `loose` used to
	// draw in plain array order, and that order was never a sort -- it was
	// whichever of two unrelated orders last wrote it: `newChat` unshifts, so
	// a chat made this session jumps to the front, but `loadChats` reads
	// IndexedDB with a bare `openCursor()`, which walks the store ascending
	// BY ID STRING. Ids were `'c' + seq` then, so that was lexicographic, not
	// numeric -- past the tenth chat, 'c10' sorts before 'c2', and a reload
	// silently reshuffles a list that "New chat" had just put in a sensible
	// order. Sorting explicitly on `updatedAt` fixes both: it is stamped by
	// `touchChat` on creation, on every turn sent and every reply landed (not
	// the `touched`/`updated` pair a tag's pool conflated, at seq48's cost --
	// see reference_daimond_tag_loss_incident), so it is the one field that
	// actually answers "which of these did I touch most recently".
	loose.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
	// GROUPED BY DAY, which the sort above already makes free: the list is
	// newest first, so each bucket is a contiguous run and one pass emits a
	// heading whenever the run changes. No second sort and no bucketing pass.
	//
	// Only where the group actually changes -- a rail whose chats are all
	// from this afternoon gets one "Today" and no other furniture.
	var now = Date.now(), seen = '';
	loose.forEach(function (s) {
		var b = dayBucket(s.updatedAt || now, now);
		if (b !== seen) {
			seen = b;
			var h = document.createElement('div');
			h.className = 'rail-day';
			h.setAttribute('role', 'presentation');
			// Three literal calls rather than one assembled key, so dev/i18nfallback.mjs
			// can see them. A key built by concatenation, with its fallback fetched from
			// an object, is invisible to that check -- which is the same shape as the
			// three drifted fallbacks it was written for, where the sentence was
			// ASSEMBLED rather than copied and so had no literal to keep in step.
			h.textContent = b === 'today'     ? tOr('rail.day_today', 'Today')
				: b === 'yesterday' ? tOr('rail.day_yesterday', 'Yesterday')
				: tOr('rail.day_earlier', 'Earlier');
			sessionList.appendChild(h);
		}
		sessionList.appendChild(sessionBox(s));
	});
	updateActiveSession();
	// The times on those tiles go stale as the app sits open. See `startWhenClock`.
	startWhenClock();
	// A chat appearing or going changes what is under the root, and the root's
	// own light is not rebuilt here. `DaimondPause` announces when the STATE
	// moves; nothing announces when the tree does.
	repaintPause();
}

/// Keep the relative times on the rail honest as the app sits open.
///
/// A tile that says "just now" is a lie a minute later, and this app is one
/// people leave open all day. It rewrites the TIME TEXT ONLY -- never
/// `renderSessionList`, which would rebuild every tile once a minute and
/// take the focus, the scroll position and any half-typed pulldown with it.
///
/// A day heading can go stale too, at midnight and only then, and a rebuild
/// is the honest fix for that one: the tiles have to move between groups.
/// So the tick redraws the whole rail exactly when the bucket a tile belongs
/// to has changed, and touches nothing else the rest of the time.
var _whenTimer = null;
function startWhenClock() {
	if (_whenTimer) return;
	_whenTimer = setInterval(function () {
		if (pg.locked || !sessionList) return;
		var now = Date.now(), restack = false;
		// `.tile-when-sub` since the title moved off `.tile-when` and onto its
		// own line that never carries a `data-at` -- see `sessionBox`. Both
		// classes queried so an older tile mid-transition (there is none today,
		// but the guard costs nothing) still ticks.
		sessionList.querySelectorAll('.tile-when, .tile-when-sub').forEach(function (el) {
			var ms = parseInt(el.dataset.at || '0', 10) || 0;
			if (!ms) return;
			if (el.dataset.bucket !== dayBucket(ms, now)) { restack = true; return; }
			el.textContent = tileWhen(ms, now);
		});
		if (restack) renderSessionList();
	}, 60000);
}

// Populate a <select> with the cached model list, keeping `selected` (and
// the default) present even if the list has not loaded yet.
/// Fill a model pulldown: every provider's models, grouped under the provider that runs them.
///
/// This used to list the models of the ONE provider the app held. With a key per provider, a
/// bare model id no longer says which key to send it with, so the picker is grouped and the
/// provider rides on the option. `DaimondModels` owns both, because the tile and the New Diamond
/// dialog must not each grow their own idea of what a model is.
function populateModelSelect(sel, selected, provider) {
	if (!window.DaimondModels) { sel.innerHTML = ''; sel.disabled = true; return; }
	DaimondModels.fillSelect(sel, provider || '', selected || '');
}

/// Where a conversation folds, as a fraction of its window: `compact::FOLD_AT`.
///
/// Named here only so a tile whose agent has not been built yet can still draw the
/// mark. Where there IS an agent its own figure is preferred, because that is the one
/// actually in force — and where the USER has chosen one, `cfg.foldAt` is what was put
/// on that agent, so the two agree without this file having to reconcile them.
///
/// It was 0.8 until 2026-08-28. Keep it equal to `compact::FOLD_AT`: a meter drawn from
/// a stale copy marks the fold in a place the engine does not fold at, which is worse
/// than drawing no mark.
export var DEFAULT_FOLD_AT = 0.65;

/// The band a chosen fold fraction is held inside: `compact::FOLD_AT_MIN` and
/// `compact::FOLD_AT_MAX`, which is where the engine clamps whatever it is handed.
export var FOLD_AT_MIN = 0.1, FOLD_AT_MAX = 0.95;

/// The most context one round may carry whatever the window, in tokens:
/// `compact::ABSOLUTE_CAP`, and the band `Agent::set_context_cap` holds a choice inside.
///
/// Named here for the same reason `DEFAULT_FOLD_AT` is -- a tile drawn before its agent is
/// built still has to mark the fold in the right place -- and it goes stale the same way.
/// Keep it equal to the engine's figure.
export var DEFAULT_CONTEXT_CAP = 120000;
export var CONTEXT_CAP_MIN = 16000, CONTEXT_CAP_MAX = 1000000;

/// The most one TURN may spend before the engine stops it, in US dollars:
/// `compact::DEFAULT_SPEND_CAP_USD`, and the band `Agent::set_spend_cap_usd` holds a choice
/// inside.
///
/// It is the ceiling that holds a runaway, and the round limit is not: a turn that reaches
/// `compact::DEFAULT_MAX_ROUNDS` carries itself on up to `compact::MAX_CONTINUATIONS` times,
/// so six hundred rounds is a thing the app will do unattended. Keep it equal to the engine's
/// figure, which goes stale the same way `DEFAULT_CONTEXT_CAP` does.
export var DEFAULT_SPEND_CAP = 5;
export var SPEND_CAP_MIN = 0.01, SPEND_CAP_MAX = 1000;

/// The headroom a turn asks a minted key to hold, in MINOR units: the turn's own
/// spend cap, since that is the most a turn can draw before the engine stops it.
/// The gateway clamps this to its own band (float floor, `max_headroom_minor`
/// ceiling), so a generous figure here costs nothing -- it only tells the gateway
/// "size the key for a whole turn", which is exactly what stops the mid-turn cap
/// refusal `ensure` exists to prevent.
export function ensureWantMinor() {
	var dollars = pg.cfg.spendCap || DEFAULT_SPEND_CAP;
	return Math.ceil(dollars * 100);
}

/// The window this chat is really folding against, and where in it the fold happens.
///
/// Not simply what the provider publishes. A provider that refuses an oversized prompt
/// teaches the agent a SMALLER window (`Limits::learn_from_refusal`), and from then on
/// a meter drawn from the published figure is measuring against a window this chat has
/// already been told it does not have — reading comfortable while the next turn folds.
///
/// `foldAt` IS THE EFFECTIVE FOLD POINT AND NOT THE CHOSEN FRACTION. `Limits::budget` takes
/// the LOWER of the window's fraction and a ceiling in tokens, so on a large window the
/// fraction is not where the conversation folds at all: at 0.65 of 1,310,720 the mark would
/// sit at 65% while the engine folds at about 9%. Every caller of this draws or says "it
/// folds at X", so the effective point is what they must be handed.
export function chatWindow(s) {
	var app = s && s.app;
	var at  = DEFAULT_FOLD_AT, cap = DEFAULT_CONTEXT_CAP, cw = 0;
	if (app) {
		try { at = app.fold_at || DEFAULT_FOLD_AT; } catch (e) { /* older wasm: no getter */ }
		try { cap = app.context_cap || DEFAULT_CONTEXT_CAP; } catch (e) { /* ditto */ }
		try { cw = app.context_window || 0; } catch (e) { /* ditto */ }
	}
	if (!cw) {
		cw = (window.DaimondPricing
			? DaimondPricing.contextWindow(s.model, s.provider || '') : 0) || 0;
	}
	return { window: cw, foldAt: foldPoint(cw, at, cap), chosenFoldAt: at, cap: cap };
}

/// Where the conversation actually folds, as a fraction of the window.
///
/// The lower of the two ceilings `Limits::budget` takes, expressed back as a fraction so the
/// bar and the sentence can both use it. With no window published there is no denominator and
/// the chosen fraction is all there is to say.
function foldPoint(cw, at, cap) {
	if (!cw) return at;
	return Math.min(at, (cap || DEFAULT_CONTEXT_CAP) / cw);
}

/// The window a DAIMON'S conversation is folding against.
///
/// `chatWindow` reads the record's own agent, and a daimon's record has none by
/// design — it runs on `daimonApp`, its Diamond's own client. So the built client is
/// looked up rather than made: a tile is redrawn on every list render, and calling
/// `daimonApp` to draw a bar would mint an agent per Diamond, and note a model as used,
/// on the strength of a repaint. Where none has been built yet the published window
/// stands, which is where `chatWindow` ends up anyway.
export function daimonWindow(dc) {
	var app = null, m = turnModelOf(dc);		// the Diamond's model; the record holds none (C3)
	try {
		var a = appCfgFor(m);
		app = _daimonApps.get(diamondAppKey(a) + '\u0000' + String(dc.diamondId || ''))
			|| _diamondApps[diamondAppKey(a)] || null;
	} catch (e) { /* nothing built, or no model list: the published figure stands */ }
	return chatWindow({ app: app, model: m.model, provider: m.provider });
}

// The context bar alone: window fraction, fold mark, percentage. Factored out
// of `tileMeter` when the Diamond tile wanted the bar without the cost that
// rides beside it on a chat -- one implementation, two callers, so
// the bar cannot come to mean something slightly different in the two places.
/// Returns null when there is nothing to draw: no window published, or no
/// tokens spent. The two cases are different facts and the CALLER decides
/// which one it is looking at; a bar invented to fill the silence would hide
/// the difference.
export function tileCtxBar(s, win) {
	var cw = win.window;
	var last = s.lastPrompt || 0;
	if (!cw || last <= 0) return null;
	var pct = Math.min(100, Math.round(last / cw * 100));
	var foldPct = Math.round(win.foldAt * 100);
	var ctx = document.createElement('span');
	ctx.className = 'tile-ctx';
	ctx.title = t('tile.context_used_folds', {
		used: fmtCtx(last), all: fmtCtx(cw), at: foldPct,
	});
	var bar = document.createElement('span'); bar.className = 'tile-ctx-bar';
	var fill = document.createElement('span');
	fill.className = 'tile-ctx-fill' + (pct >= foldPct ? ' high' : '');
	fill.style.width = pct + '%';
	bar.appendChild(fill);
	// Where the fold happens, drawn ON the bar. The number has existed in
	// `compact.rs` since folding was written and has never been anywhere a user
	// could see it, so a meter at 78% said nothing about whether that was nearly
	// there or plenty of room.
	var mark = document.createElement('span');
	mark.className = 'tile-ctx-fold';
	mark.style.left = foldPct + '%';
	bar.appendChild(mark);
	var lab = document.createElement('span'); lab.className = 'tile-ctx-pct'; lab.textContent = pct + '%';
	ctx.appendChild(bar); ctx.appendChild(lab);
	return ctx;
}

// The live per-chat meter: context-window fraction, then cost. No token count
// (D-20261010-04): the percentage already says how full the chat is, and a raw
// count beside it was a second reading of the same thing in a harder unit.
function tileMeter(s) {
	var wrap = document.createElement('div');
	wrap.className = 'tile-meter';
	var total = (s.promptTokens || 0) + (s.completionTokens || 0);
	var ctx = tileCtxBar(s, chatWindow(s));
	if (ctx) wrap.appendChild(ctx);
	if (window.DaimondPricing && total > 0) {
		// What the provider charged, where it said. Only when it did not is the table asked,
		// and then with the cached share and the provider id -- both of which this used to
		// throw away, so a cache-heavy chat was billed on the tile as though every prompt
		// token were fresh. The tile's sentence rides in the price tag's title.
		var cost;
		if ((s.costUsd || 0) > 0) {
			cost = DaimondI18n.priceTag(s.costUsd, { cls: 'tile-cost', note: t('tile.cost_so_far') });
		} else {
			var pr = DaimondPricing.priceFor(s.model, s.promptTokens || 0, s.completionTokens || 0,
				s.cachedTokens || 0, s.provider || '');
			cost = pr ? DaimondI18n.priceTag(pr.usd, { cls: 'tile-cost', estimated: pr.estimated,
				note: t(pr.estimated ? 'tile.cost_estimated' : 'tile.cost_so_far') }) : null;
		}
		if (cost) wrap.appendChild(cost);
	}
	return wrap;
}

var _tileRowSeq = 0;		// so each tile's labelled control gets its own id

/// Is this empty tile waiting for a transcript that lives somewhere else?
///
/// Only ever a "may be": this device cannot see the other one's record. What
/// it can see is that the chat holds nothing, that it was not made a moment
/// ago on this device, and that the account has a second device to have made
/// it — which together are the case a reader would otherwise read as a
/// conversation that had lost its contents. A pending chat is excluded: it
/// has not started, and the tile already says so.
function waitingOnSync(s) {
	if (!s || (s.messages || []).length) return false;
	if ((s.status || 'active') === 'pending') return false;
	var mine = deviceId();
	var reg = loadDevices();
	return Object.keys(reg).some(function (id) { return id !== mine; });
}

function sessionBox(s) {
	var status = s.status || 'active';
	var box = document.createElement('div');
	// The row's selected look is `paintRailRow`'s alone, so there is one place
	// that decides which of the rail's two lists wears the accent.
	box.className = 'session-box chat-box ' + status;
	box.dataset.id = s.id;
	// How much of itself this tile draws, which is the global view and the
	// CSS is what acts on it.
	box.dataset.detail = tileDetail();

	// THE LABEL IS DERIVED AND IT IS NOT AN INPUT ANY MORE.
	//
	// It was an `<input>` whose only purpose was that a double-click renamed
	// the chat. That gesture has gone, because renaming a chat is what
	// somebody does at the moment they have decided the conversation matters
	// — and the useful thing to do at that moment is make a Diamond of it,
	// not relabel something still on a three-day clock. So the button below
	// is Keep, a plain rename lives in the cog dialog where it is out of the
	// way, and this is a `<button>`: it does one thing, opening the chat,
	// which is what a click on it always did.
	var stamp = s.updatedAt || Date.now();
	var header = document.createElement('div');
	header.className = 'session-box-header';
	var label = document.createElement('button');
	label.type = 'button';
	label.className = 'tile-label';
	// THE TITLE, per `chatDisplayName`: the user's own name; else the first
	// six words of the first thing they said; else "New chat" (CHAT-02 /
	// annoyance 10 — every tile used to read as its bare age, "just now",
	// with nothing beside it to tell one chat from the next). Kept as
	// `.tile-when` and left with no `data-at`, so `startWhenClock` -- which
	// walks that class to keep ages honest -- never overwrites a title with
	// a clock face; that guard is the same one a user's own name already
	// relied on.
	var when = document.createElement('span');
	when.className = 'tile-when';
	when.textContent = chatDisplayName(s);
	// THE AGE, always its own line beside the title rather than standing in
	// for it. `data-at` is what `startWhenClock` ticks forward once a
	// minute; see the comment there.
	var clock = document.createElement('span');
	clock.className = 'tile-when-sub';
	clock.dataset.at = String(stamp);
	clock.dataset.bucket = dayBucket(stamp);
	clock.textContent = tileWhen(stamp);
	label.appendChild(when); label.appendChild(clock);
	label.title = t('tile.click_to_open');
	label.setAttribute('aria-label', chatDisplayName(s));
	label.addEventListener('click', function (e) { e.stopPropagation(); selectChat(s); if (isMobile()) mshow('ai'); });
	// Its icon, as a Diamond's (js/avatar.js). A chat has no tags; its name is its title.
	if (window.DaimondAvatar) header.appendChild(DaimondAvatar.button({ kind: 'chat', id: s.id, name: chatIconName(s), tags: [] }));
	header.appendChild(label);
	// NO TRAFFIC LIGHT ON AN ORDINARY CHAT. The user's ruling: "ordinary chats
	// do not need a pptw", which is the same rule that took it off an
	// unautomated Diamond — a widget is for what spends WITHOUT being asked,
	// and a chat spends when you type in it and at no other time.
	//
	// notes2 never asked for one here either; it names global, mail-panel,
	// mailbox, folder, diamond tile and TA. This one arrived in phase B.
	header.appendChild(tileCog(chatDisplayName(s), function () {
		openTileDialog({
			id:       s.id,
			name:     chatDisplayName(s),
			node:     DaimondPause.id('root', 'chats', s.id),
			// The chat's model row, and the context section: its conversation is
			// the only one in the app with a durable session.
			chat:     s,
			onDelete: function () { return deleteChat(s); },
		});
	}));
	// Outside the cog, the row's far edge -- see the comment above `.tile-cog,
	// .tile-x` in app.css for why that slot and not the near one. `deleteChat`
	// is the same confirm-then-remove the dialog's own foot calls, so a
	// one-click close and a settings-dialog delete ask the identical question
	// and can never drift apart into two answers for one act.
	header.appendChild(tileCloser(chatDisplayName(s), function () { deleteChat(s); }));
	box.appendChild(header);

	// THE FIRST THING YOU SAID, dimmed, under the time. It is what makes a
	// rail of nameless chats navigable at all -- see `cfg.chatPreview` for
	// why it is a setting and why it defaults on. Absent on a pending chat,
	// which has nothing said in it yet, and absent when the user has turned
	// it off.
	if (pg.cfg.chatPreview !== false) {
		var opening = chatOpening(s);
		if (opening) {
			var prev = document.createElement('div');
			prev.className = 'tile-preview';
			// Truncated by CSS rather than by slicing the string: the ellipsis
			// then falls where the tile actually runs out at whatever width the
			// rail has been dragged to, instead of at a character count guessed
			// here. The whole line is the `title`, for a look without opening.
			prev.textContent = opening;
			prev.title = opening;
			box.appendChild(prev);
		} else if (waitingOnSync(s)) {
			// A TILE WITH NOTHING BEHIND IT IS TWO DIFFERENT THINGS, and until
			// this line the rail drew them identically: a chat somebody started
			// and never said anything in, and a chat whose transcript is on the
			// other device and has not arrived. The second is the one a reader
			// mistakes for lost work, so it says which it is.
			var wait = document.createElement('div');
			wait.className = 'tile-preview tile-waiting';
			wait.textContent = tOr('rail.not_synced', 'not synced yet');
			wait.title = tOr('rail.not_synced_help',
				'This conversation is on another of your devices and has not arrived here yet.');
			box.appendChild(wait);
		}
	}

	if (status === 'pending') {
		// Pending: pick the model here, then press Start. Start is ONE control,
		// and it lives in the centre placeholder (`renderPendingCentre`), not on
		// the tile as well: the tile chooses the model, the centre begins the
		// chat, and each action has the one home.
		var ctrls = document.createElement('div');
		ctrls.className = 'tile-pending';
		var sel = document.createElement('select');
		sel.className = 'tile-model';
		populateModelSelect(sel, s.model || pg.cfg.model || '', s.provider || '');
		sel.addEventListener('click', function (e) { e.stopPropagation(); });
		// The provider comes off the option, not out of the value: the same model name can
		// sit behind two different keys, and only the option knows which one this is.
		sel.addEventListener('change', function () {
			var p = DaimondModels.pick(sel);
			s.model = p.model; s.provider = p.provider;
			// The workers follow the chat's model until the user moves them off it
			// themselves. "Defaults to the main model" has to keep meaning that while the
			// main model is still being chosen, or a user who picks the chat's model second
			// gets workers on whatever they happened to look at first.
			if (!wsel._chosen) {
				s.workerModel = p.model; s.workerProvider = p.provider;
				populateModelSelect(wsel, p.model, p.provider);
			}
		});
		ctrls.appendChild(sel);
		// The field takes the click the native pulldown did not let through to the tile.
		if (window.DaimondModels) {
			var mp = DaimondModels.picker(sel);
			if (mp) mp.el.addEventListener('click', function (e) { e.stopPropagation(); });
		}
		box.appendChild(ctrls);

		// Below it: the model this chat's WORKERS run on. Its own row, because it is a second
		// decision about money -- a fan-out is several turns at once, and it used to be taken
		// silently on whatever model happened to be starred. A worker is dispatched by a
		// Diamond's daimon, so this is what a Diamond cut from this chat inherits.
		var wrow = document.createElement('div');
		// Its own class, so Simple can take the whole row away: the "Workers"
		// label on its own would name a control that is not there.
		wrow.className = 'tile-pending tile-worker-row';
		// A real <label>, not a `.tile-model-chip`. That pill is what a model's
		// NAME wears, so a label in one read as a second value beside the
		// pulldown rather than as the pulldown's name -- the same defect the
		// Diamond dialog's three model rows had. Naming the control also makes
		// the word a click target for it.
		var wlab = document.createElement('label');
		wlab.className = 'tile-row-label';
		wlab.textContent = t('tile.workers');
		wlab.htmlFor = 'tile-workers-' + (++_tileRowSeq);
		// The word now forwards a click to the pulldown, so it has to stop the
		// click the way the pulldown does -- otherwise the tile underneath takes
		// it as well and choosing a worker model also switches conversation.
		wlab.addEventListener('click', function (e) { e.stopPropagation(); });
		var wsel = document.createElement('select');
		wsel.className = 'tile-model tile-worker-model';
		wsel.id = wlab.htmlFor;
		wsel.title = t('tile.worker_model_help');
		// No `aria-label`: it would OVERRIDE the label element, leaving what a
		// screen reader hears and what the eye reads as two different words.
		// The longer sentence stays reachable as the title.
		populateModelSelect(wsel, s.workerModel || s.model || pg.cfg.model || '',
			s.workerProvider || s.provider || '');
		wsel.addEventListener('click', function (e) { e.stopPropagation(); });
		wsel.addEventListener('change', function () {
			var p = DaimondModels.pick(wsel);
			s.workerModel = p.model; s.workerProvider = p.provider;
			wsel._chosen = true;		// from here it no longer follows the chat's own model
		});
		wrow.appendChild(wlab); wrow.appendChild(wsel);
		if (window.DaimondModels) {
			var wmp = DaimondModels.picker(wsel);
			if (wmp) wmp.el.addEventListener('click', function (e) { e.stopPropagation(); });
		}
		box.appendChild(wrow);
	} else {
		// Active: model chip + Fold on one row, the live meter below.
		var meta = document.createElement('div');
		meta.className = 'tile-active';
		var top = document.createElement('div');
		top.className = 'tile-active-top';
		var chip = document.createElement('span');
		chip.className = 'tile-model-chip';
		chip.textContent = shortModel(s.model, s.provider); chip.title = s.model || '';
		top.appendChild(chip);
		// FOLD AND KEEP MOVED INTO THE COG (CHAT-15): every row used to carry
		// both, always, whether or not there was even a Diamond to fold into --
		// two internal verbs on every tile in the rail. `mountChatFoldKeep`
		// draws the same two acts inside the cog's own dialog now; the row
		// keeps only its title, its age and the cog that reaches them.
		// What is waiting on this chat. A queue is only drawn in the thread of
		// the chat on screen, so one left behind while the user works elsewhere
		// was invisible until they happened to go back — and it is money about
		// to be spent, which is not a thing to leave people to remember.
		var qb = queueBadge(s);
		if (qb) top.appendChild(qb);
		meta.appendChild(top);
		meta.appendChild(tileMeter(s));
		box.appendChild(meta);
	}

	box.addEventListener('click', function () {
		if (pg.current && s.id === pg.current.id) { if (isMobile()) mshow('ai'); return; }
		selectChat(s);
		if (isMobile()) mshow('ai');
	});
	// Last, so every span this tile is made of is already in it.
	paintTileColour(box, s.id);
	return box;
}

// ── Provenance (U1 of the rating design) ───────────────────
// Who an app's turns are by: its role, the model it was BUILT with -- the string the
// request carries, never `respModel()`, which is a display string -- the provider and
// the fingerprint of its instructions. Read when a turn starts, to stamp the answer's
// `prod` (provenance.js), and told to the engine so every version entry the app's file
// tools capture names its author (`Entry.by`).
export var _appProv = new WeakMap();
export function noteAppProv(app, role, model, provider, sp, run) {
	var p = { role: String(role || ''), m: String(model || ''), pv: String(provider || ''),
		sp: String(sp || '') };
	_appProv.set(app, p);
	try { if (app && app.set_provenance) app.set_provenance(p.role, p.pv, p.sp, String(run || '')); }
	catch (e) { /* an older engine records no author */ }
	return p;
}
/// The fingerprint of a role's INSTRUCTIONS -- the role plus the user's DAIMOND.md, never a
/// worker's crystal or anything else true of one turn alone. Empty on an older engine.
export function promptPrint(text) {
	try { return Wasm.prompt_fingerprint ? Wasm.prompt_fingerprint(String(text || '')) : ''; }
	catch (e) { return ''; }
}
/// The answer's product record as this page would stamp it, less what only the run knows
/// (`h`, `t`, `dev`, `at`, `hash`, `run`, `via`): the runner completes it, so a runner's
/// answer names the same role, model and instructions a Here answer does. Null where
/// provenance.js is not loaded. `em` is the turn's `errandModelOf(chat)`.
export function errandProdBase(chat, em) {
	if (!chat) return null;
	var model = (em && em.model) || '';
	var dia = !!chat.diamondId;
	// A chat's fingerprint is of the text its engine is built with (`ensureApp`); a daimon's
	// is empty, as `noteAppProv` gives it.
	var sp = dia ? '' : promptPrint(Instructions.compose(SYSTEM_PROMPT(model, chat._steer), ''));
	var p = stampProd({ k: 'answer', m: model, pv: (em && em.provider) || '',
		role: dia ? 'daimon' : 'chat', sp: sp, d: chat.diamondId || '', c: chat.id || '' });
	return prodBaseOf(p);
}
/// A product record's author, the part every record of one turn shares (`prodBase`): the
/// record with its per-row keys dropped, or null where there is none.
function prodBaseOf(p) {
	if (!p || typeof p !== 'object') return null;
	var b = Object.assign({}, p);
	['h', 't', 'dev', 'at', 'hash', 'run', 'via'].forEach(function (k) { delete b[k]; });
	return b;
}
/// The prodBase a runner's carried turn ran under, read back from its answer row's record
/// (`<run>-final`), which the runner stamped from the errand's; null where the run left no
/// stamped answer here.
export function carriedProdBase(chat, run) {
	var ms = (chat && chat.messages) || [], mid = String(run) + '-final';
	for (var i = ms.length - 1; i >= 0; i--) {
		var m = ms[i];
		if (m && m.mid === mid) return Array.isArray(m.prod) && m.prod[0] ? prodBaseOf(m.prod[0]) : null;
	}
	return null;
}
/// A product record, or null where provenance.js is not loaded.
export function stampProd(o) {
	if (!window.DaimondProvenance) return null;
	try { return DaimondProvenance.stamp(o); } catch (e) { return null; }
}
/// The record of a compactor's fold, carried by its `fold_log`; null where the fold only
/// shortened and no model wrote anything (`ev.model` absent).
export function foldProd(chat, app, ev, foldMid, turnMid) {
	if (!ev || !ev.model || !window.DaimondProvenance) return null;
	var ap = (app && _appProv.get(app)) || {};
	return stampProd({ h: DaimondProvenance.h.fold(chat.id, foldMid), k: 'crystal',
		m: ev.model, pv: ap.pv || chat.provider || '', role: 'compactor', sp: ev.sp || '',
		d: chat.diamondId || '', c: chat.id, t: turnMid || '', dev: selfDeviceId(),
		at: Date.now() });
}
/// A `mail_draft` row's record, keyed on the draft's path, which the Mail module hands back
/// by the exact text it answered with rather than by reading the sentence.
export function mailProd(result, base) {
	if (!base || !window.DaimondMail || !DaimondMail.draftOf || !window.DaimondProvenance) return null;
	var d = null;
	try { d = DaimondMail.draftOf(result); } catch (e) { d = null; }
	if (!d || !d.path) return null;
	return DaimondProvenance.rekind(base, 'mail', DaimondProvenance.h.mail(d.path));
}

/// A worker's provenance: a run id that is unique across devices (`run.id` is a per-page
/// counter), the provider it is served by and the fingerprint of the worker role and the
/// standing instructions -- WITHOUT the dispatching crystal, which changes every dispatch.
/// Kept on the run, so a report relayed after the app is gone still names it.
export function noteWorkerProv(run, provider) {
	var rid = (run.prov && run.prov.rid) || ('w-' + newMid());
	var sp = promptPrint(Instructions.compose(Prompts.role('worker', run.model), ''));
	run.prov = { rid: rid, pv: String(provider || ''), sp: sp };
	noteAppProv(run.app, 'worker', run.model, run.prov.pv, sp, rid);
}
/// A worker report's record, for the relayed message that carries it.
export function workerProd(r, chatId) {
	if (!window.DaimondProvenance || !r || !r.prov) return null;
	return stampProd({ h: DaimondProvenance.h.worker(r.prov.rid), k: 'worker', m: r.model || '',
		pv: r.prov.pv, role: 'worker', sp: r.prov.sp, d: r.diamondId || '', c: chatId || '',
		t: r.turnId || '', dev: selfDeviceId(), at: Date.now() });
}

export function install() { // page-split: install
	// page-split: install 100

	/// The tile's dialog: pause, colours, models, triggers, and Delete at the foot.
	///
	/// `opts` is `{ id, name, node, onDelete }` -- `node` being the pause node
	/// this tile's control binds to. Built here rather than through `dialog()`
	/// because that helper's body is a message and an input, and this one is a
	/// column of controls with a destructive act underneath them; it wears the
	/// same `.modal` furniture so Escape, the backdrop and the focus trap behave
	/// exactly as they do everywhere else.
	///
	/// There is no Done button. A dialog that only holds settings has nothing to
	/// confirm — everything in it has already taken effect by the time you would
	/// press it — so the way out is the closer cross in the top right, which is
	/// what a window of settings looks like everywhere else.
	/* var */ pg._tileDlgSeq = 0;		// so each dialog's heading id is its own
} // page-split: end install
