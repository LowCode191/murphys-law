// MCP / JSON-RPC 2.0 conformance of the stdio server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));

const TEMP_DIRS = [];
function freshHome(prefix = "murphys-mcpspec-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function exchange(lines) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [CLI, "mcp"], { env: { ...process.env, MURPHYS_HOME: freshHome() } });
    const chunks = [];
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.on("error", reject);
    proc.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    for (const line of lines) proc.stdin.write((typeof line === "string" ? line : JSON.stringify(line)) + "\n");
    proc.stdin.end();
  });
}

test("ping answers with an empty result", async () => {
  const [response] = await exchange([{ jsonrpc: "2.0", id: 9, method: "ping" }]);
  assert.deepEqual(response, { jsonrpc: "2.0", id: 9, result: {} });
});

test("batches and non-object JSON are Invalid Request (-32600, id null)", async () => {
  const responses = await exchange(['[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]', '"just a string"', "42", "null"]);
  assert.equal(responses.length, 4, "every invalid message gets an answer — silence hangs the client");
  for (const response of responses) {
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32600);
  }
});

test("a request without a method is Invalid Request, keeping its id", async () => {
  const [response] = await exchange([{ jsonrpc: "2.0", id: 4 }]);
  assert.equal(response.id, 4);
  assert.equal(response.error.code, -32600);
});

test("notifications get no response", async () => {
  const responses = await exchange([{ jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 1, method: "ping" }]);
  assert.deepEqual(responses.map((r) => r.id), [1]);
});

test("initialize negotiates protocolVersion and reports the package version", async () => {
  const [known, unknown] = await exchange([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  ]);
  assert.equal(known.result.protocolVersion, "2024-11-05", "a supported version is echoed");
  assert.notEqual(unknown.result.protocolVersion, "1999-01-01", "an unsupported version is never claimed");
  assert.match(unknown.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(known.result.serverInfo.version, PKG.version);
});

test("unknown tools and malformed arguments are Invalid params (-32602)", async () => {
  const [unknownTool, badArgs] = await exchange([
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lessons_query", arguments: ["not", "an", "object"] } },
  ]);
  assert.equal(unknownTool.error?.code, -32602);
  assert.equal(badArgs.error?.code, -32602);
});

test("tool execution errors stay in-band results with isError", async () => {
  const [response] = await exchange([{ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lessons_apply", arguments: { task: "t" } } }]);
  assert.equal(response.result.isError, true);
});
