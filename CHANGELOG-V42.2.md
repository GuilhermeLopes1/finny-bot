# CHANGELOG V42.2 — vínculo seguro Google Play ↔ conta Allofy

## Objetivo
Corrigir o caso em que uma nova assinatura/resassinatura herdava um `linkedPurchaseToken` historicamente associado ao UID errado e era bloqueada com HTTP 409, mesmo com o usuário correto autenticado no Allofy.

## Mudanças

- O **token atual** continua sendo imutável: se já pertence a outro UID, a API bloqueia a tentativa.
- `linkedPurchaseToken` passa a ser tratado como **histórico**, não como autorização absoluta para sobrescrever o usuário atual.
- Uma exceção segura e curta existe apenas para uma **compra realmente nova**, ainda não reconhecida (`ACK_PENDING`) e iniciada recentemente (30 minutos por padrão). Nesse caso o novo token pode ser vinculado ao UID Firebase autenticado que acabou de concluir o checkout.
- Restaurações antigas e compras já reconhecidas **não podem trocar de UID automaticamente**.
- O token histórico divergente é marcado como substituído e deixa de conceder direito Pro ao UID antigo.
- O backend passa a registrar `ownershipVersion`, `ownershipSource`, `ownerUidHash`, datas de verificação e dados de auditoria de substituição.
- Para re-assinaturas, o acknowledge tenta enviar `externalAccountIds.obfuscatedAccountId` (SHA-256 do UID com namespace Allofy). Se a Google Play não aceitar esse metadado naquele fluxo, o ACK é repetido sem o campo para não perder a compra.
- Nova coleção interna `google_play_account_links` relaciona o identificador ofuscado ao UID para ajudar RTDN e futuras resassinaturas.
- RTDN agora tenta resolver o usuário por `externalAccountIdentifiers` antes de herdar um token histórico.
- RTDN **não herda UID de registros legados sem `ownershipVersion: 2`**; nesses casos a notificação fica órfã até uma verificação autenticada, evitando que um vínculo antigo incorreto contamine a nova compra.
- Adicionados códigos de conflito específicos:
  - `google_play_token_owner_mismatch`
  - `google_play_linked_owner_mismatch`
  - `google_play_external_account_mismatch`
- `GOOGLE_PLAY_FRESH_PURCHASE_WINDOW_MINUTES=30` é configurável entre 5 e 180 minutos.

## Segurança

A V42.2 **não permite restauração de uma assinatura já reconhecida para outra conta**. A transferência automática só pode ocorrer na criação de um token novo, ainda não reconhecido e recente, mantendo a proteção contra reaproveitamento de tokens.

Nenhum e-mail, senha, purchase token ou chave privada é usado como identificador público de conta.
