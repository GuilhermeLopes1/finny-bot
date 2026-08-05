# Changelog V39 — FinnyBot/backend

## Pagamentos

- Autenticação Firebase obrigatória em assinatura, PIX e cancelamento.
- Identidade resolvida no servidor.
- Cancelamento confere propriedade da assinatura e referência externa.
- Rate limiting nas rotas sensíveis.

## Webhook Mercado Pago

- Validação HMAC de `x-signature`.
- Processamento aguardado antes da resposta.
- Idempotência com coleção própria de eventos.
- Validação de valor, moeda e vínculo do pagamento.

## AlloPoints e ranking

- Pontos concedidos exclusivamente pelo backend.
- Validação do evento de origem e atualização transacional.
- Ranking mensal recuperável e idempotente.
- Prêmio acrescenta 30 dias à expiração existente.

## Estrutura V39

- Serviço de hidratação e migração para subcoleções.
- FinnyBot, análises e notificações compatíveis com contas V39.
- Novas transações do bot são gravadas em subcoleção.

## Privacidade e administração

- API administrativa autenticada e paginada.
- Retorno reduzido a dados de conta/assinatura.
- Avisos filtrados no servidor.

## Datas e estabilidade

- Datas civis no fuso `America/Sao_Paulo`.
- Intervalos mensais sem avanço indevido por UTC.
- Logger com fallback seguro em testes.
- Novos testes de segurança e armazenamento.
