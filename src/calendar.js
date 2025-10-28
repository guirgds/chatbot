// src/calendar.js
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const logger = require('./logger');

// Axios: timeout padrão para chamadas externas (feriados)
const AXIOS_TIMEOUT = 6000;

/**
 * Normaliza private_key vinda de env/BD com '\n' literais.
 */
function normalizePrivateKey(key) {
  if (!key) return key;
  // Se contiver "\n" literais, converte para quebras reais
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

/**
 * Cria um cliente autenticado da API do Google Calendar
 */
function getAuthenticatedCalendarClient(googleCredentials) {
  if (!googleCredentials?.client_email || !googleCredentials?.private_key) {
    throw new Error('INVALID_GOOGLE_CREDENTIALS');
  }
  const auth = new JWT({
    email: googleCredentials.client_email,
    key: normalizePrivateKey(googleCredentials.private_key),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Verifica se o dia é feriado (via API pública Nager.Date)
 * @param {Date} date
 * @param {string} countryCode (default 'BR')
 */
async function isHoliday(date, countryCode = 'BR') {
  try {
    const year = date.getFullYear();
    const apiUrl = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
    const response = await axios.get(apiUrl, { timeout: AXIOS_TIMEOUT });
    const formatted = date.toISOString().split('T')[0];
    return response.data.some((holiday) => holiday.date === formatted);
  } catch (err) {
    logger.warn('Falha ao verificar feriado, assumindo dia normal', { error: err.message });
    return false;
  }
}

/**
 * Verifica se há evento “Aberto” no dia (permite funcionamento em feriado)
 */
async function hasOverrideOpenEvent(date, calendarId, googleCredentials) {
  try {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
      calendarId,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      q: 'Aberto', // busca por título contendo "Aberto"
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (response.data.items || []).length > 0;
  } catch (error) {
    logger.warn('Erro ao verificar eventos “Aberto” no Google Calendar', { error: error.message });
    return false;
  }
}

/**
 * Lista os próximos dias em que o estabelecimento estará aberto
 * Considera feriados e dias de funcionamento configurados
 * @returns [{ name, date, formatted }]
 */
async function listAvailableDays(calendarId, googleCredentials, businessHours = {}, timezone = 'America/Sao_Paulo') {
  const daysOfWeek = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const availableDays = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const dayName = daysOfWeek[date.getDay()];
    const hours = businessHours[dayName];

    // se não há horário configurado, o dia é fechado
    if (!hours || !hours.open || !hours.close) continue;

    const holiday = await isHoliday(date);
    const openOverride = await hasOverrideOpenEvent(date, calendarId, googleCredentials);

    // se for feriado e não houver evento "Aberto", pula o dia
    if (holiday && !openOverride) continue;

    availableDays.push({
      name: dayName,
      date,
      formatted: date.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' }),
    });
  }

  logger.info('Dias disponíveis encontrados', {
    total: availableDays.length,
    days: availableDays.map((d) => d.formatted),
  });

  return availableDays;
}

/**
 * Lista horários disponíveis (com antecedência mínima, feriados e dias de funcionamento)
 * `config` pode conter: { minAdvanceMinutes: number, allowSameDay: boolean }
 */
async function listAvailableSlots(
  day,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo',
  workingHours = { start: 9, end: 19 },
  config = {}
) {
  if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
  if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

  const calendar = getAuthenticatedCalendarClient(googleCredentials);
  const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
  const allowSameDay = config.allowSameDay ?? true;

  const holiday = await isHoliday(day);
  const openOverride = await hasOverrideOpenEvent(day, calendarId, googleCredentials);
  if (holiday && !openOverride) {
    logger.info('Dia é feriado e sem evento “Aberto”, fechado automaticamente.');
    return [];
  }

  const timeMin = new Date(day);
  timeMin.setHours(workingHours.start, 0, 0, 0);
  const timeMax = new Date(day);
  timeMax.setHours(workingHours.end, 0, 0, 0);

  const now = new Date();
  const nowWithAdvance = new Date(now.getTime() + minAdvanceMinutes * 60000);
  const isSameDay = day.toDateString() === now.toDateString();
  if (isSameDay && !allowSameDay) {
    logger.info('Cliente não permite agendamento no mesmo dia.');
    return [];
  }

  try {
    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        timeZone: timezone,
        items: [{ id: calendarId }],
      },
    });

    const busySlots = resp.data.calendars?.[calendarId]?.busy || [];
    const availableSlots = [];
    const slotInterval = 15; // min

    let currentSlot = new Date(timeMin);

    while (currentSlot.getTime() + durationInMinutes * 60000 <= timeMax.getTime()) {
      const slotEnd = new Date(currentSlot.getTime() + durationInMinutes * 60000);
      const isBusy = busySlots.some((b) => {
        const busyStart = new Date(b.start);
        const busyEnd = new Date(b.end);
        return currentSlot < busyEnd && slotEnd > busyStart;
      });

      if (!isBusy && currentSlot >= nowWithAdvance) {
        availableSlots.push(new Date(currentSlot));
      }

      currentSlot.setMinutes(currentSlot.getMinutes() + slotInterval);
    }

    logger.info('Horários disponíveis encontrados', {
      date: day.toISOString().split('T')[0],
      total: availableSlots.length,
    });

    return availableSlots;
  } catch (error) {
    logger.error('Erro ao listar horários disponíveis', { error: error.message });
    return [];
  }
}

