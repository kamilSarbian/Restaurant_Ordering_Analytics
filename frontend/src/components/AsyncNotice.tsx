import type { ReactNode } from 'react';

export type AsyncNoticeTone = 'neutral' | 'error' | 'success';

interface AsyncNoticeProps {
  children: ReactNode;
  title: string;
  tone?: AsyncNoticeTone;
  role?: 'alert' | 'status';
}

export default function AsyncNotice({
  children,
  title,
  tone = 'neutral',
  role = tone === 'error' ? 'alert' : 'status',
}: AsyncNoticeProps) {
  return (
    <section
      className="async-notice"
      data-tone={tone}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : 'polite'}
    >
      <strong>{title}</strong>
      <div>{children}</div>
    </section>
  );
}
