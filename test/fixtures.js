"use strict";

// Builds throwaway workspaces for the Node test and the in-editor test:
//  - makeMainRepo: a real git repo with one script per rule, launched from a multi-stage
//    Dockerfile, a compose file (absolute container paths, bind mounts, build.context), a
//    GitHub Actions workflow, GitLab CI, package.json scripts and a Husky hook.
//  - makeHostileRepo: a repo whose COPY/CI/npm/compose paths and symlinks all point outside
//    the workspace, a symlinked .gitattributes, and a repo-local fsmonitor that would write a
//    marker file if git ever ran it.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null"].concat(args), { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

function write(root, rel, content, mode) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mode) fs.chmodSync(abs, mode);
  return abs;
}

const BOM = "\uFEFF";
const LF_OK = "#!/bin/sh\nset -e\necho ok\n";

/** Files of the main workspace: rel -> [content, mode]. Kept in one table so tests can refer to it. */
const MAIN_FILES = {
  // Dockerfile: multi-stage, COPY --from, bare ENTRYPOINT on PATH, WORKDIR-relative CMD
  "Dockerfile": [
    [
      "# syntax=docker/dockerfile:1",
      "FROM node:20 AS build",
      "WORKDIR /src",
      "COPY scripts/ ./scripts/",
      "RUN ./scripts/build.sh && \\",
      "    ./scripts/ok.sh",
      "",
      "FROM alpine:3.20",
      "COPY --from=build /src/scripts/run.sh /app/run.sh",
      "COPY docker/entrypoint.sh /usr/local/bin/",
      "WORKDIR /app",
      'ENTRYPOINT ["entrypoint.sh"]',
      'CMD ["./run.sh"]',
      "",
    ].join("\n"),
  ],
  "scripts/build.sh": [BOM + "#!/bin/sh\necho build\n", 0o755], // EC003
  "scripts/ok.sh": [LF_OK, 0o755], // clean
  "scripts/run.sh": ["#!/bin/sh\nexec node server.js\n", 0o644], // EC004
  "docker/entrypoint.sh": ["#!/bin/sh\r\nset -e\r\nexec \"$@\"\r\n", 0o755], // EC001
  // compose: build.context differs from the Dockerfile folder; absolute entrypoint; bind mount
  "compose.yaml": [
    [
      "services:",
      "  api:",
      "    build:",
      "      context: .",
      "      dockerfile: deploy/api.Dockerfile",
      "    entrypoint: /opt/start.sh",
      "  worker:",
      "    image: alpine:3.20",
      "    volumes:",
      "      - ./worker/boot.sh:/boot.sh:ro",
      '    entrypoint: ["/boot.sh"]',
      "  plain:",
      "    image: alpine:3.20",
      "    entrypoint: /usr/bin/unrelated.sh",
      "",
    ].join("\n"),
  ],
  "deploy/api.Dockerfile": ["FROM alpine:3.20\nCOPY deploy/start.sh /opt/start.sh\nRUN chmod +x /opt/start.sh\nENTRYPOINT [\"/opt/start.sh\"]\n"],
  "deploy/start.sh": ["echo no shebang\n", 0o644], // EC002 (EC004 suppressed by RUN chmod +x)
  "worker/boot.sh": ["#!bash\necho boot\n", 0o755], // EC002 invalid shebang
  // GitHub Actions: job defaults working-directory, pwsh step skipped
  ".github/workflows/ci.yml": [
    [
      "name: ci",
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    defaults:",
      "      run:",
      "        working-directory: tools",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - name: lint",
      "        run: |",
      "          echo start",
      "          ./lint.sh --all",
      "      - name: windows only",
      "        shell: pwsh",
      "        run: ./win.sh",
      "",
    ].join("\n"),
  ],
  "tools/lint.sh": ["#!/bin/bash\r\necho lint\r\n", 0o755], // EC001
  "tools/win.sh": ["no shebang\n", 0o644], // not checked (pwsh step)
  // GitLab: script list checked, artifacts paths are not commands
  ".gitlab-ci.yml": [
    [
      "variables:",
      "  HELPER: ./ci/helper.sh",
      "test:",
      "  script:",
      "    - sh ci/test.sh",
      "  artifacts:",
      "    paths:",
      "      - ci/artifact.sh",
      "",
    ].join("\n"),
  ],
  "ci/test.sh": ["echo test\r\n", 0o644], // EC001 only (interpreted: no shebang/exec-bit checks)
  "ci/artifact.sh": ["no shebang\n", 0o644], // must not be flagged
  "ci/helper.sh": ["no shebang\n", 0o644], // must not be flagged
  // package.json: "release" key also appears earlier in the file
  "package.json": [
    JSON.stringify({ name: "fixture", release: { channel: "beta" }, scripts: { build: "tsc", release: "./scripts/release.sh --dry-run" } }, null, 2) + "\n",
  ],
  "scripts/release.sh": [BOM + "#!/usr/bin/env bash\necho release\n", 0o755], // EC003
  // Husky v9 hook (no husky.sh): CRLF only, no shebang needed
  ".husky/pre-commit": ["npm test\r\n", 0o644], // EC001
};

function makeMainRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.fileMode", "true");
  for (const [rel, [content, mode]] of Object.entries(MAIN_FILES)) write(root, rel, content, mode);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

/**
 * Hostile repo. Everything interesting lives in `outsideDir`; the workspace only points at it.
 * `markerDir` receives a file if git ever runs the repo-local fsmonitor or a planted `git`.
 */
function makeHostileRepo(root, outsideDir, markerDir) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  // Outside-the-workspace files that a hostile repo tries to make EntryCheck read or rewrite.
  write(outsideDir, "secret.sh", "SECRET no shebang\r\n", 0o644);
  write(outsideDir, "bom.sh", BOM + "#!/bin/sh\r\necho x\r\n", 0o755);
  write(outsideDir, "Dockerfile", "FROM alpine\nCOPY secret.sh /s2.sh\nENTRYPOINT [\"/s2.sh\"]\n");
  write(outsideDir, "attributes.txt", "outside attributes\n");
  const marker = path.join(markerDir, "fsmonitor-ran");
  const fsmon = write(markerDir, "fsmonitor.sh", "#!/bin/sh\ntouch '" + marker + "'\n", 0o755);

  git(root, "init", "-q", "-b", "main");
  const rel = path.relative(root, outsideDir).split(path.sep).join("/");
  write(root, "Dockerfile", [
    "FROM alpine",
    "COPY " + rel + "/secret.sh /x.sh",
    "COPY link.sh /y.sh",
    "COPY ../../../../../../../../../ /all/",
    'ENTRYPOINT ["/x.sh"]',
    "RUN /y.sh && /all" + path.join(outsideDir, "bom.sh").split(path.sep).join("/"),
    "",
  ].join("\n"));
  fs.symlinkSync(path.join(outsideDir, "secret.sh"), path.join(root, "link.sh"));
  fs.symlinkSync(outsideDir, path.join(root, "outside-dir-link"));
  write(root, ".github/workflows/x.yml", [
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: " + rel + "/secret.sh",
    "      - run: ./link.sh",
    "      - run: ./outside-dir-link/bom.sh",
    "      - working-directory: " + rel,
    "        run: ./secret.sh",
    "",
  ].join("\n"));
  write(root, "package.json", JSON.stringify({ scripts: { a: rel + "/secret.sh", b: "./link.sh", c: "sh ./outside-dir-link/bom.sh" } }, null, 2) + "\n");
  write(root, "compose.yml", [
    "services:",
    "  a:",
    "    build:",
    "      context: " + rel,
    "    entrypoint: /s2.sh",
    "  b:",
    "    build:",
    "      context: .",
    "      dockerfile: " + rel + "/Dockerfile",
    "    entrypoint: /s2.sh",
    "  c:",
    "    image: alpine",
    "    volumes:",
    "      - " + rel + "/secret.sh:/s.sh",
    "      - ./outside-dir-link:/o",
    "    entrypoint: /s.sh",
    "    command: /o/bom.sh",
    "",
  ].join("\n"));
  // .gitattributes is a symlink to a file outside: reading or appending to it must be refused.
  fs.symlinkSync(path.join(outsideDir, "attributes.txt"), path.join(root, ".gitattributes"));
  // A harmless inside script so the hostile repo still has something to check (CRLF, EC001).
  write(root, "inside.sh", "#!/bin/sh\r\necho inside\r\n", 0o755);
  write(root, ".gitlab-ci.yml", "job:\n  script:\n    - ./inside.sh\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "hostile");
  // Repo-local fsmonitor: git would run it on index reads unless core.fsmonitor is overridden.
  git(root, "config", "core.fsmonitor", fsmon);
  // A planted `git` in the workspace root (a cwd-first executable search would pick it up).
  write(root, "git", "#!/bin/sh\ntouch '" + path.join(markerDir, "planted-git-ran") + "'\n", 0o755);
  return { root, marker, outsideDir };
}

/** sha-like snapshot of every file under `dir` (to prove nothing outside was modified). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[path.relative(dir, p)] = fs.readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return JSON.stringify(out);
}

module.exports = { git, write, makeMainRepo, makeHostileRepo, snapshot, MAIN_FILES, BOM };
