# Stratum Review

AI code review for GitHub pull requests, run by [Stratum](https://github.com/stratum-eng). It reviews each pull request, posts inline findings and a summary, and keeps a dashboard of jobs, repositories, and model usage.

Tag `@stratum-review` in a pull request comment to request a review.

## A modified fork of Codra

Stratum Review is a modified fork of [Codra](https://github.com/devarshishimpi/codra) by Devarshi Shimpi, and remains licensed under the [GNU Affero General Public License v3.0](LICENSE). Stratum is not affiliated with or endorsed by the Codra project.

The main changes from upstream:

- **Runs entirely on Cloudflare.** PostgreSQL and Hyperdrive are replaced by D1, and AI responses and oversized webhook payloads are stored in R2.
- **Cloudflare Workers only.** The Node.js and Docker runtimes are removed.
- **Stats** are grouped in SQL and cached in KV.

Internal identifiers such as the `@codraoss/*` packages keep their upstream names so upstream fixes can still be merged. See the commit history for every change.

## Running it

```shell
npm install
npm test            # runs against local D1 and R2 engines; no database needed
npm run migrate     # applies packages/db/migrations to the remote D1 database
npm run deploy
```

The Worker needs the D1, R2, KV, Queue, Workflow, and AI bindings in `apps/worker/wrangler.jsonc`, and the secrets listed there.

`docs/` still describes upstream's Postgres setup and has not been updated yet.

## License

[AGPL-3.0](LICENSE). If you run a modified copy for others over a network, you must offer them its source.
