const axios = require('axios');
const { getResponses, generateNumberedList } = require('./responses');
const { processMessage } = require('./messageProcessor');
const calendarApi = require('./calendar');
const chrono = require('chrono-node');
const db = require('./database');
const logger = require('./logger');

// Configurações globais
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v20.0';
const AXIOS_TIMEOUT = 10000;

// === Função principal de envio de mensagens via API da Meta ===
async function sendWhatsAppMessage(businessPhoneId, accessToken, messageData) {
    if (!accessToken) throw new Error('MISSING_ACCESS_TOKEN');
    if (!businessPhoneId) throw new Error('MISSING_BUSINESS_PHONE_ID');

     if (messageData.type === 'text' && (!messageData.text || !messageData.text.body)) {
        logger.error('Tentativa de enviar mensagem sem corpo', { messageData });
        throw new Error('MISSING_MESSAGE_BODY');
    }

    messageData.messaging_product = "whatsapp";
    if (messageData.to) messageData.to = String(messageData.to).replace(/\D/g, '');

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${businessPhoneId}/messages`;

    try {
        logger.debug(`📤 Enviando mensagem para ${messageData.to}`, { payload: messageData });
        const response = await axios.post(url, messageData, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: AXIOS_TIMEOUT
        });
        logger.info(`Mensagem enviada com sucesso para ${messageData.to}`);
        return response.data;
    } catch (error) {
        const errRes = error.response?.data?.error;
        logger.error('Erro ao enviar mensagem pela API da Meta', {
            to: messageData.to,
            code: errRes?.code,
            message: errRes?.message
        });
        throw new Error(`META_API_SEND_FAILED: ${errRes?.message || error.message}`);
    }
}

// === Função auxiliar para listar dias disponíveis ===
async function listAvailableDaysFallback(customerId, state, clientInfo, responses, calendarId, googleCredentials, workSchedule, timezone) {
    try {
        // ✅ MUDANÇA: Passa workSchedule completo para listAvailableDays
        const availableDays = await calendarApi.listAvailableDays(calendarId, googleCredentials, workSchedule, timezone);

        if (!availableDays.length) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "📛 Nenhum dia disponível nesta semana. O estabelecimento pode estar fechado." }
            });
            return state; // Retorna estado atual para manter o fluxo
        }

        const formatted = availableDays.map((d, i) => `📅 ${i + 1}️⃣ ${d.formatted}`).join('\n');
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: {
                body: `Esses são os próximos dias disponíveis:\n\n${formatted}\n\n` +
                      `Envie o número do dia desejado.`
            }
        });

        state.step = 'AWAITING_DAY_SELECTION';
        state.availableDays = availableDays;
        return state;
    } catch (error) {
        logger.error('Erro ao listar dias disponíveis (fallback)', { error: error.message });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Erro ao consultar disponibilidade. Tente novamente mais tarde." }
        });
        // Considerar limpar o estado ou voltar ao menu inicial em caso de erro grave
        return null;
    }
}


// === Manipuladores de estado (stateHandlers) ===
const stateHandlers = {};

// === Escolha de serviço ===
stateHandlers.AWAITING_SERVICE_CHOICE = async (message, state, clientInfo, responses) => {
    const customerId = message.from;
    const messageBody = message.text.body.trim();
    const services = clientInfo.config?.services || [];
    const choiceIndex = parseInt(messageBody, 10) - 1;

    if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= services.length) {
        const errorMsg = "❌ Opção inválida.\n\n";
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: errorMsg + responses.askForService(generateNumberedList(services, 'service')) }
        });
        return state; // Mantém no mesmo estado
    }

    const chosenService = services[choiceIndex];
    // Atualiza o estado com os dados do serviço escolhido
    const nextState = {
        ...state, // Preserva outros dados do estado se houver
        step: 'AWAITING_DAY_SELECTION', // Próximo passo é escolher o dia
        service: chosenService.name,
        duration: chosenService.duration || 60,
        calendarId: clientInfo.google_calendar_id
    };


    // Verificar credenciais Google
    if (!clientInfo.google_credentials || !nextState.calendarId) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Serviço de agendamento temporariamente indisponível (G). Tente novamente mais tarde." }
        });
        return null; // Limpa estado
    }

    // Mensagem 1: confirmação da escolha
    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: { body: `💇‍♂️ Ótima escolha: *${nextState.service}*!` }
    });

    // Mensagem 2: já listar próximos dias disponíveis
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const workSchedule = clientInfo.work_schedule || {};

    try {
        // ✅ MUDANÇA: Passa workSchedule completo para listAvailableDays
        const availableDays = await calendarApi.listAvailableDays(
            nextState.calendarId,
            clientInfo.google_credentials,
            workSchedule,
            timezone
        );

        if (!availableDays.length) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "📛 Nenhum dia disponível nas próximas semanas. O estabelecimento pode estar fechado ou lotado." }
            });
             // Mantém o estado, mas sem availableDays, para o usuário tentar outra ação
            nextState.step = 'AWAITING_SERVICE_CHOICE'; // Volta para escolha de serviço? Ou menu?
            return nextState;
        }

        const formattedDays = availableDays.map((d, i) => `📅 ${i + 1}️⃣ ${d.formatted}`).join('\n');
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: {
                body: `Esses são os próximos dias disponíveis:\n\n${formattedDays}\n\n` +
                      `Envie o número do dia desejado ou digite uma data específica (ex: "30/10").`
            }
        });

        // Atualiza o estado com os dias disponíveis e o próximo passo
        nextState.availableDays = availableDays;
        nextState.step = 'AWAITING_DAY_SELECTION';
        return nextState;

    } catch (error) {
        logger.error('Erro ao listar dias disponíveis (escolha de serviço)', { error: error.message });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Erro ao consultar dias disponíveis. Tente novamente ou digite 'menu'." }
        });
        // Mantém o estado para o usuário tentar de novo ou ir pro menu
        return state;
    }
};

// === Seleção do dia (número ou data) ===
stateHandlers.AWAITING_DAY_SELECTION = async (message, state, clientInfo, responses) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const availableDays = state.availableDays || [];
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const workSchedule = clientInfo.work_schedule || {};
    const calendarId = state.calendarId || clientInfo.google_calendar_id;
    const googleCredentials = clientInfo.google_credentials;
    const duration = state.duration || 60;
    const slotInterval = duration;
    const minAdvanceMinutes = clientInfo.config?.minAdvanceMinutes || 120;

    let parsedDate = null;
    let selectedDayFormatted = "";

    // 🔴 CORREÇÃO: Verificar primeiro se é uma data antes de interpretar como número
    const isDateInput = /^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(msg) || 
                       /^(amanhã|hoje|segunda|terça|quarta|quinta|sexta|sábado|domingo)/i.test(msg);

    if (isDateInput) {
        // Tenta interpretar como DATA (ex: "30/10", "amanhã")
        if (/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(msg)) {
            const [day, month, year] = msg.split('/').map(Number);
            const currentYear = new Date().getFullYear();
            const potentialDate = new Date(year || currentYear, month - 1, day);
            if (!isNaN(potentialDate.getTime()) && potentialDate.getMonth() === month - 1) {
                parsedDate = potentialDate;
            }
        } else {
            // Usa Chrono para "amanhã", "sexta", etc.
            try {
                const parsed = chrono.parse(msg, new Date());
                if (parsed.length > 0) {
                    parsedDate = parsed[0].start.date();
                }
            } catch (error) { 
                logger.warn('Erro no parser de data (Chrono):', error.message); 
            }
        }

        // Validação da data parseada
        if (parsedDate) {
            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            if (parsedDate < today) parsedDate.setFullYear(parsedDate.getFullYear() + 1);
            if (parsedDate.getFullYear() > now.getFullYear() + 1) parsedDate.setFullYear(now.getFullYear());
             selectedDayFormatted = parsedDate.toLocaleDateString('pt-BR', { 
                 weekday: 'long', 
                 day: '2-digit', 
                 month: '2-digit', 
                 year: 'numeric'
             });
             selectedDayFormatted = selectedDayFormatted.charAt(0).toUpperCase() + selectedDayFormatted.slice(1);
        }
    } else {
        // Se não é uma data, tenta interpretar como NÚMERO da lista
        const choice = parseInt(msg, 10);
        if (!isNaN(choice) && choice >= 1 && choice <= availableDays.length) {
            const selectedDay = availableDays[choice - 1];
            parsedDate = new Date(selectedDay.date);
            selectedDayFormatted = selectedDay.formatted;
        }
    }

    // Se não conseguiu interpretar nem como número nem como data válida
    if (!parsedDate) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Opção inválida. Envie o número de um dos dias listados ou digite uma data (ex: '30/10', 'amanhã')." }
        });
        return state; // Mantém no mesmo estado
    }

    // --- Temos uma data válida (parsedDate) ---
    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: { body: `📅 Você escolheu *${selectedDayFormatted}*. Consultando horários disponíveis...` }
    });

    // Lista os slots usando a data encontrada
    let slots = [];
    try {
        slots = await calendarApi.listAvailableSlots(
            parsedDate,
            duration,
            calendarId,
            googleCredentials,
            timezone,
            workSchedule,
            {
                minAdvanceMinutes,
                allowSameDay: true,
                slotInterval: slotInterval
            }
        );

        // Fallback para slots manuais se necessário
        if (!slots.length) {
            logger.info('API não retornou slots, tentando fallback manual...');
            slots = await calendarApi.generateSlotsManually(
                parsedDate,
                duration,
                workSchedule,
                {
                    minAdvanceMinutes,
                    allowSameDay: true,
                    slotInterval: slotInterval,
                    googleCredentials,
                    calendarId
                }
            );
        }
    } catch (error) {
        logger.error('Erro ao buscar horários (day selection)', { error: error.message });
        // Tentar fallback manual mesmo em caso de erro na API
        try {
            slots = await calendarApi.generateSlotsManually(
                 parsedDate, duration, workSchedule,
                 { minAdvanceMinutes, allowSameDay: true, slotInterval, googleCredentials, calendarId }
            );
        } catch (fallbackError) {
            logger.error('Erro também no fallback manual (day selection)', { error: fallbackError.message });
        }
    }

    // Resposta se não encontrou slots
    if (!slots.length) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: `😕 Nenhum horário disponível para ${selectedDayFormatted}. Escolha outro dia.` }
        });
        // Volta para a seleção de dia, mas mantém os dados do serviço
        return {
             ...state,
             step: 'AWAITING_DAY_SELECTION',
        };
    }

    // Resposta com a lista de slots
    const slotList = slots.map((s, i) =>
        `${i + 1}️⃣ ${new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    ).join('\n');

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: {
            body: `✅ Horários disponíveis para ${selectedDayFormatted}:\n\n${slotList}\n\n` +
                  `Envie o número do horário desejado.`
        }
    });

    // Atualiza o estado para esperar a escolha do slot
    return {
        ...state,
        step: 'AWAITING_SLOT',
        availableSlots: slots.map(s => s.toISOString()),
        chosenDay: parsedDate.toISOString()
    };
};

