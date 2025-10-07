const client = require('./client');
const responses = require('./responses');
const { processMessage } = require('./messageProcessor');
const { createAppointment } = require('./calendar');
const { parseDate } = require('chrono-node'); // Biblioteca para interpretar datas

const delay = ms => new Promise(res => setTimeout(res, ms));
const knownCommands = new Set(['1', '2', '3']);

// Objeto para guardar o estado da conversa de cada cliente
const conversationState = {};

client.on('message', async msg => {
    if (!msg.from.endsWith('@c.us')) return;

    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const customerName = contact.pushname.split(" ")[0];
    const customerId = msg.from; // ID único do cliente

    const simulateTyping = async (duration = 2000) => {
        await chat.sendStateTyping();
        await delay(duration);
    };

    const messageBody = msg.body.trim();

    // ---- PARTE NOVA: LÓGICA DE AGENDAMENTO ----
    // Se o cliente já escolheu um serviço e está enviando a data/hora
    if (conversationState[customerId] && conversationState[customerId].step === 'awaiting_datetime') {
        const service = conversationState[customerId].service;
        
        // Tenta interpretar a data que o cliente enviou (ex: "amanhã às 10h")
        const appointmentDate = parseDate(messageBody, new Date(), { forwardDate: true });

        if (appointmentDate) { // Se a data for entendida com sucesso
            await simulateTyping();
            // Chama a função para criar o evento no Google Calendar
            const appointment = await createAppointment(appointmentDate.toISOString(), service, customerName);

            if (appointment) {
                await client.sendMessage(msg.from, `Pronto! Seu agendamento para *${service}* foi confirmado para ${appointmentDate.toLocaleString('pt-BR')}.`);
            } else {
                await client.sendMessage(msg.from, "Desculpe, não consegui fazer seu agendamento. Tente novamente mais tarde.");
            }
        } else { // Se não conseguir entender a data
            await client.sendMessage(msg.from, "Não consegui entender essa data e hora. Por favor, tente de novo (ex: 'hoje às 18h' ou '25/12 as 15:00').");
        }
        
        // Limpa o estado da conversa para o próximo agendamento
        delete conversationState[customerId];
        return;
    }
    // ---- FIM DA PARTE NOVA ----


    // Responde a saudações iniciais com o menu
    if (messageBody.match(/(oi|olá|menu|bom dia|boa tarde|boa noite)/i)) {
        await simulateTyping();
        await client.sendMessage(msg.from, responses.welcome(customerName));
        return;
    }

    // Responde aos comandos do menu e INICIA o agendamento
    if (knownCommands.has(messageBody)) {
        let service;
        switch (messageBody) {
            case '1': service = "Corte de Cabelo"; break;
            case '2': service = "Barba"; break;
            case '3': service = "Cabelo e Barba"; break;
        }

        // Guarda o estado da conversa para o próximo passo
        conversationState[customerId] = { step: 'awaiting_datetime', service: service };

        await simulateTyping();
        await client.sendMessage(msg.from, responses.serviceConfirmation(service));
        return;
    }

    // Se não for um comando, processa a mensagem para encontrar palavras-chave
    await simulateTyping();
    const response = processMessage(messageBody);
    await client.sendMessage(msg.from, response);
});