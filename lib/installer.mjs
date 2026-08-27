import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const DEFAULT_URL = "https://agent-broadcast-mcp.vercel.app/api/mcp";
export const MCP_NAME = "agent-broadcast-start";
const MANAGED_MARKER = ".agent-broadcast-managed";
const SOURCE_SKILL = fileURLToPath(
  new URL("../plugins/agent-broadcast/skills/agent-broadcast-start", import.meta.url),
);

export const USAGE = `Usage:
  npx --yes github:andrzejdus/agent-broadcast-mcp install (--codex | --claude) [options]
  npx --yes github:andrzejdus/agent-broadcast-mcp join (--codex | --claude) --scope <scope> --nick <name> [options]

Install copies the ${MCP_NAME} skill and registers the MCP server in one command.
Legacy invocations without "install" or "join" continue to use join mode.

Options:
  --codex | --claude  Target harness (exactly one)
  --scope <scope>     install: defaults to user; Claude also accepts local/project
                      join: session/user for Codex; session/local/user/project for Claude
  --nick <name>       Optional install nickname; required for join mode
  --url <url>         MCP endpoint (default: ${DEFAULT_URL})
  --force             Replace a managed skill or conflicting MCP registration
  --print             Show actions without changing files or harness configuration
`;

export function parseArgs(argv) {
  const args = [...argv];
  const explicitCommand = args[0] && !args[0].startsWith("-") ? args.shift() : undefined;
  const command = explicitCommand ?? "join";
  if (!["install", "join"].includes(command)) throw new Error(`Unknown command: ${command}`);

  const options = { command, url: DEFAULT_URL, force: false, print: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--nick") options.nick = requiredValue(args, ++index, argument);
    else if (argument === "--scope") options.scope = requiredValue(args, ++index, argument);
    else if (argument === "--url") options.url = requiredValue(args, ++index, argument);
    else if (argument === "--claude") options.claude = true;
    else if (argument === "--codex") options.codex = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--print") options.print = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  if (options.help) return options;
  if (Boolean(options.claude) === Boolean(options.codex)) {
    throw new Error("Pass exactly one of --claude or --codex.");
  }
  options.harness = options.claude ? "claude" : "codex";
  options.scope ??= command === "install" ? "user" : undefined;
  validateScope(options);
  if (command === "join" && !options.nick) throw new Error("--nick is required in join mode.");
  return options;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function validateScope(options) {
  if (!options.scope) throw new Error("--scope is required in join mode.");
  const scopes =
    options.command === "install"
      ? options.claude
        ? ["local", "user", "project"]
        : ["user"]
      : options.claude
        ? ["session", "local", "user", "project"]
        : ["session", "user"];
  if (!scopes.includes(options.scope)) {
    throw new Error(`--scope for ${options.harness} ${options.command} must be one of: ${scopes.join(", ")}`);
  }
}

export function serverUrl(options) {
  if (!options.nick) return options.url;
  const url = new URL(options.url);
  url.searchParams.set("nick", options.nick);
  return url.toString();
}

export function joinCommand(options) {
  const url = serverUrl(options);
  if (options.claude) {
    if (options.scope === "session") {
      return [
        "claude",
        "--mcp-config",
        JSON.stringify({ mcpServers: { [MCP_NAME]: { type: "http", url } } }),
      ];
    }
    return ["claude", "mcp", "add", "--transport", "http", "--scope", options.scope, MCP_NAME, url];
  }
  if (options.scope === "session") {
    return ["codex", "-c", `mcp_servers.${MCP_NAME}.url=${JSON.stringify(url)}`];
  }
  return ["codex", "mcp", "add", MCP_NAME, "--url", url];
}

export function skillTargets(options, installRoot = homedir()) {
  const shared = join(installRoot, ".agents", "skills", MCP_NAME);
  const claude = join(installRoot, ".claude", "skills", MCP_NAME);
  return { shared, claude };
}

export function installSkill(options, dependencies = {}) {
  const source = dependencies.sourceSkill ?? SOURCE_SKILL;
  const targets = skillTargets(options, dependencies.installRoot);
  if (!existsSync(join(source, "SKILL.md"))) throw new Error(`Bundled skill is missing: ${source}`);

  replaceManagedDirectory(source, targets.shared, options.force);
  if (options.claude) ensureClaudeLink(targets.shared, targets.claude, options.force);
  return targets;
}

function replaceManagedDirectory(source, target, force) {
  if (existsSync(target) && !existsSync(join(target, MANAGED_MARKER)) && !force) {
    throw new Error(`${target} already exists and is not installer-managed; rerun with --force to replace it.`);
  }

  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.staging-${process.pid}`;
  const backup = `${target}.backup-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(source, staging, { recursive: true });
  writeFileSync(join(staging, MANAGED_MARKER), "managed by agent-broadcast-mcp\n", { mode: 0o644 });

  let backedUp = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      backedUp = true;
    }
    renameSync(staging, target);
    if (backedUp) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (backedUp && !existsSync(target)) renameSync(backup, target);
    throw error;
  }
}

function ensureClaudeLink(shared, link, force) {
  mkdirSync(dirname(link), { recursive: true });
  const expected = relative(dirname(link), shared);
  if (existsSync(link) || isSymlink(link)) {
    if (isSymlink(link) && readlinkSync(link) === expected) return;
    if (!force) throw new Error(`${link} exists and does not point to ${shared}; rerun with --force to replace it.`);
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(expected, link);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function configureMcp(options, dependencies = {}) {
  const spawn = dependencies.spawn ?? spawnSync;
  const url = serverUrl(options);
  const get = options.codex
    ? ["codex", ["mcp", "get", MCP_NAME, "--json"]]
    : ["claude", ["mcp", "get", MCP_NAME]];
  const existing = spawn(get[0], get[1], { encoding: "utf8" });

  if (existing.status === 0) {
    const output = `${existing.stdout ?? ""}\n${existing.stderr ?? ""}`;
    if (output.includes(url)) return { changed: false, command: get };
    if (!options.force) {
      throw new Error(`${MCP_NAME} is already registered with different settings; rerun with --force to replace it.`);
    }
    const remove = options.codex
      ? ["codex", ["mcp", "remove", MCP_NAME]]
      : ["claude", ["mcp", "remove", "--scope", options.scope, MCP_NAME]];
    runCommand(remove, spawn);
  }

  const command = joinCommand(options);
  runCommand([command[0], command.slice(1)], spawn);
  return { changed: true, command };
}

function runCommand([executable, args], spawn) {
  const result = spawn(executable, args, { stdio: "inherit" });
  if (result.error?.code === "ENOENT") throw new Error(`${executable} was not found on PATH.`);
  if (result.status !== 0) throw new Error(`${executable} exited with status ${result.status ?? "unknown"}.`);
}

export function runCli(argv, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const options = parseArgs(argv);
  if (options.help) {
    log(USAGE);
    return 0;
  }

  if (options.print) {
    if (options.command === "install") {
      const targets = skillTargets(options, dependencies.installRoot);
      log(`install skill: ${targets.shared}`);
      if (options.claude) log(`link Claude skill: ${targets.claude}`);
    }
    log(joinCommand(options).map(shellQuote).join(" "));
    return 0;
  }

  if (options.command === "install") installSkill(options, dependencies);
  if (options.command === "install") configureMcp(options, dependencies);
  else runCommand([joinCommand(options)[0], joinCommand(options).slice(1)], dependencies.spawn ?? spawnSync);
  return 0;
}

export function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
