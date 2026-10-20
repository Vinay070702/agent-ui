import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, getResearch, startResearch, submitReview, type StreamHandlers } from "./api";
import type { ProgressEvent, ResearchResponse } from "./types";

const STORAGE_KEY = "research-thread-id";
const STREAM_KEY = "research-stream-progress";

function loadThreadId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveThreadId(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

function loadStreamPref(): boolean {
  try {
    return localStorage.getItem(STREAM_KEY) !== "false"; // streaming is the default
  } catch {
    return true;
  }
}

function Notes({ markdown }: { markdown: string }) {
  return (
    <article className="notes">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </article>
  );
}

function Progress({ label, events, draft }: { label: string; events: ProgressEvent[]; draft: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <>
    <section className="card" role="status">
      <div className="busy">
        <span className="spinner" /> {label} <span className="muted">({seconds}s)</span>
      </div>
      {events.length > 0 && (
        <ul className="progress">
          {events.map((e, i) => (
            <li key={i}>
              <span className="check">✓</span> {e.message}
            </li>
          ))}
        </ul>
      )}
    </section>
    {draft && (
      <>
        <p className="muted">Draft (live)</p>
        <Notes markdown={draft} />
      </>
    )}
    </>
  );
}

export default function App() {
  const [topic, setTopic] = useState("");
  const [feedback, setFeedback] = useState("");
  const [run, setRun] = useState<ResearchResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const frameRef = useRef<number | null>(null);
  const [streaming, setStreaming] = useState(loadStreamPref);
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  // Restore an in-progress run after a page reload.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const id = loadThreadId();
    if (!id) return;
    getResearch(id)
      .then(setRun)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) saveThreadId(null); // server restarted
        else setError(e.message);
      });
  }, []);

  function toggleStreaming(value: boolean) {
    setStreaming(value);
    try {
      localStorage.setItem(STREAM_KEY, String(value));
    } catch {
      /* storage unavailable */
    }
  }

  async function perform(
    label: string,
    action: (handlers?: StreamHandlers) => Promise<ResearchResponse>,
  ) {
    setBusy(label);
    setError(null);
    setEvents([]);
    draftRef.current = "";
    setDraft("");

    // Tokens arrive far faster than React should re-render markdown, so flush at most once per frame.
    const flushDraft = () => {
      frameRef.current = null;
      setDraft(draftRef.current);
    };
    const handlers: StreamHandlers = {
      onProgress: (e) => setEvents((prev) => [...prev, e]),
      onDraft: (delta) => {
        draftRef.current += delta;
        frameRef.current ??= requestAnimationFrame(flushDraft);
      },
      onDraftReset: () => {
        draftRef.current = "";
        setDraft("");
      },
    };
    try {
      const next = await action(streaming ? handlers : undefined);
      setRun(next);
      saveThreadId(next.thread_id);
      setFeedback("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      draftRef.current = "";
      setDraft("");
      setBusy(null);
    }
  }

  const review = run?.status === "awaiting_review" ? run.review : null;
  const decide = (label: string, decision: string) =>
    perform(label, (handlers) => submitReview(run!.thread_id, decision, handlers));

  function reset() {
    saveThreadId(null);
    setRun(null);
    setTopic("");
    setFeedback("");
    setError(null);
  }

  return (
    <main className="container">
      <header className="header">
        <h1>Research Agent</h1>
        <label className="toggle" title="Stream: see each step as it happens. Buffered: wait and get the full result in one response.">
          <input
            type="checkbox"
            checked={streaming}
            disabled={!!busy}
            onChange={(e) => toggleStreaming(e.target.checked)}
          />
          Stream progress
        </label>
      </header>

      {error && <div className="error" role="alert">{error}</div>}

      {!run && (
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            if (topic.trim()) perform("Researching and drafting notes…", (handlers) => startResearch(topic.trim(), handlers));
          }}
        >
          <label htmlFor="topic">What should I research?</label>
          <textarea
            id="topic"
            rows={3}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. How to build knowledge graphs across multiple enterprise products"
            disabled={!!busy}
          />
          <button type="submit" disabled={!!busy || topic.trim().length < 3}>
            Start research
          </button>
        </form>
      )}

      {busy && <Progress label={busy} events={events} draft={draft} />}

      {review && (
        <>
          <section className="card">
            <div className="row">
              <h2>Review draft</h2>
              <span className="badge">Round {review.round}</span>
              <span className={`badge ${review.ai_verdict === "pass" ? "ok" : "warn"}`}>
                AI: {review.ai_verdict}
              </span>
            </div>
            {review.ai_critique && (
              <details>
                <summary>AI critique</summary>
                <p>{review.ai_critique}</p>
              </details>
            )}
            <p className="muted">{review.instructions}</p>

            <label htmlFor="feedback">Feedback (optional for re-search, required for rewrite)</label>
            <textarea
              id="feedback"
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={!!busy}
            />
            <div className="actions">
              <button disabled={!!busy} onClick={() => decide("Saving notes…", "approve")}>
                Approve &amp; save
              </button>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  decide("Searching again…", feedback.trim() ? `search: ${feedback.trim()}` : "search")
                }
              >
                Search again
              </button>
              <button
                className="secondary"
                disabled={!!busy || !feedback.trim()}
                onClick={() => decide("Rewriting notes…", feedback.trim())}
              >
                Rewrite with feedback
              </button>
            </div>
          </section>
          <Notes markdown={review.research_notes} />
        </>
      )}

      {run?.status === "completed" && (
        <>
          <section className="card">
            <div className="row">
              <h2>Saved</h2>
              <span className="badge ok">{run.filename}</span>
            </div>
            <div className="actions">
              <button onClick={reset}>New research</button>
            </div>
          </section>
          {run.research_notes && <Notes markdown={run.research_notes} />}
        </>
      )}

      {run && !busy && run.status === "awaiting_review" && (
        <button className="link" onClick={reset}>Abandon this run</button>
      )}
    </main>
  );
}
