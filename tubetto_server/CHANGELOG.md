# 1.6.0
- Nuovo modo di usare le uscite: si ascolta e si guarda nel browser di Home Assistant (la barra in basso comanda solo
  questo dispositivo). Dal menu 🎧 ogni stanza/TV ha i suoi ▶ (manda il brano o video in corso) e ⏹ (ferma solo lei).
  Ogni TV va avanti da sola con la sua coda, anche a browser chiuso.
- 📱 Firestick con l'app Tubetto (integrazione Android Debug Bridge): compare nel menu come "… (app Tubetto)".
  ▶ accende la TV Sony collegata, la porta sull'HDMI 1 e apre il video nell'app Tubetto della Firestick;
  ⏹ la ferma. La TV si trova da sola (nome in comune con la Firestick, es. "Salone"); altrimenti si imposta in
  Configurazione: firestick_entity, firestick_tv, firestick_hdmi (predefinito "HDMI 1").

# 1.5.9
- 📺 Ogni stanza usa per prima la sua TV Google Cast con lo stesso nome (es. "TV dello studio" → media_player.tv_dello_studio)
  invece del DLNA: i video si aprono nell'app YouTube della TV.

# 1.5.8
- Comandi indipendenti: con "questo dispositivo" insieme alle stanze, il browser ha play/pausa/barra nel riquadro
  del video; la barra in basso comanda solo la casa.
- Salto avanti/indietro sulle TV DLNA (errore "Seek failed, upnp 402"): il flusso riparte dal punto scelto;
  la posizione mostrata tiene conto del salto.

# 1.5.7
- 📺 TV Google Cast: i video si aprono nell'app YouTube della TV (come trasmettere dal telefono). Niente flussi dal
  server: leggero, si può saltare, qualità piena. Per avere il video senza pubblicità tramite Tubetto Server:
  Impostazioni → "Video sulle TV Google Cast tramite Tubetto Server".
- Per la TV si prova sempre prima l'entità Google Cast, poi il DLNA.
- Un invio alla volta: più clic di fila non aprono più flussi sulla stessa TV (errore DLNA "SetAVTransportURI failed").

# 1.5.6
- "Dashboard displays only accept the media content type dashboard": se l'entità scelta per la TV rifiuta il video,
  Tubetto Server prova da solo le altre entità della stessa TV (prima Google Cast, poi DLNA) e ricorda quale
  funziona. Nel Registro le righe [tv] mostrano ogni tentativo.

# 1.5.5
- 📺 Solo audio con l'icona di Music Assistant sulla TV: erano scelte due uscite della stessa TV (Music Assistant e
  Cast) e l'audio di Music Assistant copriva il video. Ora la stessa TV (entity_id con la stessa radice, es.
  sony_kd_43xh8096 e sony_kd_43xh8096_3) è una sola voce e riceve solo il video.
- Le uscite che non esistono più vengono tolte dalla scelta.
- In casa, il tasto 🎬 del player passa sulla TV dalla copertina al video di YouTube del brano in corso (e ritorno).

# 1.5.4
- 📺 Google Cast: niente più HLS (la TV partiva dal "bordo" del flusso, si fermava e chiudeva il video).
  Ora riceve l'MP4 di YouTube (con lunghezza, si può saltare) o, se non c'è, un MP4 continuo come nel browser;
  la musica arriva come MP4 continuo con copertina e titolo. Il DLNA resta con il flusso .ts.
- "Failed to execute quick play": se la TV è ancora occupata dal flusso precedente, si riprova dopo 2,5 secondi.
- Browser: il riquadro del video si sposta trascinandolo dalla barra del titolo (doppio clic = torna al suo posto).

# 1.5.3
- Video neri e muti (browser e TV): i link video dei client diretti di YouTube si interrompevano dopo il primo pezzo.
  Per i video ora si usa prima yt-dlp con PO token (link stabili), poi i client diretti. La risposta di yt-dlp
  viene riusata per 20 minuti, così i controlli non rallentano l'avvio.

# 1.5.2
- 📺 TV collegate in DLNA (es. Sony "TV Studio", senza Google Cast): non aprono l'HLS. Ora ricevono un MP4 normale
  quando YouTube dà lo stream unico, altrimenti un flusso MPEG-TS continuo (H.264+AAC) come la TV digitale.
  Anche il badge della musica (copertina + titolo) arriva così. Le TV Google Cast continuano con l'HLS.
- Brani "lunghezza sconosciuta": la lunghezza si legge dal link di YouTube (clen), molti brani tornano a partire.
- Copertina sulla TV: se l'audio del brano non si apre, si usa l'audio del video.

# 1.5.1
- Video nero nel browser: YouTube rifiutava il link diretto dopo che Tubetto Server aveva già risposto (0 byte).
  Ora il primo pezzo si controlla prima; se è rifiutato si passa a video e audio separati uniti da ffmpeg.
- TV: se la copertina non si prepara (audio non disponibile) si prova il video, e viceversa; nel Registro la riga [tv]
  mostra il link mandato alla TV.
