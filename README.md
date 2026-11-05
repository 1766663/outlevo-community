<p align="center">
  <a href="https://outlevo.com/?utm_source=community&utm_medium=readme">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-on-dark.svg">
      <img alt="Outlevo" src=".github/assets/logo.svg" width="200">
    </picture>
  </a>
</p>

<h1 align="center">Outlevo Community</h1>

<p align="center">
  The free, open-source AI SDR that runs on your machine.
  <br /><br />
  <a href="https://outlevo.com/?utm_source=community&utm_medium=readme">Website</a>
  ·
  <a href="https://outlevo.github.io/outlevo-community/">Example pack</a>
  ·
  <a href="#is-it-for-you">Is it for you?</a>
  ·
  <a href="#community-and-outlevo-cloud">Community and Cloud</a>
  ·
  <a href="CHANGELOG.md">Changelog</a>
  ·
  <a href="https://github.com/Outlevo/outlevo-community/issues">Issues</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/outlevo"><img src="https://img.shields.io/npm/v/outlevo" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPLv3-purple" alt="License: AGPLv3"></a>
  <a href="https://github.com/Outlevo/outlevo-community/actions/workflows/ci.yml"><img src="https://github.com/Outlevo/outlevo-community/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Outlevo/outlevo-community/releases"><img src="https://img.shields.io/github/v/release/Outlevo/outlevo-community?label=release" alt="Latest release"></a>
</p>

**Give it your website. Get who to sell to, companies that fit, and emails built on quotes from their own sites. For founders and small B2B teams selling without an SDR.**

<p align="center">
  <img alt="outlevo start reads a website, finds companies that fit and writes emails, each with its quote and source" src=".github/assets/demo.gif" width="760">
  <br />
  <em>Sped up, with made-up companies. <a href="https://outlevo.github.io/outlevo-community/">Open a full example pack, no install needed</a>.</em>
</p>

## Quick start

