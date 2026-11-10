/**
 * bizfile core: a forwarding client for the hosted
 * Jid MCP server.
 *
 * No registry lookup happens on this machine. tools/list
 * is answered from the literal definitions below, which
 * reproduce a live capture of the upstream server word
 * for word (name, title, description and inputSchema
 * exactly as captured for the five built tools). This
 * build is a labelled subset of the captured surface:
 * the capture enumerated 7 tools, and the two that
 * screen individual people — `qualify_counterparty` and
 * `screen` — are omitted entirely and never registered.
 * A tools/call travels upstream over a streamable-HTTP
 * JSON-RPC session: an initialize POST, a
 * notifications/initialized POST, then the tools/call
 * POST, carrying the Mcp-Session-Id response header on
 * later requests when the upstream issues one. The
 * session opens lazily on the first forwarded call and
 * is reused for the client's lifetime.
 *
 * The endpoint is pinned to https://jid.com/mcp and may
 * be replaced with the JID_MCP_URL environment variable
 * (that override is a labelled reconstruction). When
 * JID_API_KEY is set, every upstream request carries an
 * `Authorization: Bearer <key>` header (the header name
 * is pinned by the registry record's own remote
 * declaration; the Bearer form and forwarding the key
 * from this env var are labelled reconstructions, as the
 * capture was taken keyless). When it is unset, no key
 * header goes out.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch that
 * throws or times out — become an isError result whose
 * text begins with `bizfile error:` (that rendering is
 * a labelled reconstruction). Replies may be plain JSON
 * or SSE (`data:` lines); the JSON-RPC message whose id
 * matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://jid.com/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/jid-tools-original.json; generated      */
/* programmatically by parsing and re-serialising the fixture JSON,    */
/* never retyped)                                                      */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "search_business",
    "title": "Search businesses",
    "description": "Finds Jid business files by name or by any registry number (FEI, LEI, SEC CIK, DUNS, NDC labeler code, state licence or entity number, French SIREN or SIRET). Returns candidate files with status and match evidence. For a French company pass country \"FR\": the SIRENE register is searched live and files are created on demand.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "minLength": 2,
          "maxLength": 200,
          "description": "Business name or registry number"
        },
        "country": {
          "description": "ISO country code. \"FR\" also searches the French SIRENE register live (a SIREN or SIRET is looked up there anyway).",
          "type": "string",
          "minLength": 2,
          "maxLength": 2
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "name": "get_business_file",
    "title": "Get a business file",
    "description": "The Jid file for one business. Default (compact): status with its flags, identifiers, verified websites, the top facts with source and verification date, counts and the latest changes. With detail \"full\": every current fact with its source, verification date, next check and confidence, owner statements (labelled self-reported), possible matches and the change history.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "description": "Jid file id from search_business, e.g. gland-pharma-limited-j9nehi"
        },
        "detail": {
          "description": "compact (default): the verdict, status, identifiers and top facts with sources; full: every fact with its provenance",
          "type": "string",
          "enum": [
            "compact",
            "full"
          ]
        }
      },
      "required": [
        "id"
      ]
    }
  },
  {
    "name": "verify_business",
    "title": "Verify a business before acting",
    "description": "Verifies a business against the registry facts Jid holds. Input: a Jid id (or a name or registry number) and, optionally, an activity, jurisdiction and amount. With an activity it returns a decision (proceed, review, stop or insufficient_data) with reasons: each names the requirement, met (true, false or unknown), the fact ids, source, verified_at and fresh_until, plus a signed receipt_id. Without an activity it returns the status and the top cited facts. Default output is compact (verdict, reasons, status, identifiers, top facts, receipt reference); detail \"full\" adds every cited fact and the full signed receipt. Activities: general_commerce (General commerce (default)); sell_prescription_drugs (Sell prescription drugs); manufacture_drugs (Manufacture drugs); sell_medical_devices (Sell medical devices); haul_freight (Haul freight (for-hire motor carrier)); broker_freight (Broker freight); sell_alcohol (Sell alcohol (wholesale or import)); produce_spirits (Produce distilled spirits); provide_investment_advice (Provide investment advice); accept_deposits (Accept deposits); lend (Lend); bill_medicare_medicaid (Bill Medicare or Medicaid); healthcare_supplier (Health care supplier); federal_contracting (Federal contracting); charitable_solicitation (Charitable solicitation); construction (Construction or home improvement (contractor)); operate_psilocybin_healing_center (Operate a psilocybin healing or service centre (CO, OR)).",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "id": {
          "description": "Jid file id (preferred)",
          "type": "string"
        },
        "query": {
          "description": "Name or registry number, used when no id is known",
          "type": "string",
          "minLength": 2,
          "maxLength": 200
        },
        "activity": {
          "description": "What the business is about to do for you. Defaults to general_commerce when jurisdiction or amount is given.",
          "type": "string",
          "enum": [
            "general_commerce",
            "sell_prescription_drugs",
            "manufacture_drugs",
            "sell_medical_devices",
            "haul_freight",
            "broker_freight",
            "sell_alcohol",
            "produce_spirits",
            "provide_investment_advice",
            "accept_deposits",
            "lend",
            "bill_medicare_medicaid",
            "healthcare_supplier",
            "federal_contracting",
            "charitable_solicitation",
            "construction",
            "operate_psilocybin_healing_center"
          ]
        },
        "jurisdiction": {
          "description": "US state as US-XX (for example US-CO) or an ISO country code",
          "type": "string",
          "maxLength": 5
        },
        "amount": {
          "description": "Transaction amount, recorded on the receipt as context only",
          "type": "number",
          "minimum": 0
        },
        "currency": {
          "description": "ISO 4217 currency of amount, default USD",
          "type": "string",
          "minLength": 3,
          "maxLength": 3
        },
        "detail": {
          "description": "compact (default): the verdict, status, identifiers and top facts with sources; full: every fact with its provenance",
          "type": "string",
          "enum": [
            "compact",
            "full"
          ]
        }
      }
    }
  },
  {
    "name": "get_receipt",
    "title": "Get a verification receipt",
    "description": "Returns a stored, Ed25519-signed verification receipt by receipt_id: the inputs, decision, reasons, fact ids and value hashes, rules version and time of the check. Free; does not count as a check.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "receipt_id": {
          "type": "string",
          "description": "rcpt_... from verify_business"
        }
      },
      "required": [
        "receipt_id"
      ]
    }
  },
  {
    "name": "check_email",
    "title": "Is this e-mail really from who it says? (SPF, DKIM, DMARC, lookalike sender)",
    "description": "Checks whether an e-mail is from who it claims. Input: the raw headers of a message (as shown by Show original or View source). Returns checks and a read (headline, recommendation engage | verify_first | do_not_engage, failed checks, lookup links): DMARC/SPF/DKIM as the receiving server recorded them, DKIM alignment with From, Reply-To going to another domain, and a From domain or display name that imitates a known business. The headers are processed in memory and never stored. Deterministic, no AI. Counts as 1 check with a key; free tier without one.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "headers": {
          "type": "string",
          "maxLength": 65536,
          "description": "The raw message headers, as one string (the body is not needed)"
        }
      },
      "required": [
        "headers"
      ]
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the built subset surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `bizfile error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class BizfileClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).JID_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).JID_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "bizfile", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): BizfileClient {
  return new BizfileClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new BizfileClient(deps).callTool(name, args);
}
