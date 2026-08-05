export interface LanguageOption {
  code: string;
  label: string;
}

/**
 * Locales offered in the UI dropdown. All are chirp_3 streaming-supported.
 * Canadian English (en-CA) was considered but dropped — chirp_3 has no
 * dedicated code for it, only en-US/en-GB/etc. Arabic (Morocco) is chirp_3
 * "Preview" quality, not GA, so expect it to be less accurate than the rest.
 */
export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'fr-FR', label: 'French (France)' },
  { code: 'fr-CA', label: 'French (Quebec)' },
  { code: 'ar-MA', label: 'Arabic (Morocco)' },
];
