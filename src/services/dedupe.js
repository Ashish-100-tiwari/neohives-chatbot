import { createHash } from 'node:crypto';

/**
 * Short-lived duplicate guard for lead submissions.
 *
 * Because conversation state lives in the browser, a client can replay an older
 * signed blob (one where the lead had not been submitted yet) and push the same
 * enquiry to the webhook again. This is the backstop: same email + service
 * inside the TTL returns the original reference instead of firing the webhook.
 *
 * Deliberately in-memory and best-effort — a duplicate slipping through after a
 * restart is a much smaller problem than keeping conversation state server-side.
 */
const TTL_MS = 6 * 60 * 60 * 1000;
const seen = new Map();

export function fingerprintLead(lead) {
  // Keyed on the two fields that gate submission, so the fingerprint is stable
  // even though the rest of the lead keeps growing after the first send.
  const basis = [
    lead?.email?.trim().toLowerCase(),
    (lead?.service_interest ?? lead?.requirement)?.trim().toLowerCase().slice(0, 200),
  ]
    .filter(Boolean)
    .join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

export function findSubmission(fingerprint) {
  const entry = seen.get(fingerprint);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    seen.delete(fingerprint);
    return null;
  }
  return entry;
}

export function recordSubmission(fingerprint, reference) {
  seen.set(fingerprint, { reference, at: Date.now() });
}

export function dedupeSize() {
  return seen.size;
}

const sweeper = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of seen) {
    if (entry.at < cutoff) seen.delete(key);
  }
}, 30 * 60_000);
sweeper.unref();
