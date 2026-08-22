import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: () => (
    <section className="max-w-2xl">
      <p className="mb-4 text-sm font-medium tracking-widest text-stone-500 uppercase">Reader</p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
        Your feeds will live here.
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-stone-600">
        This placeholder will become a timeline of new articles from your RSS subscriptions.
      </p>
    </section>
  ),
});
