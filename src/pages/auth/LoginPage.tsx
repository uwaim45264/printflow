import React, { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { ServiceError } from '../../services';
import type { Role } from '../../shared/types';
import { Link, navigate, useDocumentTitle, useLocation } from '../../lib/router';
import { Alert, Button, Field, Input, Logo, PasswordInput, Spinner } from '../../components/ui';

const homeFor = (role: Role) => (role === 'super_admin' ? '/admin' : '/shop');

/** One sign-in page for everyone: Super Admins go to /admin, shop owners to /shop. */
export function LoginPage() {
  useDocumentTitle('Sign in');
  const { user, loading, login } = useAuth();
  const { query } = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = query.get('next');
  // Go back to the page that asked for sign-in, but only inside the signed-in user's own area.
  const targetFor = (role: Role) => {
    const home = homeFor(role);
    return next && !next.startsWith('//') && (next === home || next.startsWith(home + '/')) ? next : home;
  };

  useEffect(() => {
    if (!loading && user) navigate(targetFor(user.role), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setSubmitting(true);
    try {
      const u = await login('any', username.trim(), password);
      navigate(targetFor(u.role), { replace: true });
    } catch (err) {
      setError(err instanceof ServiceError ? err.message : 'Sign in failed. Please try again.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.1fr]">
      <div className="flex flex-col bg-surface px-6 py-8 sm:px-12">
        <Link to="/" className="inline-flex w-fit items-center gap-2 text-sm font-medium text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden /> Back to home
        </Link>

        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-12">
          <Logo />
          <h1 className="mt-10 text-3xl font-extrabold tracking-tight text-ink">Sign in</h1>
          <p className="mt-2 text-[15px] text-muted">For shop owners and the platform administrator.</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Username">
              {(p) => (
                <Input
                  {...p}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                />
              )}
            </Field>
            <Field label="Password">
              {(p) => <PasswordInput {...p} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Button type="submit" size="lg" className="w-full" loading={submitting}>
              Sign in
            </Button>
          </form>

          <p className="mt-8 text-sm text-muted">Shop owner and forgot your password? Ask the platform administrator to reset it for you.</p>
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-cream-deep lg:block">
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-gold/40 blur-3xl" aria-hidden />
        <div className="absolute -bottom-32 left-10 size-96 rounded-full bg-orange/30 blur-3xl" aria-hidden />
        <div className="relative flex h-full flex-col justify-center px-16">
          <p className="max-w-md text-[34px] font-extrabold leading-tight tracking-tight text-ink" style={{ textWrap: 'balance' }}>
            Your print queue, straight from your customers’ phones.
          </p>
          <ul className="mt-8 max-w-md space-y-3 text-[15px] text-ink-soft">
            {[
              'Customers scan your QR code and upload files',
              'Download, print and update order status',
              'Shops, owner logins and activity in one place',
            ].map((t) => (
              <li key={t} className="flex items-start gap-3">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-gold-ink" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
