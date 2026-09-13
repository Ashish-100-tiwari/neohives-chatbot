import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

const KNOWLEDGE_PATH = fileURLToPath(new URL('./knowledge.json', import.meta.url));

let knowledge = JSON.parse(await readFile(KNOWLEDGE_PATH, 'utf8'));

export function getKnowledge() {
  return knowledge;
}

export async function reloadKnowledge() {
  knowledge = JSON.parse(await readFile(KNOWLEDGE_PATH, 'utf8'));
  logger.info({ lastUpdated: knowledge.lastUpdated }, 'knowledge base reloaded');
  return knowledge;
}

/** Hot-reload the knowledge base in dev so pricing edits don't need a restart. */
export function watchKnowledge() {
  watch(KNOWLEDGE_PATH, { persistent: false }, () => {
    reloadKnowledge().catch((err) =>
      logger.error({ err }, 'failed to reload knowledge base — keeping previous copy'),
    );
  });
}

const byId = (items, id) =>
  items.filter((item) => !id || item.id === id || item.name?.toLowerCase() === String(id).toLowerCase());

/** Pricing lookup used by the `get_pricing` tool. */
export function lookupPricing({ plan, service } = {}) {
  const kb = knowledge;
  return {
    currency: kb.company.currency,
    secondaryCurrency: kb.company.secondaryCurrency,
    // Only the AI engagement models have published prices; everything else is
    // quoted after a requirements review. The model must not fill the gap.
    pricingScope: kb.pricingScope,
    plans: byId(kb.plans, plan),
    services: byId(kb.services, service),
    retainers: kb.retainers,
    retainersNote: kb.retainersNote,
    discounts: kb.discounts,
    paymentTerms: kb.paymentTerms,
    guardrails: kb.guardrails,
  };
}

/** Onboarding lookup used by the `get_onboarding` tool. */
export function lookupOnboarding() {
  return knowledge.onboarding;
}

/** Service/capability lookup used by the `get_services` tool. */
export function lookupServices(service) {
  const kb = knowledge;
  return {
    services: byId(kb.services, service),
    // Lets the model map a vague ask ("chat with our documents") onto a service.
    intentRouting: service ? undefined : kb.intentRouting,
    qualification: kb.qualification,
  };
}

/** Case-study lookup used by the `get_case_studies` tool. */
export function lookupCaseStudies(id) {
  return {
    caseStudies: byId(knowledge.caseStudies, id),
    note: 'These are the only client results that may be cited. Never mention any other client.',
  };
}

/** Security posture lookup used by the `get_security` tool. */
export function lookupSecurity() {
  return knowledge.security;
}

/** Technology lookup used by the `get_tech_stack` tool. */
export function lookupTechStack() {
  return knowledge.techStack;
}

/** FAQ lookup — naive keyword scoring is enough for a handful of entries. */
export function lookupFaq(query) {
  if (!query) return knowledge.faqs;
  const terms = String(query).toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  const scored = knowledge.faqs
    .map((faq) => {
      const haystack = `${faq.q} ${faq.a}`.toLowerCase();
      return { faq, score: terms.filter((t) => haystack.includes(t)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored.slice(0, 3).map((entry) => entry.faq) : knowledge.faqs;
}
