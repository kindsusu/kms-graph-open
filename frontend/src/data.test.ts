import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSafeExternalUrl, parsePayload, PayloadError } from './data';
import { createDemoPayload } from './development/demo';

const item = { id: 'a', title: '자료', kind: 'document', subtype: '', description: '', owner: '', department: '', domain: '', tags: [] };

describe('parsePayload', () => {
  it('parses the schema v2 sample consumed by the Python builder', () => {
    const samplePath = fileURLToPath(new URL('../../sample/knowledge.json', import.meta.url));
    const payload = parsePayload(JSON.parse(readFileSync(samplePath, 'utf8')));
    expect(payload.items).toHaveLength(4);
    expect(payload.relations).toHaveLength(3);
  });
  it('accepts required metadata fields when they are empty strings', () => {
    expect(parsePayload({ schemaVersion: 2, title: 'KMS', generatedAt: '2026-01-01', items: [item], relations: [] }).items[0]).toMatchObject(item);
  });
  it('accepts generated demo payloads at normal and dense sizes', () => {
    expect(parsePayload(createDemoPayload(150)).relations).toHaveLength(300);
    expect(parsePayload(createDemoPayload(1000)).relations).toHaveLength(2000);
  });
  it('permits prompt only for prompt AI assets', () => {
    expect(() => parsePayload({ schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [{ ...item, prompt: 'secret' }], relations: [] })).toThrow(PayloadError);
    expect(parsePayload({ schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [{ ...item, kind: 'ai_asset', subtype: '프롬프트', prompt: '초안' }], relations: [] }).items[0].prompt).toBe('초안');
  });
  it('rejects self and duplicate relation tuples', () => {
    const b = { ...item, id: 'b', title: '다른 자료' };
    const base = { schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [item, b] };
    expect(() => parsePayload({ ...base, relations: [{ id: 'r', source: 'a', target: 'a', type: 'related', label: '' }] })).toThrow(/자기 자신/);
    expect(() => parsePayload({ ...base, relations: [{ id: 'r1', source: 'a', target: 'b', type: 'related', label: '' }, { id: 'r2', source: 'a', target: 'b', type: 'related', label: '' }] })).toThrow(/중복 관계/);
  });
  it('rejects reverse duplicates for symmetric relations and preserves directed reverse relations', () => {
    const b = { ...item, id: 'b', title: '다른 자료' };
    const base = { schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [item, b] };
    for (const type of ['related', 'uses_with'] as const) {
      expect(() => parsePayload({ ...base, relations: [
        { id: `${type}-1`, source: 'a', target: 'b', type, label: '' },
        { id: `${type}-2`, source: 'b', target: 'a', type, label: '' },
      ] })).toThrow(/중복 관계/);
    }
    expect(parsePayload({ ...base, relations: [
      { id: 'reference-forward', source: 'a', target: 'b', type: 'references', label: '' },
      { id: 'reference-reverse', source: 'b', target: 'a', type: 'references', label: '' },
    ] }).relations).toHaveLength(2);
  });
  it('does not confuse distinct relation IDs that contain the old tuple separator', () => {
    const separator = '\u0000';
    const middle = { ...item, id: `a${separator}b`, title: '중간 자료' };
    const last = { ...item, id: `b${separator}c`, title: '마지막 자료' };
    const base = { schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [item, middle, last, { ...item, id: 'c', title: '끝 자료' }] };
    expect(parsePayload({ ...base, relations: [
      { id: 'separator-first', source: `a${separator}b`, target: 'c', type: 'references', label: '' },
      { id: 'separator-second', source: 'a', target: `b${separator}c`, type: 'references', label: '' },
    ] }).relations).toHaveLength(2);
  });
});

describe('isSafeExternalUrl', () => {
  it('allows plain HTTP(S) addresses and rejects credentials or control whitespace', () => {
    expect(isSafeExternalUrl('https://example.com/a')).toBe(true);
    expect(isSafeExternalUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('https://example.com/\nnext')).toBe(false);
  });
});


describe('optional publication metadata', () => {
  const base = { schemaVersion: 2, title: 'KMS', generatedAt: 'x', items: [item], relations: [] };
  it('preserves provenance, shared memberships, evidence and review candidates', () => {
    const payload = parsePayload({ ...base, items: [{ ...item, sourceId: 'source-a', sourceUrl: 'https://example.com/source', sourceUpdatedAt: '2026-01-01', collectedAt: '2026-01-02', projectIds: ['p'] }, { ...item, id: 'b' }], sharedProjects: [{ id: 'p', title: '공용 프로젝트', description: '' }], relations: [{ id: 'r', source: 'a', target: 'b', type: 'references', label: '', evidence: '검토 근거', evidenceUrl: 'https://example.com/evidence' }], reviewCandidates: [{ itemId: 'a', changedSourceIds: ['b'], reason: '의존 자료 변경', removedSourceCount: 1 }] });
    expect(payload.items[0].sourceId).toBe('source-a'); expect(payload.items[0].projectIds).toEqual(['p']);
    expect(payload.reviewCandidates?.[0].removedSourceCount).toBe(1); expect(payload.relations[0].evidence).toBe('검토 근거'); expect(payload.reviewCandidates?.[0].changedSourceIds).toEqual(['b']);
  });
  it('rejects unpublished changed origins and duplicate review candidates', () => {
    expect(() => parsePayload({ ...base, reviewCandidates: [{ itemId: 'a', changedSourceIds: ['unpublished'], reason: '변경' }] })).toThrow(/없는 변경 원본/);
    const candidate = { itemId: 'a', changedSourceIds: [], reason: '변경', removedSourceCount: 1 };
    expect(() => parsePayload({ ...base, reviewCandidates: [candidate, candidate] })).toThrow(/중복 재검토 후보/);
    expect(parsePayload({ ...base, reviewCandidates: [candidate] }).reviewCandidates?.[0].removedSourceCount).toBe(1);
  });
  it('rejects unknown groups and unsafe evidence/source URLs', () => {
    expect(() => parsePayload({ ...base, items: [{ ...item, projectIds: ['missing'] }] })).toThrow(/없는 공용/);
    expect(() => parsePayload({ ...base, items: [{ ...item, sourceUrl: 'javascript:alert(1)' }] })).toThrow(/URL/);
    expect(() => parsePayload({ ...base, sharedProjects: [{ id: 'p', title: 'P' }, { id: 'p', title: 'Q' }] })).toThrow(/중복 공용/);
    expect(() => parsePayload({ ...base, items: [item, { ...item, id: 'b' }], relations: [{ id: 'r', source: 'a', target: 'b', type: 'references', label: '', evidenceUrl: 'javascript:alert(1)' }] })).toThrow(/URL/);
    expect(() => parsePayload({ ...base, reviewCandidates: [{ itemId: 'a', changedSourceIds: [], reason: '변경', removedSourceCount: -1 }] })).toThrow(/removedSourceCount/);
    expect(() => parsePayload({ ...base, reviewCandidates: [{ itemId: 'missing', changedSourceIds: [], reason: '변경' }] })).toThrow(/없는 재검토/);
  });
});