You need Node 22.13 or newer and an [Anthropic API key](https://console.anthropic.com/), which you pay for by use.

```bash
mkdir my-outbound && cd my-outbound
export ANTHROPIC_API_KEY=...
npx outlevo start https://yourcompany.com
```

Then open `sales-pack/index.html`. It finds the companies itself, and your own list is optional. One real run of 20 companies took about 13 minutes, at about 8 model calls per company in the pack. It runs on your machine and sends nothing until you say so. For the other commands below, run `npm install -g outlevo`, or put `npx` in front of each.

The open-source alternative to 11x, Artisan and Apollo's outreach.

```
sales-pack/
  index.html          everything on one page: open this first
  ideal-customer.md   who to sell to, and why
  companies.csv       each company: why it fits, who to write to, the quote and its source, the emails
  emails/             3 emails per company, with sources
  linkedin.md         a connection note and a follow-up per company, to send by hand from your own LinkedIn
```

What each company looks like in it, with a made-up example:

```
Northwind                                       write to: Head of Sales
Why: they are hiring sellers

Subject: Austin AE hires
Saw you are hiring 4 account executives in Austin. We help new reps find
their first accounts. Who owns ramp for them?

"We are hiring 4 account executives in Austin"   https://northwind.example/careers
```

## Then, four ways to send

1. **Yourself, free.** Copy the emails, or load `companies.csv` into the tool you use. Send the notes in `linkedin.md` from your own LinkedIn, before the emails or after them: this tool never touches LinkedIn.
2. **From your own mailbox with this tool, free.** You bring a mailbox on a separate domain and a source of contacts (your Hunter key or a list). It sends what you approve, reads replies, offers your calendar and counts meetings. See [From approved email to meeting](#from-approved-email-to-meeting).
3. **With [Outlevo Cloud](https://outlevo.com/?utm_source=community&utm_medium=readme), from $29 a month.** Verified contacts and warmed-up mailboxes, ready to go, running while your laptop is closed.
4. **[Have Outlevo's team run it](https://outlevo.com/done-for-you/?utm_source=community&utm_medium=readme).** Managed from $999 a month, or pay per booked meeting, by application.

> **Status: early.** The checks, limits and guards have tests, and it has run against a live model and Hunter, and through a local mail server. It has not yet sent from a real mailbox on a real domain, so expect rough edges and start with a small list.

## Community and Outlevo Cloud

Community is complete on its own and stays free. [Outlevo Cloud](https://outlevo.com/?utm_source=community&utm_medium=readme) is a separate, paid, hosted product for what a laptop cannot do well.

| | Community | Outlevo Cloud |
|---|---|---|
| Price | Free, plus your own model, mailbox and contacts costs | From $29 a month ([pricing](https://outlevo.com/pricing)) |
| Where it runs | Your machine | Hosted, always on |
| Code | Open source, AGPLv3 | Proprietary |
| Research, ICP, sourced emails | Yes | Yes |
| Finding verified contacts | Your own Hunter key or list | Paid in credits: 8 a researched contact |
| Mailboxes | Your own, set up and warmed by you | Bought, set up and warmed for you |
| Sending | When you have approved it and your machine is on | Around the clock, with autopilot |
| Meetings | Booking link in answers you approve, meetings counted | Answered and booked on autopilot |
| LinkedIn | Notes to send by hand | Sent from your own account, LinkedIn signals (posts, engagement, job changes), voice notes |
| CRM, ads, agencies | No | Yes |
| Done for you | No | Managed from $999 a month, or pay per meeting by application |
| Support | GitHub Issues | AI answers, with escalation |

You can use just part of Cloud from the command line, and each paid call tells you its price first:

```bash
outlevo cloud connect     # paste the key; or set OUTLEVO_KEY
outlevo cloud find --brief "Logistics software in the US" --count 10
outlevo cloud contacts <company-id> --titles "VP Sales,Head of Sales" --yes
outlevo cloud handoff --name "Q4 logistics"     # Cloud sends, after a person launches it
```

## Is it for you?

**Take it if** you sell to businesses, you are at ease in a terminal, and you want to read every email before it goes.

**Skip it if** you want any of these:

- Outreach that runs while your laptop is closed, or without you approving it. Community has no autopilot.
- LinkedIn sent for you, or phone calls. Community writes LinkedIn notes for you to send by hand, and has no phone.
- High volume. Sending stops at 50 emails a day per mailbox, and that ceiling cannot be raised.
- Contacts and warmed-up mailboxes included. You bring your own, and a new mailbox needs 2-4 weeks of warm-up.
- No terminal. It is a command-line tool, with a local dashboard for reviewing.

How it compares with the usual ways of doing this, in general terms: products differ, so check the one you have in mind.

| | Outlevo Community | Hosted AI SDR | Sales engagement tool | By hand |
|---|---|---|---|---|
| To start | Free, plus your model bill | Subscription, often after a sales call | Subscription | Your time |
| Finding companies | Finds them, or takes your list | Finds them | You build the list, often from its database | You |
| What an email rests on | A quote found on the company's page, checked in code | Varies: ask to see the sources | Templates and merge fields | Your own research |
| Sending | Only what you approve, from your mailbox | On its own | Sequences you set up | You |
| Runs | While your machine is on | Always | Always | When you do |
| Your data | On your machine | With the vendor | With the vendor | With you |
| Volume | Low: up to 50 a day per mailbox | Higher | High | Low |

## What makes it different

- **Claims are checked, not trusted.** A fact is kept only if its quote is really on the page it names: that is code, word for word. A number written in digits must appear in a quote that email cites: code again. Then a second model reading looks for any statement about the company that no quote supports, numbers in words included. That last step is a model, so it can miss something, which is why you read every email. If an email fails, the model gets two more tries. If the first email still fails, the company's emails are blocked and cannot be approved. If only a follow-up fails, that follow-up is left out.
- **It knows who is hiring.** When a company's own site links to its job board on Greenhouse, Lever or Ashby, the open roles of the last 60 days become dated facts, each quoting the title and linking to the posting. A company hiring sellers is often buying for them. No key and no model call: the boards are public. Only a board the company itself links to counts, so a posting is never pinned on the wrong company.
- **It knows who raised money.** A US company raising money privately files a Form D with the SEC. A filing from the last 180 days becomes a dated fact, quoting the amount sold and linking to the filing on EDGAR. EDGAR's search matches loosely, so a filing counts only when the issuer's legal name is the company's own name (without Inc, LLC and the like) and its ZIP code or phone number is printed on the company's own website. Funds are skipped. Free, no key, no model call.
- **Bring what you saw.** Found someone on LinkedIn writing about the problem you solve? Put the posts in a CSV and run `outlevo signals import`. Each becomes a fact about the author's company, in their own words with the link, and their first email and LinkedIn note open on it, written to them. This tool never reads LinkedIn: you paste what you saw. The company is still researched and has to fit your ICP.
- **LinkedIn too, by hand.** With the emails, from the same quotes and held to the same checks, it writes a connection note and a follow-up for each company. A note that fails is left out and never holds back the emails. It never says "I emailed you", so it can go first.
- **It learns from your deals.** Give it up to 15 companies you won and 15 you lost. It reads their home pages, and the ICP comes from what sets them apart, not from a filter list.
- **B2B first.** Of the people you have at a company, it picks the one closest to the buyers in your ICP, and writes to one person per company at a time.
- **It goes all the way to the meeting.** A reply that says it is interested gets a drafted answer with your booking link; a question gets a drafted answer to the question. When Calendly, Cal.com or Google Calendar emails you the booking, it shows up in Meetings.
- **Nothing sends without you.** Every sequence waits for your approval. The answers it drafts to replies wait too. Community has no autopilot.
- **Safe by default.** See [The rules it will not break](#the-rules-it-will-not-break).

## Running it

Run it again any time: it carries on from where it stopped and does not pay twice for what it has done.

**As many companies as you want.** It starts with 20 if you do not say; `--count 500` goes for 500, and everything in your own list gets done whatever its size. It is your key and your bill: expect about 8 model calls for each company in the pack, because it also pays to read those that turn out not to fit. To cap it, `outlevo config set model.max_calls_per_day 200`. Only sending has a ceiling, and that protects your domain, not our costs.

Not quite right? Change it in words, or take a company out. The pack updates, and rewritten emails go through every check again:

```bash
outlevo rewrite northwind.com "shorter, and no question at the end"
outlevo drop northwind.com          # --undo puts it back
```

A rewrite that fails the checks keeps the old emails. Approved emails that are rewritten need approving again, and once a company's first email has gone, its emails can no longer be rewritten. The pack is rebuilt whole each time, so edit a copy if you want to keep your changes. It never replaces files it did not make: choose another folder with `--out`.

Each industry in your ideal customer gets its own search and its own share of the companies, so one does not fill the list. `outlevo dashboard` opens a local page with the funnel from company to meeting, sends and replies by day, fit scores, the mix by industry and what your model calls add up to.

To make it better, add what you have:

```bash
outlevo start https://yourcompany.com --won won.csv --lost lost.csv   # a column named domain
outlevo companies import companies.csv                                # your own list, a column named domain
outlevo contacts import people.csv                                    # email, first_name, last_name, title, domain
outlevo signals import posts.csv                                      # posts you found: domain, name, text, post_url (title, date, email)
```

Try the rules on any email, with no key and no network:

```bash
outlevo check email.txt
```

## From approved email to meeting

To send from your own mailbox, add people (`export HUNTER_API_KEY=...` and `outlevo contacts find`, or `outlevo contacts import`), connect a mailbox on a separate domain, and pass the checks:

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
outlevo config set booking_url https://cal.com/sam
export OUTLEVO_SMTP_PASSWORD=...

outlevo doctor     # what is missing: SPF, DMARC, address, mailbox
outlevo run        # replies, send, contacts, write, research, every 5 minutes
```

A new mailbox needs 2-4 weeks of warm-up before real volume, with a warm-up service of your choice. So expect the first meetings some weeks after you start, and no number of them is promised.

Bookings are counted from the emails Calendly, Cal.com and Google Calendar send you, and only when your mail provider has verified the sender (DKIM or DMARC, in the `Authentication-Results` header). It counts only the verdict of your provider's own server, worked out from `imap.host`; if real bookings show as not proven in Activity, set yours with `outlevo config set imap.auth_server mx.yourprovider.com` (the event names the server it saw). If yours adds no such header, record them by hand with `outlevo meetings add <contact-id>`; a forger who guesses your provider's server name could still write one.

`outlevo --help` lists every command, and `--json` makes any of them easy for scripts and agents. To let an AI coding agent drive it, see [skills/outlevo/SKILL.md](skills/outlevo/SKILL.md).

## What it replaces

| | What Community does instead | What you still bring |
|---|---|---|
| 11x, Artisan | Research, email, replies, the path to a meeting, with your approval at each send. LinkedIn notes to send by hand; no LinkedIn automation or phone | Mailbox, contacts |
| Apollo | Sequences and AI writing | Contacts: there is no built-in database |
| Clay | AI research on company sites, with a quote for every answer | Other data providers |

## The rules it will not break

These are in the code, and each has a test.

| Rule | How |
|---|---|
| Approved emails only | A send picks only what a person approved, and checks it again at that moment. An approval covers the emails that were shown: if they changed in between, nothing is approved. `approve`, `answer` and `resume` need a person at a terminal, or a dashboard started from one |
| Unsourced claims do not go out | The checks in [`src/lint.ts`](src/lint.ts) run when written and again when sent |
| Links go only where they should | An email may link to your site or the prospect's, and an answer to your booking host too, with or without `https://`. That covers `evil dot com` and links handed on in a query, as in `yoursite.com/r?u=evil.com`. A redirect with a coded target is not caught, so read what you approve |
| No fake threads or fake history | No "Re:" on a first email, no "as we discussed" |
| Opt-outs work | Every email carries your postal address and a way out, plus a `List-Unsubscribe` mailto header signed for that person, so it counts even when sent from a mailbox they forward to. A plain request to stop, in several languages, from them, an alias or a colleague, suppresses the address without calling the model. Anything less clear goes to the model |
| A reply stops the sequence | For that person and for the rest of their company, even if the sender cannot be verified, because missing a real opt-out is worse. Those replies are marked `sender not verified`. An out-of-office does not stop it |
| No guessed addresses | Addresses come from your import, from a page that prints them, or from a verification service |
| Volume stays low | Ramps from your warm-up date, with a ceiling of 50 a day that settings cannot raise. By default, one email every 4 minutes in business hours on weekdays, which you can change |
| It stops itself | Sending stops when over 3% of the last 200 people bounced, once there are 20 people or 3 bounces to go on. A bounce counts only if it quotes the email we sent or comes verified from your domain or theirs, so a stranger cannot stop you with forged ones; others are listed in the dashboard's Activity as not trusted. `outlevo run` sends nothing in a turn when it cannot read replies. `outlevo stop` stops everything at any time, answers included |
| It needs your domain set up | No SPF, DMARC or postal address, no sending |

It also respects `robots.txt`, will not fetch private network addresses, treats everything from the web and every reply as data rather than instructions, and gives the model no tools when it reads them, with one exception. Finding companies uses the model's web search, so a page in the results could try to steer it. That step gets your product summary, the ICP and your `--brief`, but not your imported lists or the names of your deals, and all it returns is domains, each read and checked like any other. To avoid it, use your own list with `outlevo companies import` and `outlevo research`.

These rules protect you from mistakes, and from a coding agent ignoring its instructions, but not from someone determined on your own machine: it is open source, and `OUTLEVO_ALLOW_SCRIPTED_APPROVAL=1` exists for people who want their own automation.

You are the sender, and the law applies to you (CAN-SPAM, GDPR, CASL and others). None of this is legal advice.

## Where your data lives

Everything is in `.outlevo/` next to where you run it, readable only by you: a SQLite database, your config and your secrets. What leaves it: page text and replies to your model provider, domains and addresses to Hunter if you use it, your mail to your mail server. It also visits the sites it researches (as `OutlevoCommunityBot`) and looks up DNS. While researching it reads the public job boards those sites link to, and searches SEC EDGAR for the company's name; turn either off with `outlevo config set signals.job_boards false` or `outlevo config set signals.sec_form_d false`. It reaches Outlevo only if you connect Cloud and run a `cloud` command.

## Model

It uses the Anthropic API by default, on your own key, with no limit unless you set `model.max_calls_per_day`. Change the model with `outlevo config set model.name <id>`.

You can use Anthropic's local command-line tool instead with `outlevo config set model.provider local-cli`. Check that your plan's terms allow this kind of use before you do.

## Development

```bash
git clone https://github.com/Outlevo/outlevo-community.git && cd outlevo-community
npm install
npm test
npm run typecheck
npm run dev -- --help
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). AI coding agents: [AGENTS.md](AGENTS.md).

Built with TypeScript on Node.js and its built-in SQLite, with Anthropic's models by default. Nothing else to host.

## Contact

Cloud and sales: hello@notify.outlevo.com. Vulnerabilities: [SECURITY.md](SECURITY.md). Everything else: [GitHub Issues](https://github.com/Outlevo/outlevo-community/issues).

## License

[AGPL-3.0-only](LICENSE). The license does not grant rights to the Outlevo name or logo.
