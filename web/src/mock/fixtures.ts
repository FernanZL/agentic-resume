/**
 * Realistic scripted session fixtures for dev/portfolio preview (VITE_MOCK=1).
 * Uses strictly fictional people and organizations.
 */

import type {
  CandidateProfile,
  DocumentCreated,
  Event,
  GapReport,
  Proposal,
  Report,
  SessionSnapshot,
} from "../api";

export const MOCK_SESSION_ID = "sess-fictional-elena-vance-01";
export const MOCK_RUN_ID = "run-fictional-001";

export const SAMPLE_RESUME_TEXT = `ELENA VANCE
Seattle, WA | elena.vance.fictional@example.org | github.com/elenavance-dev

SUMMARY
Senior Backend Engineer with 7 years of experience building distributed data pipelines and API services in Python and Go. Experienced with PostgreSQL, Docker, and cloud infrastructure.

EXPERIENCE
Lead Software Engineer | Solstice Telemetry Inc. | Seattle, WA | Mar 2022 - Present
- Built ingestion services in Python and FastAPI processing 45,000 events/sec across 18 regional clusters.
- Migrated legacy monolith billing workflows to PostgreSQL and Kafka, cutting batch settlement time from 4 hours to 18 minutes.
- Worked with product and SRE teams on reliability, on-call runbooks, and deployment automation.

Software Engineer II | Northwind Logistics | Portland, OR | Jul 2019 - Feb 2022
- Developed shipment routing microservices in Go and Python serving 1.4M daily package updates.
- Implemented Redis caching layer and query indexing that lowered database CPU load by 35%.
- Maintained CI/CD workflows and container images for 12 backend services.

EDUCATION
B.S. in Computer Science | Cascadia State University | 2019

SKILLS
Python, Go, FastAPI, PostgreSQL, Kafka, Redis, Docker, Linux, Git, REST APIs`;

export const SAMPLE_LINKEDIN_TEXT = `Headline: Lead Software Engineer at Solstice Telemetry
About: Backend engineer focused on Python, Go, and scalable data systems. Passionate about clean architecture and reliable APIs.
Experience:
- Lead Software Engineer at Solstice Telemetry Inc. (2022 - Present): Building high-throughput telemetry services.
- Software Engineer at Northwind Logistics (2019 - 2022): Backend services for logistics routing.
Skills: Python, Go, PostgreSQL, Docker, Microservices`;

export const SAMPLE_JOB_TEXT = `Staff Distributed Systems Engineer — VelaStream Cloud (Remote / Seattle)
We are seeking a Staff Distributed Systems Engineer to architect our next-generation real-time observability and event streaming control plane.

Requirements (Must Have):
- 6+ years building high-throughput backend systems in Python, Go, or Rust
- Deep production expertise with Kubernetes (K8s), Kafka, PostgreSQL, and OpenTelemetry
- Proven track record designing multi-region fault-tolerant architectures and SLO-driven observability
- Experience mentoring engineers and leading cross-team technical RFCs

Nice to Have:
- Experience with Terraform, gRPC, and ClickHouse
- Cost optimization (FinOps) on AWS or GCP`;

