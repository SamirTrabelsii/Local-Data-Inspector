import { ReactFlowProvider } from '@xyflow/react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Toaster } from 'sonner'
import { ConfirmHost } from '../components/ConfirmHost'
import { Canvas } from '../features/canvas/Canvas'
import { NodePanel } from '../features/nodes/NodePanel'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { TopBar } from './TopBar'

export function App() {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel minSize={360}>
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
        </Panel>
        <Separator className="w-px" />
        <Panel defaultSize="46" minSize={440}>
          <NodePanel />
        </Panel>
      </Group>
      <ConfirmHost />
      <SettingsDialog />
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
  )
}
