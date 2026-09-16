import { render, screen } from '@testing-library/react';

import BrandMark, { type BrandMarkSize } from './BrandMark';

const SUPPORTED_SIZES: BrandMarkSize[] = [16, 24, 32, 48, 96];

describe('BrandMark', () => {
  it('renders a safe, monochrome decorative SVG by default', () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector('svg');

    expect(mark).toHaveAttribute('aria-hidden', 'true');
    expect(mark).toHaveAttribute('focusable', 'false');
    expect(mark).toHaveAttribute('stroke', 'currentColor');
    expect(mark).toHaveAttribute('viewBox', '0 0 48 48');
    expect(mark).toHaveAttribute('width', '32');
    expect(mark).toHaveAttribute('height', '32');
    expect(mark?.querySelectorAll('path')).toHaveLength(2);
    expect(mark?.querySelector('[data-part="steam"]')).toBeInTheDocument();
    expect(
      mark?.querySelectorAll('script, image, use, text, foreignObject, linearGradient'),
    ).toHaveLength(0);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('exposes an accessible image only when given a non-empty label', () => {
    const { rerender } = render(
      <BrandMark className="brand-slot" label="Nordic Hearth" size={48} />,
    );

    const labelledMark = screen.getByRole('img', { name: 'Nordic Hearth' });
    expect(labelledMark).toHaveClass('brand-slot');
    expect(labelledMark).toHaveAttribute('width', '48');
    expect(labelledMark).not.toHaveAttribute('aria-hidden');

    rerender(<BrandMark label="   " />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each(SUPPORTED_SIZES)('supports the %i px contract', (size) => {
    const { container } = render(<BrandMark size={size} />);
    const mark = container.querySelector('svg');

    expect(mark).toHaveAttribute('width', String(size));
    expect(mark).toHaveAttribute('height', String(size));
  });
});
