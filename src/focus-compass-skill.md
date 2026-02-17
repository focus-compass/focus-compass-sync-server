---
name: focus-compass
description: Read Focus Compass workspaces/projects via MCP. Use for daily planning, checking current focus, next tasks, project status, and what to work on next.
disable-model-invocation: true
allowed-tools: mcp__focus-compass__*
argument-hint: "[question or project name]"
context: fork
---

Use the `focus-compass` MCP server to answer the user's request about their Focus Compass workspaces and projects.

## Workflow

1. Call `list_documents` to discover available workspaces.
   - If there is only one document, use it automatically.
   - If there are multiple and the user did not specify, ask which one to use.
2. For a default overview (no specific question), call `get_workspace` with:
   `{"sections":{"project_info":false,"current_focus":true,"next_tasks":true,"completed_tasks":false,"notes":false}}`
   Then summarize per project: title, current focus task, and next tasks.
3. If the user asks about a specific project by title, call `list_projects` to find its `project_id`, then call `get_project` for full details.

## Output rules

- Keep output concise and human-readable. Do not paste raw JSON unless the user asks.
- Use short bullet lists or tables for multiple projects.
- Highlight the current focus task for each project.

## Error handling

If any MCP call returns an error:
- "MCP is disabled" — tell the user to enable MCP in the admin UI at the server address.
- "Unauthorized" — tell the user to check their MCP token (rotate from the admin UI if needed).
- "Database not found" or "SQLITE_CANTOPEN" — tell the user to sync data from the Focus Compass app first.
- Connection refused / timeout — tell the user to check that the Focus Compass server is running.
- "Database is busy" with `retryable: true` — retry the call once after a short pause.

## First run

If this is the first time the user invokes `/focus-compass`, briefly explain available commands after showing the overview:
- `/focus-compass` — overview of all projects
- `/focus-compass what should I work on?` — current focus and priorities
- `/focus-compass show project <Name>` — details for a specific project

$ARGUMENTS
