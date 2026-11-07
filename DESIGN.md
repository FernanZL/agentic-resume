---
name: Agentic Resume
description: The live agent run engraved as an orchestral score; engraving black on staff white, a publisher-blue shell, vermilion only for now.
colors:
  publisher-blue: "#23408e"
  publisher-blue-deep: "#1a3170"
  blue-tint: "#e4e9f5"
  on-blue: "#ffffff"
  on-blue-soft: "#cdd6ee"
  staff-white: "#f6f7f5"
  sheet: "#ffffff"
  engraving-black: "#121212"
  ink-soft: "#3a3d47"
  rule: "rgba(18, 18, 18, 0.16)"
  staff-line: "rgba(18, 18, 18, 0.22)"
  vermilion-now: "#e0482a"
typography:
  display:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "64px"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.035em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 800
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 800
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  body-reading:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 800
    letterSpacing: "0.06em"
  notation:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
rounded:
  none: "0px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.engraving-black}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "38px"
  button-hover:
    backgroundColor: "{colors.blue-tint}"
  button-primary:
    backgroundColor: "{colors.publisher-blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.none}"
    padding: "8px 16px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.publisher-blue-deep}"
  button-small:
    padding: "4px 10px"
    height: "30px"
  button-large:
    padding: "12px 24px"
    height: "48px"
  field:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.engraving-black}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
  chip:
    textColor: "{colors.engraving-black}"
    rounded: "{rounded.none}"
    padding: "3px 9px"
  segmented-selected:
    backgroundColor: "{colors.engraving-black}"
    textColor: "{colors.sheet}"
    rounded: "{rounded.none}"
    padding: "4px 14px"
    height: "34px"
  shell:
    backgroundColor: "{colors.publisher-blue}"
    textColor: "{colors.on-blue}"
    height: "60px"
    padding: "0 24px"
  cue-review:
    backgroundColor: "{colors.publisher-blue}"
    textColor: "{colors.on-blue}"
    rounded: "{rounded.none}"
    padding: "14px 16px"
  placeholder-mark:
    backgroundColor: "{colors.blue-tint}"
    textColor: "{colors.engraving-black}"
    padding: "0 3px"
---

# Design System: Agentic Resume

## Overview

**Creative North Star: "The Score"**

The live run is engraved as an orchestral score. Every agent is a labelled staff on one shared time axis, read left to right as it plays: work is a beamed bar, a tool call is a notehead with its tool written beside it, the writer–critic rewrite rounds sit inside repeat barlines with a ×n count, the human review is a fermata, and a finished run closes with a final double barline. The rest of the product (chat, program note, review, export, start screen) is set in the same engraving: black ink on staff white, hairline rules, squared 1.5px-ruled controls, and one grotesk with tabular figures.

The page is dense and quiet, like printed music. Hierarchy comes from weight, size and ink, never from grey panels, cards on cards, or soft shadows. Colour is a strict value set: publisher blue owns the shell and the one forward call to action, and vermilion means "now" and nothing else. Dashed rules are the system's single sign for missing or unverified.

**Key Characteristics:**
- Engraving black on staff white; no grey chrome, no shadows, no radius on any control or container.
- Publisher-blue shell header (60px) carrying wordmark, role, tabs and live status.
- Vermilion reserved for "now": playhead, live beam, running-staff dot, live status, streaming cursor.
- Dashed borders only for missing or unverified things.
- Music notation as the information design, not decoration: staves, beams, noteheads, repeat barlines, fermata, system barline, final double barline.
- One family (Hanken Grotesk Variable), weights 400–800, tabular figures everywhere.

## Colors

A strict value set: one ink, one paper, one publisher blue with its tint, and one vermilion that only ever means the present moment.

### Primary
- **Publisher Blue** (`publisher-blue`): owns the shell header, the primary button, the review call-to-action cue, links and code links, focus outlines, the caret, the proposal-count bar links, the fermata while review is pending, and the start-screen fermata. It is the colour of the publisher, the frame and the next step.
- **Publisher Blue Deep** (`publisher-blue-deep`): primary-button hover only.
- **Blue Tint** (`blue-tint`): the hover fill on ink-ruled controls, the selected staff name, text selection, and the background of `[X]` placeholders (underlined with a 2px inset blue rule).

