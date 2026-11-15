/** The owner's memory provider preview switch (`/api/memory/provider-preview`).
 *
 *  Shaped like the Shared Crew switch (`sharedCrewPreviewSetting.ts`): the stored
 *  choice applies on the next gateway start. `active` is what this gateway runs, so
 *  every memory provider surface (the Settings picker, the sheets an app opens)
 *  reads it through `useMemoryProviderPreviewActive`. A refusal or an older gateway
 *  without the route reads as off. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'

export const memoryProviderPreviewKey = ['memoryProvider', 'preview'] as const

function isRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return status === 403 || status === 404
}

export function useMemoryProviderPreviewSetting({ poll = false }: { poll?: boolean } = {}) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: memoryProviderPreviewKey,
    queryFn: () => api.memoryProviderPreview(),
    retry: false,
    refetchInterval: poll ? 1000 : false,
  })
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => api.memoryProviderSetPreview(enabled),
    onSuccess: data => { qc.setQueryData(memoryProviderPreviewKey, data) },
  })
  return {
    setting: query.data ?? null,
    settled: query.isSuccess || query.isError,
    visible: !!query.data || (query.isError && !isRefusal(query.error)),
    loadError: !poll && query.isError && !isRefusal(query.error),
    set: (enabled: boolean) => mutation.mutate(enabled),
    saving: mutation.isPending,
    saveFailed: mutation.isError,
  }
}

/** Whether this gateway runs the memory provider preview; `false` until it answers. */
export function useMemoryProviderPreviewActive(): boolean {
  return !!useMemoryProviderPreviewSetting().setting?.active
}
