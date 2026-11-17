// One durable run in one process, on Postgres. No model provider or API key.
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node lease-min.mjs <blockMs> [inflight]
//
// Default mode: the tool blocks the event loop for <blockMs>.
// "inflight" mode: the event loop is blocked for <blockMs> right after the first lease renewal
// has been sent, so the renewal reaches Postgres but its reply waits for the main thread.
//
// The lease is shortened to 2 s so a run takes seconds; Mastra reads it at import time.
import { randomBytes } from 'node:crypto';

process.env.MASTRA_AGENT_THREAD_LEASE_TTL_MS ??= '2000';
const BLOCK_MS = Number(process.argv[2] ?? 5000);
const INFLIGHT = process.argv[3] === 'inflight';

const { Mastra } = await import('@mastra/core');
const { Agent } = await import('@mastra/core/agent');
const { createDurableAgent } = await import('@mastra/core/agent/durable');
const { createTool } = await import('@mastra/core/tools');
const { PostgresStore } = await import('@mastra/pg');
const { MockLanguageModelV3 } = await import('ai/test');
const { simulateReadableStream } = await import('ai');
const { z } = await import('zod');
const pg = (await import('pg')).default;

const schemaName = `repro_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
await admin.query(`create schema "${schemaName}"`);

const block = () => {
  // Stand-in for any synchronous work that keeps the main thread busy.
  const end = Date.now() + BLOCK_MS;
  while (Date.now() < end) {}
};

// The owner record as Postgres sees it, compared with Postgres's own clock.
const readLease = () =>
  admin.query(
    `select "ownerId", generation, "leaseExpiresAt",
            "leaseExpiresAt" - (extract(epoch from clock_timestamp()) * 1000)::bigint as "msLeft"
       from "${schemaName}"."mastra_workflow_run_owners"`,
  );
let leaseAfterStall;

let toolCalls = 0;
const lookup = createTool({
  id: 'lookup',
  description: 'Looks up a record.',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }) => {
    toolCalls += 1;
    if (INFLIGHT) {
      // Stay in the tool long enough for the first renewal to be sent.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } else if (BLOCK_MS > 0) {
      block();
      leaseAfterStall = readLease();
    }
    return { id, title: 'Record' };
  },
});

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };
let modelCalls = 0;
const model = new MockLanguageModelV3({
  provider: 'mock',
  modelId: 'mock-model',
  doStream: async ({ prompt }) => {
    modelCalls += 1;
    const chunks = [{ type: 'stream-start', warnings: [] }];
    if (prompt[prompt.length - 1]?.role !== 'tool') {
      const input = JSON.stringify({ id: 'rec-1' });
      chunks.push(
        { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'call_1', delta: input },
        { type: 'tool-input-end', id: 'call_1' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'lookup', input },
        { type: 'finish', finishReason: 'tool-calls', usage },
      );
    } else {
      chunks.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage });
    }
    return { stream: simulateReadableStream({ chunks, chunkDelayInMs: 0 }) };
  },
});

// Since @mastra/core 1.83.0, checkpoint-backed durable execution comes from createDurableAgent();
// `durable: true` on a plain Agent now only enables resumable streams.
const agent = createDurableAgent({
  agent: new Agent({ id: 'repro-agent', name: 'Repro agent', instructions: 'Call lookup once, then answer.', model, tools: { lookup } }),
});
const storage = new PostgresStore({ id: 'repro-store', connectionString: process.env.DATABASE_URL, schemaName });

// Count renewals, and in "inflight" mode start the stall right after the first one is sent.
const workflows = await storage.getStore('workflows');
const renew = workflows.renewRunOwnership.bind(workflows);
let renewalsSent = 0;
let renewalsConfirmed = 0;
workflows.renewRunOwnership = async (...args) => {
  renewalsSent += 1;
  const pending = renew(...args);
  if (INFLIGHT && renewalsSent === 1) {
    setImmediate(() => {
      block();
      leaseAfterStall = readLease();
    });
  }
  const result = await pending;
  if (result.renewed) renewalsConfirmed += 1;
  return result;
};

const mastra = new Mastra({ agents: { reproAgent: agent }, storage });

let text = '';
let error;
try {
  const out = await mastra.getAgent('reproAgent').stream('Look up rec-1 and summarise it.', { maxSteps: 4 });
  for await (const part of out.fullStream) {
    if (part.type === 'text-delta') text += part.payload?.text ?? '';
    if (part.type === 'error') error = String(part.payload?.error?.message ?? part.payload?.error ?? part.payload);
  }
} catch (thrown) {
  error = String(thrown?.message ?? thrown);
}

// A run counts as finished only if it produced the whole answer from one tool call and two model calls.
const complete = !error && text === 'done' && toolCalls === 1 && modelCalls === 2;
const outcome = complete ? 'finished' : `FAILED: ${(error ?? `incomplete (text=${JSON.stringify(text)})`).slice(0, 150)}`;

console.log(`mode=${INFLIGHT ? 'inflight' : 'tool-block'} blocked=${BLOCK_MS}ms lease=${process.env.MASTRA_AGENT_THREAD_LEASE_TTL_MS}ms`);
console.log(`outcome: ${outcome}`);
console.log(`tool calls=${toolCalls} model calls=${modelCalls} renewals sent=${renewalsSent} confirmed=${renewalsConfirmed}`);
if (leaseAfterStall) {
  const { rows } = await leaseAfterStall;
  for (const row of rows) {
    const msLeft = Number(row.msLeft);
    const state = row.leaseExpiresAt === null ? 'released' : msLeft > 0 ? `valid for another ${msLeft} ms` : `expired ${-msLeft} ms ago`;
    console.log(`owner record right after the stall: rows=${rows.length} generation=${row.generation} lease in Postgres ${state}`);
  }
}

await mastra.shutdown?.().catch(() => {});
await admin.query(`drop schema if exists "${schemaName}" cascade`).catch(() => {});
await admin.end();
process.exit(0);
