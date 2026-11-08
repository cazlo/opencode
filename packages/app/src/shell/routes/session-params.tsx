import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { useParams } from "@solidjs/router"

type SessionRouteParamsContextValue = {
  readonly paneId: Accessor<string | undefined>
  readonly serverKey: Accessor<string | undefined>
  readonly id: Accessor<string | undefined>
  readonly draftId: Accessor<string | undefined>
  readonly focused: Accessor<boolean>
  readonly split: Accessor<boolean>
}

const SessionRouteParamsContext = createContext<SessionRouteParamsContextValue>()

export function SessionRouteParamsProvider(
  props: ParentProps<{
    paneId?: string
    serverKey?: string
    id?: string
    draftId?: string
    focused?: boolean
    split?: boolean
  }>,
) {
  const value: SessionRouteParamsContextValue = {
    paneId: () => props.paneId,
    serverKey: () => props.serverKey,
    id: () => props.id,
    draftId: () => props.draftId,
    focused: () => props.focused ?? true,
    split: () => props.split ?? false,
  }

  return <SessionRouteParamsContext.Provider value={value}>{props.children}</SessionRouteParamsContext.Provider>
}

export function useSessionRouteParams() {
  const override = useContext(SessionRouteParamsContext)
  const routerParams = useParams<{ serverKey?: string; id?: string; draftId?: string }>()

  return {
    get paneId() {
      return override ? override.paneId() : undefined
    },
    get serverKey() {
      return override ? override.serverKey() : routerParams.serverKey
    },
    get id() {
      return override ? override.id() : routerParams.id
    },
    get draftId() {
      if (override) return override.draftId()

      if (routerParams.draftId) return routerParams.draftId

      return new URLSearchParams(window.location.search).get("draftId") ?? undefined
    },
    get focused() {
      return override ? override.focused() : true
    },
    // True only when this pane renders beside others; a lone pane still has a paneId.
    get split() {
      return override ? override.split() : false
    },
  }
}
