# Tubetto Server

YouTube e YouTube Music per tutta la casa, senza pubblicità.

## Configurazione
- **github_repo**: `mariopinola10/Tubetto` (lo stesso dell'app).
- **github_token**: lo stesso token dell'app (fine-grained, solo repo Tubetto, *Contents: Read and write*).
  Serve per la libreria sincronizzata e per la configurazione dei client aggiornata in automatico.
- **audio_quality**: `high` (fino a ~256 kbps) o `medium` (~128 kbps).
- **api_key**: lascia vuoto, ne viene creata una (la trovi nel Registro dell'add-on).
- **stream_base_url**: lascia vuoto. Solo se Music Assistant non riesce a leggere gli stream,
  metti `http://192.168.1.186:8097`.

## Uso
- **Pannello laterale "Tubetto"** in Home Assistant, anche dall'app Home Assistant sul telefono
  e da fuori casa tramite Tailscale. Niente pubblicità: l'audio passa dal Raspberry.
- **🎧 / 🏠 nella barra in basso**: scegli dove suonare.
  - 🎧 Questo dispositivo: suona nel browser o nell'app che stai usando.
  - 🏠 Stanze: spunta uno o più player di Music Assistant e tocca "Suona nelle stanze scelte".
    Con più stanze, Music Assistant le raggruppa e le sincronizza (se i player lo supportano).

## Note
- I brani mandati in casa sono gestiti da Music Assistant: la coda continua anche chiudendo il browser.
- Se YouTube cambia qualcosa: Impostazioni (⚙) mostra lo stato; il workflow "Salute Tubetto"
  aggiorna i client in automatico ogni 6 ore.
