import React from 'react';
import { ExternalLink, LogIn, Search } from 'lucide-react';
import { Link } from '../../lib/router';
import { Logo } from '../../components/ui';

function SignInMenu() {
  return (
    <Link
      to="/login"
      className="inline-flex h-10 items-center gap-2 rounded-xl bg-ink px-3.5 text-sm font-semibold text-white hover:bg-ink-soft"
    >
      <LogIn className="size-4" aria-hidden />
      Sign in
    </Link>
  );
}

export function PublicShell({ children, poweredBy = false }: { children: React.ReactNode; poweredBy?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col bg-cream">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-2 px-4 sm:px-6">
          <Link to="/" aria-label="PrintFlow home">
            <Logo />
          </Link>
          <div className="flex items-center gap-1 sm:gap-2">
            <Link
              to="/track"
              className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-ink-soft hover:bg-cream-deep hover:text-ink"
              aria-label="Track an order"
            >
              <Search className="size-4 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Track an order</span>
            </Link>
            <SignInMenu />
          </div>
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted sm:px-6">
          <p>© {new Date().getFullYear()} PrintFlow</p>
          <nav className="flex gap-4" aria-label="Staff">
            <Link to="/login" className="hover:text-ink">Sign in</Link>
          </nav>
        </div>
        {poweredBy && (
          <div className="border-t border-line">
            <div className="mx-auto flex max-w-5xl flex-col items-center justify-center gap-x-2 gap-y-1 px-4 py-4 text-center text-sm text-muted sm:flex-row sm:px-6">
              <p className="inline-flex items-center gap-1.5">
                <img src="/muqore-logo.png" alt="" width={20} height={20} className="size-5 shrink-0 mix-blend-multiply" />
                <span>
                  Powered by <span className="font-semibold text-ink">MuQore Innovation</span>
                </span>
              </p>
              <span className="hidden sm:inline" aria-hidden>
                ·
              </span>
              <a
                href="https://www.muqoreinnovations.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-6 items-center gap-1 rounded font-semibold text-gold-ink underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-ink"
              >
                www.muqoreinnovations.com
                <ExternalLink className="size-3.5" aria-hidden />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
