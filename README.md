# Mastra durable lease stall reproduction

One checkpoint-backed durable agent run, one Node process, and PostgreSQL. A synchronous busy loop stalls the event loop long enough for the execution lease to expire. No second execution claims the run.

The model is `MockLanguageModelV3`, so no provider or API key is required. This reproduction is separate from observability metadata cloning: the busy loop deliberately isolates the behavior after a stall.

## Requirements

- Node.js 22.22.0 or newer.
- A local PostgreSQL database. Verified with PostgreSQL 18.0.
- A database user allowed to create and drop schemas and create tables within them.

Use a disposable local database. Each invocation creates a randomly named `repro_<hex>` schema and drops that schema after reporting the result. It does not reuse application tables. Unexpected termination can leave the temporary schema behind.

## Install and run

```bash
npm ci
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm run repro
```

Adjust the local database URL for your installation. Homebrew installations often use your macOS username as the database role instead of `postgres`. The script reads the process environment directly; it does not load `.env` files.

Verified on Node.js 22.22.3 and PostgreSQL 18.0. The command runs three separate processes:

| Case | Busy loop | Verified outcome |
| --- | ---: | --- |
| Baseline | 0 ms | Finished |
| Stall inside a tool | 5000 ms | Failed: ownership could not be verified |
| Stall with a renewal in flight | 5000 ms | Failed: ownership could not be verified |

In the verified five-second tool stall, zero renewals were sent and the lease had expired about 3.1 seconds earlier. In the in-flight stall, one renewal was sent and confirmed, and the lease had expired about 3.0 seconds earlier. Both failures retained one owner row.

The lease defaults to 2000 ms unless `MASTRA_AGENT_THREAD_LEASE_TTL_MS` is already set. For a controlled comparison, specify it explicitly:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres MASTRA_AGENT_THREAD_LEASE_TTL_MS=2000 npm run repro
```

The failure is printed as `outcome: FAILED: ...`. The script exits with status zero after reporting and cleanup even when the durable run fails; this is a diagnostic reproduction, not an automated pass/fail test.

## Run individual cases

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node lease-min.mjs 0
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node lease-min.mjs 1500
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node lease-min.mjs 5000
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node lease-min.mjs 3000 inflight
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node lease-min.mjs 5000 inflight
```

In the default mode, the tool blocks the event loop. In `inflight` mode, the script wraps `renewRunOwnership` to count renewals and schedules the stall immediately after the first renewal is initiated. That allows PostgreSQL to process the renewal while Node cannot process its reply. Check the printed sent/confirmed counts rather than assuming a renewal succeeded.

To reproduce with a 15-second lease:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres MASTRA_AGENT_THREAD_LEASE_TTL_MS=15000 node lease-min.mjs 35000
```

## What the output establishes

A run counts as finished only if it returns `done` after one tool call and two model calls. The script prints:

- The selected mode, stall duration, and lease duration.
- Completion or error text.
- Tool calls, model calls, renewals initiated, and renewals confirmed.
- Owner-row count, generation, and lease expiry immediately after the stall, compared with PostgreSQL's clock.

The earlier failing cases retained the same owner and generation, with an expired lease and no competing takeover. They reported `DURABLE_AGENT_EXECUTION_UNVERIFIED` / "could not verify that this execution still owns the run".

Exact timings can vary. A retained owner record does not mean the lease is still valid: expiry and owner identity are different facts.

## Proposed behavior for discussion

Consider one bounded, atomic ownership renewal attempt before permanently marking the execution as lost after a local deadline expires. A matching owner and generation could permit recovery when there has been no takeover.

Execution must wait for revalidation, a real takeover must stop the old execution, and an unresponsive database must still lead to a bounded failure. External tool side effects and other ownership deadlines require separate consideration. This repository demonstrates the current behavior; it does not include a fix or establish that every expired execution can safely resume.

Related discussions: [#28934](https://github.com/mastra-ai/mastra/issues/28934), [#28879](https://github.com/mastra-ai/mastra/issues/28879), and [PR #30386](https://github.com/mastra-ai/mastra/pull/30386). The earlier investigation applied the guard change from #30386 separately and still reproduced the heartbeat failure. The dependency installation here is unmodified.

## Versions

- `@mastra/core`: 1.83.0
- `@mastra/pg`: 1.36.0
- `ai`: 6.0.319
- `pg`: 8.23.1
- `zod`: 3.25.76

The script uses `createDurableAgent({ agent })` for checkpoint-backed durable execution. Exact dependencies are captured in `package-lock.json`.
