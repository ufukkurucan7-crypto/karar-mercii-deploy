#!/bin/sh
# Render build: repo kokundeki canli dosyalari sunucunun bekledigi yerlere kopyalar.
# Replit'teki km-deploy.sh ile ayni eslesme.
set -e
cp live-server.js       render/server.js
cp live-index.html      render/public/index.html
cp live-index.en.html   render/public/index.en.html
cp admin.html           render/public/admin.html
for f in render/server.js render/public/index.html render/public/index.en.html render/public/admin.html; do
  n=$(wc -c < "$f")
  echo "$f: $n bytes"
  [ "$n" -gt 1000 ] || { echo "HATA: $f cok kucuk"; exit 1; }
done
