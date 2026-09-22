"use client";

import { useAutoBackup } from "@/lib/backup/useAutoBackup";

/** Mount point for the scheduled backup. Renders nothing; it exists because
 * the hook needs to live inside the session and messaging providers. */
export function AutoBackup() {
  useAutoBackup();
  return null;
}
