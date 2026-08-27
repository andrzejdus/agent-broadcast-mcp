import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import {
  installSkill,
  joinCommand,
  MCP_NAME,
  parseArgs,
  runCli,
  serverUrl,
} from "../lib/installer.mjs";

const sourceSkill = join(process.cwd(), "plugins", "agent-broadcast", "skills", MCP_NAME);

test("parses one-command install defaults", () => {
  const options = parseArgs(["install", "--codex"]);
  assert.equal(options.command, "install");
  assert.equal(options.scope, "user");
  assert.equal(serverUrl(options), "https://agent-broadcast-mcp.vercel.app/api/mcp");
  assert.deepEqual(joinCommand(options), [
    "codex",
    "mcp",
    "add",
    MCP_NAME,
    "--url",
    "https://agent-broadcast-mcp.vercel.app/api/mcp",
  ]);
});

test("preserves legacy join syntax and adds nickname to the URL", () => {
  const options = parseArgs(["--claude", "--scope", "session", "--nick", "alice smith"]);
  assert.equal(options.command, "join");
  assert.match(joinCommand(options)[2], /alice\+smith/);
  assert.match(joinCommand(options)[2], new RegExp(MCP_NAME));
});

test("installs a managed shared skill and Claude compatibility link", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "agent-broadcast-install-"));
  const options = parseArgs(["install", "--claude"]);
  const targets = installSkill(options, { installRoot, sourceSkill });

  assert.equal(existsSync(join(targets.shared, "SKILL.md")), true);
  assert.equal(existsSync(join(targets.shared, ".agent-broadcast-managed")), true);
  assert.equal(readlinkSync(targets.claude), `../../.agents/skills/${MCP_NAME}`);

  writeFileSync(join(targets.shared, "stale.txt"), "stale");
  installSkill(options, { installRoot, sourceSkill });
  assert.equal(existsSync(join(targets.shared, "stale.txt")), false);
});

test("preserves an unmanaged skill unless force is explicit", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "agent-broadcast-conflict-"));
  const target = join(installRoot, ".agents", "skills", MCP_NAME);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "user content");
  const options = parseArgs(["install", "--codex"]);

  assert.throws(() => installSkill(options, { installRoot, sourceSkill }), /not installer-managed/);
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "user content");
  installSkill({ ...options, force: true }, { installRoot, sourceSkill });
  assert.match(readFileSync(join(target, "SKILL.md"), "utf8"), /name: agent-broadcast-start/);
});

test("print mode performs no writes or harness execution", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "agent-broadcast-print-"));
  const output = [];
  let spawned = false;
  const status = runCli(["install", "--claude", "--nick", "alice", "--print"], {
    installRoot,
    sourceSkill,
    log: (line) => output.push(line),
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
  });

  assert.equal(status, 0);
  assert.equal(spawned, false);
  assert.equal(existsSync(join(installRoot, ".agents")), false);
  assert.match(output.join("\n"), /agent-broadcast-start/);
});

test("install skips an identical MCP registration", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "agent-broadcast-idempotent-"));
  const calls = [];
  runCli(["install", "--codex"], {
    installRoot,
    sourceSkill,
    spawn: (command, args) => {
      calls.push([command, args]);
      return {
        status: 0,
        stdout: JSON.stringify({ url: "https://agent-broadcast-mcp.vercel.app/api/mcp" }),
        stderr: "",
      };
    },
  });
  assert.deepEqual(calls, [["codex", ["mcp", "get", MCP_NAME, "--json"]]]);
});
