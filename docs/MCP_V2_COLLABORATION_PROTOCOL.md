# MCP v2 Collaboration Protocol (`wg_*` tools)

WorkGraph MCP now exposes v2 collaboration tools that share a deterministic
machine-parseable response envelope:

- `wg_post_message`
- `wg_ask`
- `wg_spawn_thread`
- `wg_heartbeat`

## Deterministic envelope

All v2 tools return `structuredContent` with one of these shapes:

### Success envelope

```json
{
  "ok": true,
  "version": "2.0",
  "tool": "wg_post_message",
  "actor": "agent-name",
  "data": { "...": "tool-specific payload" }
}
```

### Error envelope

```json
{
  "ok": false,
  "version": "2.0",
  "tool": "wg_post_message",
  "error": {
    "code": "POLICY_DENIED",
    "message": "Policy gate blocked MCP write.",
    "retryable": false,
    "details": {}
  }
}
```

Error codes:

- `BAD_INPUT`
- `NOT_FOUND`
- `POLICY_DENIED`
- `READ_ONLY`
- `IDEMPOTENCY_CONFLICT`
- `TIMEOUT`
- `INTERNAL_ERROR`

## Tool contracts

## `wg_post_message`

Appends a structured conversation event tied to a thread.

Input highlights:

- `threadPath` (required)
- `body` (required)
- `messageType` (`message|note|decision|system|ask|reply`)
- `correlationId` / `replyToCorrelationId`
- `idempotencyKey`
- `evidence[]` (link/file metadata)
- `metadata` (object)

Output highlights:

- `operation` (`created|replayed`)
- `thread_path`
- `conversation_path`
- `event` (id, timestamps, correlation, evidence, metadata)
- `idempotency` (key + replay flag)

## `wg_ask`

Posts an ask event with correlation and optionally awaits/polls for reply.

Input highlights:

- `threadPath` (required)
- `question` (required)
- `correlationId` (optional; generated if omitted)
- `idempotencyKey` (optional)
- `awaitReply` + `timeoutMs` + `pollIntervalMs`

Output highlights:

- `operation` (`created|replayed`)
- `status` (`pending|answered`)
- `timed_out`
- `correlation_id`
- `ask` event + `reply` event (`null` if pending)

## `wg_spawn_thread`

Creates a child thread with inherited context from the parent.

Input highlights:

- `parentThreadPath`, `title`, `goal` (required)
- `priority`, `deps`, `tags`, `contextRefs`, `space`
- `idempotencyKey`

Output highlights:

- `operation` (`created|replayed`)
- `parent_thread_path`
- `thread` summary payload
- `idempotency` block

## `wg_heartbeat`

Writes agent presence heartbeat and thread claim heartbeat.

Input highlights:

- `actor` (optional; resolved from credential/default actor)
- `threadPath` (optional; all active/blocked owned threads if omitted)
- `threadLeaseMinutes`
- `status` (`online|busy|offline`)
- `currentWork`
- `capabilities`

Output highlights:

- `operation` (`updated`)
- `presence` summary
- `threads` heartbeat result (`touched` + `skipped`)

## Idempotency semantics

- `wg_post_message`: replay keyed by `idempotencyKey` in conversation events.
- `wg_ask`: replay keyed by `idempotencyKey`/`correlationId` for ask events while
  still allowing fresh reply polling in subsequent calls.
- `wg_spawn_thread`: replay keyed by `idempotencyKey` on spawned child metadata.

Reusing a key with different payload returns `IDEMPOTENCY_CONFLICT`.

## SSE integration

Collaboration writes emit SSE events through `/api/events` with explicit types:

- `collaboration.message`
- `collaboration.ask`
- `collaboration.reply`
- `collaboration.heartbeat`

Event IDs are now per-derived-event (`<ledger-hash>:<offset>`) so reconnect
replay with `Last-Event-ID` is safe even when multiple SSE events come from one
ledger append.