// === Escolha de horário ===
stateHandlers.AWAITING_SLOT = async (message, state, clientInfo, responses) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const slots = state.availableSlots?.map(iso => new Date(iso)) || [];
    const choice = parseInt(msg, 10) - 1;

    if (isNaN(choice) || choice < 0 || choice >= slots.length) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Escolha inválida. Envie o número do horário desejado." }
        });
        return state;
    }

    const chosenSlot = slots[choice];
    const dateStr = chosenSlot.toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });

    // 🔴 CORREÇÃO: Enviar mensagem de confirmação antes de mudar de estado
    const services = clientInfo.config?.services || [];
    const serviceInfo = services.find(s => s.name === state.service);
    const price = serviceInfo?.price ? `R$ ${serviceInfo.price.toFixed(2)}` : 'Consulte o valor';

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: {
            body: `📋 *Resumo do Agendamento:*\n\n` +
                  `📅 Data: ${dateStr}\n` +
                  `💇 Serviço: ${state.service}\n` +
                  `💰 Valor: ${price}\n\n` +
                  `Para confirmar, digite *1*\n` +
                  `Para cancelar, digite *2*`
        }
    });

    // Próximo passo: confirmação final
    return {
         ...state,
         step: 'AWAITING_FINAL_CONFIRMATION',
         chosenSlot: chosenSlot.toISOString()
    };
};

