# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Jid MCP server, built as a labelled subset of its captured surface. Five of the seven captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `search_business`, `get_business_file`, `verify_business`, `get_receipt` and `check_email`. The business tools verify companies against public registry facts (FEI, LEI, SEC CIK, DUNS, SIRENE/SIRET and state registers) with cited sources and signed receipts; `check_email` runs deterministic DMARC/SPF/DKIM checks over raw headers the caller supplies.
- Omitted, deliberately: `qualify_counterparty` and `screen`. Both score or screen individual people from a lead's or sender's personal email, phone, IP geolocation and browser timezone, and neither is registered here; tests assert their absence at the registry, MCP and CLI levels.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `bizfile error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `JID_MCP_URL`; when `JID_API_KEY` is set it is sent as an `Authorization: Bearer` header on every upstream request.
