import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = process.cwd();
const common = join(repository, "containers", "start-common.sh");
const template = join(repository, "containers", "workspace", "AGENTS.initial.md");

function bootstrap(workspace, repo = repository) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; bootstrap_workspace "$2" "$3" "$4"', "bootstrap-test", common, workspace, repo, template],
    { encoding: "utf8" },
  );
}

test("initializes an external workspace and relative Claude link", () => {
  const parent = mkdtempSync(join(tmpdir(), "agent broadcast workspace "));
  const workspace = join(parent, "persistent files");
  const result = bootstrap(workspace);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), realpathSync(workspace));
  assert.equal(readFileSync(join(workspace, "AGENTS.md"), "utf8"), readFileSync(template, "utf8"));
  assert.equal(lstatSync(join(workspace, "CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(workspace, "CLAUDE.md")), "AGENTS.md");
  assert.equal(existsSync(join(workspace, ".git")), false);
});

test("preserves existing instructions and the correct symlink", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-broadcast-existing-"));
  writeFileSync(join(workspace, "AGENTS.md"), "custom instructions\n");
  const first = bootstrap(workspace);
  const second = bootstrap(workspace);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(workspace, "AGENTS.md"), "utf8"), "custom instructions\n");
  assert.equal(readlinkSync(join(workspace, "CLAUDE.md")), "AGENTS.md");
});

test("fails without overwriting a conflicting Claude file", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agent-broadcast-conflicting-link-"));
  writeFileSync(join(workspace, "CLAUDE.md"), "keep me\n");
  const result = bootstrap(workspace);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /will not be overwritten/);
  assert.equal(readFileSync(join(workspace, "CLAUDE.md"), "utf8"), "keep me\n");
});

test("rejects a workspace inside the source repository", () => {
  const workspace = join(repository, "temporary-workspace-test");
  const result = bootstrap(workspace);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be outside/);
});

function parseArguments(...argv) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; shift; parse_start_arguments codex "$@" && printf "workspace=%s\\n" "$WORKSPACE_PATH"',
      "parse-test",
      common,
      ...argv,
    ],
    { encoding: "utf8" },
  );
}

test("reports a failed workspace bootstrap instead of running with an empty path", () => {
  const workspace = join(repository, "temporary-workspace-parse-test");
  const result = parseArguments("--workspace", workspace, "--nick", "probe");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be outside/);
  assert.doesNotMatch(result.stdout, /workspace=/);
});
