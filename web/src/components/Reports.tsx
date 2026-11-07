/**
 * The evidence behind the score: each researcher's report and the gap analysis.
 */

import type { GapReport, Report, Source } from "../api";

function List({ items, title }: { items: string[]; title: string }) {
  if (!items.length) return null;
  return (
    <div className="ev-block">
      <h4>{title}</h4>
      <ul className="ev-list">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Chips({ items, title }: { items: string[]; title: string }) {
  if (!items.length) return null;
  return (
    <div className="ev-block">
      <h4>{title}</h4>
      <div className="chips">
        {items.map((item) => (
          <span key={item} className="chip">
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  if (!sources.length) return null;
  return (
    <div className="ev-block">
      <h4>Sources</h4>
      <ul className="ev-list ev-sources">
        {sources.map((s) => (
          <li key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.title || s.url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReportView({ report }: { report: Report }) {
  if (report.error) {
    return (
      <p className="ev-error" role="status">
        {report.error} The other researchers went on without it.
      </p>
    );
  }
  if (report.job) {
    const job = report.job;
    return (
      <div className="ev">
        <p className="ev-summary">
          {job.seniority ? <strong>{job.seniority}. </strong> : null}
          {job.summary}
        </p>
        <div className="ev-cols">
          <List title="Must have" items={job.must_have} />
          <List title="Responsibilities" items={job.responsibilities} />
          <List title="Nice to have" items={job.nice_to_have} />
          <Chips title="Keywords an ATS matches on" items={job.keywords} />
        </div>
        <Sources sources={job.sources} />
      </div>
    );
  }
  if (report.company) {
    const co = report.company;
    return (
      <div className="ev">
        <p className="ev-summary">{co.summary}</p>
        <div className="ev-cols">
          <List title="Products" items={co.products} />
          <Chips title="Tech stack" items={co.tech_stack} />
          <List title="Values" items={co.values} />
          <List title="Recent news" items={co.recent_news} />
        </div>
        {co.tone ? <p className="ev-note">Tone: {co.tone}</p> : null}
        <Sources sources={co.sources} />
      </div>
    );
  }
  if (report.market) {
    const mk = report.market;
    return (
      <div className="ev">
        <p className="ev-summary">{mk.summary}</p>
        <div className="ev-cols">
          <Chips title="In-demand skills" items={mk.in_demand_skills} />
          <List title="Title variants" items={mk.title_variants} />
          <List title="Level signals" items={mk.level_signals} />
        </div>
        <Sources sources={mk.sources} />
      </div>
    );
  }
  if (report.linkedin) {
    const li = report.linkedin;
    return (
      <div className="ev">
        <p className="ev-summary">{li.summary}</p>
        <div className="ev-cols">
          <List title="Headline" items={li.headline_issues} />
          <List title="About" items={li.about_issues} />
          <List title="On your resume, missing on LinkedIn" items={li.experience_gaps} />
          <List title="Dates or titles that disagree" items={li.inconsistencies} />
        </div>
      </div>
    );
  }
  return <p className="ev-note">This report is empty.</p>;
}

export function GapView({ gap }: { gap: GapReport }) {
  return (
    <div className="ev">
      <p className="ev-summary">
        <strong>{gap.score} / 100</strong> overall match · {Math.round(gap.keyword_coverage * 100)}%
        of the role&apos;s keywords found ({gap.matched_keywords.length} of{" "}
        {gap.matched_keywords.length + gap.missing_keywords.length}
        ).
      </p>
      <div className="ev-cols">
        <div className="ev-block">
          <h4>Keywords</h4>
          <div className="chips">
            {gap.matched_keywords.map((kw) => (
              <span key={kw} className="chip">
                {kw}
              </span>
            ))}
            {gap.missing_keywords.map((kw) => (
              <span key={kw} className="chip chip-missing" title="Missing from your resume">
                {kw}
              </span>
            ))}
          </div>
        </div>
        <List title="Fix first" items={gap.priorities} />
        <List title="Strengths for this role" items={gap.strengths} />
        <List title="Format issues an ATS may trip on" items={gap.format_issues} />
      </div>
      {gap.weak_bullets.length ? (
        <p className="ev-note">Weak bullets: {gap.weak_bullets.join(", ")}</p>
      ) : null}
    </div>
  );
}
