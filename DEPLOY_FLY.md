# Deploy no Fly.io — vitallink-whatsapp-server

## Pré-requisitos
- Fly CLI instalado (`curl -L https://fly.io/install.sh | sh` no Mac/Linux, ou `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"` no Windows)
- Cartão de crédito cadastrado na conta Fly.io (necessário desde out/2024, não existe mais free tier permanente para contas novas)

## Passo a passo

### 1. Login

fly auth login

Abre o navegador para autenticar.

### 2. Criar o app no Fly (primeira vez apenas)
Rode dentro da pasta do repositório, na raiz (onde está o fly.toml):

fly launch --no-deploy

Quando perguntar se quer usar o fly.toml existente, responda **sim**. Isso registra o app "vitallink-whatsapp-server" na sua conta sem fazer deploy ainda.

### 3. Configurar os secrets (variáveis sensíveis)

fly secrets set SUPABASE_URL="https://tspcxpsskdxdrxqwsgos.supabase.co"
fly secrets set SUPABASE_SERVICE_ROLE_KEY="sua_chave_aqui"
fly secrets set SERVER_SECRET="vitallink_ws_2026"

(Troque pelos valores reais — não commite esses valores no git.)

### 4. Deploy

fly deploy

Isso builda a imagem Docker e sobe a máquina já configurada para nunca dormir (auto_stop_machines = off, min_machines_running = 1 no fly.toml).

### 5. Testar o health check

curl https://vitallink-whatsapp-server.fly.dev/health

Deve retornar `{"ok":true}` rapidamente (sem o atraso de 50s+ que via no Render).

### 6. Atualizar a Vercel
No painel do projeto `vitallink` na Vercel, trocar a env var:

WHATSAPP_SERVER_URL=https://vitallink-whatsapp-server.fly.dev

Depois, redeploy do frontend para aplicar.

### 7. Testar o fluxo completo
VitalLink → Configurações → WhatsApp → escanear QR Code → enviar mensagem de teste.

### 8. Desligar o Render
Só depois de confirmar que tudo funciona no Fly.io por alguns dias — suspenda ou delete o serviço `vitallink-whatsapp-server` no Render.

## Custo esperado
Máquina shared-cpu-1x com 512MB sempre ligada: ~$2-5/mês, dependendo da região e uso de banda.
