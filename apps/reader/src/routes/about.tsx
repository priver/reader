import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  component: () => (
    <section className="max-w-2xl">
      <p className="mb-4 text-sm font-medium tracking-widest text-stone-500 uppercase">About</p>
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
        Follow the web through RSS.
      </h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-stone-600">
        Reader will collect new posts from the websites you subscribe to and keep them in one feed.
      </p>
    </section>
  ),
});
