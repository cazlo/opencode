import type { SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"

export function selectSessionUserMessages(messages: SessionMessageInfo[]) {
  return messages.filter((message): message is SessionMessageUser => message.type === "user")
}

export function selectVisibleSessionUserMessages(messages: SessionMessageUser[], revertMessageID?: string) {
  if (!revertMessageID) return messages

  return messages.filter((message) => message.id < revertMessageID)
}

export function hasVisibleSessionMessages(messages: readonly SessionMessageInfo[], revertMessageID?: string) {
  if (messages.length === 0) return false

  if (!revertMessageID) return true

  return messages.some((message) => message.id < revertMessageID)
}