// === Confirmação final do agendamento ===
stateHandlers.AWAITING_FINAL_CONFIRMATION = async (message, state, clientInfo) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const chosenSlot = new Date(state.chosenSlot);
    const calendarId = state.calendarId;
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const customerName = message.profile?.name || 'Cliente';
    const workSchedule = clientInfo.work_schedule || {};

    // 🔴 CORREÇÃO: Verificar tanto '1' quanto '2' explicitamente
    if (msg === '1') { // Confirmou
        try {
            await calendarApi.createAppointment(
                chosenSlot.toISOString(),
                state.service,
                customerName,
                state.duration,
                calendarId,
                clientInfo.google_credentials,
                timezone,
                workSchedule,
                { minAdvanceMinutes: clientInfo.config?.minAdvanceMinutes || 120 }
            );

            // Salva visita no BD local
            await db.saveCustomerVisit(clientInfo.id, customerId, customerName, chosenSlot.toISOString());

            const formattedDate = chosenSlot.toLocaleString('pt-BR', {
                day: '2-digit', 
                month: '2-digit', 
                year: 'numeric',
                hour: '2-digit', 
                minute: '2-digit'
            });
            
            const services = clientInfo.config?.services || [];
            const serviceInfo = services.find(s => s.name === state.service);
            const price = serviceInfo?.price ? `R$ ${serviceInfo.price.toFixed(2)}` : 'Consulte o valor';

            const confirmationMessage = `✅ *Agendamento confirmado!*\n\n` +
                              `📅 ${formattedDate}\n` +
                              `💇 Serviço: ${state.service}\n` +
                              `💰 Valor: ${price}\n\n` +
                              `Obrigado pela preferência!`;

            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: confirmationMessage }
            });

            return null; // Limpa o estado após sucesso

        } catch (error) {
            logger.error('Erro ao criar agendamento final', { error: error.message, code: error.code });
            let errorMessage = "❌ Ocorreu um erro ao confirmar o agendamento. Tente novamente.";
            
            if (error.message === 'CONFLICT') errorMessage = "❌ Desculpe, esse horário acabou de ser ocupado. Por favor, escolha outro.";
            else if (error.message === 'MIN_ADVANCE_NOT_MET') errorMessage = "❌ Você precisa agendar com mais antecedência. Escolha um horário mais tarde.";
            else if (error.message === 'HOLIDAY_CLOSED') errorMessage = "❌ O estabelecimento está fechado neste feriado.";
            else if (error.message === 'DAY_CLOSED') errorMessage = "❌ O estabelecimento está fechado neste dia.";
            else if (error.message === 'OUTSIDE_WORKING_HOURS') errorMessage = "❌ O horário escolhido está fora do expediente.";

            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: errorMessage }
            });
            
            return {
                 ...state,
                 step: 'AWAITING_DAY_SELECTION',
                 chosenSlot: null,
            };
        }
    } else if (msg === '2') { // Cancelou
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Agendamento cancelado. Digite 'menu' para recomeçar." }
        });
        return null; // Limpa o estado
    } else {
        // 🔴 CORREÇÃO: Se a opção for inválida, pede novamente
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { 
                body: "❌ Opção inválida.\n\n" +
                      "Para confirmar, digite *1*\n" +
                      "Para cancelar, digite *2*"
            }
        });
        return state; // Mantém no mesmo estado
    }
};

