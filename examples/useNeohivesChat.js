/**
 * React hook wrapping examples/neohives-chat.js. Copy both files into your app.
 *
 *   const { messages, send, sending, error, pendingTool, lead, reset } = useNeohivesChat();
 *
 * Streams by default, so the reply types itself out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNeohivesChat, GREETING } from './neohives-chat.js';

export function useNeohivesChat({
  apiUrl = import.meta.env.VITE_NEOHIVES_API_URL,
  token = import.meta.env.VITE_NEOHIVES_CHAT_TOKEN,
  stream = true,
} = {}) {
  const chat = useMemo(() => createNeohivesChat({ apiUrl, token }), [apiUrl, token]);

  const [messages, setMessages] = useState([]);
  const [sending, setSending] = useState(false);
  const [pendingTool, setPendingTool] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState({ lead: {}, missingFields: [], submitted: null, turns: 0 });
  const abortRef = useRef(null);

  // Repaint the thread from localStorage on mount; greet if it's a new visitor.
  useEffect(() => {
    const saved = chat.history();
    setMessages(saved.length ? saved : [{ role: 'assistant', content: GREETING }]);
  }, [chat]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text) => {
      const message = text.trim();
      if (!message || sending) return;

      setError(null);
      setSending(true);
      abortRef.current = new AbortController();

      // Optimistic: show the visitor's line, plus an empty bubble to stream into.
      setMessages((current) => [...current, { role: 'user', content: message }, { role: 'assistant', content: '' }]);

      const appendToken = (token) =>
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + token };
          return next;
        });

      const replaceLast = (content) =>
        setMessages((current) => {
          const next = [...current];
          next[next.length - 1] = { role: 'assistant', content };
          return next;
        });

      try {
        const data = await chat.send(message, {
          stream,
          signal: abortRef.current.signal,
          onToken: appendToken,
          onTool: setPendingTool,
        });
        // Non-streaming (or an empty stream) needs the reply filled in.
        setMessages((current) => (current.at(-1)?.content ? current : withReply(current, data.reply)));
        setStatus({
          lead: data.lead ?? {},
          missingFields: data.missingFields ?? [],
          submitted: data.submitted ?? null,
          turns: data.turns ?? 0,
        });
      } catch (err) {
        if (err.name === 'AbortError') return;
        setError(err);
        // `reply` on 429/502 is already visitor-safe copy.
        replaceLast(err.message);
      } finally {
        setPendingTool(null);
        setSending(false);
        abortRef.current = null;
      }
    },
    [chat, sending, stream],
  );

  const reset = useCallback(() => {
    chat.reset();
    setMessages([{ role: 'assistant', content: GREETING }]);
    setStatus({ lead: {}, missingFields: [], submitted: null, turns: 0 });
    setError(null);
  }, [chat]);

  return { messages, send, reset, sending, pendingTool, error, ...status };
}

function withReply(current, reply) {
  const next = [...current];
  next[next.length - 1] = { role: 'assistant', content: reply };
  return next;
}
