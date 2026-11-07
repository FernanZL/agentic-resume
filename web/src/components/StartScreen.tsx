/**
 * Start screen: architectural masthead with pipeline schematic, document upload/paste, and target role inputs.
 */

import { type ChangeEvent, type FormEvent, useState } from "react";
import {
  type DocumentCreated,
  createSession,
  isMockMode,
  submitDocumentText,
  uploadDocument,
} from "../api";
import { SAMPLE_JOB_TEXT, SAMPLE_LINKEDIN_TEXT, SAMPLE_RESUME_TEXT } from "../mock/fixtures";
import { IconCheck, IconDocument, IconSpark } from "./Icons";

export interface StartScreenProps {
  onSessionCreated: (sessionId: string) => void;
  onOpenDemoSession: () => void;
  onApiError: (err: unknown) => void;
}

const PIPELINE_STEPS = [
  { stage: "Intake", detail: "Parse PDF/DOCX & screen safety" },
  { stage: "Send × 4 Research", detail: "Job · Company · Market · LinkedIn" },
  { stage: "ATS Gap Matrix", detail: "Deterministic TF-IDF + LLM rubric" },
  { stage: "Writers ∥ Critic", detail: "Grounded diffs & metric audit" },
  { stage: "Human Review", detail: "Approve, edit [X]%, export DOCX/PDF" },
];

