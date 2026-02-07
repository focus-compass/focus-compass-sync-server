const formatTask = (task) => ({
  id: task.id ?? null,
  text: task.text ?? "",
  completed: Boolean(task.completed),
  group: task.group ?? null,
});

const getChecklistGroups = (project) => {
  const allGroups = Array.isArray(project.groups) ? project.groups : [];
  const selectedChecklistId = project.selectedChecklistId ?? null;

  if (!selectedChecklistId) return allGroups;

  const filtered = allGroups.filter((g) => g.checklistId === selectedChecklistId);
  return filtered.length > 0 ? filtered : allGroups;
};

const transformProject = (project, sections) => {
  const result = {
    id: project.id ?? null,
    title: project.title ?? null,
  };

  if (sections.projectInfo) {
    result.info = {
      description: project.info?.description ?? null,
      image: project.info?.image ?? null,
      imageFit: project.info?.imageFit ?? null,
      imageCrop: project.info?.imageCrop ?? null,
    };
    result.fields = project.fields ?? {};
  }

  const allTasks = Array.isArray(project.tasks) ? project.tasks : [];
  const checklistGroups = getChecklistGroups(project);

  const currentFocusGroup = checklistGroups.find((g) => !g.done) ?? null;

  if (sections.currentFocus) {
    if (currentFocusGroup) {
      const focusTasks = allTasks.filter(
        (t) => t.group === currentFocusGroup.id && !t.completed,
      );
      result.currentFocus = {
        group: {
          id: currentFocusGroup.id,
          notes: currentFocusGroup.notes ?? null,
          notesVisible: currentFocusGroup.notesVisible ?? false,
        },
        tasks: focusTasks.map(formatTask),
      };
    } else {
      result.currentFocus = null;
    }
  }

  if (sections.nextTasks) {
    if (currentFocusGroup) {
      const focusIndex = checklistGroups.indexOf(currentFocusGroup);
      const laterGroups = checklistGroups.slice(focusIndex + 1);
      const laterGroupIds = new Set(laterGroups.map((g) => g.id));

      result.nextTasks = allTasks
        .filter((t) => laterGroupIds.has(t.group) && !t.completed)
        .map(formatTask);
    } else {
      result.nextTasks = [];
    }
  }

  if (sections.completedTasks) {
    result.completedTasks = allTasks
      .filter((t) => t.completed)
      .map(formatTask);
  }

  if (sections.notes) {
    result.noteCollections = project.noteCollections ?? [];
  }

  return result;
};

export const transformWorkspace = (content, docName, sections) => {
  const root = content.root ?? Object.values(content)[0] ?? {};

  const workspace = root.workspace ?? {};
  const workspaceId = workspace.id ?? null;
  const workspaceName = workspace.name ?? workspace.title ?? null;

  const rawProjects = Array.isArray(root.projects) ? root.projects : [];
  const projects = rawProjects.map((project) => transformProject(project, sections));

  return {
    document: docName,
    workspace: {
      id: workspaceId,
      name: workspaceName,
    },
    sections: { ...sections },
    projects,
  };
};
