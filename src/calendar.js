const { google } = require('googleapis');
const path = require('path');
const logger = require('./logger'); // Importa o logger

const credentials = require(path.join(__dirname, '..', 'credentials.json'));
const calendarId = "d4b4b88394979da8b0dad7e1541f45b03a78282bae693101dc5f65bce999b11e@group.calendar.google.com"; //

const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar']
);

const calendar = google.calendar({ version: 'v3', auth });


async function listAvailableSlots(day) {
    const workingHours = { start: 9, end: 19 };
    const slotDuration = 60;

    const timeMin = new Date(day);
    timeMin.setHours(workingHours.start, 0, 0, 0);

    const timeMax = new Date(day);
    timeMax.setHours(workingHours.end, 0, 0, 0);

    try {
        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                items: [{ id: calendarId }]
            }
        });

        const busySlots = response.data.calendars[calendarId].busy;
        const allSlots = [];
        let currentSlot = new Date(timeMin);

        while (currentSlot < timeMax) {
            allSlots.push(new Date(currentSlot));
            currentSlot.setMinutes(currentSlot.getMinutes() + slotDuration);
        }

        const availableSlots = allSlots.filter(slot => {
            const isBusy = busySlots.some(busySlot => {
                const busyStart = new Date(busySlot.start);
                const busyEnd = new Date(busySlot.end);
                return slot >= busyStart && slot < busyEnd;
            });
            return !isBusy;
        });

        return availableSlots;
    } catch (error) {
        logger.error('Erro ao listar horários disponíveis no Google Calendar', { error: error.message });
        return [];
    }
}

async function isSlotAvailable(dateTimeStart) {
    try {
        const dateTimeEnd = new Date(new Date(dateTimeStart).getTime() + 60 * 60 * 1000);
        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: dateTimeStart.toISOString(),
                timeMax: dateTimeEnd.toISOString(),
                items: [{ id: calendarId }]
            }
        });
        const busySlots = response.data.calendars[calendarId].busy;
        return busySlots.length === 0;
    } catch (error) {
        logger.error('Erro ao verificar disponibilidade de horário', { error: error.message });
        return false; // Assume que não está disponível se houver erro
    }
}

async function createAppointment(dateTimeStart, service, customerName) {
    const available = await isSlotAvailable(new Date(dateTimeStart));
    if (!available) {
        logger.warn('Conflito de agendamento detectado', { dateTimeStart, customerName });
        throw new Error('CONFLICT');
    }

    const dateTimeEnd = new Date(new Date(dateTimeStart).getTime() + 60 * 60 * 1000);

    try {
        const event = {
            summary: `${service} - ${customerName}`,
            description: `Agendado via Chatbot.`,
            start: { dateTime: dateTimeStart, timeZone: 'America/Sao_Paulo' },
            end: { dateTime: dateTimeEnd, timeZone: 'America/Sao_Paulo' },
        };

        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event,
        });

        logger.info('Agendamento criado com sucesso no Google', { eventId: response.data.id, customerName });
        return response.data;
    } catch (error) {
        logger.error('Erro na API do Google ao criar agendamento', { error: error.message });
        throw new Error('API_ERROR');
    }
}

async function listCustomerAppointments(customerName) {
    const timeMin = new Date().toISOString();
    try {
        const response = await calendar.events.list({
            calendarId: calendarId,
            timeMin: timeMin,
            q: customerName,
            singleEvents: true,
            orderBy: 'startTime',
        });
        return response.data.items;
    } catch (error) {
        logger.error('Erro ao listar agendamentos do cliente', { customerName, error: error.message });
        return [];
    }
}

async function cancelAppointment(eventId) {
    try {
        await calendar.events.delete({
            calendarId: calendarId,
            eventId: eventId,
        });
        logger.info('Agendamento cancelado com sucesso no Google', { eventId });
        return true;
    } catch (error) {
        logger.error('Erro na API do Google ao cancelar agendamento', { eventId, error: error.message });
        throw new Error('API_ERROR');
    }
}

module.exports = { createAppointment, listAvailableSlots, isSlotAvailable, listCustomerAppointments, cancelAppointment };