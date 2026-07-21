"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import { CHAT_SUGGESTIONS } from "@/lib/chat-suggestions";

type Source = {
  title: string;
  url: string;
};

type ChatResponse = {
  answer: string;
  sources: Source[];
  fallback_triggered: boolean;
  query_id?: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  fallbackTriggered?: boolean;
};

type ChatWidgetProps = {
  embedded?: boolean;
  compactLauncher?: boolean;
};

const MAX_QUESTION_LENGTH = 1000;

const starterMessage: Message = {
  id: "welcome",
  role: "assistant",
  content: "Hi! I'm Welly, here to answer any questions you may have about The Well. How can I help?",
  sources: [],
};

export default function ChatWidget({ embedded = false, compactLauncher = false }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([starterMessage]);
  const [question, setQuestion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [askedSuggestions, setAskedSuggestions] = useState<string[]>([]);
  const [isCompactLauncher, setIsCompactLauncher] = useState(compactLauncher);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messageSequenceRef = useRef(0);
  const streamedAnswerRef = useRef("");
  const hasFirstTokenRef = useRef(false);
  const visibleSuggestions = CHAT_SUGGESTIONS
    .filter((suggestedQuestion) => !askedSuggestions.includes(suggestedQuestion))
    .slice(0, 3);

  useEffect(() => {
    if (!embedded || window.parent === window) return;

    const configuredParentOrigin = new URLSearchParams(window.location.search).get("parentOrigin");
    const referrerOrigin = document.referrer ? new URL(document.referrer).origin : "";
    const parentOrigin = configuredParentOrigin || referrerOrigin;

    if (!parentOrigin) return;

    const handleParentMessage = (event: MessageEvent) => {
      if (event.origin !== parentOrigin || event.source !== window.parent) return;
      if (event.data?.source !== "the-well-widget" || event.data?.type !== "viewport") return;
      setIsCompactLauncher(Boolean(event.data.compact));
    };

    window.addEventListener("message", handleParentMessage);

    window.parent.postMessage(
      {
        source: "the-well-widget",
        type: "resize",
        open: isOpen,
      },
      parentOrigin
    );

    return () => window.removeEventListener("message", handleParentMessage);
  }, [embedded, isOpen]);

  function createMessageId(role: Message["role"]): string {
    messageSequenceRef.current += 1;
    return `${role}-${messageSequenceRef.current}`;
  }

  async function sendQuestion(questionOverride?: string) {
    const trimmedQuestion = (questionOverride ?? question).trim();
    if (!trimmedQuestion || isLoading) return;

    const userMessage: Message = {
      id: createMessageId("user"),
      role: "user",
      content: trimmedQuestion,
    };

    setMessages((currentMessages) => [...currentMessages, userMessage]);
    setQuestion("");
    setError("");
    setIsLoading(true);
    // Measured in the click/submit handler, outside React render state.
    // eslint-disable-next-line react-hooks/purity
    const requestStartedAt = performance.now();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmedQuestion }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Request failed");
      }

      const contentType = response.headers.get("content-type") || "";
      const responseQueryId = response.headers.get("x-query-id") || "";
      if (contentType.includes("application/json")) {
        const payload = await response.json() as ChatResponse;
        const assistantMessage: Message = {
          id: createMessageId("assistant"),
          role: "assistant",
          content: payload.answer,
          sources: payload.sources,
          fallbackTriggered: payload.fallback_triggered,
        };

        setMessages((currentMessages) => [...currentMessages, assistantMessage]);
        // eslint-disable-next-line react-hooks/purity
        const completedAt = performance.now();
        recordTelemetry(payload.query_id || responseQueryId, requestStartedAt, completedAt, completedAt);
        return;
      }

      if (!response.body) {
        throw new Error("Missing response body");
      }

      const assistantMessageId = createMessageId("assistant");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      streamedAnswerRef.current = "";
      hasFirstTokenRef.current = false;
      let firstTokenAt = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const token = decoder.decode(value, { stream: true });
        if (!token) continue;

        streamedAnswerRef.current += token;

        if (!hasFirstTokenRef.current) {
          // eslint-disable-next-line react-hooks/purity
          firstTokenAt = performance.now();
          hasFirstTokenRef.current = true;
          setIsLoading(false);
          setMessages((currentMessages) => [
            ...currentMessages,
            {
              id: assistantMessageId,
              role: "assistant",
              content: streamedAnswerRef.current,
              sources: [],
              fallbackTriggered: false,
            },
          ]);
        } else {
          setMessages((currentMessages) => currentMessages.map((message) => (
            message.id === assistantMessageId
              ? { ...message, content: streamedAnswerRef.current }
              : message
          )));
        }
      }

      if (!hasFirstTokenRef.current) {
        throw new Error("Empty response");
      }

      // eslint-disable-next-line react-hooks/purity
      const completedAt = performance.now();
      recordTelemetry(responseQueryId, requestStartedAt, firstTokenAt, completedAt);
    } catch (requestError) {
      setError(
        requestError instanceof Error && requestError.message.includes("characters or fewer")
          ? `Please keep your question under ${MAX_QUESTION_LENGTH.toLocaleString()} characters.`
          : "We could not send that message. Please try again."
      );
    } finally {
      setIsLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendQuestion();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendQuestion();
    }
  }

  function handleSuggestedQuestion(suggestedQuestion: string) {
    setAskedSuggestions((currentSuggestions) => [...currentSuggestions, suggestedQuestion]);
    void sendQuestion(suggestedQuestion);
  }

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-3 sm:inset-x-auto sm:right-6 sm:bottom-6">
      {isOpen ? (
        <section
          aria-label="The Well chat assistant"
          className="flex h-[min(680px,calc(100vh-2rem))] w-full flex-col overflow-hidden rounded-[1.35rem] border border-[#cfe5df] bg-[#fbfdfb] shadow-[0_24px_70px_rgba(11,64,58,0.2)] max-[440px]:h-[calc(100vh-2rem)] sm:w-[410px]"
        >
          <header className="flex items-center justify-between gap-4 border-b border-[#d9ebe6] bg-[#f3faf7] px-5 py-4">
            <h2 className="text-sm font-semibold tracking-[0.01em] text-[#123f39]">
              Welly
            </h2>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex size-9 items-center justify-center rounded-full text-xl leading-none text-[#2c5d55] transition hover:bg-[#dff2ed] focus:outline-none focus:ring-2 focus:ring-[#00B5A3] focus:ring-offset-2"
              aria-label="Close chat"
            >
              x
            </button>
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex items-end ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {message.role === "assistant" ? (
                  <div className="relative z-10 mr-0.5 flex h-9 w-8 shrink-0 items-end justify-center overflow-visible">
                    <Image
                      src="/welly.svg"
                      alt="Welly"
                      width={32}
                      height={32}
                      className="h-8 w-auto object-contain"
                    />
                  </div>
                ) : null}
                <article
                  className={`relative max-w-[86%] rounded-[1.1rem] px-4 py-3 text-sm leading-6 ${
                    message.role === "user"
                      ? "bg-[#00B5A3] text-white"
                      : "border border-[#d9ebe6] bg-white text-[#193f3a] before:absolute before:-left-[5px] before:bottom-3 before:size-2.5 before:rotate-45 before:border-b before:border-l before:border-[#d9ebe6] before:bg-white"
                  }`}
                >
                  {message.role === "assistant" ? (
                    <ReactMarkdown
                      components={{
                        a: ({ children, href }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-[#007f73] underline decoration-[#9fdad2] underline-offset-4 hover:text-[#005f57]"
                          >
                            {children}
                          </a>
                        ),
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      }}
                    >
                      {message.content}
                    </ReactMarkdown>
                  ) : (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  )}
                </article>
              </div>
            ))}

            {isLoading ? (
              <div className="flex justify-start">
                <div className="rounded-[1.1rem] border border-[#d9ebe6] bg-white px-4 py-3 text-sm text-[#53746d]">
                  Checking our website content...
                </div>
              </div>
            ) : null}
          </div>

          {visibleSuggestions.length > 0 ? (
            <div className="flex flex-wrap gap-2 border-t border-[#d9ebe6] bg-[#f7fbf9] px-3 py-3">
              {visibleSuggestions.map((suggestedQuestion) => (
                <button
                  key={suggestedQuestion}
                  type="button"
                  onClick={() => handleSuggestedQuestion(suggestedQuestion)}
                  disabled={isLoading}
                  className="rounded-full border border-[#abdcd5] bg-white px-3 py-2 text-left text-xs font-medium leading-4 text-[#17665c] transition hover:border-[#00B5A3] hover:bg-[#e5f7f3] focus:outline-none focus:ring-2 focus:ring-[#00B5A3] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {suggestedQuestion}
                </button>
              ))}
            </div>
          ) : null}

          <form onSubmit={handleSubmit} className="border-t border-[#d9ebe6] bg-white p-3">
            {error ? (
              <p className="mb-2 rounded-xl bg-[#fff3ed] px-3 py-2 text-xs font-medium text-[#8a3d1e]">
                {error}
              </p>
            ) : null}
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={MAX_QUESTION_LENGTH}
                rows={1}
                placeholder="Ask about Sundays, serving, giving..."
                className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl border border-[#cfe5df] bg-[#fbfdfb] px-4 py-3 text-sm leading-5 text-[#173f39] outline-none transition placeholder:text-[#7d9a94] focus:border-[#00B5A3] focus:ring-2 focus:ring-[#b8eee7]"
              />
              <button
                type="submit"
                disabled={!question.trim() || isLoading}
                className="flex h-11 shrink-0 items-center justify-center rounded-2xl bg-[#00B5A3] px-4 text-sm font-semibold text-white transition hover:bg-[#009989] focus:outline-none focus:ring-2 focus:ring-[#00B5A3] focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#9bcfca]"
              >
                Send
              </button>
            </div>
            {question.length >= MAX_QUESTION_LENGTH * 0.8 ? (
              <p className="mt-1.5 pr-1 text-right text-[11px] text-[#66857f]">
                {question.length.toLocaleString()} / {MAX_QUESTION_LENGTH.toLocaleString()}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}

      {!embedded || !isOpen ? (
        <button
          type="button"
          onClick={() => setIsOpen((current) => !current)}
          className={`flex items-center justify-center rounded-full text-white shadow-[0_14px_34px_rgba(0,127,115,0.28)] transition focus:outline-none focus:ring-2 focus:ring-[#00B5A3] focus:ring-offset-2 ${
            isCompactLauncher
              ? `size-14 ${isOpen ? "bg-[#00B5A3] hover:bg-[#009989]" : "bg-transparent hover:scale-[1.04]"}`
              : "h-[4.5rem] bg-[#00B5A3] px-7 text-lg font-semibold hover:bg-[#009989]"
          }`}
          aria-expanded={isOpen}
          aria-label={isOpen ? "Close The Well chat" : "Open The Well chat"}
          title={isOpen ? "Close chat" : "Ask a question"}
        >
          {isCompactLauncher ? <span className="flex size-14 items-center justify-center" aria-hidden="true">
            {isOpen ? (
              <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <Image src="/welly.svg" alt="" width={56} height={56} className="size-14" />
            )}
          </span> : <span>{isOpen ? "Close" : "Questions?"}</span>}
        </button>
      ) : null}
    </div>
  );
}

function recordTelemetry(queryId: string, requestStartedAt: number, firstTokenAt: number, completedAt: number): void {
  if (!queryId) return;

  void fetch("/api/chat/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query_id: queryId,
      time_to_first_token_ms: Math.round(firstTokenAt - requestStartedAt),
      total_response_time_ms: Math.round(completedAt - requestStartedAt),
    }),
    keepalive: true,
  }).catch(() => undefined);
}
