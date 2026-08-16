import { DraftHandler } from './types';

const handlers = new Map<string, DraftHandler<any>>();

export function registerDraftKind(handler: DraftHandler<any>): void {
  handlers.set(handler.kind, handler);
}

export function getDraftHandler(kind: string): DraftHandler<any> | undefined {
  return handlers.get(kind);
}
