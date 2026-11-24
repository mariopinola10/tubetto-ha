#!/usr/bin/with-contenv bashio
bashio::log.info "Avvio Tubetto Server..."
cd /app/server
exec node server.mjs
