import { createRootRoute, Link, Outlet } from '@tanstack/react-router';

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-dvh bg-stone-50 text-stone-950">
      <header className="border-b border-stone-200 bg-stone-50/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Reader
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-1 text-sm">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              className="rounded-full px-3 py-2 text-stone-600 transition-colors hover:bg-stone-200/70 hover:text-stone-950"
              activeProps={{ className: 'bg-stone-200/70 text-stone-950' }}
            >
              Home
            </Link>
            <Link
              to="/about"
              className="rounded-full px-3 py-2 text-stone-600 transition-colors hover:bg-stone-200/70 hover:text-stone-950"
              activeProps={{ className: 'bg-stone-200/70 text-stone-950' }}
            >
              About
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-16 sm:px-8 sm:py-24">
        <Outlet />
      </main>
    </div>
  ),
});
