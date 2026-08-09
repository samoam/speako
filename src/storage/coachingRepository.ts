import { db } from './db';

export type FeedbackCategory = 'clarity' | 'pacing' | 'filler_words' | 'talk_time' | 'follow_through';

export interface FeedbackPoint {
  category: FeedbackCategory;
  observation: string;
  quote: string | null;
  suggestion: string;
}

export interface CoachingFeedback {
  sessionId: string;
  talkTimeRatio: number;
  fillerWordCount: number;
  fillerWordExamples: string[];
  feedbackPoints: FeedbackPoint[];
  generatedAt: string;
}

export function saveCoachingFeedback(
  sessionId: string,
  feedback: Omit<CoachingFeedback, 'sessionId' | 'generatedAt'>
): CoachingFeedback {
  const generatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO coaching_feedback (session_id, talk_time_ratio, filler_word_count, filler_word_examples, feedback_points, generated_at)
     VALUES (@sessionId, @talkTimeRatio, @fillerWordCount, @fillerWordExamples, @feedbackPoints, @generatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       talk_time_ratio = excluded.talk_time_ratio,
       filler_word_count = excluded.filler_word_count,
       filler_word_examples = excluded.filler_word_examples,
       feedback_points = excluded.feedback_points,
       generated_at = excluded.generated_at`
  ).run({
    sessionId,
    talkTimeRatio: feedback.talkTimeRatio,
    fillerWordCount: feedback.fillerWordCount,
    fillerWordExamples: JSON.stringify(feedback.fillerWordExamples),
    feedbackPoints: JSON.stringify(feedback.feedbackPoints),
    generatedAt,
  });
  return { sessionId, ...feedback, generatedAt };
}

export function getCoachingFeedback(sessionId: string): CoachingFeedback | undefined {
  const row = db.prepare('SELECT * FROM coaching_feedback WHERE session_id = ?').get(sessionId) as
    | {
        session_id: string;
        talk_time_ratio: number;
        filler_word_count: number;
        filler_word_examples: string;
        feedback_points: string;
        generated_at: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.session_id,
    talkTimeRatio: row.talk_time_ratio,
    fillerWordCount: row.filler_word_count,
    fillerWordExamples: JSON.parse(row.filler_word_examples),
    feedbackPoints: JSON.parse(row.feedback_points),
    generatedAt: row.generated_at,
  };
}
