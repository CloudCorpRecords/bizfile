/**
 * bizfile types.
 *
 * This package verifies no business locally. It is a
 * forwarding client: the captured tool surface lives as
 * data (ToolDef entries served verbatim for tools/list)
 * and each tools/call travels to the hosted Jid MCP
 * endpoint through an injectable fetch, so the test
 * suite can stub the upstream and never touch the live
 * network.
 */

/** One captured tool definition, served exactly as captured for tools/list. */
export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  [key: string]: unknown;
}

/** Arguments for a tool call, as decoded JSON. */
export type ToolArgs = Record<string, unknown>;

/** A tools/call result: upstream payloads pass through verbatim; local failures use this shape too. */
export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** The narrow slice of a fetch Response the forwarding client relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Injectable fetch function, so tests never reach the live network. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/** Injectable runtime dependencies for the forwarding client. */
export interface ForwardDeps {
  /** Fetch implementation. Defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Environment (JID_MCP_URL, JID_API_KEY). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Endpoint URL override. Defaults to env JID_MCP_URL or the pinned default. */
  url?: string;
  /** Per-request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
}
