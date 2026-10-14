import type { KnowledgeItem, KnowledgeRelation } from './model';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko');
/** AND matching across fields; title matches outrank metadata and body matches. */
export function searchScores(items: readonly KnowledgeItem[], relations: readonly KnowledgeRelation[], query: string, sharedLabels: ReadonlyMap<string, string[]> = new Map()): Map<string, number> {
  const tokens = [...new Set(normalize(query).trim().split(/\s+/).filter(Boolean))];
  if (!tokens.length) return new Map(items.map((item) => [item.id, 0]));
  const relationLabels = { references: '참조', based_on: '근거', explains: '설명', uses_with: '함께 사용', related: '관련' };
  const labels = new Map<string, string[]>();
  for (const edge of relations) for (const id of [edge.source, edge.target]) labels.set(id, [...(labels.get(id) ?? []), edge.label, relationLabels[edge.type], edge.evidence ?? '']);
  const scores = new Map<string, number>();
  for (const item of items) {
    const title = normalize(item.title);
    const metadata = normalize([item.owner, item.department, item.domain, item.subtype, ...item.tags, ...(labels.get(item.id) ?? []), ...(sharedLabels.get(item.id) ?? [])].join('\n'));
    const content = normalize([item.description, item.body ?? '', item.prompt ?? ''].join('\n'));
    let score = 0; let matches = true;
    for (const token of tokens) {
      if (title.includes(token)) score += title === token ? 100 : title.startsWith(token) ? 60 : 40;
      else if (metadata.includes(token)) score += 12;
      else if (content.includes(token)) score += 3;
      else { matches = false; break; }
    }
    if (matches) scores.set(item.id, score);
  }
  return scores;
}
