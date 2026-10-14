export interface HistoryWriter {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function writeSelectionHistory(target: HistoryWriter, pathname: string, search: string, id: string | null, replace = false) {
  const url = id ? `#item=${encodeURIComponent(id)}` : `${pathname}${search}`;
  target[replace ? 'replaceState' : 'pushState'](null, '', url);
}
