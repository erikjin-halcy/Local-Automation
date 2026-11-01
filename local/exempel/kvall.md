---
mcp: google-work, slack, linear, github
---
Gör min <org>-kväll: en rapport över vad jag har gjort på <org> i dag (från 00:00 till nu, i min tidszon). Allt rör <org> och stannar på min Mac.

Hämta (bara läsning):
- Slack (workspacen <org>): meddelanden jag har skrivit i dag, och trådar där någon fortfarande väntar på svar från mig.
- Jobbmejl (google-work): mejl jag har skickat i dag, och mejl till mig i dag som jag inte har svarat på.
- Jobbkalendern (google-work): dagens möten och fokusblock ("Fokus: …").
- Linear: ärenden jag har skapat, uppdaterat, kommenterat, flyttat eller stängt i dag.
- GitHub, bara repot <org>/<repo> (läs inga andra repon). Mina konton där är <konto1> och <konto2>, räkna båda som mig: mina commits, PR:er, reviews och kommentarer i dag, och vad som har mergats i dag.

Skriv sedan rapporten:
1. **I korthet**: 2–3 meningar om vad dagen handlade om.
2. **Gjort i dag**: per område, med länkar (PR, Linear-ärende, Slack-tråd).
3. **Möten**: med tid.
4. **Fokusblock**: planerade block, och om det finns spår av att arbetet blev gjort.
5. **Kvar och väntar på mig**: det som fortfarande kräver svar eller åtgärd från mig, med källa.
6. **Inför i morgon**: 1–3 saker att börja med.

Läs bara. Ändra, skicka, svara, kommentera eller posta ingenting någonstans. Skriv inte ut tokens eller hemligheter.

Skriv rapporten till /work/<org>-kvall-ÅÅÅÅ-MM-DD.md (dagens datum).

Skriv också /work/counts.json med bara antal (heltal), inget annat: inga ämnen, namn, kanaler, titlar eller länkar. Exakt de här nycklarna, och utelämna en källa som inte gick att läsa:
{"mejl": {"nya": 0, "relevanta": 0, "hogPrio": 0, "vantarSvar": 0}, "slack": {"omnamnanden": 0, "dm": 0, "vantarSvar": 0}, "linear": {"tilldelade": 0, "nya": 0, "hogPrio": 0}, "github": {"oppnaPr": 0, "vantarReview": 0, "ciFel": 0, "mergade": 0}}
Räkna för i dag: mejl = jobbmejl i dag, de som är relevanta för mig, hög prio och de som fortfarande väntar på svar från mig. slack = omnämnanden av mig i dag, DM till mig i dag och trådar som fortfarande väntar på mig. linear = ärenden tilldelade mig som inte är klara, nya i dag och de med hög prio. github = mina öppna PR:er, PR:er som väntar på min review, PR:er med misslyckad CI och PR:er mergade i dag.
