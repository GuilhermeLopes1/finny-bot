# Allo Finanças API

Backend do Allo Finanças para pagamentos, importação de faturas, Allofy, AlloPoints, notificações push e administração segura do Firebase Authentication.

## Execução

```bash
npm install
npm start
```

O serviço exige as credenciais do Firebase Admin e as chaves dos provedores usados em produção. Consulte `.env.example` e configure os segredos no ambiente de hospedagem, sem adicioná-los ao repositório.

## Rotas principais

- `GET /health` — saúde da API
- `GET /pricing` — preços dos planos
- `POST /create-payment` e `POST /create-payment-pix` — pagamentos
- `POST /webhook-mp` — retorno do Mercado Pago
- `POST /import-pdf` — importação de fatura
- `POST /ai-analysis` — análise financeira
- `POST /allofy-chat` — assistente financeiro por texto
- `GET /admin/health` — saúde da integração administrativa
- `GET /admin/users` — metadados reais das contas do Firebase Authentication
- `GET /admin/users/:uid` — identidade e acesso de uma conta
- `POST /admin/users/:uid/action` — bloquear, revogar sessões, verificar e-mail, atualizar ou excluir conta

Todas as rotas `/admin/*` exigem um token Firebase válido e conferem no servidor se o usuário possui o papel `admin`. As ações sensíveis também são registradas em `admin_logs`.

As integrações de mensageria e áudio foram removidas. O nome público da API permanece independente do domínio atual de hospedagem, preservando a compatibilidade com o aplicativo.
