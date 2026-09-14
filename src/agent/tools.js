import {
  lookupCaseStudies,
  lookupFaq,
  lookupOnboarding,
  lookupPricing,
  lookupSecurity,
  lookupServices,
  lookupTechStack,
} from '../data/knowledge.js';
import { leadFieldsSchema, isReadyToSubmit, missingRequiredFields, validateForSubmit } from '../services/leadSchema.js';
import { mergeLead, toTranscript } from '../services/conversation.js';
import { findSubmission, fingerprintLead, recordSubmission } from '../services/dedupe.js';
import { buildPayload, deliver, newReference } from '../services/webhook.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/** OpenAI tool (function-calling) definitions. */
export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'get_pricing',
      description:
        'Look up the published Neo Hives AI engagement models (Rapid AI Pilot, Production AI Agent, Enterprise AI Systems), which services have no published price, the discount policy and the billing model. Call this before stating ANY price.',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            enum: ['ai-pilot', 'ai-production', 'ai-enterprise'],
            description: 'Restrict to a single AI engagement model, if the visitor asked about one.',
          },
          service: {
            type: 'string',
            enum: [
              'ai-agents',
              'rag',
              'voice-ai',
              'ai-evaluation',
              'web',
              'mobile',
              'uiux',
              'testing',
              'consulting',
              'cloud',
              'marketing',
            ],
            description: 'Restrict to a single service line, if known.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_services',
      description:
        'Look up what Neo Hives builds for a given service line — capabilities, examples, integrations and the qualifying questions to ask. Omit the argument to get the full intent→service routing table when the visitor is vague about what they need.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            enum: [
              'ai-agents',
              'rag',
              'voice-ai',
              'ai-evaluation',
              'web',
              'mobile',
              'uiux',
              'testing',
              'consulting',
              'cloud',
              'marketing',
            ],
            description: 'The service line to describe. Omit to get the routing table and qualifying questions.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_case_studies',
      description:
        'Get the published Neo Hives client results. Call this before citing ANY client outcome, metric or named client — these are the only ones that may be mentioned.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            enum: ['ai-document-automation', 'telematica-australia', 'right-qlik-multimedia', 'supriya-travels'],
            description: 'Restrict to a single case study, if relevant.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_security',
      description:
        'Get the security and data-handling posture: Zero Data Retention, private VPC deployment (AWS/Azure/GCP), RBAC, TLS, audit logging, NDA/DPA availability, and the exact compliance stance. Call this before answering ANY question about security, privacy, where data lives, whether client data trains models, SOC 2, HIPAA, ISO or certifications.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tech_stack',
      description:
        'Get the AI technology stack: which foundation-model providers are used (OpenAI, Anthropic Claude, Llama, DeepSeek, Mistral), orchestration frameworks (LangGraph, LangChain, CrewAI, LlamaIndex), vector databases (Pinecone, Qdrant, pgvector, Weaviate, Milvus) and cloud/evaluation tooling. Call this whenever a visitor asks which models, providers, frameworks, databases or tools Neo Hives uses — including "do you use OpenAI/Claude/LangChain?".',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_onboarding',
      description:
        'Get the engagement process: discovery, scoping, pilot, development, testing, deployment and ongoing support, plus what the client must provide.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_faq',
      description:
        'Search Neo Hives FAQs (services, AI pricing, pilots, code/IP ownership, NDAs, international clients, response times, model providers, compliance).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: "The visitor's question in their own words." } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_lead',
      description:
        'Save or update what you know about the visitor. Merges with anything saved earlier, so send only the new fields. Call this as soon as you learn a detail. IMPORTANT: the moment both `email` and `service_interest` are known this tool sends the enquiry to the sales team by itself and returns a reference id — read `auto_submitted` in the result and give the visitor that reference. Anything you learn afterwards is forwarded automatically too, so keep calling this for the rest of the chat.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Visitor's full name." },
          email: { type: 'string', description: 'Work email address. Required before the enquiry can be sent — ask for it early.' },
          phone: { type: 'string', description: 'Phone or WhatsApp number, with country code if given.' },
          company: { type: 'string', description: 'Company or brand name.' },
          country: { type: 'string', description: 'Country they operate from.' },
          industry: { type: 'string', description: 'Their industry or sector.' },
          service_interest: {
            type: 'string',
            description:
              'The service or AI engagement model they are looking for, e.g. "AI agents & automation", "private RAG / document AI", "voice AI", "web development", "mobile app", "UI/UX", "QA & testing", "cloud", "IT consulting", "digital marketing". Required before the enquiry can be sent — set it as soon as the visitor makes their need clear, even loosely.',
          },
          requirement: { type: 'string', description: 'The business problem and what they want built, in their words.' },
          current_technology: { type: 'string', description: 'Systems and tools they use today (CRM, ERP, helpdesk, stack).' },
          required_integrations: { type: 'string', description: 'Systems the solution must integrate with.' },
          expected_volume: { type: 'string', description: 'Expected volume, e.g. "3,000 invoices/month".' },
          number_of_users: { type: 'string', description: 'How many people will use it.' },
          budget_range: { type: 'string', description: 'Budget as stated, e.g. "$15k" or "1-2 lakh".' },
          timeline: { type: 'string', description: 'When they want to start or launch.' },
          preferred_contact_time: { type: 'string', description: 'When the team should reach out.' },
          notes: { type: 'string', description: 'Anything else useful for the sales team.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_lead',
      description:
        'Send the captured lead to the Neo Hives sales team. Usually unnecessary: update_lead sends the enquiry automatically once email and service_interest are known. Use this only to attach a summary for the sales team, or if update_lead reported that the lead was not sent. Safe to call twice — it returns the existing reference instead of sending again.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One or two sentence summary of the enquiry for the sales team.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Flag the conversation for a human: custom/enterprise pricing, legal or compliance questions, complaints, or anything the knowledge base cannot answer.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why a human is needed.' },
          urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },
];

