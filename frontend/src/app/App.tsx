import { ReactFlowProvider } from '@xyflow/react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { ConfirmHost } from '../components/ConfirmHost'
import { CacheDialog } from '../features/cache/CacheDialog'
import { Canvas } from '../features/canvas/Canvas'
import { ParamsDialog } from '../features/params/ParamsDialog'
import { Explorer } from '../features/explorer/Explorer'
import { TablePreview } from '../features/explorer/TablePreview'
import { NodePanel } from '../features/nodes/NodePanel'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { useUi } from '../lib/store'
import { TopBar } from './TopBar'

export function App() {
  const explorerOpen = useUi((s) => s.explorerOpen)
  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        <Group orientation="horizontal" className="min-h-0 flex-1">
          {explorerOpen && (
            <>
              <Panel id="explorer" defaultSize="18" minSize={220}>
                <Explorer />
              </Panel>
              <Separator className="w-px" />
            </>
          )}
          <Panel id="canvas" minSize={360}>
            <Canvas />
          </Panel>
          <Separator className="w-px" />
          <Panel id="node" defaultSize="42" minSize={440}>
            <NodePanel />
          </Panel>
        </Group>
        <ConfirmHost />
        <SettingsDialog />
        <CacheDialog />
        <ParamsDialog />
        <TablePreview />
        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{
            style: {
              background: '#151821',
              border: '1px solid #2c3140',
              color: '#e8eaf0',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
            },
          }}
        />
      </div>
    </ReactFlowProvider>
  )
}
