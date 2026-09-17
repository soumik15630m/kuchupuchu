"use client";

import { useEffect, useState } from "react";

import { displayName, loadContacts } from "../contacts";
import { getGroup, isGroupId, type Group } from "../groups";
import type { ChatTarget } from "./client";

export interface ResolvedChat {
  target: ChatTarget | null;
  chatId: string;
  title: string;
  subtitle: string;
  group: Group | null;
  /** Everyone who receives a message here, for media upload audience. */
  audience: string[];
}

/** Resolves a chat id — an email for a 1:1, or a `group-` id — into the target
 * the messaging client sends to. Returns `target: null` for a group this device
 * does not know yet, which is how a deleted or never-received group reads. */
export function useChatTarget(chatId: string, revision: number): ResolvedChat {
  const [resolved, setResolved] = useState<ResolvedChat>({
    target: null,
    chatId,
    title: chatId,
    subtitle: "",
    group: null,
    audience: [],
  });

  useEffect(() => {
    if (isGroupId(chatId)) {
      const group = getGroup(chatId);
      setResolved({
        target: group ? { kind: "group", group } : null,
        chatId,
        title: group?.name ?? "Group",
        subtitle: group ? `${group.members.length} members` : "Group not found",
        group,
        audience: group?.members ?? [],
      });
      return;
    }

    const contacts = loadContacts();
    setResolved({
      target: { kind: "direct", email: chatId },
      chatId,
      title: displayName(chatId, contacts),
      subtitle: chatId,
      group: null,
      audience: [chatId],
    });
  }, [chatId, revision]);

  return resolved;
}
