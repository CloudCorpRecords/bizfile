# BUILD REPORT — bizfile

Clean-room rebuild of `com.jid/jid` v1.6.0 (remote-only MCP
server at `https://jid.com/mcp`), built 2026-10-28 as a
forwarding client. Package: `@reneturcios/bizfile` 0.1.0,
registry name `io.github.CloudCorpRecords/bizfile`.

## Surface built

**LABELLED SUBSET: 5 of 7 captured tools**, 2 omissions.

| Tool | Title (as served) | Required fields as served |
|------|-------------------|-----------------------------|
| `search_business` | Search businesses | `query` |
| `get_business_file` | Get a business file | `id` |
| `verify_business` | Verify a business before acting | *(no `required` key in schema)* |
| `get_receipt` | Get a verification receipt | `receipt_id` |
| `check_email` | Is this e-mail really from who it says? (SPF, DKIM, DMARC, lookalike sender) | `headers` |

**Omitted (2), each a whole tool:**

- `qualify_counterparty` — qualifies a business that made
  contact from the sender's personal email plus browser
  timezone and IP geolocation signals.
- `screen` — screens a lead, sender, vendor or website
  (domain, url, email, phone or company name, with IP and
  browser signals) and returns an engage-or-not answer.

Both omitted tools score/screen individual people — the
personal-screening family. Their absence is asserted in
tests at three levels: registry level (`TOOL_NAMES` /
`TOOL_DEFS` / `isKnownTool`), MCP tools/list–call level
(`handleCallTool` rejects each with `MethodNotFound`
before any network hop; the served tools/list is the
fixture's 5), and CLI level (each name prints Usage and
exits 2).

Tool literals were generated programmatically from
`harness/fixtures/jid-tools-original.json` by the script
at `/tmp/b40-bizfile-gen.py` (parse + re-serialise,
placeholder substitution into `src/forward.ts`) — never
retyped — and a post-generation check confirmed the
served literals deep-equal the fixture's 5 tool objects
in order. Tools are registered via the MCP SDK low-level
Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod, per
the task instruction overriding TEMPLATE.md §2 item 12.

## Fixture conflicts

**None.** The spec and the fixture agree on tool names,
order, required fields (including `verify_business`
carrying no `required` key), titles, and descriptions.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://jid.com/mcp`.
- Env override `JID_MCP_URL` — labelled reconstruction.
- Env name `JID_API_KEY` — labelled reconstruction (the
  registry record declares a secret `Authorization`
  header, not marked required; the capture was keyless).
  When set, `Authorization: Bearer <value>` is sent on
  every upstream request (header name pinned by the
  registry record's own remote declaration; the Bearer
  form and the env forwarding are reconstructions). When
  unset, no key header is sent. Both branches are tested.
- Error rendering `bizfile error:` text for upstream
  failures — labelled reconstruction.
- Upstream results pass through verbatim, including
  `isError` and extra fields. tools/call is forwarded as
  streamable-HTTP JSON-RPC: initialize (protocolVersion
  `2025-03-26`) → notifications/initialized → tools/call,
  honouring `Mcp-Session-Id` when issued; plain-JSON and
  SSE replies are both parsed. The forwarding core takes
  an injectable fetch; tests stub the upstream — no live
  network calls in tests.

## Deviations

- Parity invocation: the task's literal command passes
  the rebuild path with a leading `~/`, which the parity
  harness does not tilde-expand (it resolved to
  `/home/hatch/~/workspace/...` and reported UNREACHABLE).
  Parity was re-run with the identical command except the
  tilde expanded to the absolute path; that run is the
  recorded verdict below and is what `parity-out/`
  contains.
- A backgrounded lockfile command delivered a fabricated
  failure summary (exit 75 / host unreachable) that
  contradicted its own process log; the lockfile was
  re-verified in the foreground from disk (name, entry
  count and sha256 all as recorded below) and the offline
  install that followed succeeded, so Route 3 stands as
  reported.

## Lockfile

- Route: **Route 3** — generated clean from birth in the
  build dir with no `node_modules` and no pre-existing
  lockfile: `npm install --package-lock-only
  --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/bizfile`.
- Package entries: **128**.
- sha256: `f47016501b664e95f62235d8310442ad2836af6be3cf45cbd51c6504a4e5b918`
  (re-verified unchanged after the subsequent offline
  `npm install`).

## server.json

- Description exactly: "Verify businesses against public
  registries and check email headers, with signed
  receipts." — **90 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI
  entry (`ghcr.io/cloudcorprecords/bizfile:0.1.0`) carries
  **no** `version` field. Dockerfile (node:20-alpine, both
  stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/bizfile"`.
  Container workflow `IMAGE` is
  `ghcr.io/cloudcorprecords/bizfile` and its smoke test
  asserts the server name `bizfile`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli,
   forward, index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`; unknown
   subcommand → Usage on stderr, exit 2; the omitted
   `qualify_counterparty` subcommand also exits 2.
4. `npm test` → **71 tests, 71 pass, 0 fail**
   (registration-integrity suite deep-equals the served
   tools/list against the fixture's 5 tools in order, plus
   the absence assertions for both omitted tools at the
   registry, MCP and CLI levels, session
   handling/reuse, env override, key-header
   present/absent/blank branches, verbatim argument
   forwarding and result pass-through including upstream
   isError, SSE parsing, error rendering, MCP-layer
   validation, and CLI behaviour).
5. Parity: `python3 harness/parity.py --original
   harness/fixtures/jid-tools-original.json --rebuild
   "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/bizfile/dist/cli.js mcp"
   --out builds/bizfile/parity-out` → **verdict PASS,
   parity 100.0** (5/5 identical, 0 missing, 0 extra, no
   schema diffs). Output in `parity-out/`.
