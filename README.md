# Local-Automation

Kör Claude Code i Docker med jämna mellanrum via macOS `launchd`. Varje uppgift
är en fil i `tasks/` med egen prompt och egen frekvens.

## Kom igång

```bash
cp .env.example .env     # fyll i token från `claude setup-token`
./run.sh exempel         # testkör en uppgift en gång
./install.sh             # schemalägg alla uppgifter med enabled: true
```

## Webbgränssnitt

```bash
./ui/install-ui.sh       # startar http://localhost:4777 nu och vid varje inloggning
./ui/install-ui.sh --remove
node ui/server.mjs       # eller kör den bara tillfälligt i terminalen
```

Där kan du skapa, ändra och ta bort uppgifter, slå på/av scheman, köra en
uppgift direkt och läsa loggar och filer i `/work`. Gränssnittet läser och skriver
samma filer i `tasks/` som skripten, så båda sätten fungerar samtidigt.

Servern (`ui/server.mjs`) har inga beroenden utöver Node och lyssnar bara på
127.0.0.1. Den avvisar anrop från andra webbsidor (Host-, Origin- och
`x-local-ui`-kontroll).

### Arkitektur och plan för molnversion

```
ui/public (webbsida)  ──HTTP /api──►  ui/server.mjs  ──►  tasks/, logs/, work/, run.sh, install.sh
```

Webbsidan pratar bara med `/api`. För att flytta gränssnittet till webben:
1. Webbsidan hostas i molnet och `/api` blir en molntjänst med inloggning
   och en databas för uppgifter och körningar.
2. `server.mjs` ersätts av en liten agent på Macen som *hämtar* uppgifter och
   kör-begäranden från molnet och skickar tillbaka loggar. Macen tar aldrig
   emot inkommande anslutningar.

## Skapa en uppgift

Skapa `tasks/<namn>.md`:

```markdown
---
schedule: weekdays 09:00
enabled: true
---
Det här är prompten Claude får varje gång.
```

| `schedule`              | Betyder                          |
|-------------------------|----------------------------------|
| `every 30m` / `every 2h` / `every 3600` | intervall (minst 60 s) |
| `daily 08:00`           | varje dag                        |
| `weekdays 09:00`        | måndag–fredag                    |
| `weekly mon,thu 09:00`  | valda veckodagar (mon…sun)       |

Kör `./install.sh` igen efter varje ändring. `./install.sh -n` visar vad som
skulle hända utan att ändra något. Raderade eller avstängda uppgifter tas bort
från schemat automatiskt.

## Åtkomst till tjänster (MCP)

En uppgift får bara de tjänster den listar i `mcp:`. Standard är läsning;
`:write` ger även skrivverktyg (skicka mejl, posta i Slack, skapa issues …).

```markdown
---
schedule: weekdays 07:00
enabled: true
mcp: slack, google, github:write
---
```

Konfigurationerna finns i `mcp/<tjänst>.read.json` och `mcp/<tjänst>.write.json`.
Tokens läses från `.env` via `${VAR}` och sparas aldrig i git. Tjänster som
inte listas laddas inte alls (`--strict-mcp-config`).

| Tjänst | `mcp:` | Server |
|---|---|---|
| GitHub | `github` | officiell, `api.githubcopilot.com/mcp` |
| Slack | `slack` | [korotovsky/slack-mcp-server](https://github.com/korotovsky/slack-mcp-server) |
| Gmail + Kalender, privat | `google` | [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) |
| Gmail + Kalender, jobb | `google-work` | samma, eget konto och egen token |

### GitHub → `GITHUB_PAT`
github.com → Settings → Developer settings → Fine-grained tokens. Välj repon och
ge *Read* på Contents, Issues, Pull requests och Metadata. Behöver en uppgift
skriva, ge *Read and write* på det som behövs.

### Slack → `SLACK_XOXP`
1. api.slack.com/apps → *Create New App* → From scratch, välj din workspace.
2. *OAuth & Permissions* → **User Token Scopes**: `channels:history`, `channels:read`,
   `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`,
   `mpim:read`, `users:read`, `search:read`, `usergroups:read`.
   För `slack:write` även `chat:write` och `reactions:write`.
3. *Install to Workspace* och kopiera **User OAuth Token** (`xoxp-…`).

### Gmail + Kalender → `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_EMAIL`
1. console.cloud.google.com → nytt projekt → aktivera **Gmail API** och
   **Google Calendar API**.
2. *OAuth consent screen*: External, lägg till din adress som testanvändare,
   och sätt sedan *Publishing status* till **In production** – annars slutar
   token fungera efter 7 dagar.
3. *Credentials* → *Create OAuth client ID* → **Desktop app**. Kopiera id och secret.
4. Kör `./mcp/google-login.sh` en gång och godkänn i webbläsaren. Token sparas i
   `data/google/` och förnyas automatiskt.
5. Jobbkonto: sätt `GOOGLE_WORK_EMAIL` och kör `./mcp/google-login.sh work`.
   Samma OAuth-klient fungerar; token sparas i `data/google-work/`. Kontots
   Workspace-admin kan behöva godkänna appen.

## Bra att veta

- **work/&lt;namn&gt;/** monteras som `/work` i containern; varje uppgift har sin egen
  mapp och Claude kommer inte åt något annat
- **logs/&lt;namn&gt;/** innehåller en logg per körning
- **data/** innehåller cache för Slack och Google-inloggningen (inte i git)
- `./uninstall.sh` tar bort alla scheman
- Kör en schemalagd uppgift direkt: `launchctl kickstart gui/$(id -u)/com.erikjin.claude-runner.<namn>`
- Docker Desktop startas automatiskt om den inte är igång. Datorn måste vara
  vaken; missade kalenderkörningar körs när den vaknar.
