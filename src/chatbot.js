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

// === Parser de data em português (Chrono) ===
function createPortugueseParser() {
    try {
        const chronoPt = require('chrono-node/dist/cjs/locales/pt');
        const customChrono = new chrono.Chrono();
        customChrono.parsers.push(...chronoPt.parsers);
        customChrono.refiners.push(...chronoPt.refiners);
        logger.debug("Parser PT carregado com sucesso");
        return customChrono;
    } catch {
        logger.warn('Locale PT não disponível, usando padrão EN');
        return chrono;
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

// Mensagem 1: confirmação da escolha
await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
  to: customerId,
  type: 'text',
  text: { body: `💇‍♂️ Ótima escolha: *${state.service}*!` }
});

// Mensagem 2: já listar próximos dias disponíveis
const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';
const businessHours = clientInfo.config?.business_hours || {};
const availableDays = await calendarApi.listAvailableDays(state.calendarId, clientInfo.google_credentials, businessHours, timezone);

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
    body:
      `Esses são os próximos dias disponíveis:\n\n${formattedDays}\n\n` +
      `Envie o número do dia desejado ou digite uma data específica (ex: "30/10").`
  }
});

state.step = 'AWAITING_DAY_SELECTION';
state.availableDays = availableDays;
return state;

};

// === Escolha de dia (inteligente com dias disponíveis e feriados) ===
// === Escolha de dia (inteligente com dias disponíveis e feriados) ===
stateHandlers.AWAITING_DAY = async (message, state, clientInfo, responses) => {
  const customerId = message.from;
  const messageBody = message.text.body.trim().toLowerCase();
  const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';
  const businessHours = clientInfo.config?.business_hours || {};
  const calendarId = state.calendarId || clientInfo.google_calendar_id;
  const minAdvanceMinutes = clientInfo.config?.minAdvanceMinutes || 120;
  const googleCredentials = clientInfo.google_credentials;

  const parser = require('chrono-node');
  const parsed = parser.pt?.parse(messageBody, new Date(), { forwardDate: true }) || parser.parse(messageBody, new Date(), { forwardDate: true });
  let parsedDate = parsed.length ? parsed[0].start.date() : null;

  // 🧠 Tenta interpretar formato manual "30/10"
  if (!parsedDate && /^\d{1,2}\/\d{1,2}$/.test(messageBody)) {
    const [day, month] = messageBody.split('/').map(Number);
    const year = new Date().getFullYear();
    parsedDate = new Date(year, month - 1, day);
  }

  // 🔹 Se o texto não for compreendido, listar dias disponíveis automaticamente
  if (!parsedDate) {
    const availableDays = await calendarApi.listAvailableDays(calendarId, googleCredentials, businessHours, timezone);

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
              `Envie o número do dia desejado ou digite uma data específica (ex: "30/10").`
      }
    });

    state.step = 'AWAITING_DAY_SELECTION';
    state.availableDays = availableDays;
    return state;
  }

  // 🔹 Ignora horários passados se for hoje
  const now = new Date();
  if (parsedDate.toDateString() === now.toDateString() && parsedDate.getTime() < now.getTime()) parsedDate = now;

  // 🔹 Calcula horário de funcionamento do dia escolhido
  const weekdayIndex = parsedDate.getDay();
  const dayKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayKey = dayKeys[weekdayIndex];
  const config = businessHours[dayKey];
  const [openHour, closeHour] = config?.open ? config.open.split(':').map(Number) : [9, 18];
  const workingHours = { start: openHour, end: closeHour };

  const duration = state.duration || 60;

  // 🔹 Lista horários disponíveis
  const slots = await calendarApi.listAvailableSlots(
    parsedDate,
    duration,
    calendarId,
    googleCredentials,
    timezone,
    workingHours,
    { minAdvanceMinutes, allowSameDay: true }
  );

  if (!slots.length) {
    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
      to: customerId, type: 'text',
      text: { body: `😕 Nenhum horário disponível para ${parsedDate.toLocaleDateString('pt-BR')}. Tente outro dia.` }
    });
    return state;
  }

  const slotList = slots.map((s, i) => `${i + 1}️⃣ ${new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join('\n');
  await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
    to: customerId, type: 'text',
    text: { body: `✅ Horários disponíveis em ${parsedDate.toLocaleDateString('pt-BR')}:\n\n${slotList}\n\nEnvie o número do horário desejado.` }
  });

  state.step = 'AWAITING_SLOT';
  state.availableSlots = slots.map(s => s.toISOString());
  state.chosenDay = parsedDate;
  return state;
};


// === Novo: seleção do dia sugerido ===
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
    state.chosenDay = date;
    state.step = 'AWAITING_DAY';
    message.text.body = msg; // força reprocessamento
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
  const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';
  const businessHours = clientInfo.config?.business_hours || {};
  const weekdayIndex = parsedDate.getDay();
  const dayKeys = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const config = businessHours[dayKeys[weekdayIndex]];
  const [openHour, closeHour] = config?.open ? config.open.split(':').map(Number) : [9, 18];
  const workingHours = { start: openHour, end: closeHour };

  const slots = await calendarApi.listAvailableSlots(
    parsedDate,
    duration,
    state.calendarId,
    clientInfo.google_credentials,
    timezone,
    workingHours,
    { minAdvanceMinutes: clientInfo.config?.minAdvanceMinutes || 120, allowSameDay: true }
  );

  if (!slots.length) {
    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
      to: customerId, type: 'text',
      text: { body: `😕 Nenhum horário disponível para ${selectedDay.formatted}. Escolha outro dia.` }
    });
    return state;
  }

  const slotList = slots.map((s, i) => `${i + 1}️⃣ ${new Date(s).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join('\n');
  await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
    to: customerId, type: 'text',
    text: { body: `✅ Horários disponíveis para ${selectedDay.formatted}:\n\n${slotList}\n\nEnvie o número do horário desejado.` }
  });

  state.step = 'AWAITING_SLOT';
  state.availableSlots = slots.map(s => s.toISOString());
  state.chosenDay = parsedDate;
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
    const dateStr = chosenSlot.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

    state.step = 'AWAITING_FINAL_CONFIRMATION';
    state.chosenSlot = chosenSlot.toISOString();

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId,
        type: 'text',
        text: { body: `🕒 Você escolheu ${dateStr} para o serviço *${state.service}*.\n\n1️⃣ Confirmar\n2️⃣ Cancelar` }
    });

    return state;
};

