import { getGeminiClient } from './geminiClient';

// Gemini's minimum cacheable-content size varies by model (roughly a few
// hundred to ~1000+ tokens) — creating a cache below that threshold either
// gets rejected by the API or wastes a round trip for no benefit. ~4000
// characters (~1000 tokens) is a conservative proxy that comfortably clears
// it for what this is used for (full meeting transcripts, prep source
// bundles) while staying safely inert for short ones.
const MIN_CACHEABLE_CHARS = 4000;

/**
 * Creates a short-lived explicit cache for content shared by two or more
 * back-to-back Gemini calls (e.g. summarizeSession + extractActionItems both
 * sending the same full transcript) — cached-content reads bill at roughly
 * 10% of the normal input price. Returns null when the content's too small
 * to be worth caching or cache creation fails for any reason; callers must
 * fall back to inlining the content directly in that case — correctness
 * never depends on this succeeding.
 */
export async function createSharedCache(model: string, content: string, ttlSeconds = 600): Promise<string | null> {
  if (content.length < MIN_CACHEABLE_CHARS) return null;
  try {
    const cache = await getGeminiClient().caches.create({
      model,
      config: { contents: content, ttl: `${ttlSeconds}s` },
    });
    return cache.name ?? null;
  } catch (err: any) {
    console.error('[gemini] context cache creation failed, falling back to inline content:', err.message);
    return null;
  }
}