export const MOCK_CANDIDATE_PROFILE: CandidateProfile = {
  name: "Elena Vance",
  headline: "Staff Distributed Systems & Platform Engineer",
  contact: ["Seattle, WA", "elena.vance.fictional@example.org", "github.com/elenavance-dev"],
  summary:
    "Senior Backend Engineer with 7 years of experience building distributed data pipelines and API services in Python and Go.",
  experience: [
    {
      id: "exp0",
      title: "Lead Software Engineer",
      organization: "Solstice Telemetry Inc.",
      kind: "employment",
      source_section: "Experience",
      location: "Seattle, WA",
      start: "Mar 2022",
      end: "Present",
      bullets: [
        {
          id: "exp0.b0",
          text: "Built ingestion services in Python and FastAPI processing 45,000 events/sec across 18 regional clusters.",
        },
        {
          id: "exp0.b1",
          text: "Migrated legacy monolith billing workflows to PostgreSQL and Kafka, cutting batch settlement time from 4 hours to 18 minutes.",
        },
        {
          id: "exp0.b2",
          text: "Worked with product and SRE teams on reliability, on-call runbooks, and deployment automation.",
        },
      ],
    },
    {
      id: "exp1",
      title: "Software Engineer II",
      organization: "Northwind Logistics",
      kind: "employment",
      source_section: "Experience",
      location: "Portland, OR",
      start: "Jul 2019",
      end: "Feb 2022",
      bullets: [
        {
          id: "exp1.b0",
          text: "Developed shipment routing microservices in Go and Python serving 1.4M daily package updates.",
        },
        {
          id: "exp1.b1",
          text: "Implemented Redis caching layer and query indexing that lowered database CPU load by 35%.",
        },
      ],
    },
    {
      id: "exp2",
      title: "OpenTelemetry Tail-Sampler CLI",
      organization: "Open Source",
      kind: "project",
      source_section: "Projects",
      location: "",
      start: "",
      end: "",
      bullets: [
        {
          id: "exp2.b0",
          text: "Built a deterministic trace-replay CLI in Go for benchmarking tail-sampling policies.",
        },
      ],
    },
  ],
  education: [
    {
      degree: "B.S. in Computer Science",
      institution: "Cascadia State University",
      year: "2019",
      details: "Distributed Systems Track",
    },
  ],
  skills: [
    "Python",
    "Go",
    "FastAPI",
    "PostgreSQL",
    "Kafka",
    "Redis",
    "Docker",
    "CI/CD",
    "REST APIs",
  ],
  certifications: ["CKA — Certified Kubernetes Administrator (2024)"],
  languages: ["English"],
  other: ["Speaker, GopherCon NW 2025"],
};

export const MOCK_REPORTS: Record<string, Report> = {
  job: {
    kind: "job",
    job: {
      summary:
        "Staff-level IC role owning VelaStream's multi-region event streaming control plane, requiring strong Python/Go throughput credentials plus explicit SLO, Kubernetes, and RFC leadership signals.",
      seniority: "Staff (IC6 / L6)",
      must_have: [
        "6+ years building high-throughput backend systems in Python or Go",
        "Production Kafka, PostgreSQL, and Kubernetes (K8s)",
        "Multi-region fault tolerance & SLO-driven observability (OpenTelemetry)",
        "Technical RFC authorship and cross-team mentorship",
      ],
      nice_to_have: ["Terraform", "gRPC", "ClickHouse", "Cloud FinOps / cost optimization"],
      responsibilities: [
        "Architect multi-region ingestion and stream routing services",
        "Define latency/availability SLOs and OpenTelemetry instrumentation standards",
        "Author technical RFCs and mentor senior engineers across 3 platform squads",
      ],
      keywords: [
        "Python",
        "Go",
        "Kubernetes",
        "Kafka",
        "PostgreSQL",
        "OpenTelemetry",
        "Distributed Systems",
        "Multi-region",
        "SLOs",
        "gRPC",
        "Terraform",
        "CI/CD",
      ],
      sources: [
        {
          title: "VelaStream Careers — Staff Distributed Systems",
          url: "https://velastream.example.com/jobs/staff-distributed",
        },
      ],
    },
    company: null,
    market: null,
    linkedin: null,
    error: "",
  },
  company: {
    kind: "company",
    job: null,
    company: {
      summary:
        "VelaStream Cloud builds real-time telemetry and log-routing pipelines for fintech and SaaS enterprises, emphasizing predictable tail latency and zero-data-loss guarantees.",
      products: ["VelaStream Core Control Plane", "VelaEdge Collector", "SchemaGuard Registry"],
      tech_stack: [
        "Go",
        "Python",
        "Kafka",
        "Kubernetes",
        "PostgreSQL",
        "OpenTelemetry",
        "ClickHouse",
      ],
      values: [
        "Engineering rigor over hype",
        "Customer-visible reliability",
        "Written RFC culture",
      ],
      tone: "Direct, metrics-first, systems-oriented engineering prose",
      recent_news: [
        "Launched multi-region active-active stream replication in Q3",
        "Published open-source OpenTelemetry tail-sampling benchmark suite",
      ],
      sources: [
        {
          title: "VelaStream Engineering Blog",
          url: "https://velastream.example.com/blog/active-active",
        },
      ],
    },
    market: null,
    linkedin: null,
    error: "",
  },
  market: {
    kind: "market",
    job: null,
    company: null,
    market: {
      summary:
        "Staff Distributed Systems roles in Seattle/Remote prioritize quantified throughput, p99 latency reductions, Kubernetes operator experience, and cross-org technical direction.",
      title_variants: [
        "Staff Distributed Systems Engineer",
        "Staff Platform Engineer — Streaming",
        "Principal Backend Infrastructure Engineer",
      ],
      in_demand_skills: [
        "OpenTelemetry",
        "Kubernetes",
        "Kafka",
        "gRPC",
        "Tail-latency optimization",
      ],
      level_signals: [
        "Leading architecture via written RFCs across multiple teams",
        "Owning tier-0 availability SLOs (99.99%+) and incident reduction",
        "Mentoring senior engineers and standardizing platform patterns",
      ],
      sources: [
        {
          title: "2026 Cloud Platform Engineering Market Index",
          url: "https://market.example.com/staff-infra-2026",
        },
      ],
    },
    linkedin: null,
    error: "",
  },
  linkedin: {
    kind: "linkedin",
    job: null,
    company: null,
    market: null,
    linkedin: {
      summary:
        "LinkedIn profile reads as a mid-senior generalist and omits the 45,000 events/sec scale, Kafka/PostgreSQL migration metrics, and Staff-level architecture scope present on the resume.",
      basis: "profile",
      sources: [],
      limitations: [],
      headline_issues: [
        "Current headline ('Lead Software Engineer at Solstice Telemetry') lacks target role keywords ('Distributed Systems', 'Python & Go', 'High-Throughput Streaming').",
      ],
      about_issues: [
        "About section is only two generic sentences; fails to mention 7 years of scale, 45k events/sec ingestion, or multi-region reliability work.",
      ],
      experience_gaps: [
        "Solstice Telemetry role on LinkedIn omits the 4h -> 18m Kafka/PostgreSQL billing migration.",
        "Northwind role omits the 1.4M daily updates and 35% CPU reduction metrics.",
      ],
      inconsistencies: [
        "Northwind title is 'Software Engineer' on LinkedIn vs. 'Software Engineer II' on the resume.",
      ],
    },
    error: "",
  },
};

