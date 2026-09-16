import styles from './BrandMark.module.css';

export type BrandMarkSize = 16 | 24 | 32 | 48 | 96;

export interface BrandMarkProps {
  className?: string;
  label?: string;
  size?: BrandMarkSize;
}

/** Render the reusable Nordic hytte symbol as an accessible inline SVG. */
export default function BrandMark({ className, label, size = 32 }: BrandMarkProps) {
  const accessibleLabel = label?.trim() || undefined;
  const classNames = [styles.mark, className].filter(Boolean).join(' ');

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={accessibleLabel === undefined ? true : undefined}
      aria-label={accessibleLabel}
      className={classNames}
      fill="none"
      focusable="false"
      height={size}
      role={accessibleLabel === undefined ? undefined : 'img'}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      viewBox="0 0 48 48"
      width={size}
    >
      <path
        data-part="hytte"
        d="M6.5 23.5 24 8.5l7 6M35.5 18.25l6 5.25M11 19.75V39h26V19.75M31 14.5V10h4.5v8.25"
      />
      <path data-part="steam" d="M33.25 8.5c-5-2 5-4 0-6" />
    </svg>
  );
}