// === Confirmação final do agendamento ===
stateHandlers.AWAITING_FINAL_CONFIRMATION = async (message, state, clientInfo) => {
    const customerId = message.from;
    const msg = message.text.body.trim();
    const chosenSlot = new Date(state.chosenSlot);
    const calendarId = state.calendarId || clientInfo.google_calendar_id;
    const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';
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
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: `✅ Agendamento confirmado!\n📅 ${chosenSlot.toLocaleString('pt-BR')}\n💇 Serviço: ${state.service}` }
            });
            return null;
        } catch (error) {
            logger.error('Erro ao criar agendamento', { error: error.message });
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Ocorreu um erro ao confirmar o agendamento. Tente novamente." }
            });
            return state;
        }
    }

    await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
        to: customerId, type: 'text',
        text: { body: "Agendamento cancelado. Digite 'menu' para recomeçar." }
    });
    return null;
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

        if (!messageObject?.text?.body || !metadataObject?.phone_number_id)
            return logger.debug('Payload ignorado (não é texto válido)');

        customerId = messageObject.from;
        const messageBody = messageObject.text.body.trim();
        const customerName = contactObject?.profile?.name || "Cliente";
        const businessPhoneId = metadataObject.phone_number_id;

        clientInfo = await db.getClientByPhoneId(businessPhoneId);
        if (!clientInfo?.whatsapp_token) return logger.error(`Número não registrado: ${businessPhoneId}`);

        responses = getResponses(clientInfo.config || {});
        currentState = await db.getConversationState(customerId, clientInfo.id);

        const payload = { from: customerId, text: { body: messageBody }, profile: { name: customerName } };
        const msgUpper = messageBody.toUpperCase();

        let nextState = null;

        // === Continua fluxo atual ===
        if (currentState?.step && stateHandlers[currentState.step]) {
            nextState = await stateHandlers[currentState.step](payload, currentState, clientInfo, responses);
        }

        // === Saudação ou menu ===
        else if (/^(oi|olá|menu|bom dia|boa tarde|boa noite)$/i.test(messageBody)) {
            const services = clientInfo.config?.services || [];
            const welcomeMsg = responses.welcome(customerName);
            const serviceList = services.length ? generateNumberedList(services, 'service') : "(Nenhum serviço cadastrado)";
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: `${welcomeMsg}\n\n${responses.askForService(serviceList)}` }
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
            nextState = { step: 'AWAITING_DAY', service: chosenService.name, duration: chosenService.duration || 60, calendarId: clientInfo.google_calendar_id };
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: responses.askForDay(chosenService.name) }
            });
        }

        // === Padrão ===
        else {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: responses.default }
            });
        }

        if (nextState) await db.saveConversationState(customerId, clientInfo.id, nextState);
        else if (currentState) await db.deleteConversationState(customerId, clientInfo.id);

    } catch (error) {
        logger.error('Erro global no handleIncomingMessage', { error: error.message });
        if (customerId && clientInfo?.whatsapp_phone_id && clientInfo?.whatsapp_token) {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text',
                text: { body: "❌ Ocorreu um erro inesperado. Tente novamente mais tarde." }
            });
        }
    }
}

module.exports = { handleIncomingMessage };
