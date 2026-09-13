#!/usr/bin/env node
/**
 * Re-sends leads that the webhook never accepted.
 *
 *   node scripts/replay-failed.js            # replay data/failed-webhooks.jsonl
 *   node scripts/replay-failed.js --dry-run  # just list them
 *
 * Successfully replayed entries are removed from the file; failures are kept.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deliver } from '../src/services/webhook.js';
import { config } from '../src/config.js';

const FILE = fileURLToPath(new URL('../data/failed-webhooks.jsonl', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

let raw;
try {
  raw = await readFile(FILE, 'utf8');
} catch {
  console.log('Nothing to replay — no data/failed-webhooks.jsonl.');
  process.exit(0);
}

const entries = raw
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (!config.webhook.url) {
  console.error('LEAD_WEBHOOK_URL is not set — nothing to replay to.');
  process.exit(1);
}

console.log(`${entries.length} failed delivery/deliveries found. Target: ${config.webhook.url}`);
const stillFailing = [];

for (const entry of entries) {
  const reference = entry.payload?.reference ?? '(no reference)';
  if (dryRun) {
    console.log(`- ${reference} ${entry.payload?.lead?.email ?? ''} failed_at=${entry.failed_at}`);
    continue;
  }
  const result = await deliver(entry.payload);
  if (result.delivery === 'delivered') {
    console.log(`✔ ${reference} delivered`);
  } else {
    console.log(`✖ ${reference} still failing: ${result.error ?? result.delivery}`);
    stillFailing.push(entry);
  }
}

if (!dryRun) {
  // deliver() re-appends permanent failures, so rewrite the file from scratch.
  await writeFile(FILE, stillFailing.map((entry) => JSON.stringify(entry)).join('\n') + (stillFailing.length ? '\n' : ''), 'utf8');
  console.log(`Done. ${entries.length - stillFailing.length} delivered, ${stillFailing.length} remaining.`);
}
