// verify_tapulldown.mjs -- triggered actions are chosen from a pulldown.
//
// notes2, verbatim: "new triggered actions (TAs) can be added with a + icon,
// and selected for editing from a pulldown", and "To avoid clutter, Instruction
// and Context should just show an edit button and a copy button to facilitate
// copying between TAs and diamonds."
//
// A previous session recorded this as decided-against on the grounds that most
// Diamonds have one action and hiding a list of one behind a click is worse
// than showing it. That was overruled: it is the spec. These are the properties
// the spec is asking for.
//
//   1. Every action a Diamond has appears in the pulldown, and only there --
//      there is no second list of rows saying the same thing twice.
//   2. Pressing + adds an action AND chooses it. Add-then-hunt is not
//      add-then-choose, and an action you cannot find is worse than no action.
//   3. Choosing an option shows THAT action's settings: a mail action's mailbox
//      and folder, a timer's minutes. This is the check that a pulldown which
//      changes the label but not the panel would fail.
//   4. Instruction and Context are an edit button and a copy button, not two
//      textareas. The clutter rule is the reason the pulldown exists at all, so
//      a panel that inlines them defeats the change.
//   5. What is written reaches triggers.json, so the file the daimon reads and
//      the box the user typed in are the same thing.
//   6. Removing the chosen action leaves a real choice behind rather than an
//      empty panel.
//
// Also: a new action must arrive HELD, and held means held on the PAUSE TREE.
// `DaimondTriggers.allowed` asks the tree and never reads the record's `on`, so
// an action that only wrote `on: false` was armed from birth -- unable to fire
// only for as long as it had nothing to say. Found by this file, because the
// pulldown puts the armed state in the option text where the row list never
// showed it.
//
// Proved red by hand rather than by a --break switch, because this tree's
// convention is to patch the thing under test from the test, and mountTriggers
// is a closure that cannot be reached. Each was shown failing by editing
// www/js/daimond.js and reverting:
//
//   check 2  -- delete `chosen = ta.id;` from the + handler          (4 red)
//   check 3  -- drop `chosen = sel.value` from the change handler    (2 red)
//   check 4  -- render instruction as a textarea in triggerPanel     (5 red)
//   held     -- drop the seedPaused call from the + handler          (2 red)
//   check 6  -- drop the `chosen` fallback at the top of draw()      (1 red)
//
// Note what check 6's break is NOT: clearing `chosen` after a removal is not
// the mechanism and never was. draw() falls back whenever `chosen` names an
// action that is not there, which is the same guard that has to survive an
// action removed on another device -- so the explicit clear was dead code and
// has been removed rather than left looking load-bearing.
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import { open, connectMock, signInAs, scratch } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	if (!cond) failures++;
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail ? ' -- ' + detail : ''));
};

const s = await open({ name: 'tapulldown', signIn: false, connect: false,
	profile: scratch('pw', 'tapulldown-' + process.pid) });
const { page: p } = s;

/// What the trigger area is showing: the options, which is chosen, and what the
/// panel beneath it contains. Read from the DOM, because the question is what
/// the user is looking at rather than what the record says.
async function area() {
	return p.evaluate(() => {
		const sel = document.querySelector('.tile-dlg-card .trig-choose');
		const panel = document.querySelector('.tile-dlg-card .trig-panel');
		const labels = panel
			? [...panel.querySelectorAll('.trig-label')].map(l => l.textContent.trim())
			: [];
		return {
			options: sel ? [...sel.options].map(o => o.textContent.trim()) : [],
			chosen:  sel ? sel.value : '',
			chosenLabel: sel && sel.selectedIndex >= 0
				? sel.options[sel.selectedIndex].textContent.trim() : '',
			panelLabels: labels,
			// The clutter rule, measured: a long text inside the panel means the
			// panel is a form again.
			textareasInPanel: panel ? panel.querySelectorAll('textarea').length : -1,
			// And the pair that replaced them.
			textRows: panel ? panel.querySelectorAll('.trig-text-row').length : -1,
			buttonsPerTextRow: panel
				? [...panel.querySelectorAll('.trig-text-row')]
					.map(r => r.querySelectorAll('button').length) : [],
			// The old shape. If rows come back, the dialog says everything twice.
			legacyRows: document.querySelectorAll('.tile-dlg-card .trig-row').length,
		};
	});
}

