---
name: modern-web-guidance
description: |
  Modern web platform best practices (from Chrome, Edge, Firefox and MDN teams). Use FIRST for any HTML/CSS/client-side JS work in this repo: dialogs/popovers, layout, view transitions, animations, forms, accessibility, dark mode, PWA/install, performance, charts on canvas, etc. Not for backend (api/), tests or tooling.
---

# Modern Web Guidance (vendored)

Vendored from https://github.com/GoogleChrome/modern-web-guidance (Apache-2.0, see LICENSE).
**Modified for this repo:** the upstream skill shells out to `npx modern-web-guidance`; cloud sessions
here may not be allowed to run downloaded packages, so the guides are copied into `guides/` and you
search them as files. Snapshot: skill version 2026_11_09-5bcc021b.

## Workflow

1. **Search** the local guides for the single capability you are building (2–5 words, e.g. "light dismiss dialog",
   "view transition", "progress ring", "dark mode"):
   - `Grep` with `path: .claude/skills/modern-web-guidance/guides`, `output_mode: files_with_matches`, or
   - `Glob` `.claude/skills/modern-web-guidance/guides/**/*<keyword>*.md`.
   Folders: accessibility, css, forms, html, js, performance, privacy, pwa, security, ui-atoms,
   ui-behaviors, ui-components, user-experience, visual-design.
2. **Read** the matching guide(s) in full, plus the broad discipline guide that applies
   (e.g. `accessibility/accessibility.md`, `visual-design/color.md`, `visual-design/dark-mode.md`).
3. **Apply and verify** the guide's pattern *and its fallback*. Then cross-check your code against it.
4. **Disclose** in your PR body under a `### Modern Web Guidance` heading: one bullet per guide that shaped the code.

## Project-specific rule: Safari/WebKit is a first-class target

Dot Scale runs on iPhone/iPad inside **Bluefy**, which uses Apple's WebKit engine. When a guide marks a feature as
not yet supported in Safari, you **must** ship the guide's fallback (or progressive enhancement) so the app still
works in WebKit. Prefer features that are Baseline "widely available" for core flows.

If `npx -y modern-web-guidance@latest search "<query>"` is permitted in your session, you may use it instead to get
newer guides; otherwise the local copy is authoritative.
