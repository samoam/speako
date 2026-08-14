import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { logGeminiUsage } from '../gemini/logUsage';
import { pcmToWav } from '../audio-capture/wavHeader';

const SCRIPT_PROMPT = `You are writing a short, natural two-host podcast-style discussion (hosts named
"HostA" and "HostB") for someone to listen to instead of reading. Cover the material below in a
genuinely conversational way — hosts can react to each other, ask follow-up questions, and highlight
what's actually interesting — not just read a summary aloud in turns.

Let the length follow the material: if there's a lot of substantive content, a fuller discussion is fine;
if there's very little, keep it brief rather than padding it out. Never invent facts not implied by the
material below.

Format strictly as alternating lines, each starting with "HostA:" or "HostB:" and nothing else on the
line (no scene directions, no headers).`;

/** Turns a block of gathered context (a session's summary, or RAG-retrieved excerpts) into a two-host dialogue script. Creative writing, not extraction — stays on config.geminiModel, not the fast tier. */
export async function generateAudioOverviewScript(subjectLabel: string, contextBlock: string): Promise<string> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

  const prompt = `${SCRIPT_PROMPT}\n\nSubject: ${subjectLabel}\n\nMaterial:\n${contextBlock}`;
  const response = await getGeminiClient().models.generateContent({
    model: config.geminiModel,
    contents: prompt,
  });
  logGeminiUsage('generateAudioOverviewScript', response);

  const script = (response.text ?? '').trim();
  if (!script) throw new Error('Gemini returned an empty script.');
  return script;
}

/** Parses "audio/L16;codec=pcm;rate=24000"-style mimeTypes — never hardcode the rate, Google states it on every response and it's confirmed to matter (TTS output is 24kHz, distinct from this app's own 16kHz mic capture). */
function parsePcmSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  if (!match) throw new Error(`Could not determine sample rate from TTS response mimeType: ${mimeType}`);
  return Number(match[1]);
}

/**
 * Synthesizes a two-host script into a playable WAV buffer via Gemini's TTS
 * model (config.geminiTtsModel). Exactly two speakerVoiceConfigs are
 * required by the API for multiSpeakerVoiceConfig (verified directly) — the
 * speaker names here must match "HostA"/"HostB" as used in the script.
 */
export async function synthesizeAudioOverviewSpeech(script: string): Promise<Buffer> {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY is not configured — see NOTES.md.');

  const response = await getGeminiClient().models.generateContent({
    model: config.geminiTtsModel,
    contents: script,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: [
            { speaker: 'HostA', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            { speaker: 'HostB', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
          ],
        },
      },
    },
  });
  logGeminiUsage('synthesizeAudioOverviewSpeech', response);

  const part = response.candidates?.[0]?.content?.parts?.[0];
  const base64Data: string | undefined = part?.inlineData?.data;
  if (!base64Data) throw new Error('Gemini TTS response did not include audio data.');

  const sampleRate = parsePcmSampleRate(part.inlineData.mimeType);
  const pcm = Buffer.from(base64Data, 'base64');
  return pcmToWav(pcm, sampleRate, 1);
}

export interface AudioOverviewResult {
  scriptText: string;
  audioBuffer: Buffer;
}

/** The full two-step flow — script, then speech. Each step logged/attributed separately (see the two functions above) so cost tracking distinguishes the cheap-ish text step from the pricier audio step. */
export async function generateAudioOverview(subjectLabel: string, contextBlock: string): Promise<AudioOverviewResult> {
  const scriptText = await generateAudioOverviewScript(subjectLabel, contextBlock);
  const audioBuffer = await synthesizeAudioOverviewSpeech(scriptText);
  return { scriptText, audioBuffer };
}