export const MOCK_GAP_REPORT: GapReport = {
  score: 72,
  keyword_coverage: 0.5833,
  matched_keywords: [
    "Python",
    "Go",
    "Kafka",
    "PostgreSQL",
    "Distributed Systems",
    "Multi-region",
    "CI/CD",
  ],
  missing_keywords: ["Kubernetes", "OpenTelemetry", "SLOs", "gRPC", "Terraform"],
  format_issues: [
    "Bullet exp0.b2 lacks both a strong action verb and a measurable metric ('Worked with product and SRE teams...').",
  ],
  weak_bullets: ["exp0.b2", "exp0.b0"],
  strengths: [
    "Strong quantified throughput (45,000 events/sec across 18 regional clusters) directly matches VelaStream's streaming domain.",
    "Proven Kafka + PostgreSQL migration with a 13x latency improvement (4 hours to 18 minutes).",
  ],
  priorities: [
    "Rewrite Summary to position 7 years of Python/Go distributed streaming and multi-region architecture for a Staff IC scope.",
    "Replace passive bullet exp0.b2 with concrete SRE/SLO ownership, deployment automation, and placeholder metrics ([X]% availability / [N] engineers mentored).",
    "Sharpen exp0.b0 to foreground multi-region fault tolerance and observability.",
    "Align LinkedIn Headline and About section with Staff Distributed Systems keywords.",
  ],
};

