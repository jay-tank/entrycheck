"use strict";

/**
 * EntryCheck core - no `vscode` dependency so it runs under plain Node in tests.
 *
 * Finds the scripts that Dockerfiles, docker-compose, CI workflows, package.json scripts and
 * git hooks execute, and flags what makes them fail at runtime:
 *
 *   EC001 CRLF line endings            (Error)
 *   EC002 missing or invalid shebang   (Error, only for directly-executed scripts)
 *   EC003 UTF-8 BOM before the shebang (Error)
 *   EC004 not executable in git index  (Warning, needs Workspace Trust - reads git)
 *   EC005 no .gitattributes eol rule   (Information)
 *
 * Security: every path comes from repository content, so every file EntryCheck reads or writes
 * must resolve (after symlinks) inside the scanned workspace folder. The only process spawned
 * is `git ls-files -s` via execFile (no shell), with a hardened environment.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const posix = path.posix;
const NULL_DEVICE = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", ".venv", "venv", "target", "__pycache__", ".next", ".tox", ".cache", "bower_components", ".terraform"]);
const MAX_ENTRIES = 200000; // directory entries visited per workspace folder
const MAX_LAUNCHERS = 5000;
const MAX_DEPTH = 12;
const MAX_LAUNCHER_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "source", "."]);
const PREFIX_WORDS = new Set(["exec", "sudo", "env", "nohup", "time", "command", "then", "do", "else", "if", "while", "until", "!", "{"]);
const PATH_DIRS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
const HOOK_NAMES = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg",
  "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update",
  "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc",
  "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist",
  "p4-post-changelist", "p4-pre-submit", "post-index-change",
]);

const RULES = {
  EC001: { title: "CRLF line endings", severity: "Error" },
  EC002: { title: "missing or invalid shebang", severity: "Error" },
  EC003: { title: "UTF-8 BOM before the shebang", severity: "Error" },
  EC004: { title: "not executable in git (100644)", severity: "Warning" },
  EC005: { title: "no .gitattributes eol=lf rule", severity: "Information" },
};

const KIND_LABEL = {
  dockerfile: "Dockerfile",
  compose: "docker-compose",
  gha: "GitHub Actions",
  gitlab: "GitLab CI",
  package: "package.json scripts",
  husky: "git hook",
};

// ---------------------------------------------------------------- path confinement

function isInside(base, abs) {
  if (abs === base) return true;
  const b = base.endsWith(path.sep) ? base : base + path.sep;
  return abs.startsWith(b);
}

function realpathOr(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch (_e) {
    return null;
  }
}

/**
 * Realpath of `p` when it exists and resolves (after symlinks) inside `root`, else null.
 * A path that does not exist is never "inside": nothing can be read from it, and a dangling
 * symlink must not be written through.
 */
function confined(root, p) {
  const base = realpathOr(root);
  const abs = realpathOr(p);
  if (!base || !abs) return null;
  return isInside(base, abs) ? abs : null;
}

/** Kept for compatibility: true when `p` resolves inside `root`. */
function insideRoot(root, p) {
  return confined(root, p) !== null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_e) {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_e) {
    return false;
  }
}

/** A regular file inside `root`, read as a Buffer, or null. */
function readConfined(root, p, max) {
  const real = confined(root, p);
  if (!real) return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(real);
  } catch (_e) {
    return null;
  }
}

function toRel(root, p) {
  const base = realpathOr(root) || path.resolve(root);
  const abs = realpathOr(p) || path.resolve(p);
  return path.relative(base, abs).split(path.sep).join("/");
}

// ---------------------------------------------------------------- file discovery

function classify(root, file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const base = path.basename(file);
  if (/\.(md|txt|orig|bak|swp|rej|log)$/i.test(base)) return null;
  if (/^(Dockerfile|Containerfile)(\..+)?$/i.test(base) || /\.(dockerfile|containerfile)$/i.test(base)) return "dockerfile";
  if (/^(docker-)?compose(\.[\w-]+)*\.ya?ml$/i.test(base)) return "compose";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return "gha";
  if (base === ".gitlab-ci.yml" || /\.gitlab-ci\.ya?ml$/.test(base) || /^\.gitlab\/ci\/.+\.ya?ml$/.test(rel)) return "gitlab";
  if (base === "package.json") return "package";
  if (/(^|\/)\.husky\/[^/]+$/.test(rel) && HOOK_NAMES.has(base)) return "husky";
  return null;
}

/** Async walk that yields to the event loop on every directory, so a large tree cannot stall. */
async function walk(root) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  let visited = 0;
  let truncated = false;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const e of entries) {
      if (++visited > MAX_ENTRIES) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= MAX_DEPTH) continue;
        if (e.name === "_" && path.basename(dir) === ".husky") continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        const kind = classify(root, full);
        if (!kind) continue;
        out.push({ file: full, kind });
        if (out.length >= MAX_LAUNCHERS) {
          truncated = true;
          stack.length = 0;
          break;
        }
      }
    }
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files: out, truncated };
}

// ---------------------------------------------------------------- command parsing

function stripPrefixes(toks) {
  let afterPrefix = false;
  while (toks.length) {
    const s = toks[0].s;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) toks.shift();
    else if (PREFIX_WORDS.has(s) || PREFIX_WORDS.has(posix.basename(s))) {
      toks.shift();
      afterPrefix = true;
    } else if (afterPrefix && /^-/.test(s)) toks.shift();
    else break;
  }
  return toks;
}

/**
 * Split a shell command string into simple commands (on ; & | newlines and parentheses,
 * respecting quotes) and return each one's tokens: { s (unquoted), col, len }.
 */
