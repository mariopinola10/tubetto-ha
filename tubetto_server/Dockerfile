ARG BUILD_FROM
FROM $BUILD_FROM

USER root
ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg per gli stream HLS; yt-dlp con plugin PO token (bgutil) e runtime JavaScript (node, già presente)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" bgutil-ytdlp-pot-provider

COPY server /app/tubetto/server
COPY web /app/tubetto/web
COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT []
CMD [ "/run.sh" ]
