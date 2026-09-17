"use client";

import { AppShell } from "@/components/shell/AppShell";
import { Pane, PaneEmpty, PaneHeader } from "@/components/ui/Pane";

export default function StatusPage() {
  return (
    <AppShell detail={<PaneEmpty>Nothing to show yet.</PaneEmpty>}>
      <Pane>
        <PaneHeader title="Status" />
        <PaneEmpty>
          Status updates need the messaging service and R2 store-and-forward, which aren&apos;t
          built yet.
        </PaneEmpty>
      </Pane>
    </AppShell>
  );
}
