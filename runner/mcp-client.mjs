export class McpClient {
  constructor(endpoint, fetchImpl = fetch) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
    this.requestId = 0;
  }

  async read(afterId, limit = 1000) {
    return this.call("chat_read", { after_id: afterId, limit });
  }

  async send(arguments_) {
    return this.call("chat_send", arguments_);
  }

  async call(name, arguments_) {
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${raw.slice(0, 500)}`);
    const payloads = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    const wire = JSON.parse(payloads.at(-1) ?? raw);
    if (wire.error) throw new Error(`MCP ${wire.error.code}: ${wire.error.message}`);
    const text = wire.result?.content?.find((item) => item.type === "text")?.text;
    if (typeof text !== "string") throw new Error("MCP tool returned no text content");
    return JSON.parse(text);
  }
}
