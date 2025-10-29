// test_meta_api.js
require('dotenv').config(); // Carrega variáveis do .env
const axios = require('axios');

// --- CONFIGURAÇÕES DO TESTE ---
// Usa diretamente as variáveis do .env principal do bot
const MY_BUSINESS_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || null;
const MY_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || null;

// !! IMPORTANTE !! Defina o número PARA O QUAL enviar a mensagem de teste
// Pode colocar diretamente aqui ou criar uma variável no .env como TEST_RECIPIENT_WAID
const RECIPIENT_PHONE_NUMBER = process.env.TEST_RECIPIENT_WAID || "555191428281"; // SUBSTITUA OU USE .env

const GRAPH_API_VERSION = 'v20.0'; // Ou a versão que estiver a usar
// --- FIM DAS CONFIGURAÇÕES ---

async function testMetaApiSendMessage() {
    console.log('--- Iniciando Teste de Envio de Mensagem via Meta API ---');
    console.log('   (Usando WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN do .env)');

    // Validação inicial das configurações
    if (!MY_BUSINESS_PHONE_ID) {
        console.error('❌ ERRO: Variável WHATSAPP_PHONE_NUMBER_ID não definida no .env ou está vazia.');
        return;
    }
    if (!MY_ACCESS_TOKEN) {
        console.error('❌ ERRO: Variável WHATSAPP_ACCESS_TOKEN não definida no .env ou está vazia.');
        return;
    }
    if (!RECIPIENT_PHONE_NUMBER || RECIPIENT_PHONE_NUMBER === "SEU_NUMERO_WHATSAPP_AQUI") {
        console.error('❌ ERRO: Número do Destinatário (RECIPIENT_PHONE_NUMBER) não definido.');
        console.log('   -> Defina a variável TEST_RECIPIENT_WAID no .env ou edite o script.');
        console.log('   -> Use o formato internacional sem +, ex: 555191428281');
        return;
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${MY_BUSINESS_PHONE_ID}/messages`;

    const messageData = {
        messaging_product: "whatsapp",
        to: String(RECIPIENT_PHONE_NUMBER).replace(/\D/g, ''), // Garante que só tem números
        type: "text",
        text: {
            preview_url: false,
            body: `✅ Mensagem de teste da API Meta (via script) - ${new Date().toLocaleTimeString()}`
        }
    };

    console.log(`\n📞 Enviando de (WHATSAPP_PHONE_NUMBER_ID): ${MY_BUSINESS_PHONE_ID}`);
    console.log(`➡️ Para (RECIPIENT_PHONE_NUMBER/TEST_RECIPIENT_WAID): ${messageData.to}`);
    console.log(`🔑 Usando Token (WHATSAPP_ACCESS_TOKEN): ${MY_ACCESS_TOKEN.substring(0, 10)}...`);

    try {
        const response = await axios.post(url, messageData, {
            headers: {
                'Authorization': `Bearer ${MY_ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000 // Aumentar timeout para teste
        });

        console.log('\n✅ SUCESSO! A API da Meta aceitou a mensagem.');
        console.log('   -> Resposta da Meta:', JSON.stringify(response.data, null, 2));
        console.log('\n   Verifique se a mensagem chegou no seu WhatsApp.');

    } catch (error) {
        console.error('\n❌ FALHA! A API da Meta retornou um erro.');
        if (error.response) {
            // Erro veio da API da Meta
            console.error('   -> Status:', error.response.status);
            console.error('   -> Erro Detalhado da Meta:', JSON.stringify(error.response.data, null, 2));
             if (error.response.data?.error?.code === 10) {
                console.error('\n   🚨 CAUSA PROVÁVEL (Erro #10):');
                console.error('      - Token (WHATSAPP_ACCESS_TOKEN) inválido/expirado.');
                console.error('      - Token sem permissão "whatsapp_business_messaging".');
                console.error('      - App Meta em Modo Desenvolvimento E destinatário não é Testador.');
                console.error('      - ID do Número de Telefone (WHATSAPP_PHONE_NUMBER_ID) errado.');
            } else if (error.response.data?.error?.code === 100) {
                 console.error('\n   🚨 CAUSA PROVÁVEL (Erro #100):');
                 console.error('      - Parâmetro inválido (verifique "to", "type", etc.).');
                 console.error('      - Número do destinatário em formato incorreto ou inválido para WhatsApp.');
            } else if (error.response.data?.error?.code === 131000 || error.response.data?.error?.code === 131053 ) {
                 console.error('\n   🚨 CAUSA PROVÁVEL (Erro de Número):');
                 console.error('      - O número de telefone do destinatário não tem WhatsApp ou está incorreto.');
                 console.error('      - Verifique se o formato está correto (ex: 555191428281).');
            }
        } else if (error.request) {
            console.error('   -> Erro: Sem resposta da Meta (timeout ou problema de rede?).', error.message);
        } else {
            console.error('   -> Erro de Configuração:', error.message);
        }
    } finally {
        console.log('\n--- Teste Concluído ---');
    }
}

// Executa a função de teste
testMetaApiSendMessage();