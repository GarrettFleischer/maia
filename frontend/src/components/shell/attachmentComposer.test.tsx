import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RouterConversation } from '@/components/shell/RouterConversation'

function Composer({
  stageAttachments,
}: {
  stageAttachments: (files: readonly File[]) => Promise<void>
}) {
  const [draft, setDraft] = useState('See the file')
  return (
    <RouterConversation
      messages={[
        {
          message_id: 'm-1',
          role: 'owner',
          text: 'Sent',
          attachments: [
            {
              attachment_id: 'att-1',
              safe_name: 'note.txt',
              media_type: 'text/plain',
              byte_size: 5,
            },
          ],
        },
      ]}
      transcriptState={{ kind: 'ready' }}
      admission={{ kind: 'ready' }}
      operation={{ kind: 'idle' }}
      announcement={null}
      draft={draft}
      notice={{ kind: 'idle' }}
      disabled={false}
      canAttach
      stageAttachments={stageAttachments}
      onDraftChange={setDraft}
      onRetryTranscript={() => undefined}
      onAnnouncementAcknowledged={() => undefined}
      onSubmit={() => undefined}
    />
  )
}

describe('composer attachments', () => {
  it('shows a removable chip and keeps markup out of the picker', async () => {
    const user = userEvent.setup()
    const stageAttachments = vi.fn(async () => undefined)
    render(<Composer stageAttachments={stageAttachments} />)
    expect(screen.getByText('note.txt')).toBeVisible()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const input = screen.getByLabelText('Attach')
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/gif,image/webp,text/plain,application/pdf')
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await user.upload(input, file)
    expect(screen.getByRole('button', { name: 'Remove note.txt' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Remove note.txt' }))
    expect(screen.queryByRole('button', { name: 'Remove note.txt' })).not.toBeInTheDocument()
    await user.upload(input, file)
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(stageAttachments).toHaveBeenCalledWith([expect.any(File)])
  })
})
