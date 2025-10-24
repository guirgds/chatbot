require('dotenv').config(); // Carrega as variáveis do ficheiro .env
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // Para validar a assinatura do webhook (Segurança)
const logger = require('./src/logger'); // O nosso logger
const { handleIncomingMessage } = require('./src/chatbot'); // A lógica do chatbot refatorada
// const { getDb } = require('./src/database'); // Para inicializar ou fechar o BD se necessário

const app = express();

// Middleware para parsear o corpo das requisições POST como JSON
// IMPORTANTE: Adicionar verify para guardar o corpo raw necessário para validação da assinatura
app.use(bodyParser.json({
    verify: (req, res, buf) => {
        req.rawBody = buf.toString(); // Guarda o corpo original (raw) na requisição
    }
}));

const PORT = process.env.PORT || 3000;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET; // Deverá obter isto do painel da Meta

// --- Rota GET /webhook ---
// Usada pela Meta APENAS na configuração inicial para verificar a sua URL
app.get('/webhook', (req, res) => {
    logger.info('Recebido pedido de verificação de webhook GET');

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // Verifica se mode e token estão presentes e se o token corresponde ao seu
    if (mode && token) {
        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
            logger.info('Webhook verificado com sucesso!');
            res.status(200).send(challenge);
        } else {
            // Se o token não corresponder, recusa
            logger.warn('Falha na verificação do webhook: Token inválido.');
            res.sendStatus(403); // Forbidden
        }
    } else {
        logger.warn('Falha na verificação do webhook: Faltando mode ou token.');
        res.sendStatus(400); // Bad Request
    }
});

// --- Rota POST /webhook ---
// Recebe as notificações de mensagens da Meta
app.post('/webhook', (req, res) => {
    const signature = req.headers['x-hub-signature-256'];

    // // ---- Validação da Assinatura (IMPORTANTE PARA PRODUÇÃO) ----
    // if (!WHATSAPP_APP_SECRET) {
    //     logger.warn('WHATSAPP_APP_SECRET não configurado. Pulando validação da assinatura.');
    // } else if (!signature) {
    //     logger.warn('Requisição POST sem assinatura X-Hub-Signature-256. Recusando.');
    //     return res.sendStatus(403); // Forbidden
    // } else {
    //     const expectedSignature = 'sha256=' + crypto
    //         .createHmac('sha256', WHATSAPP_APP_SECRET)
    //         .update(req.rawBody) // Usa o corpo raw que guardámos
    //         .digest('hex');

    //     if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    //         logger.warn('Assinatura X-Hub-Signature-256 inválida. Recusando.');
    //         return res.sendStatus(403); // Forbidden
    //     }
    //     logger.debug('Assinatura X-Hub-Signature-256 validada com sucesso.');
    // }
     // ---- Fim da Validação da Assinatura ----

    const body = req.body;

    // Verifica se é uma notificação do WhatsApp (pode receber outros webhooks aqui)
    if (body.object === 'whatsapp_business_account') {
        logger.debug('Recebido payload do WhatsApp:', { payload: body }); // Cuidado: pode logar dados sensíveis

        // Envia para o processador do chatbot
        // Envolvemos em setImmediate para responder à Meta rapidamente (status 200 OK)
        // e processar a mensagem "em background" (no próximo ciclo do event loop)
        setImmediate(() => {
            handleIncomingMessage(body).catch(error => {
                logger.error('Erro não tratado dentro do handleIncomingMessage', { error: error.message, stack: error.stack });
            });
        });

        // Responde IMEDIATAMENTE à Meta com 200 OK
        res.sendStatus(200);

    } else {
        // Se não for um payload esperado, ignora
        logger.warn('Recebido payload POST não reconhecido', { objectType: body.object });
        res.sendStatus(404); // Not Found
    }
});

// --- Rota de Teste ---
app.get('/', (req, res) => {
    res.send('Servidor do Chatbot está no ar!');
});

// --- Iniciar o Servidor ---
app.listen(PORT, async () => {
    logger.info(`Servidor webhook iniciado na porta ${PORT}`);
    // Opcional: Pode chamar getDb() aqui para garantir que o BD inicializa ao arrancar
    // try {
    //     await getDb();
    // } catch (dbError) {
    //     logger.error("Falha ao inicializar BD no arranque do servidor.", { error: dbError.message });
    //     // Considerar encerrar o processo se o BD for essencial
    //     // process.exit(1);
    // }
});

// Opcional: Lidar com encerramento gracioso (Ctrl+C) para fechar o BD
// process.on('SIGINT', async () => {
//     logger.info('Recebido SIGINT. Fechando servidor e BD...');
//     const db = await getDb(); // Obtém a instância
//     if (db && typeof db.close === 'function') {
//         await db.close();
//         logger.info('Conexão do BD fechada.');
//     }
//     process.exit(0);
// });