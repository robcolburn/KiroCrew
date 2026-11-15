import { useEffect } from 'react'
import { MemoryProviderSheetHost } from './MemoryProviderSheet'
import { MemoryMoveSheetHost } from './MemoryMoveSheet'
import { MemoryBenchSheetHost } from './MemoryBenchSheet'
import { setMemoryProviderPreviewOff } from '../app-sdk/memoryProviderPreview'
import { useMemoryProviderPreviewSetting } from '../pages/settings/memoryProviderPreviewSetting'

/** The sheets an app's memory verbs open, mounted only while this gateway runs the
 *  memory provider preview. Off, nothing mounts and the verbs answer `'not_enabled'`. */
export default function MemoryProviderSheetHosts() {
  const preview = useMemoryProviderPreviewSetting()
  const active = !!preview.setting?.active
  const off = preview.settled && !active
  useEffect(() => {
    setMemoryProviderPreviewOff(off)
  }, [off])
  if (!active) return null
  return (
    <>
      {/* The sheet an app's `requestMemoryProviderChange()` opens; only the owner's
          press there switches which memory Crew uses. */}
      <MemoryProviderSheetHost />
      {/* The sheet an app's `requestMemoryMove()` opens; only the owner's press there
          runs a move. */}
      <MemoryMoveSheetHost />
      <MemoryBenchSheetHost />
    </>
  )
}
