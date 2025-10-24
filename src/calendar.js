const { google } = require('googleapis');
const { JWT } = require('google-auth-library'); // Usar JWT para autenticação moderna
const logger = require('./logger');

/**
 * Cria um cliente autenticado da API do Google Calendar para um cliente específico.
 * @param {object} googleCredentials - O objeto JSON das credenciais para o cliente.
 * @returns {object} Uma instância autenticada do cliente da API do Google Calendar.
 * @throws {Error} Se a autenticação falhar.
 */
function getAuthenticatedCalendarClient(googleCredentials) {
    if (!googleCredentials || !googleCredentials.client_email || !googleCredentials.private_key) {
        throw new Error('INVALID_GOOGLE_CREDENTIALS: Faltando client_email ou private_key.');
    }
    try {
        const scopes = ['https://www.googleapis.com/auth/calendar'];
        const auth = new JWT({
            email: googleCredentials.client_email,
            key: googleCredentials.private_key,
            scopes: scopes,
        });
        return google.calendar({ version: 'v3', auth });
    } catch (error) {
        logger.error('Falha ao criar cliente do Google Calendar', { error: error.message, client_email: googleCredentials.client_email });
        throw new Error(`GOOGLE_AUTH_FAILED: ${error.message}`);
    }
}

/**
 * Lista os horários disponíveis para o calendário de um cliente específico.
 * @param {Date} day - O dia para verificar.
 * @param {number} durationInMinutes - A duração do horário desejado.
 * @param {string} calendarId - O ID específico do Google Calendar para este cliente.
 * @param {object} googleCredentials - O objeto de credenciais para este cliente.
 * @param {string} [timezone='America/Sao_Paulo'] - O fuso horário para os cálculos.
 * @param {object} [workingHours={ start: 9, end: 19 }] - Objeto com hora de início e fim { start: 9, end: 19 }.
 * @returns {Promise<Array<Date>>} Uma lista de horários de início disponíveis como objetos Date.
 */
async function listAvailableSlots(day, durationInMinutes, calendarId, googleCredentials, timezone = 'America/Sao_Paulo', workingHours = { start: 9, end: 19 }) {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
    if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

    const calendar = getAuthenticatedCalendarClient(googleCredentials); // Autentica sob demanda

    try {
        const timeMin = new Date(day);
        timeMin.setHours(workingHours.start, 0, 0, 0);

        const timeMax = new Date(day);
        timeMax.setHours(workingHours.end, 0, 0, 0);

        // Garantir que estamos a procurar horários no futuro (adicionar buffer, ex: 30 min)
        const nowWithBuffer = new Date(Date.now() + 30 * 60000);
        if (timeMin < nowWithBuffer) {
            timeMin.setTime(nowWithBuffer.getTime());
             // Ajustar minutos para o próximo intervalo de 15 min se necessário, dependendo da precisão desejada
             const minutes = timeMin.getMinutes();
             const remainder = minutes % 15; // Exemplo: verificar a cada 15 min
             if (remainder !== 0) {
                 timeMin.setMinutes(minutes + (15 - remainder));
             }
        }

        logger.info('Buscando horários disponíveis', {
            calendarId: calendarId,
            date: day.toDateString(),
            duration: durationInMinutes,
            timeMin: timeMin.toLocaleString('pt-BR', { timeZone: timezone }), // Usar timezone na formatação
            timeMax: timeMax.toLocaleString('pt-BR', { timeZone: timezone })
        });

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                timeZone: timezone,
                items: [{ id: calendarId }]
            }
        });

        const busySlots = response.data.calendars?.[calendarId]?.busy || [];
        const availableSlots = [];
        const slotInterval = 15; // Verificar disponibilidade a cada 15 minutos para flexibilidade

        let currentSlotStart = new Date(timeMin);

        // Itera enquanto o fim do slot potencial ainda está dentro do horário de trabalho
        while (currentSlotStart.getTime() + durationInMinutes * 60000 <= timeMax.getTime()) {
            const currentSlotEnd = new Date(currentSlotStart.getTime() + durationInMinutes * 60000);

            // Verifica se este slot potencial se sobrepõe a algum slot ocupado
            const isBusy = busySlots.some(busy => {
                const busyStart = new Date(busy.start);
                const busyEnd = new Date(busy.end);
                // Condição de sobreposição: (SlotStart < BusyEnd) e (SlotEnd > BusyStart)
                return currentSlotStart < busyEnd && currentSlotEnd > busyStart;
            });

            // Se não está ocupado E começa depois do buffer atual, adiciona
            if (!isBusy && currentSlotStart >= nowWithBuffer) {
                availableSlots.push(new Date(currentSlotStart));
            }

            // Move para o próximo horário de início potencial
            currentSlotStart.setMinutes(currentSlotStart.getMinutes() + slotInterval);
        }

        logger.info('Horários disponíveis encontrados', {
            calendarId: calendarId,
            total: availableSlots.length,
            // slots: availableSlots.map(s => s.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: timezone })) // Manter se necessário para log
        });

        return availableSlots;
    } catch (error) {
        logger.error('Erro ao listar horários disponíveis', {
            calendarId: calendarId,
            error: error.message,
            code: error.code // Incluir código de erro da API do Google se disponível
        });
        // Relançar um erro mais específico potencialmente
         if (error.code === 404) throw new Error('CALENDAR_NOT_FOUND');
         if (error.code === 401 || error.code === 403) throw new Error('GOOGLE_PERMISSION_ERROR');
        throw error; // Relançar erro original se não tratado especificamente
    }
}

