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
        const availableDays = await calendarApi.listAvailableDays(calendarId, googleCredentials, workSchedule, timezone);

        if (!availableDays.length) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId,
                type: 'text',
                text: { body: "📛 Nenhum dia disponível nesta semana. O estabelecimento pode estar fechado." }
            });
            return state;
        }

        const formatted = availableDays.map((d, i) => `📅 ${i + 1}️⃣ ${d.formatted}`).join('\n');
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId,
            type: 'text',
            text: {
                body: `Esses são os próximos dias disponíveis:\n\n${formatted}\n\n` +
                      `Envie o número do dia desejado.`
            }
        });

        state.step = 'AWAITING_DAY_SELECTION';
        state.availableDays = availableDays;
        return state;
    } catch (error) {
        logger.error('Erro ao listar dias disponíveis', { error: error.message });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Erro ao consultar disponibilidade. Tente novamente mais tarde." }
        });
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
            to: customerId,
            type: 'text',
            text: { body: errorMsg + responses.askForService(generateNumberedList(services, 'service')) }
        });
        return state;
    }

    const chosenService = services[choiceIndex];
    state.step = 'AWAITING_DAY';
    state.service = chosenService.name;
    state.duration = chosenService.duration || 60;
    state.calendarId = clientInfo.google_calendar_id;

    // Verificar credenciais Google
    if (!clientInfo.google_credentials || !state.calendarId) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId,
            type: 'text',
            text: { body: "❌ Serviço de agendamento temporariamente indisponível. Tente novamente mais tarde." }
        });
        return null;
    }

    // Mensagem 1: confirmação da escolha
    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId,
        type: 'text',
        text: { body: `💇‍♂️ Ótima escolha: *${state.service}*!` }
    });

    // Mensagem 2: já listar próximos dias disponíveis
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const workSchedule = clientInfo.work_schedule || {};
    
    try {
        const availableDays = await calendarApi.listAvailableDays(state.calendarId, clientInfo.google_credentials, workSchedule, timezone);

        if (!availableDays.length) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId,
                type: 'text',
                text: { body: "📛 Nenhum dia disponível nesta semana. O estabelecimento pode estar fechado." }
            });
            return state;
        }

        const formattedDays = availableDays.map((d, i) => `📅 ${i + 1}️⃣ ${d.formatted}`).join('\n');
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId,
            type: 'text',
            text: {
                body: `Esses são os próximos dias disponíveis:\n\n${formattedDays}\n\n` +
                      `Envie o número do dia desejado ou digite uma data específica (ex: "30/10").`
            }
        });

        state.step = 'AWAITING_DAY_SELECTION';
        state.availableDays = availableDays;
        return state;
    } catch (error) {
        logger.error('Erro ao listar dias disponíveis no serviço', { error: error.message });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId,
            type: 'text',
            text: { body: "❌ Erro ao consultar dias disponíveis. Tente novamente." }
        });
        return state;
    }
};

