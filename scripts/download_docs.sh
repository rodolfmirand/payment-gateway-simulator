#!/usr/bin/env bash
# Downloads the Pagar.me documentation (https://docs.pagar.me) as Markdown, rebuilds INDEX.md
# and regenerates openapi.json via merge_openapi.py.
#
# usage: bash scripts/download_docs.sh [out dir]      (default: docs/pagarme)
#
# Page list = official llms.txt + the site's sidebar (llms.txt alone misses many endpoints).
# E-commerce platform plugin guides (Magento, Shopify, VTEX, WooCommerce, Nuvemshop...) are skipped.
# Existing files are overwritten; pages removed from the site are left on disk but drop out of INDEX.md.
set -euo pipefail

SITE="https://docs.pagar.me"
JOBS=8
SKIP_GUIDES='magento|shopify|vtex|woocommerce|nuvemshop|copy-of-|instalando-o-conector|cadastrando-um-cartão-private-label|plataformas-overview|nfeio|slack'

# percent-encode every byte outside [A-Za-z0-9/._-] (the site answers 400 to raw UTF-8 paths)
urlencode() {
  local hex c enc=""
  while IFS= read -r hex; do
    [ -z "$hex" ] && continue
    c=$(printf "\\x$hex")
    case "$c" in
      [A-Za-z0-9/._-]) enc+="$c" ;;
      *) enc+="%${hex^^}" ;;
    esac
  done < <(printf '%s' "$1" | od -An -v -tx1 | tr -s ' ' '\n')
  printf '%s' "$enc"
}

# fetch one page: <out dir> <section> <path>; prints "OK|FAIL(code) \t section \t name \t url"
fetch_page() {
  local out_dir="$1" section="$2" path="$3" slug name out code
  slug="${path##*/}"
  name=$(printf '%s' "$slug" | iconv -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null | tr -cd 'A-Za-z0-9._-')
  [ -z "$name" ] && name="$slug"
  out="$out_dir/$section/$name.md"
  code=$(curl -sL --retry 3 -w '%{http_code}' -o "$out.tmp" "$SITE$(urlencode "$path").md")
  if [ "$code" = "200" ] && [ -s "$out.tmp" ] && ! head -c 200 "$out.tmp" | grep -qi '<!doctype html'; then
    mv "$out.tmp" "$out"; printf 'OK\t%s\t%s\t%s\n' "$section" "$name" "$SITE$path"
  else
    rm -f "$out.tmp"; printf 'FAIL(%s)\t%s\t%s\t%s\n' "$code" "$section" "$name" "$SITE$path"
  fi
}

# xargs re-enters the script in this mode for each page
if [ "${1:-}" = "--fetch-page" ]; then
  shift; fetch_page "$@"; exit 0
fi

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$PROJECT/docs/pagarme}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT/reference" "$OUT/guides" "$OUT/pages"

echo "==> index and sidebar"
curl -sfL "$SITE/llms.txt" -o "$OUT/llms.txt"
curl -sfL "$SITE/reference/criar-pedido-2" -o "$TMP/reference.html"
curl -sfL "$SITE/docs/webhooks" -o "$TMP/docs.html"

# slugs from llms.txt for one section (reference|docs|page)
from_llms() { grep -oE "$SITE/$1/[^)]+\.md" "$OUT/llms.txt" | sed -E "s#^$SITE##; s#\.md\$##"; }
# slugs from the sidebar HTML; percent-encoded copies are dropped (the decoded form is also present)
from_sidebar() { grep -oE "/$1/[^\"\\\\?#< ]+" "$2" | grep -v '%' | grep -v ')$' || true; }

{ from_sidebar reference "$TMP/reference.html" | grep -vE '^/reference/[A-Z]'; from_llms reference; } \
  | sort -u | sed 's#^#reference #' > "$TMP/list.txt"
{ from_sidebar docs "$TMP/docs.html" | grep -v '^/docs/Web/'; from_llms docs; } \
  | grep -vE "$SKIP_GUIDES" | sort -u | sed 's#^#guides #' >> "$TMP/list.txt"
from_llms page | sort -u | sed 's#^#pages #' >> "$TMP/list.txt"
echo "    $(wc -l < "$TMP/list.txt") pages to fetch"

echo "==> downloading ($JOBS in parallel)"
sed "s#^#$OUT #" "$TMP/list.txt" | xargs -P "$JOBS" -L 1 bash "${BASH_SOURCE[0]}" --fetch-page > "$TMP/results.tsv"
cut -f1 "$TMP/results.tsv" | sort | uniq -c
# category pages (e.g. /reference/financeiro) are HTML-only and fail by design
grep -v '^OK' "$TMP/results.tsv" | cut -f4 | sed 's#^#    not downloaded: #' || true

echo "==> INDEX.md"
{
  echo "# Documentação Pagar.me (API v5) — cópia local"
  echo
  echo "Baixada de $SITE em $(date +%F) (versão \`.md\` de cada página; endpoints trazem o bloco \`# OpenAPI definition\` com schemas e exemplos de resposta)."
  echo "Guias de plugins de plataformas (Magento, Shopify, VTEX, WooCommerce, Nuvemshop) foram omitidos. \`llms.txt\` é o índice oficial do site."
  echo
  echo "**\`openapi.json\`** — todos os blocos OpenAPI fundidos numa spec única. Cada operação tem \`x-doc-url\` (página de origem); operações documentadas em várias páginas (\`POST /orders\`, \`POST /subscriptions\`, captura e cancelamento de cobrança) trazem \`x-variants\`. Exemplos convertidos de string para JSON (\`x-fixed\` quando foi preciso remover vírgulas finais). Exemplos que são pseudo-JSON na própria documentação ficaram como texto, e vários exemplos divergem do schema publicado (ex.: \`metadata\` tipado como \`string\`); na dúvida, o exemplo reflete melhor a resposta real. Para regerar: \`python scripts/merge_openapi.py\`; para baixar tudo de novo: \`bash scripts/download_docs.sh\` (na raiz do projeto)."
  echo
  echo "Legenda: 🔌 = contém OpenAPI definition"
  for sec in reference guides pages; do
    echo; echo "## $sec"; echo
    echo "| Arquivo | Título | Fonte |"; echo "|---|---|---|"
    awk -F'\t' -v s="$sec" '$1=="OK" && $2==s {print $3"\t"$4}' "$TMP/results.tsv" | sort -u | while IFS=$'\t' read -r name url; do
      f="$OUT/$sec/$name.md"
      t=$(grep -m1 '^# ' "$f" | sed 's/^# //; s/|/\\|/g' || true)
      flag=""; grep -q '^# OpenAPI definition' "$f" && flag=" 🔌"
      echo "| [$name.md]($sec/$name.md) | ${t}${flag} | <$url> |"
    done
  done
} > "$OUT/INDEX.md"

echo "==> openapi.json"
# first interpreter that actually runs (on Windows "python3" may be the Microsoft Store stub)
PY=""
for cand in python3 python py; do
  if command -v "$cand" >/dev/null && "$cand" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
    PY="$cand"; break
  fi
done
if [ -n "$PY" ]; then
  "$PY" -I "$PROJECT/scripts/merge_openapi.py" "$OUT" "$OUT/openapi.json"
else
  echo "    python 3 not found: run scripts/merge_openapi.py manually"
fi