/**
 * Verifica se um horário específico está disponível.
 * @param {string|Date} dateTimeStart - O horário de início para verificar.
 * @param {number} durationInMinutes - A duração do horário.
 * @param {string} calendarId - O ID específico do Google Calendar para este cliente.
 * @param {object} googleCredentials - O objeto de credenciais para este cliente.
 * @param {string} [timezone='America/Sao_Paulo'] - O fuso horário para os cálculos.
 * @returns {Promise<boolean>} Verdadeiro se o horário está disponível, falso caso contrário.
 */
async function isSlotAvailable(dateTimeStart, durationInMinutes, calendarId, googleCredentials, timezone = 'America/Sao_Paulo') {
     if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
     if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

     const calendar = getAuthenticatedCalendarClient(googleCredentials);

    try {
        const startTime = new Date(dateTimeStart);
        const endTime = new Date(startTime.getTime() + durationInMinutes * 60000);

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: startTime.toISOString(),
                timeMax: endTime.toISOString(),
                timeZone: timezone,
                items: [{ id: calendarId }]
            }
        });

        const busySlots = response.data.calendars?.[calendarId]?.busy || [];
        return busySlots.length === 0; // Disponível se nenhum slot ocupado se sobrepuser
    } catch (error) {
        logger.error('Erro ao verificar disponibilidade', { calendarId: calendarId, error: error.message, code: error.code });
        // Dependendo dos requisitos, pode retornar falso ou relançar o erro
        return false; // Padrão mais seguro: assumir indisponível se a verificação falhar
    }
}

/**
 * Cria um evento de agendamento no Google Calendar especificado.
 * @param {string|Date} dateTimeStart - O horário de início do agendamento.
 * @param {string} service - O nome do serviço.
 * @param {string} customerName - O nome do cliente.
 * @param {number} durationInMinutes - A duração do agendamento.
 * @param {string} calendarId - O ID específico do Google Calendar para este cliente.
 * @param {object} googleCredentials - O objeto de credenciais para este cliente.
 * @param {string} [timezone='America/Sao_Paulo'] - O fuso horário para o evento.
 * @returns {Promise<object>} O objeto do evento criado no Google Calendar.
 * @throws {Error} Se o horário não está disponível (CONFLICT) ou ocorre erro na API.
 */
async function createAppointment(dateTimeStart, service, customerName, durationInMinutes, calendarId, googleCredentials, timezone = 'America/Sao_Paulo') {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
    if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const startTime = new Date(dateTimeStart);

    // Re-verificar disponibilidade imediatamente antes de criar para minimizar condições de corrida
    const available = await isSlotAvailable(startTime, durationInMinutes, calendarId, googleCredentials, timezone);

    if (!available) {
        logger.warn('Conflito de agendamento detectado antes de criar evento', {
            calendarId: calendarId,
            dateTimeStart: startTime.toLocaleString('pt-BR', { timeZone: timezone }),
            customerName,
            service
        });
        throw new Error('CONFLICT'); // Erro explícito de conflito
    }

    const endTime = new Date(startTime.getTime() + durationInMinutes * 60000);

    try {
        const event = {
            summary: `${service} - ${customerName}`,
            description: `Agendamento realizado via Chatbot WhatsApp.`,
            start: {
                dateTime: startTime.toISOString(),
                timeZone: timezone
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: timezone
            },
            // Pode adicionar lembretes aqui mais tarde
            // reminders: {
            //   useDefault: false,
            //   overrides: [
            //     {method: 'popup', 'minutes': 60}, // Exemplo: 1 hora antes
            //   ],
            // },
        };

        logger.info('Criando evento no Google Calendar', {
            calendarId: calendarId,
            customerName,
            service,
            start: startTime.toLocaleString('pt-BR', { timeZone: timezone })
        });

        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event,
            // sendNotifications: true, // Descomente se quiser notificar convidados (se houver)
        });

        logger.info('✅ Agendamento criado com sucesso no Google Calendar', {
            calendarId: calendarId,
            eventId: response.data.id,
            customerName,
            service,
            start: startTime.toLocaleString('pt-BR', { timeZone: timezone })
        });

        return response.data;
    } catch (error) {
        logger.error('❌ Erro ao criar agendamento no Google Calendar', {
            calendarId: calendarId,
            error: error.message,
            code: error.code,
            customerName,
            service
        });

        if (error.code === 409) { // Código de conflito da API do Google
            throw new Error('CONFLICT');
        } else if (error.code === 404) {
             throw new Error('CALENDAR_NOT_FOUND');
        } else if (error.code === 401 || error.code === 403) {
            throw new Error('GOOGLE_PERMISSION_ERROR');
        } else {
            throw new Error('GOOGLE_API_ERROR'); // Erro genérico da API do Google
        }
    }
}

