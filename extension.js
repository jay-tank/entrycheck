"use strict";

/**
 * EntryCheck - finds scripts that Docker, docker-compose, CI and git hooks will execute and
 * flags the things that make them fail at runtime with "exec format error",
 * "no such file or directory" or "permission denied":
 *
 *   EC001 CRLF line endings            (Error, Quick Fix: convert to LF / add .gitattributes)
 *   EC002 missing or invalid shebang   (Error, only for directly-executed scripts)
 *   EC003 UTF-8 BOM before the shebang (Error, Quick Fix: strip BOM)
 *   EC004 not executable in git index  (Warning, needs Workspace Trust - reads git)
 *   EC005 no .gitattributes eol rule   (Information)
 *
 * Diagnostics are placed on the referencing line (Dockerfile, compose file, CI workflow,
 * package.json) with relatedInformation pointing at the script itself. The activity bar view
 * "Failing scripts" groups the same findings by the launching file.
 *
 * Zero network, zero telemetry. Files are read with `fs` and only when they resolve (after
 * symlinks) inside a workspace folder. The only process spawned is `git ls-files -s` via
 * execFile (no shell, hardened env, fsmonitor and hooks off), and only when the workspace is
 * trusted.
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("./core");

const SOURCE = "EntryCheck";
const SECTION = "entrycheck";
const VIEW_ID = "entrycheck.scripts";
const POLL_MS = 10000;

let collection;
let timer;
let pollTimer;
let treeView;
const treeEmitter = new vscode.EventEmitter();

/** Current findings (each gets an `id`) and lookup tables. */
let findings = [];
let byId = new Map();
let groups = [];
let state = { scanned: false, launchers: 0, truncated: false, trusted: true };
/** Map<path, signature> of launchers + scripts + .gitattributes + .git/index for polling. */
let watched = new Map();
let scanning = null;
let again = false;
let scanCount = 0;

function enabled() {
  return vscode.workspace.getConfiguration(SECTION).get("enabled", true) !== false;
}

function fileFolders() {
  return (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === "file");
}

function signature(p) {
  try {
    const st = fs.statSync(p);
    return st.mtimeMs + ":" + st.size + ":" + st.mode;
  } catch (_e) {
    return "missing";
  }
}

// ---------------------------------------------------------------- scan

async function doScan() {
  const next = [];
  const nextWatched = new Map();
  let launchers = 0;
  let truncated = false;
  const trusted = vscode.workspace.isTrusted;
  if (enabled()) {
    for (const f of fileFolders()) {
      let res;
      try {
        res = await core.scanFolderDetailed(f.uri.fsPath, { trusted });
      } catch (_e) {
        continue;
      }
      launchers += res.launchers.length;
      truncated = truncated || res.truncated;
      for (const p of res.watched) nextWatched.set(p, signature(p));
      for (const fd of res.findings) next.push(Object.assign({ folder: f.uri.fsPath, id: f.uri.fsPath + "|" + fd.key }, fd));
    }
  }
  findings = next;
  byId = new Map(findings.map((x) => [x.id, x]));
  watched = nextWatched;
  state = { scanned: true, launchers, truncated, trusted };
  scanCount++;
  render();
}

