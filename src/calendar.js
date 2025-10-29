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
 * Converte string "09:00" para número 9
 */
function parseTimeString(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (typeof timeStr === 'string') {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours + (minutes / 60); // Retorna decimal para precisão (ex: 9.5 para 09:30)
  }
  return 9; // padrão
}

/**
 * 🎯 CONVERSOR PARA MÚLTIPLOS PERÍODOS
 */
function normalizeWorkingPeriods(dayConfig) {
  if (!dayConfig?.available) {
    return [];
  }
  
  // Se já tem períodos definidos, usar eles
  if (dayConfig.periods && Array.isArray(dayConfig.periods)) {
    const validPeriods = dayConfig.periods
      .filter(period => period.start && period.end)
      .map(period => ({
        start: parseTimeString(period.start),
        end: parseTimeString(period.end)
      }))
      .filter(period => period.start < period.end); // Remover períodos inválidos
    
    if (validPeriods.length > 0) {
      return validPeriods;
    }
  }
  
  // Se não tem períodos, usar o formato antigo (backward compatibility)
  if (dayConfig.start && dayConfig.end) {
    const start = parseTimeString(dayConfig.start);
    const end = parseTimeString(dayConfig.end);
    
    if (start < end) {
      return [{ start, end }];
    }
  }
  
  // Padrão se nada estiver definido
  return [{ start: 9, end: 18 }];
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

      // Verificar se o dia tem períodos de trabalho válidos
      const workingPeriods = normalizeWorkingPeriods(dayConfig);
      const hasValidPeriods = workingPeriods.length > 0;

      if (hasValidPeriods) {
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
          formatted: formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1),
          periods: workingPeriods.length
        });

        console.log(`✅ DIA DISPONÍVEL: ${formattedDate} (${dayOfWeek}) - ${workingPeriods.length} período(s)`);
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
 * Lista horários disponíveis - COM SUPORTE A MÚLTIPLOS PERÍODOS
 */
async function listAvailableSlots(
  day,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo',
  dayConfig = {}, // ✅ MUDANÇA: Recebe dayConfig completo
  config = {}
) {
  try {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
    if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

    // ✅ CORREÇÃO: Obter múltiplos períodos do dia
    const workingPeriods = normalizeWorkingPeriods(dayConfig);
    const slotInterval = Number.isFinite(config.slotInterval) ? config.slotInterval : 30;

    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
    const allowSameDay = config.allowSameDay ?? true;

    // Verificar se há períodos de trabalho
    if (workingPeriods.length === 0) {
      logger.warn('Nenhum período de trabalho definido para este dia');
      return [];
    }

    // Verificar feriado
    const holiday = await isHoliday(day);
    if (holiday) {
      logger.info('Dia é feriado, fechado automaticamente.');
      return [];
    }

    const now = new Date();
    const nowWithAdvance = new Date(now.getTime() + minAdvanceMinutes * 60000);
    const isSameDay = day.toDateString() === now.toDateString();
    
    if (isSameDay && !allowSameDay) {
      logger.info('Cliente não permite agendamento no mesmo dia.');
      return [];
    }

    // ✅ CORREÇÃO: Log dos períodos
    console.log(`🔄 PERÍODOS DE TRABALHO:`, workingPeriods.map(p => 
      `${Math.floor(p.start)}:${String((p.start % 1) * 60).padStart(2, '0')} - ${Math.floor(p.end)}:${String((p.end % 1) * 60).padStart(2, '0')}`
    ).join(' | '));

    try {
      // Buscar slots ocupados para todo o dia
      const timeMin = new Date(day);
      timeMin.setHours(0, 0, 0, 0);
      
      const timeMax = new Date(day);
      timeMax.setHours(23, 59, 59, 999);

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

      // ✅ CORREÇÃO: Gerar slots para cada período de trabalho
      for (const period of workingPeriods) {
        let currentSlot = new Date(day);
        currentSlot.setHours(Math.floor(period.start), Math.round((period.start % 1) * 60), 0, 0);
        
        const periodEnd = new Date(day);
        periodEnd.setHours(Math.floor(period.end), Math.round((period.end % 1) * 60), 0, 0);

        while (currentSlot.getTime() + durationInMinutes * 60000 <= periodEnd.getTime()) {
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
          
          if (currentSlot.getTime() > periodEnd.getTime()) {
            break;
          }
        }
      }

      // Ordenar slots por horário
      availableSlots.sort((a, b) => a.getTime() - b.getTime());

      console.log(`✅ HORÁRIOS ENCONTRADOS: ${availableSlots.length} slots em ${workingPeriods.length} períodos`);
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
 * Método alternativo para gerar slots manualmente - COM MÚLTIPLOS PERÍODOS
 */
async function generateSlotsManually(
  day,
  durationInMinutes,
  dayConfig = {}, // ✅ MUDANÇA: Recebe dayConfig completo
  config = {}
) {
  const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
  const now = new Date();
  const nowWithAdvance = new Date(now.getTime() + minAdvanceMinutes * 60000);
  const slotInterval = Number.isFinite(config.slotInterval) ? config.slotInterval : 30;

  // ✅ CORREÇÃO: Obter múltiplos períodos
  const workingPeriods = normalizeWorkingPeriods(dayConfig);
  const availableSlots = [];

  if (workingPeriods.length === 0) {
    console.log('❌ Nenhum período de trabalho definido');
    return [];
  }

  console.log(`🔄 GERANDO SLOTS MANUALMENTE: ${workingPeriods.length} períodos`);

  for (const period of workingPeriods) {
    const startHour = Math.floor(period.start);
    const startMinute = Math.round((period.start % 1) * 60);
    const endHour = Math.floor(period.end);
    const endMinute = Math.round((period.end % 1) * 60);

    let currentHour = startHour;
    let currentMinute = startMinute;

    while (currentHour < endHour || (currentHour === endHour && currentMinute < endMinute)) {
      const slotTime = new Date(day);
      slotTime.setHours(currentHour, currentMinute, 0, 0);
      
      const slotEnd = new Date(slotTime.getTime() + durationInMinutes * 60000);
      
      const periodEndTime = new Date(day);
      periodEndTime.setHours(endHour, endMinute, 0, 0);
      
      // Verificar se o slot cabe no período e está no futuro
      if (slotEnd <= periodEndTime && slotTime >= nowWithAdvance) {
        availableSlots.push(new Date(slotTime));
      }

      // Avançar no intervalo
      currentMinute += slotInterval;
      if (currentMinute >= 60) {
        currentHour += Math.floor(currentMinute / 60);
        currentMinute = currentMinute % 60;
      }
    }
  }

  // Ordenar slots por horário
  availableSlots.sort((a, b) => a.getTime() - b.getTime());

  console.log(`✅ SLOTS MANUAIS GERADOS: ${availableSlots.length} em ${workingPeriods.length} períodos`);
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
  generateSlotsManually,
  normalizeWorkingPeriods // ✅ Exportar para testes
};