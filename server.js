require('dotenv').config(); // Carrega variáveis do .env
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { google } = require('googleapis');
const logger = require('./src/logger');
const { handleIncomingMessage } = require('./src/chatbot');
const { getDb } = require('./src/database');
const { getAuthenticatedCalendarClient } = require('./src/calendar');

const app = express();
const PORT = process.env.PORT || 3000;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

// --- Middlewares ---
app.use(bodyParser.json({
    verify: (req, res, buf) => { req.rawBody = buf.toString(); }
}));

// Ambiente
if (process.env.NODE_ENV === 'production') {
    logger.info('🚀 Rodando em modo de PRODUÇÃO');
} else {
    logger.info('🧪 Rodando em modo de DESENVOLVIMENTO');
}

/**
 * 🔐 Valida o token da Meta (verifica se ainda é válido)
 */
async function validateWhatsAppToken(token) {
    try {
        const resp = await axios.get(`https://graph.facebook.com/v20.0/me?access_token=${token}`);
        logger.info('Token da Meta válido', { app_id: resp.data.id });
        return true;
    } catch (err) {
        logger.warn('Token da Meta expirado ou inválido.', { error: err.message });
        return false;
    }
}

/**
 * 🗓️ Cria um calendário Google automaticamente se o cliente ainda não tiver um
 */
async function ensureClientCalendar(clientInfo, db) {
    try {
        if (!clientInfo.google_credentials) {
            logger.warn(`Cliente ${clientInfo.business_name} sem credenciais Google.`);
            return;
        }

        const googleCredentials = JSON.parse(clientInfo.google_credentials);
        const calendar = getAuthenticatedCalendarClient(googleCredentials);

        if (!clientInfo.calendar_id) {
            const response = await calendar.calendars.insert({
                requestBody: {
                    summary: clientInfo.business_name || 'Novo Estabelecimento',
                    timeZone: 'America/Sao_Paulo'
                }
            });

            const newCalendarId = response.data.id;
            await db.run(
                'UPDATE clients SET calendar_id = ? WHERE id = ?',
                [newCalendarId, clientInfo.id]
            );
            logger.info(`✅ Calendário criado automaticamente para ${clientInfo.business_name}`);
        }
    } catch (err) {
        logger.error('Erro ao criar calendário automático', { error: err.message });
    }
}

// --- GET /webhook --- (Verificação inicial do Meta)
app.get('/webhook', (req, res) => {
    logger.info('Recebido pedido de verificação de webhook GET');
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
            logger.info('Webhook verificado com sucesso!');
            res.status(200).send(challenge);
        } else {
            logger.warn('Falha na verificação do webhook: Token inválido.');
            res.sendStatus(403);
        }
    } else {
        logger.warn('Falha na verificação do webhook: Faltando mode ou token.');
        res.sendStatus(400);
    }
});

// --- POST /webhook --- (Recebe mensagens do WhatsApp)
app.post('/webhook', (req, res) => {
    const signature = req.headers['x-hub-signature-256'];

    // --- Validação opcional de assinatura ---
    if (WHATSAPP_APP_SECRET && signature) {
        const expectedSignature = 'sha256=' + crypto
            .createHmac('sha256', WHATSAPP_APP_SECRET)
            .update(req.rawBody)
            .digest('hex');

        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
            logger.warn('Assinatura inválida no webhook da Meta.');
            return res.sendStatus(403);
        }
    }

    const body = req.body;
    if (body.object === 'whatsapp_business_account') {
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const from = message?.from || 'desconhecido';
        const type = message?.type || 'indefinido';

        logger.info('Mensagem recebida do WhatsApp', { from, type });

        setImmediate(() => {
            handleIncomingMessage(body).catch(error => {
                logger.error('Erro não tratado no handleIncomingMessage', { error: error.message });
            });
        });

        res.sendStatus(200);
    } else {
        logger.warn('Payload POST não reconhecido', { objectType: body.object });
        res.sendStatus(404);
    }
});

// --- Rota de teste ---
app.get('/', (req, res) => {
    res.send('Servidor do Chatbot está ativo!');
});

// --- Iniciar servidor ---
app.listen(PORT, async () => {
    logger.info(`🌐 Servidor webhook iniciado na porta ${PORT}`);

    // Verifica token da Meta
    if (META_ACCESS_TOKEN) {
        await validateWhatsAppToken(META_ACCESS_TOKEN);
    } else {
        logger.warn('Nenhum META_ACCESS_TOKEN definido no .env');
    }

    // Inicializa o banco e cria calendários se necessário
    try {
        const db = await getDb();
        const clients = await db.all('SELECT * FROM clients');
        for (const client of clients) {
            await ensureClientCalendar(client, db);
        }
    } catch (dbError) {
        logger.error("Falha ao inicializar o BD no arranque do servidor.", { error: dbError.message });
        process.exit(1);
    }
});

// --- Encerramento gracioso ---
process.on('SIGINT', async () => {
    logger.info('🛑 Encerrando servidor...');
    const db = await getDb();
    if (db && typeof db.close === 'function') {
        await db.close();
        logger.info('Conexão do BD fechada com sucesso.');
    }
    process.exit(0);
});
