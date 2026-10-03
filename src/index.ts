export { StuDevice } from './device/index.js';
export type { StuDeviceOptions, ProtocolAccess, ModeService, DeviceState } from './device/index.js';
export { StuError } from './errors.js';
export type { StuErrorCode, ErrorDetails } from './errors.js';
export type * from './types.js';
export type {
  DeviceInformation,
  Capability,
  DeviceStatus,
  InkStyle,
  InkThreshold,
} from './protocol/codecs.js';
export type { OperationMode, RomSlot, RomDescriptor, RomImageHash } from './protocol/modes.js';
export type { ImageFormat, RgbaImage, EncodedImage, ImageOptions } from './protocol/images.js';
export type { CryptoProvider, EncryptionIo, EncryptionSession } from './crypto/contracts.js';
export { Recording } from './device/recording.js';
export type { CaptureOptions, RecordingState } from './device/recording.js';
export type { BacklightSetting } from './device/settings.js';
export type { UploadOptions } from './device/display.js';
export type { StartupImage } from './device/startup.js';
export type {
  StoredImageSlot,
  StoredImageReference,
  StoreImageOptions,
  StoredImageDisplayOptions,
} from './device/rom.js';
export type { EventStreamOptions } from './device/stream.js';
export { Signature, Recorder, transformPoint } from './capture/index.js';
export type {
  CaptureDimensions,
  CaptureMetadata,
  RecordingJSON,
  LossIndicator,
  SvgOptions,
  TransformOptions,
  TimelinePoint,
  ReplayOptions,
} from './capture/index.js';
export { modelProfiles, getModelProfile } from './profiles/index.js';
export type { ModelProfile } from './profiles/index.js';
