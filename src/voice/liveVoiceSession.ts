import { EventEmitter } from 'events';
import { config } from '../config';
import { getGeminiClient } from '../gemini/geminiClient';
import { ToolKey } from '../tools/activeTools';
import { searchByTool } from '../prep/toolCatalog';
import { retrieve } from '../rag/rag';

// @google/genai is ESM-only but ships a working CJS build — same require()
// trick used by geminiClient.ts/mcpClient.ts to sidestep the ESM/CJS boundary
// under this project's CommonJS + node16 module resolution. Session/message
// shapes are treated as `any` for the same reason (getGeminiClient() is
// already `any`-typed).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Modality } = require('@google/genai');

/**
 * The full set of tools eligible for voice chat/practice's function-calling —
 * a deliberately smaller subset of ALL_TOOL_KEYS (no email/teams/web search,
 * which don't fit a live spoken assistant), mirroring liveQa.ts's existing
 * scope plus mem0 and localCodebase. This is the *ceiling*: config.voiceToolKeys
 * (user-configurable via Settings) picks the actual active subset of this,
 * which server.ts then further filters down to whichever of those are
 * actually configured (has real credentials/paths).
 */
export const VOICE_TOOL_KEYS: ToolKey[] = ['jira', 'confluence', 'mem0', 'ragCloud', 'bitbucket', 'localCodebase'];

const TOOL_DESCRIPTIONS: Partial<Record<ToolKey, string>> = {
  jira: 'Search Jira tickets by keyword.',
  confluence: 'Search Confluence pages by keyword.',
  mem0: 'Search durable personal/work memory facts previously saved about people and topics.',
  ragCloud: 'Search external reference material and documents (the MyRAG cloud service) — NOT this user\'s own Speako meetings, use search_pastMeetings for those.',
  bitbucket: 'Search recent commit activity in configured Bitbucket repos.',
  localCodebase: 'Search the user\'s locally indexed codebase(s) by keyword.',
};

const FUNCTION_PREFIX = 'search_';

/**
 * Searches this user's own past Speako meeting transcripts (src/rag/rag.ts's
 * local corpus, built from every recorded session) — always available, no
 * "is configured" gate, unlike the VOICE_TOOL_KEYS below which wrap optional
 * external integrations. Dispatched separately in handleMessage() rather
 * than through toolKeyFromFunctionName/searchByTool/TOOL_CATALOG, since
 * "past meetings" isn't an external integration with a configured/
 * not-configured state — it's always there if you've recorded anything.
 *
 * This was missing entirely before — the only other RAG-shaped tool offered
 * to voice chat was 'ragCloud', whose name/description confusingly implied
 * it covered past meetings too, but it only ever called the external MyRAG
 * cloud service (src/integrations/ragClient.ts), never the local corpus.
 */
const PAST_MEETINGS_FUNCTION_NAME = `${FUNCTION_PREFIX}pastMeetings`;

function buildPastMeetingsDeclaration(): any {
  return {
    name: PAST_MEETINGS_FUNCTION_NAME,
    description: "Search this user's own past Speako meetings — recorded transcripts, discussions, and decisions from meetings they've had.",
    parametersJsonSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
  };
}

/** Builds Gemini Live function declarations for the given tools — one `search_<tool>(query)` function per tool, executed via the same searchByTool() prep already uses. */
export function buildFunctionDeclarations(tools: ToolKey[]): any[] {
  return tools.map((tool) => ({
    name: `${FUNCTION_PREFIX}${tool}`,
    description: TOOL_DESCRIPTIONS[tool] ?? `Search ${tool}.`,
    parametersJsonSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.' } },
      required: ['query'],
    },
  }));
}

function toolKeyFromFunctionName(name: string | undefined): ToolKey | null {
  if (!name?.startsWith(FUNCTION_PREFIX)) return null;
  const key = name.slice(FUNCTION_PREFIX.length) as ToolKey;
  return VOICE_TOOL_KEYS.includes(key) ? key : null;
}

export interface LiveVoiceSessionOptions {
  systemInstruction: string;
  /** Defaults to VOICE_TOOL_KEYS — pass a filtered subset (e.g. only configured tools) to avoid Gemini calling a tool that isn't set up. */
  tools?: ToolKey[];
}

/**
 * Wraps one Gemini Live (`ai.live.connect()`) WebSocket connection —
 * EventEmitter-based, same shape as SoxCapture/StreamManager. Emits:
 * 'open', 'audio' (Buffer, PCM16 @ 24kHz), 'inputTranscript'/'outputTranscript'
 * (text, finished), 'functionCall' (tool name), 'turnComplete', 'error', 'close'.
 */
export class LiveVoiceSession extends EventEmitter {
  private session: any = null;
  private closed = false;

