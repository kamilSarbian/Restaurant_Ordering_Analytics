import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { vi } from 'vitest';

import Button, { type ButtonSize, type ButtonVariant } from './Button';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'accent', 'danger', 'ghost'];
const SIZES: ButtonSize[] = ['sm', 'md', 'lg'];

describe('Button', () => {
  it.each(VARIANTS)('renders the %s variant', (variant) => {
    render(<Button variant={variant}>Continue</Button>);

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveAttribute(
      'data-variant',
      variant,
    );
  });

  it.each(SIZES)('renders the %s size', (size) => {
    render(<Button size={size}>Continue</Button>);

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveAttribute(
      'data-size',
      size,
    );
  });

  it('forwards native button behavior, attributes, and refs', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    const { rerender } = render(
      <Button ref={ref} name="checkout" onClick={onClick} value="continue">
        Continue
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('name', 'checkout');
    expect(button).toHaveValue('continue');
    expect(ref.current).toBe(button);
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();

    rerender(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button', { name: 'Submit' })).toHaveAttribute(
      'type',
      'submit',
    );
  });

  it('uses native disabled behavior to block interaction', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Continue
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('preserves content and blocks duplicate clicks while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Saving order" onClick={onClick}>
        Place order
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Saving order' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('data-loading', 'true');
    expect(screen.getByText('Place order')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
