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

