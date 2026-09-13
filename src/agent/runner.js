import { config } from '../config.js';
import { logger } from '../logger.js';
import { appendMessages, toApiMessages } from '../services/conversation.js';
import { getClient } from '../services/openaiClient.js';
import { buildSystemPrompt } from './prompt.js';
import { toolDefinitions, runTool } from './tools.js';
import { mockCompletion } from './mockModel.js';

const FALLBACK =
  "Sorry — I couldn't work that out. Could you rephrase it, or leave your name and email and I'll have someone from the team reply directly?";

/** One completion request. Streams token deltas through `onToken` when given. */
async function complete(messages, onToken) {
  if (config.openai.mock) {
    const response = mockCompletion(messages);
    const content = response.choices[0].message.content;
    if (onToken && content) {
      for (const chunk of content.match(/\S+\s*/g) ?? []) {
        onToken(chunk);
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    }
    return response.choices[0];
  }

  const request = {
    model: config.openai.model,
    temperature: config.openai.temperature,
    max_tokens: config.openai.maxOutputTokens,
    messages,
    tools: toolDefinitions,
    tool_choice: 'auto',
  };

  const client = getClient();
  if (!onToken) {
    const response = await client.chat.completions.create(request);
    return response.choices[0];
  }

  // Streaming: text deltas go to the client immediately, tool-call deltas are
  // accumulated by index until the turn finishes.
  const stream = await client.chat.completions.create({ ...request, stream: true });
  const message = { role: 'assistant', content: '', tool_calls: [] };
  let finishReason = 'stop';

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (delta.content) {
      message.content += delta.content;
      onToken(delta.content);
    }
    for (const part of delta.tool_calls ?? []) {
      const slot = (message.tool_calls[part.index] ??= {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      });
      if (part.id) slot.id = part.id;
      if (part.function?.name) slot.function.name += part.function.name;
      if (part.function?.arguments) slot.function.arguments += part.function.arguments;
    }
  }

  if (!message.tool_calls.length) delete message.tool_calls;
  if (!message.content) message.content = null;
  return { message, finish_reason: finishReason };
}

/**
 * Runs one visitor turn: appends the message, then loops
 * model -> tools -> model until the model answers in plain text.
 * Mutates `conversation` — the caller re-signs it for the browser afterwards.
 *
 * @param {object}   params.conversation from services/conversation.js
 * @param {string}   params.message      the visitor's message
 * @param {Function} [params.onToken]    called with each text delta (enables streaming)
 * @param {Function} [params.onToolStart] called with each tool name as it runs
 */
export async function runTurn({ conversation, message, onToken, onToolStart }) {
  appendMessages(conversation, [{ role: 'user', content: message }]);
  conversation.turns += 1;

  const toolsUsed = [];

  for (let iteration = 0; iteration < config.maxToolIterations; iteration += 1) {
    const systemPrompt = buildSystemPrompt({
      lead: conversation.lead,
      locale: conversation.origin?.locale,
      pageUrl: conversation.origin?.pageUrl,
    });

    const choice = await complete(
      [{ role: 'system', content: systemPrompt }, ...toApiMessages(conversation)],
      onToken,
    );
    const assistant = choice.message;

    appendMessages(conversation, [
      {
        role: 'assistant',
        content: assistant.content ?? null,
        ...(assistant.tool_calls?.length ? { tool_calls: assistant.tool_calls } : {}),
      },
    ]);

    if (!assistant.tool_calls?.length) {
      return {
        reply: assistant.content?.trim() || FALLBACK,
        toolsUsed,
        finishReason: choice.finish_reason,
      };
    }

    // Tools are independent of each other, so run the batch concurrently.
    const results = await Promise.all(
      assistant.tool_calls.map(async (call) => {
        const name = call.function?.name;
        onToolStart?.(name);
        toolsUsed.push(name);
        const result = await runTool(name, call.function?.arguments, { conversation });
        logger.debug({ tool: name, conversationId: conversation.id }, 'tool executed');
        return {
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: JSON.stringify(result ?? { ok: true }),
        };
      }),
    );
    appendMessages(conversation, results);
  }

  logger.warn({ conversationId: conversation.id, toolsUsed }, 'tool iteration limit hit');
  const reply =
    'Let me get a human on this — I can have the team email you the details. What is the best email to use?';
  appendMessages(conversation, [{ role: 'assistant', content: reply }]);
  return { reply, toolsUsed, finishReason: 'iteration_limit' };
}
