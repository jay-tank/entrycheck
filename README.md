# EntryCheck: Fix exec format error in Docker & CI Scripts

Your image builds fine, then the container dies instantly with one of these:

```
exec /entrypoint.sh: exec format error
/usr/bin/env: 'bash\r': No such file or directory
exec: "./start.sh": permission denied
```

Nothing is wrong with the logic. The script has Windows line endings, a missing shebang, an invisible UTF-8 BOM, or it was committed without the executable bit. EntryCheck finds the scripts your Dockerfiles, compose files, CI workflows, npm scripts and git hooks actually execute, and flags those problems right on the line that runs them - before you push.

## What it checks

| Rule | Severity | Problem | Fix |
| :--- | :--- | :--- | :--- |
| EC001 | Error | CRLF line endings in a script that runs on Linux | Quick Fix: convert to LF, or add `*.sh text eol=lf` to `.gitattributes` |
| EC002 | Error | Directly-executed script has no `#!` shebang, or the interpreter is not an absolute path | Add e.g. `#!/bin/sh` or `#!/usr/bin/env bash` |
| EC003 | Error | UTF-8 BOM before the shebang hides `#!` from the kernel | Quick Fix: strip the BOM |
| EC004 | Warning | Script is mode `100644` in git, so it is not executable after checkout | `git update-index --chmod=+x path/to/script.sh` or `RUN chmod +x` in the Dockerfile |
| EC005 | Information | No `.gitattributes` eol rule for shell scripts | Quick Fix: add `*.sh text eol=lf` |

Each diagnostic sits on the referencing line (for example the `ENTRYPOINT` in your Dockerfile) and links to the script itself.

- **Activity bar**: an EntryCheck view lists every failing script, grouped by the file that launches it (Dockerfile, compose file, workflow, package.json, Husky hook). Each row names the rule and the exact script, for example `EC001  docker/entrypoint.sh`, with the rule and line next to it. Click a row to jump to the launching line. Inline buttons convert the script to LF, strip the BOM, add the `.gitattributes` rule or open the script. The icon shows a badge with the number of problems.

## Where it looks

- **Dockerfile / Containerfile** - `ENTRYPOINT`, `CMD` and `RUN`, in exec form (`["/entrypoint.sh"]`), shell form, `["sh", "-c", "..."]` and `RUN <<EOF` heredocs. Container paths are mapped back to your build context through `COPY`/`ADD` (directories, globs, `--chmod`), `WORKDIR`, multi-stage `COPY --from=<stage>` and `RUN --mount=type=bind`. A bare name such as `ENTRYPOINT ["docker-entrypoint.sh"]` is looked up in the usual `PATH` folders (`/usr/local/bin` and friends).
- **docker-compose** - `entrypoint:` and `command:` in string or list form. These paths live inside the container, so they are resolved through the service's bind mounts (`volumes:`), then through its Dockerfile (`build.context`, `build.dockerfile`, `build.target`) and `working_dir`. An absolute path like `entrypoint: /opt/start.sh` is followed to the file the Dockerfile copied there. The Dockerfile itself is also checked with the build context from the compose file.
- **GitHub Actions** - `run:` steps, including multi-line `run: |` blocks, with `working-directory:` (step, job or workflow default) applied. Steps with a non-shell `shell:` (pwsh, python) are skipped.
- **GitLab CI** - `script:`, `before_script:` and `after_script:` entries.
- **package.json** - `scripts` entries that call `./something.sh`.
- **Husky** - hooks in `.husky/`. Husky 9 hooks are run with `sh`, so they are only checked for CRLF and BOM. Older hooks that source `husky.sh` are run by git and also need a shebang and the executable bit.

Only scripts that are executed directly (`./deploy.sh`, `/entrypoint.sh`) are checked for a shebang and the executable bit. Scripts run through an interpreter (`sh ./x.sh`, `bash x.sh`) are still checked for CRLF and BOM, which break them too. EC004 is skipped when the Dockerfile already does `RUN chmod +x` on the file (or its folder with `chmod -R`) or copies it with `COPY --chmod=755`.

## How this differs

ShellCheck lints the contents of a shell script and hadolint lints Dockerfile instructions. Neither follows an `ENTRYPOINT` or a CI `run:` line to the file it points at and checks that file's line endings, BOM, or executable bit in git. EntryCheck is that missing link between the two, and it complements them rather than replacing them.

## Privacy and Workspace Trust

EntryCheck only reads, reports on or rewrites files that resolve (after following symlinks) inside the open workspace folder. Script paths from `COPY`, compose `build:` and `volumes:`, CI `run:` lines or `package.json` that point outside the project are ignored, and a `.gitattributes` that is a symlink is never read or changed.

- No network access and no telemetry. Everything runs locally.
- The executable-bit check (EC004) reads git's index with `git ls-files -s`, run without a shell, with `core.fsmonitor` and hooks disabled and global/system git config ignored. It only runs in trusted workspaces. In an untrusted (Restricted Mode) workspace EntryCheck still runs EC001, EC002, EC003 and EC005, which only read files.
- Files are only changed when you pick a Quick Fix or an inline button, and never while the file has unsaved changes in the editor.

## Commands

- **EntryCheck: Rescan Workspace** - rescan all workspace folders. Scans also run automatically on save, when files change, and every few seconds for files that changed outside VS Code.

## Settings

- `entrycheck.enabled` (default `true`) - turn all checks off or on.

## Limitations

- Without a compose file, a Dockerfile's build context is assumed to be its own folder.
- Paths built from variables (`$APP_DIR/start.sh`, `${{ ... }}`) are skipped, and so are files copied from an external image (`COPY --from=nginx`).
- A compose `entrypoint:` with an absolute path is only resolved when the service has a bind mount or a `build:` whose Dockerfile copies that path. For an `image:`-only service the script is not in your workspace, so it is skipped.
- EC002 checks that the shebang is well formed, not that the interpreter exists in your image.

## License

MIT - included with the extension.
