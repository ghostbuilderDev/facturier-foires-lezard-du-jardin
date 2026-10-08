#!/data/data/com.termux/files/usr/bin/bash
set -e
pkg update -y
pkg install -y nodejs-lts git
npm install
if [ ! -f .env ]; then cp .env.example .env; fi
printf '\nInstallation terminée.\nÉdite .env : nano .env\nPuis lance : npm run dev -- --host 0.0.0.0\n'