- Impostazioni: "Link per le TV …/ping" per verificare dal telefono che la TV possa raggiungere Tubetto Server.
- I client YouTube non vengono più esclusi tutti insieme dopo un errore.
- Arresto pulito all'aggiornamento/riavvio (niente più avviso SIGTERM).

# 1.5.0
- 📺 TV: arriva sempre un'immagine. I video di YouTube sono preparati come HLS H.264+AAC (il formato che Google Cast
  legge meglio); la musica arriva come video "badge" con copertina, titolo e artista. Se il video non è disponibile
  o non si prepara, parte il badge. (Impostazioni: "Musica sulla TV: mostra il video di YouTube".)
- Video nel browser: l'audio viene sempre convertito in AAC; nel Registro le righe [video] dicono da dove arriva.
- Nuovo pacchetto font per scrivere il titolo sul badge.

# 1.4.9
- "Invalid media type audio/mp4 … Only app and channel are supported": per il video si usa solo la TV di Google Cast
  (o DLNA), mai l'integrazione Sony Bravia/Android TV, che accetta solo app e canali. Se un'entità rifiuta il link,
  viene esclusa e la stanza riceve comunque l'audio.
- Sulla TV arriva sempre il video, anche per la musica; la copertina solo se il video non c'è o se lo scegli
  nelle Impostazioni ("Musica sulla TV: solo copertina").

# 1.4.8
- "Video non disponibile, riproduco solo l'audio": quando YouTube non dà più lo stream unico audio+video,
  Tubetto Server prende video (H.264, fino a 480p) e audio separati e li unisce con ffmpeg. Vale per il browser e la TV.
- Stanze doppie con nomi simili ("TV dello studio" e "TV STUDIO"): ora sono un'unica voce.

# 1.4.7
- Video neri (solo audio) nel browser e sulla TV: si sceglie solo video H.264, quello che leggono tutti; se YouTube
  dà video e audio separati, ffmpeg li unisce.
- In casa il tasto ▶/⏹ ferma tutte le uscite scelte o rimanda il brano corrente (niente più "does not support
  action media_player.media_play" con le TV che non hanno play/pausa).
- Comandi verso più uscite: se una non supporta un comando, le altre lo ricevono comunque.

# 1.4.6
- Risolto di nuovo "does not support action music_assistant.play_media": i player di Music Assistant si riconoscono
  anche dagli attributi; una stanza rifiutata da Music Assistant viene segnata e ritentata subito via Cast.
- Le TV ricevono sempre direttamente (Cast): i video come video; la musica come copertina con titolo
  (o come video, se scelto nelle Impostazioni). Se il video non è disponibile arriva l'audio con la copertina.
- Menu delle uscite più semplice: Questo dispositivo, le stanze, Ferma la musica in casa, Suona nelle stanze scelte.

# 1.4.5
- Passando da un video all'altro (o da video a canzone) sulla TV, il trasferimento precedente viene fermato prima
  di mandare il nuovo: la TV non risulta più occupata.
- 🎧 + 🏠 insieme: nel menu delle uscite "Questo dispositivo" è una casella che si può spuntare insieme alle stanze.
  La musica suona nelle stanze e anche qui; il pulsante mostra 🏠🎧.

# 1.4.4
- Risolto "does not support action music_assistant.play_media": se la stanza scelta è la TV vista direttamente
  da Home Assistant (Cast) e non un player di Music Assistant, video, brani, playlist e radio le arrivano via Cast,
  con avanti/indietro e passaggio automatico al brano dopo gestiti da Tubetto Server.

# 1.4.3
- Righe di copertine sfogliabili col mouse: tieni premuto e trascina a destra/sinistra.
- Risolto "Casa: URI malformed" con i titoli che contengono emoji.
- 📺 Con una TV scelta arriva il VIDEO anche per i brani musicali (prima andavano solo come audio).
  Si può tornare al solo audio dal menu delle uscite: "📺 Sulle TV mostra il video".
- Dal PC meno salti: se lo stream si interrompe o si blocca, riprende dallo stesso punto prima di passare al successivo.

# 1.4.2
- 📺 Video sulla TV: la TV riceveva un link con il nome interno dell'add-on (raggiungibile solo da Music Assistant)
  e diceva "impossibile riprodurre". Ora il link usa l'IP di casa di Home Assistant e la porta 8099, aperta di default.
- Con il video sulla TV, play/pausa/volume/posizione vanno alla TV; avanti/indietro passano al video dopo o prima,
  e a fine video parte il successivo.
- Niente più "HTTP 500 The queue is empty": se Music Assistant ha svuotato la coda, il play la rimanda da dove eri.

# 1.4.1
- Uscite "in casa" senza doppioni: un solo elemento per stanza anche se Home Assistant ha lo stesso dispositivo
  più volte (Cast, DLNA, AirPlay…).
- 📺 **Video sulla TV**: per le TV (Chromecast/Cast in Home Assistant) un video viene mandato come VIDEO, non più solo audio.
  Anche i film di Internet Archive.
- Titolo leggibile in Music Assistant (niente più "%20" al posto degli spazi).

