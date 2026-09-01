// Hamster Wheel — VS Code sidebar over the hamster tmux system.
// Pure viewer/controller: all state lives in hamster (~/.claude/hamster +
// tmux); every action shells back into `hamster` / `tmux`. No writes here.
// The webview renderer reconciles rows in place (no innerHTML blasts) so
// CSS activity animations run continuously instead of restarting every poll.
const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HDIR = path.join(os.homedir(), '.claude', 'hamster');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const NOTES = path.join(HDIR, 'notes');

function cfg() { return vscode.workspace.getConfiguration('hamster'); }
function expandHome(p) {
  return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
const STABLE = path.join(HDIR, 'bin');
let resolvedBin = null;   // set by ensureSetup at activation
let setupDone = Promise.resolve();   // replaced in activate; awaited before any exec
function hamsterBin() {
  const p = cfg().get('path');
  if (p) return expandHome(p);
  return resolvedBin || path.join(STABLE, 'hamster');
}

// ── first-run bootstrap ──────────────────────────────────────────────────
// Hooks must survive extension updates (versioned install paths), so the
// bundled core is synced to a STABLE location and hooks point there. A
// git-clone install (hooks already pointing at a live checkout) is adopted
// as-is — never rewired out from under the user.
const CORE_FILES = ['hamster', 'wheelstate.py', 'pick.py', 'enrich.py',
  'backfill_facts.py', 'backfill_artifacts.py', 'facts-hook.sh', 'facts_hook.py',
  'hamster.tmux.conf'];
const SKIP_CMDS = ['hamster.jump', 'hamster.menu', 'hamster.snoozeActive',
  'hamster.renameActive', 'hamster.hidesnooze', 'hamster.new',
  'hamster.stepPrev', 'hamster.stepNext', 'hamster.prev', 'hamster.attach'];

async function exists(p) {
  try { await fs.promises.access(p); return true; } catch (e) { return false; }
}

async function findHookBin(sj) {
  for (const e of ((sj.hooks || {}).Stop || [])) {
    for (const k of (e.hooks || [])) {
      const m = /^(.*\/hamster) stop-hook$/.exec(k.command || '');
      if (m && await exists(m[1])) return m[1];
    }
  }
  return null;
}

async function syncCore(src, version) {
  const stamp = path.join(STABLE, '.version');
  try {
    if (await fs.promises.readFile(stamp, 'utf8') === version) {
      let all = true;
      for (const f of CORE_FILES) if (!await exists(path.join(STABLE, f))) { all = false; break; }
      if (all) return;
    }
  } catch (e) { /* first run */ }
  await fs.promises.mkdir(STABLE, { recursive: true });
  for (const f of CORE_FILES) await fs.promises.copyFile(path.join(src, f), path.join(STABLE, f));
  for (const f of ['hamster', 'facts-hook.sh']) await fs.promises.chmod(path.join(STABLE, f), 0o755);
  await fs.promises.writeFile(stamp, version);
}

async function writeHooks(sj, settingsPath, raw) {
  const ham = path.join(STABLE, 'hamster');
  const facts = path.join(STABLE, 'facts-hook.sh');
  const wanted = [
    ['UserPromptSubmit', null, ham + ' submit-hook'],
    ['Stop', null, ham + ' stop-hook'],
    ['Notification', null, ham + ' notify-hook'],
    ['SubagentStart', null, ham + ' subagent 1'],
    ['SubagentStop', null, ham + ' subagent -1'],
    ['PostToolUse', 'Bash', facts],
    ['PostToolUse', 'Artifact', facts],
  ];
  const hooks = sj.hooks = sj.hooks || {};
  for (const [ev, matcher, cmd] of wanted) {
    let entries = hooks[ev] = hooks[ev] || [];
    for (const e of entries) {   // strip broken wirings from old paths
      const keep = [];
      for (const k of (e.hooks || [])) {
        const c = k.command || '';
        const ours = /\/(hamster( |$)|facts-hook\.sh)/.test(c);
        if (!ours || c.startsWith(STABLE) || await exists(c.split(' ')[0])) keep.push(k);
      }
      e.hooks = keep;
    }
    hooks[ev] = entries = entries.filter(e => (e.hooks || []).length);
    const hit = entries.some(e => (matcher == null || e.matcher === matcher)
      && (e.hooks || []).some(k => k.command === cmd));
    if (!hit) {
      const e = { hooks: [{ type: 'command', command: cmd, timeout: 10 }] };
      if (matcher) e.matcher = matcher;
      entries.push(e);
    }
  }
  if (raw !== null) {
    await fs.promises.writeFile(settingsPath + '.bak-claude-hamster', raw);
  }
  await fs.promises.writeFile(settingsPath, JSON.stringify(sj, null, 2));
}

async function ensureSkipShell() {
  const conf = vscode.workspace.getConfiguration();
  const key = 'terminal.integrated.commandsToSkipShell';
  const cur = (conf.inspect(key) || {}).globalValue || [];
  const merged = cur.concat(SKIP_CMDS.filter(x => !cur.includes(x)));
  if (merged.length !== cur.length) {
    await conf.update(key, merged, vscode.ConfigurationTarget.Global);
  }
}

async function ensureSetup(context) {
  try {
    await ensureSkipShell();
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let sj = {};
    let raw = null;
    try { raw = await fs.promises.readFile(settingsPath, 'utf8'); } catch (e) { /* fresh */ }
    if (raw !== null) {
      try { sj = JSON.parse(raw); } catch (e) {
        vscode.window.showWarningMessage(
          'Hamster: ~/.claude/settings.json exists but is not valid JSON — '
          + 'not touching it. Fix it (or run install.sh) and reload to wire the hooks.');
        return;
      }
    }
    const hookBin = await findHookBin(sj);
    if (hookBin) {
      resolvedBin = hookBin;
      if (hookBin.startsWith(STABLE)) {   // our managed copy: keep it current
        await syncCore(path.join(context.extensionPath, 'core'),
          (context.extension && context.extension.packageJSON.version) || '0');
      }
      return;   // existing install adopted
    }
    await syncCore(path.join(context.extensionPath, 'core'),
      (context.extension && context.extension.packageJSON.version) || '0');
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeHooks(sj, settingsPath, raw);
    resolvedBin = path.join(STABLE, 'hamster');
    vscode.window.showInformationMessage(
      'Hamster: Claude Code hooks wired; core installed to ~/.claude/hamster/bin. '
      + 'Run "Hamster: Install CLI" to get `hamster` on your PATH (optional).');
  } catch (e) {
    console.error('hamster bootstrap failed', e);
  }
}

async function installCli() {
  await setupDone;
  const bin = hamsterBin();
  const dst = path.join(os.homedir(), '.local', 'bin', 'hamster');
  try {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    try { await fs.promises.unlink(dst); } catch (e) { /* absent */ }
    await fs.promises.symlink(bin, dst);
    vscode.window.showInformationMessage('Hamster: linked ' + dst + ' → ' + bin
      + ' (ensure ~/.local/bin is on your PATH)');
  } catch (e) {
    vscode.window.showErrorMessage('Hamster: could not link CLI — ' + e.message);
  }
}
// GUI-launched VS Code has a bare PATH; hamster needs tmux/claude/python3/gh
function env(extra) {
  const add = [path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const cur = (process.env.PATH || '').split(':');
  const PATH = [...add.filter(p => !cur.includes(p)), ...cur].join(':');
  return { ...process.env, PATH, ...(extra || {}) };
}
function exec(bin, args, extraEnv, timeoutMs) {
  return new Promise(resolve => {
    cp.execFile(bin, args, { env: env(extraEnv), timeout: timeoutMs || 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}
const hamster = async (args, extraEnv, timeoutMs) => {
  await setupDone;   // bootstrap must resolve the binary before first exec
  return exec(hamsterBin(), args, extraEnv, timeoutMs);
};
const tmux = (args) => exec('tmux', args);

let ownWheelTerminal = null;
function wheelTerminal(startIfMissing) {
  const name = cfg().get('terminalName') || 'hamster';
  // Only adopt a terminal this extension created (location is guaranteed).
  // A same-named stray — persistent-session revival re-docks the old one in
  // the panel — gets disposed: it's just a tmux attach client, and a second
  // client would mirror the wheel and clamp its size to the smaller pane.
  if (ownWheelTerminal && ownWheelTerminal.exitStatus === undefined
      && vscode.window.terminals.includes(ownWheelTerminal)) {
    ownWheelTerminal.show(false);
    return ownWheelTerminal;
  }
  ownWheelTerminal = null;
  const stray = vscode.window.terminals.find(x => x.name === name);
  if (stray) stray.dispose();
  if (!startIfMissing) return null;
  const loc = (cfg().get('terminalLocation') || 'editor') === 'panel'
    ? vscode.TerminalLocation.Panel : vscode.TerminalLocation.Editor;
  const t = vscode.window.createTerminal({ name, location: loc });
  t.sendText('"' + hamsterBin() + '" start');   // absolute — PATH may lack the CLI
  t.show(false);
  ownWheelTerminal = t;
  return t;
}

async function getState() {
  const r = await hamster(['json']);
  try { return JSON.parse(r.stdout); } catch (e) { return null; }
}
async function cmdPrev() {
  const st = await getState();
  await tmux(['last-window', '-t', (st && st.session) || 'hamster']);
  wheelTerminal(true);
}
async function activeSession() {
  const st = await getState();
  const w = st && st.ok && (st.windows || []).find(x => x.active);
  return w ? { t: w.target, n: w.name } : null;
}
const JICON = { working: '◐', attention: '❓', snoozed: '💤', ready: '·', shell: '▣' };
async function cmdJump() {
  const st = await getState();
  if (!st || !st.ok) { vscode.window.showWarningMessage('Hamster: wheel offline'); return; }
  const rows = (st.windows || []).slice()
    .sort((a, b) => (b.last_mtime || 0) - (a.last_mtime || 0))
    .map(w => ({
      label: `${JICON[w.state] || '·'} ${w.name}`,
      description: [w.sid ? w.sid.slice(0, 8) : '(no id)',
                    w.base, w.branch ? '⎇ ' + w.branch : ''].filter(Boolean).join('  ·  '),
      target: w.target,
    }));
  const p = await vscode.window.showQuickPick(rows, { placeHolder: 'Jump to a wheel session' });
  if (!p) return;
  await tmux(['select-window', '-t', p.target]);
  wheelTerminal(true);
}

// Per-session free-text notes, keyed by sid (survives restarts/reorders),
// stored as ~/.claude/hamster/notes/<sid>.md. Follows the active session.
class NotesProvider {
  constructor() { this.view = null; this.curSid = null; this.saving = Promise.resolve(); }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = notesHtml();
    view.webview.onDidReceiveMessage(m => {
      if (m.cmd !== 'save' || !m.sid) return;
      // serialized: update() awaits this chain before reading, so a rapid
      // A→B→A switch can't read A's file ahead of A's in-flight save
      this.saving = this.saving.then(async () => {
        try {
          await fs.promises.mkdir(NOTES, { recursive: true });
          await fs.promises.writeFile(path.join(NOTES, m.sid + '.md'), m.text || '');
        } catch (e) {
          vscode.window.showErrorMessage('Hamster notes: ' + e.message);
        }
      });
    });
    view.onDidDispose(() => { this.view = null; this.curSid = null; });
    this.curSid = null;   // force a load on next update
  }

  async update(state) {
    if (!this.view) return;
    let sid = '', label = 'wheel offline';
    if (state && state.ok) {
      const w = (state.windows || []).find(x => x.active) || null;
      if (w) {
        sid = w.sid || '';
        label = sid ? `${w.name} — ${sid.slice(0, 8)}` : `${w.name} — no session id yet`;
      } else label = 'no active session';
    }
    if (sid === this.curSid) {
      try { this.view.webview.postMessage({ type: 'load', sid, label, sameSid: true }); } catch (e) { }
      return;
    }
    let text = '';
    if (sid) {
      await this.saving;   // any in-flight save for this sid lands first
      try { text = await fs.promises.readFile(path.join(NOTES, sid + '.md'), 'utf8'); }
      catch (e) { text = ''; }
    }
    this.curSid = sid;
    try { this.view.webview.postMessage({ type: 'load', sid, label, text }); } catch (e) { }
  }
}

function notesHtml() {
  return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { height: 100%; }
  body { margin: 0; display: flex; flex-direction: column; font-family: var(--vscode-font-family); }
  #who { flex: none; padding: 3px 8px; font-size: 10px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  textarea { flex: 1; width: 100%; box-sizing: border-box; border: none; outline: none; resize: none;
    background: transparent; color: var(--vscode-foreground, inherit);
    padding: 4px 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
</style></head><body>
<div id="who">…</div>
<textarea id="ta" placeholder="Notes for this session — autosaved, follows the active session" disabled></textarea>
<script>
  const vs = acquireVsCodeApi();
  const ta = document.getElementById('ta'), who = document.getElementById('who');
  let sid = '', dirty = false, timer = null;
  function flush() {
    if (dirty && sid) { vs.postMessage({ cmd: 'save', sid, text: ta.value }); dirty = false; }
  }
  ta.addEventListener('input', () => { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 600); });
  ta.addEventListener('blur', flush);
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type !== 'load') return;
    who.textContent = m.label || '';
    if (m.sameSid) return;         // just a label refresh — never clobber edits
    flush();                       // switching sessions: persist the old one first
    sid = m.sid || '';
    ta.value = m.text || '';
    dirty = false;
    ta.disabled = !sid;
  });
</script></body></html>`;
}

class WheelProvider {
  constructor() { this.view = null; this.timer = null; this.enrichTimer = null; this.state = null; this.notes = null; }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      vscode.window.showErrorMessage('Hamster: ' + (e && e.message || e));
    }));
    view.onDidChangeVisibility(() => view.visible ? this.startPoll() : this.stopPoll());
    view.onDidDispose(() => { this.stopPoll(); this.view = null; });
    this.startPoll();
  }

  startPoll() {
    this.stopPoll();
    const ms = Math.max(Number(cfg().get('pollMs')) || 1500, 500);
    this.tick();
    this.timer = setInterval(() => this.tick(), ms);
    const enrich = () => {
      if (Date.now() - (this.lastEnrich || 0) < 4 * 60 * 1000) return;
      this.lastEnrich = Date.now();
      hamster(['enrich']);   // PR backfill: slow gh rail, fire-and-forget
    };
    enrich();
    this.enrichTimer = setInterval(enrich, 5 * 60 * 1000);
  }
  stopPoll() {
    if (this.timer) clearInterval(this.timer);
    if (this.enrichTimer) clearInterval(this.enrichTimer);
    this.timer = this.enrichTimer = null;
  }

  async tick() {
    if (!this.view) return;
    const r = await hamster(['json']);
    let state;
    try { state = JSON.parse(r.stdout); }
    catch (e) {
      state = { ok: false, error: (r.stderr || r.stdout || 'hamster json failed').trim().slice(0, 300), windows: [] };
    }
    this.state = state;
    try { this.view.webview.postMessage({ type: 'state', state }); } catch (e) { /* view gone */ }
    if (this.notes) this.notes.update(state);
    const c = state.counts || {};
    const n = (c.attention || 0) + (c.ready || 0);
    this.view.badge = n ? { value: n, tooltip: `${c.attention || 0} need you · ${c.ready || 0} ready` } : undefined;
  }

  async onMessage(m) {
    const t = m.target;
    const T = t ? { HAMSTER_TARGET: t } : null;
    switch (m.cmd) {
      case 'refresh': break;
      case 'attach': wheelTerminal(true); break;
      case 'openpr':
        if (m.url) vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;   // no state change — skip the extra tick
      case 'openticket': {
        const base = (cfg().get('jiraBaseUrl') || '').replace(/\/+$/, '');
        if (base && m.key) vscode.env.openExternal(vscode.Uri.parse(base + '/browse/' + m.key));
        return;
      }
      case 'openartifact': {
        if (m.url && !m.path) { vscode.env.openExternal(vscode.Uri.parse(m.url)); return; }
        const opts = [];
        if (m.url) opts.push('Open Link');
        if (m.path) opts.push('Open File (default app)', 'Open in Editor', 'Reveal in Finder');
        opts.push(m.url ? 'Copy URL' : 'Copy Path');
        const pick = await vscode.window.showQuickPick(opts, { placeHolder: m.url || m.path });
        if (pick === 'Open Link') vscode.env.openExternal(vscode.Uri.parse(m.url));
        else if (pick === 'Open File (default app)') vscode.env.openExternal(vscode.Uri.file(m.path));
        else if (pick === 'Open in Editor') vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path));
        else if (pick === 'Reveal in Finder') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
        else if (pick && pick.startsWith('Copy')) await vscode.env.clipboard.writeText(m.url || m.path);
        return;
      }
      case 'addartifact': {
        const val = await vscode.window.showInputBox({
          prompt: `Artifact URL or file path for ${m.name || t}`,
          placeHolder: 'https://… or /path/to/demo.html', ignoreFocusOut: true,
        });
        if (!val) break;
        const label = await vscode.window.showInputBox({
          prompt: 'Label (optional)', ignoreFocusOut: true,
        });
        if (label === undefined) break;
        const args = ['artifact', 'add', val];
        if (label) args.push(label);
        const r = await hamster(args, T);
        if (r.stdout.trim()) vscode.window.showInformationMessage('Hamster: ' + r.stdout.trim());
        break;
      }
      case 'opendir': {
        if (!m.path) return;
        const pick = await vscode.window.showQuickPick(
          ['Open in New Window', 'Reveal in Finder', 'Copy Path'],
          { placeHolder: m.path });
        if (pick === 'Open in New Window') {
          vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: true });
        } else if (pick === 'Reveal in Finder') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(m.path));
        } else if (pick === 'Copy Path') {
          await vscode.env.clipboard.writeText(m.path);
          vscode.window.showInformationMessage('Copied: ' + m.path);
        }
        return;
      }
      case 'focus':
        await tmux(['select-window', '-t', t]);
        wheelTerminal(true);
        break;
      case 'prev': await cmdPrev(); break;
      case 'hidesnooze': await hamster(['hidesnooze'], { HAMSTER_TARGET: 'x' }); break;
      case 'pin': await hamster(['pin'], T); break;
      case 'unsnooze': await hamster(['unsnooze'], T); break;
      case 'relabel': await hamster(['relabel-current'], T); break;
      case 'ainame': await hamster(['ai-name', t], T); break;
      case 'rename': {
        const v = await vscode.window.showInputBox({
          prompt: `Pin a name for ${m.name || t}`, value: m.name || '', ignoreFocusOut: true,
        });
        if (v) await hamster(['rename', v], T);
        break;
      }
      case 'restart': {
        const yes = await vscode.window.showWarningMessage(
          `Restart claude for "${m.name || t}"? Resumes the same session in a fresh process.`,
          { modal: true }, 'Restart');
        if (yes) await hamster(['restart', 'current'], T);
        break;
      }
      case 'restartAll': {
        const pick = await vscode.window.showWarningMessage(
          'Restart claude in every wheel session (post claude-update)? Each resumes in place.',
          { modal: true }, 'Idle only', 'Force (working too)');
        if (!pick) break;
        const r = await hamster(['restart', pick.startsWith('Force') ? 'force' : 'all'], null, 600000);
        vscode.window.showInformationMessage('Hamster: ' + (r.stdout || r.stderr).trim().replace(/\n/g, ' · '));
        break;
      }
      case 'snooze': {
        const inc = await vscode.window.showQuickPick(
          ['1m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '1w', 'forever'],
          { placeHolder: `Snooze ${m.name || t} for…` });
        if (inc) await hamster(['snooze', inc], T);
        break;
      }
      case 'close': {
        const yes = await vscode.window.showWarningMessage(
          `End session "${m.name || t}"? Kills its tmux window.`, { modal: true }, 'End session');
        if (yes) await hamster(['close'], T);
        break;
      }
      case 'new': {
        const dir = await vscode.window.showInputBox({
          prompt: 'Working directory for the new session',
          value: cfg().get('newSessionDir') || '~', ignoreFocusOut: true,
        });
        if (dir === undefined) break;
        const name = await vscode.window.showInputBox({
          prompt: 'Session name (empty = auto-title)', ignoreFocusOut: true,
        });
        if (name === undefined) break;
        const args = ['new', expandHome(dir || '')];
        if (name) args.push(name);
        const r = await hamster(args);
        if (r.err) vscode.window.showErrorMessage('Hamster new: ' + (r.stderr || r.err.message));
        break;
      }
      case 'adopt': {
        const here = path.dirname(await fs.promises.realpath(hamsterBin()));
        const r = await exec('python3', [
          path.join(here, 'pick.py'), 'adopt', HDIR, PROJECTS, '/dev/null',
          path.join(os.homedir(), '.claude', 'active-sessions.jsonl'), '72',
        ], { HAMSTER_PICK_DRY: '1' });
        let rows = [];
        try { rows = JSON.parse(r.stdout); } catch (e) { /* none */ }
        if (!rows.length) { vscode.window.showInformationMessage('Hamster: no registered sessions outside the wheel.'); break; }
        const picked = await vscode.window.showQuickPick(
          rows.map(x => ({ label: x.label, out: x.out })),
          { canPickMany: true, placeHolder: 'Adopt sessions into the wheel' });
        if (!picked || !picked.length) break;
        for (const p of picked) {
          const [sid, cwd] = p.out.split('\t');
          const ar = await hamster(['adopt', sid, cwd || '']);
          if (ar.err) vscode.window.showWarningMessage('Adopt failed: ' + (ar.stdout || ar.stderr).trim());
        }
        break;
      }
    }
    await this.tick();
  }
}

function html() {
  return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; }
  #hdr { position: sticky; top: 0; background: var(--vscode-sideBar-background); padding: 6px 8px; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,.2)); z-index: 2; }
  #counts { opacity: .85; }
  #hbtns { display: flex; gap: 4px; margin-top: 5px; flex-wrap: wrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 2px 7px; cursor: pointer; font-size: 11px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #filt { width: 100%; box-sizing: border-box; margin-top: 5px; padding: 2px 6px; font-size: 11px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; outline: none; }
  #filt:focus { border-color: var(--vscode-focusBorder); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; padding: 3px 8px; cursor: pointer; white-space: nowrap; position: relative; overflow: hidden; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .row.snoozed { opacity: .5; }
  .icon { width: 14px; text-align: center; flex: none; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; visibility: hidden;
    background: var(--vscode-charts-green, #2da042);
    box-shadow: 0 0 5px var(--vscode-charts-green, #2da042); }
  .row.unseen .dot { visibility: visible; }
  .pinstar { flex: none; font-size: 10px; }
  .name { overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; }
  .meta { opacity: .6; flex: none; font-size: 11px; }
  .sub { flex-basis: 100%; padding-left: 20px; font-size: 10px; opacity: .6; overflow: hidden; text-overflow: ellipsis; }
  .subx { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 2px 4px; padding: 2px 8px 4px 20px; font-size: 10px; opacity: .75; }
  .c { border: 1px solid rgba(128,128,128,.35); border-radius: 3px; padding: 0 4px; cursor: pointer; white-space: nowrap; }
  .c:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); }
  .ticket { flex: none; font-size: 10px; opacity: .6; border: 1px solid rgba(128,128,128,.4); border-radius: 3px; padding: 0 3px; }
  .pr { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .pr:hover { text-decoration: underline; }
  .acts { display: none; gap: 2px; flex: none; }
  .row:hover .acts { display: inline-flex; }
  .acts button { padding: 0 4px; background: transparent; }
  .acts button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); }
  #err { padding: 12px 10px; }
  #err button { margin-top: 8px; display: block; }
  /* ── activity animations ─────────────────────────────────────────── */
  .row.working .icon { display: inline-block; animation: spin 1.2s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .row.working::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
    background: linear-gradient(90deg, transparent 20%, var(--vscode-progressBar-background, #0e70c0) 50%, transparent 80%);
    background-size: 200% 100%; animation: shimmer 1.6s linear infinite; opacity: .8; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .row.attention { border-left: 3px solid var(--vscode-editorWarning-foreground, #d7ba7d); padding-left: 5px;
    animation: breathe 2s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { background-color: transparent; }
    50% { background-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d7ba7d) 14%, transparent); } }
  .row.flash-done { animation: flashDone .9s ease-out 1; }
  @keyframes flashDone { from { background-color: color-mix(in srgb, var(--vscode-charts-green, #2da042) 35%, transparent); }
    to { background-color: transparent; } }
  .row.flash-attn { animation: breathe 2s ease-in-out infinite, flashAttn .9s ease-out 1; }
  @keyframes flashAttn { from { background-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d7ba7d) 45%, transparent); }
    to { background-color: transparent; } }
  .meta.pop { animation: pop .35s ease-out 1; }
  @keyframes pop { 50% { transform: scale(1.4); opacity: 1; } }
</style></head><body>
<div id="hdr"><div id="counts">…</div><div id="hbtns">
  <button data-h="prev" title="Back to the session you were just on">◀ prev</button>
  <button data-h="new" title="Launch a new Claude session">✚ new</button>
  <button data-h="adopt" title="Adopt registered sessions">⤓ adopt</button>
  <button data-h="restartAll" title="Restart claude in every session (post claude-update); each resumes in place">⟲ all</button>
  <button data-h="hidesnooze" id="hideChip" class="chip" title="Hide/show snoozed sessions (F8)"></button>
  <button data-h="lensState" id="lensState" class="chip">❗ needs-you</button>
  <button data-h="lensRecent" id="lensRecent" class="chip">🕐 recent</button>
</div>
<input id="filt" placeholder="filter — name, ticket, branch (esc clears)" title="Type to filter the list; Esc clears"></div>
<div id="list"></div>
<div id="err" hidden></div>
<script>
  const vs = acquireVsCodeApi();
  const send = (cmd, target, name) => vs.postMessage({ cmd, target, name });
  // base order = alphabetical (stable shelf); a lens is a transient overlay —
  // engaged/off, off returns to the shelf. No manual ordering by design.
  let prefs = vs.getState() || {};
  if (!['state', 'recent', null].includes(prefs.lens ?? null)) prefs.lens = null;
  delete prefs.sort;
  let lastState = null;
  let filt = '';
  document.getElementById('hbtns').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const h = b.dataset.h;
    if (h === 'lensState' || h === 'lensRecent') {
      const v = h === 'lensState' ? 'state' : 'recent';
      prefs.lens = prefs.lens === v ? null : v;
      vs.setState(prefs);
      if (lastState) render(lastState);
      return;
    }
    send(h);
  });
  const filtEl = document.getElementById('filt');
  filtEl.addEventListener('input', () => {
    filt = filtEl.value.trim().toLowerCase();
    if (lastState) render(lastState);
  });
  filtEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { filtEl.value = ''; filt = ''; if (lastState) render(lastState); }
  });
  const ICON = { working: '◐', attention: '❓', snoozed: '💤', ready: '·', shell: '▣' };
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dur = s => s == null ? '' : s < 0 ? '∞' : s < 3600 ? Math.floor(s/60)+'m' : s < 86400 ? Math.floor(s/3600)+'h' : Math.floor(s/86400)+'d';
  const SKEL =
    '<span class="dot" title="Returned — you haven\\'t seen this response yet"></span>' +
    '<span class="icon"></span><span class="pinstar" hidden>📌</span>' +
    '<span class="ticket" hidden></span><span class="name"></span><span class="meta"></span>' +
    '<span class="acts">' +
      '<button data-a="pin" title="Pin / unpin — pinned sessions float above the a–z shelf (lenses override)">📌</button>' +
      '<button data-a="snooze" title="Snooze (hide) this session…">💤</button>' +
      '<button data-a="unsnooze" title="Unsnooze — back in the ready queue" hidden>⏰</button>' +
      '<button data-a="ainame" title="AI-name this session from its chat">✨</button>' +
      '<button data-a="restart" title="Restart the claude process (resumes this session in place)">⟲</button>' +
      '<button data-a="close" title="End the session (kills its tmux window)">✕</button>' +
    '</span><span class="sub"></span><span class="subx" hidden></span>';
  const rowEls = new Map();   // target -> element, reused across polls
  const expandedRows = new Set();   // targets with the detail accordion open (ephemeral)

  function makeRow(t) {
    const el = document.createElement('div');
    el.className = 'row';
    el.dataset.t = t;
    el.innerHTML = SKEL;
    return el;
  }
  function setText(el, sel, txt) {
    const n = el.querySelector(sel);
    if (n.textContent !== txt) n.textContent = txt;
  }
  function updateRow(el, w) {
    const p = el._w || {};
    el.dataset.n = w.name;
    const cls = 'row ' + w.state + (w.active ? ' active' : '') + (w.unseen ? ' unseen' : '');
    if (el._cls !== cls) {
      const hadState = p.state;
      el.className = cls;
      el._cls = cls;
      if (hadState && hadState !== w.state) {   // one-shot transition flash
        const f = w.state === 'attention' ? 'flash-attn'
                : (hadState === 'working' ? 'flash-done' : '');
        if (f) {
          el.classList.add(f);
          setTimeout(() => el.classList.remove('flash-attn', 'flash-done'), 1000);
        }
      }
    }
    setText(el, '.icon', ICON[w.state] || '·');
    el.querySelector('.pinstar').hidden = !w.pin;
    const tks = w.tickets || [];
    const tkHead = tks.slice(0, 3);
    const tkPfx = tkHead.length ? tkHead[0].replace(/\d+$/, '') : '';
    const tkTxt = tkHead.length
      ? tkHead[0] + tkHead.slice(1).map(x =>
          '·' + (tkPfx && x.startsWith(tkPfx) ? x.slice(tkPfx.length) : x)).join('')
        + (tks.length > 3 ? '+' + (tks.length - 3) : '')
      : '';
    const tkEl = el.querySelector('.ticket');
    tkEl.hidden = !tkTxt;
    if (tkEl.textContent !== tkTxt) tkEl.textContent = tkTxt;
    if (tkEl.title !== tks.join('  ')) tkEl.title = tks.join('  ');
    setText(el, '.name', w.name);
    const meta = [w.subagents ? '⚒' + w.subagents : '',
                  w.state === 'snoozed' ? dur(w.snooze_left_s) : dur(w.waiting_s)]
                 .filter(Boolean).join(' ');
    setText(el, '.meta', meta);
    if (p.subagents !== undefined && w.subagents !== p.subagents && w.subagents > 0) {
      const m = el.querySelector('.meta');
      m.classList.remove('pop'); void m.offsetWidth; m.classList.add('pop');
    }
    el.querySelector('[data-a=snooze]').hidden = w.state === 'snoozed';
    el.querySelector('[data-a=unsnooze]').hidden = w.state !== 'snoozed';
    const allPrs = w.prs || [];
    const openPrs = allPrs.filter(p => !p.state || p.state === 'open');
    const donePrs = allPrs.filter(p => p.state && p.state !== 'open');
    const prChip = (p, full) =>
      '<span class="pr" data-url="' + esc(p.url || '') + '" title="'
      + esc((p.title ? p.title + ' — ' : '') + (p.url || 'PR')) + '">#'
      + esc(String(p.number)) + (p.state ? ' ' + esc(p.state) : '')
      + (full && p.branch ? ' ⎇ ' + esc(p.branch) : '') + '</span>';
    const dirChip = (w.base || w.branch)
      ? '<span class="c dirchip" data-p="' + esc(w.cwd || '') + '" title="'
        + esc(w.cwd || '') + ' — open in new window / reveal / copy">'
        + esc(w.base || '') + (w.branch ? ' ⎇ ' + esc(w.branch) : '') + '</span>'
      : '';
    const xp = expandedRows.has(w.target);
    // collapsed: one nowrap line — dir chip + open PRs (terminal fill to 3) + expander
    const shownPrs = openPrs.concat(donePrs.slice(-(Math.max(0, 3 - openPrs.length))));
    const hiddenN = allPrs.length - shownPrs.length;
    const arts = w.artifacts || [];
    let subHtml;
    if (!xp) {
      subHtml = [dirChip, shownPrs.map(p => prChip(p, false)).join(' ')].filter(Boolean).join(' ')
        + (arts.length ? ' <span class="c xpand" title="' + arts.length + ' artifact(s) — expand to open">🔗' + arts.length + '</span>' : '')
        + (hiddenN > 0 ? ' <span class="c xpand" title="Show all ' + allPrs.length + ' PRs, worktrees, tickets and artifacts">+' + hiddenN + ' ▾</span>' : '');
    } else {
      subHtml = [dirChip, '<span class="c xpand" title="Collapse">▴ collapse</span>'].filter(Boolean).join(' ');
    }
    if (el._sub !== subHtml) { el.querySelector('.sub').innerHTML = subHtml; el._sub = subHtml; }
    // expanded: wrapped block — every PR (worktree chip when checked out) + ticket chips
    let subxHtml = '';
    if (xp) {
      const bits = [];
      for (const p of allPrs) {
        bits.push(prChip(p, true));
        if (p.worktree) {
          bits.push('<span class="c dirchip" data-p="' + esc(p.worktree) + '" title="'
            + esc(p.worktree) + ' — open in new window / reveal / copy">📁 '
            + esc((p.branch || '').slice(0, 34) || 'worktree') + '</span>');
        }
      }
      for (const tk of (w.tickets || [])) {
        bits.push('<span class="c tkchip" data-k="' + esc(tk) + '" title="Open ' + esc(tk) + ' in Jira">' + esc(tk) + '</span>');
      }
      for (const a of arts) {
        const nameA = a.label || (a.path ? a.path.split('/').pop() : '') || (a.url ? a.url.split('/').pop().slice(0, 8) : 'artifact');
        bits.push('<span class="c artchip" data-u="' + esc(a.url || '') + '" data-p="' + esc(a.path || '')
          + '" title="' + esc([a.url, a.path].filter(Boolean).join('\\n')) + '">🔗 ' + esc(nameA.slice(0, 34)) + '</span>');
      }
      subxHtml = bits.join('');
    }
    const subxEl = el.querySelector('.subx');
    subxEl.hidden = !xp;
    if (el._subx !== subxHtml) { subxEl.innerHTML = subxHtml; el._subx = subxHtml; }
    const tipLines = [w.target + (w.sid ? '  ' + w.sid.slice(0, 8) : ''),
                      w.cwd + (w.branch ? '  ⎇ ' + w.branch : '')];
    const tipPrs = openPrs.concat(donePrs.slice(-(Math.max(0, 8 - openPrs.length))));
    for (const p of tipPrs) {
      if (p.url) tipLines.push('#' + p.number + (p.state ? ' ' + p.state : '') + '  ' + p.url);
    }
    if (allPrs.length > tipPrs.length) tipLines.push('… +' + (allPrs.length - tipPrs.length) + ' more PRs');
    tipLines.push('', w.last_text || '');
    const tip = tipLines.join('\\n');
    if (el._tip !== tip) { el.title = tip; el._tip = tip; }
    el._w = { state: w.state, subagents: w.subagents };
  }

  window.addEventListener('message', ev => {
    if (ev.data.type !== 'state') return;
    lastState = ev.data.state;
    render(lastState);
  });

  function render(st) {
    const list = document.getElementById('list'), err = document.getElementById('err');
    if (!st.ok) {
      list.textContent = ''; rowEls.clear(); err.hidden = false;
      err.innerHTML = '<div>' + esc(st.error || 'wheel offline') + '</div><button id="startBtn" title="Create a terminal running hamster start">Start / attach the wheel</button>';
      document.getElementById('startBtn').onclick = () => send('attach');
      document.getElementById('counts').textContent = 'wheel offline';
      return;
    }
    err.hidden = true;
    const c = st.counts || {};
    document.getElementById('counts').textContent =
      (st.windows||[]).length + ' sess · ' + (c.attention ? c.attention + ' need-you · ' : '') +
      (c.unseen ? c.unseen + ' unread · ' : '') +
      (c.ready||0) + ' ready · ' + (c.working||0) + ' working · ' + (c.snoozed||0) + ' snoozed';
    const hide = document.getElementById('hideChip');
    hide.textContent = st.hidesnooze ? '💤 hidden' : '💤 shown';
    hide.title = st.hidesnooze
      ? 'Snoozed sessions hidden (here and in the tmux tab bar, F8) — click to show'
      : 'Snoozed sessions shown — click to hide them (here and in the tmux tab bar, F8)';
    hide.classList.toggle('on', !!st.hidesnooze);
    const lensS = document.getElementById('lensState'), lensR = document.getElementById('lensRecent');
    lensS.classList.toggle('on', prefs.lens === 'state');
    lensR.classList.toggle('on', prefs.lens === 'recent');
    lensS.title = prefs.lens === 'state'
      ? 'Lens on: needs-you → working → ready → snoozed (a–z within groups) — click to return to the a–z shelf'
      : 'Lens: group by state, needs-you first (a–z within groups)';
    lensR.title = prefs.lens === 'recent'
      ? 'Lens on: most recent activity first — click to return to the a–z shelf'
      : 'Lens: most recent activity first';

    let rows = (st.windows || []).filter(w => !(st.hidesnooze && w.state === 'snoozed' && !w.active));
    if (filt) {
      rows = rows.filter(w =>
        (w.name + ' ' + (w.tickets || []).join(' ') + ' ' + (w.branch || '') + ' ' + (w.base || ''))
          .toLowerCase().includes(filt));
    }
    const alpha = (a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    const byRecent = (a, b) => (b.last_mtime || 0) - (a.last_mtime || 0);
    rows = rows.slice().sort(alpha);   // the shelf: stable home positions
    if (prefs.lens === 'recent') rows.sort(byRecent);
    else if (prefs.lens === 'state') {
      const rank = { attention: 0, working: 1, ready: 2, shell: 3, snoozed: 4 };
      rows.sort((a, b) => (rank[a.state] - rank[b.state]) || alpha(a, b));
    } else {
      rows.sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0));   // stable: a–z kept within groups
    }

    const seen = new Set();
    rows.forEach((w, i) => {
      seen.add(w.target);
      let el = rowEls.get(w.target);
      if (!el) { el = makeRow(w.target); rowEls.set(w.target, el); }
      updateRow(el, w);
      const cur = list.children[i];
      if (cur !== el) list.insertBefore(el, cur || null);   // minimal moves — untouched rows keep animation phase
    });
    for (const [t, el] of rowEls) {
      if (!seen.has(t)) { el.remove(); rowEls.delete(t); }
    }
  }

  document.getElementById('list').addEventListener('click', e => {
    const chip = e.target.closest('.pr, .dirchip, .tkchip, .artchip, .xpand');
    if (chip) {
      e.stopPropagation();
      if (chip.classList.contains('pr')) vs.postMessage({ cmd: 'openpr', url: chip.dataset.url });
      else if (chip.classList.contains('dirchip')) vs.postMessage({ cmd: 'opendir', path: chip.dataset.p });
      else if (chip.classList.contains('tkchip')) vs.postMessage({ cmd: 'openticket', key: chip.dataset.k });
      else if (chip.classList.contains('artchip')) vs.postMessage({ cmd: 'openartifact', url: chip.dataset.u, path: chip.dataset.p });
      else {
        const row = chip.closest('.row');
        if (row) {
          const t = row.dataset.t;
          expandedRows.has(t) ? expandedRows.delete(t) : expandedRows.add(t);
          if (lastState) render(lastState);
        }
      }
      return;
    }
    const row = e.target.closest('.row'); if (!row) return;
    const b = e.target.closest('button');
    if (b) { e.stopPropagation(); send(b.dataset.a, row.dataset.t, row.dataset.n); }
    else send('focus', row.dataset.t, row.dataset.n);
  });
</script></body></html>`;
}

async function cmdMenu(provider) {
  const a = await activeSession();
  const items = [
    { label: '$(search) Jump to session…  (F4)', act: '__jump' },
    { label: '$(arrow-left) Previous session', act: 'prev' },
    { label: '$(add) New session…  (F11)', act: 'new' },
    { label: '$(cloud-download) Adopt sessions…', act: 'adopt' },
    a && { label: '$(link) Add artifact to active… (link or file)', act: 'addartifact' },
    a && { label: '$(pinned) Pin / unpin active', act: 'pin' },
    a && { label: '$(bell-slash) Snooze active…  (F3)', act: 'snooze' },
    a && { label: '$(bell) Unsnooze active', act: 'unsnooze' },
    a && { label: '$(edit) Rename (pin name) active…  (F6)', act: 'rename' },
    a && { label: '$(sparkle) AI-name active', act: 'ainame' },
    a && { label: '$(debug-restart) Restart claude — active session', act: 'restart' },
    { label: '$(debug-restart) Restart claude — ALL sessions…', act: 'restartAll' },
    { label: '$(eye-closed) Toggle hide-snoozed  (F8)', act: 'hidesnooze' },
    a && { label: '$(close) Close active session…', act: 'close' },
    { label: '$(terminal) Open hamster tab  (ctrl+alt+h)', act: 'attach' },
  ].filter(Boolean);
  const p = await vscode.window.showQuickPick(items, {
    placeHolder: a ? 'Hamster — active: ' + a.n : 'Hamster',
    matchOnDescription: true,
  });
  if (!p) return;
  if (p.act === '__jump') return cmdJump();
  await provider.onMessage({ cmd: p.act, target: a && a.t, name: a && a.n });
}

function activate(context) {
  const provider = new WheelProvider();
  const notes = new NotesProvider();
  provider.notes = notes;
  setupDone = ensureSetup(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('hamster.installCli', installCli));
  const onActive = (cmd) => async () => {
    const a = await activeSession();
    if (!a) { vscode.window.showWarningMessage('Hamster: no active session'); return; }
    await provider.onMessage({ cmd, target: a.t, name: a.n });
  };
  const step = (dir) => async () => {
    await hamster(['step', dir], { HAMSTER_TARGET: 'x' });
    wheelTerminal(true);
    provider.tick();
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('hamsterWheel', provider),
    vscode.window.registerWebviewViewProvider('hamsterNotes', notes, {
      webviewOptions: { retainContextWhenHidden: true },   // keep unsaved text alive while collapsed
    }),
    vscode.commands.registerCommand('hamster.refresh', () => provider.tick()),
    vscode.commands.registerCommand('hamster.attach', () => wheelTerminal(true)),
    vscode.commands.registerCommand('hamster.prev', () => cmdPrev().then(() => provider.tick())),
    vscode.commands.registerCommand('hamster.jump', () => cmdJump().then(() => provider.tick())),
    vscode.commands.registerCommand('hamster.menu', () => cmdMenu(provider)),
    vscode.commands.registerCommand('hamster.new', () => provider.onMessage({ cmd: 'new' })),
    vscode.commands.registerCommand('hamster.adopt', () => provider.onMessage({ cmd: 'adopt' })),
    vscode.commands.registerCommand('hamster.snoozeActive', onActive('snooze')),
    vscode.commands.registerCommand('hamster.renameActive', onActive('rename')),
    vscode.commands.registerCommand('hamster.hidesnooze', () => provider.onMessage({ cmd: 'hidesnooze' })),
    vscode.commands.registerCommand('hamster.stepPrev', step('prev')),
    vscode.commands.registerCommand('hamster.stepNext', step('next')),
  );
}
function deactivate() {}
module.exports = { activate, deactivate };
