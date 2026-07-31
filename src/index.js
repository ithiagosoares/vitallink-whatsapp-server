require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SERVER_SECRET = process.env.SERVER_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Armazena sessões ativas em memória
const sessions = {};

// Middleware de autenticação
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== SERVER_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// Inicia ou reconecta uma sessão WhatsApp
async function iniciarSessao(psicologoId) {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${psicologoId}`);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sessions[psicologoId] = { sock, qr: null, conectado: false };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrBase64 = await QRCode.toDataURL(qr);
      sessions[psicologoId].qr = qrBase64;
      sessions[psicologoId].conectado = false;
    }

    if (connection === 'open') {
      sessions[psicologoId].conectado = true;
      sessions[psicologoId].qr = null;
      console.log(`[${psicologoId}] Conectado!`);

      // Salva status no Supabase
      await supabase
        .from('configuracoes_perfil')
        .upsert({
          psicologo_id: psicologoId,
          whatsapp_conectado: true,
          updated_at: new Date().toISOString()
        }, { onConflict: 'psicologo_id' });
    }

    if (connection === 'close') {
      sessions[psicologoId].conectado = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`[${psicologoId}] Reconectando...`);
        setTimeout(() => iniciarSessao(psicologoId), 5000);
      } else {
        console.log(`[${psicologoId}] Desconectado pelo usuário.`);
        delete sessions[psicologoId];

        await supabase
          .from('configuracoes_perfil')
          .update({ whatsapp_conectado: false })
          .eq('psicologo_id', psicologoId);
      }
    }
  });

  return sock;
}

// Reconecta sessões existentes ao iniciar o servidor
async function reconectarSessoes() {
  const { data } = await supabase
    .from('configuracoes_perfil')
    .select('psicologo_id')
    .eq('whatsapp_conectado', true);

  for (const config of data ?? []) {
    console.log(`Reconectando sessão: ${config.psicologo_id}`);
    await iniciarSessao(config.psicologo_id);
  }
}

// ─── ROTAS ───────────────────────────────────────────────────────────────────

// Health check (mantém o Render acordado)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: Object.keys(sessions).length });
});

// Gera QR Code para conectar
app.post('/connect', auth, async (req, res) => {
  const { psicologo_id } = req.body;
  if (!psicologo_id) return res.status(400).json({ error: 'psicologo_id obrigatório' });

  await iniciarSessao(psicologo_id);

  // Aguarda o QR ser gerado (até 10s)
  let tentativas = 0;
  while (!sessions[psicologo_id]?.qr && tentativas < 20) {
    await new Promise(r => setTimeout(r, 500));
    tentativas++;
  }

  if (!sessions[psicologo_id]?.qr) {
    return res.status(408).json({ error: 'Timeout ao gerar QR Code' });
  }

  res.json({ qr: sessions[psicologo_id].qr });
});

// Verifica status da conexão
app.get('/status/:psicologo_id', auth, (req, res) => {
  const { psicologo_id } = req.params;
  const session = sessions[psicologo_id];
  res.json({
    conectado: session?.conectado ?? false,
    tem_qr: !!session?.qr
  });
});

// Envia mensagem
app.post('/send', auth, async (req, res) => {
  const { psicologo_id, numero, mensagem } = req.body;

  const session = sessions[psicologo_id];
  if (!session?.conectado) {
    return res.status(400).json({ error: 'WhatsApp não conectado para este psicólogo' });
  }

  try {
    const numeroFormatado = `${numero.replace(/\D/g, '')}@s.whatsapp.net`;
    await session.sock.sendMessage(numeroFormatado, { text: mensagem });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Desconecta sessão
app.post('/disconnect', auth, async (req, res) => {
  const { psicologo_id } = req.body;
  const session = sessions[psicologo_id];

  if (session) {
    await session.sock.logout();
    delete sessions[psicologo_id];
  }

  await supabase
    .from('configuracoes_perfil')
    .update({ whatsapp_conectado: false })
    .eq('psicologo_id', psicologo_id);

  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  await reconectarSessoes();
});
