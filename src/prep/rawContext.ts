import { WorkflowSource } from './workflows/types';

/** Shared by synthesizeBrief.ts and anticipateQA.ts, which both build the identical raw-sources block — factored out so there's one place to change, and so PrepService.ts can build it once and share a Gemini context cache between both calls. */
export function buildRawContextBlock(sources: WorkflowSource[]): string {
  return sources.map((s) => `--- ${s.name} ---\n${s.content}`).join('\n\n');
}