export const MOCK_PROPOSALS: Proposal[] = [
  {
    id: "resume:summary",
    document: "resume",
    target: "summary",
    original:
      "Senior Backend Engineer with 7 years of experience building distributed data pipelines and API services in Python and Go. Experienced with PostgreSQL, Docker, and cloud infrastructure.",
    proposed:
      "Lead Backend & Distributed Systems Engineer with 7 years of experience architecting high-throughput event streaming pipelines and resilient APIs in Python and Go. Proven track record scaling multi-region ingestion to 45,000 events/sec and re-architecting core data workflows on Kafka and PostgreSQL.",
    rationale:
      "Elevates positioning to Staff-ready Distributed Systems scope and weaves in grounded metrics (7 years, 45,000 events/sec, multi-region, Kafka, PostgreSQL) from experience bullets.",
    keywords: ["Distributed Systems", "Python", "Go", "Multi-region", "Kafka", "PostgreSQL"],
    placeholders: [],
    issues: [],
    status: "ok",
  },
  {
    id: "resume:exp0.b0",
    document: "resume",
    target: "exp0.b0",
    original:
      "Built ingestion services in Python and FastAPI processing 45,000 events/sec across 18 regional clusters.",
    proposed:
      "Architected fault-tolerant, multi-region ingestion services in Python and FastAPI sustaining 45,000 events/sec across 18 regional clusters with [X]% p99 availability.",
    rationale:
      "Highlights multi-region fault tolerance sought by VelaStream and adds an explicit availability SLO placeholder for the candidate to supply.",
    keywords: ["Python", "Multi-region", "SLOs"],
    placeholders: ["[X]%"],
    issues: [],
    status: "ok",
  },
  {
    id: "resume:exp0.b2",
    document: "resume",
    target: "exp0.b2",
    original:
      "Worked with product and SRE teams on reliability, on-call runbooks, and deployment automation.",
    proposed:
      "Spearheaded reliability engineering and CI/CD deployment automation with SRE and product squads, defining service SLOs and mentoring [N] engineers to cut mean-time-to-recovery by [X]%.",
    rationale:
      "Replaces weak passive phrasing ('Worked with') with active leadership, CI/CD, and SLO signals while using safe placeholders for unstated team size and MTTR numbers.",
    keywords: ["SLOs", "CI/CD"],
    placeholders: ["[N]", "[X]%"],
    issues: [],
    status: "ok",
  },
  {
    id: "resume:skills",
    document: "resume",
    target: "skills",
    original: "Python, Go, FastAPI, PostgreSQL, Kafka, Redis, Docker, Linux, Git, REST APIs",
    proposed:
      "Python, Go, Distributed Systems, Kafka, PostgreSQL, FastAPI, Redis, Docker, CI/CD, Linux, REST APIs",
    rationale:
      "Re-orders core streaming and database skills first and normalizes CI/CD for ATS matching without adding unverified tools.",
    keywords: ["Python", "Go", "Distributed Systems", "Kafka", "PostgreSQL", "CI/CD"],
    placeholders: [],
    issues: [
      "Critic note: Kubernetes and OpenTelemetry are required by the target job but absent from your source resume; only add them here if you have hands-on experience.",
    ],
    status: "flagged",
  },
  {
    id: "linkedin:headline",
    document: "linkedin",
    target: "headline",
    original: "Lead Software Engineer at Solstice Telemetry",
    proposed:
      "Lead Software Engineer | Distributed Systems, Event Streaming & High-Throughput Backend Architecture (Python · Go · Kafka · PostgreSQL)",
    rationale:
      "Expands recruiter search surface on LinkedIn with exact domain and stack keywords verified from the resume.",
    keywords: ["Distributed Systems", "Python", "Go", "Kafka", "PostgreSQL"],
    placeholders: [],
    issues: [],
    status: "ok",
  },
  {
    id: "linkedin:about",
    document: "linkedin",
    target: "about",
    original:
      "Backend engineer focused on Python, Go, and scalable data systems. Passionate about clean architecture and reliable APIs.",
    proposed:
      "Lead Backend Engineer with 7 years of experience designing high-throughput distributed systems and event-driven architectures in Python and Go.\n\nAt Solstice Telemetry, I lead ingestion services handling 45,000 events/sec across 18 regional clusters and drove a monolith-to-Kafka/PostgreSQL migration that reduced settlement latency from 4 hours to 18 minutes. Previously at Northwind Logistics, I built Go and Python routing services handling 1.4M daily updates and cut database CPU load by 35%.\n\nCore focus: Distributed Systems · Python · Go · Kafka · PostgreSQL · FastAPI · Redis · CI/CD.",
    rationale:
      "Brings the LinkedIn About section up to par with the resume's concrete scale metrics and positions Elena for Staff Distributed Systems roles.",
    keywords: ["Distributed Systems", "Python", "Go", "Kafka", "PostgreSQL", "CI/CD"],
    placeholders: [],
    issues: [],
    status: "ok",
  },
];

export function createInitialMockSnapshot(
  title = "Staff Distributed Systems Engineer",
  company = "VelaStream Cloud",
  jobUrl = "https://velastream.example.com/jobs/staff-distributed",
  jobText = SAMPLE_JOB_TEXT,
  hasLinkedin = true,
): SessionSnapshot {
  return {
    session_id: MOCK_SESSION_ID,
    status: "running",
    created_at: new Date().toISOString(),
    target: {
      title,
      company,
      job_url: jobUrl,
      job_text: jobText,
      notes: "Staff IC level, Seattle or Remote",
    },
    has_linkedin: hasLinkedin,
    profile: MOCK_CANDIDATE_PROFILE,
    revision: "rev-initial-1",
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        content:
          "I've parsed Elena Vance's resume and LinkedIn profile and launched the 4 research subagents in parallel for **Staff Distributed Systems Engineer** at **VelaStream Cloud**. Watch the live pipeline on the right—I'll pause for your review once the critic verifies every rewrite.",
      },
    ],
    reports: {},
    gap: null,
    proposals: [],
    decisions: {},
    reviewed: false,
    cost_usd: 0.0042,
    last_event_id: 1,
  };
}