### Secondary
- **Vermilion Now** (`vermilion-now`): the playhead, a beam still being played, the dot beside a running staff's name and part status, the live dot in the shell status and live cue, and the streaming-text cursor in chat. Nothing else.

### Neutral
- **Engraving Black** (`engraving-black`): all text, every 1.5px control and container rule, beams, noteheads, barlines, selected segmented options, error strips (inverted: black ground, sheet text), and the document-type badge on proposals.
- **Ink Soft** (`ink-soft`): staff subtitles, hints, pending notes, cost line, tacet marks, rejected rewrites and disabled text. It is the only secondary text value.
- **Staff White** (`staff-white`): the page ground; also the knockout behind tool labels and tacet marks so they read over staff lines and the playhead.
- **Sheet** (`sheet`): the white of raised paper: controls, fields, cues, diff "after" column, the export sheet, form parts.
- **Rule** (`rule`): 1px hairline dividers in lists and reports, and disabled control borders.
- **Staff Line** (`staff-line`): the five staff lines in each lane and on the start-screen ensemble; also the scrollbar thumb.
- **On Blue / On Blue Soft** (`on-blue`, `on-blue-soft`): text on the shell; the soft value for the company name, shell button borders and tab hover rules.

### Named Rules
**The Vermilion Is Now Rule.** Vermilion marks only what is happening this instant: the playhead, a live beam, a running staff, the live status, the streaming cursor. When the thing stops, the vermilion goes. A finished run has no vermilion on screen.

**The Strict Value Set Rule.** New surfaces draw from the twelve colour tokens and nothing else. There are no greys beyond Ink Soft, Rule and Staff Line; no tinted panels beyond Blue Tint; no second accent.

**The Status Is Never Colour Alone Rule.** Every vermilion or blue state also has words or a shape: "playing now", "working", a notehead, a fermata, a dashed border.

## Typography

**Display Font:** Hanken Grotesk Variable (self-hosted via @fontsource-variable, with Hanken Grotesk and system-ui fallbacks)
**Body Font:** the same family
**Label/Mono Font:** the same family; there is no mono. Code is set in the grotesk at weight 600.

**Character:** a single clean grotesk carries everything, from the 64px match figure to the 11px tool labels. Tabular figures are on globally (`font-variant-numeric: tabular-nums` on body), so running times, counts and scores line up in columns.

### Hierarchy
- **Display** (800, 64px, line-height 1, -0.035em): the match-score figure in the program note, with its "/100" at 20px weight 600.
- **Headline** (800, 40px, 1.08, -0.03em, balanced wrap): the start-screen H1; 30px at 760px and below. The not-found page uses 32px.
- **Title** (800, 22px, -0.01em): panel heads (the part, Review, Export). Smaller titled moments step down by size, not by colour: form legends 18px/800, the wordmark 17px/800, proposal targets 15px/800.
- **Body** (400, 14px, 1.5): the default; chat messages at 14.5px. Reading text (report summaries, diffs) at 15.5px/1.6, capped near 72ch.
- **Label** (800, 12px, 0.06–0.08em, uppercase): column headings (Assistant, Program note), report block headings, diff "Your original / Rewrite" labels, export section heads, resume section heads.
- **Notation** (700, 11–13px): tool labels beside noteheads (11px), the time axis and repeat counts (12px), staff running times (13px/700, right-aligned).

### Named Rules
**The Weight Not Grey Rule.** Hierarchy is built with weight (400 / 600 / 700 / 800) and size. Reach for a heavier weight before a lighter colour.

**The Tabular Figures Rule.** Every number is set in tabular figures and right-aligned when it sits in a column (running times, report counts).

## Layout

The workspace is a full-height three-column grid under a sticky 60px blue shell: chat (330px) | the score (fluid) | program note (300px), each column separated by a 1.5px black rule, each scrolling independently. The chat holds its composer at the bottom. Every staff row is its own three-track grid: name (168px) | lane (fluid) | running time (92px), 16px column gap, so names, bars and times align down the whole system. Choosing a staff opens its part below the score, separated by a 1.5px rule.

