import { expect, it } from 'vitest';
import { itemSharedGroups, matchesSharedScope } from './sharedOrganization';
import type { KnowledgeItem, KnowledgePayload } from './model';
it('includes inherited folder scopes while retaining separate project membership', () => {
  const item = { id: 'a', projectIds: ['p:1'] } as KnowledgeItem;
  const payload = { sharedFolders: [{ id: 'f', title: '공용 폴더', description: '' }], sharedProjects: [{ id: 'p:1', title: '공용 프로젝트', description: '', folderId: 'f' }] } as KnowledgePayload;
  expect(matchesSharedScope(item, payload, 'folder:f')).toBe(true);
  expect(matchesSharedScope(item, payload, 'project:p:1')).toBe(true);
  expect(matchesSharedScope(item, payload, 'project:other')).toBe(false);
  expect(itemSharedGroups(item, payload).map((group) => group.title)).toEqual(['공용 폴더', '공용 프로젝트']);
  expect(item.projectIds).toEqual(['p:1']);
});