export function createDemoReviewMockSnapshot(sessionId = "demo"): SessionSnapshot {
  return {
    session_id: sessionId,
    status: "review",
    created_at: new Date().toISOString(),
    target: {
      title: "Staff Distributed Systems Engineer",
      company: "VelaStream Cloud",
      job_url: "https://velastream.example.com/jobs/staff-distributed",
      job_text: SAMPLE_JOB_TEXT,
      notes: "Staff IC6 level, Seattle or Remote",
    },
    has_linkedin: true,
    profile: MOCK_CANDIDATE_PROFILE,
    revision: "rev-demo-1",
    messages: [
      {
        id: "msg-demo-1",
        role: "user",
        content:
          "Optimize my resume and LinkedIn profile for the Staff Distributed Systems Engineer role at VelaStream Cloud.",
      },
      {
        id: "msg-demo-2",
        role: "assistant",
        content:
          "All 4 research subagents finished mapping VelaStream Cloud's streaming architecture, Staff IC6 rubric, and ATS keyword gaps (current score: 72/100). The writers and anti-fabrication critic prepared 6 grounded proposals (5 verified OK, 1 flagged note on Kubernetes/OpenTelemetry). Review and approve your diffs on the right to unlock export.",
      },
    ],
    reports: MOCK_REPORTS,
    gap: MOCK_GAP_REPORT,
    proposals: MOCK_PROPOSALS,
    decisions: {},
    reviewed: false,
    cost_usd: 0.0164,
    last_event_id: 37,
  };
}

/** Demo timing: the scripted offsets (about 3.8 s) stretched to a realistic run of
 * about two and a half minutes that ended just now. */
const DEMO_TIME_SCALE = 42;
const DEMO_LAST_OFFSET_MS = 3780;

