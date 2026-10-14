import type { KnowledgeItem, KnowledgePayload, SharedGroup } from './model';
/** A project's parent folder includes its published members without editing item memberships. */
export function itemSharedGroups(item: KnowledgeItem, payload: KnowledgePayload): SharedGroup[] {
  const projects = (payload.sharedProjects ?? []).filter((group) => item.projectIds?.includes(group.id));
  const folders = (payload.sharedFolders ?? []).filter((group) => item.folderIds?.includes(group.id) || projects.some((project) => project.folderId === group.id));
  return [...folders, ...projects];
}
export function matchesSharedScope(item: KnowledgeItem, payload: KnowledgePayload, scope: string): boolean {
  if (scope === 'all') return true;
  const divider = scope.indexOf(':'); const type = scope.slice(0, divider); const id = scope.slice(divider + 1);
  if (type === 'project') return item.projectIds?.includes(id) ?? false;
  if (type === 'folder') return item.folderIds?.includes(id) || (payload.sharedProjects ?? []).some((project) => project.folderId === id && item.projectIds?.includes(project.id));
  return false;
}
