import { useConfirm } from '../lib/store'
import { Button, Dialog } from './ui'

export function ConfirmHost() {
  const request = useConfirm((s) => s.request)
  const close = (ok: boolean) => {
    request?.resolve(ok)
    useConfirm.setState({ request: null })
  }
  return (
    <Dialog
      open={!!request}
      onClose={() => close(false)}
      title={request?.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant={request?.tone === 'danger' ? 'secondary' : 'primary'}
            className={request?.tone === 'danger' ? '!text-err' : undefined}
            onClick={() => close(true)}
            autoFocus
          >
            {request?.confirmLabel}
          </Button>
        </>
      }
    >
      {request?.body}
    </Dialog>
  )
}
