import { render, screen } from '@testing-library/react';

import Notice, { type NoticeRole, type NoticeVariant } from './Notice';

const VARIANT_SEMANTICS: [NoticeVariant, NoticeRole, 'assertive' | 'polite', string][] =
  [
    ['info', 'status', 'polite', 'i'],
    ['success', 'status', 'polite', '✓'],
    ['warning', 'status', 'polite', '!'],
    ['danger', 'alert', 'assertive', '×'],
  ];

describe('Notice', () => {
  it.each(VARIANT_SEMANTICS)(
    'renders the %s variant with %s semantics',
    (variant, role, live, marker) => {
      render(
        <Notice title="Order update" variant={variant}>
          The order state changed.
        </Notice>,
      );

      const notice = screen.getByRole(role);
      expect(notice).toHaveAttribute('data-variant', variant);
      expect(notice).toHaveAttribute('aria-live', live);
      expect(notice).toHaveAttribute('aria-atomic', 'true');
      expect(notice.querySelector('[aria-hidden="true"]')).toHaveTextContent(marker);
      expect(screen.getByText('Order update').tagName).toBe('STRONG');
      expect(screen.getByText('The order state changed.')).toBeVisible();
    },
  );

  it('supports a body-only notice and an explicit semantic role', () => {
    render(
      <Notice role="alert" variant="warning">
        Check the table number.
      </Notice>,
    );

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText('Check the table number.')).toBeVisible();
    expect(screen.queryByText('Order update')).not.toBeInTheDocument();
  });
});
