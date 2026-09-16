import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { useAuth, type AuthActionOutcome } from './AuthContext';
import { resolveAuthDestination } from './authNavigation';
import styles from './AuthPage.module.css';

interface RegisterErrors {
  confirmPassword?: string;
  email?: string;
  password?: string;
}

function AuthBrand() {
  return (
    <div className={styles.brand}>
      <BrandMark className={styles.brandMark} size={24} />
      <span>Nordic Hearth</span>
    </div>
  );
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function outcomeMessage(outcome: AuthActionOutcome): string {
  switch (outcome.kind) {
    case 'account-exists':
      return 'An account with this email already exists. Sign in instead.';
    case 'validation':
      return 'The registration details were not accepted. Review them and try again.';
    case 'rate-limited':
      return 'Too many registration attempts were made. Try again later.';
    case 'service-unavailable':
    case 'session-unavailable':
      return 'Account creation is temporarily unavailable. Try again.';
    case 'timeout':
      return 'The registration request timed out. Check your connection and try again.';
    case 'network':
      return 'We could not create your account. Check your connection and try again.';
    case 'invalid-response':
      return 'We could not complete account creation. Try again later.';
    case 'aborted':
      return 'The registration request was cancelled.';
    case 'invalid-credentials':
      return 'The new account could not be validated. Review the details and try again.';
    case 'authenticated':
      return '';
  }
}

/** Register one role-neutral customer through the canonical authentication context. */
export default function RegisterPage() {
  const { logout, phase, register, retrySession, user } = useAuth();
  const [searchParams] = useSearchParams();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const restoreSubmitFocusRef = useRef(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<RegisterErrors>({});
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmationVisible, setConfirmationVisible] = useState(false);

  useEffect(() => {
    if (retrySeconds <= 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setRetrySeconds((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [retrySeconds]);

  useEffect(() => {
    if (submitting || !restoreSubmitFocusRef.current) {
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement !== null && activeElement !== document.body) {
      restoreSubmitFocusRef.current = false;
      return;
    }
    if (retrySeconds > 0) {
      return;
    }

    submitButtonRef.current?.focus();
    restoreSubmitFocusRef.current = false;
  }, [retrySeconds, submitting]);

  if (phase === 'authenticated' && user !== null) {
    return (
      <Navigate
        to={resolveAuthDestination(searchParams.get('next'), user.role)}
        replace
      />
    );
  }

  if (phase === 'checking-session') {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} role="status" aria-live="polite">
          <AuthBrand />
          <div className={styles.heading}>
            <p className="eyebrow">Account access</p>
            <h1>Checking your session</h1>
          </div>
          <p className={styles.intro}>Please wait before creating another account.</p>
        </section>
      </main>
    );
  }

  if (phase === 'temporarily-unavailable') {
    return (
      <main className={styles.screen}>
        <section className={styles.panel} role="alert" aria-live="assertive">
          <AuthBrand />
          <div className={styles.heading}>
            <p className="eyebrow">Account access</p>
            <h1>Session validation is unavailable</h1>
          </div>
          <p className={styles.intro}>
            Your saved session remains available for another validation attempt.
          </p>
          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void retrySession()}
            >
              Retry validation
            </Button>
            <Button type="button" variant="ghost" onClick={logout}>
              Clear session
            </Button>
          </div>
        </section>
      </main>
    );
  }

  const validate = (): RegisterErrors => {
    const nextErrors: RegisterErrors = {};
    if (email.trim() === '') {
      nextErrors.email = 'Email is required.';
    } else if (!isPlausibleEmail(email)) {
      nextErrors.email = 'Enter a valid email address.';
    }

    const passwordLength = Array.from(password).length;
    if (passwordLength < 15 || passwordLength > 128) {
      nextErrors.password = 'Password must contain 15 to 128 characters.';
    }
    if (confirmPassword === '') {
      nextErrors.confirmPassword = 'Confirm your password.';
    } else if (confirmPassword !== password) {
      nextErrors.confirmPassword = 'Passwords must match exactly.';
    }
    return nextErrors;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || retrySeconds > 0) {
      return;
    }

    const nextErrors = validate();
    setErrors(nextErrors);
    setFeedback('');
    if (nextErrors.email !== undefined) {
      emailRef.current?.focus();
      return;
    }
    if (nextErrors.password !== undefined) {
      passwordRef.current?.focus();
      return;
    }
    if (nextErrors.confirmPassword !== undefined) {
      confirmPasswordRef.current?.focus();
      return;
    }

    restoreSubmitFocusRef.current = document.activeElement === submitButtonRef.current;
    setSubmitting(true);
    setFeedback('Creating your account and validating your session…');
    const outcome = await register(email, password);
    setSubmitting(false);
    if (outcome.kind === 'authenticated') {
      setPassword('');
      setConfirmPassword('');
      return;
    }
    if (outcome.kind === 'rate-limited') {
      setRetrySeconds(outcome.retryAfterSeconds ?? 0);
    }
    setFeedback(outcomeMessage(outcome));
  };

  const retryLabel =
    retrySeconds > 0 ? `Try again in ${retrySeconds} seconds` : 'Create account';
  const passwordDescription =
    errors.password === undefined
      ? 'register-password-guidance'
      : 'register-password-guidance register-password-error';
  const next = searchParams.get('next');
  const loginDestination =
    next === null ? '/login' : `/login?next=${encodeURIComponent(next)}`;

  return (
    <main className={styles.screen}>
      <section className={styles.panel} aria-labelledby="register-heading">
        <AuthBrand />
        <div className={styles.heading}>
          <p className="eyebrow">Customer account</p>
          <h1 id="register-heading">Create account</h1>
        </div>
        <p className={styles.intro}>
          Create a customer account to keep your orders together.
        </p>
        <form
          aria-busy={submitting}
          className={styles.form}
          noValidate
          onSubmit={(event) => void handleSubmit(event)}
        >
          <div className={styles.field}>
            <label htmlFor="register-email">Email</label>
            <input
              ref={emailRef}
              id="register-email"
              type="email"
              autoComplete="email"
              value={email}
              aria-describedby={
                errors.email === undefined ? undefined : 'register-email-error'
              }
              aria-invalid={errors.email !== undefined}
              onChange={(event) => setEmail(event.target.value)}
            />
            <div className={styles.fieldMessage}>
              {errors.email !== undefined ? (
                <p id="register-email-error" className={styles.fieldError}>
                  {errors.email}
                </p>
              ) : null}
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor="register-password">Password</label>
            <div className={styles.passwordControl}>
              <input
                ref={passwordRef}
                id="register-password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                aria-describedby={passwordDescription}
                aria-invalid={errors.password !== undefined}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                aria-controls="register-password"
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                aria-pressed={passwordVisible}
                className={styles.passwordToggle}
                type="button"
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? 'Hide' : 'Show'}
              </button>
            </div>
            <p id="register-password-guidance" className={styles.guidance}>
              Use 15 to 128 characters. Spaces are preserved.
            </p>
            <div className={styles.fieldMessage}>
              {errors.password !== undefined ? (
                <p id="register-password-error" className={styles.fieldError}>
                  {errors.password}
                </p>
              ) : null}
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor="register-confirm-password">Confirm password</label>
            <div className={styles.passwordControl}>
              <input
                ref={confirmPasswordRef}
                id="register-confirm-password"
                type={confirmationVisible ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                aria-describedby={
                  errors.confirmPassword === undefined
                    ? undefined
                    : 'register-confirm-password-error'
                }
                aria-invalid={errors.confirmPassword !== undefined}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <button
                aria-controls="register-confirm-password"
                aria-label={
                  confirmationVisible
                    ? 'Hide password confirmation'
                    : 'Show password confirmation'
                }
                aria-pressed={confirmationVisible}
                className={styles.passwordToggle}
                type="button"
                onClick={() => setConfirmationVisible((visible) => !visible)}
              >
                {confirmationVisible ? 'Hide' : 'Show'}
              </button>
            </div>
            <div className={styles.fieldMessage}>
              {errors.confirmPassword !== undefined ? (
                <p id="register-confirm-password-error" className={styles.fieldError}>
                  {errors.confirmPassword}
                </p>
              ) : null}
            </div>
          </div>
          <Button
            ref={submitButtonRef}
            className={styles.submitButton}
            type="submit"
            disabled={retrySeconds > 0}
            loading={submitting}
            loadingLabel="Creating account"
            size="lg"
          >
            {retryLabel}
          </Button>
          <p className={styles.authSwitch}>
            Already have an account?{' '}
            <Link className={styles.inlineLink} to={loginDestination}>
              Sign in
            </Link>
          </p>
          <Link className={styles.backLink} to="/">
            ← Back to home
          </Link>
          <div className={styles.feedbackSlot}>
            {feedback !== '' ? (
              <Notice
                className={styles.feedbackNotice}
                role={feedback.startsWith('Creating') ? 'status' : 'alert'}
                variant={feedback.startsWith('Creating') ? 'info' : 'danger'}
              >
                {feedback}
              </Notice>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  );
}
