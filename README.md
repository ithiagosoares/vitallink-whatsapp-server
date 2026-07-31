# VitalLink WhatsApp Server

Servidor Baileys para gerenciar sessões WhatsApp do VitalLink.

## Variáveis de ambiente necessárias
- SERVER_SECRET — segredo para autenticar chamadas do VitalLink
- SUPABASE_URL — URL do projeto Supabase
- SUPABASE_SERVICE_ROLE_KEY — chave service role do Supabase

## Rotas
- GET /health — health check
- POST /connect — gera QR Code para conectar
- GET /status/:psicologo_id — verifica status da conexão
- POST /send — envia mensagem
- POST /disconnect — desconecta sessão

## Deploy
Hospedado no Render como Web Service.
