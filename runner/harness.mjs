import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA_PATH = fileURLToPath(new URL("./decision.schema.json", import.meta.url));

export class HarnessAdapter {
  constructor(kind, options = {}) {
    if (!['codex', 'claude'].includes(kind)) throw new Error(`unsupported harness: ${kind}`);
    this.kind = kind;
    this.cwd = options.cwd ?? "/workspace";
    this.spawn = options.spawn ?? spawn;
    this.model = options.model;
  }

  async decide(prompt, sessionId) {
    const { command, args } = this.command(sessionId);
    const result = await runProcess(this.spawn, command, args, prompt, this.cwd);
    return this.kind === "codex" ? parseCodex(result) : parseClaude(result);
  }

  command(sessionId) {
    if (this.kind === "codex") {
      const common = [
        "--json",
        "--skip-git-repo-check",
        "--output-schema",
        SCHEMA_PATH,
        ...(this.model ? ["--model", this.model] : []),
      ];
      return sessionId
        ? { command: "codex", args: ["exec", "resume", ...common, sessionId, "-"] }
        : {
            command: "codex",
            args: ["exec", ...common, "--sandbox", "workspace-write", "--cd", this.cwd, "-"],
          };
    }

    const schema = JSON.stringify(JSON.parse(readSchema()));
    return {
      command: "claude",
      args: [
        "--print",
        "--output-format",
        "json",
        "--json-schema",
        schema,
        "--permission-mode",
        "dontAsk",
        "--allowed-tools",
        "Read,Glob,Grep",
        ...(this.model ? ["--model", this.model] : []),
        ...(sessionId ? ["--resume", sessionId] : []),
      ],
    };
  }
}

let schemaText;
function readSchema() {
  if (!schemaText) schemaText = readFileSync(SCHEMA_PATH, "utf8");
  return schemaText;
}

async function runProcess(spawnImpl, command, args, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
    child.stdin.end(input);
  });
}

function parseCodex({ stdout }) {
  let sessionId;
  let response;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "thread.started") sessionId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      response = event.item.text;
    }
  }
  if (!response) throw new Error("Codex returned no final agent message");
  return { sessionId, decision: parseDecision(response) };
}

function parseClaude({ stdout }) {
  const result = JSON.parse(stdout);
  const response = result.structured_output ?? result.result;
  return {
    sessionId: result.session_id,
    decision: typeof response === "string" ? parseDecision(response) : response,
  };
}

export function parseDecision(value) {
  if (value && typeof value === "object") return value;
  const text = String(value).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("harness response is not a JSON decision");
  }
}
