# Orbit API Launch Spec

## Overview

Orbit is a fictional API launch plan used to demo **mdsync**. The goal is simple: render markdown beautifully, let anyone *click to edit*, and make review feel lightweight instead of bureaucratic.

We want docs that read like product pages, but stay grounded in plain `README.md` workflows. See the [GitHub repository](https://github.com/taw0002/mdsync) for the full project.

### Success criteria

- Readers can move from static markdown to inline editing with almost no friction.
- Reviewers can approve, reject, or comment on sections without leaving context.
- AI tools can interact with the same content through an MCP server.

## Launch checklist

1. Ship the browser viewer with inline editing enabled.
2. Publish a marketing site that doubles as a live product demo.
3. Document installation, feedback flows, and editor integrations.

## Editor ergonomics

> Markdown should stay portable, but the experience around it should feel premium.

- Double-click to place the caret exactly where you want it.
- Select text to reveal a floating formatting toolbar.
- Type `/` on a blank line to insert common blocks quickly.

### Review workflow

| Role | Primary action | Output |
| --- | --- | --- |
| Author | Edit content inline | Updated markdown |
| Reviewer | Approve, reject, comment | Structured feedback |
| AI agent | Read and act via MCP | Tool-native workflow |

## Implementation sketch

```ts
type ReviewState = {
  section: string;
  status: "draft" | "approved" | "changes-requested";
  notes: string[];
};

export function summarizeReview(state: ReviewState) {
  const prefix = state.status === "approved" ? "Ready to ship" : "Needs attention";
  return `${prefix}: ${state.section} (${state.notes.length} notes)`;
}
```

## Delivery plan

- [x] Preserve markdown as the source of truth
- [x] Support code blocks, tables, and task lists
- [ ] Add more import/export adapters
- [ ] Expand MCP examples for editors

### Notes

This demo keeps everything in-memory on purpose. The point is to let people feel the interaction model immediately, then install the CLI when they're convinced.
