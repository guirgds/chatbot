const client = require('./client');
const responses = require('./responses');
const { processMessage } = require('./messageProcessor');
const { createAppointment, listAvailableSlots, listCustomerAppointments, cancelAppointment } = require('./calendar');
const { parseDate } = require('chrono-node');
const { saveCustomerVisit } = require('./database');
const logger = require('./logger'); // Importa o logger

const delay = ms => new Promise(res => setTimeout(res, ms));
const conversationState = {}; // Guarda o estado de cada usuário

// Função auxiliar para simular digitação
const simulateTyping = async (chat, duration = 1500) => {
    await chat.sendStateTyping();
    await delay(duration);
};

// Objeto que define o que fazer em cada estado
const stateHandlers = {
    // --- ESTADOS DE AGENDAMENTO ---
    async AWAITING_SERVICE_CHOICE(msg, state, customerId) {
        let service;
        switch(msg.body.trim()) {
            case '1': service = "Corte de Cabelo"; break;
            case '2': service = "Barba"; break;
            case '3': service = "Cabelo e Barba"; break;
            default:
                await client.sendMessage(customerId, "Opção inválida. Por favor, escolha 1, 2 ou 3.");
                return state;
        }
        state.step = 'AWAITING_DAY';
        state.service = service;
        await simulateTyping(await msg.getChat());
        await client.sendMessage(customerId, responses.askForDay(service));
        return state;
    },

    async AWAITING_DAY(msg, state, customerId) {
        const day = parseDate(msg.body.trim(), new Date(), { forwardDate: true });
        if (day) {
            await simulateTyping(await msg.getChat());
            const availableSlots = await listAvailableSlots(day);
            state.step = 'AWAITING_SLOT';
            state.availableSlots = availableSlots;
            await client.sendMessage(customerId, responses.showAvailableSlots(availableSlots));
        } else {
            await client.sendMessage(customerId, "Não consegui entender essa data. Tente de novo (ex: 'hoje', 'sábado').");
        }
        return state;
    },

    async AWAITING_SLOT(msg, state, customerId) {
        const choice = parseInt(msg.body.trim(), 10) - 1;
        if (choice >= 0 && choice < state.availableSlots.length) {
            const chosenSlot = state.availableSlots[choice];
            state.step = 'AWAITING_FINAL_CONFIRMATION';
            state.chosenSlot = chosenSlot;
            await simulateTyping(await msg.getChat());
            await client.sendMessage(customerId, responses.appointmentSummary(state.service, chosenSlot));
        } else {
            await client.sendMessage(customerId, "Opção inválida. Digite o número de um dos horários.");
        }
        return state;
    },

    async AWAITING_FINAL_CONFIRMATION(msg, state, customerId, customerName) {
        if (msg.body.trim() === '1') {
            await simulateTyping(await msg.getChat());
            try {
                const appointment = await createAppointment(state.chosenSlot.toISOString(), state.service, customerName);
                await client.sendMessage(customerId, responses.appointmentConfirmed(state.service, state.chosenSlot));
                saveCustomerVisit(customerId, customerName, state.chosenSlot.toISOString());
            } catch (error) {
                if (error.message === 'CONFLICT') {
                    await client.sendMessage(customerId, "❌ Ops! Alguém agendou neste horário. Digite 'menu' para recomeçar.");
                } else { // API_ERROR ou outro erro
                    await client.sendMessage(customerId, "❌ Desculpe, estou com um problema para me conectar à agenda. Tente novamente mais tarde.");
                }
            }
        } else {
            await simulateTyping(await msg.getChat());
            await client.sendMessage(customerId, "Ok, agendamento cancelado. Digite 'menu' para recomeçar.");
        }
        return null;
    },

    // --- ESTADOS DE CANCELAMENTO E ALTERAÇÃO ---
    async AWAITING_CANCELLATION_CONFIRMATION(msg, state, customerId) {
        if (msg.body.trim() === '1') {
            await simulateTyping(await msg.getChat());
            try {
                await cancelAppointment(state.appointmentToCancel.id);
                await client.sendMessage(customerId, responses.appointmentCancelled);
            } catch (error) {
                await client.sendMessage(customerId, "❌ Ops! Ocorreu um erro e não consegui cancelar seu agendamento.");
            }
        } else {
            await simulateTyping(await msg.getChat());
            await client.sendMessage(customerId, "Ok, seu agendamento está mantido! 😉");
        }
        return null;
    },

    async AWAITING_CHANGE_CHOICE(msg, state, customerId) {
        const choice = parseInt(msg.body.trim(), 10) - 1;
        if (choice >= 0 && choice < state.appointments.length) {
            const appointmentToChange = state.appointments[choice];
            await simulateTyping(await msg.getChat());
            try {
                await cancelAppointment(appointmentToChange.id);
                await client.sendMessage(customerId, responses.appointmentChanged);
                
                const newState = { 
                    step: 'AWAITING_DAY', 
                    service: appointmentToChange.summary.split(' - ')[0]
                };
                await simulateTyping(await msg.getChat());
                await client.sendMessage(customerId, responses.askForDay(newState.service));
                return newState;
            } catch (error) {
                await client.sendMessage(customerId, "❌ Ops! Ocorreu um erro ao tentar alterar seu agendamento.");
                return null;
            }
        } else {
            await client.sendMessage(customerId, "Opção inválida. Digite o número de um dos agendamentos.");
            return state;
        }
    }
};

