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
    <div className="export-stack">
      <section className="panel no-print" aria-label="Export controls">
        <div className="panel-header">
          <div>
            <h2>Export Artifacts &amp; LinkedIn Copy</h2>
            <p className="panel-subcopy">
              {isReviewed
                ? "Your approved and edited proposals are compiled below. Download DOCX/Markdown or open the print-ready HTML page to Save as PDF."
                : "Exports are disabled until you submit your proposal review decisions in the Review Proposals tab (proposals with no decision count as rejected)."}
            </p>
          </div>

          <div className="export-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!isReviewed || downloading !== null}
              onClick={() => void handleDownload("docx")}
            >
              <IconDownload width={15} height={15} />
              <span>{downloading === "docx" ? "Generating DOCX..." : "Download DOCX"}</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              disabled={!isReviewed || downloading !== null}
              onClick={() => void handleDownload("md")}
            >
              <IconDownload width={15} height={15} />
              <span>{downloading === "md" ? "Generating MD..." : "Download Markdown"}</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              disabled={!isReviewed}
              onClick={handleOpenPrintHtml}
            >
              <IconPrint width={15} height={15} />
              <span>Save as PDF (Print View)</span>
            </button>
          </div>
        </div>

        {!isReviewed ? (
          <div className="critic-issues-box" role="status">
            <IconAlert width={16} height={16} />
            <span>
              Complete and submit your review in <strong>2. Review Proposals</strong> to unlock
              DOCX, Markdown, print-ready HTML/PDF export, and LinkedIn copy blocks. Proposals left
              without a decision count as rejected.
            </span>
          </div>
        ) : loadingExport && !exportData ? (
          <p className="panel-subcopy">Loading reviewed export preview...</p>
        ) : linkedinEntries.length > 0 ? (
          <div className="linkedin-blocks">
            <h3>LinkedIn Copy Blocks</h3>
            <div className="linkedin-cards-grid">
              {linkedinEntries.map(([target, finalCopy]) => {
                const copyKey = `linkedin:${target}`;
                const isCopied = copiedId === copyKey;
                return (
                  <article key={copyKey} className="linkedin-copy-card">
                    <div className="linkedin-copy-header">
                      <strong>LinkedIn — {target.toUpperCase()}</strong>
                      <button
                        type="button"
                        className="btn btn-small btn-secondary"
                        disabled={!isReviewed}
                        onClick={() => void handleCopy(copyKey, finalCopy)}
                      >
                        {isCopied ? (
                          <IconCheck width={14} height={14} />
                        ) : (
                          <IconCopy width={14} height={14} />
                        )}
                        <span>{isCopied ? "Copied" : "Copy Text"}</span>
                      </button>
                    </div>
                    <pre className="linkedin-copy-pre">{finalCopy}</pre>
                  </article>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>

      {isReviewed && resumeProfile ? (
        <section className="print-resume-sheet" aria-label="ATS-safe single-column print preview">
          <div className="print-sheet-banner no-print">
            <span>ATS-Safe Single-Column Resume Preview (from /export?format=json)</span>
            <button
              type="button"
              className="btn btn-small btn-secondary"
              onClick={() => void handleCopy("full-md", markdownPreview)}
            >
              {copiedId === "full-md" ? (
                <IconCheck width={14} height={14} />
              ) : (
                <IconCopy width={14} height={14} />
              )}
              <span>{copiedId === "full-md" ? "Copied Markdown" : "Copy Markdown"}</span>
            </button>
          </div>

          <div className="ats-document">
            <header className="ats-doc-header">
              <h1>{resumeProfile.name}</h1>
              <p className="ats-doc-headline">{snapshot.target.title || resumeProfile.headline}</p>
              <p className="ats-doc-contact">{resumeProfile.contact.join(" · ")}</p>
            </header>

            <section className="ats-doc-section">
              <h2>Professional Summary</h2>
              <p>{resumeProfile.summary}</p>
            </section>

            <section className="ats-doc-section">
              <h2>Experience</h2>
              {resumeProfile.experience.map((exp) => (
                <div key={exp.id} className="ats-exp-item">
                  <div className="ats-exp-header">
                    <strong>
                      {exp.title} — {exp.organization}
                    </strong>
                    <span>
                      {exp.location} | {exp.start} – {exp.end}
                    </span>
                  </div>
                  <ul>
                    {exp.bullets.map((b) => (
                      <li key={b.id}>{b.text}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>

            <section className="ats-doc-section">
              <h2>Education</h2>
              {resumeProfile.education.map((edu, idx) => (
                <p key={idx}>
                  <strong>{edu.degree}</strong>, {edu.institution} ({edu.year})
                  {edu.details ? ` — ${edu.details}` : ""}
                </p>
              ))}
            </section>

            <section className="ats-doc-section">
              <h2>Technical Skills</h2>
              <p>{resumeProfile.skills.join(", ")}</p>
            </section>
          </div>
        </section>
      ) : null}
    </div>
  );
}
