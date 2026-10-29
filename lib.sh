# Gemensamma funktioner för att läsa uppgiftsfiler i tasks/

# task_field <nyckel> <fil> – värdet från frontmatter (mellan första två ---)
task_field() {
  awk -v k="$1" '
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^[ \t]*#/ { next }
    { i = index($0, ":"); if (i && substr($0, 1, i - 1) == k) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); print v; exit } }
  ' "$2"
}

# task_prompt <fil> – allt efter frontmatter
task_prompt() {
  awk 'f >= 2 { print; next } /^---[ \t]*$/ { f++ }' "$1"
}
