"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, AtSign, Paperclip, Square } from "lucide-react";
import { ArtifactCard, type ActiveTool, type ChatMessage } from "@braincrew-lab/langchain-canvas";

interface ChatProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onStop: () => void;
  onReset?: () => void;
  /** Clickable example prompts shown in the empty state. */
  suggestions?: string[];
  /** The agent tool currently running — drives the status line under the typing indicator. */
  activeTool?: ActiveTool | null;
  /**
   * Wire the composer's paperclip to a file picker: called with the chosen
   * files (the host uploads them so the agent can read them). Omitted, the
   * button stays disabled.
   */
  onAttachFiles?: (files: File[]) => void;
}

export function Chat({
  messages,
  isStreaming,
  error,
  onSend,
  onStop,
  onReset,
  suggestions = [],
  activeTool,
  onAttachFiles,
}: ChatProps) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
            <p>Ask the agent anything — responses are live. Try an example:</p>
            <div className="chat__suggestions">
              {suggestions.map((s) => (
                <button key={s} className="chat__chip" disabled={isStreaming} onClick={() => onSend(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => {
          const isLastMessage = index === messages.length - 1;
          // Keep the typing indicator visible through the tool-call phase (e.g. a
          // long-running write_slide run), not just before the first token arrives —
          // otherwise a silent gap after text reads as a hang.
          const showTyping = message.role === "assistant" && isStreaming && isLastMessage;
          const statusLabel =
            showTyping && activeTool
              ? activeTool.slideId
                ? `${activeTool.name} · ${activeTool.slideId} ${activeTool.stage === "verifying" ? "저장·검토 중…" : "작성 중…"}`
                : `${activeTool.name} 실행 중…`
              : null;
          return (
            <div key={message.id} className={`msg msg--${message.role}`}>
              <div className={`bubble bubble--${message.role}`}>
                {message.text}
                {showTyping &&
                  (statusLabel ? (
                    <span className="bubble__status" role="status" aria-live="polite">
                      {statusLabel}
                    </span>
                  ) : (
                    <span className="bubble__typing" />
                  ))}
              </div>
              {Array.from(new Set(message.artifactIds)).map((id) => <ArtifactCard key={id} artifactId={id} />)}
            </div>
          );
        })}

        {error && <div className="chat__error">{error}</div>}
      </div>

      <div className="composer">
        <div className="composer__card">
          <textarea
            className="composer__input"
            value={draft}
            placeholder="Ask the agent to add, edit or export slides…"
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer__actions">
            <div className="composer__left">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) onAttachFiles?.(Array.from(e.target.files));
                  e.target.value = ""; // allow re-attaching the same file
                }}
              />
              <button
                type="button"
                className="composer__icon"
                aria-label="Attach file"
                disabled={!onAttachFiles}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={16} aria-hidden />
              </button>
              <button type="button" className="composer__icon" aria-label="Mention" disabled>
                <AtSign size={16} aria-hidden />
              </button>
            </div>
            {isStreaming ? (
              <button className="composer__send composer__send--stop" onClick={onStop} aria-label="Stop">
                <Square size={14} aria-hidden />
              </button>
            ) : (
              <button
                className="composer__send"
                onClick={submit}
                disabled={!draft.trim()}
                aria-label="Send"
              >
                <ArrowUp size={16} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