  constructor(private options: LiveVoiceSessionOptions) {
    super();
  }

  /**
   * abortSignal: lets a caller give up on a hung handshake without leaving
   * this promise pending forever (see server.ts's connect timeout). Per the
   * SDK's own docs this is client-side only — it does not cancel the request
   * on Google's servers, and usage is still billed for it — so it's cleanup
   * hygiene for our process, not a fix for a server-side concurrency limit.
   */
  async connect(abortSignal?: AbortSignal): Promise<void> {
    const ai = getGeminiClient();
    const tools = this.options.tools ?? VOICE_TOOL_KEYS;
    // search_pastMeetings is always included, unlike the rest — see its own comment above.
    const functionDeclarations = [buildPastMeetingsDeclaration(), ...buildFunctionDeclarations(tools)];

    this.session = await ai.live.connect({
      model: config.geminiLiveModel,
      callbacks: {
        onopen: () => this.emit('open'),
        onmessage: (msg: any) => {
          if (process.env.VOICE_DEBUG) console.log('[LiveVoiceSession] raw message:', JSON.stringify(msg).slice(0, 500));
          this.handleMessage(msg).catch((err: any) => this.emit('error', err));
        },
        onerror: (e: any) => this.emit('error', new Error(e?.message || 'Live session error')),
        onclose: (e: any) => this.emit('close', e),
      },
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.options.systemInstruction,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations }],
        abortSignal,
      },
    });
  }

  /** chunk: raw PCM16 mono audio at config.sampleRate (16kHz), matching SoxCapture's existing output format exactly. */
  sendAudio(chunk: Buffer): void {
    if (this.closed || !this.session) return;
    this.session.sendRealtimeInput({
      media: { data: chunk.toString('base64'), mimeType: `audio/pcm;rate=${config.sampleRate}` },
    });
  }

  /**
   * Text input — lets the user type instead of/in addition to talking during
   * voice chat/practice. Uses sendClientContent (a discrete, ordered turn),
   * not sendRealtimeInput: that method's parameters have no `text` field at
   * all (audio/video/media only), so passing `{ text }` to it was silently a
   * no-op — confirmed via real-API testing (the message sent but the model
   * never responded). turnComplete: true tells the model to respond now
   * rather than wait for more input, matching how a typed message is a
   * complete, ready-to-answer turn (unlike streamed audio chunks).
   */
  sendText(text: string): void {
    if (this.closed || !this.session) return;
    this.session.sendClientContent({ turns: text, turnComplete: true });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session?.close();
  }

  private async handleMessage(msg: any): Promise<void> {
    const content = msg.serverContent;
    if (content) {
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) this.emit('audio', Buffer.from(part.inlineData.data, 'base64'));
      }
      if (content.inputTranscription?.text) {
        this.emit('inputTranscript', content.inputTranscription.text, !!content.inputTranscription.finished);
      }
      if (content.outputTranscription?.text) {
        this.emit('outputTranscript', content.outputTranscription.text, !!content.outputTranscription.finished);
      }
      if (content.turnComplete) this.emit('turnComplete');
      // generationComplete fires as soon as the model is done producing this
      // response — turnComplete fires later, after an artificial delay while
      // the model assumes realtime audio playback is still finishing (per
      // the SDK's own docs). That delay is meaningless in a server-relay
      // architecture (the server doesn't control the browser's actual
      // playback timing), so callers wanting "the response is done, flush
      // now" should use this event instead — confirmed via real traffic
      // where turnComplete didn't arrive within several seconds of
      // generationComplete for a longer response.
      if (content.generationComplete) this.emit('generationComplete');
    }

    const functionCalls = msg.toolCall?.functionCalls;
    if (functionCalls?.length) {
      for (const call of functionCalls) {
        const query = (call.args?.query as string) ?? '';
        let output: string;

        if (call.name === PAST_MEETINGS_FUNCTION_NAME) {
          this.emit('functionCall', 'pastMeetings');
          try {
            const result = await retrieve(query);
            output = result.suppressed
              ? '(no past meetings closely match this query)'
              : result.chunks.map((c) => `(${c.sessionName || 'a past session'}) ${c.text}`).join('\n');
          } catch (err: any) {
            output = `Search failed: ${err.message}`;
          }
        } else {
          const tool = toolKeyFromFunctionName(call.name);
          this.emit('functionCall', tool ?? call.name);
          try {
            output = tool ? await searchByTool(tool, query, 5) : `Unknown tool: ${call.name}`;
          } catch (err: any) {
            output = `Search failed: ${err.message}`;
          }
        }

        this.session?.sendToolResponse({
          functionResponses: [{ id: call.id, name: call.name, response: { output: output || '(no results)' } }],
        });
      }
    }
  }
}
