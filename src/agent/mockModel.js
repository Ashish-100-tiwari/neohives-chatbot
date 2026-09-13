import { randomUUID } from 'node:crypto';

/**
 * Rule-based stand-in for the ChatGPT API, used when MOCK_LLM=true or no API key
 * is configured. It returns responses in the same shape as the real API so the
 * tool-calling loop, routes and tests all exercise the production code path.
 */
// Trailing punctuation excluded, so "email is sam@acme.io, thanks" extracts cleanly.
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/;

const toolCall = (name, args) => ({
  id: `call_${randomUUID().slice(0, 8)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const wrap = (message, finishReason) => ({
  choices: [{ message, finish_reason: finishReason }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  model: 'mock',
});

export function mockCompletion(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const text = String(lastUser).toLowerCase();
  const usedTools = messages.filter((m) => m.role === 'tool').map((m) => m.name);

  if (EMAIL_RE.test(lastUser) && !usedTools.includes('update_lead')) {
    return wrap(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          toolCall('update_lead', {
            email: lastUser.match(EMAIL_RE)[0],
            requirement: lastUser,
          }),
        ],
      },
      'tool_calls',
    );
  }

  if (/price|pricing|cost|charge|how much|quote|plan|budget/.test(text) && !usedTools.includes('get_pricing')) {
    return wrap({ role: 'assistant', content: null, tool_calls: [toolCall('get_pricing', {})] }, 'tool_calls');
  }

  if (/onboard|get started|kick ?off|process|next step/.test(text) && !usedTools.includes('get_onboarding')) {
    return wrap({ role: 'assistant', content: null, tool_calls: [toolCall('get_onboarding', {})] }, 'tool_calls');
  }

  const lastTool = messages.at(-1)?.role === 'tool' ? messages.at(-1) : null;
  if (lastTool?.name === 'get_pricing') {
    return wrap(
      {
        role: 'assistant',
        content:
          '[mock] Our published AI engagement models are a Rapid AI Pilot at $2,500–$6,500 (2–3 weeks), a Production AI Agent at $12,500–$24,500 (4–8 weeks), and Enterprise AI Systems from $32,000–$55,000+ (8–16 weeks). Web, mobile and design work is quoted after a requirements review. What are you looking to build?',
      },
      'stop',
    );
  }
  if (lastTool?.name === 'get_onboarding') {
    return wrap(
      {
        role: 'assistant',
        content:
          '[mock] The process is: discovery, architecture and scope, a 2–3 week pilot for AI projects, development, testing, deployment, then monitoring and support. Want me to set up the discovery call?',
      },
      'stop',
    );
  }
  if (lastTool?.name === 'update_lead') {
    return wrap(
      {
        role: 'assistant',
        content: '[mock] Got it, thanks. Could you tell me your name and the company you represent?',
      },
      'stop',
    );
  }

  return wrap(
    {
      role: 'assistant',
      content:
        '[mock] Thanks for reaching out to Neo Hives IT Solutions. Set OPENAI_API_KEY (and MOCK_LLM=false) for real replies. What can I help you with — pricing, or how we get started?',
    },
    'stop',
  );
}
