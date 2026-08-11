/* i18n/en.js — every English string the interface says, in one table.
 *
 * This is the BASELINE. A translator copies it to `i18n/<locale>.js`, changes
 * the code in the `register` call and the values, and leaves the keys alone.
 * A key missing from a translation falls back to the English here rather than
 * to a blank, so a half-finished file is usable on the day it starts.
 *
 * Conventions:
 *   - `{name}` is a placeholder, filled at the call site. Keep every one that
 *     appears, in whatever order the target language wants them.
 *   - A key ending `.one` / `.other` is a plural pair, chosen by count. A
 *     language with more forms adds them and overrides the chooser.
 *   - Keys ending `_help` are tooltips, `_ph` are placeholders inside a field.
 *   - British spelling throughout the English.
 *   - Product nouns are NOT translated: Daimond, Diamond, Daimond Pro, Hands.
 *     A "Diamond" is a named object in this app, not the gemstone.
 */
(function () {
	'use strict';
	if (!window.DaimondI18n) return;

	window.DaimondI18n.register('en', {

	// ── Shared words ───────────────────────────────────────────
	'common.close':        'Close',
	// The spoken name of a closer, so a reader hears which of the app's
	// crosses this is rather than a fourth button called Close.
	'common.close_named':  'Close {name}',
	'admin.close_drawer':  'Close the Admin panel',
	'rail.close_rail':     'Close the Diamonds panel',
	'sheet.close':         'Close the sheet',
	'pal.close':           'Close the Go to box',
	'common.dismiss': 'Dismiss',
	'agents.read': 'Read',
	'common.close_panel':  'Close panel',
	'common.refresh':      'Refresh',
	'common.copy':         'Copy',
	'common.cancel':       'Cancel',
	'common.save':         'Save',

	// Copying an identifier. `copy.aria` wraps each `what_` so a reader hears
	// "Copy the build id" rather than five buttons all called Copy.
	'copy.aria':               'Copy {what}',
	'copy.failed':             'Could not copy',
	'copy.nothing':            'Nothing to copy',
	'copy.what_build':         'the build id',
	'copy.what_build_n':       'build {id}',
	'copy.what_fingerprint':   'your account fingerprint',
	'copy.what_device':        'the id of {name}',
	'copy.what_model':         'model id {id}',
	'copy.what_default_model': 'the default model id',

	// ── The top bar ────────────────────────────────────────────
	'topbar.menu':        'Menu',
	'topbar.open_menu':   'Open menu',
	'topbar.brand':       'Daimond, the daimond.app home page',
	'topbar.made_by': 'Made by Oxedyne',
	'topbar.made_with_ai': 'Code made mostly with AI',
	'topbar.up_to_date':  'Daimond is up to date',
	'topbar.about':       'About Daimond',
	'topbar.guide':       'Open the user guide',
	'topbar.guide_short': 'User guide',
	'topbar.appearance':  'Appearance and layout',

	// ── About ──────────────────────────────────────────────────
	// `about.what` is the guide's opening paragraph, near enough word for word:
	// it is already the house voice and already says it, and a second wording
	// would be a second thing to keep true.
	//
	// It said "nothing to install" until the app became installable -- a service
	// worker, a manifest and a guide section on adding it to a home screen -- at
	// which point the About box was denying a feature that had shipped. The
	// guide's own word is "nothing to DOWNLOAD", which is what stayed true: an
	// installed Daimond is the same page and the same stored work, with an icon
	// and a window of its own, and nothing is fetched to a disk.
	'about.title':     'About Daimond',
	'about.splash_alt': 'A figure flying through the night towards a diamond, above the curve of a planet.',
	'about.what':      'Daimond is an AI agent workspace that runs in your browser. There is no server account and nothing to download. Your chats, keys and files stay on this device.',

	// ── Panel names ────────────────────────────────────────────
	// Short: they ride in a chip row and a phone tab bar.
	'panel.rail':    'Diamonds',
	'panel.ai':      'AI',
	'panel.web':     'Web',
	'panel.doc':     'Doc',
	'panel.msg':     'Message',
	'panel.tools':   'Tools',
	'panel.compose': 'Compose',
	'panel.graph':   'Graph',
	'panel.agents':  'Agents',
	'panel.pending': 'Pending',
	'skills.menu':   'Skills you can call',
	'skills.none':   'No skills yet. Put a markdown file in {dir} and its name becomes a command.',
	'panel.mail':    'Email',
	'panel.work':    'Workspace',
	'panel.spend':   'Spending',
	'panel.term':    'Terminal',

	// ── The chip row ───────────────────────────────────────────
	// {name} is a panel's name, from `panel.*` above.
	'chip.dock_full':    'The dock is full. Choose a larger tiling in Appearance, or close a panel.',
	'chip.show':         'Show {name}',
	'chip.close':        'Close {name}',
	'chip.open':         'Open {name}',
	'chip.open_instead': 'Open {name} in place of the panel beside the chat',
	'chip.more.one':     '{n} more panel',
	'chip.more.other':   '{n} more panels',

	// ── The panel gallery and the command palette ──────────────
	'gallery.title':    'Panels',
	'pal.title':        'Go to',
	'pal.placeholder':  'Go to a panel, or a setting…',
	'pal.results':      'Results',
	'pal.nothing':      'Nothing matches.',
	'pal.kind_panel':   'Panel',
	'pal.kind_theme':   'Theme',
	'pal.kind_size':    'Text size',
	'pal.kind_dock':    'Dock',
	'pal.kind_lang':    'Language',
	'pal.kind_ccy':     'Currency',
	'pal.kind_permmode': 'Permissions',
	'pal.hint_open':    'open',
	'pal.hint_full':    'dock full',
	'pal.hint_current': 'current',

	// ── The rail ───────────────────────────────────────────────
	'rail.diamonds':             'Diamonds',
	'rail.diamonds_help':        'A repeatable method, distilled from a conversation.',
	'rail.new_diamond':          'New Diamond',
	'rail.unnamed_diamond': 'Unnamed Diamond',
	'rail.chats':                'Chats',
	'rail.chats_help':           'Raw conversation. A Diamond is cut from it.',
	'rail.new_chat':             'New chat',
	'rail.chats_menu':           'More',
	'rail.delete_all_chats':     'Delete all chats',
	'layout.handle':             'Drag to resize, double-click to reset',

	// ── Admin ──────────────────────────────────────────────────
	'admin.identity':        'Your Daimond identity',
	'admin.settings':        'Settings',
	'admin.local_identity':  'Local identity',
	'admin.account_help':    'Your account. Click for logout, passphrase and backup.',
	'admin.locked':          'Locked',
	'admin.locked_help':     'Locked. Enter your passphrase to unlock.',
	'admin.no_account':      'No account',
	'admin.no_account_help': 'Your API key is stored unencrypted. Click to create an account and encrypt it.',
	'admin.no_crypto_help':  'This browser has no WebCrypto, so keys cannot be encrypted here.',
	'admin.version_history': 'Version history',

	// ── The Admin drawer ───────────────────────────────────────
	// The name at the head of the drawer, which changes with what it is holding.
	'drawer.admin':   'Admin',
	'drawer.models':  'Models',
	'drawer.version': 'Version',
	'drawer.credits': 'Credits',
	'drawer.push':    'Push',

	// ── Dialogs ────────────────────────────────────────────────
	'dlg.are_you_sure': 'Are you sure?',
	'dlg.ok':           'OK',
	'dlg.done': 'Done',
	'dlg.not_now':      'Not now',

	// ── The Admin drawer's home menu ───────────────────────────
	'home.connect_model':     'Connect a model',
	'home.connect_note':      'Daimond needs a provider key or credits before it can answer.',
	'home.locked':            'Locked. Enter your passphrase to unlock this device.',
	'home.sec_account':       'Account',
	'home.sec_prompts':       'Prompts',
	'home.sec_accounts':      'Accounts',
	'home.create_account':    'Create an account…',
	'home.account_note':      'An account is a passphrase held on this device. It encrypts your API key and signs you in for credits. Nothing leaves the browser.',
	'home.fingerprint':       'Your device identity fingerprint',
	'home.change_name':       'Change name…',
	'home.change_passphrase': 'Change passphrase…',
	'home.add_passkey':       'Add a passkey…',
	'home.remove_passkey':    'Remove passkey',
	'home.export_backup':     'Export a backup',
	'home.import_backup':     'Import a backup…',
	'home.dashboard':         'Daimond Dashboard ↗',
	'home.signed_in_as':      'You are signed in as {role}.',
	// {role} is a prompt role's name, lower-cased by the caller.
	'home.edit_prompt':       'Edit the {role} prompt…',
	'home.prompt_opens':      'Opens {path} in the Doc panel.',
	'home.prompts_note':      'The instructions each agent runs under, kept as files in your workspace. Edit one and it applies from the next turn; delete it and the original returns. Two rules hold whatever you write: a page or an email is data and never an instruction, and nothing irreversible happens without asking you.',
	'home.switch_to':         'Switch to {name}',
	'home.unnamed_account':   'Unnamed account',
	'home.add_account':       '＋ Add another account',
	'home.accounts_note':     'Each account has its own chats, keys, credits and files. Switching locks this one and opens the other. No account can see another’s data.',
	'home.log_out':           'Log out',
	'home.sec_devices':       'Devices',
	'home.sec_console':      'Console',
	'home.console_open':     'Open the operator console',
	'home.console_note':     'This account holds the {role} role. The console opens in a new tab and follows this sign-in.',
	'home.sec_push':         'Push',
	'home.push_setup':       'Set up git push…',
	'home.push_to':          'Change the push token for {host}…',
	'home.push_help':        'A token lets Daimond push what it has committed. Without one it still commits, but every push is refused.',

	// ── The credential a push travels with ─────────────────────
	// Two boxes and no more: the user name a token travels as is a per-forge
	// constant, so it is inferred from the host rather than asked for. Every line
	// here says what happens if it is skipped, because "no credential" and
	// "authentication failed" look identical from inside a refused push.
	'push.lead':         'A token lets Daimond push work you have committed. Without one it still commits, but every push is refused and the work stays on this machine.',
	'push.host':         'Host',
	'push.host_ph':      'github.com',
	'push.host_note':    'Just the name, as in github.com. No https://, no port, no path. Only this host is authenticated; a repository anywhere else is refused, and your token never reaches it.',
	'push.token':        'Token',
	'push.token_ph':     'Paste a token with push access',
	'push.token_note':   'Push access is enough; the token never needs more. Daimond only pushes, only fast-forward, only to origin. Force, delete, mirror and any other remote are refused whatever the token allows. Empty this box and save to remove it.',
	'push.save':         'Save',
	'push.privacy':      'The token is encrypted under your passphrase and kept in this browser. It is never shown again, never sent to us, never given to a model. Without an account there is nothing to encrypt it with, so it is held for this tab only and asked for again after a reload.',
	'push.set':          'Set. A push reaches {host}.',
	'push.none':         'Not set. Every push is refused until a token is saved here.',
	'push.saved':        'Saved. Encrypted under your passphrase and used each time you unlock.',
	'push.cleared':      'Removed. Pushes are refused again until a token is saved here.',
	'push.session_only': 'Held for this tab only. With no account there is nothing to encrypt it with, so a reload asks for it again. Create an account to keep it.',
	'push.err_host':     'Enter the host the push goes to, as in github.com, or empty the token box to remove the credential.',
	'push.err_not_held': 'That was not accepted, so no push credential is held. Check the host and the token.',
	'push.not_resealed': 'Your passphrase changed, but the push token could not be re-encrypted under it. Pushing works until you reload. Set the token again to keep it.',

	// ── The devices that sync this account ─────────────────────
	// The list is what it says it is: devices that have SYNCED. A linked device
	// holds the same keys as this one, so there is nothing to revoke and the
	// wording must not imply there is.
	'devices.on_platform': '{brand} on {platform}',
	'devices.unknown':     'This device',
	'devices.this_device': 'this device',
	'devices.only_this':   'Only this device syncs this account.',
	// Naming a device. The name is the user's own words, so it never leaves the
	// browser except inside the encrypted parcel; the wording says so, because a
	// list of the user's devices is exactly where that question is asked.
	'devices.rename_title': 'Name this device',
	'devices.rename_body':  'A name to tell this device from the others. Empty the box to go back to “{derived}”. The name is stored with your own encrypted data and travels only to your other devices.',
	'devices.rename_aria':  'Rename {name}',
	'devices.note':        'Devices that have synced this account. One that holds the account but has never synced is not listed. Nothing here signs a device out. A linked device holds the same keys as this one, so it has to be dealt with there.',
	'devices.remove_aria': 'Remove {name}',
	'devices.remove_body': '“{name}” comes off this list. That does not sign the device out. It holds the same keys as this one, so it reappears the next time it syncs.',
	'devices.remove':      'Remove',
	'devices.remove_title':'Remove this device',

	// ── The status rows under the rail ─────────────────────────
	'astat.offline':             'Offline',
	'astat.service_unreachable': 'Account service unreachable',
	'astat.no_account':          'No credits account',
	'money.daimond_credits': 'Daimond credits',
	'money.own_key':         'Your {provider} key',
	'money.own_keys':        'Your own keys',
	'money.left_at_rate':    '~{mins} min at this rate',
	'money.spent_so_far':    '{amt} spent',
	'money.spent_help':      'Your provider reports no balance, so this is what has gone through this key since Daimond started counting.',
	'money.estimate_help':   'Your own figure, less what has been spent since. Update it in Models when you top up.',
	'astat.locked':          'Locked',
	'astat.credits':             'Credits',
	'astat.credits_help':        'Buy credits, or connect your own provider key',
	'astat.pro_owned':           'Owned',
	'astat.pro_owned_help':      'You own Daimond Pro. Sync, cloud storage and Email are on.',
	'astat.pro_upgrade':         'Upgrade to Pro',
	'astat.pro_upgrade_help':    'Own Daimond once to turn on sync, cloud storage and Email.',
	'astat.tools':               'Tools · {have}',
	'astat.tools_of':            'Tools · {have} of {all}',
	'astat.tools_help':          'What Daimond can do, and what the rest would cost.',
	'astat.workspace_browser':   'Workspace · Browser',
	'astat.workspace_native':    'Workspace · Machine',
	'astat.evictable':           'evictable',
	'astat.store_of':            '{used} of {quota} this browser allows.',
	'astat.store_persistent':    'Marked persistent, so the browser will not evict it.',
	'astat.store_evictable':     'Not persistent: the browser may evict this workspace under storage pressure. Click to ask for permanent storage.',
	'astat.not_connected':       'not connected',
	'astat.native_help':         'Let the agents work on a real folder on this machine.',
	'astat.n_files':             '{n} files',
	'astat.counting':            'Counting. Click to stop.',
	'astat.part':                '(part)',
	'astat.counted':             '{n} files under {folder}.',
	'astat.counted_partial':     '{n} files under {folder}, counted until you stopped it.',
	'astat.count_again':         'Click to count again.',
	'astat.count_offer':         'Click to count it. The browser will not say how big a real folder is, and counting reads every file, so a large tree takes a while. You can stop at any point.',

	// ── Pro, in its own words ──────────────────────────────────
	'pro.owned_plain':     'You own Daimond Pro. Cross-device sync, cloud storage and Email are on. Nothing renews.',
	'pro.offer_plain':     'Own Daimond with one payment, kept for good. Pro turns on cross-device sync, cloud storage, and Email, so your own mail is read and sent in the workspace. No subscription. Inference, bandwidth and other metered use are still paid from credits.',
	'pro.checkout_failed': 'Could not start checkout',

	// ── The egress gate ────────────────────────────────────────
	// The last thing between a steered agent and a request that carries the
	// user's own information out. {host} is a hostname; keep it where a reader
	// will look for it.
	'egress.type_title':  'Type into {host}?',
	'egress.type_body':   'This turn has read content from outside your workspace. Daimond now wants to type into the page at {host}, which may send it on.\n\nWhat it wants to enter:\n\n{text}\n\nIf you did not expect this, decline.',
	'egress.type_ok':     'Type it',
	'egress.nothing':     '(nothing)',
	'egress.act_title':   'Act on {host}?',
	'egress.act_body':    'This turn has read content from outside your workspace. Daimond now wants to act on the page at {host}.\n\nWhoever wrote the page wrote its links, and following one can carry information away.\n\nAllow this only if you expected it.',
	'egress.act_ok':      'Allow acting on {host}',
	'egress.heavy_title': 'Send this to {host}?',
	'egress.heavy_body':  'This turn has read content from outside your workspace. Daimond now wants to reach {host} with an unusually long address.\n\nAn address can carry information out. This one carries:\n\n{text}\n\nIf you did not expect this, decline. Nothing is lost but the one request.',
	'egress.heavy_ok':    'Send it anyway',
	'egress.reach_title': 'Reach {host}?',
	'egress.reach_body':  'This turn has read a web page or a message from outside your workspace, and something in it may be steering Daimond.\n\nIt now wants to reach {host}, which it has not visited before. Anything it knows could ride in that address.\n\nAllow this only if you expected it.',
	'egress.reach_ok':    'Allow {host}',
	// A search, where the thing leaving is the QUERY rather than an address.
	// {query} is the user's own search text, already truncated, and it stands
	// alone in its own paragraph -- never wrapped in quotation marks, because
	// the query may contain quotes of its own and a mismatched pair reads as
	// corruption. {engine} is a display name and is sometimes a proper noun
	// (Brave Search, Serper) and sometimes a translated phrase (Daimond
	// credits). Every \n\n is load-bearing: five paragraphs, four breaks, and
	// a consent dialog run together into a wall is a dialog nobody reads. The
	// clause about the setting answers the question a real user asked -- why
	// that engine -- and the last sentence tells a frightened reader that
	// declining is cheap. Neither may be compressed away.
	'egress.search_title': 'Search the web?',
	'egress.search_body':  'This turn has read content from outside your workspace. Daimond now wants to search the web.\n\nWhat it wants to search for:\n\n{query}\n\nSearching with {engine}, which is your setting. The query is what leaves this device.\n\nIf you did not expect this, decline. Nothing is lost but the one search.',
	'egress.search_ok':    'Run this search',

	// ── A chat tile in the rail ────────────────────────────────
	'chat.copy_message':   'Copy message',
	'chat.include_turn':   'Include this turn when folding',
	'chat.connect_to_chat': 'Connect a provider, or unlock, to chat on this model.',
	'tile.cost_estimated': 'Estimated. This model is not in the price table.',
	'tile.cost_so_far':    'Cost so far for this chat.',
	'tile.click_to_open':  'Click to open, double-click to rename',
	'tile.settings': 'Settings for this tile',
	'tile.settings_named': 'Settings for "{name}"',
	'tile.close_named': 'Close "{name}"',
	'tile.dlg_running': 'Running',
	'tile.dlg_detail': 'Detail',
	'tile.detail_simple': 'Simple',
	'tile.detail_simple_help': 'The name, whether it is running, and what is waiting.',
	'tile.detail_max': 'Max',
	'tile.detail_max_help': 'Models, context, cost, version and when it last moved.',
	'tile.spend_help': 'What this Diamond has cost, over {turns} turns.',
	'tile.detail_default': 'Default ({what})',
	'tile.detail_default_help': 'Follow the view set in Appearance, and any change to it.',
	'tile.detail_note': 'Tiles follow the view unless you set one differently here.',

	// ── The models a Diamond runs on, and the context its chats hold ──
	'tile.dlg_models': 'Models',
	'tile.model_daimon': 'Daimon',
	'tile.model_daimon_help': 'The model this Diamond thinks with. Changing it starts a new daimon.',
	'tile.model_workers': 'Workers',
	'tile.model_vision': 'Workers, images',
	'tile.model_vision_help': 'The model a worker runs on when its task names an image. Daimond cannot check that a model can see, so the choice is yours.',
	'tile.model_same_as_text': 'Same as the daimon',
	'tile.model_none': 'none',
	'tile.diamond_model_help': 'This Diamond thinks with {model}.',
	'tile.model_note': 'A worker keeps the model it started on. A new model applies to the next one dispatched.',
	'tile.model_change_title': 'Start a new daimon?',
	'tile.model_change_body': 'This Diamond thinks with {from}. Continuing on {to} starts a new daimon. The crystal carries over; the conversation does not. The change goes into the crystal’s history.',
	'tile.model_change_ok': 'Change model',
	'tile.model_change_note': 'Daimon moved from {from} to {to}.',
	'tile.model_change_unlogged': 'The model changed, but the history entry could not be written.',
	'tile.dlg_context': 'Context',
	'tile.context_line': '{used} of {all} used. Folds at {at}%.',
	'tile.context_unknown': 'This model publishes no context window, so there is nothing to measure against until a request is refused.',
	'tile.context_used_folds': 'Context window used: {used} / {all}. Folds at {at}%.',
	'tile.fold_context': 'Fold now',
	'tile.fold_context_help': 'Summarise the earlier part of this conversation now, before it fills up',
	'tile.fold_context_title': 'Fold this conversation?',
	'tile.fold_context_body': 'A model summarises the earlier part, which costs a call, and the summary becomes what this chat remembers. The messages on screen stay where they are.',
	'tile.fold_context_ok': 'Fold',
	'tile.fold_nothing': 'Nothing to fold. This conversation is already as short as it goes.',
	'tile.fold_mid_turn': 'Wait for this turn to finish before folding.',
	'tile.fold_unavailable': 'This chat has no agent to fold. Say something first.',
	'tile.fold_failed': 'The fold did not finish',

	'tile.dlg_delete': 'Delete',
	'tile.start':          'Start',
	'tile.start_help':     'Confirm the model and start this chat',
	'tile.workers':        'Workers',
	'tile.worker_model_help': 'The model workers run on. Left alone, they run on the chat’s own model.',
	'tile.folded':         'Folded',
	'tile.fold_all':       'Fold all',
	'tile.folded_help':    'Already folded into "{name}". Fold again to add what is new since.',
	'tile.fold_all_help':  'Fold this whole chat into a Diamond',
	'tile.dlg_colour':  'Colour',
	'tile.colour_bg':   'Background',
	'tile.colour_fg':   'Text',
	'tile.colour_clear':'Use the theme’s colours',
	'tile.colour_faint':'These two contrast at {ratio}:1, below the usual {min}:1 floor for text this size. Left as chosen.',

	// ── The spend governor ─────────────────────────────────────
	'gov.past_budget': 'Well past your run budget',
	'gov.faster':      'Spending faster than usual',
	'gov.per_min':     '{rate}/min',
	'gov.run_spent':   'This run has spent {spent} of a {budget} pace budget. A large fan-out asks before it runs.',
	'gov.fanout_body.one':   'This Diamond is about to run {n} agent, at about {total} ({each} each).',
	'gov.fanout_body.other': 'This Diamond is about to run {n} agents, at about {total} ({each} each).',
	'gov.burst_spent': 'This burst has spent {spent} already.',
	'gov.would_pass':  'That would pass your {budget} pace budget for one run.',
	'gov.run_n.one':   'Run {n} agent',
	'gov.run_n.other': 'Run {n} agents',
	'spend.includes_estimate': 'Estimated. At least one model here is not in the price table.',

	// ── Models and provider keys ───────────────────────────────
	'models.lead':                  'A key for each provider you use. New chats and Diamonds start on the default model; any model can be picked for a single chat.',
	'models.add':                   '+ Add provider',
	'models.provider':              'Provider',
	'models.choose_provider':       'Choose a provider…',
	'models.custom_provider':       'Custom (advanced)…',
	'models.base_url':              'Base URL',
	'models.api_key':               'API key',
	'models.api_key_ph':            'Paste your API key',
	'models.default_model':         'Default model',
	'models.choose_provider_first': 'Choose a provider first…',
	'models.model_id_ph':           'Model id (type manually)',
	'models.default_note':          'New agents use this unless you choose another for them.',
	'models.save_start':            'Save & start',
	'models.privacy':               '<strong>Everything stays on this device.</strong> Your keys, chats and files live only in this browser, and nothing is sent to us.',

	// The Models panel: a row per provider, expandable to the models it runs.
	// A vendor's name (Groq, Fireworks AI) is a proper noun and is NOT here;
	// these two are names Daimond made up for itself.
	'models.credits_row':          'Daimond credits',
	'models.custom_provider_name': 'Custom provider',
	// A stand-in where the gateway did not name the company behind a minted key.
	// It goes into {provider} slots built for a BRAND NAME ("via {provider}",
	// "Remove {provider}"), so it must read as a name, not as a noun phrase with
	// an article -- "via the provider" forces an article a Romance language
	// then has to fight.
	'models.the_provider':         'your provider',
	'models.empty':                'No provider yet. Add one to give Daimond a model to think with.',
	'models.balance_left':         '{amount} left',
	'models.via':                  'via {provider}',
	'models.count.one':            '{n} model',
	'models.count.other':          '{n} models',
	'models.row_paid_help':        'These models spend your Daimond balance. Your browser calls {provider} directly with a key minted for you; nothing passes through Daimond.',
	'models.row_own_help':         'These models are billed to your own {provider} account. They do not touch your Daimond balance.',
	// What a row says about its key. The symbol in front is added by the code.
	'models.sealed':               'sealed',
	'models.key_set':              'key set',
	'models.no_key':               'no key',
	'models.connecting':           'connecting…',
	'models.no_credits':           'no credits',
	'models.offline':              'account service unreachable',
	'models.could_not_connect':    'could not connect',
	'models.unlock_to_use':        'unlock to use',
	'models.sealed_unlock':        'sealed, unlock to use',
	'models.top_up_to_use':        'top up to use',
	'models.top_up':               'Top up your credits →',
	'models.ask_provider':         'Ask this provider what it can run',
	'models.waiting_credits':      'Waiting for your credits…',
	'models.add_key_first':        'Add a key first',
	'models.asking':               'Asking…',
	// One model in the list.
	'models.econ_credits':         'credits',
	'models.econ_own':             'your key',
	'models.favourites': 'Favourites',
	'models.is_default':           'default',
	'models.model_is_default':     'New chats and Diamonds start on this model.',
	'models.model_make_default':   'Make this the model new chats and Diamonds start on.',
	'models.model_paid':           'Spends your Daimond balance, via {provider}.',
	'models.model_own':            'Billed to your own {provider} account.',
	'models.model_twin':           'Another provider serves a model of this name. This is the {provider} one.',
	'models.remove':               'Remove {provider}',
	'models.starts_on':            'New chats start on: {model}',
	'models.no_default':           'No default model yet. Star one above.',
	'models.none_yet':             'No provider yet',
	'models.err_refused':          'The account service refused (HTTP {status}).',
	'models.err_bad_key':          'The account service sent a key Daimond cannot use.',
	'models.err_no_key':           'That provider has no key yet.',
	'models.err_key_refused':      'The provider refused the key (HTTP {status}).',
	// What is left on a provider key, and how that is known. The manual line is
	// deliberately not called a balance: it is the user's own figure less an
	// estimate, and saying so is the whole point of showing it.
	'models.credit_auto':          '{amount} left on this key, as the provider said at {when}.',
	'models.credit_manual':        '{amount} left. Your {base} from {when}, less about {spent} spent since.',
	'models.credit_unknown':       'Nothing known about what is left on this key.',
	'models.credit_check':         'Ask what is left',
	'models.credit_recheck':       'Ask again',
	'models.credit_probe_failed':  '{provider} would not say what is left. Tell Daimond instead.',
	'models.credit_base_ph':       'e.g. 12.50',
	'models.credit_base_label':    'What is on this key now, in US dollars',
	'models.credit_base_set':      'I have this much, as of now',
	'models.credit_base_update':   'Update my figure',
	'models.credit_base_bad':      'That is not an amount. Enter a number of US dollars.',

	// ── Search ─────────────────────────────────────────────────
	// The engine is the USER's setting, not the model's choice, so every string
	// here belongs to the settings row rather than to a tool result. Engine
	// names (Brave, Exa, Tavily, Serper) are proper nouns and are not here, for
	// the same reason a provider's name is not: see the note above
	// `models.credits_row`.
	'search.head':            'Search',
	'search.engine':          'Search engine',
	// An allowance, not a free key: the key costs nothing and the queries past
	// the allowance are billed by the vendor, to the user. Deliberately no
	// figure and no engine named -- a number here goes stale silently when a
	// vendor changes its tier, and nobody re-reads eight locales to catch it.
	// The per-engine line under the field (`.search-engine-note`) is the one
	// that can be accurate.
	'search.engine_note':     'Which service Daimond searches with. Most give a free allowance each month if you bring your own key.',
	'search.credits':         'Daimond credits',
	'search.key':             'API key',
	'search.key_note':        'Kept on this device, sealed with your passphrase, and sent only with the search it pays for.',
	// {engine} is an engine's name, e.g. Brave. It is never translated.
	'search.no_key':          'Add a key for {engine}, or switch to Daimond credits.',
	// What is being searched: the open web, the news, or scholarly work. Three
	// peers in one pulldown, so none of them takes an article, and the third
	// is "Academic" rather than "Research" -- French would otherwise have one
	// word, Recherche, doing three jobs in one panel: the heading, the engine
	// and the corpus.
	'search.kind_web':        'Web',
	'search.kind_news':       'News',
	'search.kind_academic':   'Academic',
	// Named, not "that engine": two of the three places this is reached from
	// -- the gateway's refusal and the operator console -- have no pulldown
	// above them for a "that" to point at.
	'search.refused_serper':  '{engine} can only be used with your own key.',
	// The per-engine allowance under the key field -- the line that CAN be
	// accurate, where `search.engine_note` deliberately is not. {n} arrives
	// already grouped by toLocaleString(), so no separator of our own goes in;
	// the reader gets 1,000 or 1 000 or 1.000 as their locale wants it. "Last
	// time we looked" is not padding: it is a third party's pricing, it will
	// go stale, and the hedge is what keeps this a report rather than a
	// promise. Keep it in every language.
	'search.free_month':      '{engine}: about {n} searches a month free, last time we looked.',

	// ── Credits, packs and Pro ─────────────────────────────────
	// Anything the user is CHARGED says US dollars out loud. See `billing.*`.
	'credits.lead':      'Buy credits and Daimond runs the model for you, with no provider key to manage. No subscription. You keep what you buy, and nothing is charged again unless you turn on auto-reload.',
	'credits.balance':   'Balance: {amount}',
	'credits.balance_unavailable': 'Balance unavailable.',
	'credits.see_spend': 'See where your spending goes →',
	'credits.offline':   'The Daimond account service is unreachable, so credits are unavailable. Your own provider key still works.',
	'credits.need_account': 'Credits let you use Daimond without a provider key. They need an account: a passphrase kept on this device.',
	'credits.create_account': 'Create an account',
	'credits.added':     'Credits added',
	'credits.now':       'Your balance is now {amount}.',
	'pro.owned':         '<b>You own Daimond Pro.</b> Cross-device sync, cloud storage and Email are on. Nothing renews.',
	'pro.offer':         '<p><b>Own Daimond.</b> One payment, kept for good. Pro turns on cross-device sync, cloud storage, and Email, so your own mail is read and sent in the workspace.</p>',
	'pro.fine':          'No subscription. Metered use (inference, bandwidth, storage beyond the free tier) is paid from credits, whether or not you own Pro.',
	'pro.buy':           'Own Daimond',
	'pro.buy_priced':    'Own Daimond for {price}',
	'billing.usd_note':  'You are billed in US dollars; the converted figure is approximate.',
	'billing.rates_as_of': 'Rates as of {date}, approximate.',

	// ── Auto-reload ────────────────────────────────────────────
	// Every amount here is charged to a card, so the copy stays plain.
	'autoreload.title':            'Auto-reload',
	'autoreload.lead':             'Daimond can buy credits when they run low, so a long job does not stop halfway. It charges the card below without asking, up to a limit you set here.',
	'autoreload.card_word':        'card',
	'autoreload.card_has':         '{brand} ending {last4}',
	'autoreload.replace':          'Replace…',
	'autoreload.replace_help':     'Save a different card. Stripe collects it; Daimond never sees it.',
	'autoreload.no_card':          'No card saved.',
	'autoreload.save_card':        'Save a card',
	'autoreload.save_card_help':   'Opens Stripe’s own page. Nothing is charged, and no card detail reaches Daimond.',
	'autoreload.switch_on':        'Buy credits automatically',
	'autoreload.switch_no_card':   'Buy credits automatically (save a card first)',
	'autoreload.when_below':       'When the balance falls below',
	'autoreload.when_below_hint':  'A reload fires the moment a turn takes the balance under this.',
	'autoreload.buy_amount':       'Buy this much',
	'autoreload.buy_amount_hint':  'One top-up. The gateway will not sell more than {max} at a time.',
	'autoreload.monthly_cap':      'Never spend more, per month, than',
	'autoreload.monthly_cap_hint': 'The most auto-reload may spend in a calendar month. Raise it here if you need more.',
	'autoreload.spent':            'Spent this month: {spent}',
	'autoreload.spent_of':         'Spent this month: {spent} of {cap}',
	'autoreload.last_error':       'The last automatic top-up failed: {reason}',
	'autoreload.saving':           'Saving…',
	'autoreload.on_note':          'On. Daimond tops itself up, within your monthly limit.',
	'autoreload.off_note':         'Off. Nothing will be charged.',

	// ── The chat ───────────────────────────────────────────────
	'chat.no_chat':        'No chat',
	'chat.model_for_chat': 'Model for this chat',
	'chat.select_all':     'Select all',
	'chat.deselect_all':   'Deselect all',
	'chat.fold_selected':  'Fold selected',
	'chat.fold_now': 'Fold',
	'chat.fold_now_help': 'Fold this conversation now, keeping a summary of what came before.',
	'chat.steps':          'Steps',
	'chat.concise': 'Concise',
	'chat.concise_help': 'Ask for short answers in this chat. Every message carries the /concise skill, a file in your workspace you can edit.',
	'chat.concise_failed_title': 'Concise is not available',
	'chat.concise_failed': 'Daimond could not write .daimond/skills/concise.md, so the chip would refuse every turn instead of shortening it. Open a workspace folder, or check the Files panel, and try again.',
	'chat.steps_help':     'Show or hide the tool steps in the thread',
	'chat.collapse_help':  'Collapse every answer, leaving what you asked, and pick turns to fold',
	'chat.input_ph':       'Type a message…',
	'chat.send':           'Send',
	// The turn indicator: what the three dots at the foot of the thread say while
	// a turn runs. It is up from the moment the turn starts until it ends, so
	// these have to carry a long silence — a run of tool calls with the steps
	// hidden changes nothing else on screen for minutes at a time. {tool} is a
	// tool's own name, which the thread shows untranslated; {n} counts the
	// tool-call rounds, and is there so something on the line MOVES.
	// Nothing here says anything about how long any of it has taken.
	'chat.busy':           'Thinking…',
	'chat.busy_tool':      'Running {tool}, step {n}…',
	'chat.busy_next':      'Step {n} done, thinking…',
	'chat.busy_writing':   'Writing the answer…',
	'chat.answered': 'Daimond answered, {n} words',
	'chat.answer_failed': 'Daimond could not answer',
	'chat.collapse': 'Collapse every answer',
	'chat.jump': 'Jump back to your last message',
	'chat.end': 'Jump to the end of the chat',
	'chat.jump_help':      'Jump back to your last message. Press again to walk back through the ones before it.',
	'chat.end_help':       'Jump to the end of the chat.',
	'chat.new':            '+ New chat',
	// Messages typed while an answer is still arriving. They are held, shown, and
	// sent one turn each once the answer is finished.
	// Short on purpose: a phone's composer is ~120px wide, and a longer line wraps
	// to two clipped rows. What happens to a queued message is said in full by the
	// line above the bubbles (chat.queue_help), at the moment it matters.
	'chat.queue_ph':       'Type the next message…',
	'chat.queue_help':     'Waiting. Sent when this answer finishes',
	'chat.queued_pending': 'Not sent yet. Click to edit it.',
	'chat.queue_cancel':   'Do not send this',
	'chat.queue_returned': 'That turn did not finish, so what you queued is back in the box, unsent.',
	// Speaking into a turn that is already running. A turn is a round of requests,
	// and the message list is rebuilt between them, so a message typed mid-turn can
	// go to the model AT THAT SEAM rather than after the whole turn is over. Two
	// states, and the difference between them is what these say: waiting (typed, not
	// yet delivered) and delivered (in the conversation, and the model has it).
	// The heading is honest about the limit -- an answer that writes prose straight
	// through has no seam in it, so a correction can still end up waiting until it
	// finishes -- because a promise of "shortly" that a quiet turn cannot keep is
	// worse than no promise.
	'chat.send_into':         'Send into this answer',
	'chat.interject_help':    'Waiting. Goes in at the model’s next step, or when this answer finishes',
	'chat.interject_pending': 'Not delivered yet. Click to edit it.',
	'chat.interjected':       'You cut in here',
	'chat.interjected_help':  'Said into the turn at this point. The model had it from here on.',
	'chat.compacted':         'Conversation folded',
	'chat.compacted_help':    'Daimond replaced the earlier part with a summary so the conversation fits the model’s context window.',
	// The same thing said on the chat's TILE, for a queue left on a conversation
	// the user has walked away from: the bubbles are only drawn in the chat on
	// screen, and money about to be spent should not depend on remembering.
	'chat.queue_badge.one':        '{n} waiting',
	'chat.queue_badge.other':      '{n} waiting',
	'chat.queue_badge_help.one':   'One message is waiting on this chat. Open it and it is sent as its own turn.',
	'chat.queue_badge_help.other': '{n} messages are waiting on this chat. Open it and they are sent, one turn each.',

	// ── The Web panel ──────────────────────────────────────────
	'web.who_drives': 'Who is driving',
	'web.back':       'Back',
	'web.reload':     'Reload',
	'web.pop_out':    'Open in a real tab',
	// The name of the pause control in the panel header, so `pause.act_pause`
	// reads "Pause Web access". It governs `root/web`, which reaches further
	// than this panel — a page fetched for a chat is stopped by it too — so it
	// is not called "This panel".
	'web.pause':      'Web access',
	'web.blind_title': "You're driving. I'm not watching.",
	'web.blind_note':  'Daimond has stopped reading this page. No text, no picture, no keystrokes. Sign in, then click <b>Resume Daimond</b> in the browser tab to hand the wheel back. That button is in the tab, so this page can never take the wheel from you.',
	'web.resumed':     'I’ve resumed, check',
	// {where} is what the extension said Daimond stopped at, e.g. a sign-in page.
	'web.blind_title_at': 'You’re driving. I stopped at {where}.',
	// The header: what is on screen, and who has the wheel.
	'web.guide':             'Guide',
	'web.guide_title':       'Daimond’s user guide',
	'web.panel_for':         'The Web panel',
	'web.who_you':           'You',
	'web.who_daimond':       'Daimond',
	'web.who_ready':         'Ready',
	'web.who_view_only':     'View only',
	'web.who_you_help':      'You are driving. Daimond is not watching this page.',
	'web.who_daimond_help':  'Daimond is driving. You can take the wheel at any time.',
	'web.who_ready_help':    'Daimond Hands is installed.',
	'web.who_view_only_help': 'This page can be shown, but not operated. Install Daimond Hands to drive it.',
	// Opening a site through the extension. {host} is a hostname, already escaped;
	// these are placed as markup, so keep the tags and add none.
	'web.opening':         '<b>Opening {host}…</b><br>A <b>Daimond Hands</b> window opens in front. Approve the site there, then confirm once in Chrome. Both happen only the first time for a site.',
	'web.not_approved':    '<b>{host} was not approved.</b><br>',
	'web.approval_closed': 'The approval window was closed, or you said no. To allow it, ask for the site again and click <b>Allow, then confirm in Chrome</b>. The window opens in front of this one, and the <b>Daimond Hands</b> icon holds the question until you answer it.',
	// An answer that arrived after Daimond had stopped waiting: the site was
	// approved late, or refused late. The first sits above the driving note.
	'web.approved_late':   '<b>{host} was approved.</b> Your answer arrived after Daimond gave up waiting, so the panel said otherwise for a moment. The page is open now.',
	'web.answer_late':     'Your answer came after Daimond had stopped waiting. ',
	'web.driving_tab':     '<b>Daimond is driving {host}</b> in a browser tab. Watch it there, or pull a live picture into this panel.',
	'web.show_live':       'Show live view here',
	'web.real_tab':       'The page opens as a real browser tab, which is what carries your own sign-ins, so this panel only shows a picture of it.',
	'web.mirror_wait':    'Waiting for the first picture of that tab. If Chrome has put a permission window in front, it wants your answer.',
	'web.mirror_silent':  'Nothing has come back from Daimond Hands for a while, so there is no live picture. The tab itself is still open, and is still the page.',
	'web.mirror_refused': 'This tab cannot be photographed, so there is no live picture. Watch the tab itself, or ask for the picture again.',
	// A site that refuses to be framed, which is most of them.
	'web.blocked':         '<b>{host}</b> will not display inside another page. Most sites block this as protection against clickjacking; it is not a fault.',
	'web.blocked_hands':   'Daimond Hands can drive it in a real tab.',
	'web.blocked_install': 'Install Daimond Hands to drive it live.',
	'web.open_new_tab':    'Open in a new tab',
	'web.read_as_text':    'Read it as text',
	'web.reading':         'Reading…',
	'web.read_failed':     'That page could not be read: {reason}',
	'web.readonly_badge':  'Read-only copy, not the live site. Do not sign in here.',

	// ── Compose ────────────────────────────────────────────────
	'compose.from':       'From',
	'compose.to':         'To',
	'compose.cc':         'Cc',
	'compose.subject':    'Subject',
	'compose.optional':   'Optional',
	'compose.body_ph':    'Write your message.',
	'compose.send':       'Send',
	'compose.save_draft': 'Save draft',
	'compose.attach':     'Attach…',
	'compose.discard':    'Discard',

	// ── Agents ─────────────────────────────────────────────────
	'agents.control_all':    'Control all agents',
	'agents.pause_all':      'Pause all agents',
	'agents.resume_all':     'Resume all paused agents',
	'agents.stop_all':       'Stop all agents',
	'agents.clear_finished': 'Clear finished agents',
	'agent.model_vision':    'This task names an image, so it runs on the Diamond’s image model, {model}.',
	'agent.model_vision_fallback': 'This task names an image, but no image model is set for this Diamond, so it runs on the text model, {model}.',
	// ── Pending ────────────────────────────────────────────────
	'pending.empty':        'Nothing waiting on you.',
	'pending.sort':         'Sort',
	'pending.by_priority':  'By priority',
	'pending.by_newest':    'Newest first',
	'pending.by_oldest':    'Oldest first',
	'pending.priority':     'Priority',
	'pending.prio_high':    'High',
	'pending.prio_normal':  'Normal',
	'pending.prio_low':     'Low',
	'pending.no_detail':    'No further detail was given.',
	'pending.execute':      'Do it',
	'pending.execute_named': 'Do it: {what}',
	'pending.discuss':      'Discuss it first',
	'pending.discuss_named': 'Discuss first: {what}',
	'pending.cancel':       'Drop it',
	'pending.cancel_named': 'Drop it: {what}',
	'pending.noted':        'Noted, and taken off the list.',
	'pending.diamond_gone': 'The Diamond that raised this is gone, so there is nobody to discuss it with.',
	'pending.discuss_prompt': 'We need to discuss this further before I approve it: “{headline}”',

	'agents.search':         'Search agents',
	'agents.search_help':    'Search agents by name, task, Diamond or tag',

	// ── Email ──────────────────────────────────────────────────
	'mail.write':       'Write a message',
	'mail.add_mailbox': 'Add a mailbox',
	'mail.sync_now':    'Sync now',

	// The pitch, shown while Email is not unlocked on this account. The first
	// two carry markup and are placed as markup; keep the tags and add none.
	'mail.pitch.head':    '<b>Daimond can read your mail.</b> Your inbox lands in the workspace as ordinary files, so every agent can read, search and work from it.',
	'mail.pitch.fine':    'Email is part of Pro, one payment kept for good, alongside cross-device sync and cloud storage. Covers {cap} mailboxes. Sending and fetching are metered against credits, like inference. Nothing renews.',
	'mail.pitch.privacy': 'Daimond’s gateway makes the connection and forgets your password. No mail is ever stored on our side.',
	'mail.pitch.unknown': 'The account service is not reachable, so Daimond cannot tell whether Email is unlocked here.',
	'mail.pro_pitch':     'Email is part of Pro. Own Daimond once to turn it on, along with sync and cloud storage.',

	// The mailbox list.
	'mail.remove_mailbox': 'Remove this mailbox',
	'mail.remove_mailbox_named': 'Remove the mailbox {address}',
	'mail.no_mailbox':     'No mailbox yet. Press <b>+</b> to add one.',
	'mail.remove.title':   'Remove {address}?',
	'mail.remove.body':    'The mail already synced stays in the workspace. The mailbox frees a seat on your unlock.',
	'mail.remove.ok':      'Remove',
	'mail.ago.never':      'never',
	'mail.ago.just_now':   'just now',
	'mail.ago.mins':       '{n}m ago',
	'mail.ago.hours':      '{n}h ago',
	'mail.ago.days':       '{n}d ago',

	// Folders. A server may name its folders in its own language, so the name
	// shown is the ROLE's name wherever the server declares one (RFC 6154) and
	// the server's own spelling everywhere else.
	'mail.folders':         'Folders',
	'mail.folders_loading': 'Looking for folders…',
	'mail.refreshed_held': '{done} folders refreshed in {boxes} mailboxes; {held} held by a pause.',
	'mail.refreshed': '{done} folders refreshed in {boxes} mailboxes.',
	'mail.count.never': 'Not fetched yet, so there is no count.',
	'mail.count.asat': '{n} messages, as at {when}.',
	'mail.count.more': '{n} more were waiting on the server then.',
	'mail.settings': 'Mailbox settings',
	'mail.settings_named': 'Settings for {address}',
	'mail.all_mailboxes': 'All mailboxes',
	'mail.refresh_all': 'Refresh all {folders} folders in {boxes} mailboxes',
	'mail.every.0': 'Manual only',
	'mail.every.300': 'Every 5 minutes',
	'mail.every.900': 'Every 15 minutes',
	'mail.every.1800': 'Every 30 minutes',
	'mail.every.3600': 'Every hour',
	'mail.every.14400': 'Every 4 hours',
	'mail.every.43200': 'Every 12 hours',
	'mail.every.86400': 'Once a day',
	'mail.every.secs': 'Every {n} seconds',
	'mail.every_for': 'How often {folder} refreshes itself',
	'mail.cfg.head': 'How often each folder goes and looks, and which of them may. Every refresh costs credits, so nothing polls until you say so.',
	'mail.cfg.self': 'Holds every folder below.',
	'mail.cfg.title': 'Settings for {address}',
	'mail.folders_err':     'The folder list could not be fetched: {reason}',
	'mail.folder.inbox':    'Inbox',
	'mail.folder.sent':     'Sent',
	'mail.folder.drafts':   'Drafts',
	'mail.folder.trash':    'Bin',
	'mail.folder.junk':     'Spam',
	'mail.folder.archive':  'Archive',
	'mail.folder.all':      'All mail',
	'mail.folder.flagged':  'Starred',

	// The message list.
	'mail.drafts_head':    'Drafts · {n}',
	'mail.no_subject':     '(no subject)',
	'mail.no_recipient':   '(no recipient)',
	'mail.unknown_sender': '(unknown)',
	'mail.nothing_yet':    'Nothing here yet. Press <b>⟳</b> to sync.',

	// Syncing. {address} is a mailbox, {folder} the folder inside it.
	'mail.note.syncing':          'Syncing {folder} in {address}…',
	'mail.note.fetching_older':   'Fetching older mail from {folder} in {address}…',
	'mail.note.rebuilt':          'The mailbox was rebuilt on the server; resyncing from the start…',
	'mail.note.up_to_date':       'Up to date.',
	'mail.note.no_older':         'No older mail left to fetch.',
	'mail.note.new.one':          '{n} new message',
	'mail.note.new.other':        '{n} new messages',
	'mail.note.older.one':        '{n} older message',
	'mail.note.older.other':      '{n} older messages',
	'mail.note.still_older.one':  '{n} older still on the server',
	'mail.note.still_older.other': '{n} older still on the server',

	// The foot of the list: what the cap held back.
	'mail.more.note.one':   '{n} older message still on the server. Daimond fetches the newest {batch} at a time, so a whole mailbox is never pulled down at once.',
	'mail.more.note.other': '{n} older messages still on the server. Daimond fetches the newest {batch} at a time, so a whole mailbox is never pulled down at once.',
	'mail.more.next':       'Fetch next {n}',
	'mail.more.stop':       'Stop',
	'mail.more.all':        'Fetch all',

	// Walking a whole mailbox down. {count} is `mail.all.count`, already worded.
	'mail.all.title':        'Fetch all {n} remaining messages?',
	'mail.all.body':         'They arrive in batches of {batch} and are written into the workspace, so a large mailbox takes a while and uses disk. Syncing is metered against your credits by the megabyte. Stop part-way and what has arrived stays.',
	'mail.all.ok':           'Fetch all',
	'mail.all.progress':     'Fetched {got} of {total}…',
	'mail.all.count.one':    '{n} message',
	'mail.all.count.other':  '{n} messages',
	'mail.all.done':         'Done. {count} fetched.',
	'mail.all.done_left':    'Done. {count} fetched, {left} still on the server.',
	'mail.all.stopped':      'Stopped. {count} fetched.',
	'mail.all.stopped_left': 'Stopped. {count} fetched, {left} still on the server.',

	// Quoting and forwarding. The separator is what the reader sees; the header
	// names under it (From:, Date:, Subject:, To:) are the message's own and
	// stay spelled as headers are. "Re:" and "Fwd:" are likewise left alone —
	// they are what a receiving client threads on.
	// Two sentences, not one with a fallback phrase dropped into the date slot:
	// a quote whose date cannot be read gets a sentence with no date in it.
	'mail.quote.head':         'On {date}, {who} wrote:',
	'mail.quote.head_undated': '{who} wrote:',
	'mail.quote.they':         'they',
	'mail.fwd.sep':       '---------- Forwarded message ----------',

	// Adding a mailbox.
	'mail.add.title':         'Add a mailbox',
	'mail.add.lead':          'Daimond’s gateway connects to your mail server, hands the messages back, and forgets your password. The password is encrypted on this device under your passphrase.',
	'mail.add.ok':            'Add and sync',
	'mail.add.address':       'Email address',
	'mail.add.password':      'App password',
	'mail.add.password_ph':   'The app password from your provider',
	'mail.add.imap':          'IMAP server',
	'mail.add.smtp':          'SMTP server',
	'mail.add.port':          'Port',
	'mail.add.guess':         'Daimond will need this provider’s server names (often imap.{domain} for reading, smtp.{domain} for sending).',
	'mail.add.err_address':   'That is not an email address.',
	'mail.add.err_password':  'The app password is required.',
	'mail.add.err_imap':      'Daimond needs the IMAP server name.',
	'mail.add.err_port':      'IMAP runs on port 993 (TLS) or 143.',
	'mail.add.err_smtp':      'Daimond needs the SMTP server name to send from this mailbox.',
	'mail.add.err_smtp_port': 'Mail is submitted on port 587 or 465.',

	// Provider guidance, shown under the address as soon as the domain is
	// recognised. These carry markup. "App Password" is the provider's own name
	// for the thing, so keep whatever the provider calls it in that language.
	'mail.preset.gmail':       'Gmail needs an <b>App Password</b> (Google Account → Security → 2-Step Verification → App passwords), not your Google password.',
	'mail.preset.gmail_short': 'Gmail needs an <b>App Password</b>, not your Google password.',
	'mail.preset.outlook':     'Outlook needs an <b>app password</b> if two-step verification is on.',
	'mail.preset.yahoo':       'Yahoo requires an <b>app password</b> generated in Account Security.',
	'mail.preset.icloud':      'iCloud requires an <b>app-specific password</b>.',
	'mail.preset.fastmail':    'Fastmail requires an app password with IMAP access.',
	'mail.unreachable.proton': 'Proton mail is only reachable through the Proton Bridge running on your own machine, which Daimond’s gateway cannot connect to.',
	'mail.unreachable.tuta':   'Tuta offers no IMAP, so no mail client can read it, Daimond included.',

	// What can go wrong.
	'mail.err.unlock_first':        'Unlock Daimond first. The mail password is encrypted under your passphrase.',
	'mail.err.draft_needs_mailbox': 'A draft needs a mailbox to be from.',
	'mail.err.draft_unreadable':   'That draft could not be read.',
	'mail.err.msg_unreadable':     'That message could not be read.',
	'mail.err.send_from_added':    'Send from a mailbox you have added and synced.',
	'mail.err.no_recipients':      'A message with no recipients cannot be sent.',
	'mail.err.add_mailbox_first':  'Add a mailbox before writing a message.',
	'mail.err.service_unavailable': 'The account service is unavailable.',
	'mail.err.service_unreachable': 'Could not reach the Daimond account service. Try again shortly.',
	'mail.err.cap.one':            'This unlock covers {n} mailbox. Remove one to add another.',
	'mail.err.cap.other':          'This unlock covers {n} mailboxes. Remove one to add another.',

	// ── Workspace files ────────────────────────────────────────
	'work.new_file':   'New file',
	'work.new_folder': 'New folder',
	'work.upload':     'Upload files',
	'work.parent':     'Parent folder',
	'work.filter_ph':  'Filter…',
	'work.breadcrumb': 'Folder path',

	// ── The phone shell ────────────────────────────────────────
	'mnav.chat':     'Chat',
	'mnav.mail':     'Email',
	'mnav.files':    'Files',
	'mnav.agents':   'Agents',
	'sheet.panel':   'Panel',
	'sheet.ask':     'Ask',
	'sheet.ask_ph':  'Ask about this…',
	// {thing} is a panel's name, lower-cased by the caller. A language where
	// that reads badly should rewrite the sentence around it.
	'sheet.ask_about': 'Ask about this {thing}…',

	// ── Identity: creating and unlocking ───────────────────────
	'identity.your_name':          'Your name',
	'identity.passphrase':         'Passphrase',
	'identity.confirm_passphrase': 'Confirm passphrase',
	'identity.show_passphrase':    'Show passphrase',
	'identity.hide_passphrase':    'Hide passphrase',
	'identity.generate_another':   'Generate another',
	'identity.wrote_it_down':      'I have written this down somewhere safe',
	'identity.choose_own':         'Choose my own passphrase instead',
	'identity.skip':               'Skip for now',
	'identity.create_account':     'Create account',
	'identity.unlock':             'Unlock',
	'identity.forget':             'Forget this identity…',
	'identity.use_generated':      'Use a generated passphrase instead',
	'identity.title_create':       'Create your account',
	'identity.title_unlock':       'Unlock Daimond',
	'identity.title_welcome':      'Welcome back, {name}',
	'identity.title_linked':       'Linked. Now unlock it',
	'identity.lead_create':        'Choose a name. Daimond generates the passphrase itself, below. If you already use Daimond on another device, do not make a second account: choose “Have a pairing code?” to link this one. (Opening a real folder for agents to edit needs Chrome, Edge or Brave.)',
	'identity.lead_unlock':        'Enter your passphrase to unlock this device and decrypt your saved key.',
	'identity.lead_linked':        'This device is linked to your account. Enter the SAME passphrase you use on your other device, not a new one, to bring your chats and files here.',
	'identity.lead_linked_named':  'This device is linked to your account “{name}”. Enter the SAME passphrase you use on your other device, not a new one, to bring your chats and files here.',
	// {bits} is a number read off the shipped wordlist, not a constant.
	'identity.gen_note':           'Eight words picked at random by this device, about {bits} bits, far past anything that can be guessed. It is the key to everything you store here, and nobody can reset it for you. Write it on paper. A password manager may also offer to keep it, which is safe at this strength.',

	// ── Passkeys ───────────────────────────────────────────────
	// Every one of these is a dead end explained: a passkey that will not open
	// leaves the passphrase as the only way in, so each says which it is.
	'passkey.err_need_passphrase':     'A passphrase is required to enrol a passkey.',
	'passkey.err_no_identity':         'There is no identity to protect with a passkey.',
	'passkey.err_bad_passphrase':      'That passphrase did not match.',
	'passkey.err_cannot_create':       'This browser or device cannot create a passkey.',
	'passkey.err_create_failed':       'Passkey creation was cancelled or failed.',
	'passkey.err_none_created':        'No passkey was created.',
	'passkey.err_no_prf':              'This authenticator does not support the PRF extension, so it cannot unlock Daimond.',
	'passkey.err_not_sealed':          'The passkey could not be sealed. Nothing was saved.',
	'passkey.err_not_saved':           'The passkey could not be saved on this device.',
	'passkey.err_not_enrolled':        'No passkey is enrolled on this device.',
	'passkey.err_unreadable':          'The passkey could not be read.',
	'passkey.err_unreadable_use_pass': 'The passkey could not be read. Use your passphrase.',
	'passkey.err_wrong_identity':      'The passkey did not match this identity. Use your passphrase.',
	'passkey.err_out_of_date':         'This passkey is out of date. Unlock with your passphrase, then re-add it.',
	'passkey.err_cannot_use':          'This browser or device cannot use a passkey.',
	'passkey.err_no_identity_support': 'Identity support is unavailable.',
	'passkey.err_no_offer':            'No Daimond passkey was offered, or it carried no PRF secret.',
	'passkey.err_no_account_carried':  'That passkey is not set up to carry an account. On the device that has your account, open Settings and add the passkey again.',
	'passkey.err_did_not_open':        'That passkey did not open the account.',
	'passkey.err_stored_unreadable':   'The stored account could not be read.',
	'passkey.err_stored_locked':       'The stored account did not open. Use your passphrase.',
	'passkey.err_not_resealed':        'The passkey could not be re-sealed.',

	// ── Cross-device sync ──────────────────────────────────────
	'sync.syncing':    'Syncing…',
	'sync.synced':     'Synced',
	'sync.off':        'Sync off',
	'sync.off_reason': 'Cross-device sync is part of Pro, which this account does not hold.',
	// The chip is the only place this is said, so it also has to be the way to
	// the offer: it is clickable in this state, and opens Pro in Credits.
	'sync.off_click':  'Click to see Pro in Credits.',
	'sync.off_pitch':  'Sync is off because this account is not on Pro. Pro adds cross-device sync, cloud storage and Email.',
	// A refused parcel. Say what is too large, and what usually makes it so:
	// "too large" on its own leaves nothing to do about it.
	'sync.too_big':        'Sync paused',
	'sync.too_big_reason': 'This device’s parcel is too large to send, so its work has stopped travelling. Usually one very large Diamond or workspace file is the cause; shrink or remove it and sync resumes on its own.',
	// A Diamond the parcel had no room for. Named, because the only thing the user can
	// do about it is find that Diamond, and said aloud rather than logged, because
	// nothing else on screen would look any different.
	'sync.diamonds_left.one':   '{n} Diamond did not fit in this device’s sync parcel and will not reach your other devices until it is smaller: {names}',
	'sync.diamonds_left.other': '{n} Diamonds did not fit in this device’s sync parcel and will not reach your other devices until they are smaller: {names}',
	// A session that has ended and could not be taken again. Same label as the
	// two below for the same reason: what the user needs to know is that this
	// device's work is not travelling, and the difference is in the hover.
	'sync.signed_out':        'Sync paused',
	'sync.signed_out_reason': 'This device is signed out of the Daimond account service and could not sign in again, so its work is not reaching your other devices. It resumes as soon as the service is reachable. If it does not, lock Daimond and unlock it.',
	// A reconcile that did not finish. Both of these mean the same thing to the
	// user — this device's work is still only here — so they share a label and
	// differ in the reason.
	'sync.paused':         'Sync paused',
	'sync.busy_reason':    'Another device is saving to this account at the same time, so this device’s work has not been sent yet. It goes on the next change.',
	'sync.merge_reason':   'Some of what arrived from the other device could not be merged here, so this device has not sent over the top of it. Reloading the page usually clears it.',
	'sync.last_synced':    'Last synced {when}.',
	'sync.last_never':     'Nothing has synced from this device yet.',
	'sync.when_just_now':  'just now',
	'sync.when_mins':      '{n}m ago',
	'sync.when_hours':     '{n}h ago',
	'sync.when_days':      '{n}d ago',

	// ── Cloud storage cleanup ──────────────────────────────────
	// A deletion the gateway would not carry out on one request. Say the two
	// numbers, and say plainly that nothing of theirs has gone.
	'chunks.sweep_held':          'Cleanup paused',
	'chunks.sweep_held_reason':   'Cloud storage holds {n} of its {m} stored pieces that no file on this account still refers to. They have NOT been deleted, because no single request may remove more than half of what is stored. Nothing of yours is missing, and the space is freed by the next sync that can account for it all.',

	// ── Pairing a second device ────────────────────────────────
	// The quotation marks around a button's name are curly on purpose; keep
	// whatever quotation marks the target language uses.
	'pair.link_another':  'Link another device',
	'pair.link_this':     'Link this device',
	'pair.have_code':     'Have a pairing code?',
	'pair.making_code':   'Making a one-time code…',
	'pair.scan_lead':     'On your other phone, point its camera at this to open Daimond and link it:',
	'pair.no_camera':     'Without a camera, open Daimond there, choose “Have a pairing code?”, and enter:',
	'pair.type_lead':     'On your other device, open Daimond, choose “Have a pairing code?”, and enter:',
	'pair.code_expiry':   'This code works once and expires in about {mins} minutes. You will unlock the other device with your usual passphrase.',
	'pair.code_ph':       'pairing code',
	'pair.code_check':    'This is the code from your other device. It should match the one shown there.',
	'pair.scanned_lead':  'Scanned from your other device. Tap “Link this device” below to bring your account here.',
	'pair.manual_lead':   'On the device you already use, choose “Link another device” and type the code it shows here.',
	'pair.linked':        'This device is linked',
	'pair.linked_note':   'It now holds your account. Tap Unlock, then enter the SAME passphrase you use on your other device, not a new one.',
	'pair.linked_named':  'It now holds your account “{name}”. Tap Unlock, then enter the SAME passphrase you use on your other device, not a new one.',
	// Naming the device while linking it: the one moment the user is holding the
	// device in question. Optional — an unnamed device still syncs.
	'pair.name_this':     'Name this device (optional)',
	'pair.name_ph':       'e.g. Kitchen laptop',
	'pair.named_note':    'This device will appear as “{name}” in your device list. You can change it later there.',
	'pair.err_no_identity':      'There is no identity on this device to link.',
	'pair.err_unreadable_local': 'Could not read this device’s identity.',
	'pair.err_sign_in_first':    'Sign in on this device before linking another.',
	'pair.err_enter_code':       'Enter the pairing code from your other device.',
	'pair.err_bad_code':         'That code is invalid or has expired. Make a new one on your other device.',
	'pair.err_bundle_unreadable': 'The linked identity was unreadable.',
	'pair.err_bundle_import':    'The linked identity could not be imported.',
	'pair.err_create':           'Could not create a pairing code.',
	'pair.err_link':             'Could not link this device.',
	// The one-time presentation handover. Say that it happened and that it is
	// this device's own from now on, or a German interface on a new phone reads
	// as a fault rather than as the other device's setting.
	'pair.look_carried': 'Your theme, language and panel layout came across too. Each device keeps its own from now on, so changing one leaves the other alone.',

	// ── The appearance menu ────────────────────────────────────
	'menu.view':            'View',
	'menu.view_simple':     'Simple',
	'menu.view_max':        'Max',
	'menu.view_simple_help': 'Each thing shows its name and whether it is running. Everything else is one press away.',
	'menu.view_max_help':   'Models, cost and context beside each thing, so you can compare them without opening anything.',
	'menu.view_note':       'Sets the shape of every tile too. Use a tile’s cog to set that tile differently.',
	'menu.theme':         'Theme',
	'menu.tone_light':    'Light',
	'menu.tone_mid':      'Intermediate',
	'menu.tone_dark':     'Dark',
	'menu.theme_light':     'Paper',
	'menu.theme_mist':      'Mist',
	'menu.theme_linen':     'Linen',
	'menu.theme_lollypop':  'Lollypop',
	'menu.theme_sage':      'Sage',
	'menu.theme_dusk':      'Dusk',
	'menu.theme_dark':      'Ember',
	'menu.theme_amber':     'Amber',
	'menu.theme_amber_help': 'Warm and blue-poor, for reading at night.',
	'menu.theme_midnight':  'Midnight',
	'menu.theme_forest':    'Forest',
	'menu.theme_plum':      'Plum',
	'menu.text_size':     'Text size',
	'menu.smaller':       'Smaller text',
	'menu.larger':        'Larger text',
	'menu.dock_tiling':   'Dock tiling',
	'menu.dock_auto':     'Auto',
	'menu.dock_auto_help': 'A second column once the window is wide enough for it',
	'menu.dock_grid_help.one':   '{cols} column, up to {cells} panels',
	'menu.dock_grid_help.other': '{cols} columns, up to {cells} panels',
	'menu.language':      'Language',
	'menu.language_help': 'What Daimond says. A language with no table yet stays in English.',
	'menu.language_pending': 'not translated yet',
	'menu.currency':      'Currency',
	'menu.currency_help': 'What figures are shown in. Billing is always in US dollars.',
	'menu.this_diamond':  'This Diamond',
	'menu.arrangement_update': 'Update the saved arrangement',
	'menu.arrangement_keep':   'Keep this arrangement with {name}',
	'menu.arrangement_keep_this': 'Keep this arrangement with this Diamond',
	'menu.arrangement_forget': 'Forget it',
	'menu.arrangement_note':   'Opening this Diamond again restores the panels it was worked in. Nothing is remembered until you ask.',

	// ── Text-size steps ────────────────────────────────────────
	'size.small':  'Small',
	'size.normal': 'Normal',
	'size.large':  'Large',
	'size.larger': 'Larger',

	// ── Dock grids ─────────────────────────────────────────────
	'dock.one_column': 'One column',
	'dock.2x2':        '2 by 2',
	'dock.2x3':        '2 by 3',
	'dock.3x2':        '3 by 2',
	'dock.automatic':  'Automatic',

	// ── The panel gallery rows ─────────────────────────────────
	'gallery.search_ph':        'Search panels',
	'gallery.no_match':         'No panel by that name.',
	'gallery.zone_rail':        'The rail',
	'gallery.zone_stage':       'Beside the chat',
	'gallery.zone_dock':        'The dock',
	'gallery.note':             'Pinned panels sit in the top bar. Press <kbd>Ctrl</kbd> <kbd>K</kbd> to reach any panel from the keyboard.',
	'gallery.state_unrevealed': 'not in use yet',
	'gallery.state_full':       'dock full',
	'gallery.state_open':       'open',
	'gallery.state_no_room':    'no room in the bar',
	'gallery.pin':              'Keep {name} in the top bar',
	'gallery.unpin':            'Remove {name} from the top bar',

	// ── Spending ───────────────────────────────────────────────
	'spend.intro':           'Two pots, kept apart. Inference runs on your own provider key; credits pay the gateway for the few things that leave the browser.',
	'spend.inference':       'Inference',
	'spend.inference_hint':  'billed to your own provider key',
	'spend.credits':         'Credits',
	'spend.credits_hint':    'gateway services: web, mail, sync',
	'spend.no_usage':        'No usage recorded.',
	'spend.no_account':      'No gateway account yet. Credits pay for the few things that leave the browser: fetching a web page, sending or syncing mail, cross-device sync. Add a passphrase and credits to begin.',
	'spend.this_week':       'this week',
	'spend.this_month':      'this month',
	'spend.session':         'this session',
	'spend.balance':         'balance',
	'spend.tok':             'tok',
	// The three cells of the rail's spend row. Short: they sit under a figure.
	'spend.session_short':   'Session',
	'spend.period_week':     'Week',
	'spend.period_month':    'Month',
	'spend.no_turns':        'No turns in this window yet.',
	'spend.nothing_yet':     'Nothing yet.',
	'spend.nothing_spent':   'Nothing spent here yet.',
	'spend.no_movements':    'No credit movements yet.',
	'spend.where_credits_went': 'Where credits went',
	'spend.unknown_model':   '(unknown)',
	'spend.meter_help':      'See where your spending goes',
	'spend.rates_note':      'Figures are converted at approximate rates ({date}); you are billed in US dollars.',
	// Table headings. Keep them short: they sit above numbers in a narrow panel.
	'spend.col_model':   'Model',
	'spend.col_turns':   'Turns',
	'spend.col_tokens':  'Tokens',
	'spend.col_cost':    'Cost',
	'spend.col_key':          'Key',
	'spend.col_left':         'Left',
	'spend.col_period_spend': 'Spent',
	'spend.provider_keys':    'Provider keys',
	'spend.left_auto':        'What the provider says is left on this key.',
	'spend.left_manual':      'Your own figure, counted down by what Daimond estimates you have spent since.',
	'spend.left_unknown':     'This provider does not say what is left, and you have not told Daimond.',
	// Where the headline figure came from. A total the providers billed is not an
	// estimate, and marking it "≈" said the opposite of the truth.
	'spend.all_reported':          'Every turn in this window came with a cost from the provider, so this is what was charged.',
	'spend.part_reported':         '{amount} of this was reported by the providers; the rest is priced from Daimond\'s rate table.',
	'spend.none_reported':         'Priced from Daimond’s rate table. No provider reported a cost for these turns.',
	'spend.none_reported_unknown': 'Priced from Daimond’s rate table, which is missing one of these models, so the figure is a rough guide.',
	// Why a total the user remembers as larger has fallen: the old rate table ran
	// high, and the estimates it made were corrected once, here, on this device.
	'spend.repriced': 'Estimates made before the rate table was corrected have been repriced on this device; under the old table this period read {amount}.',
	'spend.col_when':    'When',
	'spend.col_what':    'What',
	'spend.col_amount':  'Amount',
	'spend.col_balance': 'Balance',
	// Credit categories, as the gateway tags them. The first seven are metered
	// spends and are `SPEND_CATEGORIES` in gateway/src/schema.rs; the rest are
	// credit-side movements, named by their kind alone.
	//
	// `cat_infer` is model spend on the key Daimond mints and reconciles against
	// credits, which is a different pot from the Inference section above it —
	// that one is billed to the user's own provider key and never touches
	// credits. Hence "on credits" rather than "Inference" alone: the two sit on
	// one screen and the qualifier is the whole difference between them. It also
	// leads with the word that matters, because the dock is narrow enough to
	// truncate a label to its first two words.
	'spend.cat_web':     'Web pages',
	'spend.cat_search':  'Web searches',
	'spend.cat_mail':    'Mail',
	'spend.cat_sync':    'Cross-device sync',
	'spend.cat_storage': 'Stored files',
	'spend.cat_infer':   'Inference on credits',
	'spend.cat_other':   'Other services',
	'spend.cat_topup':   'Credits bought',
	'spend.cat_refund':  'Refunds',
	'spend.cat_grant':   'Gifts & grants',
	'spend.cat_adjust':  'Adjustments',
	'spend.cat_fallback': 'Other',   // a category the gateway did not name
	// A category the gateway DID name and this build cannot. Money left the
	// balance with nothing to say for it, and that is what the row says: showing
	// the gateway's own token instead is how three weeks of untranslated
	// "infer" reached eight languages unnoticed.
	'spend.cat_unlisted': 'Not accounted for',

	// ── Tools ──────────────────────────────────────────────────
	// `tools.head` and `tools.shop_fine` are placed inside markup, so any HTML
	// in them is rendered. Keep the tags that are there and add none.
	'tools.head':         '<b>{have} of {all}</b> tools. Most of what Daimond does costs nothing. A few reach the world outside the browser, and those cost what they cost to run.',
	'tools.built_in':     'Built in',
	'tools.unlocked':     'Unlocked',
	'tools.unlock_price': 'Unlock for {price}',
	'tools.sec_unlocked': 'Unlocked on this account',
	'tools.sec_shop':     'Get more tools',
	'tools.shop_fine':    'Bought once, kept for good. Nothing renews. What a tool costs to run, a mailbox synced or a page fetched, is metered against credits, so ongoing cost tracks ongoing use.',
	'tools.unreachable':  'The account service could not be reached, so what is unlocked here is unknown.',
	'tools.no_service':   'The account service is unavailable.',


	// ── The rail's Diamonds and chats ──────────────────────────
	'rail.no_diamonds':      'No Diamonds yet.',
	'rail.no_match':         'No Diamonds match.',
	'rail.no_chats':         'No chats yet.',
	// Shown under the search box when nothing is tagged, so that an empty
	// filing system cannot be read as a missing one.
	'rail.tag_hint':         'No tags yet. Tag a Diamond and filter chips appear here.',
	'rail.tag_hint_help':    'Open a Diamond, then Tags on its crystal. Starter tags are offered there: {tags}.',
	'rail.dblclick_rename':  'Double-click to rename',
	'rail.rename_diamond':   'Rename Diamond',
	'rail.rename':           'Rename',
	'rail.rename_failed':    'Rename failed',
	'rail.delete_failed':    'Delete failed',
	'rail.create':           'Create',
	'rail.name':             'Name',
	'rail.model':            'Model',
	'rail.worker_model':     'Model for workers',
	'rail.worker_model_help': 'The daimon dispatches workers several at a time. Left as it is, they run on the Diamond’s own model.',
	'rail.err_name':         'Give the Diamond a name.',
	'rail.err_model':        'Choose a model for this Diamond to think with.',
	'rail.err_no_key':       'That provider has no readable key yet. Unlock, or add one.',
	'rail.err_no_key_worker': 'The workers’ provider has no readable key yet, so they would fall back to the Diamond’s own model. Unlock the key, or choose another provider.',
	'rail.create_failed':    'Could not create Diamond',
	'rail.created_unreadable': 'Diamond created, but not readable',
	'rail.created_unreadable_body': '"{name}" was written but could not be read back, so it is not in the rail. Reload the page. If it is still missing, this device’s storage is refusing to serve what it accepted.',

	// ── The PPTW: pause, play, traffic light ───────────────────
	// One control at six placements. The state words are lower case because
	// they are appended to an action in the accessible name — "Pause Alpha —
	// running" — and a capital mid-sentence would read as a second label.
	'pause.everything':      'Everything',
	'pause.everything_help': 'Pause or resume everything that can spend: every Diamond, every chat, the workers, the mailboxes and any page fetched for you.',
	// {name} holds two different kinds of thing and no spacing suits both, so
	// this has a known rough edge in ja, zh-Hans and fr, and it is left alone
	// deliberately. It takes either a user-named Diamond or chat -- usually
	// Latin script -- or a translated node name. The ja template spaces the
	// particle off the name ('{name} を一時停止') because that is right for
	// "Alpha を一時停止" and wrong for "ウェブアクセス を一時停止"; zh-Hans
	// spaces it ('暂停 {name}') for the same reason and with the same cost
	// between two Chinese words; fr's 'Mettre {name} en pause' wants "l'accès"
	// once {name} is a common noun rather than a name. Every existing node
	// already reads this way. Gluing would fix the translated case and break
	// the commoner one, so nothing in this table fixes both -- only a call
	// site that knows which kind of name it is holding could.
	'pause.act_pause':       'Pause {name}',
	'pause.act_play':        'Resume {name}',
	'pause.state_play':      'running',
	'pause.state_pause':     'paused',
	'pause.state_mixed':     'partly paused',
	'pause.this':            'this',
	'pause.workers':         'Workers',
	'pause.mail':            'Mail',
	'pause.mail_polling':    'Mailbox polling',
	'pause.unnamed_chat':    'Unnamed chat',
	// The refusals enforcement speaks at the spend boundary. {node} is a
	// HUMAN name -- DaimondPause.label(), not the node id -- because
	// "root/diamonds/a1b2/self" names the node exactly and tells the reader
	// nothing. All four say the same three things: what did NOT happen, that no
	// money moved, and where the control is. The web one once stayed silent
	// about the control, because `root/web` had no widget anywhere in the app;
	// the Web panel header has one now, and dev/verify_search_i18n.mjs asserts
	// all four name it, in every language.
	'pause.web':              'Web',
	'pause.refused_title':    'Paused',
	'pause.refused.turn':     '{node} is paused. No turn started, nothing spent. Press play on it to resume.',
	'pause.refused.dispatch': '{node} is paused. No agents dispatched, nothing spent. Press play on it to resume.',
	'pause.refused.web':      '{node} is paused. The page was not fetched and nothing was spent. Press play on it to resume.',
	'pause.refused.mail':     '{node} is paused. The mailbox was not contacted and nothing was spent. Press play on it to resume.',

	// ── Tags ───────────────────────────────────────────────────
	'tag.only_agents':   'Show only agents tagged "{tag}"',
	'tag.only_diamonds': 'Show only Diamonds tagged "{tag}"',
	'tag.clear_filter':  'Clear the "{tag}" filter',
	'tag.remove':        'Remove "{tag}"',
	'tag.add':           'Add "{tag}"',
	'tag.starters': 'person, project, topic, org',
	'tag.add_btn':       'Add',
	'tag.add_ph':        'Add a tag',
	'tag.on_diamond':    'On this Diamond',
	'tag.all':           'All your tags',
	'tag.all_used':      'Every tag you have is on this Diamond already.',
	'tag.none_yet':      'No tags yet.',
	'tag.save_failed':   'Could not save the tags',
	// The rail's boolean filter: the tags wanted, the tags refused, and how two
	// or more wanted tags combine. A chip in the rail cycles off, wanted,
	// refused, off; a chip in the summary comes out of the filter altogether.
	'tag.exclude_next':  'Showing Diamonds tagged "{tag}". Click again to hide them.',
	'tag.clear_exclude': 'Stop hiding Diamonds tagged "{tag}"',
	'tag.not_tagged':    'Not tagged "{tag}"',
	'tag.mode_all':      'All',
	'tag.mode_any':      'Any',
	'tag.mode_all_help': 'Show only Diamonds carrying every one of these tags',
	'tag.mode_any_help': 'Show Diamonds carrying any one of these tags',
	'tag.mode_aria':     'How the chosen tags combine',
	'tag.clear_all':     'Clear',
	'tag.clear_all_help': 'Take every tag out of the filter',
	// The one row the pool of chips sits behind, under the search box. It is
	// there whenever a tag is, because a filter nobody can see is a filter
	// nobody finds -- and it is only a row, because a vocabulary of thirty tags
	// standing open costs the rail's two lists four rows on every screen.
	// {n} is how many tags are behind it.
	'tag.pool_toggle':    'Filter by tag ({n})',
	'tag.pool_show_help': 'Show every tag you can filter on',
	'tag.pool_hide_help': 'Put the tags away. Anything you are filtering on stays on, and stays in view.',
	// The chips that are doing the filtering, shown on their own while the tags
	// are put away.
	'tag.active_aria':    'Tags the rail is filtering on',
	// Deleting a tag from the pool, which takes it off every Diamond that carries it.
	'tag.delete_help':        'Delete the tag "{tag}" everywhere',
	'tag.delete_title':       'Delete this tag?',
	'tag.delete_body_used.one':   'Delete the tag "{tag}"? It comes off the {n} Diamond carrying it. Nothing else about that Diamond changes.',
	'tag.delete_body_used.other': 'Delete the tag "{tag}"? It comes off all {n} Diamonds carrying it. Nothing else about them changes.',
	'tag.delete_body_unused': 'Delete the tag "{tag}"? No Diamond carries it, so this only takes it off the list.',
	'tag.delete_ok':          'Delete the tag',
	'tag.deleted':            'Tag "{tag}" deleted.',
	'tag.deleted_from.one':   'Tag "{tag}" deleted from {n} Diamond.',
	'tag.deleted_from.other': 'Tag "{tag}" deleted from {n} Diamonds.',
	'tag.editor_note':   'Tags file this Diamond in the rail. They are never sent to a model and never enter the crystal.',

	// ── Starting and interrupting a turn ───────────────────────
	'chat.choose_model':   'Choose a model to start this chat.',
	'chat.no_key_start':   'That provider has no readable key yet. Unlock, or add one, to start this chat.',
	'chat.connect_start':  'Connect a provider to start this chat.',
	'chat.pending_hint':   'Pick a model in this chat\u2019s tile and press \u25b6 Start to begin.',
	'chat.start_selected': 'Start with the selected model',
	'chat.stop':           'Stop',
	'turn.interrupted':       'Interrupted. The browser closed before this finished.',
	'turn.interrupted_early': 'Interrupted before it could answer.',
	'turn.continue':          'Continue',
	'turn.continue_help':     'Run this turn again from your message.',
	'astat.no_model':         'No model connected',
	'astat.model_help':       'The models Daimond can run, and the keys behind them',

	// ── Folding a chat into a Diamond ──────────────────────────
	'fold.nothing':          'Nothing to fold',
	'fold.chat_empty':       'This chat is empty. Send a message first, then fold it into a Diamond.',
	'fold.turns_empty':      'The turns you chose have no content to fold in.',
	'fold.agent_empty':      'This agent produced no summary to fold.',
	'fold.into':             'Fold into…',
	'fold.n_turns_into.one':   'Fold {n} turn into…',
	'fold.n_turns_into.other': 'Fold {n} turns into…',
	'fold.no_diamonds':      'No Diamonds yet. Create one:',
	'fold.new_diamond':      '＋ New Diamond…',
	'fold.connect_first':    'Connect a provider to fold into a Diamond.',
	'fold.create_and_fold':  'Create and fold',
	'fold.no_key':           'That Diamond’s provider has no readable key. Unlock, or add one, to fold into it.',
	'fold.nothing_new':      'Nothing new to fold',
	'fold.nothing_new_body': '"{chat}" has not changed since it was folded into "{diamond}".',
	'fold.proposing':        'Proposing fold…',
	'fold.diamond_gone':     'Diamond is gone',
	'fold.diamond_gone_body': 'The Diamond that dispatched this agent no longer exists.',
	'fold.diamond_gone_chat_body': 'The Diamond you chose no longer exists; it may have been deleted in another tab. Nothing was folded.',
	'fold.empty_reply':      'The model returned nothing to fold, so nothing was proposed. Try again.',
	'fold.proposed_toast':   'Fold proposed. Accept or Reject it below.',
	'fold.proposed_elsewhere': 'Fold proposed on "{diamond}". Open it to Accept or Reject.',
	'fold.pending_badge':    'fold waiting',
	'fold.pending_badge_help': 'A proposed fold is waiting on this Diamond. Open it to accept or reject the change.',
	// The fold diff's heading. Four shapes rather than one with glue, because a
	// language that puts the target first cannot reorder a fragment.
	'diff.folding_chat':      'Folding "{chat}". Review the change, then Accept or Reject.',
	'diff.folding_chat_into': 'Folding "{chat}" into "{diamond}". Review the change, then Accept or Reject.',
	'diff.proposed':          'Proposed fold. Review the change, then Accept or Reject.',
	'diff.proposed_into':     'Proposed fold into "{diamond}". Review the change, then Accept or Reject.',
	'diff.no_change':         'No change proposed. The crystal already covers this.',
	'diff.no_change_into':    'No change proposed into "{diamond}". The crystal already covers this.',
	'diff.accept':            'Accept fold',
	'diff.reject':            'Reject',
	'diff.nothing_to_apply':  'Nothing to apply. The proposal matches the current crystal.',
	// What accepting would take OUT. A fold that only adds needs no warning; one
	// that drops a key the crystal already holds is the change worth naming, and
	// {keys} is the list of them, joined by the caller.
	'fold.keys_lost':         'Accepting this removes: {keys}',

	// ── The crystal ────────────────────────────────────────────
	'crystal.page':           'Page',
	'crystal.page_help':      'Ask the daimon to change how this crystal looks, not what it says',
	'crystal.page_note':      'Change this Diamond\'s PAGE (crystal.html), not its memory (crystal.json). Read crystal.html first, then edit it, and leave crystal.json alone. Keep it self-contained: all CSS and JavaScript inline, images only as data: URIs, no fetch, no external files, no eval. Keep its ready, rendered and height messages, and let rendered name every top-level key of the data that has content. What I want: ',
	'crystal.history':        'History',
	'crystal.tags':           'Tags',
	'crystal.tags_help':      'File this Diamond in the rail',
	'crystal.empty':          'The crystal is empty. Steer it below to begin.',
	'crystal.empty_paren':    '(empty)',
	'crystal.save_failed':    'Could not save the crystal',
	'crystal.back':           'Back to the crystal',
	'crystal.no_history':     'No history yet.',
	'crystal.view':           'View',
	'crystal.restore':        'Restore',
	'crystal.restore_v':      'Restore v{v}',
	'crystal.restore_title':  'Restore a version',
	'crystal.restore_body':   'Restore the crystal to v{v}? The current text is kept in the history, so this can itself be undone.',
	'crystal.restore_failed': 'Could not restore',
	'crystal.at_version':     'Crystal at v{v}',
	'crystal.read_version_failed': 'Could not read that version',
	'crystal.delta':          'Delta',
	'crystal.delta_help':     'The raw input this fold was made from',
	'crystal.delta_at':       'Delta folded at v{v}',
	'crystal.read_delta_failed': 'Could not read the delta',
	'crystal.steer_paused':   'Paused. Press play on its tile',
	'crystal.view_switch':    'Which face of this Diamond',
	'crystal.view_crystal':   'Crystal',
	'crystal.view_chat':      'Chat',
	'crystal.chat_empty':     'Nothing said yet. The crystal is what this Diamond knows; this is how it came to know it.',
	'crystal.dispatch_after_error': 'The turn ended badly, so the agents it asked for were not started.',
	'crystal.steering':       'Steering…',
	'crystal.no_key_steer':   'This Diamond’s provider has no readable key. Unlock, or add one, to steer it.',
	'crystal.page_failed':    'This Diamond’s page did not load, so its data is shown instead.',
	'crystal.page_partial':   'This Diamond’s page did not show everything it holds, so its data is shown instead.',
	'crystal.page_reset':     'Reset the page',
	'crystal.page_reset_confirm': 'Replace this Diamond’s page with the standard one? Its data is not touched.',
	'crystal.ask':            'Ask the daimon to change this page',
	'crystal.edit_json':      'Edit as JSON',
	'crystal.json_invalid':   'That is not valid JSON, so nothing was saved.',
	'crystal.field_title':    'Title',
	'crystal.field_summary':  'Summary',
	'crystal.field_sections': 'Sections',
	'crystal.field_facts':    'Facts',
	'crystal.field_open':     'Open threads',
	'crystal.field_links':    'Links',
	'crystal.field_heading':  'Heading',
	'crystal.field_body':     'Body',
	'crystal.add_section':    'Add a section',
	'crystal.remove':         'Remove',
	'crystal.other_fields':   'Other fields',
	'crystal.other_fields_note': 'Kept as they are, and shown here so nothing vanishes.',

	// ── Artefacts ──────────────────────────────────────────────
	'arte.count.one':      '{n} artefact',
	'arte.count.other':    '{n} artefacts',
	'arte.strip_help':     'What this Diamond produced or consulted',
	'arte.refer_help':     'Refer to this in the steer box',
	'arte.drop_help':      'Not an artefact of this Diamond',
	'arte.drop_named': 'Drop "{name}" as an artefact',
	'arte.file_gone':      'That file is not there any more',
	'arte.file_gone_body': '“{path}” is an artefact of this Diamond, but it cannot be read now; it may have been renamed, moved or deleted.',
	'arte.nothing_to_open': 'Nothing to open',
	'arte.no_viewer':      'This artefact is a \u201c{kind}\u201d, which this version has no viewer for.',

	// ── Attach to focus (ATTACH_CONTRACT.md) ────────────
	'attach.to_focus':     'Attach to current focus',
	'attach.note':         'Note',
	'attach.read':         'Read',
	'attach.note_help':    'The path is worth knowing. Costs a few tokens.',
	'attach.read_help':    'The contents are wanted now. A file can run to thousands of tokens.',
	'attach.add':          'Attach',
	'attach.view_stack':   'Stack',
	'attach.view_icons':   'Icons',
	'attach.prefix_note':  'Note {paths}',
	'attach.prefix_read':  'Read {paths} in full.',
	'attach.cleared':      'Attachments cleared',
	'attach.list':         'Attachments',
	'attach.pick_title':   'Attach files and folders',
	'attach.pick_empty':   'Nothing here.',
	'attach.already':      'Already attached',

	// ── This Diamond's workspace ───────────────────────────────
	'dws.title':           'This Diamond\u2019s workspace',
	'dws.count.one':       '{n} item',
	'dws.count.other':     '{n} items',
	'dws.mode_all':        'Everything',
	'dws.mode_diamond':    'This Diamond',
	'dws.empty':           'Nothing is kept with this Diamond yet. What you keep here is what its daimon can open.',
	// An attachment records the workspace it was made in, so one made on the
	// machine can say so when the browser sandbox is what is open.
	'dws.not_here':        'Kept with this Diamond, but it lives {where}, which is not the workspace you have open. Its daimon cannot reach it from here.',
	'dws.in_machine':      'in the folder "{name}" on this machine',
	'dws.in_browser':      'in the browser workspace',
	'dws.a_folder':        'a folder',
	'dws.attach_dir':      'Keep this folder with {name}',
	'dws.detach_dir':      'Stop keeping this folder with {name}',
	'dws.elsewhere':       'Lives in the workspace',
	'dws.readonly':        'Read only',
	'dws.kits':            'Toolchains',
	'dws.kits_help':       'Which compilers and package managers a command from this Diamond may reach on your computer. Off unless you say so; no daimon chooses this.',
	'dws.kit_on':          'Grant the {kit} toolchain to {name}',
	'dws.kit_off':         'Take the {kit} toolchain back from {name}',
	'dws.kit_failed':      'That toolchain grant was not saved',
	'dws.kit_none':        'No toolchain. A command can reach this Diamond\u2019s files and nothing else on your computer.',

	// \u2500\u2500 Links between Diamonds \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'link.count.one':      '{n} linked Diamond',
	'link.count.other':    '{n} linked Diamonds',
	'link.strip_help':     'How this Diamond stands to your other Diamonds',
	'link.none':           'No links to another Diamond yet.',
	'link.this':           'this',
	'link.rel_blank':      'linked',
	'link.out_help':       'This Diamond \u2192 {rel} \u2192 \u201c{name}\u201d',
	'link.in_help':        '\u201c{name}\u201d \u2192 {rel} \u2192 this Diamond',
	'link.open_other':     'Show \u201c{name}\u201d',
	'link.note_help':      'Show the note on this link',
	'link.drop':           'Remove link',
	'link.drop_help':      'Remove this link',
	'link.drop_confirm':   'Remove the \u201c{rel}\u201d link with \u201c{name}\u201d? Both Diamonds stay; only the link goes.',
	'link.drop_failed':    'Could not remove the link',
	'link.gone':           'That Diamond is not there any more',
	'link.gone_body':      '“{ref}” is linked from this Diamond, but no Diamond of that id can be read now; it may have been deleted.',
	'link.gone_name':      '(deleted Diamond)',
	'link.add_btn':        'Link',
	'link.add_title':      'Link this Diamond to another',
	'link.pick_label':     'Diamond',
	'link.pick_ph':        'Find a Diamond by name',
	'link.pick_none':      'No Diamond matches that.',
	'link.pick_empty':     'There is no other Diamond to link to yet.',
	'link.change_pick':    'Change',
	'link.rel_label':      'Relation',
	'link.rel_ph':         'How are they related?',
	'link.rel_sug_help':   'Suggestions only; any word will do',
	'link.rel_use':        'Use \u201c{rel}\u201d',
	'link.note_label':     'Note',
	'link.note_ph':        'Why, in a sentence (optional)',
	'link.direction_note': 'The link runs from this Diamond to the one you pick.',
	'link.need_target':    'Choose the Diamond to link to first.',
	'link.save':           'Add link',
	'link.graph_open':     'Graph',

	// ── Agents ─────────────────────────────────────────────────
	'agents.none_yet':            'No agents yet. Ask a Diamond to start one and it appears here.',
	'agents.no_match':            'No agents match. Clear the search or filter.',
	'agents.fold_in':             'Fold in',
	'agents.fold_in_help':        'Fold this agent\u2019s summary into "{name}"',
	'agents.folded':              'folded',
	'agents.already_folded':      'Already folded',
	'agents.already_folded_body': 'This agent\u2019s summary has already been folded into the crystal.',
	'agents.a_diamond':           'Diamond',
	'agents.clear_diamond_filter': 'Clear the Diamond filter',
	'instructions.chip_help':     'Your standing instructions, given to every agent. Click to open.',
	'instructions.chip_two':      'Two layers are in force, yours and this project’s. Click to open yours.',

	// ── The System section: Daimond's own store ────────────────
	'sys.head':  'System',
	'sys.note':  'Daimond\u2019s own files. They live in the browser, not in the folder you have open, and they travel between your devices.',
	'sys.empty': 'nothing here yet',
	'sys.up':    'Up one folder',

	// ── What each kind of agent is told ────────────────────────
	'role.chat':            'Chat',
	'role.chat_help':       'The agent you talk to.',
	'role.daimon':         'Diamond daimon',
	'role.daimon_help':    'Keeps a Diamond\u2019s crystal, and dispatches workers.',
	'role.worker':          'Dispatched worker',
	'role.worker_help':     'One task, its own context, reports back.',
	'role.reducer':         'Crystal fold',
	'role.reducer_help':    'Folds one delta into the crystal.',
	// ── Triggered actions ──────────────────────────────────────
	'trig.head':            'When this Diamond acts',
	'trig.none':            'Nothing set. This Diamond answers when you prompt it and at no other time.',
	'trig.activity':        'After {n} minutes of your activity',
	'trig.mail':            'When mail arrives in {folder} ({mailbox})',
	'trig.edit':            'Edit this action',
	'trig.choose':          'Which action',
	'trig.opt_on':          '▶ {what}',
	'trig.opt_off':         '⏸ {what}',
	'trig.nothing_written': 'nothing written',
	'trig.edit_this':       'Edit the {what}',
	'trig.copy_this':       'Copy the {what}',
	'trig.copy':            'Copy its instruction and context',
	'trig.copied':          'Copied.',
	'trig.copy_failed':     'The clipboard refused. Open the action and copy from the box.',
	'trig.remove':          'Remove',
	'trig.remove_body':     'Remove “{what}”? This Diamond will stop acting on it.',
	'trig.add':             'Add an action',
	'trig.add_kind':        'What sets it off',
	'trig.kind_activity':   'Minutes of my activity',
	'trig.kind_mail':       'Mail arriving',
	'trig.note':            'These live in {path}, where you and this Diamond can both read them.',
	'trig.edit_title':      'Edit: {what}',
	'trig.minutes':         'Minutes',
	'trig.minutes_note':    'Minutes you are working, not minutes on the clock. A tab left open overnight counts none of them.',
	'trig.mailbox':         'Mailbox',
	'trig.folder':          'Folder',
	'trig.no_mailbox':      'No mailbox set up yet',
	'trig.instruction':     'Instruction',
	'trig.instruction_ph':  'What to ask this Diamond to do when it fires…',
	'trig.context':         'Context',
	'trig.context_ph':      'Background it needs the first time, and only the first time…',
	'trig.context_note':    'Sent once, in front of the first instruction. Change it and it is sent again.',
	'trig.section':          'Triggered actions',

	'role.compactor':       'Context fold',
	'role.compactor_help':  'Summarises a conversation that has outgrown its window. Its answer becomes what the chat remembers.',

	// ── The Workspace panel ────────────────────────────────────
	'files.back':            'Back',
	'files.edit':            'Edit',
	'files.stop_editing':    'Stop editing',
	'files.line_numbers':    'Line numbers',
	'files.download':        'Download',
	'files.download_help':   'Save to this machine',
	'files.hold_add': 'Keep this file with {name}',
	'files.hold_drop': 'Stop keeping this file with {name}',
	'files.mode_browser': 'Browser',
	'files.browser_switch': 'Switch the agent back to the private in-browser workspace.',
	'files.browser_help': 'The agent works in a private in-browser workspace. This is what syncs.',
	'files.mode_machine': 'Machine',
	'files.machine_here': 'The agent reads and writes this real folder. It does not sync.',
	'files.machine_pick': 'Let the agent work in a real folder on this machine. It will not sync.',
	'files.machine_needs_chromium': 'Real folders need a Chromium-based browser.',
	'files.machine_reconnect': 'Reconnect {name}',
	'files.mode_cloud': 'Cloud',
	'files.cloud_on_machine': 'Cloud storage carries your browser workspace, not a folder on this machine.',
	'files.cloud_help': 'Where your workspace lives, so it can be larger than this device.',
	'files.import_folder': 'Import a folder…',
	'files.import_folder_help': 'Copy a folder from this machine into the workspace, so it syncs',
	'files.save_copy': 'Save a copy…',
	'files.save_copy_help': 'Write the workspace out to a folder on this machine',
	'files.delete':          'Delete',
	'files.rename_move':     'Rename or move',
	'files.rename_hint':     'A name, or a path, to move it somewhere else.',
	'files.err_name':        'Enter a name.',
	'files.rename_failed':   'Could not rename: {reason}',
	'files.no_match':        'Nothing matches "{filter}".',
	'files.new_file_hint':   'Name it DAIMOND.md to write standing instructions every agent will follow.',
	'files.create_failed':   'Could not create file: {reason}',
	'files.create_folder_failed': 'Could not create the folder: {reason}',
	'files.delete_file_body':   'Delete "{name}"? This cannot be undone.',
	'files.delete_folder_body': 'Delete the folder "{name}" and everything inside it? This cannot be undone.',
	'files.delete_failed':   'Could not delete {name}: {reason}',
	'files.upload_failed':   'Could not upload {name}: {reason}',
	'files.uploaded.one':    'Uploaded {n} file.',
	'files.uploaded.other':  'Uploaded {n} files.',
	'files.saving':          'Saving…',
	'files.saved':           'Saved.',
	'files.save_failed':     'Save failed: {reason}',
	'files.save_cancelled':  'Save cancelled. The file changed on disk.',
	'files.discard':         'Discard',
	'files.discard_title':   'Discard your changes?',
	'files.keep_editing':    'Keep editing',
	'files.unsaved_body':    'Your changes to {path} have not been saved. Close the editor and lose them?',
	'files.editing_stopped': 'Editing stopped. Nothing was written.',
	'files.overwrite':       'Overwrite',
	'files.conflict_title':  'It changed while you were editing',
	'files.conflict_body':   'This file changed on disk since you opened it, most likely an agent. Save anyway and overwrite those changes?',
	'files.changed_while_editing': 'This file changed on disk; an agent edited it. Your edits are kept, and saving asks before overwriting.',
	'files.reloaded':        'Reloaded. The file changed on disk.',
	'files.compile':         'Compile',
	'files.compiling':       'compiling',
	'files.compiling_path':  'Compiling {path} …',
	'files.compiled':        'Compiled → {path} ({size})',
	'files.compile_failed':  'Compile failed: {reason}',
	'files.binary_note':     'A binary file of {size}. It is stored and synced like everything else here, but there is nothing to show. Download it to open it in something that understands it.',
	// Cloud storage, seen from the Workspace panel.
	'files.cloud':           'Cloud',
	'files.cloud_storage':   'Cloud storage',
	'files.cloud_empty':     'Nothing in cloud storage yet. Your workspace is limited to what this browser grants.',
	'files.cloud_locked':    'Unlock to use cloud storage. Without it your workspace is limited to what this browser grants.',
	'files.cloud_some_away': '{n} files in cloud storage; {away} of them not on this device.',
	'files.cloud_all_here':  '{n} files in cloud storage, all of them also on this device.',
	'files.cloud_intro':     'Your workspace lives in cloud storage, and this device holds as much of it as it can. {n} files, {total} in total;',
	'files.cloud_away':      '{n} of them ({bytes}) are not on this device.',
	'files.cloud_here':      'all of them are also on this device.',
	'files.cloud_none':      'Nothing is in cloud storage yet. Without it your workspace is limited to what this browser grants you.',
	'files.cloud_none_quota': 'Nothing is in cloud storage yet. Without it your workspace is limited to what this browser grants you, {quota} here.',
	'files.cloud_cap':       'This browser has granted {quota}, of which {used} is used. Files are freed automatically as it fills, unless you have pinned them.',
	'files.reclaim':         'Free up space',
	'files.reclaim_help':    'Free up space on this device now',
	'files.get_help':        'Bring this file onto this device ({size})',
	'files.pinned_short':    'Pinned to this device',
	'files.pinned_help':     'Pinned: always kept on this device. Click to release.',
	'files.pin_help':        'Pin: never free this one to make room.',
	'files.free_help':       'Keep it in cloud storage; drop the copy here',
	'files.fetch':           'Fetch',
	'files.fetch_body':      'Bring "{path}" onto this device? That downloads {size}.',
	'files.fetching':        'Fetching {path}…',

	// ── Where the agent works: the root, and its scope ──────────
	// Changing the root is a separate act from switching between the browser sandbox and the
	// disk. The Machine chip used to do both, so a user who had gone to the sandbox and back was
	// shown the folder picker every time -- and had no way to state the root's scope, which is the
	// one thing they most need to know before pointing an agent at a directory.
	'files.change_root':      'Change folder…',
	'files.change_root_help': 'Point the agent at a different folder on this machine',
	'files.machine_scope':    'The agent works only inside {name}. Nothing outside that folder is visible to Daimond.',
	'files.machine_return':   'Put the agent back to work in {name}',
	'files.forget_root':      'Forget this folder',
	'files.forget_root_help': 'Stop offering this folder. Daimond keeps no record of it, and asks you to pick one next time.',
	'files.root_forgotten':   'Forgotten. Daimond no longer holds a record of that folder.',

	// Diamond files an earlier build left in a folder, brought back into Daimond's own storage.
	// Said out loud rather than done quietly: files moved, and the copies in the user's project
	// are still there for them to delete when they are satisfied.
	'files.adopted_title.one':   'A Diamond was brought back',
	'files.adopted_title.other': '{n} Diamonds were brought back',
	'files.adopted_body':        'Daimond found its own files in this folder and copied them back into its own storage, where they sync: {names}. The copies were left where they are, under diamonds/; delete them once you are satisfied.',
	'files.adopted_kept':        'These differed from what Daimond already held, so both copies were kept:\n{paths}',
	// And what did not come back. The copy runs under a budget, and a file past it is
	// left where it is — which the user has to be told, or a Diamond arrives missing a
	// part of itself and looks whole.
	'files.adopt_left_title':    'Some files stayed in the folder',
	'files.adopted_skipped':     'These were not copied, being over 8 MiB or unreadable, so a Diamond that needs one is here without it, or not here at all:\n{paths}',

	// ── The file viewer ────────────────────────────────────────
	// A file is shown as what it IS: decoded where the browser can decode it,
	// laid out where it is text-shaped, and dumped as bytes otherwise. The floor
	// is the tier that matters, so its wording says what the file is and why the
	// bytes are what a reader is looking at, rather than apologising.
	//
	// {fmt} is a format's name, from the `fileview.fmt.*` lookup the viewer does
	// per media variant; where a locale has no entry the library's own English
	// label ("PDF document") stands. {shown}, {total}, {from} and {to} are
	// already formatted numbers -- grouped by the reader's own locale -- so they
	// are never re-formatted here.
	'fileview.read_failed':      'This file could not be read: {reason}',
	'fileview.disagree':         'The name says {named}. The bytes say {found}, and the bytes are what is shown.',
	'fileview.empty':            'This file is empty.',
	'fileview.too_large':        'A {fmt} of {size} is too large to hold in memory here. Its bytes follow; download it to open it elsewhere.',
	'fileview.decode_failed':    'This browser could not decode this {fmt}.',
	'fileview.frame_title':      'The contents of {name}',
	'fileview.json_bad':         'This is not one JSON value, so it is shown as text.',
	'fileview.tree_capped':      'The tree is cut short here; the file is larger than it shows.',
	'fileview.rows_capped':      'Showing the first {shown} rows of {total}.',
	'fileview.capped':           'Showing the first {shown} of {total}.',
	// The honest floor. Two sentences rather than one with a hole in it: with the
	// format unknown, "no viewer here for a Unknown" is what the hole fills with.
	'fileview.hex_note':         'There is no viewer here for a {fmt}, so these are its bytes.',
	'fileview.hex_note_unknown': 'Nothing here recognises this file, so these are its bytes.',
	'fileview.hex_prev':         'Earlier bytes',
	'fileview.hex_next':         'Later bytes',
	'fileview.hex_at':           'Bytes {from} to {to} of {total}',

	// ── One message, read ──────────────────────────────────────
	'msg.unknown_sender':    '(unknown sender)',
	'msg.reply_to':          'Reply-to',
	'msg.reply':             'Reply',
	'msg.reply_all':         'Reply all',
	'msg.forward':           'Forward',
	'msg.save_help':         'Save into the workspace',
	'msg.saved_to':          'Saved · {path}',
	'msg.save_failed':       'Could not save {name}',
	'msg.pictures_blocked':  'Pictures and other remote content are blocked. Loading them tells the sender you opened this.',
	'msg.load_pictures':     'Load pictures',
	'msg.no_text':           '(This message has no readable text part.)',

	// ── Writing one ────────────────────────────────────────────
	'compose.new_message':       'New message',
	'compose.draft':             'Draft',
	'compose.remove_attachment': 'Remove this attachment',
	'compose.err_no_to':         'Say who it is going to.',
	'compose.send_title':        'Send this message?',
	'compose.send_body':         'It will be posted through {from}, and cannot be recalled.',
	'compose.discard_title':     'Discard this draft?',
	'compose.discard_body':      'The draft is deleted and what is written in it is lost.',

	// ── Identity, at the gate ──────────────────────────────────
	'identity.err_enter_pass':      'Enter a passphrase.',
	'identity.err_choose_name':     'Choose a name.',
	'identity.err_confirm_written': 'Confirm you have written the passphrase down first.',
	'identity.err_too_short_gen':   'That passphrase is too short. Generate another, or choose your own.',
	'identity.err_too_short':       'Use a passphrase of at least 8 characters.',
	'identity.err_mismatch':        'The passphrases do not match.',
	'identity.err_create':          'Could not create the account.',
	'identity.err_wrong_pass':      'That passphrase did not match. Try again.',
	'identity.err_locked':          'Daimond identity is locked.',
	'identity.err_no_webcrypto':    'WebCrypto is unavailable in this browser.',

	// ── Passkeys, in the interface ─────────────────────────────
	'passkey.have_one':          'I have a passkey for Daimond',
	'passkey.use_one':           'Use a passkey',
	'passkey.browser_cannot':    'This browser cannot use your passkey, so the passphrase is the way in here.',
	'passkey.adopt_note':        'If you added a passkey on another device, it brings that account here without a pairing code or a passphrase.',
	'passkey.looking':           'Looking for your passkey…',
	'passkey.waiting':           'Waiting for your passkey…',
	'passkey.err_unusable':      'The passkey could not be used.',
	'passkey.err_did_not_work':  'That passkey did not work. Use your passphrase.',
	'passkey.err_enter_pass':    'Enter your passphrase.',
	'passkey.add_title':         'Add a passkey',
	'passkey.add_body':          'Confirm your passphrase to protect it with a passkey. Your device then asks you to create it: Face ID, Touch ID, Windows Hello or a security key.',
	'passkey.continue':          'Continue',
	'passkey.not_added':         'Passkey not added',
	'passkey.err_create_failed2': 'The passkey could not be created.',
	'passkey.err_create_retry':  'The passkey could not be created. You can try again from Settings.',
	'passkey.added':             'Passkey added',
	'passkey.added_synced':      'You can now unlock Daimond with your passkey. It syncs between your own devices, so it brings this account to a new phone or laptop without a pairing code. Your passphrase still works, and remains the fallback.',
	'passkey.added_local':       'You can now unlock Daimond on this device with your passkey. The account service could not be reached, so for now it works here only; add it again once you are online and it will carry the account to your other devices. Your passphrase still works, and remains the fallback.',
	'passkey.added_offer':       'Next time, Daimond will ask for your passkey instead of your passphrase. You can remove it from Settings at any time.',
	'passkey.remove_title':      'Remove passkey?',
	'passkey.remove_body':       'The passkey comes off this device and stops opening your account anywhere else, so you unlock with your passphrase. The passkey itself stays in your authenticator until you delete it there.',
	'passkey.removed':           'Passkey removed',
	'passkey.removed_body':      'This device will ask for your passphrase from now on.',
	'passkey.offer_title':       'Unlock with your face?',
	'passkey.offer_body':        'Daimond can unlock with Face ID, Touch ID or your device PIN instead of the passphrase. Your passkey syncs between your devices, so it carries this account to them as well. Your passphrase keeps working either way.',

	// ── Forgetting an account ──────────────────────────────────
	'forget.credits_title':  'Save your credits first?',
	'forget.credits_body':   'This account holds {amount}, kept on Daimond’s server and unlocked only by this identity. A backup saves the identity encrypted, so another device can take it over, but only with this account’s passphrase, which the backup does not contain. Lose the passphrase and nothing brings the balance back. Export a backup now?',
	'forget.skip':           'Skip',
	'forget.title':          'Forget this account?',
	'forget.ok':             'Erase everything',
	'forget.body':           'This erases your passphrase, your encrypted API key, and all of your chats, Diamonds and spend history on this device.',
	'forget.tail':           'There is no recovery. Everything is gone.',
	'forget.body_secondary': 'This removes the account “{name}” from this browser: its passphrase, keys, chats, Diamonds, spend and files.',
	'forget.tail_secondary': 'There is no recovery. Other accounts here are untouched.',
	'forget.abandons':       'It also abandons {amount} held on the server. Only this identity unlocks it, and only this account\u2019s passphrase opens a backup of the identity.',

	// ── Changing a name, and a passphrase ──────────────────────
	'rename.title':               'Change name',
	'rename.failed':              'Could not rename',
	'changepass.lead':            'This replaces your current passphrase. There is no recovery, so write the new one down before you continue.',
	'changepass.gen_note':        'Eight words picked at random by this device, about {bits} bits, far past anything that can be guessed. It becomes the key to everything you store here, and nobody can reset it for you. Write it on paper. A password manager may also offer to update it, which is safe at this strength.',
	'changepass.new_ph':          'New passphrase',
	'changepass.again_ph':        'Type it once more',
	'changepass.change_it':       'Change it',
	'changepass.select_above':    'Select it above',
	'changepass.err_same_gen':    'That matches your current passphrase. Generate another.',
	'changepass.err_short':       'Use at least 8 characters.',
	'changepass.err_same':        'That is your current passphrase. Choose a different one.',
	'changepass.failed':          'That did not work',
	'changepass.failed_body':     'Your current passphrase did not match. Nothing was changed.',
	'changepass.careful':         'Careful',
	'changepass.key_not_resealed': 'The passphrase changed, but your API key could not be re-encrypted. Re-enter it in Settings.',
	'changepass.changed':         'Passphrase changed',
	'changepass.changed_body':    'Your new passphrase is active. Your saved API key was re-encrypted under it.',
	'changepass.passkey_stale':   'Your passkey could not be updated, so it will ask for the new passphrase. Re-add it from Settings.',

	// ── Backups ────────────────────────────────────────────────
	'backup.unreadable':      'That backup file could not be read.',
	'backup.not_a_backup':    'That is not a Daimond backup.',
	'backup.identity_title':  'Account identity restored',
	'backup.identity_body':   'The backup carried the identity for “{name}”, so this browser is now that account, with the credits and Pro licence held on the server for it. Unlock with that account’s passphrase; the backup does not contain it, and nothing else opens the account.',
	'backup.identity_kept':   'This browser already holds an account, so the identity for \u201c{name}\u201d in that backup was left alone. Everything else was restored.',
	'backup.identity_failed': 'The identity in that backup could not be restored.',
	'backup.restored':        'Backup restored',
	'backup.n_files.one':     '{n} workspace file',
	'backup.n_files.other':   '{n} workspace files',
	'backup.n_diamonds.one':  '{n} diamond',
	'backup.n_diamonds.other': '{n} diamonds',
	'backup.restored_body':   'Restored {files} and {diamonds}. Daimond will reload to open your restored workspace.',
	// Appended to the line above when a backup held another account's files. There are
	// only two places they could go — a folder named after a stranger inside this
	// workspace, or into that account's private storage — and neither is a restore, so
	// they are left out and the user is told rather than left to notice.
	'backup.n_foreign.one':   '{n} file in that backup belongs to another account at that browser, so it was not restored and stays only in the backup.',
	'backup.n_foreign.other': '{n} files in that backup belong to another account at that browser, so they were not restored and stay only in the backup.',

	// ── The provider form ──────────────────────────────────────
	'models.other':            'Other (type manually)…',
	'models.enter_key_first':  'Enter your API key to load models…',
	'models.key_rejected':     'That API key was rejected. Check it and try again.',
	'models.list_failed':      'Could not load models automatically. Pick "Other" and type a model id.',


	// ── The provider form's refusals ───────────────────────────
	'byok.err_provider': 'Choose a provider first.',
	'byok.err_base_url': 'Enter the provider base URL.',
	'byok.err_bad_url':  'That base URL is not a web address. It should start with https:// and name the provider’s host.',
	'byok.err_key':      'Paste your API key.',
	'byok.err_model':    'Choose a model, or wait a moment for the list to load.',
	'byok.err_rejected': 'The provider rejected that API key. Check it and try again.',

	// ── Confirming something irreversible ──────────────────────
	'confirm.yes_do_it':    'Yes, do it',
	'confirm.irreversible': 'Daimond wants to do something that cannot be undone',
	'fold.nothing_chosen':      'Nothing chosen',
	'fold.nothing_chosen_body': 'Tick the turns you want to fold, then press Fold selected.',

	// ── Coming back from a checkout ────────────────────────────
	'checkout.cancelled':        'Cancelled',
	'checkout.cancelled_body':   'Nothing was charged and your balance is unchanged.',
	'checkout.card_saved':       'Card saved',
	'checkout.card_saved_body':  'Daimond can now top up your credits automatically. Set the limits below, then switch it on. Nothing has been charged.',
	'checkout.card_pending_body': 'Stripe has taken the card. It may take a moment to appear here; reopen Credits shortly. Nothing has been charged.',
	'checkout.pro_unlocked':     'Pro unlocked',
	'checkout.pro_unlocked_body': 'You own Daimond. Cross-device sync, cloud storage and Email are on. Nothing renews.',
	'checkout.received':         'Payment received',
	'checkout.pro_pending_body': 'Your Pro unlock is being confirmed and will appear here shortly. Reopen Credits in a moment.',
	'checkout.credits_pending_body': 'Your credits are still being confirmed. They will appear here shortly.',

	// ── Going out to a checkout ────────────────────────────────
	// The two ways buying can fail before Stripe is ever reached: the account
	// service did not answer, and it answered without the address to go to. Both
	// arrive at the user through `friendlyError`, which shows them verbatim.
	// A card and a credit pack are named apart, because a buyer who pressed
	// "Save a card" should not be told about a checkout they did not start.
	'gateway.acct_unreachable': 'Could not reach the Daimond account service. Try again shortly.',
	'gateway.session_no_url':   'The checkout session came back without a URL.',
	'gateway.card_no_url':      'The card session came back without a URL.',

	// ── A few more from the Workspace and Agents panels ────────
	'files.folder_open_failed': 'Could not open that folder.',
	'files.import':             'Import',
	'files.import_body':        'Copy "{name}" into the workspace? Everything in it then syncs to your other devices and counts towards your storage.',
	'files.this_file':          'this file',
	'files.unsaved_close':      'Your changes to {path} have not been saved. Close it and lose them?',
	'agents.no_diamond':        'no Diamond',
	'agents.no_diamond_help':   'This run has no Diamond',
	'agents.only_from':         'Show only agents from "{name}"',
	'changepass.title':         'Change passphrase',
	'changepass.enter_current': 'Enter your current passphrase.',
	'changepass.next':          'Next',

	// ── Errors the app rewrites for the user ───────────────────
	'err.unreachable':  'Could not reach that endpoint. Check the base URL in Settings, and your connection.',
	'err.rejected_401': 'Your API key was rejected (401). Open Settings and check it.',
	'err.denied_403':   'The provider denied access (403). Check your key and plan.',
	'err.notfound_404': 'That endpoint was not found (404). Check the base URL in Settings.',
	'err.ratelimit_429': 'The provider is rate-limiting you (429). Wait a moment and retry.',
	'err.server_5xx':   'The provider had a server error. Try again shortly.',
	'err.generic':      'Something went wrong. Try again.',
	'err.reply_cut':    'The reply ran out of room at {max} tokens, so a tool call arrived incomplete and could not run. Raise the reply length in Settings, or ask for a smaller change',

	// ── How long a reply may be ────────────────────────────────
	'settings.max_tokens':         'Longest reply',
	'settings.max_tokens_auto':    'Automatic',
	'settings.tokens':             'tokens',
	'settings.max_tokens_note':    'How long a single reply may be. Too low and a large file arrives cut in half.',
	'settings.max_tokens_ceiling': 'accepts up to',

	// ── How far one turn may go ─────────────────────
	'settings.max_rounds':         'Steps per turn',
	'settings.crystal_limits':   'Size limits',
	'settings.crystal_cap':      'Crystal size limit',
	'settings.crystal_cap_note': 'A crystal is a Diamond’s summary, so it has a ceiling. Past it, a daimon puts the detail in a file in the Diamond’s scope.',
	'settings.crystal_cap_auto': 'Default',
	'settings.crystal_page_cap': 'Page size limit',
	'settings.crystal_page_cap_note': 'The page that renders a Diamond’s data. It travels in every sync, so it shares the budget with the data itself.',
	'settings.max_rounds_auto':    'Default',
	'settings.steps':              'steps',
	'settings.max_rounds_note':    'How many times an agent may use a tool before one turn stops. It says so when it stops, and you can tell it to carry on.',
	'settings.fold_model':         'Fold with',
	'settings.fold_model_own':     'The conversation’s own model',
	'settings.fold_model_group':   'Fold with instead',
	'settings.fold_model_note':    'When a conversation outgrows its window it is summarised, and the summary becomes what the model remembers. This chooses what writes it, for chats on the same provider; every other chat folds with its own model.',

	// ── The permission ladder ──────────────────────────────────
	// What Daimond does WITHOUT ASKING. Nothing here moves the fence, the
	// system-call filter, a Diamond's folders or the journal — say so plainly,
	// because a person choosing bypass is entitled to know exactly what they
	// have and have not switched off.
	'permmode.title':        'Permission mode',
	'permmode.lead':         'What Daimond does without asking',
	'permmode.chip_help':    'Permission mode: what Daimond does without asking',
	'permmode.chip_aria':    'Permission mode: {mode}. Change it.',
	'permmode.astat':        'Permissions: {mode}',
	'permmode.never':        'No mode changes the fence a command runs inside, the folders a Diamond can reach, or the journal that records what ran.',
	'permmode.failed':       'That permission mode could not be set, so nothing changed.',

	'permmode.ask':          'Ask every time',
	'permmode.ask_blurb':    'Every command is put to you before it runs, and Daimond asks before it fetches any page.',
	'permmode.guarded':      'Guarded',
	'permmode.guarded_blurb': 'Commands run without asking. Once a turn has read a page, an email or a build log, it loses the network and Daimond asks before reaching anywhere new.',
	'permmode.bypass':       'Bypass',
	'permmode.bypass_blurb': 'Nothing is asked. Commands run and pages are fetched, whatever the turn has read.',

	'permmode.bypass_title': 'Stop asking?',
	'permmode.bypass_body':  'Bypass stops the asking. Daimond runs commands on your machine and fetches pages it chose without putting either to you, including on a turn that has already read a web page, an email, or a build log written by somebody else.\n\nThat last case is what you are giving up. It is where something you did not write could talk Daimond into sending your work somewhere.\n\nBypass leaves the rest alone. A command still runs inside the same fence; each Diamond still reaches only its own folders; the system-call filter under it is untouched; text from outside is still marked as somebody else’s words; and every command still goes into the machine hand’s journal, so what ran can be checked afterwards.\n\nYou will not be asked this again.',
	'permmode.bypass_ok':    'Use bypass',

	'permmode.run_title':    'Run this command?',
	'permmode.run_body':     'Daimond wants to run a command on your machine.\n\n{cmd}\n\nin {cwd}\n\nThe “ask every time” permission mode puts every command to you first.',
	'permmode.run_ok':       'Run it',

	// ── When conversations stop being saved ────────────────────
	// Said outright, and while the user can still act. The failure this replaces
	// was silent: the work went on being answered and stopped being stored, and
	// the user found out on the next reload.
	'store.alarm':          'Your conversations are not being saved.',
	'store.alarm_advice':   'Everything on screen is still here, but a reload would lose it. Download a copy now.',
	'store.alarm_download': 'Download a copy',
	'store.alarm_retry':    'Try again',
	'store.full':           'there is no room left in this browser’s storage for this site',

	// ── The delivery check ─────────────────────────────────────
	// A page checking itself. The check NAMES are what a reader scans down, so
	// keep them short; the details are the sentence under a failure.
	//
	// The page around them (verify.html) is here too. It used to be English in
	// every language, under a verdict that was translated -- so a reader was told
	// "manifest self-consistent" in their own language beneath a heading that was
	// not. The verdict lines are the sentences a person acts on, so they carry
	// their emphasis: {NOT} in `verdict_no` is deliberate and should stay loud in
	// whatever way the language has.
	'verify.page_title':      'Verify Daimond',
	'verify.page_lede':       'Check that the Daimond this page came from is the published open source. The evidence is a hash you can reproduce yourself.',
	'verify.checking':        'Checking this build…',
	'verify.recheck':         'Check again',
	'verify.hashing':         'hashing served files… {done} / {total}',
	'verify.ids':             'build {build}  ·  bundle {bundle}',
	'verify.verdict_ok':      'This build is the published source, and it was sealed.',
	'verify.verdict_no':      'This build does NOT match the published source.',
	'verify.verdict_partial': 'Could not fully verify. The checks say why.',
	'verify.independent':     'The independent check.',
	'verify.independent_body': 'A page cannot fully vouch for itself. Build the public source and run the verifier; nothing this server controls is in that loop:',
	// Stands in the command below where the page could not read its own origin.
	'verify.this_site':       'this site',
	// {url} is the transparency log's address, held by the page and never by a
	// translation -- keep the placeholder and the anchor around the words.
	'verify.green_means':     'Green means the bytes this site served are the source you just built, and that build is a sealed entry in the public <a href="{url}">transparency log</a>.',
	'verify.check_manifest':  'manifest',
	'verify.check_self':      'manifest self-consistent',
	'verify.check_log':       'public transparency log',
	'verify.check_sealed':    'sealed in the public log',
	'verify.check_files':     'every served file matches the manifest',
	'verify.no_manifest':     'this build was served without a manifest.json, so it cannot be checked',
	'verify.self_mismatch':   'the manifest bundle hash does not match its file list',
	'verify.log_broken':      'the public log is not an intact chain: {reason}',
	'verify.log_unreachable': 'could not reach the public log (offline, or blocked by policy); run verify/check.mjs to be sure',
	'verify.on_record':       '{n} releases on record',
	'verify.never_published': 'this served bundle is NOT in the public history; it was never published',
	'verify.unreadable':      '(unreadable)',
	'verify.files_differ':    '{n} differ: {list}',
	'verify.files_ok':        '{n} files',
	'verify.chain_order':     'entry {n} out of order',
	'verify.chain_break':     'entry {n} does not chain on {prev}',
	'verify.chain_hash':      'entry {n} hash mismatch',
	'verify.caveat':          'A page cannot vouch for itself: a tampered server could tamper with this check too. For an independent verdict, build the public source and run verify/check.mjs, or use the delivery-verify browser extension. This server can touch neither.',

	// ── Versions and the release history ───────────────────────
	'rel.version':          'Version',
	'rel.prerelease':       'Pre-release',
	'rel.unsealed':         'Unsealed',
	'rel.update_ready':     'update ready',
	'rel.not_published':    'not published',
	'rel.planned':          'planned',
	'rel.next':             'next',
	'rel.you_are_here':     'you are here',
	'rel.today':            'today',
	'rel.yesterday':        'yesterday',
	'rel.days_ago.one':     '{n} day ago',
	'rel.days_ago.other':   '{n} days ago',
	'rel.months_ago.one':   '{n} month ago',
	'rel.months_ago.other': '{n} months ago',
	'rel.years_ago.one':    '{n} year ago',
	'rel.years_ago.other':  '{n} years ago',
	'rel.title_named':      '{name}, build {build}, published {date}.',
	'rel.title_prerelease': 'Pre-release, build {build}, published {date}.',
	'rel.title_behind':     'A newer build has been published; reload to take it.',
	'rel.title_click':      'Click for what changed.',
	'rel.title_unlogged':   'This build is not in the published log. Click for the history.',
	'rel.no_date':          'Not released yet, and not promised for a date.',
	'rel.no_history':       'No published history could be read.',
	'rel.none_declared':    'No release has been declared yet. You are running a build ahead of the first one.',
	'rel.sealed_no':        'sealed #{n}',
	'rel.sealed_builds.one':   '{n} sealed build',
	'rel.sealed_builds.other': '{n} sealed builds',
	'rel.foot':             'A release is declared; a build is deployed. Every build here is recorded in a chain that cannot be rewritten without breaking. There is deliberately no way back to an older one.',

	// ── Updates ────────────────────────────────────────────────
	'update.checking':   'Checking for updates…',
	'update.latest':     'You are on the latest version',
	'update.ready':      'Update ready',
	'update.click_now':  'Click to update now.',
	'update.ready_help': 'Update ready. It applies when this finishes, or click to force it.',
	'update.updated':    'Daimond updated',
	'update.stale':      'Daimond is out of date and must reload to keep working. Click to reload.',

	// ── Typst ──────────────────────────────────────────────────
	// {reason} is the compiler's own diagnostic, which stays as it came.
	'typst.load_failed':   'Typst compiler failed to load: {reason}',
	'typst.no_pdf':        'Typst produced no PDF (unknown compile error).',
	'typst.compile_error': 'Typst compile error: {reason}',

	// ── Toasts ─────────────────────────────────────────────────
	'toast.copied': 'Copied',
	'render.copy_failed': 'Failed',

	// ── The Graph pane ─────────────────────────────────────────
	// One still picture of the Diamonds and the links between them. It is an
	// instrument for checking the structure, so the wording states what is
	// there rather than praising it.
	'graph.no_diamonds':        'No Diamonds yet, so there is nothing to draw.',
	'graph.isolated':           'Not linked',
	'graph.unnamed':            'Untitled',
	'graph.link_mode': 'Link',
	'graph.link_help': 'Click the Diamond a link starts at, then the one it points at. Escape cancels.',
	'graph.organise': 'Organise',
	'graph.organise_help': 'Lay the Diamonds out again to reduce crossings, and keep the new positions.',
	'graph.pick_source': 'Click the source, then the target. Escape cancels.',
	'graph.pick_target': 'From {name}. Click the target, or press Escape.',
	'graph.menu_link': 'Link from here…',
	'graph.menu_open': 'Open this Diamond',
	'graph.menu_reset_node': 'Put this Diamond back',
	'graph.menu_reset_all': 'Put every Diamond back',
	'graph.menu_reset_view': 'Reset the view',
	'graph.menu_edit_link': 'Edit this link…',
	'graph.menu_drop_link': 'Delete this link',
	// The zoom control that takes in the whole picture. One word: it rides in a
	// row of zoom buttons beside the numbers.
	'graph.fit': 'All',
	'graph.fit_help': 'Scale the picture until every Diamond is on screen.',
	'graph.edit_title': 'Link',
	'graph.new_title': 'New link',
	// A link carries several relations, added one at a time. `graph.rel_pool` heads
	// the words already used elsewhere in this graph, offered so the same idea is
	// not written three ways.
	'graph.rels_label': 'Relations',
	'graph.rel_add_ph': 'part-of, blocks… one at a time',
	'graph.rel_add': 'Add this relation',
	'graph.rel_pool': 'Already in use',
	'graph.rel_none': 'No relation yet.',
	'graph.rel_remove': 'Remove {rel}',
	'graph.rel_full': 'A link carries at most {n} characters of relation.',
	'graph.rel_label': 'Relation',
	'graph.rel_ph': 'part-of, blocks, supersedes…',
	'graph.note_label': 'Note',
	'graph.note_ph': 'Whatever the relation does not say.',
	'graph.save': 'Save',
	'graph.create': 'Create',
	'graph.cancel': 'Cancel',
	'graph.drop': 'Delete',
	'graph.self_link': 'A link joins two different Diamonds.',
	'graph.write_failed': 'That could not be written: {err}',
	'graph.edit_help': 'Edit this link',
	'graph.in_cycle':           'This Diamond is on a cycle.',
	'graph.back_edge':          'This link closes a cycle. Cycles are allowed; it is drawn dashed so it can be seen.',
	'graph.edge_tip':           '{from} → {to}',
	'graph.edge_rel':           'Relation: {rel}',
	'graph.failed':             'The graph could not be read: {err}',
	'graph.artefacts.one':      '{n} link to a file, page or chat',
	'graph.artefacts.other':    '{n} links to files, pages or chats',
	'graph.stat_diamonds.one':  '{n} Diamond',
	'graph.stat_diamonds.other': '{n} Diamonds',
	'graph.stat_links.one':     '{n} link between Diamonds',
	'graph.stat_links.other':   '{n} links between Diamonds',
	'graph.stat_cycles.one':    '{n} link closes a cycle',
	'graph.stat_cycles.other':  '{n} links close cycles',
	'graph.stat_dangling.one':  '{n} link points at a Diamond that is gone',
	'graph.stat_dangling.other': '{n} links point at Diamonds that are gone',

	// ── The terminal ───────────────────────────────────────────
	'term.label':            'Terminal',
	'term.hint':             'Type to send keys straight to the program. Ctrl-Shift-C copies the selection, Ctrl-Shift-V pastes, Ctrl-Shift-A selects everything, and Shift with Page Up or Page Down moves through what has scrolled past.',
	'term.screen_label':     'Terminal screen, as text',
	'term.screen_now':       'The screen now reads:',
	'term.nothing_selected': 'Nothing is selected.',
	'term.copied.one':       '{n} line copied.',
	'term.copied.other':     '{n} lines copied.',
	'term.printed_lines.one':   '{n} line printed.',
	'term.printed_lines.other': '{n} lines printed.',
	'term.paste_warn':       'This paste is {n} lines. The program has not asked to be told when text is pasted, so every line after the first would run the moment it arrived.',
	'term.paste_first':      'Paste the first line',
	'term.paste_all':        'Paste all {n} lines',
	'term.exited':           'The program exited with status {code}.',

	// ── The Terminal panel ─────────────────────────────────────
	// The sentences a refusal is made of live one layer down, in js/handpty.js and
	// in the hand itself, and reach the panel verbatim. What is here is the panel's
	// own furniture, plus the two conditions no lower layer can report: a page
	// missing one of its own scripts, and a build whose wasm cannot say what a
	// terminal would be allowed to touch.
	'term.notices_label':    'Notices about this terminal',
	'term.dismiss_notice':   'Dismiss this notice',
	'term.gaps_count.one':   'Output is missing in {n} place.',
	'term.gaps_count.other': 'Output is missing in {n} places.',
	'term.start':            'Start a terminal',
	'term.restart':          'Restart the terminal',
	'term.stop':             'Stop the program',
	'term.leave_hint':       'Press F6 to move the keyboard out of the terminal.',
	'term.starting':         'Starting a terminal…',
	'term.running':          'The terminal is running.',
	'term.nothing_running':  'There is no program running in this terminal.',
	'term.not_paired':       'No machine hand is paired with this browser, so there is no machine to open a terminal on. Everything else in Daimond works without one.',
	'term.no_composer':      'This build cannot say what a terminal would be allowed to touch, so it will not open one. The Rust side of the app works that out, and this page is older than it. Update Daimond; commands and the file tools are unaffected.',
	'term.unreadable_request': 'Daimond could not read its own answer about what this terminal would be allowed to touch, so nothing was started. Reload the app; if it happens again, the app needs updating.',
	'term.no_relay_script':  'The terminal relay did not load in this page, so no terminal can be opened. Nothing is wrong with your machine. Reload Daimond.',
	'term.no_renderer':      'The terminal itself did not load in this page, so there is nothing to draw one on. Nothing is wrong with your machine. Reload Daimond.',

	// The durable trail, shown on the lock screen only when the app is
	// actually looping -- three boots in ninety seconds. See breadcrumb.js.
	'trail.looping':         'Daimond has restarted {n} times in the last minute. This is what it did; copy it into a bug report.',
	'trail.copy':            'Copy',
	'trail.copied':          'Copied',
	'trail.clear':           'Clear',

	// A safe start: the app opens without the sync engine, so a device that
	// cannot stay open long enough to be used gets to be used. See safe.js.
	'safe.armed':            'Daimond has started without syncing, so it should stay open. Your work is safe on this device, and reaches your other devices again once syncing is turned back on.',
	'safe.offer':            'If Daimond will not stay open, start it without syncing. Your work stays on this device and nothing is deleted.',
	'safe.turn_off':         'Start without syncing',
	'safe.turn_on':          'Turn syncing back on',
	'safe.chip':             'Sync off (safe start)',
	'safe.chip_reason':      'Daimond started without syncing, so this device’s work is not reaching your other devices. Nothing is lost; it is all still here.',
	'safe.chip_click':       'Click to turn syncing back on.',
	'safe.turn_on_title':    'Turn syncing back on?',
	'safe.turn_on_ask':      'Daimond restarts and tries to sync with your other devices again. If it starts closing itself, it goes back to a safe start on its own.',
	'safe.turn_on_ok':       'Restart with syncing',


	// The sync switch and the durable trail, both reachable from the admin
	// panel. See safe.js and breadcrumb.js.
	'home.sec_sync':        'Syncing and diagnostics',
	'settings.sync':        'Syncing',
	'settings.sync_on_note': 'This device is sending its work to your other devices. Stopping is immediate and loses nothing; everything stays here.',
	'settings.sync_off_note': 'This device is not syncing. Its work is safe here and is not reaching your other devices.',
	'settings.trail':       'Diagnostics',
	'settings.trail_copy':  'Copy the app’s own trail',
	'settings.trail_note':  'What Daimond last did: event names and a clock, no keys, no message text, nothing from your files. Safe to paste into a bug report.',
	'settings.trail_empty': 'Nothing recorded yet.',
	// ── The Trash ──────────────────────────────────────────────
	// Deleting a chat or a Diamond moves it here and asks nothing. The two
	// questions that cannot be taken back are both in this panel.
	'panel.trash': 'Trash',
	'trash.nothing': 'Nothing has been deleted.',
	'trash.kept_days': 'Kept for {days} days, then destroyed.',
	'trash.holding.one': '{n} thing, {bytes}',
	'trash.holding.other': '{n} things, {bytes}',
	'trash.until': 'Until {date}',
	'trash.deleted_why': 'Deleted. It is only here.',
	'trash.kind_chat': 'chat',
	'trash.kind_diamond': 'diamond',
	'trash.unnamed_chat': 'Unnamed chat',
	'trash.restore': 'Restore',
	'trash.restore_named': 'Restore {name}',
	'trash.restore_all': 'Restore everything',
	'trash.purge': 'Delete permanently',
	'trash.purge_named': 'Delete {name} permanently',
	'trash.purge_ask': 'Delete “{name}” for good? It goes from every device, and there is no way back.',
	'trash.purge_ok': 'Delete permanently',
	'trash.empty': 'Empty trash',
	'trash.empty_ask.one': 'Destroy the {n} thing in the trash for good? It goes from every device, and there is no way back.',
	'trash.empty_ask.other': 'Destroy all {n} things in the trash for good? They go from every device, and there is no way back.',
	'trash.empty_ok': 'Empty trash',
	'trash.moved': 'Moved “{name}” to the trash.',
	'trash.moved_n.one': 'Moved {n} thing to the trash.',
	'trash.moved_n.other': 'Moved {n} things to the trash.',
	});
})();
