import { render, screen } from '@testing-library/react';

import StatusBadge, { type StatusBadgeVariant } from './StatusBadge';

const VARIANTS: [StatusBadgeVariant, string][] = [
  ['neutral', '•'],
  ['info', 'i'],
  ['success', '✓'],
  ['warning', '!'],
  ['danger', '×'],
];

describe('StatusBadge', () => {
  it.each(VARIANTS)('renders visible text for the %s variant', (variant, marker) => {
    render(<StatusBadge variant={variant}>Order ready</StatusBadge>);

    const text = screen.getByText('Order ready');
    const badge = text.closest('[data-variant]');
    const semanticMarker = badge?.querySelector('[aria-hidden="true"]');
    expect(text).toBeVisible();
    expect(badge).toHaveAttribute('data-variant', variant);
    expect(semanticMarker).toHaveTextContent(marker);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
