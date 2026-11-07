/**
 * Export & Print View panel: gates all export actions on snapshot.reviewed,
 * fetches GET /api/sessions/{id}/export?format=json for preview & LinkedIn copy,
 * and opens GET /api/sessions/{id}/export?format=html in a new tab for Save as PDF.
 * Never renders fixture content in live mode.
 */

import { useEffect, useState } from "react";
import {
  type ExportJson,
  type SessionSnapshot,
  downloadExport,
  formatProfileAsMarkdown,
  getExportHtmlUrl,
  getExportJson,
} from "../api";
import { IconAlert, IconCheck, IconCopy, IconDownload, IconPrint } from "./Icons";

export interface ExportPanelProps {
  snapshot: SessionSnapshot;
  onApiError: (err: unknown) => void;
}

const LINKEDIN_NAMES: Record<string, string> = { headline: "Headline", about: "About" };

export function ExportPanel({ snapshot, onApiError }: ExportPanelProps) {
  const [downloading, setDownloading] = useState<"docx" | "md" | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exportData, setExportData] = useState<ExportJson | null>(null);
  const [loadingExport, setLoadingExport] = useState(false);

  const isReviewed = Boolean(snapshot.reviewed);

  useEffect(() => {
    if (!isReviewed) {
      setExportData(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoadingExport(true);

    getExportJson(snapshot.session_id, controller.signal)
      .then((data) => {
        if (!cancelled) {
          setExportData(data);
        }
      })
      .catch((err: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof Error && err.name === "AbortError") return;
        onApiError(err);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingExport(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isReviewed, snapshot.session_id, snapshot.decisions, onApiError]);

  const handleDownload = async (format: "docx" | "md") => {
    if (!isReviewed) return;
    setDownloading(format);
    try {
      const blob = await downloadExport(snapshot.session_id, format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `optimized-resume.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      onApiError(err);
    } finally {
      setDownloading(null);
    }
  };

  const handleCopy = async (key: string, text: string) => {
    if (!isReviewed) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // Ignore clipboard failures in restricted headless environments.
    }
  };

  const handleOpenPrintHtml = () => {
    if (!isReviewed) return;
    window.open(getExportHtmlUrl(snapshot.session_id), "_blank", "noopener,noreferrer");
  };

  const linkedinEntries = exportData ? Object.entries(exportData.linkedin) : [];
  const resumeProfile = exportData?.resume ?? null;
  const markdownPreview = resumeProfile
    ? formatProfileAsMarkdown(resumeProfile, snapshot.target.title)
    : "";

  return (
    <section className="export" aria-labelledby="export-title">
      <header className="export-head no-print">
        <div>
          <h2 id="export-title">Export Artifacts &amp; LinkedIn Copy</h2>
          <p>
            {isReviewed
              ? "Built from the proposals you accepted or edited. Everything else stays as you wrote it."
              : "Exports open once you submit your review. Proposals left without a decision count as rejected."}
          </p>
        </div>
        <div className="export-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!isReviewed || downloading !== null}
            onClick={() => void handleDownload("docx")}
          >
            <IconDownload width={15} height={15} aria-hidden="true" />
            {downloading === "docx" ? "Preparing DOCX…" : "Download DOCX"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!isReviewed || downloading !== null}
            onClick={() => void handleDownload("md")}
          >
            <IconDownload width={15} height={15} aria-hidden="true" />
            {downloading === "md" ? "Preparing Markdown…" : "Download Markdown"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!isReviewed}
            onClick={handleOpenPrintHtml}
          >
            <IconPrint width={15} height={15} aria-hidden="true" />
            Save as PDF (Print View)
          </button>
        </div>
      </header>

      {!isReviewed ? (
        <p className="export-locked" role="status">
          <IconAlert width={16} height={16} aria-hidden="true" />
          Submit your review first. Proposals left without a decision count as rejected.
        </p>
      ) : loadingExport && !exportData ? (
        <p className="loading">Preparing your reviewed documents…</p>
      ) : null}

      {isReviewed && linkedinEntries.length > 0 ? (
        <section className="linkedin no-print" aria-labelledby="linkedin-title">
          <h3 id="linkedin-title">LinkedIn copy</h3>
          <ul className="linkedin-list">
            {linkedinEntries.map(([target, finalCopy]) => {
              const copyKey = `linkedin:${target}`;
              const isCopied = copiedId === copyKey;
              return (
                <li key={copyKey} className="linkedin-item">
                  <div className="linkedin-item-head">
                    <strong>{LINKEDIN_NAMES[target] ?? `Experience (${target})`}</strong>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => void handleCopy(copyKey, finalCopy)}
                    >
                      {isCopied ? (
                        <IconCheck width={14} height={14} aria-hidden="true" />
                      ) : (
                        <IconCopy width={14} height={14} aria-hidden="true" />
                      )}
                      {isCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  <p className="linkedin-text">{finalCopy}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {isReviewed && resumeProfile ? (
        <section className="sheet-wrap" aria-label="Your reviewed resume">
          <div className="sheet-bar no-print">
            <span>Your reviewed resume, single column and ATS-safe</span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => void handleCopy("full-md", markdownPreview)}
            >
              {copiedId === "full-md" ? (
                <IconCheck width={14} height={14} aria-hidden="true" />
              ) : (
                <IconCopy width={14} height={14} aria-hidden="true" />
              )}
              {copiedId === "full-md" ? "Copied Markdown" : "Copy Markdown"}
            </button>
          </div>
          <article className="sheet">
            <header>
              <h1>{resumeProfile.name}</h1>
              {resumeProfile.headline ? (
                <p className="sheet-headline">{resumeProfile.headline}</p>
              ) : null}
              <p className="sheet-contact">{resumeProfile.contact.join(" · ")}</p>
            </header>
            {resumeProfile.summary ? (
              <section>
                <h2>Summary</h2>
                <p>{resumeProfile.summary}</p>
              </section>
            ) : null}
            <section>
              <h2>Experience</h2>
              {resumeProfile.experience.map((exp) => (
                <div key={exp.id} className="sheet-role">
                  <h3>
                    {exp.title} — {[exp.organization, exp.location].filter(Boolean).join(", ")}
                  </h3>
                  <p className="sheet-dates">{[exp.start, exp.end].filter(Boolean).join(" – ")}</p>
                  <ul>
                    {exp.bullets.map((b) => (
                      <li key={b.id}>{b.text}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
            {resumeProfile.education.length ? (
              <section>
                <h2>Education</h2>
                {resumeProfile.education.map((edu, idx) => (
                  <p key={idx}>
                    <strong>{edu.degree}</strong>, {edu.institution}
                    {edu.year ? ` (${edu.year})` : ""}
                    {edu.details ? ` — ${edu.details}` : ""}
                  </p>
                ))}
              </section>
            ) : null}
            {resumeProfile.skills.length ? (
              <section>
                <h2>Skills</h2>
                <p>{resumeProfile.skills.join(", ")}</p>
              </section>
            ) : null}
          </article>
        </section>
      ) : null}
    </section>
  );
}
