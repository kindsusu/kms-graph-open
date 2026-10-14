import { describe, expect, it } from 'vitest';
import {
  OrganizationConflictError,
  OrganizationError,
  applyOrganizationActions,
  emptyOrganization,
  libraryStorageKey,
  loadOrganization,
  parseOrganization,
  persistOrganization,
  reduceOrganization,
} from './store';

class MemoryStorage {
  values = new Map<string, string>();
  failWrites = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrites) throw new Error('quota exceeded'); this.values.set(key, value); }
}

const key = 'test-library';
const organization = () => emptyOrganization(key);
const folder = (state = organization()) => reduceOrganization(state, { type: 'folder/create', id: 'folder-a', name: '운영' });
const project = (state = folder()) => reduceOrganization(state, { type: 'project/create', id: 'project-a', folderId: 'folder-a', name: '출장비' });

describe('organization store', () => {
  it('scopes storage to origin, pathname, and demo mode without using volatile payload fields', () => {
    const scope = { origin: 'https://kms.example', pathname: '/library/' } as Location;
    expect(libraryStorageKey('production', scope)).toContain('production');
    expect(libraryStorageKey('demo', scope)).toContain('demo');
    expect(libraryStorageKey('production', scope)).not.toBe(libraryStorageKey('demo', scope));
    expect(libraryStorageKey('production', scope)).toBe(libraryStorageKey('production', { origin: 'https://kms.example', pathname: '/library' } as Location));
  });

  it('creates, moves, and deletes a folder without deleting project or source data', () => {
    let state = project();
    state = reduceOrganization(state, { type: 'project/create', id: 'project-unfiled', folderId: null, name: '수시 업무' });
    state = reduceOrganization(state, { type: 'folder/create', id: 'folder-b', name: 'AI' });
    state = reduceOrganization(state, { type: 'project/move', id: 'project-a', folderId: 'folder-b' });
    state = reduceOrganization(state, { type: 'folder/delete', id: 'folder-b' });
    expect(state.projects.filter((entry) => entry.folderId === null).sort((a, b) => a.order - b.order)).toEqual([
      { id: 'project-unfiled', folderId: null, name: '수시 업무', order: 0 },
      { id: 'project-a', folderId: null, name: '출장비', order: 1 },
    ]);
    expect(state.memberships).toEqual([]);
  });

  it('preserves immutable prior states and prevents cross-entity ID collisions', () => {
    const initial = organization();
    const next = folder(initial);
    expect(initial.folders).toEqual([]);
    expect(next).not.toBe(initial);
    expect(() => reduceOrganization(next, { type: 'project/create', id: 'folder-a', folderId: null, name: '중복' })).toThrow(OrganizationError);
  });

  it('allows shared memberships, moves without duplicates, and keeps ordered appends', () => {
    let state = project();
    state = reduceOrganization(state, { type: 'project/create', id: 'project-b', folderId: null, name: '개선' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'item-1' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'missing-source-item' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-b', itemId: 'item-1' });
    state = reduceOrganization(state, { type: 'item/move', fromProjectId: 'project-a', toProjectId: 'project-b', itemId: 'item-1' });
    expect(state.memberships.filter((entry) => entry.itemId === 'item-1')).toEqual([{ projectId: 'project-b', itemId: 'item-1', order: 0 }]);
    expect(state.memberships).toContainEqual({ projectId: 'project-a', itemId: 'missing-source-item', order: 0 });
  });

  it('reorders folders, projects, and items with a before target and self drops are no-ops', () => {
    let state = project();
    state = reduceOrganization(state, { type: 'folder/create', id: 'folder-b', name: 'AI' });
    state = reduceOrganization(state, { type: 'folder/move', id: 'folder-b', beforeId: 'folder-a' });
    state = reduceOrganization(state, { type: 'project/create', id: 'project-b', folderId: 'folder-a', name: '정산', beforeId: 'project-a' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'two' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'one', beforeItemId: 'two' });
    const untouched = reduceOrganization(state, { type: 'item/reorder', projectId: 'project-a', itemId: 'one', beforeItemId: 'one' });
    expect(untouched).toStrictEqual(state);
    expect(state.folders.map((entry) => entry.id)).toEqual(['folder-b', 'folder-a']);
    expect(state.projects.filter((entry) => entry.folderId === 'folder-a').sort((a, b) => a.order - b.order).map((entry) => entry.id)).toEqual(['project-b', 'project-a']);
    expect(state.memberships.sort((a, b) => a.order - b.order).map((entry) => entry.itemId)).toEqual(['one', 'two']);
  });

  it('moves either item to the front or end without moving its neighbour instead', () => {
    let state = project();
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'first' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'second' });
    const itemOrder = (value: typeof state) => value.memberships.filter((entry) => entry.projectId === 'project-a').sort((a, b) => a.order - b.order).map((entry) => entry.itemId);
    state = reduceOrganization(state, { type: 'item/reorder', projectId: 'project-a', itemId: 'first' });
    expect(itemOrder(state)).toEqual(['second', 'first']);
    state = reduceOrganization(state, { type: 'item/reorder', projectId: 'project-a', itemId: 'first', beforeItemId: 'second' });
    expect(itemOrder(state)).toEqual(['first', 'second']);
  });

  it('rejects malformed imports, foreign libraries, duplicate memberships, and invalid names', () => {
    expect(() => parseOrganization({ schemaVersion: 1, libraryKey: key, folders: [], projects: [], memberships: [{ projectId: 'missing', itemId: 'i', order: 0 }] }, key)).toThrow(OrganizationError);
    expect(() => parseOrganization({ schemaVersion: 1, libraryKey: 'other', folders: [], projects: [], memberships: [] }, key)).toThrow('다른 라이브러리');
    expect(() => parseOrganization({ schemaVersion: 1, libraryKey: key, folders: [{ id: 'f', name: 'a'.repeat(101), order: 0 }], projects: [], memberships: [] }, key)).toThrow(OrganizationError);
  });

  it('does not overwrite corrupt data and reports storage failures', () => {
    const storage = new MemoryStorage();
    storage.values.set(key, '{not json');
    const loaded = loadOrganization(storage, key);
    expect(loaded.error).toBeInstanceOf(OrganizationError);
    expect(storage.getItem(key)).toBe('{not json');
    storage.failWrites = true;
    expect(() => persistOrganization(storage, organization())).toThrow('저장할 수 없습니다');
  });

  it('persists valid state and detects stale tab snapshots before writing', () => {
    const storage = new MemoryStorage();
    const firstRaw = persistOrganization(storage, folder());
    const loaded = loadOrganization(storage, key);
    expect(loaded.error).toBeUndefined();
    expect(loaded.state.folders[0]?.name).toBe('운영');
    persistOrganization(storage, reduceOrganization(loaded.state, { type: 'folder/rename', id: 'folder-a', name: '새 운영' }), { expectedRaw: firstRaw });
    expect(() => persistOrganization(storage, folder(), { expectedRaw: firstRaw })).toThrow(OrganizationConflictError);
  });

  it('applies multi-item moves atomically and leaves the input unchanged when a later action is invalid', () => {
    let state = project();
    state = reduceOrganization(state, { type: 'project/create', id: 'project-b', folderId: null, name: '개선' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'one' });
    state = reduceOrganization(state, { type: 'item/link', projectId: 'project-a', itemId: 'two' });
    const original = state;
    const moved = applyOrganizationActions(state, [
      { type: 'item/move', fromProjectId: 'project-a', toProjectId: 'project-b', itemId: 'one' },
      { type: 'item/move', fromProjectId: 'project-a', toProjectId: 'project-b', itemId: 'two' },
    ]);
    expect(moved.memberships.filter((entry) => entry.projectId === 'project-b').map((entry) => entry.itemId)).toEqual(['one', 'two']);
    expect(original.memberships.filter((entry) => entry.projectId === 'project-a')).toHaveLength(2);
    expect(() => applyOrganizationActions(state, [
      { type: 'item/unlink', projectId: 'project-a', itemId: 'one' },
      { type: 'item/move', fromProjectId: 'project-a', toProjectId: 'project-b', itemId: 'absent' },
    ])).toThrow('이동할 자료 소속');
    expect(state).toStrictEqual(original);
  });
});