/**
 * Lista agendamentos futuros para um cliente num calendário específico.
 * @param {string} customerName - O nome do cliente para procurar.
 * @param {string} calendarId - O ID específico do Google Calendar para este cliente.
 * @param {object} googleCredentials - O objeto de credenciais para este cliente.
 * @param {string} [timezone='America/Sao_Paulo'] - O fuso horário para a consulta.
 * @returns {Promise<Array<object>>} Uma lista de objetos de evento do Google Calendar.
 */
async function listCustomerAppointments(customerName, calendarId, googleCredentials, timezone = 'America/Sao_Paulo') {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');

    const calendar = getAuthenticatedCalendarClient(googleCredentials);

    try {
        const timeMin = new Date().toISOString(); // A partir de agora

        logger.info('Buscando agendamentos do cliente', { calendarId: calendarId, customerName });

        const response = await calendar.events.list({
            calendarId: calendarId,
            timeMin: timeMin,
            q: customerName, // Usar o parâmetro de busca 'q' do Google
            singleEvents: true,
            orderBy: 'startTime',
            timeZone: timezone,
            maxResults: 10 // Limitar resultados por performance
        });

        const appointments = response.data.items || [];

        logger.info('Agendamentos encontrados', {
            calendarId: calendarId,
            customerName,
            count: appointments.length
        });

        return appointments;
    } catch (error) {
        logger.error('Erro ao listar agendamentos do cliente', {
            calendarId: calendarId,
            customerName,
            error: error.message,
            code: error.code
        });
         if (error.code === 404) throw new Error('CALENDAR_NOT_FOUND');
         if (error.code === 401 || error.code === 403) throw new Error('GOOGLE_PERMISSION_ERROR');
        // Retornar lista vazia em caso de erro, ou relançar dependendo do comportamento desejado
        return [];
    }
}
/**
 * Cancela um evento de agendamento específico.
 * @param {string} eventId - O ID do evento a cancelar.
 * @param {string} calendarId - O ID específico do Google Calendar onde o evento reside.
 * @param {object} googleCredentials - O objeto de credenciais para este cliente.
 * @returns {Promise<boolean>} Verdadeiro se o cancelamento foi bem-sucedido ou evento não existia, lança erro caso contrário.
 */
async function cancelAppointment(eventId, calendarId, googleCredentials) {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
    if (!eventId) throw new Error('MISSING_EVENT_ID');

    const calendar = getAuthenticatedCalendarClient(googleCredentials);

    try {
        logger.info('Cancelando agendamento', { calendarId: calendarId, eventId });

        await calendar.events.delete({
            calendarId: calendarId,
            eventId: eventId,
            // sendNotifications: true, // Descomente se quiser notificar
        });

        logger.info('✅ Agendamento cancelado com sucesso', { calendarId: calendarId, eventId });
        return true;
    } catch (error) {
        logger.error('❌ Erro ao cancelar agendamento', {
            calendarId: calendarId,
            eventId,
            error: error.message,
            code: error.code
        });

        if (error.code === 404 || error.code === 410) { // 404 Não Encontrado ou 410 Já se Foi
            logger.warn('Agendamento não encontrado ou já excluído ao tentar cancelar', { calendarId: calendarId, eventId });
            return true; // Considerar "bem-sucedido" se já não existe
        } else if (error.code === 401 || error.code === 403) {
            throw new Error('GOOGLE_PERMISSION_ERROR');
        } else {
            throw new Error('GOOGLE_API_ERROR');
        }
    }
}

module.exports = {
    createAppointment,
    listAvailableSlots,
    isSlotAvailable,
    listCustomerAppointments,
    cancelAppointment,
    getAuthenticatedCalendarClient
};