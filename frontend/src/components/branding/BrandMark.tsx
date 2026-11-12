import styles from './BrandMark.module.css';

export type BrandMarkSize = 16 | 24 | 32 | 48 | 96;

export interface BrandMarkProps {
  className?: string;
  label?: string;
  size?: BrandMarkSize;
}

/** Render the official Nordic Hearth emblem cropped from the canonical logo. */
export default function BrandMark({ className, label, size = 32 }: BrandMarkProps) {
  const accessibleLabel = label?.trim() || undefined;
  const classNames = [styles.mark, className].filter(Boolean).join(' ');

  return (
    <span
      aria-hidden={accessibleLabel === undefined ? true : undefined}
      aria-label={accessibleLabel}
      className={classNames}
      role={accessibleLabel === undefined ? undefined : 'img'}
      style={{ height: size, width: size }}
    >
      <picture>
        <source
          srcSet="/images/brand/optimized/logo/nordic-hearth-logo-320w.webp"
          type="image/webp"
        />
        <img
          alt=""
          decoding="async"
          height="724"
          src="/images/brand/logo/nordic-hearth-logo.png"
          width="2172"
        />
      </picture>
    </span>
  );
}