function commandHeads(text, baseCol) {
  const heads = [];
  let toks = [];
  const n = text.length;
  let i = 0;
  const flush = () => {
    stripPrefixes(toks);
    if (toks.length) heads.push(toks.slice(0, 12));
    toks = [];
  };
  while (i < n) {
    const ch = text[i];
    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
      flush();
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#" && toks.length === 0) {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    const start = i;
    let s = "";
    while (i < n && !/[\s;&|()`]/.test(text[i])) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        if (end < 0) {
          s += text.slice(i + 1);
          i = n;
          break;
        }
        s += text.slice(i + 1, end);
        i = end + 1;
      } else if (c === "\\" && i + 1 < n) {
        s += text[i + 1];
        i += 2;
      } else {
        s += c;
        i++;
      }
    }
    toks.push({ s, col: (baseCol || 0) + start, len: i - start, quoted: /^["']/.test(text[start]) });
  }
  flush();
  return heads;
}

/** A token that the shell (or Docker) executes as a file path: contains a slash. */
function looksLikePath(s) {
  if (!s || s.includes("$") || s.endsWith("/") || s.includes("//")) return false;
  if (/^\/(dev|proc|sys)\//.test(s)) return false;
  return /^(\.{1,2}\/|\/)?[\w.@+-]+(\/[\w.@+-]+)*$/.test(s) && s.includes("/");
}

function isBareScript(s) {
  return /^[\w.@+-]+\.(sh|bash)$/.test(s) && !s.includes("$");
}

/**
 * From one simple command's tokens, return the script hits:
 * [{ tok, direct, bare }]. `direct` = executed as a program (needs shebang and exec bit);
 * `bare` = a name without a slash, looked up on PATH (only meaningful inside a container).
 */
function scriptsFromTokens(toks, depth) {
  if (!toks || !toks.length || (depth || 0) > 3) return [];
  const first = toks[0].s;
  if (SHELLS.has(first) || SHELLS.has(posix.basename(first))) {
    let i = 1;
    while (toks[i] && /^-/.test(toks[i].s)) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(toks[i].s) && first !== "source" && first !== ".") {
        const cmd = toks[i + 1];
        if (!cmd) return [];
        const out = [];
        for (const h of commandHeads(cmd.s, cmd.col + (cmd.quoted ? 1 : 0))) {
          if (cmd.line !== undefined) for (const t of h) t.line = cmd.line;
          out.push(...scriptsFromTokens(h, (depth || 0) + 1));
        }
        return out;
      }
      i++;
    }
    const tk = toks[i];
    if (tk && (looksLikePath(tk.s) || /^[\w.@+-][\w.\/@+-]*\.(sh|bash|ksh|zsh)$/.test(tk.s))) return [{ tok: tk, direct: false, bare: false }];
    return [];
  }
  if (looksLikePath(first)) return [{ tok: toks[0], direct: true, bare: false }];
  if (isBareScript(first)) return [{ tok: toks[0], direct: true, bare: true }];
  return [];
}

/** Kept for compatibility with the original API: first hit or null. */
function scriptFromTokens(toks) {
  const h = scriptsFromTokens(toks).filter((x) => !x.bare);
  return h.length ? h[0] : null;
}

/** Scan shell lines (array of {text, line, col}); a line after one ending in `\` is arguments. */
function hitsFromLines(lines) {
  const out = [];
  let cont = false;
  for (const l of lines) {
    const wasCont = cont;
    cont = /\\\s*$/.test(l.text);
    if (wasCont) continue;
    for (const h of commandHeads(l.text, l.col)) for (const hit of scriptsFromTokens(h)) out.push(Object.assign({ line: l.line }, hit));
  }
  return out;
}

// ---------------------------------------------------------------- Dockerfile

function globToRe(g) {
  return new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
}
const hasGlob = (s) => /[*?[]/.test(s);

/**
 * Parse a Dockerfile into instructions with a column map for continuation lines.
 * Returns [{ kw, args, line, map }] where map converts an offset in `args`'s instruction text
 * back to {line, col}.
 */
function dockerInstructions(text) {
  const lines = text.split(/\r?\n/);
  if (/^#\s*escape\s*=\s*`/m.test(lines.slice(0, 5).join("\n"))) return null; // Windows-style Dockerfile
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(#|$)/.test(lines[i])) continue;
    let body = lines[i];
    const map = [{ off: 0, line: i }];
    while (/\\\s*$/.test(body) && i + 1 < lines.length) {
      body = body.replace(/\\\s*$/, " ");
      i++;
      while (i < lines.length && /^\s*#/.test(lines[i])) i++;
      if (i >= lines.length) break;
      map.push({ off: body.length, line: i });
      body += lines[i];
    }
    const m = /^\s*([A-Za-z]+)(\s+|$)/.exec(body);
    if (!m) continue;
    const ins = { kw: m[1].toUpperCase(), text: body, argsOff: m[0].length, line: map[0].line, map };
    out.push(ins);
    // Heredoc: RUN <<EOF ... EOF. Its body is a shell script when the heredoc feeds RUN itself
    // or a shell; otherwise (cat <<EOF > file) it is file content and is skipped.
    const hd = /<<(-?)\s*["']?([A-Za-z_]\w*)["']?/.exec(body);
    if (hd && (ins.kw === "RUN" || ins.kw === "COPY" || ins.kw === "ADD")) {
      const word = hd[2];
      const strip = hd[1] === "-";
      const bodyLines = [];
      while (i + 1 < lines.length) {
        i++;
        const l = lines[i];
        if ((strip ? l.trim() : l.replace(/\s+$/, "")) === word) break;
        bodyLines.push({ text: l, line: i, col: 0 });
      }
      if (ins.kw === "RUN") {
        const before = body.slice(ins.argsOff, hd.index).replace(/--\S+\s*/g, "").trim();
        const shellHead = before === "" || SHELLS.has(posix.basename(before.split(/\s+/)[0]));
        const foreign = bodyLines.length && /^#!/.test(bodyLines[0].text) && !/sh\b/.test(bodyLines[0].text);
        if (shellHead && !foreign) ins.heredocBody = bodyLines;
      }
    }
  }
  return out;
}

function mapPos(ins, off) {
  let seg = ins.map[0];
  for (const s of ins.map) if (s.off <= off) seg = s;
  return { line: seg.line, col: off - seg.off };
}

function parseFlags(args) {
  const flags = [];
  let rest = args;
  let off = 0;
  for (;;) {
    const m = /^(\s*)(--\S+)(\s+|$)/.exec(rest);
    if (!m) break;
    flags.push(m[2]);
    off += m[0].length;
    rest = rest.slice(m[0].length);
  }
  return { flags, rest, off };
}

function parseMount(spec) {
  const o = {};
  for (const kv of spec.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    else o[kv.trim()] = "true";
  }
  return o;
}

/**
 * Analyze a Dockerfile. `ctxs` is the list of candidate build contexts (absolute paths).
 * Returns { refs, stages, finalStage, stageByName, resolve(stage, cpath) }.
 */
function analyzeDockerfile(text, file, ctxs, root) {
  const empty = { refs: [], stages: [], finalStage: null, stageByName: new Map(), resolve: () => null };
  const instrs = dockerInstructions(text);
  if (!instrs) return empty;
  const contexts = (ctxs && ctxs.length ? ctxs : [path.dirname(file)]).map((c) => path.resolve(c));
  const stages = [];
  const stageByName = new Map();
  let stage = { name: null, index: 0, workdir: "/", copies: [], chmods: [], parent: null };
  let started = false;
  const refs = [];

  const newStage = (from, name) => {
    const parent = stageByName.get(String(from).toLowerCase()) || null;
    const s = { name: name || null, index: stages.length, workdir: parent ? parent.workdir : "/", copies: [], chmods: [], parent };
    stages.push(s);
    stageByName.set(String(s.index), s);
    if (name) stageByName.set(name.toLowerCase(), s);
    return s;
  };

  for (const ins of instrs) {
    const args = ins.text.slice(ins.argsOff);
    if (ins.kw === "FROM") {
      const { rest } = parseFlags(args);
      const m = /^(\S+)(?:\s+as\s+(\S+))?/i.exec(rest.trim());
      stage = newStage(m ? m[1] : "", m ? m[2] : null);
      started = true;
      continue;
    }
    if (!started) {
      stage = newStage("", null);
      started = true;
    }
    const pushRefs = (hits, ins2, baseOff, kw, mounts) => {
      for (const h of hits) {
        const s = h.tok.s;
        if (s.includes("$")) continue;
        const pos = ins2 ? mapPos(ins2, baseOff + h.tok.col) : { line: h.line, col: h.tok.col };
        refs.push({
          line: pos.line,
          col: pos.col,
          len: h.tok.len,
          containerPath: h.bare ? null : posix.resolve(stage.workdir, s),
          bareName: h.bare ? s : null,
          direct: h.direct,
          kw,
          stage,
          mounts: mounts || [],
        });
      }
    };
    if (ins.kw === "WORKDIR") {
      const w = args.trim().replace(/^["']|["']$/g, "");
      if (w && !w.includes("$")) stage.workdir = posix.resolve(stage.workdir, w);
    } else if (ins.kw === "COPY" || ins.kw === "ADD") {
      if (/<</.test(args)) continue; // heredoc file creation
      const { flags, rest } = parseFlags(args);
      let chmod = false;
      let from = null;
      for (const f of flags) {
        const cm = /^--chmod=(\S+)$/.exec(f);
        if (cm && (/x/.test(cm[1]) || /^[0-7]*[1357][0-7]?[0-7]?$/.test(cm[1].replace(/^0+(?=\d{3})/, "")))) chmod = true;
        const fm = /^--from=(\S+)$/.exec(f);
        if (fm) from = fm[1];
      }
      let parts;
      if (/^\s*\[/.test(rest)) {
        try {
          parts = JSON.parse(rest.trim());
        } catch (_e) {
          continue;
        }
        if (!Array.isArray(parts)) continue;
      } else parts = rest.trim().split(/\s+/);
      parts = parts.map(String);
      if (parts.length < 2) continue;
      const destRaw = parts[parts.length - 1];
      if (destRaw.includes("$")) continue;
      const srcs = parts.slice(0, -1).filter((s) => !/^[a-z]+:\/\//i.test(s) && !/^git@/.test(s) && !s.includes("$"));
      const fromStage = from ? stageByName.get(from.toLowerCase()) || null : null;
      stage.copies.push({
        srcs,
        dest: posix.resolve(stage.workdir, destRaw),
        destSlash: destRaw.endsWith("/") || parts.length > 2 || srcs.some(hasGlob),
        chmod,
        from,
        fromStage,
      });
    } else if (ins.kw === "RUN" || ins.kw === "ENTRYPOINT" || ins.kw === "CMD") {
      let mounts = [];
      let restOff = ins.argsOff;
      let rest = args;
      if (ins.kw === "RUN") {
        const pf = parseFlags(args);
        restOff += pf.off;
        rest = pf.rest;
        for (const f of pf.flags) {
          const mm = /^--mount=(.*)$/.exec(f);
          if (!mm) continue;
          const o = parseMount(mm[1]);
          if ((o.type || "bind") !== "bind" || !o.target && !o.dst && !o.destination) continue;
          mounts.push({ target: posix.resolve("/", o.target || o.dst || o.destination), source: o.source || o.src || ".", from: o.from || null });
        }
      }
      if (/^\s*\[/.test(rest)) {
        let arr = null;
        try {
          arr = JSON.parse(rest.trim());
        } catch (_e) {
          arr = null;
        }
        if (Array.isArray(arr) && arr.length) {
          let searchFrom = restOff;
          const toks = arr.slice(0, 12).map((v) => {
            const q = JSON.stringify(String(v));
            const at = ins.text.indexOf(q, searchFrom);
            if (at >= 0) searchFrom = at + q.length;
            return { s: String(v), col: at >= 0 ? at : restOff, len: q.length, quoted: true };
          });
          stripPrefixes(toks);
          pushRefs(scriptsFromTokens(toks), ins, 0, ins.kw, mounts);
        }
        if (arr) continue;
      }
      if (ins.kw === "RUN") {
        const cm = /chmod\s+((?:-\S+\s+)*)(\+x|[augo]*\+[rwx]*x[rwx]*|[0-7]*[1357][0-7]{0,2})\s+([^;&|]+)/g;
        let c;
        while ((c = cm.exec(rest))) {
          const recursive = /-\S*R/.test(c[1]);
          for (const p of c[3].trim().split(/\s+/)) {
            const q = p.replace(/^["']|["']$/g, "");
            if (!q || q.includes("$") || /^[<>]/.test(q)) continue;
            stage.chmods.push({ path: posix.resolve(stage.workdir, q), recursive });
          }
        }
      }
      pushRefs(hitsFromLines([{ text: rest, line: ins.line, col: 0 }]).map((h) => Object.assign(h, { line: undefined })), ins, restOff, ins.kw, mounts);
      if (ins.heredocBody) pushRefs(hitsFromLines(ins.heredocBody), null, 0, ins.kw, mounts);
    }
  }
  const finalStage = stages[stages.length - 1] || stage;

  function chmodIn(st, cpath) {
    for (let s = st, d = 0; s && d < 16; s = s.parent, d++) {
      for (const c of s.chmods) {
        if (c.path === cpath) return true;
        if (hasGlob(c.path) && globToRe(c.path).test(cpath)) return true;
        if (c.recursive && cpath.startsWith(c.path.endsWith("/") ? c.path : c.path + "/")) return true;
      }
    }
    return false;
  }

  function localFor(ctx, rel) {
    const p = path.join(ctx, rel);
    // Never stat outside the workspace; the read happens later through readConfined anyway.
    if (root && !confined(root, p)) return null;
    return p;
  }

  /** Map a container path through one context COPY to a local file, or null. */
  function matchContextCopy(c, cpath) {
    const prefix = c.dest.endsWith("/") ? c.dest : c.dest + "/";
    for (const ctx of contexts) {
      for (let k = c.srcs.length - 1; k >= 0; k--) {
        const src = c.srcs[k];
        const srcBase = posix.basename(src);
        if (hasGlob(srcBase)) {
          if (!cpath.startsWith(prefix)) continue;
          const tail = cpath.slice(prefix.length);
          if (tail.includes("/") || !globToRe(srcBase).test(tail)) continue;
          const local = localFor(ctx, posix.join(posix.dirname(src), tail));
          if (local && isFile(local)) return local;
          continue;
        }
        const srcAbs = localFor(ctx, src);
        if (!srcAbs) continue;
        if (isDir(srcAbs)) {
          if (!cpath.startsWith(prefix)) continue;
          const local = path.join(srcAbs, cpath.slice(prefix.length));
          if (isFile(local)) return local;
          continue;
        }
        if (!isFile(srcAbs)) continue;
        if ((!c.destSlash && cpath === c.dest) || cpath === posix.join(c.dest, srcBase)) return srcAbs;
      }
    }
    return null;
  }

  function resolveIn(st, cpath, depth) {
    if (!st || !cpath || depth > 8) return null;
    for (let s = st, d = 0; s && d < 16; s = s.parent, d++) {
      for (let k = s.copies.length - 1; k >= 0; k--) {
        const c = s.copies[k];
        if (c.from) {
          // COPY --from=<stage>: follow the path into that stage.
          const prefix = c.dest.endsWith("/") ? c.dest : c.dest + "/";
          const exact = [];
          const below = [];
          for (const src of c.srcs) {
            const srcC = posix.resolve("/", src);
            if (!c.destSlash && cpath === c.dest) exact.push(srcC);
            if (cpath === posix.join(c.dest, posix.basename(srcC))) exact.push(srcC);
            if (cpath.startsWith(prefix)) below.push(posix.join(srcC, cpath.slice(prefix.length)));
          }
          // From an external image: the file is not in the workspace. Only an exact match
          // shadows the path; a directory-style match into e.g. "/" says nothing about it.
          if (!c.fromStage) {
            if (exact.length) return null;
            continue;
          }
          const cands = exact.concat(below);
          if (!cands.length) continue;
          for (const cand of cands) {
            const r = resolveIn(c.fromStage, cand, depth + 1);
            if (r) return { local: r.local, chmod: c.chmod || r.chmod || chmodIn(st, cpath) };
          }
          continue;
        }
        const local = matchContextCopy(c, cpath);
        if (local) return { local, chmod: c.chmod || chmodIn(st, cpath) };
      }
    }
    return null;
  }

  function resolveRef(r) {
    const cands = r.bareName ? PATH_DIRS.map((d) => d + "/" + r.bareName) : [r.containerPath];
    for (const cpath of cands) {
      for (const m of r.mounts) {
        const prefix = m.target.endsWith("/") ? m.target : m.target + "/";
        if (cpath !== m.target && !cpath.startsWith(prefix)) continue;
        const tail = cpath === m.target ? "" : cpath.slice(prefix.length);
        if (m.from) {
          const fs2 = stageByName.get(m.from.toLowerCase());
          const rr = fs2 ? resolveIn(fs2, posix.join(posix.resolve("/", m.source), tail), 1) : null;
          if (rr) return { cpath, local: rr.local, chmod: rr.chmod };
          continue;
        }
        for (const ctx of contexts) {
          const local = localFor(ctx, path.join(m.source, tail));
          if (local && isFile(local)) return { cpath, local, chmod: false };
        }
      }
      const r2 = resolveIn(r.stage, cpath, 0);
      if (r2) return { cpath, local: r2.local, chmod: r2.chmod };
    }
    return null;
  }

  for (const r of refs) {
    const res = resolveRef(r);
    if (res) {
      r.target = res.local;
      r.containerPath = res.cpath;
      r.chmodded = res.chmod || chmodIn(r.stage, res.cpath);
    } else {
      r.chmodded = r.containerPath ? chmodIn(r.stage, r.containerPath) : false;
      // A RUN may call a context file by the same relative path (e.g. bind-mounted build scripts).
      if (r.kw === "RUN" && r.containerPath && !r.mounts.length) {
        for (const ctx of contexts) {
          const guess = localFor(ctx, r.containerPath.replace(/^\/+/, ""));
          if (guess && isFile(guess)) {
            r.target = guess;
            break;
          }
        }
      }
    }
  }

  return {
    refs,
    stages,
    finalStage,
    stageByName,
    /** Resolve a container path in the given stage (or the final one). */
    resolve(stageName, cpathOrBare) {
      const st = (stageName && stageByName.get(String(stageName).toLowerCase())) || finalStage;
      if (!st) return null;
      const bare = !cpathOrBare.includes("/");
      const cands = bare ? PATH_DIRS.map((d) => d + "/" + cpathOrBare) : [cpathOrBare];
      for (const c of cands) {
        const r = resolveIn(st, c, 0);
        if (r) return { cpath: c, local: r.local, chmod: r.chmod || chmodIn(st, c) };
      }
      return null;
    },
    workdirOf(stageName) {
      const st = (stageName && stageByName.get(String(stageName).toLowerCase())) || finalStage;
      return st ? st.workdir : "/";
    },
  };
}

/** Backward-compatible wrapper: refs of a Dockerfile with its folder as the build context. */
function extractDockerfile(text, file, ctxs, root) {
  return analyzeDockerfile(text, file, ctxs, root).refs;
}

// ---------------------------------------------------------------- tiny YAML reader

const KEY_RE = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.$/][\w.\-/$]*)(\s*:)(?:(\s+)(.*))?$/;

/**
 * Line-based YAML reader, enough for CI and compose files: block mappings, block sequences,
 * block scalars (| and >), single-line flow sequences and quoted scalars. Returns a root node;
 * every node has { key?, item?, value, valueCol, line, children, items, block, flow, parent }.
 */
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = { key: null, indent: -1, children: [], items: [], line: -1, parent: null };
  const stack = [root];
  let block = null;

  const setScalar = (node, raw, line, col, parentIndent) => {
    let v = raw;
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(v)) {
      node.block = [];
      block = { node, parentIndent };
      return;
    }
    if (v.startsWith("[")) {
      node.flow = [];
      const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^,\[\]\s][^,\]]*?)(?=\s*[,\]])/g;
      let m;
      const inner = v.replace(/\s+#.*$/, "");
      while ((m = re.exec(inner))) {
        const s = m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2] !== undefined ? m[2] : m[3];
        node.flow.push({ s, col: col + m.index, len: m[0].length, quoted: m[1] !== undefined || m[2] !== undefined });
      }
      return;
    }
    if (v.startsWith('"') || v.startsWith("'")) {
      const q = v[0];
      const end = v.lastIndexOf(q);
      if (end > 0) {
        node.value = v.slice(1, end);
        node.valueCol = col + 1;
        node.valueLine = line;
        return;
      }
    }
    v = v.replace(/\s+#.*$/, "");
    node.value = v;
    node.valueCol = col;
    node.valueLine = line;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const ind = ln.search(/\S/);
    if (block) {
      if (ind === -1) continue;
      if (ind > block.parentIndent) {
        block.node.block.push({ text: ln.slice(ind), line: i, col: ind });
        continue;
      }
      block = null;
    }
    if (ind === -1) continue;
    const content = ln.slice(ind);
    if (content.startsWith("#") || /^(---|\.\.\.)(\s|$)/.test(content)) continue;
    let k = ind;
    let rest = content;
    if (/^-(\s|$)/.test(content)) {
      while (stack.length > 1 && stack[stack.length - 1].indent > ind) stack.pop();
      const parent = stack[stack.length - 1];
      const item = { item: true, parent, line: i, indent: ind + 0.5, children: [], items: [], value: null, valueCol: -1 };
      parent.items.push(item);
      stack.push(item);
      const after = content.slice(1);
      const sp = after.search(/\S/);
      if (sp === -1) continue;
      rest = after.slice(sp);
      k = ind + 1 + sp;
      if (!KEY_RE.test(rest) || /^-(\s|$)/.test(rest)) {
        if (!/^-(\s|$)/.test(rest)) setScalar(item, rest, i, k, ind);
        continue;
      }
    }
    const km = KEY_RE.exec(rest);
    if (!km) continue; // continuation of a multi-line scalar
    while (stack.length > 1 && stack[stack.length - 1].indent >= k) stack.pop();
    const parent = stack[stack.length - 1];
    const key = km[1].replace(/^["']|["']$/g, "");
    const node = { key, parent, line: i, indent: k, children: [], items: [], value: null, valueCol: -1 };
    parent.children.push(node);
    stack.push(node);
    if (km[4] !== undefined && km[4] !== "") setScalar(node, km[4], i, k + km[1].length + km[2].length + km[3].length, k);
  }
  return root;
}

function child(node, key) {
  return node ? node.children.find((c) => c.key === key) || null : null;
}

function allNodes(node, out) {
  out = out || [];
  for (const c of node.children) {
    out.push(c);
    allNodes(c, out);
  }
  for (const it of node.items) {
    out.push(it);
    allNodes(it, out);
  }
  return out;
}

/** Shell lines held by a node: inline scalar, block scalar, or (for lists) each item. */
function shellLines(node) {
  if (!node) return [];
  if (node.block) return node.block;
  if (node.value !== null && node.value !== undefined && node.value !== "") return [{ text: node.value, line: node.valueLine, col: node.valueCol }];
  if (node.flow) return node.flow.map((t) => ({ text: t.s, line: node.line, col: t.col + (t.quoted ? 1 : 0) }));
  const out = [];
  for (const it of node.items) {
    if (typeof it.value === "string" && it.value.startsWith("!")) continue;
    out.push(...shellLines(it));
  }
  return out;
}

// ---------------------------------------------------------------- CI files

function extractGha(text, root) {
  const doc = parseYaml(text);
  const refs = [];
  const wfDefault = child(child(child(doc, "defaults"), "run"), "working-directory");
  for (const n of allNodes(doc)) {
    if (n.key !== "run" || n.children.length || (!n.block && (n.value === null || n.value === ""))) continue;
    const step = n.parent;
    if (!step || !step.item) continue;
    const shell = child(step, "shell");
    if (shell && shell.value && !/^(\S*\/)?(bash|sh)\b/.test(shell.value.trim())) continue;
    const stepsKey = step.parent;
    const job = stepsKey && stepsKey.parent;
    const jobDefault = child(child(child(job, "defaults"), "run"), "working-directory");
    const wdNode = child(step, "working-directory") || jobDefault || wfDefault;
    let base = root;
    if (wdNode && wdNode.value && !wdNode.value.includes("${{") && !wdNode.value.includes("$")) base = path.resolve(root, wdNode.value);
    for (const h of hitsFromLines(shellLines(n))) {
      if (h.bare || h.tok.s.includes("$") || path.isAbsolute(h.tok.s)) continue;
      refs.push({ line: h.line, col: h.tok.col, len: h.tok.len, target: path.join(base, h.tok.s), direct: h.direct });
    }
  }
  return refs;
}

function extractGitlab(text, root) {
  const doc = parseYaml(text);
  const refs = [];
  const underVariables = (n) => {
    for (let p = n.parent; p; p = p.parent) if (p.key === "variables") return true;
    return false;
  };
  for (const n of allNodes(doc)) {
    if (!n.key || !/^(before_|after_)?script$/.test(n.key) || underVariables(n)) continue;
    for (const h of hitsFromLines(shellLines(n))) {
      if (h.bare || h.tok.s.includes("$") || path.isAbsolute(h.tok.s)) continue;
      refs.push({ line: h.line, col: h.tok.col, len: h.tok.len, target: path.join(root, h.tok.s), direct: h.direct });
    }
  }
  return refs;
}

/** Backward-compatible entry point for the YAML launchers. */
function extractYamlRuns(text, file, root, kind) {
  if (kind === "gha") return extractGha(text, root);
  if (kind === "gitlab") return extractGitlab(text, root);
  if (kind === "compose") return analyzeCompose(text, file, root, {}).refs;
  return [];
}

// ---------------------------------------------------------------- docker-compose

function composeBuild(svc, composeDir) {
  const b = child(svc, "build");
  if (!b) return null;
  let context = ".";
  let dockerfile = "Dockerfile";
  let target = null;
  if (b.value) context = b.value;
  else {
    const c = child(b, "context");
    const d = child(b, "dockerfile");
    const t = child(b, "target");
    if (child(b, "dockerfile_inline")) return null;
    if (c && c.value) context = c.value;
    if (d && d.value) dockerfile = d.value;
    if (t && t.value) target = t.value;
  }
  if (/^[a-z]+:\/\//i.test(context) || /^git@/.test(context) || context.includes("$") || dockerfile.includes("$")) return null;
  const ctx = path.resolve(composeDir, context);
  return { ctx, dockerfile: path.resolve(ctx, dockerfile), target };
}

function composeMounts(svc, composeDir) {
  const out = [];
  const vols = child(svc, "volumes");
  if (!vols) return out;
  for (const it of vols.items) {
    let host = null;
    let target = null;
    if (typeof it.value === "string" && it.value) {
      const parts = it.value.split(":");
      if (parts.length < 2 || /^[A-Za-z]$/.test(parts[0])) continue;
      host = parts[0];
      target = parts[1];
    } else {
      const type = child(it, "type");
      const src = child(it, "source");
      const tgt = child(it, "target");
      if (type && type.value !== "bind") continue;
      host = src && src.value;
      target = tgt && tgt.value;
    }
    if (!host || !target || host.includes("$") || target.includes("$") || host.startsWith("~")) continue;
    if (!/^(\.|\/)/.test(host)) continue; // named volume
    out.push({ host: path.resolve(composeDir, host), target: posix.resolve("/", target) });
  }
  return out;
}

/**
 * Analyze a compose file. `env.readDockerfile(abs)` returns the Dockerfile text (confined) or
 * null; `env.dockerCache` memoizes analyses. Returns { refs, builds: [{dockerfile, ctx}] }.
 *
 * A script named in `entrypoint:`/`command:` runs inside the container, so its path is a
 * container path. It is resolved, in order, through the service's bind mounts (volumes), then
 * through the service's Dockerfile COPY/ADD/WORKDIR map, and finally (relative paths only)
 * from the compose file's folder.
 */
function analyzeCompose(text, file, root, env) {
  const doc = parseYaml(text);
  const composeDir = path.dirname(file);
  const services = child(doc, "services");
  const refs = [];
  const builds = [];
  if (!services) return { refs, builds };
  const cache = (env && env.dockerCache) || new Map();
  const readDf = (env && env.readDockerfile) || ((p) => {
    const b = readConfined(root, p, MAX_LAUNCHER_BYTES);
    return b ? b.toString("utf8") : null;
  });
  for (const svc of services.children) {
    const build = composeBuild(svc, composeDir);
    let df = null;
    if (build) {
      builds.push({ dockerfile: build.dockerfile, ctx: build.ctx });
      const key = build.dockerfile + "\0" + build.ctx;
      if (!cache.has(key)) {
        const t = readDf(build.dockerfile);
        cache.set(key, t === null ? null : analyzeDockerfile(t, build.dockerfile, [build.ctx], root));
      }
      df = cache.get(key);
    }
    const mounts = composeMounts(svc, composeDir);
    const wd = child(svc, "working_dir");
    const cwdIn = wd && wd.value && !wd.value.includes("$") ? posix.resolve("/", wd.value) : df ? df.workdirOf(build.target) : null;
    for (const key of ["entrypoint", "command"]) {
      const n = child(svc, key);
      if (!n) continue;
      let hits = [];
      if (n.flow || n.items.length) {
        // exec form: list of argv strings
        const toks = n.flow ? n.flow.map((t) => ({ s: t.s, col: t.col, len: t.len, quoted: t.quoted, line: n.line })) : n.items.filter((it) => typeof it.value === "string").map((it) => ({ s: it.value, col: it.valueCol, len: it.value.length, line: it.valueLine }));
        const first = toks[0];
        stripPrefixes(toks);
        hits = scriptsFromTokens(toks).map((h) => Object.assign({ line: h.tok.line !== undefined ? h.tok.line : first ? first.line : n.line }, h));
        // Nested `sh -c` strings keep the line of the -c token
        for (const h of hits) if (h.line === undefined) h.line = n.line;
      } else {
        hits = hitsFromLines(shellLines(n));
      }
      for (const h of hits) {
        const p = h.tok.s;
        if (p.includes("$")) continue;
        let target = null;
        let chmodded = false;
        let containerPath = null;
        let viaDockerfile = false;
        const cands = h.bare ? PATH_DIRS.map((d) => d + "/" + p) : posix.isAbsolute(p) ? [p] : cwdIn ? [posix.resolve(cwdIn, p)] : [];
        for (const cpath of cands) {
          for (const m of mounts) {
            const prefix = m.target.endsWith("/") ? m.target : m.target + "/";
            if (cpath === m.target) target = m.host;
            else if (cpath.startsWith(prefix)) target = path.join(m.host, cpath.slice(prefix.length));
            if (target && isFile(target)) break;
            target = null;
          }
          if (target) {
            containerPath = cpath;
            break;
          }
        }
        if (!target && df) {
          const r = h.bare ? df.resolve(build.target, p) : cands.length ? df.resolve(build.target, cands[0]) : null;
          if (r) {
            target = r.local;
            chmodded = r.chmod;
            containerPath = r.cpath;
            viaDockerfile = true;
          }
        }
        if (!target && !h.bare && !posix.isAbsolute(p)) {
          const local = path.join(composeDir, p);
          if (isFile(local)) target = local;
        }
        if (!target) continue;
        refs.push({ line: h.line, col: h.tok.col, len: h.tok.len, target, direct: h.direct, chmodded, containerPath, viaDockerfile });
      }
    }
  }
  return { refs, builds };
}

// ---------------------------------------------------------------- package.json

function extractPackageJson(text, file) {
  const refs = [];
  let json;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (_e) {
    return refs;
  }
  if (!json || typeof json.scripts !== "object" || Array.isArray(json.scripts) || !json.scripts) return refs;
  const lines = text.split(/\r?\n/);
  let from = lines.findIndex((l) => /"scripts"\s*:/.test(l));
  if (from < 0) from = 0;
  for (const [name, cmd] of Object.entries(json.scripts)) {
    if (typeof cmd !== "string") continue;
    const key = JSON.stringify(name);
    let li = -1;
    for (let k = from; k < lines.length; k++) {
      if (new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:").test(lines[k])) {
        li = k;
        break;
      }
    }
    if (li < 0) li = from;
    const enc = JSON.stringify(cmd);
    const at = lines[li].indexOf(enc, lines[li].indexOf(key) + key.length);
    const valCol = at >= 0 ? at + 1 : 0;
    for (const h of commandHeads(cmd, valCol)) {
      for (const hit of scriptsFromTokens(h)) {
        if (hit.bare || path.isAbsolute(hit.tok.s)) continue;
        refs.push({ line: li, col: hit.tok.col, len: hit.tok.len, target: path.join(path.dirname(file), hit.tok.s), direct: hit.direct });
      }
    }
  }
  return refs;
}

// ---------------------------------------------------------------- script checks

/** Returns list of {code, sev, msg} for the script bytes. null if binary/unreadable. */
function checkScript(buf, direct) {
  const head = buf.subarray(0, 4096);
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return null; // ELF
  if (head.includes(0)) return null; // binary
  const issues = [];
  const bom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");
  if (bom) issues.push({ code: "EC003", sev: "Error", msg: "script starts with a UTF-8 BOM, so the kernel cannot see the `#!` shebang (\"exec format error\" / \"not found\"). Strip the BOM." });
  if (/\r\n/.test(text)) issues.push({ code: "EC001", sev: "Error", msg: "script has CRLF (Windows) line endings; on Linux the interpreter becomes e.g. `/bin/sh\\r` (\"no such file or directory\") and lines fail with `$'\\r': command not found`. Convert to LF and add `*.sh text eol=lf` to .gitattributes." });
  if (direct) {
    const first = text.split("\n", 1)[0].replace(/\r$/, "");
    if (!first.startsWith("#!")) issues.push({ code: "EC002", sev: "Error", msg: "directly-executed script has no `#!` shebang on line 1, so exec fails with \"exec format error\". Add e.g. `#!/bin/sh`." });
    else if (!/^#!\s*\/\S+/.test(first)) issues.push({ code: "EC002", sev: "Error", msg: "shebang `" + first + "` is invalid: the interpreter must be an absolute path (e.g. `#!/usr/bin/env bash`)." });
  }
  return issues;
}

/**
 * Husky v5-v8 hooks (the ones that source `_/husky.sh`) are executed by git directly, so they
 * need a shebang and the exec bit. Husky v9 hooks are plain files run with `sh -e`, so only
 * CRLF and BOM can break them.
 */
function huskyHookIsDirect(text) {
  return /husky\.sh/.test(text);
}

// ---------------------------------------------------------------- git (hardened)

function hardenedGitEnv() {
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  });
  for (const k of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_COMMON_DIR",
    "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CEILING_DIRECTORIES",
  ]) delete env[k];
  return env;
}

// core.fsmonitor= (empty) disables a repo-configured fsmonitor program; hooksPath at the null
// device means no hook can run. `-C <root>` is used instead of cwd=<root> so a `git` binary
// planted in the workspace can never be picked up by a cwd-first executable search.
const GIT_LEADING_ARGS = ["-c", "core.fsmonitor=", "-c", "core.hooksPath=" + NULL_DEVICE, "-c", "core.quotePath=false", "--no-pager"];
const SAFE_CWD = __dirname;

function runGit(dir, args, o) {
  const opts = o || {};
  return new Promise((resolve) => {
    try {
      execFile(
        opts.gitPath || "git",
        ["-C", dir].concat(GIT_LEADING_ARGS, args),
        { cwd: SAFE_CWD, env: hardenedGitEnv(), timeout: opts.timeout || 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false },
        (err, stdout) => resolve({ ok: !err, stdout: String(stdout || "") })
      );
    } catch (_e) {
      resolve({ ok: false, stdout: "" });
    }
  });
}

/** Map<rel, mode> for the given root-relative paths, read from git's index with `ls-files -s`. */
async function gitModes(realRoot, rels, o) {
  const out = new Map();
  const list = Array.from(new Set(rels));
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    const r = await runGit(realRoot, ["ls-files", "-s", "-z", "--"].concat(chunk), o);
    if (!r.ok) continue;
    for (const rec of r.stdout.split("\0")) {
      const m = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/.exec(rec);
      if (m) out.set(m[2], m[1]);
    }
  }
  return out;
}

/** Single-file variant kept for compatibility. */
async function gitMode(root, file, o) {
  const realRoot = realpathOr(root);
  if (!realRoot) return null;
  const rel = toRel(realRoot, file);
  const m = await gitModes(realRoot, [rel], o);
  return m.get(rel) || null;
}

const EOL_LINE_RE = /^\s*(\*|\*\.sh|\*\.bash|\S*\.sh)\s.*\beol=lf\b/;

function eolRuleIn(text) {
  return text.split(/\r?\n/).some((l) => EOL_LINE_RE.test(l));
}

/** Reads <root>/.gitattributes only when it is a regular file inside the workspace. */
function hasEolRule(root) {
  const p = path.join(root, ".gitattributes");
  try {
    if (fs.lstatSync(p).isSymbolicLink()) return false;
  } catch (_e) {
    return false;
  }
  const b = readConfined(root, p, 1024 * 1024);
  return b ? eolRuleIn(b.toString("utf8")) : false;
}

// ---------------------------------------------------------------- scan

/**
 * Scan one workspace folder.
 * Returns { findings, launchers, watched, truncated } where each finding is
 * { file, kind, line, col, len, code, severity, message, script, scriptRel, launcherRel, containerPath }.
 * `opts.trusted` controls whether git is invoked (EC004).
 */
async function scanFolderDetailed(root, opts) {
  const trusted = !!(opts && opts.trusted);
  const realRoot = realpathOr(root);
  const result = { findings: [], launchers: [], watched: new Set(), truncated: false };
  if (!realRoot) return result;
  const { files, truncated } = await walk(root);
  result.truncated = truncated;
  result.launchers = files.map((f) => f.file);
  for (const f of files) result.watched.add(f.file);
  result.watched.add(path.join(root, ".gitattributes"));
  result.watched.add(path.join(root, ".git", "index"));

  const readLauncher = (p) => {
    const b = readConfined(root, p, MAX_LAUNCHER_BYTES);
    return b ? b.toString("utf8") : null;
  };
  const dockerCache = new Map();
  const dfContexts = new Map();
  const composeRefs = new Map();
  for (const f of files) {
    if (f.kind !== "compose") continue;
    const text = readLauncher(f.file);
    if (text === null) continue;
    const c = analyzeCompose(text, f.file, root, { readDockerfile: readLauncher, dockerCache });
    composeRefs.set(f.file, c.refs);
    for (const b of c.builds) {
      const real = confined(root, b.dockerfile);
      if (!real || !confined(root, b.ctx)) continue;
      if (!dfContexts.has(real)) dfContexts.set(real, []);
      if (!dfContexts.get(real).includes(b.ctx)) dfContexts.get(real).push(b.ctx);
    }
  }

  const pending = [];
  for (const f of files) {
    let refs;
    if (f.kind === "compose") refs = composeRefs.get(f.file) || [];
    else {
      const text = readLauncher(f.file);
      if (text === null) continue;
      if (f.kind === "dockerfile") {
        const real = realpathOr(f.file);
        const extra = (real && dfContexts.get(real)) || [];
        refs = extractDockerfile(text, f.file, [path.dirname(f.file)].concat(extra.filter((c) => c !== path.dirname(f.file))), root);
      } else if (f.kind === "package") refs = extractPackageJson(text, f.file);
      else if (f.kind === "husky") refs = [{ line: 0, col: 0, len: Math.max(1, text.split(/\r?\n/, 1)[0].length), target: f.file, direct: huskyHookIsDirect(text), self: true }];
      else if (f.kind === "gha") refs = extractGha(text, root);
      else refs = extractGitlab(text, root);
    }
    for (const r of refs) pending.push({ f, r });
  }

  const seen = new Set();
  const add = (f) => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    result.findings.push(f);
  };
  const launcherRel = (p) => toRel(realRoot, p);
  const needMode = [];
  let firstShRef = null;
  for (const { f, r } of pending) {
    if (!r.target) continue;
    const real = confined(root, r.target); // never read files outside the workspace
    if (!real) continue;
    result.watched.add(real);
    const buf = readConfined(root, real, MAX_SCRIPT_BYTES);
    if (!buf) continue;
    const issues = checkScript(buf, r.direct);
    if (!issues) continue;
    const scriptRel = path.relative(realRoot, real).split(path.sep).join("/");
    const base = { file: f.file, kind: f.kind, launcherRel: launcherRel(f.file), line: r.line, col: r.col, len: r.len, script: real, scriptRel, containerPath: r.containerPath || null };
    if (/\.(sh|bash)$/.test(real) && !firstShRef) firstShRef = base;
    for (const is of issues) {
      add(Object.assign({}, base, { code: is.code, severity: is.sev, message: (r.self ? "git hook: " : scriptRel + ": ") + is.msg, key: [f.file, r.line, r.col, is.code, real].join("|") }));
    }
    if (trusted && r.direct && !r.chmodded) needMode.push({ base, r, scriptRel, kind: f.kind });
  }
  if (needMode.length) {
    const modes = await gitModes(realRoot, needMode.map((n) => n.scriptRel), opts);
    for (const { base, r, scriptRel, kind } of needMode) {
      if (modes.get(scriptRel) !== "100644") continue;
      const hint = kind === "dockerfile" || r.viaDockerfile ? " or add `RUN chmod +x " + (r.containerPath || scriptRel) + "` to the Dockerfile" : "";
      add(Object.assign({}, base, {
        code: "EC004",
        severity: "Warning",
        message: scriptRel + ": not executable in git (mode 100644), so it fails with \"permission denied\" after checkout. Run `git update-index --chmod=+x " + scriptRel + "`" + hint + ".",
        key: [base.file, base.line, base.col, "EC004", base.script].join("|"),
      }));
    }
  }
  if (firstShRef && !hasEolRule(root)) {
    add(Object.assign({}, firstShRef, {
      code: "EC005",
      severity: "Information",
      message: "No .gitattributes eol rule for shell scripts: a Windows checkout (core.autocrlf=true) will turn them CRLF. Add `*.sh text eol=lf`.",
      key: [firstShRef.file, firstShRef.line, firstShRef.col, "EC005"].join("|"),
    }));
  }
  const order = { EC001: 1, EC002: 2, EC003: 3, EC004: 4, EC005: 5 };
  result.findings.sort((a, b) => (a.launcherRel < b.launcherRel ? -1 : a.launcherRel > b.launcherRel ? 1 : a.line - b.line || a.col - b.col || order[a.code] - order[b.code]));
  return result;
}

/** Map<launcher file, findings[]> - the original return shape. */
async function scanFolder(root, opts) {
  const r = await scanFolderDetailed(root, opts);
  const out = new Map();
  for (const f of r.findings) {
    if (!out.has(f.file)) out.set(f.file, []);
    out.get(f.file).push(f);
  }
  return out;
}

// ---------------------------------------------------------------- fixes (pure file operations)

/** Remove every CR that precedes an LF, byte-wise (no re-encoding). */
function crlfToLf(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

function stripBomBytes(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
}

/**
 * Append `*.sh text eol=lf` to <root>/.gitattributes. Refuses a symlinked or out-of-workspace
 * .gitattributes. Returns "added" | "present" | "refused".
 */
function appendGitattributes(root) {
  const ga = path.join(root, ".gitattributes");
  let cur = "";
  let exists = false;
  try {
    const st = fs.lstatSync(ga);
    if (st.isSymbolicLink() || !st.isFile()) return "refused";
    exists = true;
  } catch (_e) { /* new file */ }
  if (exists) {
    const b = readConfined(root, ga, 1024 * 1024);
    if (!b) return "refused";
    cur = b.toString("utf8");
    if (eolRuleIn(cur)) return "present";
  }
  if (!realpathOr(root)) return "refused";
  const nl = cur.includes("\r\n") ? "\r\n" : "\n";
  const data = cur + (cur && !/\r?\n$/.test(cur) ? nl : "") + "*.sh text eol=lf" + nl;
  // `wx` on a new file: never follows a symlink planted between the check and the write.
  if (exists) fs.writeFileSync(confined(root, ga), data);
  else fs.writeFileSync(ga, data, { flag: "wx" });
  return "added";
}

module.exports = {
  RULES,
  KIND_LABEL,
  SHELLS,
  classify,
  walk,
  commandHeads,
  scriptFromTokens,
  scriptsFromTokens,
  looksLikePath,
  parseYaml,
  analyzeDockerfile,
  extractDockerfile,
  analyzeCompose,
  extractGha,
  extractGitlab,
  extractYamlRuns,
  extractPackageJson,
  checkScript,
  huskyHookIsDirect,
  hardenedGitEnv,
  GIT_LEADING_ARGS,
  runGit,
  gitModes,
  gitMode,
  hasEolRule,
  eolRuleIn,
  isInside,
  confined,
  insideRoot,
  readConfined,
  scanFolder,
  scanFolderDetailed,
  crlfToLf,
  stripBomBytes,
  appendGitattributes,
};
