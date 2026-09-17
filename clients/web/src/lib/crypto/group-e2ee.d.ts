import type { GroupKeyProvider } from "./key-provider";
import type { DeviceIdentity, PrekeyBundle, PublishPayload } from "./signal-crypto";
import type { RotationParticipant } from "./rotation";

export const DATA_TOPIC: string;

export interface IdentityOnFile {
  identity_key: string;
  identity_dh_key: { public_key: string; signature: string };
}

export interface GroupE2EEDeps {
  keyProvider: GroupKeyProvider;
  sendData: (payloadBytes: Uint8Array, targetIdentities?: string[]) => void;
  fetchBundle: (email: string, deviceId: string) => Promise<PrekeyBundle>;
  fetchIdentity: (email: string, deviceId: string) => Promise<IdentityOnFile>;
  emailForIdentity: (deviceIdentity: string) => string;
  onFingerprintChanged?: (fp: string, generation: number) => void;
  onIdentitySafetyNumber?: (peerIdentity: string, safetyNumber: string) => void;
  onIdentityChanged?: (identity: DeviceIdentity) => void | Promise<void>;
  onRejoinNeeded?: () => void;
  onPartialRotationFailure?: (unreachedPeerIdentities: string[]) => void;
  bundleFetchRetryDelaysMs?: number[];
}

export class GroupE2EE {
  constructor(deps: GroupE2EEDeps);
  identity: DeviceIdentity | null;
  myDeviceIdentity: string | null;
  generation: number;
  currentRoomKey: Uint8Array | null;
  initialize(myDeviceIdentity: string, existingIdentity?: DeviceIdentity | null): Promise<PublishPayload>;
  topUpOneTimePrekeysIfLow(remoteUnusedCount: number): Promise<PublishPayload | null>;
  onMembershipChanged(participants: RotationParticipant[]): Promise<void>;
  handleDataMessage(payloadBytes: Uint8Array, fromIdentity: string): Promise<void>;
}