// ... (o restante do código permanece igual - Confirmação de cancelamento, Escolha de agendamento para alteração, Função principal)

// === Confirmação de cancelamento de agendamento ===
stateHandlers.AWAITING_CANCELLATION_CONFIRMATION = async (message, state, clientInfo) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const appointmentToCancel = state.appointmentToCancel;
    const calendarId = state.calendarId || clientInfo.google_calendar_id;

    if (msg === '1' && appointmentToCancel?.id) {
        try {
            await calendarApi.cancelAppointment(appointmentToCancel.id, calendarId, clientInfo.google_credentials);
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "✅ Agendamento cancelado com sucesso!" }
            });
        } catch (error) {
            logger.error('Erro ao cancelar agendamento', { error: error.message });
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Não foi possível cancelar agora. Tente novamente mais tarde." }
            });
        }
    } else {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "😉 Ok! O agendamento foi mantido." }
        });
    }
    return null; // Limpa estado em ambos os casos
};

// === Escolha de agendamento para alteração ===
stateHandlers.AWAITING_CHANGE_CHOICE = async (message, state, clientInfo, responses) => {
    const customerId = message.from;
    const messageBody = message.text.body.trim();
    const appointments = state.appointments || [];
    const choice = parseInt(messageBody, 10) - 1;
    const calendarId = state.calendarId || clientInfo.google_calendar_id;

    if (choice >= 0 && choice < appointments.length) {
        const appointment = appointments[choice];
        const serviceName = appointment.summary?.split(' - ')[0] || 'Serviço';
        const services = clientInfo.config?.services || [];
        const serviceInfo = services.find(s => s.name === serviceName);
        const duration = serviceInfo?.duration || 60;

        try {
            await calendarApi.cancelAppointment(appointment.id, calendarId, clientInfo.google_credentials);
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "🔁 Ok! O agendamento anterior foi cancelado. Vamos escolher um novo dia e horário." }
            });

             const nextState = {
                 step: 'AWAITING_DAY_SELECTION',
                 service: serviceName,
                 duration: duration,
                 calendarId: calendarId
             };

            const timezone = clientInfo.timezone || 'America/Sao_Paulo';
            const workSchedule = clientInfo.work_schedule || {};

            return await listAvailableDaysFallback(
                customerId,
                nextState,
                clientInfo,
                responses,
                calendarId,
                clientInfo.google_credentials,
                workSchedule,
                timezone
            );

        } catch (error) {
            logger.error('Erro ao cancelar para reagendar', { error: error.message });
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Ocorreu um erro ao iniciar o reagendamento. Tente novamente." }
            });
            return null;
        }
    }

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: { body: "❌ Opção inválida. Envie o número de um dos agendamentos listados." }
    });
    return state;
};

