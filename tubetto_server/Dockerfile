ARG BUILD_FROM
FROM $BUILD_FROM

# Node.js per il server, yt-dlp (in un ambiente Python separato) come metodo di riserva
RUN apk add --no-cache nodejs python3 py3-pip ca-certificates \
 && python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir -U yt-dlp

COPY server /app/server
COPY web /app/web
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