Spacing works on a 4px-derived rhythm (4, 8, 12, 16, 20, 24), with 20px column padding and 20–24px panel padding; review and export panels add 48px at the foot. Reading measures are capped at 60–80ch. The start screen is a centred two-column grid (5fr / 7fr, max 1360px, 48px gap).

**Responsive behaviour:**
- **≤1280px:** the columns tighten: chat 290px, program note 260px, staff names 140px.
- **≤1100px:** the program note leaves the right edge and becomes a full-width band above the score (wrapping its blocks at 220px), ruled underneath; chat stays left. The start screen drops to one column.
- **≤760px:** the shell wraps (role and tabs take full rows, tabs share the width equally, 40px tall); the workspace stacks program note, then score, then chat (log capped at 60vh). Each staff becomes a name/time row above a full-width lane with a 2px black left rule; the system barline, final double barline and playhead are removed, and the repeat count moves inside its bracket. Diffs stack, decision groups go full width, and field pairs collapse to one column. Panels pad at 16px.

**Motion:** beams grow from their left edge (scaleX, 0.6s, cubic-bezier(0.16, 1, 0.3, 1)); noteheads drop 8px into place (0.35s, same curve); the playhead slides linearly (0.5s); controls change fill in 0.15s ease-out. Under `prefers-reduced-motion: reduce`, every animation and transition is removed: each state still renders in full, only the sweep and the growth are gone.

## Elevation & Depth

The system is flat. There are no drop shadows anywhere. Depth is ink and paper: Sheet white sits on Staff White ground inside a 1.5px black rule, the blue shell sits above the work by colour alone, and inverted black strips mark errors. The only `box-shadow` values in the build are inset rules used to draw notation and underlines (repeat barline thick strokes, the final double barline, the placeholder underline); they are drawing strokes, not elevation.

### Named Rules
**The Paper And Ink Rule.** Raise a surface by giving it Sheet white and a 1.5px black rule, never by shadow, blur or tint.

## Shapes

Every control and container is square-cornered (0px radius) and drawn with a 1.5px solid black rule; dividers inside lists are 1px Rule hairlines; structural column and section breaks are 1.5px black. Grouped controls (decision options, the paste/upload switch) butt together with a -1.5px overlap so they share one rule. The only round forms are musical or signal forms: noteheads (ovals rotated -20°), the fermata's arc and dot, and the 7–8px live dots.

### Named Rules
**The Squared Rule Rule.** Controls are squared with a 1.5px rule and no radius. A rounded button or pill is outside this world.

**The Dashed Means Unverified Rule.** A dashed border appears only where something is missing or unverified: keywords missing from the resume, a critic-flagged verdict, the critic's issue list. Everything verified or present is solid.

## Components

### Buttons
Squared, ruled and plain; the ink does the work.
- **Shape:** square corners (0px), 1.5px solid rule, 38px minimum height, weight 600 at 14px, 8px icon gap.
- **Default:** Sheet ground, Engraving Black rule and text; hover fills Blue Tint.
- **Primary:** Publisher Blue ground and rule, white text; hover deepens to Publisher Blue Deep. Used for the one forward action in a panel.
- **On blue:** white ground, blue text, inside the blue review cue. **Shell buttons:** transparent with an On Blue Soft rule that turns white on hover.
- **Quiet:** no rule, underlined text. **Sizes:** small 30px (4px 10px, 13px), large 48px (12px 24px, 16px).
- **Disabled:** transparent, Rule-coloured border, Ink Soft text.
- **Focus:** a 2px Publisher Blue outline offset 2px everywhere; white on the shell.

### Chips
- **Style:** text on the page ground inside a 1.5px black rule, 12.5px/600, square.
- **Missing:** the same chip with a dashed rule and weight 500: a keyword the posting wants that the resume lacks.

