# Outlevo Community

**An open-source AI SDR for B2B. It runs on your machine, and every claim in every email has a source you can check.**

The open alternative to closed AI SDRs like 11x and Artisan. You can read every rule it follows, see every email before it goes, and change anything.

```
$ outlevo run
Researched northwind.com: qualified (82)
Wrote 3 emails for Dana Reed, Head of Sales

  Saw you are hiring 4 account executives in Austin. We help new reps find
  their first accounts. Who owns ramp for them?

  source: "We are hiring 4 account executives in Austin"
          https://northwind.com/careers

Waiting for your approval. Nothing sends without you.
```

## What makes it different

- **Claims are checked by code, not trusted.** A fact is kept only if its quote is really on the page it names. A number in an email must appear in a fact that email cites. If an email breaks a rule, the model gets one more try. After that the email is blocked and cannot be approved.
- **It learns from your deals.** Give it the companies you won and lost, and the ICP comes from what they show, not from a filter list.
- **B2B first.** It looks for the person who owns the problem at a company, and writes to one person per company at a time.
- **Nothing sends without you.** Every sequence waits for your approval. The answers it drafts to replies wait too. Community has no autopilot.
- **Safe by default.** See [The rules it will not break](#the-rules-it-will-not-break).

## Quick start

You need Node 22.13 or newer and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone <this repository> && cd outlevo-community
npm install && npm run build && npm link

mkdir my-outbound && cd my-outbound
export ANTHROPIC_API_KEY=...

outlevo init --website https://yourcompany.com
outlevo product learn
outlevo icp learn --won won.csv --lost lost.csv   # both optional, a column named domain
outlevo companies import companies.csv            # a column named domain
outlevo contacts import people.csv                # email, first_name, last_name, title, domain
outlevo run --once                                # research
outlevo run --once                                # write
outlevo dashboard                                 # review and approve
```

Try the rules on any email, with no key and no network:

```bash
outlevo check email.txt
```

Before anything can send, connect a mailbox and pass the checks:

```bash
outlevo config set sender.name "Sam Lee"
outlevo config set sender.company "Acme Tools"
outlevo config set sender.email sam@getacme.com
outlevo config set sender.postal_address "1 Main St, Springfield, IL 62701"
outlevo config set smtp.host smtp.example.com
outlevo config set smtp.user sam@getacme.com
outlevo config set imap.host imap.example.com
outlevo config set imap.user sam@getacme.com
outlevo config set warmup_start 2026-11-01
export OUTLEVO_SMTP_PASSWORD=...

outlevo doctor     # what is missing: SPF, DMARC, address, mailbox
outlevo run        # replies, send, write, research, every 5 minutes
```

`outlevo --help` lists every command, and `--json` makes any of them easy for scripts and agents. To let an AI coding agent drive it, see [skills/outlevo/SKILL.md](skills/outlevo/SKILL.md).

## The rules it will not break

These are in the code, and each has a test.

| Rule | How |
|---|---|
| Approved emails only | A send picks only what a person approved, and checks it again at that moment |
| Unsourced claims do not go out | The checks in [`src/lint.ts`](src/lint.ts) run when written and again when sent |
| No fake threads or fake history | No "Re:" on a first email, no "as we discussed" |
| Opt-outs work | Every email carries your postal address and a way out, plus a `List-Unsubscribe` header. A reply saying stop suppresses the address without calling the model |
| A reply stops the sequence | For that person and for the rest of their company |
| No guessed addresses | Addresses come from your import, from a page that prints them, or from a verification service |
| Volume stays low | Ramps from your warm-up date, with a hard ceiling of 50 a day and a gap between emails. Business hours only |
| It stops itself | Bounces over 3% stop all sending, and `outlevo stop` does the same at any time |
| It needs your domain set up | No SPF, DMARC or postal address, no sending |

It also respects `robots.txt`, will not fetch private network addresses, treats everything from the web and every reply as data rather than instructions, and gives the model no tools when it reads them.

You are the sender, and the law applies to you (CAN-SPAM, GDPR, CASL and others). None of this is legal advice.

## Where your data lives

Everything is in `.outlevo/` next to where you run it: a SQLite database, your config, and a private secrets file. It goes only to the model provider you choose and the mail server you set. It reaches Outlevo only if you connect Cloud and run a `cloud` command.

## Model

It uses the Anthropic API by default, on your own key, and stops at `model.max_calls_per_day` (200 unless you change it). Change the model with `outlevo config set model.name <id>`.

You can use a local Claude Code install instead with `outlevo config set model.provider claude-cli`. Check that your plan's terms allow this kind of use before you do.

## Community and Outlevo Cloud

Community is complete on its own and stays free. [Outlevo Cloud](https://outlevo.com/?utm_source=community&utm_medium=readme) is a separate, paid, hosted product for what a laptop cannot do well.

| | Community | Outlevo Cloud |
|---|---|---|
| Price | Free | Paid plans |
| Where it runs | Your machine | Hosted, always on |
| Code | Open source, AGPLv3 | Proprietary |
| Research, ICP, sourced emails | Yes | Yes |
| Finding verified contacts | Bring your own, or buy from Cloud | Included |
| Mailboxes | Your own, set up and warmed by you | Bought, set up and warmed for you |
| Sending | When you have approved it and your machine is on | Around the clock, with autopilot |
| CRM, ads, agencies | No | Yes |
| Support | GitHub Issues | Included |

You can use just part of Cloud from the command line, and each paid call tells you its price first:

```bash
outlevo cloud connect <key>
outlevo cloud find --brief "Logistics software in the US" --count 10
outlevo cloud contacts <company-id> --titles "VP Sales,Head of Sales" --yes
outlevo cloud handoff --name "Q4 logistics"     # Cloud sends, after a person launches it
```

## Development

```bash
npm test
npm run typecheck
npm run dev -- --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE). "Outlevo" is a trademark of REALTY.TM GROUP sp. z o.o.; the license does not grant rights to the name or logo.
