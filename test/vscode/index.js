"use strict";

// In-editor test, loaded by VS Code through --extensionTestsPath. Expects the workspace built
// by test/run-vscode.js and its JSON config in EC_TEST_CONFIG.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { snapshot } = require("../fixtures");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : detail });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) { /* retry */ }
    await sleep(250);
  }
  throw new Error("timeout waiting for " + label);
}
const labelOf = (t) => (typeof t.label === "string" ? t.label : t.label && t.label.label);

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.EC_TEST_CONFIG, "utf8"));
  const { mode, mainRoot, hostileRoot, outsideDir, markerDir, resultFile, shotDir } = cfg;
  const trusted = mode === "trusted";
  const M = (rel) => path.join(mainRoot, rel);
  const outsideBefore = snapshot(outsideDir);

  try {
    check(`${mode}: workspace trust state`, vscode.workspace.isTrusted === trusted);
    const ext = vscode.extensions.getExtension("jaytankdev.entrycheck");
    check(`${mode}: extension found`, !!ext);
    const api = ext.isActive ? ext.exports : await ext.activate();
    check(`${mode}: activate() returns the test API`, api && typeof api.getTreeItems === "function");

    // Main repo: 11 findings when trusted (10 without EC004); hostile repo: inside.sh EC001 + EC005.
    const expected = trusted ? 13 : 12;
    await waitFor(() => api.getFindings().length === expected, 60000, "findings").catch(() => {});
    let F = api.getFindings();
    check(`${mode}: ${expected} findings`, F.length === expected, F.map((f) => f.code + " " + f.launcherRel + " " + f.scriptRel).join("; "));
    check(`${mode}: EC004 only when trusted`, F.some((f) => f.code === "EC004") === trusted);
    check(`${mode}: compose absolute entrypoint resolved through the Dockerfile`, F.some((f) => f.code === "EC002" && f.launcherRel === "compose.yaml" && f.scriptRel === "deploy/start.sh" && f.line === 5));
    check(`${mode}: hostile repo only reports its inside script`, F.filter((f) => f.file.startsWith(hostileRoot)).every((f) => f.script === path.join(hostileRoot, "inside.sh")));
    check(`${mode}: nothing references the outside dir`, !F.some((f) => (f.script + f.message).includes(outsideDir)));

    // Contribution: container, icon, view.
    const pkg = ext.packageJSON;
    const ac = (pkg.contributes.viewsContainers || {}).activitybar || [];
    check(`${mode}: activity bar container contributed`, ac.some((c) => c.id === "entrycheck" && c.title === "EntryCheck" && c.icon === "media/activity.svg"));
    check(`${mode}: activity bar icon file exists`, fs.existsSync(path.join(ext.extensionPath, "media", "activity.svg")));
    check(`${mode}: view entrycheck.scripts is in the container`, (pkg.contributes.views.entrycheck || []).some((v) => v.id === "entrycheck.scripts"));
    check(`${mode}: onView activation event`, pkg.activationEvents.includes("onView:entrycheck.scripts"));
    let opened = true;
    try {
      await vscode.commands.executeCommand("workbench.view.extension.entrycheck");
    } catch (e) {
      opened = String(e);
    }
    check(`${mode}: workbench.view.extension.entrycheck opens`, opened === true, opened);
    await sleep(1000);

    // Rows: launcher groups -> findings labelled with the exact script.
    const top = await api.getTreeItems();
    const groupLabels = top.map(labelOf);
    const wantGroups = ["hostile/.gitlab-ci.yml", "main/.github/workflows/ci.yml", "main/.gitlab-ci.yml", "main/.husky/pre-commit", "main/compose.yaml", "main/deploy/api.Dockerfile", "main/Dockerfile", "main/package.json"];
    check(`${mode}: one group row per launching file`, JSON.stringify(groupLabels.slice().sort()) === JSON.stringify(wantGroups.slice().sort()), JSON.stringify(groupLabels));
    check(`${mode}: group rows say what kind of launcher it is and the tooltip counts the problems`, top.every((t) => /^(Dockerfile|docker-compose|GitHub Actions|GitLab CI|package\.json scripts|git hook)$/.test(t.description) && /launching \d+ failing script/.test(t.tooltip)), JSON.stringify(top.map((t) => t.description)));
    const df = top.find((t) => labelOf(t) === "main/Dockerfile");
    const dfRows = await api.getTreeItems(df.node);
    const dfLabels = dfRows.map(labelOf);
    const wantDf = trusted ? ["EC003  scripts/build.sh", "EC001  docker/entrypoint.sh", "EC004  scripts/run.sh"] : ["EC003  scripts/build.sh", "EC001  docker/entrypoint.sh"];
    check(`${mode}: Dockerfile rows name the exact script`, JSON.stringify(dfLabels) === JSON.stringify(wantDf), JSON.stringify(dfLabels));
    let allRows = [];
    for (const g of top) allRows = allRows.concat(await api.getTreeItems(g.node));
    check(`${mode}: finding rows equal finding count`, allRows.length === F.length, allRows.length + " vs " + F.length);
    check(`${mode}: rows differ without hovering`, new Set(allRows.map((r) => labelOf(r) + "|" + r.description)).size === allRows.length);
    check(`${mode}: rows have icon, description, tooltip with file:line and the open command`, allRows.every((r) => r.iconPath && r.description && /:\d+/.test(r.tooltip) && r.command && r.command.command === "entrycheck.openFinding"), JSON.stringify(allRows.find((r) => !(r.iconPath && r.description && /:\d+/.test(r.tooltip)))));
    check(`${mode}: EC005 row is labelled .gitattributes`, allRows.some((r) => labelOf(r) === "EC005  .gitattributes"));
    check(`${mode}: badge equals finding count`, api.getBadge() === F.length && F.length > 0, `badge=${api.getBadge()} findings=${F.length}`);
    check(`${mode}: diagnostics still published on the launching line`, vscode.languages.getDiagnostics(vscode.Uri.file(M("Dockerfile"))).filter((d) => d.source === "EntryCheck").length === wantDf.length);
    if (!trusted) check("untrusted: view message explains Restricted Mode", /Restricted Mode/.test(api.getMessage() || ""), api.getMessage());
    else check("trusted: no view message", !api.getMessage(), api.getMessage());

    // Screenshot with findings present (trusted run only).
    if (trusted) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("workbench.view.extension.entrycheck");
      await sleep(6000);
      fs.writeFileSync(path.join(shotDir, "shot-trusted"), "1");
      await waitFor(() => fs.existsSync(path.join(shotDir, "shot-done-trusted")), 20000, "screenshot").catch(() => {});
      check("trusted: screenshot taken", fs.existsSync(path.join(shotDir, "shot-done-trusted")));
    }

    // Open command: right file and line.
    const entryRow = dfRows.find((r) => labelOf(r) === "EC001  docker/entrypoint.sh");
    const res = await vscode.commands.executeCommand("entrycheck.openFinding", ...entryRow.command.arguments);
    let ed = vscode.window.activeTextEditor;
    check(`${mode}: openFinding opens the Dockerfile`, res && res.status === "opened" && ed && ed.document.uri.fsPath === M("Dockerfile"), JSON.stringify(res));
    check(`${mode}: openFinding selects the ENTRYPOINT line`, ed && ed.document.lineAt(ed.selection.active.line).text.startsWith("ENTRYPOINT"), ed && String(ed.selection.active.line));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const os1 = await vscode.commands.executeCommand("entrycheck.openScript", entryRow.node);
    ed = vscode.window.activeTextEditor;
    check(`${mode}: openScript opens the script`, os1 && os1.status === "opened" && ed && ed.document.uri.fsPath === M("docker/entrypoint.sh"));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Forged / outside arguments are refused.
    const refused = async (cmd, arg) => {
      const r = await vscode.commands.executeCommand(cmd, arg);
      return r && r.status === "refused";
    };
    check(`${mode}: openFinding refuses a forged id`, await refused("entrycheck.openFinding", { id: "nope", file: path.join(outsideDir, "secret.sh"), line: 0 }));
    check(`${mode}: openFinding refuses a path`, await refused("entrycheck.openFinding", path.join(outsideDir, "secret.sh")));
    check(`${mode}: openScript refuses a Uri`, await refused("entrycheck.openScript", vscode.Uri.file(M("Dockerfile"))));
    check(`${mode}: fixCrlf refuses an outside file`, await refused("entrycheck.fixCrlf", path.join(outsideDir, "secret.sh")));
    check(`${mode}: fixCrlf refuses a symlink that leads outside`, await refused("entrycheck.fixCrlf", path.join(hostileRoot, "link.sh")));
    check(`${mode}: stripBom refuses an outside file`, await refused("entrycheck.stripBom", vscode.Uri.file(path.join(outsideDir, "bom.sh"))));
    check(`${mode}: fixCrlf refuses an inside file that is not a live EC001 script`, await refused("entrycheck.fixCrlf", M("ci/artifact.sh")));
    check(`${mode}: fixCrlf refuses no argument`, await refused("entrycheck.fixCrlf", undefined));
    check(`${mode}: no editor opened for refused arguments`, !vscode.window.activeTextEditor);

    // Code actions on the launching line.
    const ciUri = vscode.Uri.file(M(".github/workflows/ci.yml"));
    const ciDoc = await vscode.workspace.openTextDocument(ciUri);
    const acts = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", ciUri, new vscode.Range(13, 10, 13, 18));
    const titles = (acts || []).map((a) => a.title);
    check(`${mode}: Quick Fixes offered on the run: line`, titles.includes("EntryCheck: Convert lint.sh to LF line endings") && titles.includes("EntryCheck: Add `*.sh text eol=lf` to .gitattributes"), JSON.stringify(titles));
    void ciDoc;

    // Inline actions from tree rows.
    const scansBefore = api.getState().scanCount;
    const fx = await vscode.commands.executeCommand("entrycheck.fixCrlf", entryRow.node);
    check(`${mode}: fixCrlf from a tree row converts the script to LF`, fx && fx.status === "fixed" && !fs.readFileSync(M("docker/entrypoint.sh"), "utf8").includes("\r"), JSON.stringify(fx));
    check(`${mode}: fixCrlf rescans and the row disappears`, api.getState().scanCount > scansBefore && !api.getFindings().some((f) => f.scriptRel === "docker/entrypoint.sh" && f.code === "EC001"));
    const bomRow = (await api.getTreeItems((await api.getTreeItems()).find((t) => labelOf(t) === "main/package.json").node)).find((r) => labelOf(r) === "EC003  scripts/release.sh");
    const sb = await vscode.commands.executeCommand("entrycheck.stripBom", bomRow && bomRow.node);
    check(`${mode}: stripBom from a tree row strips the BOM`, sb && sb.status === "fixed" && fs.readFileSync(M("scripts/release.sh"))[0] === 0x23, JSON.stringify(sb));
    // Code-action route (script path string) still works.
    const lf = await vscode.commands.executeCommand("entrycheck.fixCrlf", M("tools/lint.sh"));
    check(`${mode}: fixCrlf via the Quick Fix path argument`, lf && lf.status === "fixed" && !fs.readFileSync(M("tools/lint.sh"), "utf8").includes("\r"));
    // .gitattributes: added in main, refused in hostile (symlink to outside).
    const mainEc5 = api.getFindings().find((f) => f.code === "EC005" && f.file.startsWith(mainRoot));
    const hostEc5 = api.getFindings().find((f) => f.code === "EC005" && f.file.startsWith(hostileRoot));
    const ga = await vscode.commands.executeCommand("entrycheck.addGitattributes", { id: mainEc5 && mainEc5.id });
    check(`${mode}: addGitattributes writes the rule`, ga && ga.status === "added" && /\*\.sh text eol=lf/.test(fs.readFileSync(M(".gitattributes"), "utf8")), JSON.stringify(ga));
    check(`${mode}: EC005 gone for main after the rule`, !api.getFindings().some((f) => f.code === "EC005" && f.file.startsWith(mainRoot)));
    const gh = await vscode.commands.executeCommand("entrycheck.addGitattributes", { id: hostEc5 && hostEc5.id });
    check(`${mode}: addGitattributes refuses the hostile symlinked .gitattributes`, gh && gh.status === "refused", JSON.stringify(gh));
    check(`${mode}: badge follows the fixes`, api.getBadge() === api.getFindings().length);

    // Polling fallback: an external change (no watcher event needed) is picked up.
    fs.writeFileSync(M("scripts/ok.sh"), "#!/bin/sh\r\necho now crlf\r\n");
    const polled = api.pollOnce();
    await waitFor(() => api.getFindings().some((f) => f.scriptRel === "scripts/ok.sh" && f.code === "EC001"), 15000, "poll").then(
      () => check(`${mode}: poll picks up an external edit`, polled === true),
      (e) => check(`${mode}: poll picks up an external edit`, false, String(e))
    );
    // Save path: saving a launcher rescans.
    const n0 = api.getState().scanCount;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(M("Dockerfile")));
    const edd = await vscode.window.showTextDocument(doc);
    await edd.edit((eb) => eb.insert(new vscode.Position(doc.lineCount - 1, 0), "RUN ./scripts/ok.sh\n"));
    await doc.save();
    await waitFor(() => api.getState().scanCount > n0, 15000, "save rescan").then(
      () => check(`${mode}: saving a launcher rescans`, true),
      (e) => check(`${mode}: saving a launcher rescans`, false, String(e))
    );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    // Commands registered.
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["entrycheck.rescan", "entrycheck.fixCrlf", "entrycheck.stripBom", "entrycheck.addGitattributes", "entrycheck.openFinding", "entrycheck.openScript"]) check(`${mode}: command ${c} registered`, cmds.includes(c));
    await vscode.commands.executeCommand("entrycheck.rescan");
    F = api.getFindings();
    check(`${mode}: rescan keeps a consistent badge`, api.getBadge() === F.length);

    // Disabled: view empty, badge cleared; re-enabled: back.
    const conf = vscode.workspace.getConfiguration("entrycheck");
    await conf.update("enabled", false, vscode.ConfigurationTarget.Global);
    await waitFor(async () => api.getBadge() === 0 && (await api.getTreeItems()).length === 0 && api.getFindings().length === 0, 15000, "disabled").then(
      () => check(`${mode}: enabled=false empties the view and clears the badge`, true),
      (e) => check(`${mode}: enabled=false empties the view and clears the badge`, false, String(e))
    );
    check(`${mode}: enabled=false clears diagnostics`, vscode.languages.getDiagnostics(vscode.Uri.file(M("Dockerfile"))).filter((d) => d.source === "EntryCheck").length === 0);
    await conf.update("enabled", undefined, vscode.ConfigurationTarget.Global);
    await waitFor(() => api.getBadge() === F.length, 15000, "re-enabled").then(
      () => check(`${mode}: re-enabled restores the badge`, true),
      (e) => check(`${mode}: re-enabled restores the badge`, false, String(e))
    );

    // Security: nothing outside changed, no fsmonitor / planted git ran.
    await api.whenIdle();
    check(`${mode}: nothing outside the workspace changed`, snapshot(outsideDir) === outsideBefore);
    check(`${mode}: repo-local fsmonitor never ran`, !fs.existsSync(cfg.marker));
    check(`${mode}: planted git never ran`, !fs.existsSync(path.join(markerDir, "planted-git-ran")));
  } catch (e) {
    check("unexpected exception", false, String(e && e.stack ? e.stack : e));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  fs.writeFileSync(resultFile, JSON.stringify({ passed, failed, results }, null, 2));
  if (failed) throw new Error(`${failed} in-editor checks failed`);
}

module.exports = { run };
