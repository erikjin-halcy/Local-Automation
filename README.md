# Local-Automation

Kör Claude Code i Docker med jämna mellanrum via macOS `launchd`.

## Kom igång

```bash
cp .env.example .env          # fyll i token från `claude setup-token`
./run.sh                      # testkör en gång, se logs/
./install.sh 08:00            # schemalägg varje dag kl 08:00
# eller: ./install.sh every 3600   (varje timme)
```

- **prompt.md** – vad Claude ska göra
- **work/** – monteras som `/work` i containern, Claude kommer bara åt denna mapp
- **logs/** – en logg per körning
- `./uninstall.sh` tar bort schemat
- Tvinga omkörning nu: `launchctl kickstart gui/$(id -u)/com.erikjin.claude-runner`

Om Docker Desktop inte är igång startas den automatiskt. Datorn måste vara vaken;
missade kalenderkörningar körs när den vaknar.
