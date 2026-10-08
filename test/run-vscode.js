"use strict";

// Launches a real, isolated VS Code window with EntryCheck loaded from this folder and runs
// test/vscode/index.js inside it: once trusted (full suite), once untrusted (Restricted Mode).
// The workspace has two folders: the main fixture repo and a hostile repo whose paths and
// symlinks point outside the workspace. In the trusted run the test asks for a screenshot of
// the (hidden) display with the EntryCheck view open; it is saved as
// <tmpBaseDir>/entrycheck-panel.png.
// Usage: node test/run-vscode.js [tmpBaseDir]   (always spawns `code` from PATH)

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { makeMainRepo, makeHostileRepo } = require("./fixtures");

const extDir = path.resolve(__dirname, "..");
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), "ec-vscode-")));

function buildWorkspace(tag) {
  const d = path.join(base, tag);
  const mainRoot = makeMainRepo(path.join(d, "ws", "main"));
  const outsideDir = path.join(d, "outside");
  const markerDir = path.join(d, "markers");
  const h = makeHostileRepo(path.join(d, "ws", "hostile"), outsideDir, markerDir);
  // A distinct name so the window title ("entrycheck-test (Workspace)") can be found on a
  // display shared with other test runs.
  const wsFile = path.join(d, "entrycheck-test.code-workspace");
  fs.writeFileSync(wsFile, JSON.stringify({ folders: [{ path: mainRoot }, { path: h.root }] }, null, 2));
  return { mainRoot, hostileRoot: h.root, outsideDir, markerDir, marker: h.marker, wsFile };
}

const userDir = path.join(base, "user");
const extsDir = path.join(base, "exts");
fs.mkdirSync(path.join(userDir, "User"), { recursive: true });
fs.mkdirSync(extsDir, { recursive: true });
const settingsPath = path.join(userDir, "User", "settings.json");
const resultFile = path.join(base, "results.json");
const cfgFile = path.join(base, "config.json");
const shotDir = path.join(base, "shots");
fs.mkdirSync(shotDir);
const shot = path.join(process.argv[2] ? path.resolve(process.argv[2]) : base, "entrycheck-panel.png");

function writeSettings(ws, trustEnabled) {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      "security.workspace.trust.enabled": trustEnabled,
      "security.workspace.trust.startupPrompt": "never",
      // The built-in Git extension would itself run the hostile repo's fsmonitor; keep it out
      // of that repo so any marker file can only come from EntryCheck.
      "git.ignoredRepositories": [ws.hostileRoot],
      "git.openRepositoryInParentFolders": "never",
      "git.autofetch": false,
      "git.enabled": false,
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "workbench.startupEditor": "none",
      "window.zoomLevel": 0,
    }, null, 2)
  );
}

async function launch(ws, mode, extraArgs) {
  fs.writeFileSync(cfgFile, JSON.stringify(Object.assign({ mode, resultFile, shotDir }, ws)));
  const args = [
    "--wait", "--new-window",
    "--user-data-dir", userDir,
    "--extensions-dir", extsDir,
    "--disable-extensions",
    ...extraArgs,
    "--skip-welcome", "--skip-release-notes",
    "--extensionDevelopmentPath=" + extDir,
    "--extensionTestsPath=" + path.join(__dirname, "vscode", "index.js"),
    ws.wsFile,
  ];
  console.log("code " + args.join(" "));
  const child = spawn("code", args, { stdio: "inherit", env: Object.assign({}, process.env, { EC_TEST_CONFIG: cfgFile }) });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const killer = setTimeout(() => child.kill("SIGKILL"), 300000);
  const poll = setInterval(() => {
    const want = path.join(shotDir, "shot-" + mode);
    if (!fs.existsSync(want)) return;
    fs.unlinkSync(want);
    try {
      // Raise this run's window above any other window on the shared hidden display first.
      try {
        const ids = execFileSync("xdotool", ["search", "--name", "entrycheck-test"]).toString().trim().split(/\s+/).filter(Boolean);
        for (const id of ids) execFileSync("xdotool", ["windowraise", id]);
        execFileSync("sleep", ["1.5"]);
      } catch (_e) { /* xdotool missing: capture as is */ }
      execFileSync("import", ["-window", "root", "-display", process.env.DISPLAY || ":99", shot]);
      console.log("screenshot: " + shot);
    } catch (e) {
      console.log("screenshot failed: " + e.message);
    }
    fs.writeFileSync(path.join(shotDir, "shot-done-" + mode), "1");
  }, 300);
  const status = await exited;
  clearTimeout(killer);
  clearInterval(poll);
  console.log("code exit status:", status);
  if (!fs.existsSync(resultFile)) {
    console.log("FAIL: no results written");
    return { passed: 0, failed: 1, results: [] };
  }
  const res = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  fs.unlinkSync(resultFile);
  for (const t of res.results) console.log((t.ok ? "PASS " : "FAIL ") + t.name + (t.detail ? " :: " + t.detail : ""));
  return res;
}

(async () => {
  const ws1 = buildWorkspace("run1");
  writeSettings(ws1, false);
  const r1 = await launch(ws1, "trusted", ["--disable-workspace-trust"]);

  const ws2 = buildWorkspace("run2");
  writeSettings(ws2, true);
  const r2 = await launch(ws2, "untrusted", []);

  const passed = r1.passed + r2.passed;
  const failed = r1.failed + r2.failed;
  console.log(`\nin-editor tests: ${passed} passed, ${failed} failed (trusted run ${r1.passed}/${r1.passed + r1.failed}, untrusted run ${r2.passed}/${r2.passed + r2.failed})`);
  if (!failed) fs.rmSync(base, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
