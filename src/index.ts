import { config } from './config';
import { InterfaceServer } from './interface/server';
import { Session } from './session';
import { closeOrphanedSessions } from './storage/segmentRepository';

function main(): void {
  // A previous process instance may have died before Session.stop() ran (a
  // crash, a forced kill, the machine sleeping) — that leaves a session
  // stuck with ended_at NULL forever, since nothing else ever sets it. A
  // fresh process means nothing is actually recording yet, so reconcile now.
  const recovered = closeOrphanedSessions();
  if (recovered > 0) {
    console.log(`Recovered ${recovered} session(s) left "recording" by a previous run that didn't shut down cleanly.`);
  }

  const ui = new InterfaceServer();
  let currentSession: Session | null = null;

  ui.setHandlers({
    onStart: (languageCode, name, existingSessionId, activeFeatures) => {
      const languageCodes = languageCode ? [languageCode] : config.languageCodes;
      currentSession = new Session(ui, languageCodes, name, existingSessionId, activeFeatures);
      currentSession.start();
      return currentSession.id;
    },
    onStop: () => {
      currentSession?.stop();
      currentSession = null;
    },
  });

  ui.start();

  const shutdown = () => {
    console.log('\nStopping…');
    currentSession?.stop();
    ui.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Best-effort safety net: an uncaught exception/rejection anywhere still
  // leaves the process in an unknown state, so this doesn't try to keep
  // running — just makes sure the active session's ended_at gets set (and
  // its WAV recorder flushed) before going down, rather than leaving another
  // stuck-forever row for the next start to clean up. Won't help against a
  // SIGKILL or power loss — closeOrphanedSessions() above is the backstop
  // for those.
  const crashShutdown = (label: string) => (err: any) => {
    console.error(`[fatal] ${label}:`, err?.stack || err);
    try {
      currentSession?.stop();
    } catch (stopErr: any) {
      console.error('[fatal] failed to cleanly stop the active session during crash shutdown:', stopErr.message);
    }
    process.exit(1);
  };
  process.on('uncaughtException', crashShutdown('uncaughtException'));
  process.on('unhandledRejection', crashShutdown('unhandledRejection'));
}

main();
