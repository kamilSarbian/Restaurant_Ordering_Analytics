import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { vi } from 'vitest';

import CustomerDemoDialog from './CustomerDemoDialog';

describe('CustomerDemoDialog', () => {
  it('announces the shared identity and traps focus in both directions', async () => {
    const user = userEvent.setup();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    const triggerRef = createRef<HTMLButtonElement>();
    triggerRef.current = trigger;

    const { unmount } = render(
      <CustomerDemoDialog
        busy={false}
        feedback={null}
        onClose={vi.fn()}
        onStartDemo={vi.fn()}
        returnFocusRef={triggerRef}
      />,
    );

    const start = screen.getByRole('button', { name: 'Try customer demo' });
    const close = screen.getByRole('button', { name: 'Close login options' });
    expect(await screen.findByRole('dialog')).toHaveAccessibleDescription(
      'Customer demo uses a shared synthetic identity and shared order history. It is not a private visitor account.',
    );
    expect(start).toHaveFocus();

    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Continue as guest' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('closes on Escape and exposes safe feedback', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CustomerDemoDialog
        busy={false}
        feedback="The customer demo is unavailable right now."
        onClose={onClose}
        onStartDemo={vi.fn()}
        returnFocusRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The customer demo is unavailable right now.',
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
