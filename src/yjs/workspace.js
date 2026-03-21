import {
  getProjectDescription,
  getProjectTitle,
  isNonEmptyObject,
  isNonEmptyString,
  sanitizeRecord,
} from "./projectFormat.js";

const getChecklistGroups = (project) => {
  const allGroups = Array.isArray(project.groups) ? project.groups : [];
  const selectedChecklistId = project.selectedChecklistId ?? null;

  if (!selectedChecklistId) return allGroups;

  const filtered = allGroups.filter((g) => g.checklistId === selectedChecklistId);
  return filtered.length > 0 ? filtered : allGroups;
};

const getGroupTitle = (group) => {
  if (isNonEmptyString(group?.title)) return group.title;
  if (isNonEmptyString(group?.name)) return group.name;
  return null;
};

const formatTaskText = (task) => (isNonEmptyString(task?.text) ? task.text : null);

const formatTaskGroup = (group, taskTexts, { requireTasks = false } = {}) => {
  const result = {};
  const title = getGroupTitle(group);
  const notes = isNonEmptyString(group?.notes) ? group.notes : null;

  if (requireTasks && taskTexts.length === 0) return null;

  if (title) result.title = title;
  if (notes) result.notes = notes;
  if (taskTexts.length > 0) result.tasks = taskTexts;

  return isNonEmptyObject(result) ? result : null;
};

const appendTaskText = (groupMap, groupId, text) => {
  if (!groupId || !text) return;

  const existing = groupMap.get(groupId);
  if (existing) {
    existing.push(text);
    return;
  }

  groupMap.set(groupId, [text]);
};

const createTaskGroupMaps = (tasks) => {
  const pending = new Map();
  const completed = new Map();

  for (const task of tasks) {
    const text = formatTaskText(task);
    const groupId = task?.group ?? null;

    if (!text || !groupId) continue;

    appendTaskText(task?.completed ? completed : pending, groupId, text);
  }

  return { pending, completed };
};

const buildTaskGroups = (groups, taskTextsByGroup) =>
  groups
    .map((group) =>
      formatTaskGroup(group, taskTextsByGroup.get(group?.id) ?? [], {
        requireTasks: true,
      }),
    )
    .filter(Boolean);

const formatNotes = (project) => {
  const noteCollections = Array.isArray(project.noteCollections)
    ? project.noteCollections
    : [];

  return noteCollections
    .map((collection) => {
      const name = isNonEmptyString(collection?.name)
        ? collection.name
        : isNonEmptyString(collection?.id)
          ? collection.id
          : null;
      const items = Array.isArray(collection?.items)
        ? collection.items
          .map((item) => (isNonEmptyString(item?.text) ? item.text : null))
          .filter(Boolean)
        : [];

      if (!name || items.length === 0) return null;
      return { name, items };
    })
    .filter(Boolean);
};

export const transformProject = (project, sections) => {
  const result = {};
  const title = getProjectTitle(project);
  const description = getProjectDescription(project, sections.descriptionMode);

  if (project?.id != null) result.id = project.id;
  if (title !== null) result.title = title;
  if (description) result.description = description;

  if (sections.includeFields) {
    const fields = sanitizeRecord(project.fields);
    if (isNonEmptyObject(fields)) result.fields = fields;
  }

  const needsTasks =
    sections.currentFocus || sections.nextTasks || sections.completedTasks;

  const allTasks = needsTasks && Array.isArray(project.tasks) ? project.tasks : [];
  const checklistGroups = needsTasks ? getChecklistGroups(project) : [];
  const taskGroups = needsTasks
    ? createTaskGroupMaps(allTasks)
    : { pending: new Map(), completed: new Map() };
  const currentFocusGroup = needsTasks
    ? checklistGroups.find((group) => !group?.done) ?? null
    : null;

  if (sections.currentFocus && currentFocusGroup) {
    const currentFocus = formatTaskGroup(
      currentFocusGroup,
      taskGroups.pending.get(currentFocusGroup.id) ?? [],
    );
    if (currentFocus) result.currentFocus = currentFocus;
  }

  if (sections.nextTasks && currentFocusGroup) {
    const focusIndex = checklistGroups.indexOf(currentFocusGroup);
    const nextTaskGroups = buildTaskGroups(
      checklistGroups.slice(focusIndex + 1),
      taskGroups.pending,
    );

    if (nextTaskGroups.length > 0) {
      result.nextTaskGroups = nextTaskGroups;
    }
  }

  if (sections.completedTasks) {
    const completedTaskGroups = buildTaskGroups(
      checklistGroups,
      taskGroups.completed,
    );

    if (completedTaskGroups.length > 0) {
      result.completedTaskGroups = completedTaskGroups;
    }
  }

  if (sections.notes) {
    const notes = formatNotes(project);
    if (notes.length > 0) result.notes = notes;
  }

  return result;
};

export const transformWorkspace = (content, docName, sections) => {
  const root = content.root ?? Object.values(content)[0] ?? {};

  const workspaceSource = root.workspace ?? {};
  const workspaceId = workspaceSource.id ?? null;
  const workspaceName = workspaceSource.name ?? workspaceSource.title ?? null;

  const rawProjects = Array.isArray(root.projects) ? root.projects : [];
  const projects = rawProjects
    .map((project) => transformProject(project, sections))
    .filter((project) => isNonEmptyObject(project));

  const workspace = {};
  if (workspaceId != null) workspace.id = workspaceId;
  if (isNonEmptyString(workspaceName)) workspace.name = workspaceName;

  const result = { document: docName, projects };
  if (isNonEmptyObject(workspace)) result.workspace = workspace;

  return result;
};
