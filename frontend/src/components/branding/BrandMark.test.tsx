import { render, screen } from '@testing-library/react';

import BrandMark, { type BrandMarkSize } from './BrandMark';

const SUPPORTED_SIZES: BrandMarkSize[] = [16, 24, 32, 48, 96];

describe('BrandMark', () => {
  it('renders the canonical logo emblem as a decorative image by default', () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector('span');
    const image = container.querySelector('img');

    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveStyle({ height: '32px', width: '32px' });
    expect(image).toHaveAttribute('src', '/images/brand/logo/nordic-hearth-logo.png');
    expect(image).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('exposes an accessible image only when given a non-empty label', () => {
    const { rerender } = render(
      <BrandMark className="brand-slot" label="Nordic Hearth" size={48} />,
    );

    const labelledMark = screen.getByRole('img', { name: 'Nordic Hearth' });
    expect(labelledMark).toHaveClass('brand-slot');
    expect(labelledMark).toHaveStyle({ height: '48px', width: '48px' });
    expect(labelledMark).not.toHaveAttribute('aria-hidden');

    rerender(<BrandMark label="   " />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each(SUPPORTED_SIZES)('supports the %i px contract', (size) => {
    const { container } = render(<BrandMark size={size} />);
    const mark = container.querySelector('span');

    expect(mark).toHaveStyle({ height: `${size}px`, width: `${size}px` });
  });
});
