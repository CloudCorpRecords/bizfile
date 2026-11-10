# bizfile

Before you deal with a company you have only just met, it helps to know whether public registries back up what it says about itself. bizfile is a small local bridge to the hosted Jid MCP service: you can search for a business file by name or registry number, read the file with its cited facts, ask for a proceed / review / stop verification decision with a signed receipt, fetch an earlier receipt by its id, or run deterministic header checks on an email to see whether it really came from who it claims.

Nothing is verified on your own machine. This package answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged.

This build is a labelled subset. The captured Jid surface had seven tools; the two that screen individual people — `qualify_counterparty` and `screen`, which score a lead or sender from their personal email, phone, IP geolocation and browser signals — are not part of this rebuild and are never registered, at the MCP layer or on the CLI.

## The tools

- **`search_business`** — Finds business files by name or by any registry number (FEI, LEI, SEC CIK, DUNS, NDC labeler code, state licence or entity number, French SIREN or SIRET), returning candidates with status and match evidence. Passing country `"FR"` also searches the French SIRENE register live.
- **`get_business_file`** — Returns one business's file by its Jid id: status and flags, identifiers, verified websites and the top facts with source and verification date — or, with `detail` `"full"`, every current fact with its provenance, owner statements, possible matches and change history.
- **`verify_business`** — Verifies a business against the registry facts Jid holds, by id or by name / registry number, optionally for a stated activity, jurisdiction and amount. With an activity it returns a decision (proceed, review, stop or insufficient_data) with reasons and a signed `receipt_id`; without one it returns the status and the top cited facts.
- **`get_receipt`** — Returns a stored, Ed25519-signed verification receipt by `receipt_id`: the inputs, decision, reasons, fact ids and value hashes, rules version and time of the check.
- **`check_email`** — Checks the raw headers of a message you supply: DMARC / SPF / DKIM as the receiving server recorded them, DKIM alignment with From, a Reply-To on another domain, and a From domain or display name imitating a known business. The headers are processed in memory and never stored, per the captured description.

No built tool buys anything, starts a subscription, checks out, mints a key, or screens a person.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/bizfile mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "bizfile": {
      "command": "npx",
      "args": ["-y", "@reneturcios/bizfile", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/bizfile
docker run --rm ghcr.io/cloudcorprecords/bizfile get_receipt '{"receipt_id":"rcpt_123"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
bizfile search_business '{"query":"Example Corp"}'
bizfile get_business_file '{"id":"example-corp-a1b2c3"}'
bizfile verify_business '{"id":"example-corp-a1b2c3","activity":"general_commerce"}'
bizfile get_receipt '{"receipt_id":"rcpt_123"}'
bizfile check_email '{"headers":"From: a@example.com\nSubject: hi\n"}'
bizfile --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand — including either omitted tool — or a malformed JSON argument.

## Configuration

- `JID_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://jid.com/mcp`. (The override variable is a reconstruction added by this rebuild.)
- `JID_API_KEY` — When set, its value is sent to the upstream on every request as an `Authorization: Bearer <value>` header. When it is not set, no key header is sent at all, matching the keyless behaviour the tool surface was captured with. (The variable name and the Bearer form are reconstructions; the hosted service's registry record declares an `Authorization` header, not marked required.)

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `bizfile error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface tool by tool, asserts that the two omitted tools are absent at the registry, MCP and CLI levels, exercises the session handshake and its reuse, covers both key-header branches, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
