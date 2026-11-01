import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { createMemo, type Accessor } from "solid-js"
import { composerModelLabelKey, composerModelLabels, composerProviderName } from "@/composer/model-label"
import { useProviders } from "@/providers/catalog/providers"

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
