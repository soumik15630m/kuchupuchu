"use client";

import { useAutoBackup } from "@/lib/backup/useAutoBackup";
import { useRestoreDrill } from "@/lib/backup/useRestoreDrill";

/** Mount point for the scheduled backup. Renders nothing; it exists because
 * the hook needs to live inside the session and messaging providers. */
export function AutoBackup() {
  useAutoBackup();
  // Mounted beside the backup rather than inside it: the drill checks the
  // archive that is already on the server, so it must run even for a member
  // who has scheduled backups turned off.
  useRestoreDrill();
  return null;
}