/**
 * Sends the enquiry to the webhook. Called automatically by `update_lead` the
 * moment email + service_interest are known — the model is not trusted to
 * remember to submit, and a lead with a reply-to address and a stated need is
 * already worth routing to sales.
 *
 * Idempotent: an already-submitted conversation gets its original reference back.
 */
async function sendLead(conversation, { summary, trigger = 'auto' } = {}) {
  const validation = validateForSubmit(conversation.lead);
  if (!validation.ok) {
    return { ok: false, error: validation.error, missing: validation.missing };
  }

  if (conversation.submissions.length) {
    const previous = conversation.submissions[0];
    return {
      ok: true,
      already_submitted: true,
      reference: previous.reference,
      message: 'This enquiry was already sent. Give the visitor the same reference id.',
    };
  }

  // Guards against a replayed conversation state re-sending the same enquiry.
  const fingerprint = fingerprintLead(conversation.lead);
  const duplicate = findSubmission(fingerprint);
  if (duplicate) {
    conversation.submissions.push({
      reference: duplicate.reference,
      at: new Date().toISOString(),
      delivery: 'duplicate',
      sentFields: Object.keys(conversation.lead),
      updates: 0,
    });
    return {
      ok: true,
      already_submitted: true,
      reference: duplicate.reference,
      message: 'We already have this enquiry. Give the visitor the same reference id.',
    };
  }

  if (summary) {
    mergeLead(conversation, { notes: [conversation.lead.notes, summary].filter(Boolean).join(' | ') });
  }

  const reference = newReference();
  const payload = buildPayload({
    event: 'lead.submitted',
    conversation,
    lead: conversation.lead,
    reference,
    transcript: toTranscript(conversation),
    extra: { summary: summary ?? null, trigger },
  });
  const result = await deliver(payload);
  recordSubmission(fingerprint, reference);
  conversation.submissions.push({
    reference,
    at: new Date().toISOString(),
    delivery: result.delivery,
    trigger,
    // What sales has already seen, so later answers can be sent as an update.
    sentFields: Object.keys(conversation.lead),
    updates: 0,
  });

  logger.info(
    { reference, trigger, delivery: result.delivery, conversationId: conversation.id },
    'lead submitted',
  );

  return {
    ok: true,
    reference,
    delivery: result.delivery,
    message: `Lead sent to the sales team. Tell the visitor their reference is ${reference} and that a senior engineer replies within one business day.`,
  };
}

/**
 * Because the lead goes out as soon as email + service are known, the richer
 * answers (budget, volumes, integrations, timeline) usually arrive afterwards.
 * Those are forwarded as `lead.updated` against the same reference, capped so a
 * long conversation cannot flood the sales inbox.
 */
