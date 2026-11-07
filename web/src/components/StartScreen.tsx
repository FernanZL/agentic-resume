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

/** The parts of the run, drawn as a small static score (illustration, not live data). */
const ENSEMBLE = [
  { name: "Assistant", does: "talks with you, starts the team", at: 0, len: 8 },
  {
    name: "Researchers ×4",
    does: "posting, company, market, LinkedIn, in parallel",
    at: 10,
    len: 34,
  },
  {
    name: "Gap analysis",
    does: "keywords counted in code, then a recruiter's rubric",
    at: 46,
    len: 10,
  },
  { name: "Writers", does: "resume and LinkedIn rewrites from your own facts", at: 58, len: 16 },
  { name: "Critic", does: "checks every number, sends weak rewrites back", at: 66, len: 22 },
  { name: "You", does: "accept, edit or reject each change", at: 90, len: 0 },
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
    <section className="start" aria-labelledby="start-title">
      <div className="start-intro">
        <h1 id="start-title">Tailor your resume with a team of agents you can watch.</h1>
        <p>
          Give it your resume and the role. Researchers study the posting, the company and the
          market in parallel, writers propose changes grounded in your own words, and a critic sends
          back anything it can&apos;t verify. Nothing is exported until you decide on every change.
        </p>
        <ol className="ensemble" aria-label="The team">
          {ENSEMBLE.map((part) => (
            <li key={part.name} className="ensemble-part">
              <span className="ensemble-name">{part.name}</span>
              <span className="ensemble-line" aria-hidden="true">
                {part.len ? (
                  <span
                    className="ensemble-beam"
                    style={{ left: `${part.at}%`, width: `${part.len}%` }}
                  />
                ) : (
                  <svg className="fermata" style={{ left: `${part.at}%` }} viewBox="0 0 32 18">
                    <path
                      d="M2 16 A14 14 0 0 1 30 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                    />
                    <circle cx="16" cy="13" r="2.6" fill="currentColor" />
                  </svg>
                )}
              </span>
              <span className="ensemble-does">{part.does}</span>
            </li>
          ))}
        </ol>
        <div className="row">
          <button type="button" className="btn" onClick={handleLoadSample}>
            <IconSpark width={16} height={16} aria-hidden="true" />
            Try it with a fictional sample
          </button>
          {isMockMode() ? (
            <button type="button" className="btn btn-quiet" onClick={onOpenDemoSession}>
              Open the finished demo
            </button>
          ) : null}
        </div>
      </div>

      <form className="start-form" onSubmit={handleSubmit} noValidate aria-label="New session">
        {localValidationError ? (
          <p className="form-error" role="alert">
            {localValidationError}
          </p>
        ) : null}

        <fieldset className="form-part">
          <legend>Your documents</legend>
          <div className="field-head">
            <label htmlFor="resume-input">Resume</label>
            <div className="switch" role="tablist" aria-label="Resume input method">
              <button
                type="button"
                role="tab"
                aria-selected={resumeMode === "paste"}
                onClick={() => setResumeMode("paste")}
              >
                Paste text
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={resumeMode === "upload"}
                onClick={() => setResumeMode("upload")}
              >
                Upload a file
              </button>
            </div>
          </div>
          {resumeMode === "paste" ? (
            <textarea
              id="resume-input"
              className="field"
              rows={9}
              placeholder="Paste your whole resume: at least 50 characters."
              value={resumeText}
              onChange={(e) => {
                setResumeText(e.target.value);
                setResumeDoc(null);
              }}
            />
          ) : (
            <div className="drop">
              <IconDocument width={22} height={22} aria-hidden="true" />
              <label htmlFor="resume-file-input">PDF, DOCX, TXT or Markdown, up to 2 MB</label>
              <input
                id="resume-file-input"
                aria-label="Upload resume file"
                type="file"
                accept=".pdf,.docx,.txt,.md"
                onChange={(e) => void handleFileUpload("resume", e)}
              />
              {resumeBusy ? <span className="drop-status">Reading the file…</span> : null}
            </div>
          )}
          {resumeDoc ? (
            <p className="parsed">
              <IconCheck width={15} height={15} aria-hidden="true" />
              Read {resumeDoc.characters.toLocaleString()} characters, starting “
              {resumeDoc.preview.slice(0, 70)}…”
            </p>
          ) : null}

          <div className="field-head">
            <span className="label" id="linkedin-label">
              LinkedIn profile, optional
            </span>
            <div className="switch" role="tablist" aria-labelledby="linkedin-label">
              <button
                type="button"
                role="tab"
                aria-selected={linkedinMode === "none"}
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
                onClick={() => setLinkedinMode("paste")}
              >
                Paste text
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={linkedinMode === "upload"}
                onClick={() => setLinkedinMode("upload")}
              >
                Upload the PDF
              </button>
            </div>
          </div>
          {linkedinMode === "paste" ? (
            <textarea
              id="linkedin-input"
              aria-label="LinkedIn profile text"
              className="field"
              rows={5}
              placeholder="Paste your headline, About and experience."
              value={linkedinText}
              onChange={(e) => {
                setLinkedinText(e.target.value);
                setLinkedinDoc(null);
              }}
            />
          ) : null}
          {linkedinMode === "upload" ? (
            <div className="drop">
              <label htmlFor="linkedin-file-input">
                LinkedIn&apos;s “Save to PDF” export of your profile
              </label>
              <input
                id="linkedin-file-input"
                aria-label="Upload LinkedIn file"
                type="file"
                accept=".pdf,.docx,.txt,.md"
                onChange={(e) => void handleFileUpload("linkedin", e)}
              />
              {linkedinBusy ? <span className="drop-status">Reading the PDF…</span> : null}
            </div>
          ) : null}
          {linkedinDoc ? (
            <p className="parsed">
              <IconCheck width={15} height={15} aria-hidden="true" />
              Read {linkedinDoc.characters.toLocaleString()} characters of your LinkedIn profile
            </p>
          ) : null}
          <p className="hint">LinkedIn is never scraped: export your profile or paste it.</p>
        </fieldset>

        <fieldset className="form-part">
          <legend>The role</legend>
          <div className="field-pair">
            <div>
              <label htmlFor="target-title">Job title</label>
              <input
                id="target-title"
                className="field"
                type="text"
                required
                placeholder="e.g. Staff Distributed Systems Engineer"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="target-company">Company, optional</label>
              <input
                id="target-company"
                className="field"
                type="text"
                placeholder="e.g. VelaStream Cloud"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>
          </div>
          <label htmlFor="target-url">Posting URL, optional</label>
          <input
            id="target-url"
            className="field"
            type="url"
            placeholder="e.g. https://jobs.example.com/role"
            value={jobUrl}
            onChange={(e) => setJobUrl(e.target.value)}
          />
          <label htmlFor="target-jd-text">Posting text</label>
          <textarea
            id="target-jd-text"
            className="field"
            rows={6}
            placeholder="Paste the posting if the link needs a sign-in. It makes the research much sharper."
            value={jobText}
            onChange={(e) => setJobText(e.target.value)}
          />
          <label htmlFor="target-notes">Anything else, optional</label>
          <input
            id="target-notes"
            className="field"
            type="text"
            placeholder="e.g. level, region, what to emphasize"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </fieldset>

        <div className="form-submit">
          <button
            type="submit"
            className="btn btn-primary btn-large"
            disabled={submitting || resumeBusy || linkedinBusy}
          >
            {submitting ? "Starting the team…" : "Start the analysis"}
          </button>
          <p className="hint">
            The run takes a few minutes. You can watch every agent while it plays.
          </p>
        </div>
      </form>
    </section>
  );
}
