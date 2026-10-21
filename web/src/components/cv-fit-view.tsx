"use client";

import { useEffect, useState } from "react";
import { FileSearch, Loader2, AlertTriangle, Check, X, HelpCircle, ArrowRight, Upload, FileText, ClipboardPaste, FolderOpen, Library } from "lucide-react";

type Item = {
  key: string;
  capabilities: string[];
  alternatives: boolean;
  askedFor: string;
  covered: boolean;
  coveredBy: string | null;
  evidence: string | null;
};

type CrossRef = { capability: string; source: string; snippet: string };

type Ranked = {
  label: string;
  pdf: string | null;
  date: string | null;
  coverage: number;
  similarity: number;
  requirements: number;
  items: Item[];
  unmatched: string[];
  preferredMet: string[];
  preferredMissing: string[];
  crossReferences: CrossRef[];
  contextGaps: string[];
  levelMismatch: boolean;
};

type Result = {
  decision: "reuse" | "reuse-with-edits" | "regenerate";
  reason: string;
  best: { label: string; pdf: string | null; coverage: number } | null;
  ranked: Ranked[];
  skipped?: { label: string; reason: string }[];
  rejected?: { name: string; reason: string }[];
  uploaded?: string[];
  error?: string;
};

// The headline has to explain itself. A CV showing 75% coverage under a
// "regenerate" verdict reads as a bug unless the reason travels with it — the
// cause is usually the seniority gate, not the coverage number.
const REASON_COPY: Record<string, string> = {
  coverage: "Based on how much of the posting this CV evidences.",
  "level-mismatch":
    "Not the coverage — this CV is written at a different seniority level than the posting asks for. Sending it invites the wrong comparison.",
  "low-coverage": "Too many of the stated requirements have nothing behind them on any CV you have.",
  "no-parseable-requirements":
    "This posting has no requirements section or bullet list, so there was nothing concrete to score against. Read it yourself.",
  "no candidates": "No CVs were found to compare.",
};

const DECISION_TITLE: Record<Result["decision"], string> = {
  reuse: "Send this one",
  "reuse-with-edits": "Send this one, after the fixes below",
  regenerate: "Tailor a new CV",
};

/**
 * The last run, kept so reopening the page does not re-spawn the ranker and so
 * the assistant can answer questions about a result the user is looking at.
 * Deliberately local to the browser: it holds the pasted posting and CV-derived
 * findings, which are the user's own documents and have no business being
 * written into the project or sent anywhere.
 */
const CACHE_KEY = "career-ops:cv-fit:last";

type Cached = { jd: string; result: Result; at: number };

function loadCached(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    return c && c.result && Array.isArray(c.result.ranked) ? c : null;
  } catch {
    return null;
  }
}

