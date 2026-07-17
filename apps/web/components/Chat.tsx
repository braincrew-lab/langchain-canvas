"use client";

import { useEffect, useRef, useState } from "react";
import { ArtifactCard, type ChatMessage } from "@langchain-canvas/react";

interface ChatProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onReset?: () => void;
  /** Clickable example prompts shown in the empty state. */
  suggestions?: string[];
}

export function Chat({ messages, isStreaming, error, onSend, onStop, onReset, suggestions = [] }: ChatProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the transcript pinned to the latest message as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="chat">
      <header className="chat__header">
        <h1>Chat</h1>
        {onReset && messages.length > 0 && (
          <button className="chat__reset" onClick={onReset} disabled={isStreaming}>
            ↺ New
          </button>
        )}
      </header>

      <div className="chat__scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat__hello">
            <p>Try an example — no LLM call, the response is mocked.</p>
            <div className="chat__suggestions">
              {suggestions.map((s) => (
                <button key={s} className="chat__chip" disabled={isStreaming} onClick={() => onSend(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`msg msg--${message.role}`}>
            <div className={`bubble bubble--${message.role}`}>
              {message.text}
              {message.role === "assistant" && !message.text && !message.artifactIds?.length && (
                <span className="bubble__typing" />
              )}
            </div>
            {message.artifactIds?.map((id) => <ArtifactCard key={id} artifactId={id} />)}
          </div>
        ))}

        {error && <div className="chat__error">{error}</div>}
      </div>

      <div className="composer">
        <textarea
          className="composer__input"
          value={draft}
          placeholder="Message the agent…"
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {isStreaming ? (
          <button className="composer__btn composer__btn--stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="composer__btn" onClick={submit} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
