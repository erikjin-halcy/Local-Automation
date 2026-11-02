---
mcp: google-work, slack, linear, github
---
Gör min <org>-morgon: en sammanfattning av mitt jobb på <org> inför dagen. Allt rör <org> och stannar på min Mac.

Hämta (bara läsning):
- Jobbmejl (google-work, kontot på <domän>): mejl från de senaste 24 timmarna, eller sedan förra vardagens morgon om det är måndag. Särskilt det som kräver svar eller åtgärd från mig.
- Jobbkalendern (google-work): dagens möten och fokusblock ("Fokus: …").
- Slack (workspacen <org>): omnämnanden av mig, DM och trådar jag deltar i under samma period, och trådar där någon väntar på svar från mig.
- Linear: ärenden tilldelade mig, och ärenden som har ändrats sedan i går i de team jag är med i.
- GitHub, bara repot <org>/<repo> (läs inga andra repon). Mina konton där är <konto1> och <konto2>, räkna båda som mig: vad som har ändrats sedan förra körningen. Läs /work/github-state.json om den finns (tidpunkt och läget då), annars de senaste 24 timmarna. Commits på standardbranchen, PR:er som är nya, mergade eller stängda, och alla öppna PR:er med författare, reviewers, review- och CI-status. Issues som är nya eller stängda, och öppna issues med tilldelad person.

Skriv sedan rapporten. Den börjar med en sammanfattning och följs av detaljerna; nämn varje sak bara en gång i sammanfattningsdelen.
1. **Sammanfattning** (allra först): ett kort stycke löptext, 3–5 meningar, om läget. Dra slutsatser över alla källor tillsammans, som en kollega som har läst allt: vad som har hänt sedan i går, vad som väntar på mig och varför, mönster och sådant som har blivit liggande (t.ex. en PR utan reviewer sedan flera dagar), och vad dagen ser ut att handla om. Gruppera mindre saker i stället för att räkna upp dem. Inga punktlistor här.
2. **Prioritera i dag**: de 1–3 saker som är viktigast för mig i dag, numrerade, en rad var med kort motivering och källa. Är inget viktigt, skriv det i sammanfattningen och hoppa över rubriken.
3. **Dagens schema**: möten och fokusblock med tider, bara om det finns några.

Sedan, under en linje (`---`) och rubriken **Detaljer**:
4. **Väntar på svar från mig**: mejl, Slack-trådar och Linear-ärenden, med länk.
5. **GitHub sedan i går**: vad som är mergat, nytt och stängt. Sedan en tabell över det som är kvar att göra och vem som gör det (PR/issue, ägare, status, länk), där det som har stått still längst eller saknar ägare kommer först.
6. **Att göra**: en samlad checklista (`- [ ] …`) i prioritetsordning, där dubbletter är ihopslagna.

Sammanfattningen och Prioritera i dag tillsammans högst cirka 180 ord. Skriv datum som ÅÅÅÅ-MM-DD. Ta bara med sådant som du har hittat i källorna och hitta inte på något. Ingen hälsningsfras.

Läs bara. Ändra, skicka, svara, kommentera eller posta ingenting någonstans. Skriv inte ut tokens eller hemligheter.

Skriv rapporten till /work/<org>-morgon-ÅÅÅÅ-MM-DD.md (dagens datum). Skriv sist över /work/github-state.json med tidpunkten för körningen och de öppna PR:erna och issuesen (nummer, titel, ägare, status), men bara om GitHub svarade.

Skriv också /work/counts.json med bara antal (heltal), inget annat: inga ämnen, namn, kanaler, titlar eller länkar. Exakt de här nycklarna, och utelämna en källa som inte gick att läsa:
{"mejl": {"nya": 0, "relevanta": 0, "hogPrio": 0, "vantarSvar": 0}, "slack": {"omnamnanden": 0, "dm": 0, "vantarSvar": 0}, "linear": {"tilldelade": 0, "nya": 0, "hogPrio": 0}, "github": {"oppnaPr": 0, "vantarReview": 0, "ciFel": 0, "mergade": 0}}
Räkna för samma period som rapporten: mejl = nya jobbmejl, de som är relevanta för mig, hög prio och de som väntar på svar från mig. slack = omnämnanden av mig, DM till mig och trådar som väntar på svar från mig. linear = ärenden tilldelade mig som inte är klara, nya ärenden till mig och de med hög prio. github = öppna PR:er, PR:er som väntar på min review, PR:er med misslyckad CI och PR:er mergade sedan i går.
