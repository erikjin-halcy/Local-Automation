#!/bin/zsh
# Engångsinloggning mot Google med minsta möjliga behörigheter (se mcp/google-login.mjs).
#   ./mcp/google-login.sh         privat konto: läsa Gmail och kalendern   -> data/google
#   ./mcp/google-login.sh work    jobbkonto: läsa Gmail, ändra kalendern  -> data/google-work
#   ./mcp/google-login.sh send    privat konto: bara skicka (morgonmejlet) -> data/gmail-send
# Kör "send" efter det privata kontot: återkallas en privat token återkallas båda.
exec node "${0:A:h}/google-login.mjs" "$@"
