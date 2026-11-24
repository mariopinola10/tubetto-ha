#!/bin/sh
echo "[tubetto] Avvio generatore PO token (bgutil) su 127.0.0.1:4416"
cd /app && node build/main.js --port 4416 2>&1 | sed -u 's/^/[pot] /' &
sleep 2
echo "[tubetto] Avvio Tubetto Server"
cd /app/tubetto/server && exec node server.mjs
