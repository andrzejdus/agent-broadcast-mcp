import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StateStore {
  constructor(path) {
    this.path = path;
  }

  load(now = Date.now()) {
    try {
      return {
        cursor: 0,
        sessionId: undefined,
        lastSentAt: 0,
        lastProactiveAt: 0,
        lastRoomActivity: now,
        ...JSON.parse(readFileSync(this.path, "utf8")),
      };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return {
        cursor: 0,
        sessionId: undefined,
        lastSentAt: 0,
        lastProactiveAt: 0,
        lastRoomActivity: now,
      };
    }
  }

  save(state) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