### Cards / Containers (cues, form parts, diff, LinkedIn items, the export sheet)
- **Corner Style:** square (0px).
- **Background:** Sheet white on Staff White ground.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1.5px Engraving Black. The warning cue thickens its top rule to 3px; the live cue softens its rule to Rule; the review cue is solid Publisher Blue with white text.
- **Internal Padding:** 14px 16px for cues and items; 20px 24px for form parts; 48px 56px for the export sheet.

### Inputs / Fields
- **Style:** Sheet ground, 1.5px black rule, square, 10px 12px padding, 15px text.
- **Focus:** the global 2px blue outline. Caret is Publisher Blue.
- **Disabled:** transparent ground with a Rule-coloured border.

### Segmented decisions (Accept / Edit / Reject, Paste / Upload)
Adjacent squared options sharing one 1.5px rule; hover Blue Tint; the selected option inverts to black ground with Sheet text. A rejected rewrite is struck through (1.5px) in Ink Soft.

### Navigation (the shell)
A sticky 60px Publisher Blue bar: wordmark (17px/800), role · company (company in On Blue Soft), then Score / Review n / Export tabs that stretch full height with a 3px bottom rule (On Blue Soft on hover, white when current). The review count sits in a white square badge with blue 12px/800 figures. Live status shows a vermilion dot while the run plays. At 760px and below the bar wraps into rows and tabs share the width.

### The Score (signature component)
- **Staff:** a labelled row (name 14px/700, part subtitle 12px Ink Soft) over a 34px lane of five hairline Staff Line rules, with a right-aligned running time. A selected staff name fills Blue Tint.
- **System barline:** a 2px black line joins all staves at the lane start, as in a printed system.
- **Final double barline:** when the run finishes, a thin 1px line and a 4px thick line close the system at the lane end.
- **Beam:** a 9px black bar for each stretch of work; while still playing it is vermilion and grows from its left edge.
- **Notehead:** a 14×10px black oval, rotated -20°, for each tool call, with the tool's name in 11px/700 on a Staff White knockout beside it, layered above the playhead.
- **Repeat barlines:** the writer and critic rounds sit between an opening and closing repeat (thick 3px line, thin 1px line, two dots), with a 12px/800 "×n" count.
- **Fermata:** a 2.4px-stroked arc over a dot on the review staff, blue while the review waits.
- **Playhead:** a 2px vermilion line sweeping the system with the elapsed time.
- **Tacet:** an italic "tacet" mark on a staff the run did not need.
- **Bar links:** small ruled proposal-count buttons in Publisher Blue at the end of writer and critic staves that jump to the review.

### Program Note
A 300px right column: the match figure in Display, keyword chips (dashed when missing), report rows with right-aligned counts on 1px hairlines, a status cue (blue when review is waiting), and the model cost in 12.5px Ink Soft pinned to the foot.

## Do's and Don'ts

### Do:
- **Do** keep vermilion (`vermilion-now`) for the present moment only: the playhead, live beams, running staffs, the live status and the streaming cursor.
- **Do** draw every control and container square with a 1.5px solid Engraving Black rule and 0px radius.
- **Do** use a dashed rule only for missing or unverified things: missing keywords, critic-flagged verdicts, issue lists.
- **Do** express agent work in the notation vocabulary: staves, beams, noteheads with tool labels, repeat barlines with ×n, the fermata, the system barline and the final double barline.
- **Do** build hierarchy with weight and size in Hanken Grotesk, with tabular figures on every number.
- **Do** keep every state rendered when motion is reduced; remove only animation and transition.
- **Do** collapse at 1280px (tighter columns), 1100px (program note above the score) and 760px (stacked single column, staves as name rows over full-width lanes).

### Don't:
- **Don't** use vermilion for errors, warnings, emphasis or branding; errors are inverted black strips and warnings thicken a black rule.
- **Don't** use dashed borders for decoration, dividers or empty states.
- **Don't** round controls, cards or chips, or add drop shadows; the only round forms are noteheads, the fermata and live dots.
- **Don't** add grey panels or a second accent; the value set is fixed.
- **Don't** convey status by colour alone; pair it with words or a notation shape.
