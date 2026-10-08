"use strict";

// Plain Node tests for core.js. Run: node test/core.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../core");
const { makeMainRepo, makeHostileRepo, snapshot, write, git, BOM } = require("./fixtures");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + (detail !== undefined ? " :: " + detail : ""));
  }
}
const j = (x) => JSON.stringify(x);

function dfRefs(text, files, extraCtx) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ec-df-"));
  for (const [rel, c] of Object.entries(files || {})) write(d, rel, c);
  write(d, "Dockerfile", text);
  const ctxs = [d].concat((extraCtx || []).map((c) => path.join(d, c)));
  const a = core.analyzeDockerfile(text, path.join(d, "Dockerfile"), ctxs, d);
  return { d, a, refs: a.refs, rel: (p) => (p ? path.relative(d, p).split(path.sep).join("/") : null) };
}

async function main() {
  // ---------------------------------------------------------------- command parsing
  const heads = core.commandHeads('FOO=1 sudo -E ./a.sh x && bash -x "b c.sh" | ./c.sh; echo "x;./not.sh"', 0);
  check("commandHeads splits on && | ; and keeps quoted ; inside one token", heads.length === 4 && heads[3][0].s === "echo" && heads[3][1].s === "x;./not.sh", j(heads.map((h) => h.map((t) => t.s))));
  check("commandHeads strips env assignments, sudo and its flags", heads[0][0].s === "./a.sh" && heads[0][0].col === 14, j(heads[0][0]));
  const hits = (cmd) => core.commandHeads(cmd, 0).flatMap((h) => core.scriptsFromTokens(h)).map((h) => [h.tok.s, h.direct, h.bare]);
  check("direct ./x.sh", j(hits("./x.sh")) === j([["./x.sh", true, false]]));
  check("relative path with a slash is direct", j(hits("scripts/deploy.sh --prod")) === j([["scripts/deploy.sh", true, false]]));
  check("sh x.sh is interpreted", j(hits("sh x.sh")) === j([["x.sh", false, false]]));
  check("/usr/bin/env bash ./x.sh is interpreted", j(hits("/usr/bin/env bash ./x.sh")) === j([["./x.sh", false, false]]));
  check("bash -c './x.sh arg' is followed into the -c string as direct", j(hits("bash -c './x.sh arg'")) === j([["./x.sh", true, false]]));
  check("source ./env.sh is interpreted", j(hits(". ./env.sh && source ./b.sh")) === j([["./env.sh", false, false], ["./b.sh", false, false]]));
  check("/usr/local/bin/entry.sh is a path (no longer excluded)", j(hits("/usr/local/bin/entry.sh")) === j([["/usr/local/bin/entry.sh", true, false]]));
  check("$VAR paths are skipped", hits("$DIR/x.sh").length === 0);
  check("bare name is marked bare", j(hits("docker-entrypoint.sh")) === j([["docker-entrypoint.sh", true, true]]));
  check("python ./x.py is not a script run", hits("python ./x.py").length === 0);
  check("comment line ignored", hits("# ./x.sh").length === 0);

  // ---------------------------------------------------------------- Dockerfile
  {
    const t = dfRefs("FROM alpine\nWORKDIR /app\nCOPY start.sh .\nRUN apk add x && \\\n    ./start.sh --init\nCMD [\"./start.sh\"]\n", { "start.sh": "x" });
    const r = t.refs.find((x) => x.line === 4);
    check("continuation line: column maps to the real line", r && r.col === 4 && t.rel(r.target) === "start.sh", j(t.refs.map((x) => [x.line, x.col, t.rel(x.target)])));
    check("exec-form CMD relative to WORKDIR", t.refs.some((x) => x.line === 5 && x.containerPath === "/app/start.sh" && t.rel(x.target) === "start.sh"));
  }
  {
    const t = dfRefs("FROM alpine\nCOPY scripts /opt/scripts\nCOPY *.sh /bin2/\nENTRYPOINT [\"/opt/scripts/a.sh\"]\nCMD /bin2/b.sh\n", { "scripts/a.sh": "x", "b.sh": "y" });
    check("COPY of a directory without trailing slash maps its contents", t.refs.some((x) => t.rel(x.target) === "scripts/a.sh"));
    check("COPY glob source maps by name", t.refs.some((x) => t.rel(x.target) === "b.sh"));
  }
  {
    const t = dfRefs("FROM alpine AS one\nWORKDIR /w\nCOPY one.sh ./\nFROM alpine\nCOPY two.sh /\nCMD [\"/w/one.sh\"]\nENTRYPOINT [\"/two.sh\"]\n", { "one.sh": "x", "two.sh": "y" });
    check("stages are separate: /w/one.sh is not in the final stage", !t.refs.some((x) => t.rel(x.target) === "one.sh") && t.refs.some((x) => t.rel(x.target) === "two.sh"), j(t.refs.map((x) => t.rel(x.target))));
  }
  {
    const t = dfRefs("FROM alpine AS b\nCOPY src/run.sh /src/run.sh\nRUN chmod +x /src/run.sh\nFROM b AS c\nFROM alpine\nCOPY --from=c /src/run.sh /app/run.sh\nCOPY --from=nginx:latest /docker-entrypoint.sh /\nENTRYPOINT [\"/app/run.sh\"]\nCMD [\"/docker-entrypoint.sh\"]\n", { "src/run.sh": "x", "docker-entrypoint.sh": "y" });
    const r = t.refs.find((x) => x.containerPath === "/app/run.sh");
    check("COPY --from=<stage> is followed through an inherited stage", r && t.rel(r.target) === "src/run.sh", j(t.refs));
    check("chmod in the source stage counts", r && r.chmodded === true);
    const n = t.refs.find((x) => x.containerPath === "/docker-entrypoint.sh");
    check("COPY --from=<external image> is not mapped to the context", n && !n.target);
  }
  {
    const t = dfRefs("FROM alpine\nCOPY docker/entrypoint.sh /usr/local/bin/\nENTRYPOINT [\"entrypoint.sh\"]\n", { "docker/entrypoint.sh": "x" });
    check("bare ENTRYPOINT name resolved on PATH", t.refs.length === 1 && t.rel(t.refs[0].target) === "docker/entrypoint.sh" && t.refs[0].containerPath === "/usr/local/bin/entrypoint.sh", j(t.refs));
  }
  {
    const t = dfRefs("FROM alpine\nCOPY --chmod=755 a.sh /a.sh\nCOPY b.sh /b.sh\nCOPY c.sh /scripts/c.sh\nRUN chmod -R +x /scripts\nENTRYPOINT [\"/a.sh\"]\nCMD [\"/b.sh\"]\nRUN /scripts/c.sh\n", { "a.sh": "", "b.sh": "", "c.sh": "" });
    const by = (p) => t.refs.find((x) => x.containerPath === p);
    check("COPY --chmod=755 marks chmodded", by("/a.sh").chmodded === true);
    check("plain COPY is not chmodded", by("/b.sh").chmodded === false);
    check("RUN chmod -R +x on a directory covers files below it", by("/scripts/c.sh").chmodded === true);
  }
  {
    const t = dfRefs("FROM alpine\nRUN --mount=type=bind,source=tools,target=/t /t/build.sh\nRUN <<EOF\nset -e\n./gen.sh\nEOF\nRUN cat <<EOF > /x\n./not-a-command.sh\nEOF\n", { "tools/build.sh": "x", "gen.sh": "y", "not-a-command.sh": "z" });
    check("RUN --mount=type=bind maps the target to the context source", t.refs.some((x) => t.rel(x.target) === "tools/build.sh" && x.line === 1));
    check("RUN heredoc body is scanned with its own line numbers", t.refs.some((x) => x.line === 4 && t.rel(x.target) === "gen.sh"), j(t.refs.map((x) => [x.line, t.rel(x.target)])));
    check("cat <<EOF file content is not scanned", !t.refs.some((x) => t.rel(x.target) === "not-a-command.sh"));
  }
  {
    const t = dfRefs("FROM alpine\nCOPY app/start.sh /start.sh\nENTRYPOINT [\"/start.sh\"]\n", { "sub/app/start.sh": "x" }, ["sub"]);
    check("extra build context (from compose) is used", t.refs.some((x) => t.rel(x.target) === "sub/app/start.sh"));
  }

  // ---------------------------------------------------------------- YAML launchers
  {
    const y = core.parseYaml("a:\n  - name: x\n    run: |\n      ./one.sh\n      echo \\\n        ./arg.sh\n  - run: ./two.sh  # comment\nb: [\"x\", 'y z']\n");
    const a = y.children[0];
    check("yaml: list of mappings", a.items.length === 2 && a.items[0].children.map((c) => c.key).join() === "name,run");
    check("yaml: block scalar lines", a.items[0].children[1].block.length === 3);
    check("yaml: inline comment stripped", a.items[1].children[0].value === "./two.sh");
    check("yaml: flow sequence", j(y.children[1].flow.map((t) => t.s)) === j(["x", "y z"]));
  }
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ec-gha-"));
    write(d, "sub/a.sh", "x");
    write(d, "a.sh", "x");
    write(d, "arg.sh", "x");
    const refs = core.extractGha("jobs:\n  j:\n    steps:\n      - run: ./a.sh\n      - working-directory: sub\n        run: ./a.sh\n      - run: |\n          echo \\\n            ./arg.sh\n      - shell: python {0}\n        run: ./a.sh\n      - shell: /bin/bash -e {0}\n        run: ./a.sh\n", d);
    check("GHA: working-directory applied per step; custom bash shell kept", refs.length === 3 && path.relative(d, refs[0].target) === "a.sh" && path.relative(d, refs[1].target) === path.join("sub", "a.sh"), j(refs.map((r) => path.relative(d, r.target))));
    check("GHA: continuation-line arguments are not commands; shell: python skipped", !refs.some((r) => /arg\.sh/.test(r.target)));
    const g = core.extractGitlab("variables:\n  X: ./a.sh\njob:\n  before_script:\n    - ./a.sh\n  artifacts:\n    paths:\n      - ./arg.sh\n", d);
    check("GitLab: before_script checked, variables and artifacts ignored", g.length === 1 && g[0].line === 4, j(g));
  }
  {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ec-compose-"));
    write(d, "docker/Dockerfile", "FROM alpine\nWORKDIR /srv\nCOPY docker/run.sh /usr/local/bin/run.sh\nCOPY bin/ ./bin/\n");
    write(d, "docker/run.sh", "x");
    write(d, "bin/go.sh", "x");
    write(d, "mnt/hook.sh", "x");
    write(d, "local.sh", "x");
    const text = [
      "services:",
      "  a:",
      "    build:",
      "      context: .",
      "      dockerfile: docker/Dockerfile",
      "    entrypoint: /usr/local/bin/run.sh",
      "    command: ./bin/go.sh",
      "  b:",
      "    build: ./docker",
      "    entrypoint:",
      "      - run.sh",
      "  c:",
      "    image: alpine",
      "    working_dir: /w",
      "    volumes:",
      "      - type: bind",
      "        source: ./mnt",
      "        target: /hooks",
      "      - data:/var/lib/data",
      "    entrypoint: [\"sh\", \"-c\", \"/hooks/hook.sh && ./local.sh\"]",
      "volumes:",
      "  data: {}",
      "",
    ].join("\n");
    const c = core.analyzeCompose(text, path.join(d, "compose.yaml"), d, {});
    const rel = (r) => path.relative(d, r.target).split(path.sep).join("/");
    check("compose: absolute entrypoint resolved through the Dockerfile COPY map", c.refs.some((r) => r.line === 5 && rel(r) === "docker/run.sh" && r.direct));
    check("compose: relative command resolved through the image WORKDIR", c.refs.some((r) => r.line === 6 && rel(r) === "bin/go.sh"));
    check("compose: build.context reported for the Dockerfile scan", c.builds.some((b) => b.ctx === d && b.dockerfile === path.join(d, "docker", "Dockerfile")));
    check("compose: wrong context (./docker) does not invent a file", !c.refs.some((r) => r.line === 10));
    check("compose: long-syntax bind mount resolves /hooks/hook.sh", c.refs.some((r) => r.line === 19 && rel(r) === "mnt/hook.sh"), j(c.refs.map((r) => [r.line, rel(r)])));
    check("compose: relative path in sh -c falls back to the compose folder", c.refs.some((r) => r.line === 19 && rel(r) === "local.sh"));
  }
  {
    const pj = JSON.stringify({ release: { x: 1 }, scripts: { release: "./r.sh", lint: "eslint ." } }, null, 2);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ec-pkg-"));
    const refs = core.extractPackageJson(pj, path.join(d, "package.json"));
    const lines = pj.split("\n");
    check("package.json: the scripts entry line is used, not an earlier same-named key", refs.length === 1 && /"release": "\.\/r\.sh"/.test(lines[refs[0].line]) && lines[refs[0].line].slice(refs[0].col, refs[0].col + 6) === "./r.sh", j(refs));
  }
  check("husky v9 hook is not direct", core.huskyHookIsDirect("npm test\n") === false);
  check("husky v8 hook is direct", core.huskyHookIsDirect('#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\nnpm test\n') === true);
  check("classify: .husky/.gitignore is not a hook", core.classify("/r", "/r/.husky/.gitignore") === null && core.classify("/r", "/r/.husky/pre-push") === "husky");
  check("classify: Dockerfile.md is not a Dockerfile", core.classify("/r", "/r/Dockerfile.md") === null && core.classify("/r", "/r/api.Dockerfile") === "dockerfile");

  // ---------------------------------------------------------------- checks and fixes
  const codes = (b, d) => (core.checkScript(Buffer.from(b), d) || []).map((x) => x.code).join(",");
  check("EC001 CRLF", codes("#!/bin/sh\r\necho\r\n", true) === "EC001");
  check("EC002 no shebang (direct only)", codes("echo\n", true) === "EC002" && codes("echo\n", false) === "");
  check("EC002 relative interpreter", codes("#!bash\n", true) === "EC002");
  check("EC003 BOM", codes(BOM + "#!/bin/sh\n", true) === "EC003");
  check("ELF skipped", core.checkScript(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1]), true) === null);
  check("crlfToLf is byte-wise and keeps lone CR / latin1 bytes", core.crlfToLf(Buffer.from([0x61, 0x0d, 0x0a, 0xe9, 0x0d, 0x62, 0x0d, 0x0a])).equals(Buffer.from([0x61, 0x0a, 0xe9, 0x0d, 0x62, 0x0a])));
  check("stripBomBytes", core.stripBomBytes(Buffer.from(BOM + "#!")).toString() === "#!");
  check("eolRuleIn", core.eolRuleIn("*.sh text eol=lf\n") && core.eolRuleIn("* text=auto eol=lf") && !core.eolRuleIn("*.sh text\n"));

  // ---------------------------------------------------------------- full scans on real repos
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ec-core-")));
  const main = makeMainRepo(path.join(base, "ws", "main"));
  const res = await core.scanFolderDetailed(main, { trusted: true });
  const got = res.findings.map((f) => f.code + " " + f.launcherRel + ":" + (f.line + 1) + " " + f.scriptRel).sort();
  const want = [
    "EC001 .github/workflows/ci.yml:14 tools/lint.sh",
    "EC001 .gitlab-ci.yml:5 ci/test.sh",
    "EC001 .husky/pre-commit:1 .husky/pre-commit",
    "EC001 Dockerfile:12 docker/entrypoint.sh",
    "EC002 compose.yaml:11 worker/boot.sh",
    "EC002 compose.yaml:6 deploy/start.sh",
    "EC002 deploy/api.Dockerfile:4 deploy/start.sh",
    "EC003 Dockerfile:5 scripts/build.sh",
    "EC003 package.json:8 scripts/release.sh",
    "EC004 Dockerfile:13 scripts/run.sh",
    "EC005 .github/workflows/ci.yml:14 tools/lint.sh",
  ];
  check("main repo: exactly the expected findings", j(got) === j(want), "\n  got  " + got.join("\n       ") + "\n  want " + want.join("\n       "));
  const untrusted = await core.scanFolderDetailed(main, { trusted: false });
  check("untrusted scan: same findings minus EC004", untrusted.findings.length === res.findings.length - 1 && !untrusted.findings.some((f) => f.code === "EC004"));
  check("scan lists launchers and watched files", res.launchers.length === 7 && res.watched.size > res.launchers.length, res.launchers.length);
  // compose absolute entrypoint via Dockerfile: EC004 suppressed by RUN chmod in api.Dockerfile
  check("RUN chmod +x in the compose service's Dockerfile suppresses EC004", !res.findings.some((f) => f.code === "EC004" && f.scriptRel === "deploy/start.sh"));
  // git modes
  const modes = await core.gitModes(main, ["scripts/run.sh", "scripts/ok.sh", "nope.sh"]);
  check("gitModes reads 100644/100755", modes.get("scripts/run.sh") === "100644" && modes.get("scripts/ok.sh") === "100755" && !modes.has("nope.sh"));
  // .gitattributes fix makes EC005 go away
  check("appendGitattributes adds the rule", core.appendGitattributes(main) === "added" && core.appendGitattributes(main) === "present");
  const after = await core.scanFolderDetailed(main, { trusted: true });
  check("EC005 gone after .gitattributes rule", !after.findings.some((f) => f.code === "EC005"));

  // ---------------------------------------------------------------- hostile repo
  const outside = path.join(base, "outside");
  const markers = path.join(base, "markers");
  const h = makeHostileRepo(path.join(base, "ws", "hostile"), outside, markers);
  const before = snapshot(outside);
  const hr = await core.scanFolderDetailed(h.root, { trusted: true });
  check("hostile: only the inside script is reported", hr.findings.length && hr.findings.every((f) => f.script === path.join(h.root, "inside.sh")), j(hr.findings.map((f) => f.code + " " + f.script)));
  check("hostile: no finding, watched file or message mentions the outside dir", !hr.findings.some((f) => (f.script + f.message).includes(outside)) && !Array.from(hr.watched).some((p) => (core.confined(h.root, p) === null && fs.existsSync(p) && !p.endsWith(path.join(".git", "index")) && !p.endsWith(".gitattributes"))));
  check("hostile: symlinked .gitattributes is never read (EC005 still reported)", hr.findings.some((f) => f.code === "EC005"));
  check("hostile: appendGitattributes refuses a symlinked .gitattributes", core.appendGitattributes(h.root) === "refused");
  check("hostile: confined() rejects outside paths, symlinks to outside and dangling links", core.confined(h.root, path.join(outside, "secret.sh")) === null && core.confined(h.root, path.join(h.root, "link.sh")) === null && core.confined(h.root, path.join(h.root, "outside-dir-link", "bom.sh")) === null);
  check("hostile: repo-local fsmonitor never ran", !fs.existsSync(h.marker));
  check("hostile: planted git in the workspace never ran", !fs.existsSync(path.join(markers, "planted-git-ran")));
  check("hostile: nothing outside the workspace changed", snapshot(outside) === before);
  // a dangling .gitattributes symlink must not be written through
  const dang = path.join(base, "ws", "dangling");
  fs.mkdirSync(dang, { recursive: true });
  fs.symlinkSync(path.join(outside, "created-by-entrycheck"), path.join(dang, ".gitattributes"));
  check("dangling .gitattributes symlink is refused and nothing is created outside", core.appendGitattributes(dang) === "refused" && !fs.existsSync(path.join(outside, "created-by-entrycheck")));
  // git env hardening
  process.env.GIT_DIR = "/nonexistent";
  check("hardened env drops GIT_DIR and ignores global config", !("GIT_DIR" in core.hardenedGitEnv()) && core.hardenedGitEnv().GIT_CONFIG_GLOBAL);
  delete process.env.GIT_DIR;
  check("git is run with -C and fsmonitor/hooks disabled", core.GIT_LEADING_ARGS.includes("core.fsmonitor=") && core.GIT_LEADING_ARGS.some((a) => a.startsWith("core.hooksPath=")));

  // ---------------------------------------------------------------- scan cannot stall
  const big = path.join(base, "ws", "big");
  for (let i = 0; i < 300; i++) write(big, "d" + (i % 30) + "/f" + i + ".txt", "x");
  let ticks = 0;
  const iv = setInterval(() => ticks++, 0);
  const t0 = Date.now();
  await core.walk(big);
  clearInterval(iv);
  check("walk yields to the event loop", ticks > 0, "ticks=" + ticks + " ms=" + (Date.now() - t0));

  fs.rmSync(base, { recursive: true, force: true });
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
