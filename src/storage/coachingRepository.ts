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
  youInterruptedOthersCount: number;
  othersInterruptedYouCount: number;
  feedbackPoints: FeedbackPoint[];
  generatedAt: string;
}

export function saveCoachingFeedback(
  sessionId: string,
  feedback: Omit<CoachingFeedback, 'sessionId' | 'generatedAt'>
): CoachingFeedback {
  const generatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO coaching_feedback (session_id, talk_time_ratio, filler_word_count, filler_word_examples, you_interrupted_others_count, others_interrupted_you_count, feedback_points, generated_at)
     VALUES (@sessionId, @talkTimeRatio, @fillerWordCount, @fillerWordExamples, @youInterruptedOthersCount, @othersInterruptedYouCount, @feedbackPoints, @generatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       talk_time_ratio = excluded.talk_time_ratio,
       filler_word_count = excluded.filler_word_count,
       filler_word_examples = excluded.filler_word_examples,
       you_interrupted_others_count = excluded.you_interrupted_others_count,
       others_interrupted_you_count = excluded.others_interrupted_you_count,
       feedback_points = excluded.feedback_points,
       generated_at = excluded.generated_at`
  ).run({
    sessionId,
    talkTimeRatio: feedback.talkTimeRatio,
    fillerWordCount: feedback.fillerWordCount,
    fillerWordExamples: JSON.stringify(feedback.fillerWordExamples),
    youInterruptedOthersCount: feedback.youInterruptedOthersCount,
    othersInterruptedYouCount: feedback.othersInterruptedYouCount,
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
        you_interrupted_others_count: number;
        others_interrupted_you_count: number;
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
    youInterruptedOthersCount: row.you_interrupted_others_count,
    othersInterruptedYouCount: row.others_interrupted_you_count,
    feedbackPoints: JSON.parse(row.feedback_points),
    generatedAt: row.generated_at,
  };
}
