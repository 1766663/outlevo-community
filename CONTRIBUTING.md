# Contributing

Issues and pull requests are welcome.

## Before you open a pull request

- `npm run typecheck && npm test` must pass.
- Anything that changes what can be sent, to whom or how often needs a test showing the guard still holds.
- Rules that decide whether an email goes out belong in code, not in a prompt.
- Text from the web or from a reply is data. Wrap it with `untrusted()` before it reaches a model, and render it as text in the dashboard.

## We will not merge

- Ways around approval, suppression, the opt-out or the daily ceiling.
- Fake threads, hidden tracking, or sender rotation meant to evade spam filters.
- Scraping behind a login, or ignoring `robots.txt`.

## License of contributions

The project is AGPL-3.0-only, and REALTY.TM GROUP sp. z o.o. also sells Outlevo Cloud commercially. By submitting a contribution you agree that:

1. You wrote it, or have the right to submit it.
2. It is licensed to everyone under AGPL-3.0-only.
3. You also grant REALTY.TM GROUP sp. z o.o. a perpetual, worldwide, royalty-free license to use, modify and relicense it, including in commercial products.

You keep your copyright. Say so in your first pull request: "I agree to the contribution terms in CONTRIBUTING.md."
