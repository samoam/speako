import { v1 } from '@google-cloud/language';

const client = new v1.LanguageServiceClient();

export interface SentimentResult {
  score: number;
  magnitude: number;
}

/** Document-level sentiment for one finalized transcript segment's text. */
export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  const [result] = await client.analyzeSentiment({
    document: { content: text, type: 'PLAIN_TEXT' },
  });
  return {
    score: result.documentSentiment?.score ?? 0,
    magnitude: result.documentSentiment?.magnitude ?? 0,
  };
}
