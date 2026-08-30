require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

// ─── Persistência de sessão no Supabase ──────────────────────────────────────

async function carregarSessaoDoSupabase(psicologoId) {
  const { data } = await supabase
    .from('whatsapp_sessions')
    .select('session_data')
    .eq('psicologo_id', psicologoId)
    .single();
  return data?.session_data ?? null;
}

async function salvarSessaoNoSupabase(psicologoId, sessionData) {
  await supabase
    .from('whatsapp_sessions')
    .upsert({
      psicologo_id: psicologoId,
      session_data: sessionData,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'psicologo_id' });
}

async function criarAuthState(psicologoId) {
  const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

  const dadosSalvos = await carregarSessaoDoSupabase(psicologoId);

  let creds = dadosSalvos?.creds
    ? JSON.parse(JSON.stringify(dadosSalvos.creds), BufferJSON.reviver)
    : initAuthCreds();

  let keys = dadosSalvos?.keys ?? {};

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          let value = keys[`${type}-${id}`];
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value;
        }
        return data;
      },
      set: async (data) => {
        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const value = data[category][id];
            const key = `${category}-${id}`;
            if (value) {
              keys[key] = value;
            } else {
              delete keys[key];
            }
          }
        }
        await salvarSessaoNoSupabase(psicologoId, {
          creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
          keys,
        });
      },
    },
  };

  const saveCreds = async () => {
    await salvarSessaoNoSupabase(psicologoId, {
      creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
      keys,
    });
  };

  return { state, saveCreds };
}

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
  const { state, saveCreds } = await criarAuthState(psicologoId);
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
        console.log(`[${psicologoId}] Reconectando... Motivo:`, JSON.stringify(lastDisconnect?.error?.output?.payload || lastDisconnect?.error?.message || lastDisconnect?.error));
        setTimeout(() => iniciarSessao(psicologoId), 5000);
      } else {
        console.log(`[${psicologoId}] Desconectado pelo usuário.`);
        delete sessions[psicologoId];

        await supabase
          .from('configuracoes_perfil')
          .update({ whatsapp_conectado: false })
          .eq('psicologo_id', psicologoId);

        // Limpa credenciais inválidas — sem isso, a próxima tentativa de
        // reconexão trava (408) porque o Baileys tenta reusar uma sessão
        // que o WhatsApp já revogou do lado dele.
        await supabase
          .from('whatsapp_sessions')
          .delete()
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
  res.json({ ok: true });
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

  await supabase
    .from('whatsapp_sessions')
    .delete()
    .eq('psicologo_id', psicologo_id);

  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  await reconectarSessoes();
});
