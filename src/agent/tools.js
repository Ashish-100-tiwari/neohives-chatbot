import {
  lookupCaseStudies,
  lookupFaq,
  lookupOnboarding,
  lookupPricing,
  lookupSecurity,
  lookupServices,
  lookupTechStack,
} from '../data/knowledge.js';
import { leadFieldsSchema, missingRequiredFields, validateForSubmit } from '../services/leadSchema.js';
import { mergeLead, toTranscript } from '../services/conversation.js';
import { findSubmission, fingerprintLead, recordSubmission } from '../services/dedupe.js';
import { buildPayload, deliver, newReference } from '../services/webhook.js';
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
        'Save or update what you know about the visitor. Merges with anything saved earlier, so send only the new fields. Call this as soon as you learn a detail.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "Visitor's full name." },
          email: { type: 'string', description: 'Work email address.' },
          phone: { type: 'string', description: 'Phone or WhatsApp number, with country code if given.' },
          company: { type: 'string', description: 'Company or brand name.' },
          country: { type: 'string', description: 'Country they operate from.' },
          industry: { type: 'string', description: 'Their industry or sector.' },
          service_interest: { type: 'string', description: 'Service or AI engagement model they are interested in.' },
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
        'Send the captured lead to the Neo Hives sales team. Call this ONLY after the visitor has confirmed your read-back summary. Returns a reference id to give the visitor.',
      parameters: {
        type: 'object',
        properties: {
          confirmed_by_visitor: {
            type: 'boolean',
            description: 'True only if the visitor explicitly confirmed their details are correct.',
          },
          summary: {
            type: 'string',
            description: 'One or two sentence summary of the enquiry for the sales team.',
          },
        },
        required: ['confirmed_by_visitor', 'summary'],
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

  update_lead: (args, { conversation }) => {
    const parsed = leadFieldsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        error: 'Some fields were rejected.',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'field'}: ${issue.message}`),
      };
    }
    const lead = mergeLead(conversation, parsed.data);
    return {
      ok: true,
      lead,
      still_missing: missingRequiredFields(lead),
      ready_to_submit: missingRequiredFields(lead).length === 0,
    };
  },

  submit_lead: async ({ confirmed_by_visitor, summary }, { conversation }) => {
    if (!confirmed_by_visitor) {
      return {
        ok: false,
        error: 'Not submitted: read the details back to the visitor and get an explicit confirmation first.',
      };
    }
    const validation = validateForSubmit(conversation.lead);
    if (!validation.ok) {
      return { ok: false, error: validation.error, missing: validation.missing };
    }
    if (conversation.submissions.length) {
      const previous = conversation.submissions.at(-1);
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
      conversation.submissions.push({ reference: duplicate.reference, at: new Date().toISOString(), delivery: 'duplicate' });
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
      extra: { summary: summary ?? null },
    });
    const result = await deliver(payload);
    recordSubmission(fingerprint, reference);
    conversation.submissions.push({ reference, at: new Date().toISOString(), delivery: result.delivery });

    return {
      ok: true,
      reference,
      delivery: result.delivery,
      message: `Lead recorded. Tell the visitor their reference is ${reference} and that the team replies within one business day.`,
    };
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