// === Escolha de dia (CORRIGIDO para usar work_schedule) ===
stateHandlers.AWAITING_DAY = async (message, state, clientInfo, responses) => {
    const customerId = message.from;
    const messageBody = message.text.body.trim().toLowerCase();
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const workSchedule = clientInfo.work_schedule || {};
    const calendarId = state.calendarId || clientInfo.google_calendar_id;
    const minAdvanceMinutes = clientInfo.config?.minAdvanceMinutes || 120;
    const googleCredentials = clientInfo.google_credentials;

    // Verificar credenciais Google primeiro
    if (!googleCredentials || !calendarId) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Serviço temporariamente indisponível. Tente novamente mais tarde." }
        });
        return null;
    }

    // 🧠 Interpretação da data digitada
    let parsedDate = null;

    // Caso o usuário digite formato "30/10" ou "30/10/2025"
    if (/^\d{1,2}\/\d{1,2}(\/\d{4})?$/.test(messageBody)) {
        const [day, month, year] = messageBody.split('/').map(Number);
        const currentYear = new Date().getFullYear();
        parsedDate = new Date(year || currentYear, month - 1, day);
        
        // Validação rigorosa da data
        if (isNaN(parsedDate.getTime()) || parsedDate.getMonth() !== month - 1) {
            parsedDate = null;
        }
    } else {
        // Usa o parser Chrono para textos como "amanhã", "sexta", etc.
        try {
            const parsed = chrono.parse(messageBody, new Date());
            if (parsed.length > 0) {
                parsedDate = parsed[0].start.date();
            }
        } catch (error) {
            logger.warn('Erro no parser de data:', error.message);
        }
    }

    // Se não conseguir entender a data → lista os dias disponíveis
    if (!parsedDate || isNaN(parsedDate.getTime())) {
        logger.debug('Data não entendida, listando dias disponíveis');
        return await listAvailableDaysFallback(customerId, state, clientInfo, responses, calendarId, googleCredentials, workSchedule, timezone);
    }

    // Validação e correção da data
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Se data no passado, ajusta para o próximo ano
    if (parsedDate < today) {
        parsedDate.setFullYear(parsedDate.getFullYear() + 1);
    }

    // Se ano muito no futuro (> 1 ano), corrige
    if (parsedDate.getFullYear() > now.getFullYear() + 1) {
        parsedDate.setFullYear(now.getFullYear());
    }

    // Verifica se é dia de funcionamento usando work_schedule
    const weekdayIndex = parsedDate.getDay();
    const dayKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayKey = dayKeys[weekdayIndex];
    const dayConfig = workSchedule[dayKey];

    if (!dayConfig?.available) {
        logger.debug('Dia sem expediente', { date: parsedDate.toISOString(), dayKey });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId,
            type: 'text',
            text: { body: `📛 ${parsedDate.toLocaleDateString('pt-BR')} é um dia sem expediente.` }
        });
        return await listAvailableDaysFallback(customerId, state, clientInfo, responses, calendarId, googleCredentials, workSchedule, timezone);
    }

    // ✅ VALIDAÇÃO CRÍTICA: Verificar se horários são válidos
    if (dayConfig.start >= dayConfig.end) {
        logger.error('Horário de trabalho inválido na configuração', { 
            start: dayConfig.start, 
            end: dayConfig.end,
            dayKey 
        });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId,
            type: 'text',
            text: { body: `❌ Configuração de horário inválida para ${parsedDate.toLocaleDateString('pt-BR')}.` }
        });
        return await listAvailableDaysFallback(customerId, state, clientInfo, responses, calendarId, googleCredentials, workSchedule, timezone);
    }

    const workingHoursConfig = { start: dayConfig.start, end: dayConfig.end };
    const duration = state.duration || 60;

    // Lista horários disponíveis com tratamento de erro e fallback
    let slots = [];
    try {
        slots = await calendarApi.listAvailableSlots(
            parsedDate,
            duration,
            calendarId,
            googleCredentials,
            timezone,
            workingHoursConfig,
            { minAdvanceMinutes, allowSameDay: true }
        );

        // Se a API retornar vazio mas deveria ter slots, tenta método manual
        if (!slots.length && workingHoursConfig.start < workingHoursConfig.end) {
            logger.info('Tentando gerar slots manualmente como fallback...');
            slots = await calendarApi.generateSlotsManually(
                parsedDate,
                duration,
                workingHoursConfig,
                { minAdvanceMinutes, allowSameDay: true }
            );
        }
    } catch (error) {
        logger.error('Erro ao buscar horários', { error: error.message });
        // Em caso de erro, tenta método manual
        try {
            slots = await calendarApi.generateSlotsManually(
                parsedDate,
                duration,
                workingHoursConfig,
                { minAdvanceMinutes, allowSameDay: true }
            );
        } catch (fallbackError) {
            logger.error('Erro também no fallback manual', { error: fallbackError.message });
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Erro ao consultar horários. Listando dias disponíveis..." }
            });
            return await listAvailableDaysFallback(customerId, state, clientInfo, responses, calendarId, googleCredentials, workSchedule, timezone);
        }
    }

    // Quando não há horários, oferece dias alternativos
    if (!slots.length) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: `😕 Nenhum horário disponível para ${parsedDate.toLocaleDateString('pt-BR')}.` }
        });
        return await listAvailableDaysFallback(customerId, state, clientInfo, responses, calendarId, googleCredentials, workSchedule, timezone);
    }

    const slotList = slots
        .map((s, i) => `${i + 1}️⃣ ${new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`)
        .join('\n');

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId,
        type: 'text',
        text: { 
            body: `✅ Horários disponíveis em ${parsedDate.toLocaleDateString('pt-BR')}:\n\n${slotList}\n\n` +
                  `Envie o número do horário desejado.`
        }
    });

    state.step = 'AWAITING_SLOT';
    state.availableSlots = slots.map(s => s.toISOString());
    state.chosenDay = parsedDate.toISOString();
    return state;
};

