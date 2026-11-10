import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  BizfileClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Jid endpoint is never
 * contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/jid-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const SEARCH_TOOL = "search_business";
const FILE_TOOL = "get_business_file";
const VERIFY_TOOL = "verify_business";
const RECEIPT_TOOL = "get_receipt";
const EMAIL_TOOL = "check_email";
const ALL_TOOLS = [SEARCH_TOOL, FILE_TOOL, VERIFY_TOOL, RECEIPT_TOOL, EMAIL_TOOL];
const OMITTED_TOOLS = ["qualify_counterparty", "screen"];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"id\":\"example-corp-a1b2c3\",\"status\":\"verified\"}" }],
  structuredContent: { id: "example-corp-a1b2c3", status: "verified" },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "jid", version: "1.6.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new BizfileClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured subset surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, [
      "search_business",
      "get_business_file",
      "verify_business",
      "get_receipt",
      "check_email",
    ]);
  });

  it("carries exactly the fixture's keys on each tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's tool titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Search businesses",
        "Get a business file",
        "Verify a business before acting",
        "Get a verification receipt",
        "Is this e-mail really from who it says? (SPF, DKIM, DMARC, lookalike sender)",
      ],
    );
  });

  it("requires exactly query on search_business", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[0]).required, ["query"]);
  });

  it("requires exactly id on get_business_file", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[1]).required, ["id"]);
  });

  it("carries no required key on verify_business", () => {
    assert.equal("required" in schemaOf(TOOL_DEFS[2]), false);
    assert.equal(schemaOf(TOOL_DEFS[2]).required, undefined);
  });

  it("requires exactly receipt_id on get_receipt", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[3]).required, ["receipt_id"]);
  });

  it("requires exactly headers on check_email", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[4]).required, ["headers"]);
  });

  it("carries the draft-07 $schema on every tool's inputSchema", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(
        schemaOf(tool)["$schema"],
        "http://json-schema.org/draft-07/schema#",
      );
      assert.equal(schemaOf(tool).type, "object");
    }
  });

  it("carries every fixture property, in order, for all five tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 5; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), ["query", "country"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["id", "detail"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), [
      "id",
      "query",
      "activity",
      "jurisdiction",
      "amount",
      "currency",
      "detail",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), ["receipt_id"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[4]).properties), ["headers"]);
  });

  it("carries search_business argument shapes verbatim", () => {
    const props = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(props.query.type, "string");
    assert.equal(props.query.minLength, 2);
    assert.equal(props.query.maxLength, 200);
    assert.equal(props.country.type, "string");
    assert.equal(props.country.minLength, 2);
    assert.equal(props.country.maxLength, 2);
  });

  it("carries the detail enum on get_business_file and verify_business", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[1]).properties.detail.enum, ["compact", "full"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[2]).properties.detail.enum, ["compact", "full"]);
  });

  it("carries verify_business's activity enum verbatim", () => {
    const activity = schemaOf(TOOL_DEFS[2]).properties.activity;
    assert.equal(activity.type, "string");
    assert.equal(activity.enum.length, 17);
    assert.equal(activity.enum[0], "general_commerce");
    assert.ok(activity.enum.includes("operate_psilocybin_healing_center"));
    const amount = schemaOf(TOOL_DEFS[2]).properties.amount;
    assert.equal(amount.type, "number");
    assert.equal(amount.minimum, 0);
  });

  it("carries check_email's headers shape verbatim", () => {
    const headers = schemaOf(TOOL_DEFS[4]).properties.headers;
    assert.equal(headers.type, "string");
    assert.equal(headers.maxLength, 65536);
  });

  it("carries the fixture's wording in the tool descriptions", () => {
    assert.match(TOOL_DEFS[0].description, /SIRENE register is searched live/);
    assert.match(TOOL_DEFS[3].description, /Ed25519-signed verification receipt/);
    assert.match(TOOL_DEFS[4].description, /processed in memory and never stored/);
  });

  it("isKnownTool recognises the 5 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("search-business"), false);
    assert.equal(isKnownTool("find_business"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omission: the personal-screening tools are absent", () => {
  it("the omitted tools are not among the served tool names (registry level)", () => {
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(TOOL_NAMES.includes(omitted), false);
      assert.equal(TOOL_DEFS.some((t) => t.name === omitted), false);
    }
    assert.equal(TOOL_DEFS.length, 5);
  });

  it("isKnownTool rejects each omitted tool (registry level)", () => {
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(isKnownTool(omitted), false);
    }
  });

  it("the MCP layer rejects qualify_counterparty as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "qualify_counterparty", { email: "a@example.com" }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP layer rejects screen as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "screen", { email: "a@example.com", phone: "+1-555-0100" }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://jid.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name bizfile and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECEIPT_TOOL, { receipt_id: "rcpt_1" });
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "bizfile", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    await c.callTool(RECEIPT_TOOL, { receipt_id: "rcpt_1" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(FILE_TOOL, { id: "example-corp-a1b2c3" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the JID_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new BizfileClient({
      fetchFn: upstream.fetchFn,
      env: { JID_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(VERIFY_TOOL, { id: "example-corp-a1b2c3" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(RECEIPT_TOOL, { receipt_id: "rcpt_9" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { JID_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new BizfileClient({
      fetchFn: upstream.fetchFn,
      env: { JID_MCP_URL: "   " },
    });
    await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer on every request when JID_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new BizfileClient({
      fetchFn: upstream.fetchFn,
      env: { JID_API_KEY: "jid-key-42" },
    });
    await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer jid-key-42",
      ),
    );
  });

  it("sends no Authorization header when JID_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header when JID_API_KEY is blank", async () => {
    const upstream = makeUpstream();
    const c = new BizfileClient({
      fetchFn: upstream.fetchFn,
      env: { JID_API_KEY: "   " },
    });
    await c.callTool(RECEIPT_TOOL, { receipt_id: "rcpt_1" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new BizfileClient({
      fetchFn: withKey.fetchFn,
      env: { JID_API_KEY: "jid-key-42" },
    });
    await c1.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.ok(withKey.calls.every((call) => call.headers["X-API-Key"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a search_business call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { query: "Example Corp" };
    await c.callTool(SEARCH_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a French search_business call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { query: "123456789", country: "FR" };
    await c.callTool(SEARCH_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SEARCH_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_business_file call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { id: "example-corp-a1b2c3", detail: "full" };
    await c.callTool(FILE_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, FILE_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a verify_business call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      id: "example-corp-a1b2c3",
      activity: "general_commerce",
      jurisdiction: "US-CA",
      amount: 5000,
      currency: "USD",
    };
    await c.callTool(VERIFY_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, VERIFY_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_receipt call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(RECEIPT_TOOL, { receipt_id: "rcpt_123" });
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RECEIPT_TOOL);
    assert.deepEqual(params.arguments, { receipt_id: "rcpt_123" });
  });

  it("forwards a check_email call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { headers: "From: a@example.com\nAuthentication-Results: mx; dmarc=pass\n" };
    await c.callTool(EMAIL_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EMAIL_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such business file" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(FILE_TOOL, { id: "missing-1" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(VERIFY_TOOL, { id: "example-corp-a1b2c3" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      RECEIPT_TOOL,
      { receipt_id: "rcpt_77" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RECEIPT_TOOL);
    assert.deepEqual(params.arguments, { receipt_id: "rcpt_77" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as bizfile error text", () => {
  it("maps a JSON-RPC error to `bizfile error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "lookup failed upstream" },
    });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bizfile error: lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to bizfile error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bizfile error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bizfile error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bizfile error: malformed response");
  });

  it("maps a non-2xx upstream status to bizfile error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bizfile error: HTTP 500");
  });

  it("maps a throwing fetch to bizfile error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^bizfile error: /);
  });

  it("maps a throwing initialize fetch to bizfile error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "bizfile error: socket hang up");
  });

  it("maps a timed-out call to bizfile error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(SEARCH_TOOL, { query: "Example Corp" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^bizfile error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, SEARCH_TOOL, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, RECEIPT_TOOL, "receipt_id=rcpt_1"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid search_business call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, SEARCH_TOOL, { query: "Example Corp" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { query: "Example Corp" });
  });

  it("forwards a valid get_receipt call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, RECEIPT_TOOL, { receipt_id: "rcpt_123" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RECEIPT_TOOL);
  });

  it("forwards a valid check_email call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, EMAIL_TOOL, { headers: "From: a@example.com\n" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EMAIL_TOOL);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, VERIFY_TOOL, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("the omitted qualify_counterparty tool is not a CLI command and exits 2", () => {
    const res = runCli(["qualify_counterparty", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("the omitted screen tool is not a CLI command and exits 2", () => {
    const res = runCli(["screen", "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([SEARCH_TOOL, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([SEARCH_TOOL, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
