# 1.0.9
- Nuovo logo: medusa stilizzata.

# 1.0.8
- Copertine mancanti: al loro posto un disegno (nota musicale) invece dell'icona di immagine rotta.

# 1.0.7
- "Dimostra di non essere un bot": generatore di PO token (bgutil) integrato e yt-dlp con runtime JavaScript.
  Quando YouTube blocca le richieste dirette, si passa in automatico a yt-dlp + PO token.
- Il brano successivo viene preparato in anticipo (browser e Music Assistant).
- Facoltativo: cookie di un account YouTube in /share/tubetto/cookies.txt.

# 1.0.6
- Se YouTube blocca i link diretti ("conferma di non essere un bot" o 403 a metà brano) usa gli stream HLS,
  convertiti al volo da ffmpeg: funzionano anche nel browser e in Music Assistant.
- Identità anonima (visitorData) come un browser vero: meno blocchi "bot".

# 1.0.5
- Corretto: brani che si fermavano subito (HTTP 403). Il client IOS dà link validi solo per i primi byte:
  ora ogni link viene verificato anche a metà e alla fine, e se si interrompe si riprende dallo stesso punto con un altro client.

# 1.0.4
- Corretto config.yaml (testo non valido che nascondeva l'app nello store).

# 1.0.3
- Porta di rete di casa disattivata di default (8095 e 8097 sono di Music Assistant):
  pannello e Music Assistant funzionano senza. Se serve, attivala in Rete con una porta libera.

# 1.0.2
- Porta cambiata: la 8095 è già usata da Music Assistant. Ora interna 8099, in rete di casa 8097.

# 1.0.1
- Copertine a mosaico 2×2 per playlist, preferiti e mix.

# 1.0.0
- Prima versione: interfaccia Tubetto senza pubblicità nel pannello di Home Assistant,
  stream dal Raspberry, "Suona in casa" verso Music Assistant, libreria sincronizzata con l'app.
