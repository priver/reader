# Reader

Reader is a chronological RSS and Atom web reader for people who already use feeds. It has no
ranking algorithm. Articles stay in publication order, and the reading view comes first.

## Current development

Requirements:

- Node 24.19.0
- pnpm 11.21.0

```sh
pnpm install
pnpm --filter @priver/reader-web dev
```

Current repository checks:

```sh
pnpm check
pnpm build
```

## Product direction

Personal alpha includes:

- Public RSS and Atom subscriptions through feed or website URLs
- OPML import and export
- Folders, unread state, saved items, title/source search, and synchronized reading progress
- Three resizable panes on desktop, plus stacked navigation and bottom destinations on mobile
- Feed-provided article HTML that the Go worker sanitizes before storage
- Signed imgproxy URLs for article images, so browsers never request them from publishers

Reader will not download linked article pages through invitation beta. When a feed contains only an
excerpt, Reader shows it and links to the original page. Full-page extraction remains a post-beta
product and architecture decision.

## Documentation

| Topic                         | Document                                       |
| ----------------------------- | ---------------------------------------------- |
| Product scope and experience  | [`docs/product.md`](docs/product.md)           |
| Target architecture and flows | [`docs/architecture.md`](docs/architecture.md) |
| Conceptual data model         | [`docs/data-model.md`](docs/data-model.md)     |
| Security boundaries           | [`docs/security.md`](docs/security.md)         |
| Testing and release gates     | [`docs/testing.md`](docs/testing.md)           |
| Deployment and operations     | [`docs/deployment.md`](docs/deployment.md)     |
| Decision records              | [`docs/decisions/`](docs/decisions/)           |

## License

This project is licensed under the MIT License - see the [LICENSE.txt](LICENSE.txt) file for
details.
