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
 * Verifica se o dia é feriado
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
 * 🎯 CONVERSOR AUTOMÁTICO: Aceita números (9, 18) e strings ("09:00", "18:00")
 */
function normalizeWorkingHours(workingHours) {
  if (!workingHours) return { start: 9, end: 18 }; // padrão
  
  let startHour, endHour;
  
  // Converter start
  if (typeof workingHours.start === 'string') {
    // Formato "09:00" -> converter para número 9
    startHour = parseInt(workingHours.start.split(':')[0]);
  } else if (typeof workingHours.start === 'number') {
    // Já é número (9)
    startHour = workingHours.start;
  } else {
    startHour = 9; // padrão
  }
  
  // Converter end
  if (typeof workingHours.end === 'string') {
    // Formato "18:00" -> converter para número 18
    endHour = parseInt(workingHours.end.split(':')[0]);
  } else if (typeof workingHours.end === 'number') {
    // Já é número (18)
    endHour = workingHours.end;
  } else {
    endHour = 18; // padrão
  }
  
  console.log(`🔄 HORÁRIOS NORMALIZADOS: ${workingHours.start}-${workingHours.end} -> ${startHour}:00-${endHour}:00`);
  
  return { start: startHour, end: endHour };
}

/**
 * Lista os próximos dias em que o estabelecimento estará aberto
 */
async function listAvailableDays(calendarId, googleCredentials, workSchedule = {}, timezone = 'America/Sao_Paulo', daysToCheck = 14) {
  try {
    console.log('🔍 WORK_SCHEDULE RECEBIDO:', JSON.stringify(workSchedule, null, 2));

    const availableDays = [];
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);

    const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    for (let i = 0; i < daysToCheck; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + i);
      
      const dayOfWeek = daysOfWeek[currentDate.getDay()];
      const dayConfig = workSchedule[dayOfWeek];

      if (dayConfig?.available) {
        const holiday = await isHoliday(currentDate);
        if (holiday) {
          console.log(`❌ FERIADO: ${currentDate.toLocaleDateString('pt-BR')}`);
          continue;
        }

        const formattedDate = currentDate.toLocaleDateString('pt-BR', {
          weekday: 'long',
          day: '2-digit',
          month: '2-digit',
          year: 'numeric'
        });

        availableDays.push({
          date: currentDate.toISOString(),
          formatted: formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1)
        });

        console.log(`✅ DIA DISPONÍVEL: ${formattedDate} (${dayOfWeek})`);
      } else {
        console.log(`❌ DIA FECHADO: ${currentDate.toLocaleDateString('pt-BR')} (${dayOfWeek})`);
      }
    }

    console.log(`📊 TOTAL DE DIAS DISPONÍVEIS: ${availableDays.length}`);
    return availableDays;
  } catch (error) {
    logger.error('Erro em listAvailableDays', { error: error.message });
    return [];
  }
}

/**
 * Lista horários disponíveis - COM CONVERSÃO AUTOMÁTICA
 */
async function listAvailableSlots(
  day,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo',
  workingHours = { start: 9, end: 18 }, // 🎯 ACEITA NÚMEROS E STRINGS
  config = {}
) {
  try {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
    if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

    // 🎯 CONVERSÃO AUTOMÁTICA DOS HORÁRIOS
    const normalizedHours = normalizeWorkingHours(workingHours);
    const startHour = normalizedHours.start;
    const endHour = normalizedHours.end;

    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
    const allowSameDay = config.allowSameDay ?? true;

    // Validar horário de trabalho
    if (startHour >= endHour) {
      logger.warn('Horário de trabalho inválido', { start: startHour, end: endHour });
      return [];
    }

    // Verificar feriado
    const holiday = await isHoliday(day);
    if (holiday) {
      logger.info('Dia é feriado, fechado automaticamente.');
      return [];
    }

    // Criar range de tempo
    const timeMin = new Date(day);
    timeMin.setHours(startHour, 0, 0, 0);
    
    const timeMax = new Date(day);
    timeMax.setHours(endHour, 0, 0, 0);

    if (timeMin >= timeMax) {
      logger.warn('Range de tempo inválido', { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() });
      return [];
    }

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
      const slotInterval = 15;

      let currentSlot = new Date(timeMin);

      while (currentSlot.getTime() + durationInMinutes * 60000 <= timeMax.getTime()) {
        const slotEnd = new Date(currentSlot.getTime() + durationInMinutes * 60000);
        
        const isBusy = busySlots.some((busy) => {
          const busyStart = new Date(busy.start);
          const busyEnd = new Date(busy.end);
          return currentSlot < busyEnd && slotEnd > busyStart;
        });

        const isInFuture = currentSlot >= nowWithAdvance;

        if (!isBusy && isInFuture) {
          availableSlots.push(new Date(currentSlot));
        }

        currentSlot.setMinutes(currentSlot.getMinutes() + slotInterval);
        
        if (currentSlot.getTime() > timeMax.getTime()) {
          break;
        }
      }

      console.log(`✅ HORÁRIOS ENCONTRADOS: ${availableSlots.length} slots`);
      return availableSlots;

    } catch (error) {
      if (error.message.includes('time range is empty')) {
        logger.warn('Range de tempo vazio no Google Calendar');
        return [];
      }
      throw error;
    }

  } catch (error) {
    logger.error('Erro ao listar horários disponíveis', { 
      error: error.message,
      date: day.toISOString()
    });
    return [];
  }
}

