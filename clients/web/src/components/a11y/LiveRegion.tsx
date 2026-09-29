"use client";

import { Announcer } from "./Announcer";
import { useMessaging } from "@/lib/messaging/MessagingProvider";

/** Connects the provider's latest announcement to the live region. Split from
 * Announcer so that component stays testable without a provider around it. */
export function LiveRegion() {
  const { announcement } = useMessaging();
  return <Announcer message={announcement} />;
}