/**
 * Verifica se um horário está livre
 */
async function isSlotAvailable(
  dateTimeStart,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo'
) {
  const calendar = getAuthenticatedCalendarClient(googleCredentials);
  const start = new Date(dateTimeStart);
  const end = new Date(start.getTime() + durationInMinutes * 60000);
  const response = await calendar.freebusy.query({
    requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), timeZone: timezone, items: [{ id: calendarId }] },
  });
  const busy = response.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}

/**
 * Cria o agendamento respeitando antecedência mínima, feriado e horário
 * `config` pode conter: { minAdvanceMinutes: number, allowSameDay: boolean, workingHours?: {start,end} }
 */
async function createAppointment(
  dateTimeStart,
  service,
  customerName,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo',
  config = {}
) {
  const calendar = getAuthenticatedCalendarClient(googleCredentials);
  const start = new Date(dateTimeStart);
  const end = new Date(start.getTime() + durationInMinutes * 60000);
  const now = new Date();

  const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
  const allowSameDay = config.allowSameDay ?? true;
  const workingHours = config.workingHours || null;

  // Regras de antecedência
  if (start.getTime() - now.getTime() < minAdvanceMinutes * 60000) throw new Error('MIN_ADVANCE_NOT_MET');
  if (!allowSameDay && start.toDateString() === now.toDateString()) throw new Error('SAME_DAY_NOT_ALLOWED');

  // Feriados + exceção "Aberto"
  const holiday = await isHoliday(start);
  const openOverride = await hasOverrideOpenEvent(start, calendarId, googleCredentials);
  if (holiday && !openOverride) throw new Error('HOLIDAY_CLOSED');

  // (Opcional) validar contra horário de funcionamento
  if (workingHours) {
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getHours() + end.getMinutes() / 60;
    if (startHour < workingHours.start || endHour > workingHours.end) {
      throw new Error('OUTSIDE_WORKING_HOURS');
    }
  }

  // Disponibilidade final
  let available = false;
  try {
    available = await isSlotAvailable(start, durationInMinutes, calendarId, googleCredentials, timezone);
  } catch (e) {
    logger.error('Falha ao checar disponibilidade antes de criar evento', { error: e.message });
    throw new Error('GOOGLE_AVAILABILITY_CHECK_FAILED');
  }
  if (!available) throw new Error('CONFLICT');

  // Criação do evento
  const event = {
    summary: `${service} - ${customerName}`,
    description: `Agendamento via Chatbot WhatsApp.`,
    start: { dateTime: start.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
  };

  const response = await calendar.events.insert({ calendarId, resource: event });

  logger.info('✅ Agendamento criado com sucesso', {
    calendarId,
    service,
    customerName,
    start: start.toISOString(),
  });

  return response.data;
}

/**
 * Lista agendamentos futuros de um cliente
 */
async function listCustomerAppointments(customerName, calendarId, googleCredentials, timezone = 'America/Sao_Paulo') {
  const calendar = getAuthenticatedCalendarClient(googleCredentials);
  const resp = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    q: customerName,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: timezone,
  });
  return resp.data.items || [];
}

/**
 * Cancela um agendamento
 */
async function cancelAppointment(eventId, calendarId, googleCredentials) {
  const calendar = getAuthenticatedCalendarClient(googleCredentials);
  await calendar.events.delete({ calendarId, eventId });
  logger.info('✅ Agendamento cancelado', { calendarId, eventId });
  return true;
}

module.exports = {
  createAppointment,
  listAvailableSlots,
  listAvailableDays, // ✅ usado pelo chatbot para sugerir próximos dias abertos
  isSlotAvailable,
  listCustomerAppointments,
  cancelAppointment,
  getAuthenticatedCalendarClient,
};
