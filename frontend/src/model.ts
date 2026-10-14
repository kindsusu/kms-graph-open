export type ItemKind = 'document' | 'tool' | 'ai_asset';

export interface KnowledgeItem {
  id: string;
  title: string;
  kind: ItemKind;
  subtype: string;
  description: string;
  owner: string;
  department: string;
  domain: string;
  tags: string[];
  url?: string;
  body?: string;
  /** Present only on an ai_asset whose subtype is 프롬프트. */
  prompt?: string;
  version?: string;
  updatedAt?: string;
  status?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceUpdatedAt?: string;
  collectedAt?: string;
  folderIds?: string[];
  projectIds?: string[];
  health?: 'ok' | 'unchecked' | 'unreachable' | 'auth_required';
}

export type RelationType = 'references' | 'based_on' | 'explains' | 'uses_with' | 'related';
export interface KnowledgeRelation {
  id: string;
  source: string;
  target: string;
  type: RelationType;
  label: string;
  evidence?: string;
  evidenceUrl?: string;
}

export interface SharedGroup { id: string; title: string; description: string; folderId?: string }
export interface ReviewCandidate { itemId: string; changedSourceIds: string[]; reason: string; removedSourceCount?: number }

export interface KnowledgePayload {
  schemaVersion: 2;
  title: string;
  generatedAt: string;
  items: KnowledgeItem[];
  relations: KnowledgeRelation[];
  isDemo?: boolean;
  sharedFolders?: SharedGroup[];
  sharedProjects?: SharedGroup[];
  reviewCandidates?: ReviewCandidate[];
}

export interface GraphStats {
  visibleNodes: number;
  visibleEdges: number;
  layoutRunning: boolean;
}

export interface GraphCanvasProps {
  items: KnowledgeItem[];
  relations: KnowledgeRelation[];
  relationTypes?: ReadonlySet<RelationType>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Filtering must not recompute the layout. */
  visibleIds?: ReadonlySet<string>;
  /** 0 = entire graph; 1/2 = undirected hops around selection. */
  localDepth?: 0 | 1 | 2;
  focusRequest?: { id: string; nonce: number } | null;
  onStats?: (stats: GraphStats) => void;
}
