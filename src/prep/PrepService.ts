import { createPrepBrief } from '../storage/prepBriefRepository';
import { findLikelyPreviousSession, setPrepStatus } from '../storage/segmentRepository';
import { seedMeetingState } from '../state/meetingState';
import { MeetingType } from './meetingTypes';
import { getWorkflow } from './workflows';
import { synthesizeBrief } from './synthesizeBrief';
import { anticipateQA } from './anticipateQA';

export interface RunPrepParams {
  sessionId: string;
  sessionName?: string;
  meetingType: MeetingType;
  calendarEventId?: string;
  /** Free text the user typed before clicking "Prepare session" — given priority in synthesis, see synthesizeBrief.ts. */
  userNotes?: string;
  /** Which tools this session has active — null means "all globally-configured tools." See src/tools/activeTools.ts. */
  activeTools: string[] | null;
  /** Called once the brief is ready (or prep has failed) — server.ts wires this to a WS broadcast. */
  onDone?: (sessionId: string, status: 'ready' | 'failed') => void;
}

/**
 * Orchestrates one prep run: find the likely previous instance of this
 * recurring meeting, run the meeting-type's workflow to gather raw context,
 * synthesize it (plus any user-provided notes) into a brief, persist it, and
 * seed meeting_state so live assistance starts grounded instead of cold
 * (§5.1-§5.4). Runs async and never throws to its caller — the caller gets
 * sessionId back immediately and learns the outcome via onDone/polling
 * prep_status, matching every other background operation in this codebase
 * (diarization, summarization).
 */
export async function runPrep(params: RunPrepParams): Promise<void> {
  const { sessionId, sessionName, meetingType, calendarEventId, userNotes, activeTools, onDone } = params;
  const hasUserNotes = !!userNotes?.trim();

  try {
    const previousSession = findLikelyPreviousSession(meetingType, sessionName, sessionId);

    const workflow = getWorkflow(meetingType);
    const { sources } = await workflow({ sessionId, sessionName, userNotes, meetingType, previousSession, activeTools });

    const [briefText, anticipatedQa] = await Promise.all([
      synthesizeBrief(meetingType, sessionName, sources, userNotes),
      anticipateQA(meetingType, sessionName, sources, userNotes),
    ]);
    const succeeded = sources.length > 0 || hasUserNotes;

    createPrepBrief({
      sessionId,
      meetingType,
      calendarEventId,
      sourcesQueried: [...(hasUserNotes ? ['user_notes'] : []), ...sources.map((s) => s.name)],
      prepBriefText: briefText,
      rawContext: hasUserNotes ? [{ name: 'user_notes', content: userNotes!.trim() }, ...sources] : sources,
      anticipatedQa,
    });

    seedMeetingState(sessionId, briefText);
    setPrepStatus(sessionId, succeeded ? 'ready' : 'failed');
    onDone?.(sessionId, succeeded ? 'ready' : 'failed');
  } catch (err: any) {
    console.error(`[prep] run failed for session ${sessionId}:`, err.message);
    setPrepStatus(sessionId, 'failed');
    onDone?.(sessionId, 'failed');
  }
}
