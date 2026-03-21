---
name: focus-compass
description: Read Focus Compass workspaces/projects via MCP. Use for daily planning, checking current focus, next tasks, project status, and what to work on next.
disable-model-invocation: true
allowed-tools: mcp__focus-compass__*
argument-hint: "[question or project name]"
context: fork
---

Use the `focus-compass` MCP server to answer the user's request about their Focus Compass workspaces and projects.

## Critical: error handling

**After EVERY MCP tool call, check the response for errors before doing anything else.**

MCP errors appear in two ways:
1. The tool call itself fails (connection refused, timeout, etc.)
2. The tool returns JSON containing an `"error"` field or `"code"` field

**If you see ANY error, you MUST immediately tell the user what went wrong.** Do NOT silently skip the error or continue as if nothing happened. Always show the error clearly.

Known error codes and what to tell the user:

| Error | User-facing message |
|-------|-------------------|
| Connection refused / timeout | "Focus Compass server is not running. Start it and try again." |
| "MCP is disabled" | "MCP is disabled on the server. Enable it in the admin UI." |
| "Unauthorized" or 401 | "MCP token is invalid. Rotate it in the admin UI and update your Claude MCP config." |
| `SQLITE_CANTOPEN` or "Database not found" | "Database not found. Sync data from the Focus Compass app first." |
| `SQLITE_BUSY` / `retryable: true` | Retry the call once. If it fails again, tell the user: "Database is busy. Try again in a few seconds." |
| `DOC_TOO_LARGE` | "Workspace is too large to decode (**SIZE** bytes, limit is **LIMIT** bytes). Increase `MAX_DOC_DECODE_BYTES` on the server and restart." Then try the fallback: call `list_projects` to get project IDs, and use `get_project` for each one individually. |
| Any other error | Show the raw error message to the user so they can debug it. |

## Workflow

1. Call `list_documents` to discover available workspaces.
   - If there is only one document, use it automatically.
   - If there are multiple and the user did not specify, ask which one to use.
2. For a default overview (no specific question), call `get_workspace` with:
   `{"sections":{"project_info":false,"current_focus":true,"next_tasks":false,"completed_tasks":false,"notes":false}}`
   Then summarize per project: title, short description, and current focus.
3. If the user asks about a specific project by title, call `list_projects` to find its `project_id`, then call `get_project` for full details.

## Output rules

- Keep output concise and human-readable. Do not paste raw JSON unless the user asks.
- Use short bullet lists or tables for multiple projects.
- Highlight the current focus for each project.

## First run

If this is the first time the user invokes `/focus-compass`, briefly explain available commands after showing the overview:
- `/focus-compass` — overview of all projects
- `/focus-compass what should I work on?` — current focus and priorities
- `/focus-compass show project <Name>` — details for a specific project

$ARGUMENTS