async function sendLeadUpdate(conversation) {
  const submission = conversation.submissions[0];
  if (!submission) return null;
  if ((submission.updates ?? 0) >= config.webhook.maxLeadUpdates) return null;

  const alreadySent = new Set(submission.sentFields ?? []);
  const updatedFields = Object.keys(conversation.lead).filter(
    (field) => conversation.lead[field] && !alreadySent.has(field),
  );
  if (!updatedFields.length) return null;

  const payload = buildPayload({
    event: 'lead.updated',
    conversation,
    lead: conversation.lead,
    reference: submission.reference,
    transcript: toTranscript(conversation),
    extra: { updated_fields: updatedFields },
  });
  const result = await deliver(payload);

  submission.updates = (submission.updates ?? 0) + 1;
  submission.sentFields = [...alreadySent, ...updatedFields];
  return { reference: submission.reference, delivery: result.delivery, updated_fields: updatedFields };
}

/**
 * Tool implementations. Each receives (args, { conversation }) and returns a
 * plain object that is JSON-stringified straight back to the model.
 */
const handlers = {
  get_pricing: (args) => lookupPricing(args),

  get_services: ({ service } = {}) => lookupServices(service),

  get_case_studies: ({ id } = {}) => lookupCaseStudies(id),

  get_security: () => lookupSecurity(),

  get_tech_stack: () => lookupTechStack(),

  get_onboarding: () => lookupOnboarding(),

  search_faq: ({ query }) => ({ results: lookupFaq(query) }),

  update_lead: async (args, { conversation }) => {
    const parsed = leadFieldsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Some fields were rejected.',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'field'}: ${issue.message}`),
      };
    }
    const lead = mergeLead(conversation, parsed.data);
    const stillMissing = missingRequiredFields(lead);
    const response = {
      ok: true,
      lead,
      still_missing: stillMissing,
      ready_to_submit: stillMissing.length === 0,
    };

    if (!isReadyToSubmit(lead)) return response;

    // The trigger the whole flow hangs on: email + service_interest are in, so
    // the enquiry goes to sales now rather than waiting for a confirmation the
    // visitor may never give.
    if (!conversation.submissions.length) {
      const submission = await sendLead(conversation, { trigger: 'auto' });
      response.auto_submitted = submission;
      if (submission.ok) {
        response.message = `The enquiry has been sent to the sales team automatically — reference ${submission.reference}. Give the visitor that reference and say a senior engineer replies within one business day. Do not call submit_lead.`;
      }
      return response;
    }

    const update = await sendLeadUpdate(conversation);
    if (update) {
      response.forwarded_update = update;
      response.message = `Saved and forwarded to the sales team against reference ${update.reference}. No need to mention the reference again.`;
    }
    return response;
  },

  submit_lead: async ({ summary }, { conversation }) => {
    // Already auto-submitted? Attach the summary as an update so the sales team
    // still gets it, and hand back the original reference.
    if (conversation.submissions.length && summary) {
      mergeLead(conversation, { notes: [conversation.lead.notes, summary].filter(Boolean).join(' | ') });
      await sendLeadUpdate(conversation);
    }
    return sendLead(conversation, { summary, trigger: 'explicit' });
  },

  escalate_to_human: async ({ reason, urgency = 'normal' }, { conversation }) => {
    const reference = newReference('NH-ESC');
    const payload = buildPayload({
      event: 'lead.escalated',
      conversation,
      lead: conversation.lead,
      reference,
      transcript: toTranscript(conversation),
      extra: { escalation: { reason, urgency } },
    });
    const result = await deliver(payload);
    conversation.escalations.push({ reference, reason, urgency, at: new Date().toISOString() });
    return {
      ok: true,
      reference,
      delivery: result.delivery,
      message: `A human has been notified (${reference}). Ask for contact details if you don't have them yet.`,
    };
  },
};

export async function runTool(name, rawArgs, context) {
  const handler = handlers[name];
  if (!handler) return { ok: false, error: `Unknown tool: ${name}` };

  let args = {};
  if (rawArgs) {
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs;
    } catch {
      return { ok: false, error: 'Arguments were not valid JSON. Retry with a valid JSON object.' };
    }
  }

  try {
    return await handler(args, context);
  } catch (err) {
    logger.error({ err, tool: name }, 'tool execution failed');
    return { ok: false, error: 'That lookup failed on our side. Apologise briefly and offer to have the team follow up.' };
  }
}

export const toolNames = Object.keys(handlers);
