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

