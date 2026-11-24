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
