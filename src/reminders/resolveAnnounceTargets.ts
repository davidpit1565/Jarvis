import type { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";

/** The literal value meaning "every currently-connected device" for a reminder's `targetDevice` field. */
export const ANNOUNCE_TARGET_ALL = "all";

/**
 * Resolves an `announce` reminder's `targetDevice` into the actual,
 * currently-connected device id(s) to speak through right now — reusing
 * `DeviceRegistry`/`DeviceConnectionManager`'s existing "which devices are
 * known" / "which are currently connected" model rather than inventing a
 * second one (see CLAUDE.md wishlist #19's device-targeting requirement).
 *
 * - `targetDevice === "all"` -> every currently-connected device.
 * - a specific device id -> that device, only if it's currently connected
 *   (a reminder can't be spoken through a device that's off/asleep —
 *   that's exactly the "device must be powered on" case the spec calls
 *   out, handled by the caller falling back to the existing push/Telegram
 *   path when this returns no targets).
 * - `null`/unset ("wherever available") -> the primary device if it's
 *   connected, else any one currently-connected device, else nothing.
 *
 * Returns an empty array when nothing reachable is found — the caller is
 * expected to fall back to the pre-existing push/Telegram notification
 * path in that case, never to silently drop the reminder.
 */
export function resolveAnnounceTargets(
  targetDevice: string | null,
  deviceRegistry: DeviceRegistry,
  deviceConnectionManager: DeviceConnectionManager
): string[] {
  if (targetDevice === ANNOUNCE_TARGET_ALL) {
    return deviceConnectionManager.listConnectedDeviceIds();
  }

  if (targetDevice) {
    return deviceConnectionManager.hasConnection(targetDevice) ? [targetDevice] : [];
  }

  const primary = deviceRegistry.getPrimaryDevice();
  if (primary && deviceConnectionManager.hasConnection(primary.id)) {
    return [primary.id];
  }

  const anyConnected = deviceConnectionManager.listConnectedDeviceIds();
  return anyConnected.length > 0 ? [anyConnected[0]!] : [];
}
