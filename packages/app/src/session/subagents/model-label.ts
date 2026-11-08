import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { createMemo, type Accessor } from "solid-js"
import { composerModelLabelKey, composerModelLabels, composerProviderName } from "@/composer/model-label"
import { useProviders } from "@/providers/catalog/providers"
import { useData } from "@/runtime/server/current"
import { useWorkspaceLocation } from "@/workspaces/location"
import { compactionThreshold } from "@opencode/client/solid"
import { subagentContextPercent } from "./tree"

// The model a subagent ran with, named as the composer names it: the session's own, else its latest reply's.
export function createSubagentModelLabel(input: {
  info: Accessor<SessionInfo | undefined>
  messages: Accessor<readonly SessionMessageInfo[]>
}) {
  const providers = useProviders(() => input.info()?.location.directory)

  const modelLabels = createMemo(() =>
    composerModelLabels(
      providers.all(),
      providers.connected().map((provider) => provider.id),
    ),
  )

  return () => {
    const ref = input.info()?.model ?? input.messages().findLast((message) => message.type === "assistant")?.model

    if (!ref) return
    const label = modelLabels().get(composerModelLabelKey(ref.providerID, ref.id))

    return {
      provider: label
        ? label.provider
        : composerProviderName(
            ref.providerID,
            providers.all(),
            providers.connected().map((provider) => provider.id),
          ),
      name: label?.model ?? ref.id,
      variant: ref.variant,
    }
  }
}

// The share of its compaction threshold a subagent fills now, matching its row in the Subagents list.
export function createSubagentContextPercent(input: {
  info: Accessor<SessionInfo | undefined>
  messages: Accessor<readonly SessionMessageInfo[]>
}) {
  const data = useData()
  const workspaceLocation = useWorkspaceLocation()

  const thresholdFor = (ref: { readonly providerID: string; readonly id: string }) => {
    const dir = input.info()?.location.directory || workspaceLocation().directory
    const models = data.location.model.list(dir ? { directory: dir } : undefined)

    if (!models) return undefined

    const model =
      models.findLast(
        (item) => item.providerID === ref.providerID && item.id === ref.id && item.status !== "deprecated",
      ) ?? models.findLast((item) => item.providerID === ref.providerID && item.id === ref.id)

    return compactionThreshold(model?.limit)
  }

  return createMemo(() => subagentContextPercent(input.info(), input.messages(), thresholdFor))
}