try {
	await signInAs(s, 'tapulldown');
	await connectMock(s);

	// Daimond Help is the subject: seeded by the same call verify_triggers uses,
	// and the one default that arrives with NO triggered actions -- so the empty
	// case below is the real empty case rather than one this file arranged.
	await p.evaluate(() => DaimondDiamond.seedDefaults());
	await p.waitForFunction(() =>
		[...document.querySelectorAll('#diamond-list .session-box-name')]
			.some(n => /Daimond Help/.test(n.textContent)), null, { timeout: 20000 });
	const id = await p.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(b => /Daimond Help/.test(b.textContent));
		return box ? box.dataset.id : '';
	});
	check(!!id, 'a Diamond to hang actions on', String(id));

	await p.evaluate((did) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${did}"] .tile-cog`).click();
	}, id);
	await p.waitForSelector('.tile-dlg-card .trig-add', { timeout: 8000 });

	// ══ A fresh Diamond has no actions, and says so with ONE button ═══
	//
	// notes3: "should simply show the plus icon button when no TAs are
	// registered, and reveal the pulldown when clicked". Most Diamonds never have
	// a triggered action, and for those the section was a pulldown, a kind
	// chooser and a paragraph explaining that none of them had anything to do.
	// So what is asserted is the whole of the section: one control, and nothing
	// beside it.
	{
		const a = await area();
		check(a.options.length === 0,
			'a new Diamond starts with no actions, so there is nothing to choose',
			a.options.join(' | ') || '(none)');
		const bare = await p.evaluate(() => {
			const host = document.querySelector('.tile-dlg-card .trig-list');
			if (!host) return null;
			const ctl = [...host.querySelectorAll('button, select, input, textarea')];
			return {
				controls: ctl.map(c => (c.textContent || '').trim() || c.tagName.toLowerCase()),
				kinds: host.querySelectorAll('select').length,
				// The explanatory line about triggers.json: worth saying once there
				// IS a file to look in, and noise before that.
				noteShown: [...document.querySelectorAll('.tile-dlg-card .tile-dlg-note')]
					.some(n => /triggers\.json/.test(n.textContent || '')
						&& n.style.display !== 'none'),
			};
		});
		check(bare && bare.controls.length === 1 && bare.controls[0] === '+',
			'and the section is a + and nothing else',
			bare && JSON.stringify(bare.controls));
		check(bare && bare.kinds === 0,
			'with no kind pulldown standing open over an empty section',
			bare && String(bare.kinds));
		check(bare && !bare.noteShown,
			'and nothing explaining where actions are kept, because there is no file yet');
	}

	// ══ 2. + adds AND chooses ═════════════════════════════════════════
	//
	// On an empty section the first press REVEALS the kind pulldown rather than
	// creating anything -- what sets an action off is decided when it is made,
	// and a + that quietly chose would put the mail case behind an action you
	// then have to delete. So: press until the chooser is there, choose, press.
	async function add(kind) {
		await p.evaluate(() => {
			if (document.querySelector('.tile-dlg-card .trig-add select')) return;
			const plus = document.querySelector('.tile-dlg-card .trig-add button');
			if (plus) plus.click();
		});
		await p.waitForSelector('.tile-dlg-card .trig-add select', { timeout: 6000 });
		await p.evaluate((k) => {
			const sel = document.querySelector('.tile-dlg-card .trig-add select');
			sel.value = k;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			document.querySelector('.tile-dlg-card .trig-add button').click();
		}, kind);
		await p.waitForTimeout(400);
	}

	// The reveal itself, asserted once: pressing + on an empty section must not
	// register an action. A + that created one would make the check above pass
	// and the user's first press irreversible.
	{
		await p.evaluate(() => {
			const plus = document.querySelector('.tile-dlg-card .trig-add button');
			if (plus) plus.click();
		});
		await p.waitForTimeout(300);
		const a = await area();
		const revealed = await p.evaluate(() =>
			!!document.querySelector('.tile-dlg-card .trig-add select'));
		check(revealed, 'pressing + on an empty section reveals the kind pulldown');
		check(a.options.length === 0,
			'and registers nothing until a kind has been chosen -- the first press is not a commitment',
			a.options.join(' | ') || '(none)');
	}

	await add('activity');
	{
		const a = await area();
		check(a.options.length === 1, 'pressing + adds one action', a.options.join(' | '));
		check(/minutes/i.test(a.chosenLabel),
			'and the action it added is the one showing -- added is chosen', a.chosenLabel);
		check(a.panelLabels.some(l => /minute/i.test(l)),
			'so the panel is the timer’s own settings', a.panelLabels.join(' | '));
		// A new action must arrive HELD, and held means held on the pause tree.
		// `DaimondTriggers.allowed` asks the tree and never reads the record's
		// `on`, so an action that only wrote `on: false` was armed -- unable to
		// fire only for as long as it had no instruction to send.
		const arrival = await p.evaluate((did) => {
			const sel = document.querySelector('.tile-dlg-card .trig-choose');
			const t = DaimondTriggers;
			const rec = (window.DaimondCore ? null : null);
			return {
				light: (document.querySelector('.tile-dlg-card .trig-pick .pptw') || {}).dataset.state,
				// The question that matters: would it be let through if it had
				// something to say?
				allowedWithWords: t.allowed(did, { id: sel.value, kind: 'activity', minutes: 30,
					instruction: 'SOMETHING TO SAY' }),
			};
		}, id);
		check(arrival.light === 'pause', 'a new action arrives held', arrival.light);
		check(arrival.allowedWithWords === false,
			'and held on the PAUSE TREE, so writing an instruction does not arm it by itself',
			String(arrival.allowedWithWords));
	}

	await add('mail');
	{
		const a = await area();
		check(a.options.length === 2, 'a second + adds a second action', a.options.join(' | '));
		check(/mail/i.test(a.chosenLabel), 'and again the new one is chosen', a.chosenLabel);
		// ══ 3. The panel follows the choice ═══════════════════════════
		check(a.panelLabels.some(l => /mailbox/i.test(l)) && a.panelLabels.some(l => /folder/i.test(l)),
			'the panel changed with it -- a mail action shows mailbox and folder',
			a.panelLabels.join(' | '));
		check(!a.panelLabels.some(l => /minute/i.test(l)),
			'and no longer shows the timer’s minutes', a.panelLabels.join(' | '));
	}

	// ══ 1. One list, not two ══════════════════════════════════════════
	{
		const a = await area();
		check(a.legacyRows === 0,
			'the actions are listed once, in the pulldown -- there is no row list saying it again',
			String(a.legacyRows));
	}

	// ══ 4. Instruction and Context are edit + copy ════════════════════
	{
		const a = await area();
		check(a.textRows === 2,
			'Instruction and Context are each one row', String(a.textRows));
		check(a.textareasInPanel === 0,
			'and neither is a textarea sitting in the panel -- that is the clutter the pulldown exists to avoid',
			String(a.textareasInPanel));
		check(a.buttonsPerTextRow.length === 2 && a.buttonsPerTextRow.every(n => n === 2),
			'each shows exactly two buttons: edit, and copy',
			a.buttonsPerTextRow.join(','));
	}

	// ══ Choosing the other one goes back ══════════════════════════════
	{
		const first = await p.evaluate(() => {
			const sel = document.querySelector('.tile-dlg-card .trig-choose');
			const other = [...sel.options].find(o => o.value !== sel.value);
			sel.value = other.value;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			return other.value;
		});
		await p.waitForTimeout(300);
		const a = await area();
		check(a.chosen === first, 'choosing another action selects it', a.chosenLabel);
		check(a.panelLabels.some(l => /minute/i.test(l)),
			'and brings its settings back', a.panelLabels.join(' | '));
	}

	// ══ 5. What is typed reaches the file ═════════════════════════════
	{
		// Open the instruction editor, type, and close it the way the reader does.
		await p.evaluate(() => {
			const row = [...document.querySelectorAll('.tile-dlg-card .trig-text-row')][0];
			row.querySelectorAll('button')[0].click();
		});
		await p.waitForSelector('.tile-dlg-card textarea.trig-area', { timeout: 6000 });
		await p.evaluate(() => {
			const area = document.querySelector('.tile-dlg-card textarea.trig-area');
			area.value = 'REACHES THE FILE';
			area.dispatchEvent(new Event('input', { bubbles: true }));
			// The last .tile-dlg-done is the editor's; the settings dialog beneath
			// has one too and closing that instead would prove nothing.
			const dones = [...document.querySelectorAll('.tile-dlg-done')];
			dones[dones.length - 1].click();
		});
		await p.waitForTimeout(600);

		const a = await area();
		check(/REACHES THE FILE/.test(a.panelLabels.join(' ') + ' ' + (await p.evaluate(() =>
			[...document.querySelectorAll('.tile-dlg-card .trig-gist')].map(g => g.textContent).join(' ')))),
			'what was typed shows on the row without reopening the editor');

		const file = await p.evaluate(async (did) => {
			const W = await import('/pkg/oxedyne_daimond.js');
			try { return await W.store_read('diamonds/' + did + '/triggers.json'); }
			catch (e) { return ''; }
		}, id);
		let parsed = null;
		try { parsed = JSON.parse(file); } catch (e) { parsed = null; }
		const written = parsed && (parsed.actions || []).some(x => x.instruction === 'REACHES THE FILE');
		check(!!written,
			'and it is in triggers.json, where the daimon reads it',
			file ? file.replace(/\s+/g, ' ').slice(0, 90) : '(absent)');
	}

	// ══ 6. Removing the chosen one leaves a real choice ═══════════════
	{
		const before = (await area()).options.length;
		await p.evaluate(() => {
			const btns = document.querySelectorAll('.tile-dlg-card .trig-pick button');
			btns[btns.length - 1].click();
		});
		await p.waitForTimeout(400);
		// An action with an instruction asks first; answer it.
		await p.evaluate(() => {
			const ok = [...document.querySelectorAll('.dlg-ok, .modal-card button')]
				.find(b => /remove/i.test(b.textContent));
			if (ok) ok.click();
		});
		await p.waitForTimeout(500);
		const a = await area();
		check(a.options.length === before - 1, 'removing takes the action away',
			a.options.join(' | ') || '(none)');
		check(a.options.length === 0 || (!!a.chosen && a.panelLabels.length > 0),
			'and what is left is chosen, not an empty panel over a full pulldown',
			a.chosenLabel + ' / ' + a.panelLabels.join(' | '));
	}
} catch (e) {
	failures++;
	console.log('  FAIL threw -- ' + (e && e.message ? e.message.split('\n')[0] : e));
} finally {
	await s.close();
}

console.log('');
console.log(failures ? `verify_tapulldown: ${failures} FAILED` : 'verify_tapulldown: all checks pass.');
process.exit(failures ? 1 : 0);
