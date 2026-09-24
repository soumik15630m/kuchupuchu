"use client";

import { ChatListPane } from "@/components/chat/ChatListPane";
import { AppShell } from "@/components/shell/AppShell";
import { PaneEmpty } from "@/components/ui/Pane";

export default function ChatsPage() {
  return (
    <AppShell detail={<PaneEmpty>Pick a chat to start reading.</PaneEmpty>}>
      <ChatListPane />
    </AppShell>
  );
}
