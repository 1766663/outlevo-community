# Security

Please do not open a public issue for a vulnerability. Write to hello@outlevo.com with the steps to reproduce it.

What we care about most:

- A website or a reply making the agent do something it should not (prompt injection).
- A fetched page reaching your private network.
- Script running in the dashboard from scraped or received text.
- Anything that sends an email without approval, or to a suppressed address.
- Secrets leaving `.outlevo/`.

The dashboard listens on 127.0.0.1 only, and needs the link it prints. Started without a terminal, it cannot approve, answer or resume sending. Do not put it behind a public proxy.
