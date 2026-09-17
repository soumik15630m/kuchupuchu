import type { DeviceIdentity } from "./signal-crypto";

export function loadIdentity(deviceId: string): Promise<DeviceIdentity | null>;
export function saveIdentity(deviceId: string, identity: DeviceIdentity): Promise<boolean>;
export function clearIdentity(deviceId: string): Promise<boolean>;
