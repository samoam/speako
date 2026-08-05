import { v2 } from '@google-cloud/speech';
import { config } from '../config';
import { buildAdaptationConfig } from '../speechAdaptation';

// Regional v2 resources (recognizers) must be addressed via a matching regional
// endpoint — the default global endpoint rejects them with a somewhat opaque
// "Invalid resource field value" INVALID_ARGUMENT error.
export const speechClient = new v2.SpeechClient(
  config.speechLocation === 'global' ? {} : { apiEndpoint: `${config.speechLocation}-speech.googleapis.com` }
);

export function buildRecognizerPath(): string {
  return `projects/${config.gcpProjectId}/locations/${config.speechLocation}/recognizers/_`;
}

/** First message sent on every streaming call: config only, no audio. */
export function buildStreamingConfigRequest(channelCount: number, languageCodes: string[] = config.languageCodes) {
  return {
    recognizer: buildRecognizerPath(),
    streamingConfig: {
      config: {
        explicitDecodingConfig: {
          encoding: 'LINEAR16' as const,
          sampleRateHertz: config.sampleRate,
          audioChannelCount: channelCount,
        },
        model: config.speechModel,
        languageCodes,
        adaptation: buildAdaptationConfig(),
        features: {
          enableAutomaticPunctuation: true,
          ...(channelCount > 1
            ? { multiChannelMode: 'SEPARATE_RECOGNITION_PER_CHANNEL' as const }
            : {}),
        },
      },
      streamingFeatures: {
        interimResults: true,
      },
    },
  };
}
