import type { ReactNode } from 'react';

import Notice, { type NoticeVariant } from './ui/Notice';

export type AsyncNoticeTone = 'neutral' | 'error' | 'success';

interface AsyncNoticeProps {
  children: ReactNode;
  title: string;
  tone?: AsyncNoticeTone;
  role?: 'alert' | 'status';
}

const NOTICE_VARIANTS: Record<AsyncNoticeTone, NoticeVariant> = {
  error: 'danger',
  neutral: 'info',
  success: 'success',
};

/** Preserve the legacy async notice API while delegating presentation to Notice. */
export default function AsyncNotice({
  children,
  title,
  tone = 'neutral',
  role = tone === 'error' ? 'alert' : 'status',
}: AsyncNoticeProps) {
  return (
    <Notice role={role} title={title} variant={NOTICE_VARIANTS[tone]}>
      {children}
    </Notice>
  );
}