client.on('message', async msg => {
    try {
        if (!msg.from.endsWith('@c.us')) return;

        const chat = await msg.getChat();
        const contact = await msg.getContact();
        const customerName = contact.pushname.split(" ")[0];
        const customerId = msg.from;
        const messageBody = msg.body.trim();

        logger.info(`Mensagem recebida de ${customerName} (${customerId}): "${messageBody}"`);

        let currentState = conversationState[customerId];

        if (currentState && stateHandlers[currentState.step]) {
            const newState = await stateHandlers[currentState.step](msg, currentState, customerId, customerName);
            if (newState) {
                conversationState[customerId] = newState;
            } else {
                delete conversationState[customerId];
            }
            return;
        }
        
        if (messageBody.match(/(oi|olá|menu|bom dia|boa tarde|boa noite)/i)) {
            delete conversationState[customerId];
            await simulateTyping(chat);
            await client.sendMessage(customerId, responses.welcome(customerName));
            return;
        }
        
        switch (messageBody) {
            case '1':
                conversationState[customerId] = { step: 'AWAITING_SERVICE_CHOICE' };
                await simulateTyping(chat);
                await client.sendMessage(customerId, responses.askForService);
                break;
            case '2':
                await simulateTyping(chat);
                const appointments = await listCustomerAppointments(customerName);
                if (appointments && appointments.length > 0) {
                    conversationState[customerId] = { step: 'AWAITING_CHANGE_CHOICE', appointments: appointments };
                    await client.sendMessage(customerId, responses.listAppointmentsToChange(appointments));
                } else {
                    await client.sendMessage(customerId, responses.appointmentNotFound);
                }
                break;
            case '3':
                await simulateTyping(chat);
                const appointmentsToCancel = await listCustomerAppointments(customerName);
                if (appointmentsToCancel && appointmentsToCancel.length > 0) {
                    const nextAppointment = appointmentsToCancel[0];
                    conversationState[customerId] = { step: 'AWAITING_CANCELLATION_CONFIRMATION', appointmentToCancel: nextAppointment };
                    const date = new Date(nextAppointment.start.dateTime).toLocaleString('pt-BR');
                    await client.sendMessage(customerId, responses.confirmCancellation(nextAppointment.summary, date));
                } else {
                    await client.sendMessage(customerId, responses.appointmentNotFound);
                }
                break;
            default:
                await simulateTyping(chat);
                const response = processMessage(messageBody);
                await client.sendMessage(customerId, response);
                break;
        }
    } catch (error) {
        logger.error('Erro global não tratado no fluxo de mensagem', { error: error.message, stack: error.stack });
        // Opcional: Enviar uma mensagem de erro genérica para o usuário
         await client.sendMessage(msg.from, "❌ Ocorreu um erro inesperado. Tente novamente.");
    }
});