/**
 * Método alternativo para gerar slots manualmente - COM CONVERSÃO
 */
async function generateSlotsManually(
  day,
  durationInMinutes,
  workingHours = { start: 9, end: 18 }, // 🎯 ACEITA NÚMEROS E STRINGS
  config = {}
) {
  const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
  const now = new Date();
  const nowWithAdvance = new Date(now.getTime() + minAdvanceMinutes * 60000);

  // 🎯 CONVERSÃO AUTOMÁTICA
  const normalizedHours = normalizeWorkingHours(workingHours);
  const startHour = normalizedHours.start;
  const endHour = normalizedHours.end;

  const availableSlots = [];
  const slotInterval = 30;

  console.log(`🔄 GERANDO SLOTS MANUALMENTE: ${startHour}:00-${endHour}:00`);

  for (let hour = startHour; hour < endHour; hour++) {
    for (let minute = 0; minute < 60; minute += slotInterval) {
      const slotTime = new Date(day);
      slotTime.setHours(hour, minute, 0, 0);
      
      const slotEnd = new Date(slotTime.getTime() + durationInMinutes * 60000);
      
      const closingTime = new Date(day);
      closingTime.setHours(endHour, 0, 0, 0);
      
      if (slotEnd <= closingTime && slotTime >= nowWithAdvance) {
        availableSlots.push(new Date(slotTime));
      }
    }
  }

  console.log(`✅ SLOTS MANUAIS GERADOS: ${availableSlots.length}`);
  return availableSlots;
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
  try {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const start = new Date(dateTimeStart);
    const end = new Date(start.getTime() + durationInMinutes * 60000);
    
    const response = await calendar.freebusy.query({
      requestBody: { 
        timeMin: start.toISOString(), 
        timeMax: end.toISOString(), 
        timeZone: timezone, 
        items: [{ id: calendarId }] 
      },
    });
    
    const busy = response.data.calendars?.[calendarId]?.busy || [];
    return busy.length === 0;
  } catch (error) {
    logger.error('Erro ao verificar disponibilidade do slot', { error: error.message });
    return false;
  }
}

/**
 * Cria o agendamento
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

  if (start.getTime() - now.getTime() < minAdvanceMinutes * 60000) {
    throw new Error('MIN_ADVANCE_NOT_MET');
  }
  if (!allowSameDay && start.toDateString() === now.toDateString()) {
    throw new Error('SAME_DAY_NOT_ALLOWED');
  }

  const holiday = await isHoliday(start);
  if (holiday) throw new Error('HOLIDAY_CLOSED');

  let available = false;
  try {
    available = await isSlotAvailable(start, durationInMinutes, calendarId, googleCredentials, timezone);
  } catch (e) {
    logger.error('Falha ao checar disponibilidade antes de criar evento', { error: e.message });
    throw new Error('GOOGLE_AVAILABILITY_CHECK_FAILED');
  }
  
  if (!available) throw new Error('CONFLICT');

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
  try {
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
  } catch (error) {
    logger.error('Erro ao listar agendamentos do cliente', { error: error.message });
    return [];
  }
}

/**
 * Cancela um agendamento
 */
async function cancelAppointment(eventId, calendarId, googleCredentials) {
  try {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    await calendar.events.delete({ calendarId, eventId });
    logger.info('✅ Agendamento cancelado', { calendarId, eventId });
    return true;
  } catch (error) {
    logger.error('Erro ao cancelar agendamento', { error: error.message });
    throw error;
  }
}

module.exports = {
  createAppointment,
  listAvailableSlots,
  listAvailableDays,
  isSlotAvailable,
  listCustomerAppointments,
  cancelAppointment,
  getAuthenticatedCalendarClient,
  generateSlotsManually
};