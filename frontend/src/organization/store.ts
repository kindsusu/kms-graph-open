export const ORGANIZATION_SCHEMA_VERSION = 1 as const;
const STORAGE_PREFIX = 'kms-library-organization:v1:';
const MAX_NAME_LENGTH = 100;
const MAX_ENTRIES = 5_000;

export interface OrganizationFolder { id: string; name: string; order: number }
export interface OrganizationProject { id: string; folderId: string | null; name: string; order: number }
export interface OrganizationMembership { projectId: string; itemId: string; order: number }
export interface OrganizationState {
  schemaVersion: typeof ORGANIZATION_SCHEMA_VERSION;
  libraryKey: string;
  folders: OrganizationFolder[];
  projects: OrganizationProject[];
  memberships: OrganizationMembership[];
}

export type OrganizationAction =
  | { type: 'folder/create'; id: string; name: string; beforeId?: string }
  | { type: 'folder/rename'; id: string; name: string }
  | { type: 'folder/delete'; id: string }
  | { type: 'folder/move'; id: string; beforeId?: string }
  | { type: 'project/create'; id: string; folderId: string | null; name: string; beforeId?: string }
  | { type: 'project/rename'; id: string; name: string }
  | { type: 'project/delete'; id: string }
  | { type: 'project/move'; id: string; folderId: string | null; beforeId?: string }
  | { type: 'item/link'; projectId: string; itemId: string; beforeItemId?: string }
  | { type: 'item/move'; fromProjectId: string; toProjectId: string; itemId: string; beforeItemId?: string }
  | { type: 'item/unlink'; projectId: string; itemId: string }
  | { type: 'item/reorder'; projectId: string; itemId: string; beforeItemId?: string };

export class OrganizationError extends Error {
  constructor(message: string) { super(message); this.name = 'OrganizationError'; }
}

export class OrganizationConflictError extends OrganizationError {
  constructor() { super('다른 탭에서 내 정리가 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요.'); this.name = 'OrganizationConflictError'; }
}

export interface OrganizationLoadResult { state: OrganizationState; raw: string | null; error?: OrganizationError }
export interface PersistOptions { expectedRaw?: string | null }

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new OrganizationError(`${label}은(는) 비어 있지 않은 문자열이어야 합니다.`);
  return value.trim();
}

function name(value: unknown): string {
  const result = requireText(value, '이름');
  if (result.length > MAX_NAME_LENGTH) throw new OrganizationError(`이름은 ${MAX_NAME_LENGTH}자 이하여야 합니다.`);
  return result;
}

function id(value: unknown, label = 'ID'): string {
  const result = requireText(value, label);
  if (result.length > 200) throw new OrganizationError(`${label}이(가) 너무 깁니다.`);
  return result;
}

function validateLibraryKey(value: unknown): string {
  const result = requireText(value, '라이브러리 키');
  if (result.length > 4_096) throw new OrganizationError('라이브러리 키가 너무 깁니다.');
  return result;
}