// === Seleção do dia sugerido (CORRIGIDO) ===
stateHandlers.AWAITING_DAY_SELECTION = async (message, state, clientInfo, responses) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const choice = parseInt(msg, 10);
    const availableDays = state.availableDays || [];

    // Se for uma data manual (ex: 30/10)
    if (/^\d{1,2}\/\d{1,2}$/.test(msg)) {
        const [day, month] = msg.split('/').map(Number);
        const year = new Date().getFullYear();
        const date = new Date(year, month - 1, day);
        
        if (isNaN(date.getTime())) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Data inválida. Use o formato DD/MM (ex: 30/10)." }
            });
            return state;
        }
        
        state.chosenDay = date.toISOString();
        state.step = 'AWAITING_DAY';
        return await stateHandlers.AWAITING_DAY(message, state, clientInfo, responses);
    }

    // Se for escolha por número
    if (isNaN(choice) || choice < 1 || choice > availableDays.length) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: "❌ Escolha inválida. Envie o número de um dos dias listados ou digite uma data (ex: 30/10)." }
        });
        return state;
    }

    const selectedDay = availableDays[choice - 1];
    const parsedDate = new Date(selectedDay.date);

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: { body: `📅 Você escolheu *${selectedDay.formatted}*. Consultando horários disponíveis...` }
    });

    const duration = state.duration || 60;
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const workSchedule = clientInfo.work_schedule || {};
    const weekdayIndex = parsedDate.getDay();
    const dayKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayConfig = workSchedule[dayKeys[weekdayIndex]];
    
    if (!dayConfig?.available) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: `❌ ${selectedDay.formatted} é um dia sem expediente. Escolha outro dia.` }
        });
        return state;
    }

    // ✅ VALIDAÇÃO CRÍTICA: Verificar se horários são válidos
    if (dayConfig.start >= dayConfig.end) {
        logger.error('Horário de trabalho inválido', { 
            start: dayConfig.start, 
            end: dayConfig.end,
            dayKey: dayKeys[weekdayIndex]
        });
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: `❌ Configuração de horário inválida para ${selectedDay.formatted}.` }
        });
        return state;
    }

    const workingHours = { start: dayConfig.start, end: dayConfig.end };

    // Usar a mesma lógica de fallback do AWAITING_DAY
    let slots = [];
    try {
        slots = await calendarApi.listAvailableSlots(
            parsedDate,
            duration,
            state.calendarId,
            clientInfo.google_credentials,
            timezone,
            workingHours,
            { minAdvanceMinutes: clientInfo.config?.minAdvanceMinutes || 120, allowSameDay: true }
        );

        // Fallback para slots manuais
        if (!slots.length && workingHours.start < workingHours.end) {
            slots = await calendarApi.generateSlotsManually(
                parsedDate,
                duration,
                workingHours,
                { minAdvanceMinutes: clientInfo.config?.minAdvanceMinutes || 120, allowSameDay: true }
            );
        }
    } catch (error) {
        logger.error('Erro ao buscar horários no day selection', { error: error.message });
        // Tentar fallback manual
        try {
            slots = await calendarApi.generateSlotsManually(
                parsedDate,
                duration,
                workingHours,
                { minAdvanceMinutes: clientInfo.config?.minAdvanceMinutes || 120, allowSameDay: true }
            );
        } catch (fallbackError) {
            logger.error('Erro também no fallback manual do day selection', { error: fallbackError.message });
        }
    }

    if (!slots.length) {
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text',
            text: { body: `😕 Nenhum horário disponível para ${selectedDay.formatted}. Escolha outro dia.` }
        });
        return state;
    }

    const slotList = slots.map((s, i) => 
        `${i + 1}️⃣ ${new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    ).join('\n');
    
    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: { 
            body: `✅ Horários disponíveis para ${selectedDay.formatted}:\n\n${slotList}\n\n` +
                  `Envie o número do horário desejado.`
        }
    });

    state.step = 'AWAITING_SLOT';
    state.availableSlots = slots.map(s => s.toISOString());
    state.chosenDay = parsedDate.toISOString();
    return state;
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
        day: '2-digit', 
        month: '2-digit', 
        year: 'numeric',
        hour: '2-digit', 
        minute: '2-digit' 
    });

    state.step = 'AWAITING_FINAL_CONFIRMATION';
    state.chosenSlot = chosenSlot.toISOString();

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId,
        type: 'text',
        text: { 
            body: `🕒 Você escolheu ${dateStr} para o serviço *${state.service}*.\n\n` +
                  `1️⃣ Confirmar agendamento\n` +
                  `2️⃣ Cancelar e voltar ao menu`
        }
    });

    return state;
};

// === Confirmação final do agendamento ===
stateHandlers.AWAITING_FINAL_CONFIRMATION = async (message, state, clientInfo) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const chosenSlot = new Date(state.chosenSlot);
    const calendarId = state.calendarId || clientInfo.google_calendar_id;
    const timezone = clientInfo.timezone || 'America/Sao_Paulo';
    const customerName = message.profile?.name || 'Cliente';

    if (msg === '1') {
        try {
            await calendarApi.createAppointment(
                chosenSlot.toISOString(),
                state.service,
                customerName,
                state.duration,
                calendarId,
                clientInfo.google_credentials,
                timezone,
                { minAdvanceMinutes: clientInfo.config?.minAdvanceMinutes || 120 }
            );

            await db.saveCustomerVisit(clientInfo.id, customerId, customerName, chosenSlot.toISOString());
            
            const formattedDate = chosenSlot.toLocaleString('pt-BR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            
            // Encontrar o serviço para mostrar o preço
            const services = clientInfo.config?.services || [];
            const serviceInfo = services.find(s => s.name === state.service);
            const price = serviceInfo?.price ? `R$ ${serviceInfo.price.toFixed(2)}` : 'Consulte o valor';
            
            // ✅ CORREÇÃO: Garantir que a mensagem tenha corpo
            const confirmationMessage = `✅ Agendamento confirmado!\n\n` +
                          `📅 ${formattedDate}\n` +
                          `💇 Serviço: ${state.service}\n` +
                          `💰 Valor: ${price}\n\n` +
                          `Obrigado pela preferência!`;
            
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, 
                type: 'text',
                text: { 
                    body: confirmationMessage
                }
            });
            return null;
        } catch (error) {
            logger.error('Erro ao criar agendamento', { error: error.message });
            
            // ✅ CORREÇÃO: Garantir mensagem de erro também tem corpo
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, 
                type: 'text',
                text: { 
                    body: "❌ Ocorreu um erro ao confirmar o agendamento. Tente novamente." 
                }
            });
            return state;
        }
    } else {
        // ✅ CORREÇÃO: Garantir mensagem de cancelamento tem corpo
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, 
            type: 'text',
            text: { 
                body: "Agendamento cancelado. Digite 'menu' para recomeçar." 
            }
        });
        return null;
    }
};

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
    return null;
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
        const duration = 60;

        try {
            await calendarApi.cancelAppointment(appointment.id, calendarId, clientInfo.google_credentials);
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId,
                type: 'text',
                text: { body: "🔁 Ok! Vamos reagendar seu atendimento. Me diga o novo dia desejado." }
            });

            return {
                step: 'AWAITING_DAY',
                service: serviceName,
                duration,
                calendarId
            };
        } catch (error) {
            logger.error('Erro ao reagendar', { error: error.message });
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId,
                type: 'text',
                text: { body: "❌ Ocorreu um erro ao reagendar. Tente novamente." }
            });
            return null;
        }
    }

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId,
        type: 'text',
        text: { body: "❌ Opção inválida. Escolha um dos agendamentos listados." }
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

        // ✅ DEBUG: Log para verificar work_schedule
        logger.debug('DEBUG WORK SCHEDULE:', { 
            workSchedule: clientInfo.work_schedule,
            timezone: clientInfo.timezone,
            hasWorkSchedule: !!clientInfo.work_schedule
        });

        // Verificar credenciais Google no início
        if (!clientInfo.google_credentials || !clientInfo.google_calendar_id) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { 
                    body: "⚠️  Serviço de agendamento temporariamente indisponível.\n\n" +
                          "Entre em contato diretamente com o estabelecimento para agendar."
                }
            });
            return;
        }

        responses = getResponses(clientInfo.config || {});
        currentState = await db.getConversationState(customerId, clientInfo.id);

        const payload = { 
            from: customerId, 
            text: { body: messageBody }, 
            profile: { name: customerName } 
        };
        const msgUpper = messageBody.toUpperCase();

        let nextState = null;

        // === Continua fluxo atual ===
        if (currentState?.step && stateHandlers[currentState.step]) {
            logger.debug(`Continuando fluxo: ${currentState.step}`, { customerId, state: currentState });
            nextState = await stateHandlers[currentState.step](payload, currentState, clientInfo, responses);
        }
        // === Saudação ou menu ===
        else if (/^(oi|olá|menu|iniciar|começar|bom dia|boa tarde|boa noite)$/i.test(messageBody)) {
            const services = clientInfo.config?.services || [];
            const welcomeMsg = responses.welcome(customerName);
            const serviceList = services.length ? 
                generateNumberedList(services, 'service') : 
                "(Nenhum serviço cadastrado)";
                
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { 
                    body: `${welcomeMsg}\n\n${responses.askForService(serviceList)}\n\n` +
                          `💡 Você também pode:\n` +
                          `📋 Digitar "A" para Alterar um agendamento\n` +
                          `❌ Digitar "C" para Cancelar um agendamento`
                }
            });
        }
        // === Alterar agendamento ===
        else if (msgUpper === 'A') {
            const appts = await calendarApi.listCustomerAppointments(customerName, clientInfo.google_calendar_id, clientInfo.google_credentials);
            if (!appts.length) {
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: "❌ Nenhum agendamento encontrado." }
                });
                return;
            }
            const list = appts.map((a, i) => `${i + 1}️⃣ ${a.summary} — ${new Date(a.start.dateTime || a.start.date).toLocaleString('pt-BR')}`).join('\n');
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: `Qual agendamento deseja alterar?\n\n${list}` }
            });
            nextState = { step: 'AWAITING_CHANGE_CHOICE', appointments: appts };
        }
        // === Cancelar agendamento ===
        else if (msgUpper === 'C') {
            const appts = await calendarApi.listCustomerAppointments(customerName, clientInfo.google_calendar_id, clientInfo.google_credentials);
            if (!appts.length) {
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: "❌ Nenhum agendamento encontrado." }
                });
                return;
            }
            const nextAppt = appts[0];
            const dateStr = new Date(nextAppt.start.dateTime || nextAppt.start.date).toLocaleString('pt-BR');
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: `Tem certeza que deseja cancelar *${nextAppt.summary}* em ${dateStr}?\n\n1️⃣ Sim\n2️⃣ Não` }
            });
            nextState = { step: 'AWAITING_CANCELLATION_CONFIRMATION', appointmentToCancel: nextAppt };
        }
        // === Escolha de serviço (número) ===
        else if (!isNaN(parseInt(messageBody, 10))) {
            const index = parseInt(messageBody, 10) - 1;
            const services = clientInfo.config?.services || [];
            if (index < 0 || index >= services.length) {
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: "❌ Número inválido. Digite o número do serviço desejado." }
                });
                return;
            }
            const chosenService = services[index];
            nextState = { 
                step: 'AWAITING_DAY', 
                service: chosenService.name, 
                duration: chosenService.duration || 60, 
                calendarId: clientInfo.google_calendar_id 
            };
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', 
                text: { body: `💇‍♂️ Ótima escolha: *${chosenService.name}*! Consultando dias disponíveis...` }
            });
        }
        // === Padrão ===
        else {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', 
                text: { body: responses.default }
            });
        }

        // Salva ou limpa o estado
        if (nextState) {
            await db.saveConversationState(customerId, clientInfo.id, nextState);
            logger.debug('Estado salvo:', { customerId, step: nextState.step });
        } else if (currentState) {
            await db.deleteConversationState(customerId, clientInfo.id);
            logger.debug('Estado removido:', { customerId });
        }

    } catch (error) {
        logger.error('Erro global no handleIncomingMessage', { 
            error: error.message,
            stack: error.stack,
            customerId 
        });
        
        if (customerId && clientInfo?.whatsapp_phone_id && clientInfo?.whatsapp_token) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Ocorreu um erro inesperado. Tente novamente mais tarde." }
            });
        }
    }
}

module.exports = { handleIncomingMessage, sendWhatsAppMessage };