function ago(at: number) {
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

export function CvFitView() {
  const [jd, setJd] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dir, setDir] = useState("");
  const [mode, setMode] = useState<"upload" | "paste" | "saved">("upload");
  const [pasted, setPasted] = useState("");
  const [showFolderInSaved, setShowFolderInSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);

  // Restore the previous run instead of making the user re-rank to see it.
  useEffect(() => {
    const c = loadCached();
    if (!c) return;
    setJd(c.jd);
    setResult(c.result);
    setSelected(c.result.ranked[0]?.label ?? null);
    setCachedAt(c.at);
  }, []);

  // LaTeX and Markdown are converted differently server-side, and the only
  // signal available for pasted text is the text itself.
  function guessExtension(text: string) {
    return /\\documentclass|\\begin\{document\}|\\resumeItem/.test(text) ? "tex" : "md";
  }

  function addPasted() {
    const text = pasted.trim();
    if (!text) return;
    const ext = guessExtension(text);
    const n = files.filter((f) => f.name.startsWith("pasted-")).length + 1;
    setFiles((prev) => [
      ...prev,
      new File([text], `pasted-cv-${n}.${ext}`, { type: "text/plain" }),
    ]);
    setPasted("");
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setSelected(null);
    try {
      // Uploaded files go as multipart; a folder path goes as JSON. The server
      // funnels both into the same ranking, so the two paths cannot disagree.
      let res: Response;
      const useFiles = mode !== "saved" && files.length > 0;
      if (useFiles) {
        const form = new FormData();
        form.set("jd", jd);
        if (dir.trim()) form.set("dir", dir.trim());
        for (const f of files) form.append("cv", f);
        res = await fetch("/api/cv-fit", { method: "POST", body: form });
      } else {
        res = await fetch("/api/cv-fit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jd,
            dir: mode === "saved" ? undefined : dir.trim() || undefined,
          }),
        });
      }
      const data = (await res.json()) as Result;
      if (data.error) setError(data.error);
      else {
        setResult(data);
        setSelected(data.ranked[0]?.label ?? null);
        setCachedAt(null);
        try {
          // The assistant reads this key for context, so it must be written
          // before the user can ask about the result they are looking at.
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ jd, result: data, at: Date.now() } satisfies Cached),
          );
        } catch {
          /* quota / private mode — the result still shows, it just will not persist */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const current = result?.ranked.find((r) => r.label === selected) ?? result?.ranked[0] ?? null;
  const crossRefFor = (key: string) => current?.crossReferences.find((c) => c.capability === key);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10 max-sm:pb-24">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted">
          <span className="text-faint">//</span> cv fit
        </p>
        <h1 className="mt-3 text-3xl text-foreground">Which CV should I send?</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted">
          Paste a posting. Each CV is ranked by how much of the posting&apos;s stated
          requirements it actually evidences, with the gaps named. Free — no tokens spent.
        </p>
      </header>

      <textarea
        value={jd}
        onChange={(e) => setJd(e.target.value)}
        rows={9}
        placeholder="Paste the full job description here…"
        className="mt-6 w-full resize-y rounded-xl border border-border bg-surface/40 p-4 font-mono text-xs text-foreground outline-none focus:border-brand/50"
      />

      {/* Three ways to supply a CV, because people keep them in three places:
          a file, a LaTeX source they can paste, or already inside career-ops. */}
      <div className="mt-6 rounded-xl border border-border bg-surface/20 p-5">
        <div className="flex flex-wrap gap-2">
          {([
            ["upload", "Upload files", Upload],
            ["paste", "Paste CV text", ClipboardPaste],
            ["saved", "Use my saved CVs", Library],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition ${
                mode === key
                  ? "border-brand/60 bg-brand/10 text-foreground"
                  : "border-border text-muted hover:border-brand/40"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>

        {mode === "upload" && (
          <div className="mt-4">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-foreground transition hover:border-brand/50">
              <Upload className="size-4" />
              Choose files
              <input
                type="file"
                multiple
                accept=".pdf,.md,.markdown,.txt,.tex,.html,.htm"
                hidden
                onChange={(e) => {
                  setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="mt-2 text-xs text-muted">
              LaTeX (.tex), Markdown, plain text and HTML work out of the box. PDFs need
              poppler installed —{" "}
              <code className="rounded bg-surface/60 px-1 py-0.5 font-mono">brew install poppler</code>{" "}
              — otherwise they are skipped with a note.
            </p>
          </div>
        )}

        {mode === "paste" && (
          <div className="mt-4">
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={8}
              placeholder="Paste your CV — LaTeX source or plain text/Markdown…"
              className="w-full resize-y rounded-lg border border-border bg-surface/40 p-3 font-mono text-xs text-foreground outline-none focus:border-brand/50"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <button
                onClick={addPasted}
                disabled={!pasted.trim()}
                className="rounded-full border border-border px-4 py-1.5 text-xs text-foreground transition hover:border-brand/50 disabled:opacity-40"
              >
                Add this CV
              </button>
              <span className="text-xs text-muted">
                {pasted.trim()
                  ? `Detected as ${guessExtension(pasted).toUpperCase()}.`
                  : "LaTeX is detected automatically and read from source."}{" "}
                Add more than one to compare them.
              </span>
            </div>
          </div>
        )}

        {mode === "saved" && (
          <div className="mt-4">
            <p className="text-sm text-foreground">
              Rank the CVs career-ops already has.
            </p>
            <p className="mt-1 text-xs text-muted">
              Every CV generated by this install, plus your master{" "}
              <code className="rounded bg-surface/60 px-1 py-0.5 font-mono">cv.md</code>. Nothing
              to upload.
            </p>
            <button
              onClick={() => setShowFolderInSaved((v) => !v)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted underline-offset-4 hover:underline"
            >
              <FolderOpen className="size-3.5" />
              {showFolderInSaved ? "Hide folder option" : "Read a different folder instead"}
            </button>
            {showFolderInSaved && (
              <div className="mt-2">
                <input
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="/Users/you/Documents/CVs"
                  className="w-full rounded-lg border border-border bg-surface/40 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-brand/50"
                />
                <p className="mt-1.5 text-xs text-faint">
                  A folder path on the computer running career-ops. Every CV in it is read in
                  place — nothing is copied or uploaded.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Uploaded and pasted CVs share one list: they are the same thing to
            the ranker, and separating them would imply otherwise. */}
        {mode !== "saved" && files.length > 0 && (
          <ul className="mt-4 flex flex-wrap gap-2">
            {files.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-surface/50 px-3 py-1.5 text-xs text-foreground"
              >
                <FileText className="size-3.5 text-muted" />
                {f.name}
                <button
                  onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))}
                  aria-label={`Remove ${f.name}`}
                  className="text-muted transition hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={busy || !jd.trim()}
          className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 disabled:opacity-40 max-sm:min-h-[44px]"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FileSearch className="size-4" />}
          {busy
            ? "Ranking…"
            : mode !== "saved" && files.length
              ? `Rank ${files.length} CV${files.length === 1 ? "" : "s"}`
              : "Rank my CVs"}
        </button>
      </div>

      {error && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted" />
          <span>{error}</span>
        </div>
      )}

      {result && (result.rejected?.length || result.skipped?.length) ? (
        <div className="mt-6 rounded-xl border border-border bg-surface/20 p-4 text-xs text-muted">
          {result.rejected?.map((r) => (
            <p key={r.name}>
              Could not read <span className="text-foreground">{r.name}</span> — {r.reason}
            </p>
          ))}
          {result.skipped?.map((s2) => (
            <p key={s2.label}>
              Skipped <span className="text-foreground">{s2.label}</span> — {s2.reason}
            </p>
          ))}
        </div>
      ) : null}

      {result && result.ranked.length === 0 && (
        <p className="mt-6 text-sm text-muted">
          No CVs to rank. Upload one above, or point it at a folder on this machine.
        </p>
      )}

      {result && cachedAt !== null && (
        <p className="mt-6 text-xs text-muted">
          Showing your last run from {ago(cachedAt)} — nothing was re-run. Press
          &ldquo;Rank my CVs&rdquo; to refresh it.
        </p>
      )}

      {result && current && (
        <>
          <div className="mt-8 rounded-2xl border border-border bg-surface/40 p-6">
            <p className="font-mono text-xs uppercase tracking-wider text-muted">
              {DECISION_TITLE[result.decision]}
            </p>
            <p className="mt-2 text-xl text-foreground">
              {result.decision === "regenerate"
                ? "Nothing you have is the right CV for this posting"
                : (result.best?.pdf ?? result.best?.label)}
            </p>
            <p className="mt-2 text-sm text-muted">
              {REASON_COPY[result.reason] ?? REASON_COPY.coverage}
            </p>
          </div>

          {/* Pick a CV. Ranked, but every one is selectable — the top result is a
              recommendation, not a decision taken on the user's behalf. */}
          <div className="mt-6 flex flex-wrap gap-2">
            {result.ranked.map((r) => {
              const on = r.label === current.label;
              return (
                <button
                  key={r.label}
                  onClick={() => setSelected(r.label)}
                  className={`rounded-full border px-4 py-2 text-xs transition ${
                    on
                      ? "border-brand/60 bg-brand/10 text-foreground"
                      : "border-border text-muted hover:border-brand/40"
                  }`}
                >
                  <span className="font-mono tabular-nums">
                    {r.requirements === 0 ? "—" : `${Math.round(r.coverage * 100)}%`}
                  </span>
                  <span className="ml-2">{r.pdf ?? r.label}</span>
                  {r.levelMismatch && <span className="ml-2 text-faint">· wrong level</span>}
                </button>
              );
            })}
          </div>

          <section className="mt-6 rounded-2xl border border-border bg-surface/30 p-6">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="truncate text-lg text-foreground">{current.pdf ?? current.label}</h2>
              <span className="shrink-0 font-mono text-2xl tabular-nums text-brand">
                {current.requirements === 0 ? "—" : `${Math.round(current.coverage * 100)}%`}
              </span>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-brand transition-all"
                style={{ width: `${Math.round(current.coverage * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              {current.requirements === 0
                ? "Nothing scoreable was found in this posting"
                : `${current.items.filter((i) => i.covered).length} of ${current.requirements} requirement areas evidenced`}
              {current.unmatched.length > 0 && ` · ${current.unmatched.length} lines not analysed`}
            </p>
            {current.levelMismatch && (
              <p className="mt-3 rounded-lg border border-border bg-surface/50 p-3 text-sm text-foreground">
                This CV reads at a different seniority level than the posting. Fix that before
                anything else on this page — it outweighs every gap below.
              </p>
            )}
          </section>

          {/* WHAT NEEDS FIXING first: it is the actionable half, and burying it
              under the good news is how a report gets skimmed and ignored. */}
          {current.items.some((i) => !i.covered) && (
            <section className="mt-6">
              <h3 className="text-sm font-medium text-foreground">
                Needs fixing ({current.items.filter((i) => !i.covered).length})
              </h3>
              <ul className="mt-3 space-y-3">
                {current.items
                  .filter((i) => !i.covered)
                  .map((i) => {
                    const ref = crossRefFor(i.key);
                    return (
                      <li key={i.key} className="rounded-xl border border-border bg-surface/30 p-4">
                        <div className="flex items-start gap-3">
                          <X className="mt-0.5 size-4 shrink-0 text-muted" />
                          <div className="min-w-0">
                            <p className="text-sm text-foreground">
                              {i.key}
                              {i.alternatives && (
                                <span className="ml-2 text-xs text-faint">any one of these</span>
                              )}
                            </p>
                            <p className="mt-1 text-xs text-muted">
                              They asked: &ldquo;{i.askedFor}&rdquo;
                            </p>
                            {ref ? (
                              <div className="mt-3 rounded-lg border border-brand/30 bg-brand/5 p-3">
                                <p className="flex items-center gap-1.5 text-xs text-brand">
                                  <ArrowRight className="size-3" />
                                  You already have this in {ref.source}
                                </p>
                                <p className="mt-1.5 font-mono text-xs leading-relaxed text-muted">
                                  {ref.snippet}
                                </p>
                              </div>
                            ) : (
                              <p className="mt-2 text-xs text-faint">
                                Not on any CV you have. Only add it if you have actually done it.
                              </p>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </section>
          )}

          {current.items.some((i) => i.covered) && (
            <section className="mt-6">
              <h3 className="text-sm font-medium text-foreground">
                Already strong ({current.items.filter((i) => i.covered).length})
              </h3>
              <ul className="mt-3 space-y-2">
                {current.items
                  .filter((i) => i.covered)
                  .map((i) => (
                    <li key={i.key} className="rounded-xl border border-border bg-surface/20 p-3">
                      <div className="flex items-start gap-3">
                        <Check className="mt-0.5 size-4 shrink-0 text-brand" />
                        <div className="min-w-0">
                          <p className="text-sm text-foreground">{i.coveredBy}</p>
                          {i.evidence && (
                            <p className="mt-1 truncate font-mono text-xs text-muted">
                              {i.evidence}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {/* Honesty about the analyser's own blind spots. A confident percentage
              over a fraction of the posting is worse than a smaller number with
              its denominator shown. */}
          {current.unmatched.length > 0 && (
            <section className="mt-6">
              <h3 className="flex items-center gap-2 text-sm font-medium text-muted">
                <HelpCircle className="size-4" />
                Not analysed ({current.unmatched.length})
              </h3>
              <p className="mt-1 text-xs text-faint">
                These requirement lines named nothing this tool recognises, so they are in
                neither number above. Read them yourself.
              </p>
              <ul className="mt-3 space-y-1.5">
                {current.unmatched.map((line, n) => (
                  <li key={n} className="rounded-lg border border-border bg-surface/20 px-3 py-2 text-xs text-muted">
                    {line}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(current.preferredMissing.length > 0 || current.contextGaps.length > 0) && (
            <section className="mt-6 rounded-xl border border-border bg-surface/20 p-4">
              {current.preferredMissing.length > 0 && (
                <p className="text-xs text-muted">
                  <span className="text-foreground">Nice-to-have, not required:</span>{" "}
                  {current.preferredMissing.join(", ")}
                </p>
              )}
              {current.contextGaps.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  <span className="text-foreground">Their stack, not a requirement:</span>{" "}
                  {current.contextGaps.join(", ")} — not counted against you.
                </p>
              )}
            </section>
          )}

          <p className="mt-8 text-xs leading-relaxed text-faint">
            Coverage measures what the posting asked for against what your CV evidences. It is
            not a prediction that you will be called, and a technology named only as part of
            the employer&apos;s own stack is context rather than an entry requirement.
          </p>
        </>
      )}
    </div>
  );
}
