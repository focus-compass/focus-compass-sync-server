const DEFAULT_WORKSPACE_VIEW_OPTIONS = Object.freeze({
  descriptionMode: "summary",
  includeFields: false,
  currentFocus: true,
  nextTasks: false,
  completedTasks: false,
  notes: false,
});

export const FULL_PROJECT_VIEW_OPTIONS = Object.freeze({
  descriptionMode: "full",
  includeFields: true,
  currentFocus: true,
  nextTasks: true,
  completedTasks: true,
  notes: true,
});

export const createWorkspaceViewOptions = (sections = {}) => ({
  ...DEFAULT_WORKSPACE_VIEW_OPTIONS,
  descriptionMode: sections.project_info ? "full" : "summary",
  currentFocus: sections.current_focus ?? DEFAULT_WORKSPACE_VIEW_OPTIONS.currentFocus,
  nextTasks: sections.next_tasks ?? DEFAULT_WORKSPACE_VIEW_OPTIONS.nextTasks,
  completedTasks:
    sections.completed_tasks ?? DEFAULT_WORKSPACE_VIEW_OPTIONS.completedTasks,
  notes: sections.notes ?? DEFAULT_WORKSPACE_VIEW_OPTIONS.notes,
});
