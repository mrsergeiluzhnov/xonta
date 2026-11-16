# xonta.dev pages

Static pages served at xonta.dev.

- `passport/index.html` — agent passport check. Open `https://xonta.dev/passport/?id=ag_…` (agent on orchestrator.xonta.dev) or `?p=<passport URL>` for any compatible orchestrator. The page downloads the passport, resolves the issuer's did:web, checks every eddsa-jcs-2022 signature with WebCrypto, reads the Bitstring Status Lists and the validity dates. Nothing is sent anywhere else. Needs a browser with Ed25519 in WebCrypto (Chrome 137+, Firefox 129+, Safari 17+).

Страница проверки паспорта агента: `https://xonta.dev/passport/?id=ag_…` или `?p=<адрес паспорта>` для любого совместимого оркестратора. Подписи, сроки и списки отзыва проверяются в браузере, на сторонние серверы ничего не уходит.