export function buildMockEventStream(sessionId: string): Event[] {
  const start = Date.now() - DEMO_LAST_OFFSET_MS * DEMO_TIME_SCALE;
  const iso = (offsetMs: number) => new Date(start + offsetMs * DEMO_TIME_SCALE).toISOString();

  return [
    {
      id: 2,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "run_started",
      node: "concierge",
      data: { kind: "analysis" },
      at: iso(100),
    },
    {
      id: 3,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "intake",
      data: { label: "Parsing resume, LinkedIn export, and prompt-safety screen" },
      at: iso(250),
    },
    {
      id: 4,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "intake",
      data: { label: "Parsed 2 roles, 5 bullets, 10 skills (safety check passed)", seconds: 1.1 },
      at: iso(600),
    },
    {
      id: 5,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "job_analyst",
      data: { label: "Analyzing target job requirements & ATS keywords" },
      at: iso(700),
    },
    {
      id: 6,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "company_researcher",
      data: { label: "Researching VelaStream Cloud engineering stack & culture" },
      at: iso(720),
    },
    {
      id: 7,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "market_analyst",
      data: { label: "Benchmarking Staff Distributed Systems level signals" },
      at: iso(740),
    },
    {
      id: 8,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "linkedin_auditor",
      data: { label: "Auditing LinkedIn profile vs. resume & target role" },
      at: iso(760),
    },
    {
      id: 9,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "tool_called",
      node: "job_analyst",
      data: { tool: "fetch_url", summary: "velastream.example.com/jobs/staff-distributed" },
      at: iso(950),
    },
    {
      id: 10,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "tool_called",
      node: "company_researcher",
      data: {
        tool: "web_search",
        summary: "VelaStream Cloud engineering blog tech stack Kafka OpenTelemetry",
      },
      at: iso(1100),
    },
    {
      id: 11,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "tool_called",
      node: "market_analyst",
      data: {
        tool: "web_search",
        summary: "Staff Distributed Systems Engineer skills rubric 2026",
      },
      at: iso(1250),
    },
    {
      id: 12,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "report_ready",
      node: "linkedin_auditor",
      data: { kind: "linkedin", ok: true },
      at: iso(1450),
    },
    {
      id: 13,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "linkedin_auditor",
      data: { label: "LinkedIn audit complete", seconds: 1.8 },
      at: iso(1500),
    },
    {
      id: 14,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "report_ready",
      node: "job_analyst",
      data: { kind: "job", ok: true },
      at: iso(1700),
    },
    {
      id: 15,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "job_analyst",
      data: { label: "Extracted 12 ATS keywords & 4 must-haves", seconds: 2.3 },
      at: iso(1750),
    },
    {
      id: 16,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "report_ready",
      node: "company_researcher",
      data: { kind: "company", ok: true },
      at: iso(1950),
    },
    {
      id: 17,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "company_researcher",
      data: { label: "Mapped VelaStream products & RFC culture", seconds: 2.6 },
      at: iso(2000),
    },
    {
      id: 18,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "report_ready",
      node: "market_analyst",
      data: { kind: "market", ok: true },
      at: iso(2150),
    },
    {
      id: 19,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "market_analyst",
      data: { label: "Benchmarked Staff IC6 signals", seconds: 2.8 },
      at: iso(2200),
    },
    {
      id: 20,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "gap_analysis",
      data: { label: "Scoring deterministic ATS coverage & structural rubric" },
      at: iso(2300),
    },
    {
      id: 21,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "gap_ready",
      node: "gap_analysis",
      data: {
        score: MOCK_GAP_REPORT.score,
        keyword_coverage: MOCK_GAP_REPORT.keyword_coverage,
      },
      at: iso(2600),
    },
    {
      id: 22,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "gap_analysis",
      data: { label: "Match score: 72/100 (7/12 keywords matched)", seconds: 1.4 },
      at: iso(2650),
    },
    {
      id: 23,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "resume_writer",
      data: { label: "Drafting grounded resume section rewrites" },
      at: iso(2750),
    },
    {
      id: 24,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "linkedin_writer",
      data: { label: "Drafting LinkedIn headline & About section" },
      at: iso(2780),
    },
    {
      id: 25,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "resume_writer",
      data: { label: "Drafted 4 resume proposals", seconds: 2.1 },
      at: iso(3100),
    },
    {
      id: 26,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "linkedin_writer",
      data: { label: "Drafted 2 LinkedIn proposals", seconds: 1.9 },
      at: iso(3150),
    },
    {
      id: 27,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "critic",
      data: { label: "Checking every number and claim against your documents (round 1)" },
      at: iso(3250),
    },
    {
      id: 28,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "critique",
      node: "critic",
      data: { round: 1, flagged_ids: ["resume:exp0.b0", "resume:skills"], final: false },
      at: iso(3400),
    },
    {
      id: 29,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "critic",
      data: { label: "Sent 2 rewrites back to the resume writer", seconds: 0.9 },
      at: iso(3420),
    },
    {
      id: 30,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "resume_writer",
      data: { label: "Rewriting the 2 flagged proposals" },
      at: iso(3450),
    },
    {
      id: 31,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "proposals_ready",
      node: "resume_writer",
      data: { round: 2, proposal_ids: ["resume:exp0.b0", "resume:skills"] },
      at: iso(3560),
    },
    {
      id: 32,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "resume_writer",
      data: { label: "Rewrote 2 proposals", seconds: 1.1 },
      at: iso(3580),
    },
    {
      id: 33,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "critic",
      data: { label: "Checking the rewrites (round 2)" },
      at: iso(3600),
    },
    {
      id: 34,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "critique",
      node: "critic",
      data: { round: 2, flagged_ids: ["resume:skills"], final: true },
      at: iso(3700),
    },
    {
      id: 35,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_finished",
      node: "critic",
      data: { label: "5 proposals verified OK, 1 flagged for review", seconds: 1.0 },
      at: iso(3720),
    },
    {
      id: 36,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "node_started",
      node: "review",
      data: { label: "Awaiting human-in-the-loop review on 6 proposals" },
      at: iso(3760),
    },
    {
      id: 37,
      session_id: sessionId,
      run_id: MOCK_RUN_ID,
      type: "review_required",
      node: "review",
      data: { proposal_ids: MOCK_PROPOSALS.map((p) => p.id) },
      at: iso(3780),
    },
  ];
}

export function createMockDocument(kind: "resume" | "linkedin", text: string): DocumentCreated {
  return {
    document_id: `doc-mock-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    characters: text.length,
    preview: text.slice(0, 260),
  };
}