// === Função principal do chatbot ===
async function handleIncomingMessage(messagePayload) {
    let customerId = null;
    let clientInfo = null;
    let responses = null;
    let currentState = null;

    try {
        const messageObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const contactObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
        const metadataObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.metadata;

        if (!messageObject?.text?.body || !metadataObject?.phone_number_id) {
            return logger.debug('Payload ignorado (não é texto válido)');
        }

        customerId = messageObject.from;
        const messageBody = messageObject.text.body.trim();
        const customerName = contactObject?.profile?.name || "Cliente";
        const businessPhoneId = metadataObject.phone_number_id;

        clientInfo = await db.getClientByPhoneId(businessPhoneId);
        if (!clientInfo?.whatsapp_token) {
            logger.error(`Número não registrado: ${businessPhoneId}`);
            return;
        }

        // Verificar credenciais Google (essencial para agendamento)
        if (!clientInfo.google_credentials || !clientInfo.google_calendar_id) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: {
                    body: "⚠️ Serviço de agendamento temporariamente indisponível (G).\n\n" +
                          "Entre em contato diretamente com o estabelecimento."
                }
            });
            return;
        }

        responses = getResponses(clientInfo.config || {});
        currentState = await db.getConversationState(customerId, clientInfo.id);

        const payload = { from: customerId, text: { body: messageBody }, profile: { name: customerName } };
        const msgUpper = messageBody.toUpperCase();
        let nextState = null;

        // --- Roteamento da Mensagem ---

        // 1. Comando de Reset/Cancelamento Explícito (Ex: "cancelar", "sair")
        if (/^(cancelar|sair|parar|menu)$/i.test(messageBody) && currentState) {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text',
                 text: { body: "Ok, processo cancelado. Digite 'menu' ou 'olá' para recomeçar." }
             });
             nextState = null;
        }
        // 2. Continuar fluxo existente
        else if (currentState?.step && stateHandlers[currentState.step]) {
            logger.debug(`Continuando fluxo: ${currentState.step}`, { customerId, state: currentState });
            nextState = await stateHandlers[currentState.step](payload, currentState, clientInfo, responses);
        }
        // 3. Saudação ou pedido de menu (início de fluxo)
        else if (/^(oi|olá|menu|iniciar|começar|bom dia|boa tarde|boa noite)$/i.test(messageBody)) {
            const services = clientInfo.config?.services || [];
            const welcomeMsg = responses.welcome(customerName);
            const serviceList = services.length ? generateNumberedList(services, 'service') : "(Nenhum serviço cadastrado)";

            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: {
                    body: `${welcomeMsg}\n\n${responses.askForService(serviceList)}\n\n` +
                          `💡 Você também pode:\n` +
                          `📋 Digitar "A" para Alterar um agendamento\n` +
                          `❌ Digitar "C" para Cancelar um agendamento`
                }
            });
            nextState = { step: 'AWAITING_SERVICE_CHOICE' };
        }
        // 4. Comando para Alterar Agendamento ('A')
        else if (msgUpper === 'A') {
            const appts = await calendarApi.listCustomerAppointments(customerName, clientInfo.google_calendar_id, clientInfo.google_credentials);
            if (!appts.length) {
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.appointmentNotFound }
                });
                nextState = null;
            } else {
                const list = generateNumberedList(appts, 'appointment');
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.listAppointmentsToChange(appts) }
                });
                nextState = { step: 'AWAITING_CHANGE_CHOICE', appointments: appts, calendarId: clientInfo.google_calendar_id };
            }
        }
        // 5. Comando para Cancelar Agendamento ('C')
        else if (msgUpper === 'C') {
            const appts = await calendarApi.listCustomerAppointments(customerName, clientInfo.google_calendar_id, clientInfo.google_credentials);
            if (!appts.length) {
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.appointmentNotFound }
                });
                nextState = null;
            } else {
                const nextAppt = appts[0];
                const dateStr = new Date(nextAppt.start.dateTime || nextAppt.start.date).toLocaleString('pt-BR');
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text',
                    text: { body: responses.confirmCancellation(nextAppt.summary, dateStr) }
                });
                nextState = { step: 'AWAITING_CANCELLATION_CONFIRMATION', appointmentToCancel: nextAppt, calendarId: clientInfo.google_calendar_id };
            }
        }
        // 6. Entrada numérica (potencial escolha de serviço fora de hora)
        else if (!isNaN(parseInt(messageBody, 10)) && !currentState) {
             const initialState = { step: 'AWAITING_SERVICE_CHOICE' };
             nextState = await stateHandlers.AWAITING_SERVICE_CHOICE(payload, initialState, clientInfo, responses);
        }
        // 7. Mensagem Padrão (não entendeu)
        else {
             if (currentState) {
                 logger.warn('Mensagem não reconhecida durante fluxo', { currentState, messageBody });
             }
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: responses.default }
            });
        }

        // --- Fim do Roteamento ---

        // Salva ou limpa o estado da conversa
        if (nextState) {
            await db.saveConversationState(customerId, clientInfo.id, nextState);
            logger.debug('Estado salvo:', { customerId, step: nextState.step });
        } else if (currentState) {
            await db.deleteConversationState(customerId, clientInfo.id);
            logger.debug('Estado removido (fluxo concluído ou cancelado):', { customerId });
        }

    } catch (error) {
        logger.error('Erro global no handleIncomingMessage', {
            error: error.message,
            stack: error.stack,
            customerId
        });

        if (customerId && clientInfo?.whatsapp_phone_id && clientInfo?.whatsapp_token) {
            try {
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text',
                    text: { body: "❌ Ocorreu um erro inesperado. Por favor, tente novamente mais tarde ou digite 'menu' para recomeçar." }
                });
                 await db.deleteConversationState(customerId, clientInfo.id);
                 logger.warn('Estado removido devido a erro global.', { customerId });
            } catch (sendError) {
                logger.error('Falha ao enviar mensagem de erro para o cliente', { sendError: sendError.message });
            }
        }
    }
}

module.exports = { handleIncomingMessage, sendWhatsAppMessage };