function rescan() {
  if (scanning) {
    again = true;
    return scanning;
  }
  scanning = (async () => {
    try {
      do {
        again = false;
        await doScan();
      } while (again);
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

function schedule(delay) {
  clearTimeout(timer);
  timer = setTimeout(() => rescan().catch(() => {}), delay === undefined ? 700 : delay);
}

/** Polling fallback for when file watcher events do not arrive (e.g. exhausted inotify). */
function pollOnce() {
  if (!enabled() || scanning || !state.scanned) return false;
  for (const [p, sig] of watched) {
    if (signature(p) !== sig) {
      schedule(0);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- diagnostics

function render() {
  if (!collection) return;
  const per = new Map();
  for (const fd of findings) {
    const d = new vscode.Diagnostic(new vscode.Range(fd.line, fd.col, fd.line, fd.col + fd.len), fd.message, vscode.DiagnosticSeverity[fd.severity]);
    d.source = SOURCE;
    d.code = fd.code;
    d.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(fd.script), new vscode.Range(0, 0, 0, 0)), "script")];
    if (!per.has(fd.file)) per.set(fd.file, []);
    per.get(fd.file).push(d);
  }
  collection.clear();
  for (const [file, diags] of per) collection.set(vscode.Uri.file(file), diags);
  buildGroups();
  refreshTree();
}

// ---------------------------------------------------------------- activity bar view

const ICONS = { Error: ["error", "list.errorForeground"], Warning: ["warning", "list.warningForeground"], Information: ["info", "notificationsInfoIcon.foreground"] };

function relOf(fsPath) {
  return vscode.workspace.asRelativePath(vscode.Uri.file(fsPath), fileFolders().length > 1);
}

function buildGroups() {
  const map = new Map();
  for (const fd of findings) {
    if (!map.has(fd.file)) map.set(fd.file, { type: "group", file: fd.file, kind: fd.kind, rel: relOf(fd.file), items: [] });
    map.get(fd.file).items.push(fd);
  }
  groups = Array.from(map.values()).sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Row data for a node (also used by the test API). */
function rowFor(node) {
  if (node.type === "group") {
    const n = node.items.length;
    const worst = node.items.some((x) => x.severity === "Error") ? "Error" : node.items.some((x) => x.severity === "Warning") ? "Warning" : "Information";
    return {
      label: node.rel,
      description: core.KIND_LABEL[node.kind],
      tooltip: node.rel + "\n" + core.KIND_LABEL[node.kind] + " launching " + n + " failing script" + (n === 1 ? "" : "s"),
      contextValue: "launcher",
      worst,
    };
  }
  const fd = node;
  const what = fd.code === "EC005" ? ".gitattributes" : fd.scriptRel;
  const where = relOf(fd.file) + ":" + (fd.line + 1);
  return {
    label: fd.code + "  " + what,
    description: core.RULES[fd.code].title + " - line " + (fd.line + 1),
    tooltip: fd.code + " " + fd.message + "\n\n" + where + (fd.containerPath ? "\nContainer path: " + fd.containerPath : "") + (fd.code === "EC005" ? "" : "\nScript: " + fd.scriptRel),
    contextValue: "finding." + fd.code,
  };
}

const provider = {
  onDidChangeTreeData: treeEmitter.event,
  getChildren(el) {
    if (!enabled()) return [];
    if (!el) return groups;
    return el.type === "group" ? el.items : [];
  },
  getParent(el) {
    if (el.type === "group") return undefined;
    return groups.find((g) => g.file === el.file);
  },
  getTreeItem(node) {
    const row = rowFor(node);
    if (node.type === "group") {
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = "g|" + node.file;
      item.description = row.description;
      item.tooltip = row.tooltip;
      item.contextValue = row.contextValue;
      item.resourceUri = vscode.Uri.file(node.file);
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    const [icon, color] = ICONS[node.severity] || ICONS.Information;
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.command = { command: "entrycheck.openFinding", title: "Open launching line", arguments: [{ id: node.id }] };
    return item;
  },
};

function refreshTree() {
  treeEmitter.fire(undefined);
  vscode.commands.executeCommand("setContext", "entrycheck.scanned", state.scanned);
  vscode.commands.executeCommand("setContext", "entrycheck.hasLaunchers", state.launchers > 0);
  if (!treeView) return;
  const n = enabled() ? findings.length : 0;
  treeView.badge = n ? { value: n, tooltip: n + " failing script problem" + (n === 1 ? "" : "s") } : undefined;
  const msgs = [];
  if (enabled() && n && !state.trusted) msgs.push("Restricted Mode: the executable-bit check (EC004) runs once you trust this workspace.");
  if (enabled() && state.truncated) msgs.push("Large workspace: only part of it was scanned.");
  treeView.message = msgs.length ? msgs.join(" ") : undefined;
}

// ---------------------------------------------------------------- command argument validation

/** A live finding from a tree node / {id} / id string. Anything else is refused. */
function liveFinding(arg) {
  const id = typeof arg === "string" ? arg : arg && typeof arg === "object" && typeof arg.id === "string" ? arg.id : null;
  const fd = id ? byId.get(id) : undefined;
  if (!fd) return undefined;
  // Re-check confinement now: the file system may have changed since the scan.
  if (!core.confined(fd.folder, fd.file) || !core.confined(fd.folder, fd.script)) return undefined;
  return fd;
}

/**
 * Resolve a quick-fix argument to the live finding it fixes. Accepts a tree node / {id}, or a
 * script path / Uri (from a code action); the script must be the script of a live finding
 * with one of `codes`, and must resolve inside its workspace folder.
 */
function findingForFix(arg, codes) {
  let fd = liveFinding(arg);
  if (fd) return codes.includes(fd.code) ? fd : undefined;
  let p = null;
  if (typeof arg === "string") p = arg;
  else if (arg instanceof vscode.Uri && arg.scheme === "file") p = arg.fsPath;
  if (!p || !path.isAbsolute(p)) return undefined;
  let real;
  try {
    real = fs.realpathSync(p);
  } catch (_e) {
    return undefined;
  }
  fd = findings.find((x) => codes.includes(x.code) && x.script === real);
  if (!fd || !core.confined(fd.folder, fd.script)) return undefined;
  return fd;
}

async function openAt(fsPath, line, col) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
  const l = Math.max(0, Math.min(line, doc.lineCount - 1));
  const pos = new vscode.Position(l, Math.max(0, col || 0));
  const ed = await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  return ed;
}

/** Open the launching file (Dockerfile, workflow...) at the line that runs the script. */
async function openFinding(arg) {
  const fd = liveFinding(arg);
  if (!fd) return { status: "refused" };
  await openAt(fd.file, fd.line, fd.col);
  return { status: "opened", path: fd.file, line: fd.line };
}

/** Open the script itself. */
async function openScript(arg) {
  const fd = liveFinding(arg);
  if (!fd) return { status: "refused" };
  await openAt(fd.script, 0, 0);
  return { status: "opened", path: fd.script };
}

function dirtyDoc(fsPath) {
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.isDirty && (d.uri.fsPath === fsPath || safeReal(d.uri.fsPath) === fsPath));
}

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch (_e) {
    return null;
  }
}

async function rewriteScript(fd, transform, what) {
  const real = core.confined(fd.folder, fd.script);
  if (!real) return { status: "refused" };
  if (dirtyDoc(real)) {
    vscode.window.showWarningMessage("EntryCheck: " + fd.scriptRel + " has unsaved changes. Save or revert it first, then " + what + ".");
    return { status: "dirty" };
  }
  let buf;
  try {
    buf = fs.readFileSync(real);
  } catch (e) {
    vscode.window.showErrorMessage("EntryCheck: could not read " + fd.scriptRel + ": " + e.message);
    return { status: "error" };
  }
  const out = transform(buf);
  if (!out.equals(buf)) {
    try {
      fs.writeFileSync(real, out);
    } catch (e) {
      vscode.window.showErrorMessage("EntryCheck: could not write " + fd.scriptRel + ": " + e.message);
      return { status: "error" };
    }
  }
  await rescan();
  return { status: "fixed", path: real };
}

async function fixCrlf(arg) {
  const fd = findingForFix(arg, ["EC001"]);
  if (!fd) return { status: "refused" };
  return rewriteScript(fd, core.crlfToLf, "convert it to LF");
}

async function stripBom(arg) {
  const fd = findingForFix(arg, ["EC003"]);
  if (!fd) return { status: "refused" };
  return rewriteScript(fd, core.stripBomBytes, "strip the BOM");
}

async function addGitattributes(arg) {
  const fd = findingForFix(arg, ["EC001", "EC005"]);
  if (!fd) return { status: "refused" };
  const ga = path.join(fd.folder, ".gitattributes");
  if (dirtyDoc(ga) || dirtyDoc(safeReal(ga) || ga)) {
    vscode.window.showWarningMessage("EntryCheck: .gitattributes has unsaved changes. Save or revert it first.");
    return { status: "dirty" };
  }
  let r;
  try {
    r = core.appendGitattributes(fd.folder);
  } catch (e) {
    vscode.window.showErrorMessage("EntryCheck: could not update .gitattributes: " + e.message);
    return { status: "error" };
  }
  if (r === "refused") {
    vscode.window.showWarningMessage("EntryCheck: .gitattributes is a symlink or points outside the workspace, so it was not changed. Add `*.sh text eol=lf` to it by hand.");
    return { status: "refused" };
  }
  await rescan();
  return { status: r, path: ga };
}

// ---------------------------------------------------------------- quick fixes in the editor

class FixProvider {
  provideCodeActions(_doc, _range, context) {
    const actions = [];
    for (const d of context.diagnostics) {
      if (d.source !== SOURCE || !d.relatedInformation || !d.relatedInformation[0]) continue;
      const script = d.relatedInformation[0].location.uri.fsPath;
      const mk = (title, command) => {
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.command = { title, command, arguments: [script] };
        actions.push(a);
      };
      if (d.code === "EC001") {
        mk("EntryCheck: Convert " + path.basename(script) + " to LF line endings", "entrycheck.fixCrlf");
        mk("EntryCheck: Add `*.sh text eol=lf` to .gitattributes", "entrycheck.addGitattributes");
      } else if (d.code === "EC003") {
        mk("EntryCheck: Strip UTF-8 BOM from " + path.basename(script), "entrycheck.stripBom");
      } else if (d.code === "EC005") {
        mk("EntryCheck: Add `*.sh text eol=lf` to .gitattributes", "entrycheck.addGitattributes");
      }
    }
    return actions;
  }
}

// ---------------------------------------------------------------- activation

function activate(context) {
  collection = vscode.languages.createDiagnosticCollection("entrycheck");
  treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });
  const watcherGlobs = [
    "**/{Dockerfile,Dockerfile.*,Containerfile,Containerfile.*,*.dockerfile,*.Dockerfile,*.containerfile}",
    "**/{docker-compose,compose}*.{yml,yaml}",
    "**/{.gitlab-ci.yml,*.gitlab-ci.yml,package.json,.gitattributes}",
    "**/*.{sh,bash}",
    "**/.github/workflows/*.{yml,yaml}",
    "**/.husky/*",
  ];
  for (const g of watcherGlobs) {
    const w = vscode.workspace.createFileSystemWatcher(g);
    const on = () => schedule();
    context.subscriptions.push(w, w.onDidCreate(on), w.onDidChange(on), w.onDidDelete(on));
  }
  context.subscriptions.push(
    collection,
    treeView,
    treeEmitter,
    vscode.commands.registerCommand("entrycheck.rescan", () => rescan()),
    vscode.commands.registerCommand("entrycheck.fixCrlf", (p) => fixCrlf(p)),
    vscode.commands.registerCommand("entrycheck.stripBom", (p) => stripBom(p)),
    vscode.commands.registerCommand("entrycheck.addGitattributes", (p) => addGitattributes(p)),
    vscode.commands.registerCommand("entrycheck.openFinding", (a) => openFinding(a)),
    vscode.commands.registerCommand("entrycheck.openScript", (a) => openScript(a)),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.workspace.onDidSaveTextDocument(() => schedule()),
    vscode.workspace.onDidCreateFiles(() => schedule()),
    vscode.workspace.onDidDeleteFiles(() => schedule()),
    vscode.workspace.onDidRenameFiles(() => schedule()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule(0)),
    vscode.workspace.onDidGrantWorkspaceTrust(() => schedule(0)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) schedule(0);
    }),
    treeView.onDidChangeVisibility((e) => {
      if (e.visible) schedule(0);
    }),
    { dispose: () => clearInterval(pollTimer) }
  );
  pollTimer = setInterval(pollOnce, POLL_MS);
  refreshTree();
  schedule(0);

  // Test API (also handy for other extensions); never exposes file contents.
  return {
    rescan: () => rescan(),
    getFindings: () => findings.map((f) => ({ id: f.id, code: f.code, severity: f.severity, file: f.file, line: f.line, col: f.col, script: f.script, scriptRel: f.scriptRel, launcherRel: f.launcherRel, kind: f.kind, message: f.message })),
    getTreeItems: async (node) => {
      const kids = await provider.getChildren(node);
      return kids.map((k) => Object.assign({ node: k }, provider.getTreeItem(k)));
    },
    getBadge: () => (treeView && treeView.badge ? treeView.badge.value : 0),
    getMessage: () => (treeView ? treeView.message : undefined),
    getState: () => Object.assign({ scanCount }, state),
    pollOnce: () => pollOnce(),
    whenIdle: async () => {
      while (scanning) await scanning;
    },
  };
}

function deactivate() {
  clearTimeout(timer);
  clearInterval(pollTimer);
}

module.exports = {
  activate,
  deactivate,
  scanFolder: core.scanFolder,
  checkScript: core.checkScript,
  _internal: {
    extractDockerfile: core.extractDockerfile,
    extractYamlRuns: core.extractYamlRuns,
    extractPackageJson: core.extractPackageJson,
    commandHeads: core.commandHeads,
  },
};
