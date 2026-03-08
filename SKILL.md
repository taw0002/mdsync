# mdview — Present Documents & Get Targeted Feedback

## When to Use
- You've produced a plan, spec, report, review, or any document that needs human review
- You need structured feedback on specific sections (not vague "what do you think?")
- You're iterating on a document with the human (review → feedback → revise → repeat)

## How It Works
mdview renders markdown beautifully in the browser. The human can edit visually (WYSIWYG), add comments, approve/reject sections, and send structured feedback back to you.

**You write markdown. The human sees a polished document. Feedback comes back as structured JSON.**

## Presenting a Document

### With MCP (preferred)
If mdview MCP is configured, use the `present` tool:
```
present({ path: "/path/to/plan.md" })
```
This opens the doc in the human's browser automatically.

### Without MCP (file-based, works with ANY agent)
1. Write your document to a `.md` file
2. Tell the human: "I've written the plan to `plan.md`. Run `md view plan.md` to review it — you can edit, comment, and approve/reject sections."
3. After they review, read the feedback file: `plan.feedback.json` (same directory as the .md file)

## Reading Feedback

### With MCP
```
get_feedback({ path: "/path/to/plan.md" })
```

### Without MCP
Read the file `{filename}.feedback.json` next to the .md file.

### Feedback Structure
The feedback JSON contains only the delta — what the human changed or commented on. You already have the full document; this tells you what they think about it.

```json
{
  "file": "plan.md",
  "reviewedAt": "2026-03-07T23:45:00Z",
  "changes": [
    {
      "type": "edit",
      "section": "Pricing Strategy",
      "line": 45,
      "before": "Starter tier at $49/mo",
      "after": "Starter tier at $29/mo",
      "comment": "Too expensive for solo operators"
    },
    {
      "type": "comment",
      "section": "Trade Media",
      "selectedText": "$77K on advertising",
      "comment": "Skip L&L entirely. Only do Landscape Management."
    },
    {
      "type": "approve",
      "section": "Content Marketing Plan",
      "comment": "Ship it"
    },
    {
      "type": "reject",
      "section": "Budget Allocation",
      "comment": "Way too aggressive for this stage"
    },
    {
      "type": "added",
      "section": "Recommendations",
      "content": "Also add a ServiceTitan migration page"
    }
  ]
}
```

### Change Types
| Type | Meaning | Action |
|------|---------|--------|
| `edit` | Human changed text | Apply the `after` text, consider their `comment` |
| `comment` | Human commented on specific text | Address the feedback in your revision |
| `approve` | Human approved this section | Keep it as-is |
| `reject` | Human rejected this section | Rework or remove based on `comment` |
| `added` | Human added new content | Incorporate into the document |

## The Review Loop

1. **Present** — Write .md, present to human, explain what you need feedback on
2. **Wait** — Human reviews, edits, comments, approves/rejects sections
3. **Read feedback** — Parse the .feedback.json
4. **Apply** — Make changes based on feedback. Approved sections stay. Rejected sections get reworked.
5. **Re-present** — Show the updated doc. Repeat until all sections approved.

## Best Practices

- **Tell the human what to focus on.** Don't just present a doc — say "I need your input on the pricing and timeline. The rest is background context."
- **Keep docs focused.** One topic per document. Don't present a 50-page doc when you need feedback on pricing.
- **Acknowledge feedback explicitly.** When you revise, tell the human what you changed: "Updated pricing per your feedback — Starter is now $29/mo. Removed the L&L budget. Content plan unchanged since you approved it."
- **Don't re-present approved sections.** If they approved the content calendar, don't ask them to review it again.
- **Use section reactions for fast reviews.** Encourage: "You can quickly approve/reject each section, or add detailed comments where needed."

## CLI Reference

```bash
md view file.md          # Open single file in browser
md view .                # Open README.md in cwd
md serve .               # Directory mode with file tree
md serve ./docs -p 3333  # Custom port
md mcp                   # Start MCP server (stdio)

Options:
  --port, -p    Port (default: 3456)
  --light       Light theme
  --no-edit     Disable editing
  --no-open     Don't auto-open browser
```