export function StartScreen({ onSessionCreated, onOpenDemoSession, onApiError }: StartScreenProps) {
  const [resumeMode, setResumeMode] = useState<"paste" | "upload">("paste");
  const [resumeText, setResumeText] = useState("");
  const [resumeDoc, setResumeDoc] = useState<DocumentCreated | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);

  const [linkedinMode, setLinkedinMode] = useState<"none" | "paste" | "upload">("none");
  const [linkedinText, setLinkedinText] = useState("");
  const [linkedinDoc, setLinkedinDoc] = useState<DocumentCreated | null>(null);
  const [linkedinBusy, setLinkedinBusy] = useState(false);

  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [jobText, setJobText] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [localValidationError, setLocalValidationError] = useState("");

  const handleFileUpload = async (
    kind: "resume" | "linkedin",
    e: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLocalValidationError("");
    if (kind === "resume") setResumeBusy(true);
    else setLinkedinBusy(true);

    try {
      const created = await uploadDocument(kind, file);
      if (kind === "resume") setResumeDoc(created);
      else setLinkedinDoc(created);
    } catch (err) {
      onApiError(err);
    } finally {
      if (kind === "resume") setResumeBusy(false);
      else setLinkedinBusy(false);
    }
  };

  const handleLoadSample = () => {
    setLocalValidationError("");
    setResumeMode("paste");
    setResumeText(SAMPLE_RESUME_TEXT);
    setResumeDoc(null);
    setLinkedinMode("paste");
    setLinkedinText(SAMPLE_LINKEDIN_TEXT);
    setLinkedinDoc(null);
    setTitle("Staff Distributed Systems Engineer");
    setCompany("VelaStream Cloud");
    setJobUrl("https://velastream.example.com/jobs/staff-distributed");
    setJobText(SAMPLE_JOB_TEXT);
    setNotes("Staff IC6 level, Seattle or Remote");
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalValidationError("");

    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setLocalValidationError("Enter the target job title to start the analysis.");
      return;
    }

    setSubmitting(true);
    try {
      let finalResumeDoc = resumeDoc;
      if (!finalResumeDoc) {
        if (resumeText.trim().length < 50) {
          setLocalValidationError(
            "Provide a resume file (.pdf, .docx, .txt, .md) or paste at least 50 characters of resume text.",
          );
          setSubmitting(false);
          return;
        }
        finalResumeDoc = await submitDocumentText({
          kind: "resume",
          text: resumeText.trim(),
        });
        setResumeDoc(finalResumeDoc);
      }

      let finalLinkedinDoc = linkedinDoc;
      if (!finalLinkedinDoc && linkedinMode === "paste" && linkedinText.trim().length >= 50) {
        finalLinkedinDoc = await submitDocumentText({
          kind: "linkedin",
          text: linkedinText.trim(),
        });
        setLinkedinDoc(finalLinkedinDoc);
      }

      const accepted = await createSession({
        resume_document_id: finalResumeDoc.document_id,
        linkedin_document_id: finalLinkedinDoc?.document_id ?? "",
        target: {
          title: cleanTitle,
          company: company.trim(),
          job_url: jobUrl.trim(),
          job_text: jobText.trim(),
          notes: notes.trim(),
        },
      });

      onSessionCreated(accepted.session_id);
    } catch (err) {
      onApiError(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="start-shell" aria-label="Start optimization session">
      <div className="start-masthead">
        <div className="masthead-main">
          <div className="masthead-copy">
            <h1>Evidence-Bound Resume &amp; LinkedIn Optimization</h1>
            <p>
              Every claim is traced to your source documents. Four parallel LangGraph researchers
              map the posting, company engineering stack, market rubric, and ATS keyword coverage
              before the writers and anti-fabrication critic prepare section-by-section diffs for
              your approval.
            </p>
          </div>

          <div className="masthead-actions">
            <button type="button" className="btn btn-primary" onClick={handleLoadSample}>
              <IconSpark width={16} height={16} />
              <span>Load Fictional Sample (Elena Vance)</span>
            </button>
            {isMockMode() ? (
              <button type="button" className="btn btn-ghost" onClick={onOpenDemoSession}>
                <span>Open Completed Demo (/s/demo)</span>
              </button>
            ) : null}
          </div>
        </div>

        <ol className="masthead-pipeline" aria-label="Optimization pipeline architecture">
          {PIPELINE_STEPS.map((item) => (
            <li key={item.stage} className="masthead-step">
              <strong>{item.stage}</strong>
              <span>{item.detail}</span>
            </li>
          ))}
        </ol>
      </div>

      {localValidationError ? (
        <div className="banner banner-error" role="alert">
          <span>{localValidationError}</span>
        </div>
      ) : null}

      <form className="start-grid" onSubmit={handleSubmit} noValidate>
        <div className="panel start-column">
          <div className="panel-header">
            <h2>Candidate Documents</h2>
            <span className="meta-tag">Required: Resume · Optional: LinkedIn</span>
          </div>

          <div className="field-block">
            <div className="field-header-row">
              <label htmlFor="resume-input" className="field-label">
                Candidate Resume
              </label>
              <div className="segmented-tabs" role="tablist" aria-label="Resume input method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={resumeMode === "paste"}
                  className={`seg-tab ${resumeMode === "paste" ? "active" : ""}`}
                  onClick={() => setResumeMode("paste")}
                >
                  Paste Text
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={resumeMode === "upload"}
                  className={`seg-tab ${resumeMode === "upload" ? "active" : ""}`}
                  onClick={() => setResumeMode("upload")}
                >
                  Upload PDF / DOCX
                </button>
              </div>
            </div>

            {resumeMode === "paste" ? (
              <textarea
                id="resume-input"
                className="input-textarea"
                rows={10}
                placeholder="Paste your full resume text (at least 50 characters)..."
                value={resumeText}
                onChange={(e) => {
                  setResumeText(e.target.value);
                  setResumeDoc(null);
                }}
              />
            ) : (
              <div className="upload-dropzone">
                <IconDocument width={24} height={24} />
                <label htmlFor="resume-file-input" className="upload-label">
                  Choose Resume File (.pdf, .docx, .txt, .md — max 2 MB)
                </label>
                <input
                  id="resume-file-input"
                  aria-label="Upload resume file"
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(e) => void handleFileUpload("resume", e)}
                />
                {resumeBusy ? <span className="status-inline">Parsing file...</span> : null}
              </div>
            )}

            {resumeDoc ? (
              <div className="doc-preview-pill">
                <IconCheck width={15} height={15} />
                <span>
                  Parsed resume ({resumeDoc.characters.toLocaleString()} chars):{" "}
                  <code>{resumeDoc.preview.slice(0, 90)}…</code>
                </span>
              </div>
            ) : null}
          </div>

          <div className="field-block">
            <div className="field-header-row">
              <label className="field-label">LinkedIn Profile Export (Optional)</label>
              <div className="segmented-tabs" role="tablist" aria-label="LinkedIn input method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkedinMode === "none"}
                  className={`seg-tab ${linkedinMode === "none" ? "active" : ""}`}
                  onClick={() => {
                    setLinkedinMode("none");
                    setLinkedinDoc(null);
                  }}
                >
                  Skip
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkedinMode === "paste"}
                  className={`seg-tab ${linkedinMode === "paste" ? "active" : ""}`}
                  onClick={() => setLinkedinMode("paste")}
                >
                  Paste Text
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={linkedinMode === "upload"}
                  className={`seg-tab ${linkedinMode === "upload" ? "active" : ""}`}
                  onClick={() => setLinkedinMode("upload")}
                >
                  Upload PDF
                </button>
              </div>
            </div>

            {linkedinMode === "paste" ? (
              <textarea
                id="linkedin-input"
                aria-label="LinkedIn profile text"
                className="input-textarea"
                rows={5}
                placeholder="Paste your LinkedIn Headline, About, and Experience text..."
                value={linkedinText}
                onChange={(e) => {
                  setLinkedinText(e.target.value);
                  setLinkedinDoc(null);
                }}
              />
            ) : null}

            {linkedinMode === "upload" ? (
              <div className="upload-dropzone compact">
                <label htmlFor="linkedin-file-input" className="upload-label">
                  Upload LinkedIn &ldquo;Save to PDF&rdquo; export (.pdf, .docx, .txt)
                </label>
                <input
                  id="linkedin-file-input"
                  aria-label="Upload LinkedIn file"
                  type="file"
                  accept=".pdf,.docx,.txt,.md"
                  onChange={(e) => void handleFileUpload("linkedin", e)}
                />
                {linkedinBusy ? (
                  <span className="status-inline">Parsing LinkedIn PDF...</span>
                ) : null}
              </div>
            ) : null}

            {linkedinDoc ? (
              <div className="doc-preview-pill">
                <IconCheck width={15} height={15} />
                <span>Parsed LinkedIn ({linkedinDoc.characters.toLocaleString()} chars)</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="panel start-column">
          <div className="panel-header">
            <h2>Target Position</h2>
            <span className="meta-tag">Title required · URL or Posting Text recommended</span>
          </div>

          <div className="field-row-2">
            <div className="field-block">
              <label htmlFor="target-title" className="field-label">
                Target Job Title *
              </label>
              <input
                id="target-title"
                className="input-text"
                type="text"
                required
                placeholder="e.g. Staff Distributed Systems Engineer"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="field-block">
              <label htmlFor="target-company" className="field-label">
                Company Name
              </label>
              <input
                id="target-company"
                className="input-text"
                type="text"
                placeholder="e.g. VelaStream Cloud"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>
          </div>

          <div className="field-block">
            <label htmlFor="target-url" className="field-label">
              Public Job Posting URL (Optional — paste text below if behind a sign-in wall)
            </label>
            <input
              id="target-url"
              className="input-text"
              type="url"
              placeholder="https://jobs.example.com/role"
              value={jobUrl}
              onChange={(e) => setJobUrl(e.target.value)}
            />
          </div>

          <div className="field-block">
            <label htmlFor="target-jd-text" className="field-label">
              Job Posting Text
            </label>
            <textarea
              id="target-jd-text"
              className="input-textarea"
              rows={8}
              placeholder="Paste the job description, requirements, and responsibilities here..."
              value={jobText}
              onChange={(e) => setJobText(e.target.value)}
            />
          </div>

          <div className="field-block">
            <label htmlFor="target-notes" className="field-label">
              Level, Region &amp; Focus Notes
            </label>
            <input
              id="target-notes"
              className="input-text"
              type="text"
              placeholder="e.g. Staff IC6, remote US, emphasize high-throughput Kafka & SLOs"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="start-actions">
            <button
              type="submit"
              className="btn btn-primary btn-large"
              disabled={submitting || resumeBusy || linkedinBusy}
            >
              {submitting ? "Launching Research Subagents..." : "Launch Optimization Session"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
