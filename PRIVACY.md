# Privacy Policy – Local Automation

*Last updated: 2026-10-29*

Local Automation is a personal tool that runs scheduled tasks with Claude Code on
the developer's own computer. It is not offered to the public and is used only
by its developer.

## Data accessed

When a task is configured to use them, the app may read data from the
developer's own accounts:

- **Gmail and Google Calendar** – messages, labels and calendar events
- **Slack** – channels, messages and users visible to the developer
- **GitHub** – repositories, issues and pull requests

Read-only access is the default. Write access (for example sending email or
creating calendar events) is only enabled for specific tasks the developer
configures.

## How data is used and stored

- OAuth tokens and credentials are stored only on the developer's computer and
  are never uploaded or shared.
- Data is processed only to perform the tasks the developer has configured,
  such as summarizing messages. Task output and logs are stored locally.
- To perform a task, relevant content is sent to Anthropic's Claude API for
  processing, under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).
- Data is not sold, used for advertising, or shared with any other third party.

## Google API data

The use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Revoking access

Access can be revoked at any time at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions),
and by deleting the local `data/` directory.

## Contact

erikjin.123@gmail.com
