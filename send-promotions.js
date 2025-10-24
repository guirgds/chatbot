// REMOVIDO: const { Client } = require('whatsapp-web.js');
// REMOVIDO: const qrcode = require('qrcode-terminal');
const logger = require('./src/logger'); // Assumindo que o logger está em src/logger.js
const { getDb, findInactiveCustomers, getClientByPhoneId /* Ou uma nova função getAllClients */ } = require('./src/database'); // Importar funções refatoradas do BD
const { sendWhatsAppMessage } = require('./src/chatbot'); // Importar a função de envio (a ser implementada)

// --- CONFIGURAÇÕES DA CAMPANHA ---
const INACTIVITY_DAYS = 90; // Dias para considerar um cliente inativo
const MESSAGE_DELAY_MS = 5000; // Tempo de espera entre mensagens (manter um delay é bom)
const PROMO_TEMPLATE_NAME = 'volta_cliente_10_off'; // NOME EXATO do Template pré-aprovado na Meta
const PROMO_TEMPLATE_LANGUAGE = 'pt_BR'; // Código do idioma do Template

// Função principal da campanha
async function runPromotionCampaign() {
    logger.info('🚀 Iniciando campanha de promoções...');
    let db;
    try {
        db = await getDb(); // Garante que o BD está inicializado

        // 1. Buscar TODOS os seus clientes (negócios) ativos na plataforma
        // TODO: Implementar uma função `getAllActiveClients` no database.js
        const allClients = await db.allAsync('SELECT * FROM clients WHERE whatsapp_token IS NOT NULL'); // Exemplo simples
        logger.info(`🏢 Encontrados ${allClients.length} clientes (negócios) ativos.`);

        if (allClients.length === 0) {
            logger.info('Nenhum negócio ativo para enviar promoções.');
            return;
        }

        let totalSentCount = 0;
        let totalErrorCount = 0;
        let totalInactiveFound = 0;

        // 2. Iterar sobre cada cliente (negócio)
        for (const client of allClients) {
            logger.info(`--- Iniciando campanha para: ${client.business_name} (ID: ${client.id}) ---`);

            // Validar se o cliente tem as configurações necessárias
            if (!client.whatsapp_phone_id || !client.whatsapp_token) {
                 logger.warn(`Cliente ${client.business_name} sem whatsapp_phone_id ou token. Pulando.`);
                 continue;
            }

            // 3. Buscar clientes finais inativos PARA ESTE NEGÓCIO
            const inactiveCustomers = await findInactiveCustomers(client.id, INACTIVITY_DAYS);
            totalInactiveFound += inactiveCustomers.length;

            if (inactiveCustomers.length === 0) {
                logger.info(`📭 Nenhum cliente final inativo encontrado para ${client.business_name}.`);
                continue;
            }

            logger.info(`🎯 Encontrados ${inactiveCustomers.length} clientes finais inativos para ${client.business_name}.`);

            let clientSentCount = 0;
            let clientErrorCount = 0;

            // 4. Iterar sobre os clientes finais inativos e enviar a mensagem via Template
            for (const customer of inactiveCustomers) {
                try {
                    // O número do cliente final já deve estar no formato E.164 (ex: 555199998888) no BD
                    const customerPhoneNumber = customer.phone;
                    const customerName = customer.name || 'Cliente'; // Usar nome se houver

                    logger.info(`📤 Preparando envio para ${customerName} (${customerPhoneNumber}) [Negócio: ${client.business_name}]`);

                    // Construir o payload para a função de envio, usando o template
                    const messageData = {
                        messaging_product: "whatsapp",
                        to: customerPhoneNumber,
                        type: "template",
                        template: {
                            name: PROMO_TEMPLATE_NAME,
                            language: {
                                code: PROMO_TEMPLATE_LANGUAGE
                            },
                            // Componentes (variáveis do template) - AJUSTAR CONFORME SEU TEMPLATE
                            // Exemplo: Se o template for "Olá {{1}}! Use o cupom {{2}}..."
                            components: [
                                {
                                    type: "body",
                                    parameters: [
                                        { type: "text", text: customerName },         // Variável {{1}}
                                        { type: "text", text: "VOLTA10" }             // Variável {{2}}
                                        // Adicionar mais parâmetros se o template tiver mais variáveis
                                    ]
                                }
                                // Adicionar componentes de header ou buttons se o template os tiver
                            ]
                        }
                    };

                    // 5. Chamar a função de envio, passando o ID e Token do NEGÓCIO
                    await sendWhatsAppMessage(client.whatsapp_phone_id, client.whatsapp_token, messageData);

                    clientSentCount++;
                    logger.info(`✅ Enviado para ${customerName} (${customerPhoneNumber})`);

                    // Espera entre mensagens
                    await delay(MESSAGE_DELAY_MS);

                } catch (error) {
                    clientErrorCount++;
                    logger.error(`❌ Falha ao enviar para ${customer.name} (${customer.phone}) [Negócio: ${client.business_name}]`, { error: error.message || error });
                    // Espera um pouco mesmo em caso de erro
                    await delay(2000);
                }
            } // Fim do loop de clientes finais

            logger.info(`--- Resumo para ${client.business_name}: Enviados=${clientSentCount}, Erros=${clientErrorCount} ---`);
            totalSentCount += clientSentCount;
            totalErrorCount += clientErrorCount;

        } // Fim do loop de negócios (clientes da plataforma)

        logger.info(`\n📊 RESUMO GERAL DA CAMPANHA:`);
        logger.info(`✅ Total de mensagens enviadas: ${totalSentCount}`);
        logger.info(`❌ Total de erros: ${totalErrorCount}`);
        logger.info(`🎯 Total de clientes finais inativos encontrados: ${totalInactiveFound}`);

    } catch (dbError) {
        logger.error('❌ Erro crítico na campanha (provavelmente no acesso ao BD):', { error: dbError.message });
    } finally {
        logger.info('🔚 Campanha de promoções finalizada.');
        // Não precisamos mais destruir um cliente, pois não há conexão persistente.
        // Se o script for executado e terminar, o processo Node.js encerrará.
        // Considerar fechar a conexão do BD se `getDb` a mantiver aberta.
        const db = await getDb();
        if (db) await db.close(); // Exemplo de como fechar a conexão do SQLite
    }
}

// Executar a campanha
runPromotionCampaign();

// Exportar a função se quiser chamá-la de outro lugar (ex: agendador cron)
// module.exports = { runPromotionCampaign };