---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/components/TimelinePanel.tsx","web/src/components/ReviewPanel.tsx","web/src/components/ExportPanel.tsx","web/src/components/StartScreen.tsx","web/src/styles.css"]
---

# Session workspace (web app)

Scope: the whole web app in `web/`. The session workspace (live run, review, export) is primary; the start screen inherits the same world. Visitor mode: **Operate**.

Audience and job: a job seeker at a desk for a focused 20–40 minute session, tailoring a resume to one role and watching the agents work. Evaluators of the author's engineering are the secondary audience.
Key moment, chosen by the user: watching the agents work. Must avoid: generic SaaS dashboard, AI-hype neon, toy-like or playful, stuffy corporate HR. Desktop first; 390 px must work.
Constraints: keep the data flow, the API contract (docs/CONTRACT.md) and the tests. This is a visual-layer rebuild.

## Direction contract

THESIS: The run is a score. One labelled staff per agent on a shared time axis, read left to right as it plays: work is beamed bars, tool calls are noteheads, critic rewrite rounds sit inside repeat barlines, and the review is a fermata. It refuses the category default of a status-pill step list beside a chat bubble column.

OWN-WORLD: Score-publisher blue (#23408e) owns the shell header. Engraving black (#121212) on staff white (#f6f7f5). Vermilion (#e0482a) is reserved for "now": the playhead, the active staff and the live status, never anything else. Hairline staff lines, double barlines, squared controls with 1.5px black rules, no radius, no grey chrome; hierarchy by weight and ink. One grotesk (Hanken Grotesk) with tabular figures. Raises: running times right-aligned per staff (j-card); proposal codes link both ways between the bar and the document (doujin); vermilion only for now (orienteering); every number opens its evidence (monochrome canon); a strict value set (datamatics).

STORY: The user sees each specialist play its part in parallel, understands where the run is and why it waits, then reviews grounded rewrites and exports what they approved.

FIRST VIEWPORT: Blue header 60px (wordmark, role · company, Score / Review n / Export tabs, live status). Three columns: chat 330px with the input at the bottom; the score in the centre (time axis ticks, about 11 staves with name and subtitle, beams, noteheads with tool labels, repeat brackets with ×n, the vermilion playhead, a fermata over the review staff); the program note 300px on the right (match score as a large figure, keyword chips with dashed missing ones, report links with counts, a blue "fermata ahead" or review call to action).

FORM: Candidate 6 of 7 (the orchestral score), assigned by the roll. seed:498329e601ecd404

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: the score draws itself live from SSE events. Beams grow from node_started to node_finished; noteheads drop on tool_called; a repeat barline opens on the critic's first send-back; the playhead sweeps; the fermata lands on review_required. Hovering or focusing a staff shows its report; clicking a proposal code jumps between bar and document. Reduced motion keeps every state and drops the sweep.
