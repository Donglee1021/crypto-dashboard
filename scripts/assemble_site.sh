#!/usr/bin/env bash
# 把 GitHub Pages 要发布的静态文件收进 _site。
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site
mkdir -p _site
cp index.html site.webmanifest favicon.svg .nojekyll _site/
cp -a css js data _site/
if [ -d reports ]; then cp -a reports _site/; fi
echo "assembled $(find _site -type f | wc -l) files"
