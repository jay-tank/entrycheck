# Changelog

## 0.1.0

- Initial release.
- EC001 CRLF line endings (Quick Fix: convert to LF, add `.gitattributes` rule).
- EC002 missing or invalid shebang in directly-executed scripts.
- EC003 UTF-8 BOM before the shebang (Quick Fix: strip).
- EC004 script not executable in git index (trusted workspaces only).
- EC005 no `.gitattributes` eol rule for `*.sh`.
- Sources: Dockerfile ENTRYPOINT/CMD/RUN (COPY/ADD, WORKDIR, multi-stage COPY --from, RUN --mount, heredocs, bare names on PATH), docker-compose `entrypoint`/`command` (resolved through bind mounts and the service's Dockerfile, so absolute container paths work), GitHub Actions `run` (with `working-directory`), GitLab CI `script`/`before_script`/`after_script`, package.json scripts, Husky hooks (v9 aware).
- Activity bar view "Failing scripts": findings grouped by the launching file, rows named after the exact script, inline Convert to LF / Strip BOM / Add .gitattributes / Open script, badge with the count, empty states for nothing found, turned off and Restricted Mode.
- Setting `entrycheck.enabled`.
- Security: scripts, Dockerfiles and `.gitattributes` are only read, reported on or rewritten when they resolve (after symlinks) inside the workspace folder; git runs with `-C`, no shell, fsmonitor and hooks off, and global/system config ignored.
