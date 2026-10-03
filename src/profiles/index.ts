import type { ImageFormat } from '../protocol/images.js';

export interface ModelProfile {
  readonly model: string;
  readonly formats: readonly ImageFormat[];
  readonly encryption: 'dh-aes' | 'rsa-aes' | 'tls';
  readonly hardwareVerified: false;
}

export const modelProfiles: readonly ModelProfile[] = Object.freeze([
  ...['STU-300', 'STU-300B', 'STU-500'].map((model) =>
    Object.freeze({
      model,
      formats: Object.freeze(['mono'] as const),
      encryption: 'dh-aes' as const,
      hardwareVerified: false as const,
    }),
  ),
  ...['STU-520', 'STU-520A'].map((model) =>
    Object.freeze({
      model,
      formats: Object.freeze(['mono', 'rgb565'] as const),
      encryption: 'dh-aes' as const,
      hardwareVerified: false as const,
    }),
  ),
  ...['STU-430', 'STU-430V', 'STU-430G'].map((model) =>
    Object.freeze({
      model,
      formats: Object.freeze(['mono'] as const),
      encryption: 'rsa-aes' as const,
      hardwareVerified: false as const,
    }),
  ),
  ...['STU-530', 'STU-530V', 'STU-540'].map((model) =>
    Object.freeze({
      model,
      formats: Object.freeze(['mono', 'bgr24'] as const),
      encryption: 'rsa-aes' as const,
      hardwareVerified: false as const,
    }),
  ),
  Object.freeze({
    model: 'STU-541',
    formats: Object.freeze(['mono', 'bgr24'] as const),
    encryption: 'tls' as const,
    hardwareVerified: false as const,
  }),
]);

export function getModelProfile(model: string): ModelProfile | undefined {
  return modelProfiles.find((profile) => profile.model === model.trim().toUpperCase());
}