function order(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new OrganizationError(`${label}은(는) 유한한 숫자여야 합니다.`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new OrganizationError(`${label} 배열이 필요합니다.`);
  if (value.length > MAX_ENTRIES) throw new OrganizationError(`${label} 항목이 너무 많습니다.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrganizationError(`${label}은(는) 객체여야 합니다.`);
  return value as Record<string, unknown>;
}

function distinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new OrganizationError(`중복 ${label}이(가) 있습니다.`);
}

function stableOrderKey(entry: { order: number }): string {
  if ('id' in entry && typeof entry.id === 'string') return entry.id;
  if ('projectId' in entry && 'itemId' in entry && typeof entry.projectId === 'string' && typeof entry.itemId === 'string') {
    return JSON.stringify([entry.projectId, entry.itemId]);
  }
  return '';
}

function byOrder<T extends { order: number }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return stableOrderKey(left).localeCompare(stableOrderKey(right));
  });
}

function normalize<T extends { order: number }>(entries: readonly T[]): T[] {
  return entries.map((entry, index) => ({ ...entry, order: index }));
}

function insert<T extends { id: string }>(entries: readonly T[], entry: T, beforeId?: string): T[] {
  const result = [...entries];
  const index = beforeId === undefined ? -1 : result.findIndex((value) => value.id === beforeId);
  if (beforeId !== undefined && index < 0) throw new OrganizationError('삽입 기준 항목을 찾을 수 없습니다.');
  result.splice(index < 0 ? result.length : index, 0, entry);
  return result;
}

function arrangeFolders(folders: readonly OrganizationFolder[], beforeId?: string): OrganizationFolder[] {
  const moving = folders[folders.length - 1]!;
  return normalize(insert(byOrder(folders.slice(0, -1)), moving, beforeId));
}

function arrangeProjects(projects: readonly OrganizationProject[], folderId: string | null, beforeId?: string): OrganizationProject[] {
  const inFolder = byOrder(projects.filter((project) => project.folderId === folderId));
  const others = projects.filter((project) => project.folderId !== folderId);
  const moving = inFolder[inFolder.length - 1]!;
  return [...others, ...normalize(insert(inFolder.slice(0, -1), moving, beforeId))];
}

function arrangeMemberships(memberships: readonly OrganizationMembership[], projectId: string, beforeItemId?: string): OrganizationMembership[] {
  const inProject = [...memberships.filter((membership) => membership.projectId === projectId)]
    .sort((left, right) => left.order - right.order || left.itemId.localeCompare(right.itemId));
  const others = memberships.filter((membership) => membership.projectId !== projectId);
  const moving = inProject[inProject.length - 1]!;
  const ordered = inProject.slice(0, -1);
  const index = beforeItemId === undefined ? -1 : ordered.findIndex((membership) => membership.itemId === beforeItemId);
  if (beforeItemId !== undefined && index < 0) throw new OrganizationError('삽입 기준 자료를 찾을 수 없습니다.');
  ordered.splice(index < 0 ? ordered.length : index, 0, moving);
  return [...others, ...normalize(ordered)];
}

function reorderMembership(memberships: readonly OrganizationMembership[], projectId: string, itemId: string, beforeItemId?: string): OrganizationMembership[] {
  const moving = memberships.find((membership) => membership.projectId === projectId && membership.itemId === itemId);
  if (!moving) throw new OrganizationError('정렬할 자료 소속을 찾을 수 없습니다.');
  const inProject = byOrder(memberships.filter((membership) => membership.projectId === projectId && membership.itemId !== itemId));
  const index = beforeItemId === undefined ? -1 : inProject.findIndex((membership) => membership.itemId === beforeItemId);
  if (beforeItemId !== undefined && index < 0) throw new OrganizationError('삽입 기준 자료를 찾을 수 없습니다.');
  inProject.splice(index < 0 ? inProject.length : index, 0, moving);
  return [...memberships.filter((membership) => membership.projectId !== projectId), ...normalize(inProject)];
}

export function libraryStorageKey(payloadMode = 'production', locationScope: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  const mode = payloadMode === 'demo' ? 'demo' : 'production';
  const pathname = locationScope.pathname.replace(/\/+$/, '') || '/';
  return `${STORAGE_PREFIX}${encodeURIComponent(locationScope.origin)}:${encodeURIComponent(pathname)}:${mode}`;
}

export const getLibraryKey = libraryStorageKey;

export function emptyOrganization(libraryKey: string): OrganizationState {
  return { schemaVersion: ORGANIZATION_SCHEMA_VERSION, libraryKey: validateLibraryKey(libraryKey), folders: [], projects: [], memberships: [] };
}

export function parseOrganization(value: unknown, libraryKey: string): OrganizationState {
  const raw = record(value, '내 정리');
  if (raw.schemaVersion !== ORGANIZATION_SCHEMA_VERSION) throw new OrganizationError('지원하지 않는 내 정리 데이터 버전입니다.');
  const requiredKey = validateLibraryKey(libraryKey);
  if (raw.libraryKey !== requiredKey) throw new OrganizationError('다른 라이브러리의 내 정리 데이터입니다.');
  const folders = array(raw.folders, 'folders').map((value, index) => {
    const entry = record(value, `folders[${index}]`);
    return { id: id(entry.id), name: name(entry.name), order: order(entry.order, `folders[${index}].order`) };
  });
  const projects = array(raw.projects, 'projects').map((value, index) => {
    const entry = record(value, `projects[${index}]`);
    if (entry.folderId !== null && typeof entry.folderId !== 'string') throw new OrganizationError(`projects[${index}].folderId 값이 올바르지 않습니다.`);
    return { id: id(entry.id), folderId: entry.folderId === null ? null : id(entry.folderId, '폴더 ID'), name: name(entry.name), order: order(entry.order, `projects[${index}].order`) };
  });
  const memberships = array(raw.memberships, 'memberships').map((value, index) => {
    const entry = record(value, `memberships[${index}]`);
    return { projectId: id(entry.projectId, '프로젝트 ID'), itemId: id(entry.itemId, '자료 ID'), order: order(entry.order, `memberships[${index}].order`) };
  });
  distinct(folders.map((entry) => entry.id), '폴더 ID');
  distinct(projects.map((entry) => entry.id), '프로젝트 ID');
  const entityIds = [...folders.map((entry) => entry.id), ...projects.map((entry) => entry.id)];
  distinct(entityIds, '폴더 또는 프로젝트 ID');
  const folderIds = new Set(folders.map((entry) => entry.id));
  const projectIds = new Set(projects.map((entry) => entry.id));
  for (const project of projects) if (project.folderId !== null && !folderIds.has(project.folderId)) throw new OrganizationError(`프로젝트 ${project.id}이(가) 없는 폴더를 참조합니다.`);
  const membershipKeys = memberships.map((entry) => JSON.stringify([entry.projectId, entry.itemId]));
  distinct(membershipKeys, '프로젝트 자료 소속');
  for (const membership of memberships) if (!projectIds.has(membership.projectId)) throw new OrganizationError(`없는 프로젝트의 자료 소속이 있습니다: ${membership.projectId}`);
  return { schemaVersion: ORGANIZATION_SCHEMA_VERSION, libraryKey: requiredKey, folders, projects, memberships };
}

export function reduceOrganization(state: OrganizationState, action: OrganizationAction): OrganizationState {
  // Validate the incoming state once so reducer callers never persist malformed data.
  const current = parseOrganization(state, state.libraryKey);
  const folderIds = new Set(current.folders.map((folder) => folder.id));
  const projectIds = new Set(current.projects.map((project) => project.id));
  const entityIdAvailable = (value: string) => !folderIds.has(value) && !projectIds.has(value);
  const requireFolder = (value: string) => { if (!folderIds.has(value)) throw new OrganizationError('폴더를 찾을 수 없습니다.'); };
  const requireProject = (value: string) => { if (!projectIds.has(value)) throw new OrganizationError('프로젝트를 찾을 수 없습니다.'); };
  const result = (next: Omit<OrganizationState, 'schemaVersion' | 'libraryKey'>) => parseOrganization({ schemaVersion: ORGANIZATION_SCHEMA_VERSION, libraryKey: current.libraryKey, ...next }, current.libraryKey);

  switch (action.type) {
    case 'folder/create': {
      const newId = id(action.id); if (!entityIdAvailable(newId)) throw new OrganizationError('이미 사용 중인 폴더 또는 프로젝트 ID입니다.');
      const folders = [...current.folders, { id: newId, name: name(action.name), order: current.folders.length }];
      return result({ folders: arrangeFolders(folders, action.beforeId), projects: current.projects, memberships: current.memberships });
    }
    case 'folder/rename': {
      const newName = name(action.name); const target = current.folders.find((folder) => folder.id === action.id); requireFolder(action.id);
      if (target!.name === newName) return current;
      return result({ folders: current.folders.map((folder) => folder.id === action.id ? { ...folder, name: newName } : folder), projects: current.projects, memberships: current.memberships });
    }
    case 'folder/delete': {
      requireFolder(action.id);
      const movedProjects = byOrder(current.projects.filter((project) => project.folderId === action.id)).map((project) => ({ ...project, folderId: null }));
      const retainedProjects = current.projects.filter((project) => project.folderId !== action.id);
      const unfiledProjects = normalize([...byOrder(retainedProjects.filter((project) => project.folderId === null)), ...movedProjects]);
      return result({
        folders: normalize(byOrder(current.folders.filter((folder) => folder.id !== action.id))),
        projects: [...retainedProjects.filter((project) => project.folderId !== null), ...unfiledProjects],
        memberships: current.memberships,
      });
    }
    case 'folder/move': {
      requireFolder(action.id); if (action.beforeId === action.id) return current;
      const rest = current.folders.filter((folder) => folder.id !== action.id);
      const moving = current.folders.find((folder) => folder.id === action.id)!;
      return result({ folders: normalize(insert(byOrder(rest), moving, action.beforeId)), projects: current.projects, memberships: current.memberships });
    }
    case 'project/create': {
      const newId = id(action.id); if (!entityIdAvailable(newId)) throw new OrganizationError('이미 사용 중인 폴더 또는 프로젝트 ID입니다.');
      if (action.folderId !== null) requireFolder(action.folderId);
      const projects = [...current.projects, { id: newId, folderId: action.folderId, name: name(action.name), order: current.projects.filter((project) => project.folderId === action.folderId).length }];
      return result({ folders: current.folders, projects: arrangeProjects(projects, action.folderId, action.beforeId), memberships: current.memberships });
    }
    case 'project/rename': {
      requireProject(action.id); const newName = name(action.name); const target = current.projects.find((project) => project.id === action.id)!;
      if (target.name === newName) return current;
      return result({ folders: current.folders, projects: current.projects.map((project) => project.id === action.id ? { ...project, name: newName } : project), memberships: current.memberships });
    }
    case 'project/delete': {
      requireProject(action.id);
      return result({ folders: current.folders, projects: current.projects.filter((project) => project.id !== action.id), memberships: current.memberships.filter((membership) => membership.projectId !== action.id) });
    }
    case 'project/move': {
      requireProject(action.id); if (action.folderId !== null) requireFolder(action.folderId);
      const moving = current.projects.find((project) => project.id === action.id)!;
      if (moving.folderId === action.folderId && action.beforeId === action.id) return current;
      const sourceFolderId = moving.folderId;
      const rest = current.projects.filter((project) => project.id !== action.id);
      const moved = { ...moving, folderId: action.folderId };
      let destination = [...rest, moved];
      destination = arrangeProjects(destination, action.folderId, action.beforeId);
      if (sourceFolderId !== action.folderId) {
        const source = normalize(byOrder(destination.filter((project) => project.folderId === sourceFolderId)));
        destination = [...destination.filter((project) => project.folderId !== sourceFolderId), ...source];
      }
      return result({ folders: current.folders, projects: destination, memberships: current.memberships });
    }
    case 'item/link': {
      requireProject(action.projectId); const itemId = id(action.itemId, '자료 ID');
      if (current.memberships.some((membership) => membership.projectId === action.projectId && membership.itemId === itemId)) return current;
      const memberships = [...current.memberships, { projectId: action.projectId, itemId, order: current.memberships.filter((membership) => membership.projectId === action.projectId).length }];
      return result({ folders: current.folders, projects: current.projects, memberships: arrangeMemberships(memberships, action.projectId, action.beforeItemId) });
    }
    case 'item/move': {
      requireProject(action.fromProjectId); requireProject(action.toProjectId); const itemId = id(action.itemId, '자료 ID');
      if (action.fromProjectId === action.toProjectId) return reduceOrganization(current, { type: 'item/reorder', projectId: action.fromProjectId, itemId, beforeItemId: action.beforeItemId });
      if (!current.memberships.some((membership) => membership.projectId === action.fromProjectId && membership.itemId === itemId)) throw new OrganizationError('이동할 자료 소속을 찾을 수 없습니다.');
      const withoutSource = current.memberships.filter((membership) => !(membership.projectId === action.fromProjectId && membership.itemId === itemId));
      const existsAtDestination = withoutSource.some((membership) => membership.projectId === action.toProjectId && membership.itemId === itemId);
      const memberships = existsAtDestination ? withoutSource : [...withoutSource, { projectId: action.toProjectId, itemId, order: withoutSource.filter((membership) => membership.projectId === action.toProjectId).length }];
      const sourceNormalized = normalize(byOrder(memberships.filter((membership) => membership.projectId === action.fromProjectId)));
      let next = [...memberships.filter((membership) => membership.projectId !== action.fromProjectId), ...sourceNormalized];
      if (!existsAtDestination) next = arrangeMemberships(next, action.toProjectId, action.beforeItemId);
      return result({ folders: current.folders, projects: current.projects, memberships: next });
    }
    case 'item/unlink': {
      requireProject(action.projectId); const itemId = id(action.itemId, '자료 ID');
      if (!current.memberships.some((membership) => membership.projectId === action.projectId && membership.itemId === itemId)) return current;
      const rest = current.memberships.filter((membership) => !(membership.projectId === action.projectId && membership.itemId === itemId));
      return result({ folders: current.folders, projects: current.projects, memberships: [...rest.filter((membership) => membership.projectId !== action.projectId), ...normalize(byOrder(rest.filter((membership) => membership.projectId === action.projectId)))] });
    }
    case 'item/reorder': {
      requireProject(action.projectId); const itemId = id(action.itemId, '자료 ID');
      if (action.beforeItemId === itemId) return current;
      return result({ folders: current.folders, projects: current.projects, memberships: reorderMembership(current.memberships, action.projectId, itemId, action.beforeItemId) });
    }
  }
}

/**
 * Applies a multi-select move as one all-or-nothing state transition. The input
 * state is never mutated; if any action is invalid, the caller retains it.
 */
export function applyOrganizationActions(state: OrganizationState, actions: readonly OrganizationAction[]): OrganizationState {
  let next = state;
  for (const action of actions) next = reduceOrganization(next, action);
  return next;
}

export function serializeOrganization(state: OrganizationState): string {
  return JSON.stringify(parseOrganization(state, state.libraryKey));
}

export function loadOrganization(storage: Pick<Storage, 'getItem'>, libraryKey: string): OrganizationLoadResult {
  const key = validateLibraryKey(libraryKey);
  let raw: string | null;
  try { raw = storage.getItem(key); } catch (error) { return { state: emptyOrganization(key), raw: null, error: new OrganizationError(`내 정리 저장소를 읽을 수 없습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`) }; }
  if (raw === null) return { state: emptyOrganization(key), raw };
  try { return { state: parseOrganization(JSON.parse(raw), key), raw }; }
  catch (error) { return { state: emptyOrganization(key), raw, error: error instanceof OrganizationError ? error : new OrganizationError('내 정리 데이터를 읽을 수 없습니다.') }; }
}

export function persistOrganization(storage: Pick<Storage, 'getItem' | 'setItem'>, state: OrganizationState, options: PersistOptions = {}): string {
  const valid = parseOrganization(state, state.libraryKey);
  const raw = JSON.stringify(valid);
  try {
    if (options.expectedRaw !== undefined && storage.getItem(valid.libraryKey) !== options.expectedRaw) throw new OrganizationConflictError();
    storage.setItem(valid.libraryKey, raw);
    return raw;
  } catch (error) {
    if (error instanceof OrganizationError) throw error;
    throw new OrganizationError(`내 정리를 저장할 수 없습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`);
  }
}
