# WorkGraph Control API SSE stream

`GET /api/events` provides a real-time Server-Sent Events stream for dashboard/runtime consumers.

## Auth

This endpoint is under `/api`, so it uses the same bearer-token middleware as the rest of the control API.

## Event envelope

Every `data:` payload uses the deterministic envelope:

```json
{
  "id": "<event-id>",
  "type": "<event-type>",
  "path": "<primitive-path>",
  "actor": "<actor>",
  "fields": { "...": "..." },
  "ts": "<iso8601>"
}
```

SSE framing includes:

- `id: <event-id>` (for `Last-Event-ID` reconnect)
- `event: <event-type>`
- `data: <json-envelope>`

## Filters

Query params are optional and can be repeated or comma-separated:

- `event` / `events`: filter by event type (for example `thread.created`, `run.updated`)
- `primitive` / `primitiveType`: filter by primitive type (for example `thread`, `conversation`, `plan-step`, `run`)
- `thread`: filter to one thread path/slug (`threads/foo.md`, `threads/foo`, or `foo`)

## Reconnect + replay semantics

The server honors the `Last-Event-ID` request header (or `lastEventId` query fallback):

- Replay starts strictly **after** that exact event id.
- Unknown ids replay from the beginning (safe default for gap-free recovery).
- Replayed ordering is deterministic and matches ledger append order.

## Ordering + idempotency contract

- Event ids are deterministic per projected dashboard event (`<ledger-entry-id>#<event-slot>`).
- Event order is stable:
  1. Ledger append order across entries.
  2. Stable projection order within each entry.
- Clients should treat `id` as the idempotency key and dedupe on reconnect.

## Keepalive

The stream emits heartbeat comments periodically:

```text
:keepalive <unix-ms>
```

This keeps idle connections alive across proxies/load balancers.
