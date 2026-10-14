import { describe, expect, it, vi } from 'vitest';
import { writeSelectionHistory, type HistoryWriter } from './navigation';

function writer() {
  return { pushState: vi.fn(), replaceState: vi.fn() } satisfies HistoryWriter;
}

describe('writeSelectionHistory', () => {
  it('pushes explicit item selections with an encoded share hash', () => {
    const history = writer();
    writeSelectionHistory(history, '/kms/', '?view=list', '인사 문서/1');
    expect(history.pushState).toHaveBeenCalledWith(null, '', '#item=%EC%9D%B8%EC%82%AC%20%EB%AC%B8%EC%84%9C%2F1');
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it('replaces automatic filter cleanup instead of adding a back-history entry', () => {
    const history = writer();
    writeSelectionHistory(history, '/kms/', '?view=list', null, true);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/kms/?view=list');
    expect(history.pushState).not.toHaveBeenCalled();
  });
});
