// src/calendar.js
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const axios = require('axios');
const logger = require('./logger');

// Axios: timeout padrão para chamadas externas (feriados)
const AXIOS_TIMEOUT = 6000;

// Palavras-chave para overrides do Google Calendar (case-insensitive)
const CALENDAR_OPEN_OVERRIDE_KEYWORD = 'ABERTO';
const CALENDAR_CLOSE_OVERRIDE_KEYWORD = 'FECHADO';
// Horário padrão a assumir se um override "ABERTO" for encontrado num dia sem períodos definidos
const DEFAULT_OVERRIDE_PERIODS = [{ start: 9, end: 18 }];

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
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events.readonly'],
  });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Verifica se o dia é feriado (API externa) - ✅ CORRIGIDO!
 */
async function isHoliday(date, countryCode = 'BR') {
  try {
    const year = date.getFullYear();
    const apiUrl = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
    const response = await axios.get(apiUrl, { timeout: AXIOS_TIMEOUT });
    
    // ✅ VALIDAÇÃO EXTRA: Verificar se a resposta é um array
    if (!Array.isArray(response.data)) {
      logger.error('Resposta inválida da API de feriados', { data: response.data });
      return true; // ✅ CORREÇÃO: Segurança primeiro
    }
    
    const formatted = date.toISOString().split('T')[0];
    const isHolidayResult = response.data.some((holiday) => holiday.date === formatted);
    
    console.log(`🎯 Feriado ${formatted}: ${isHolidayResult ? 'SIM' : 'NÃO'}`);
    return isHolidayResult;
    
  } catch (err) {
    // ✅ CORREÇÃO CRÍTICA: Em caso de erro, considerar FERIADO
    logger.error('FALHA NA API DE FERIADOS - Considerando como FERIADO por segurança', { 
      error: err.message,
      date: date.toISOString()
    });
    return true; // ✅ CORREÇÃO: true em vez de false
  }
}

/**
 * Converte string "HH:MM" ou número de hora para um número decimal (ex: 9.5 para 09:30)
 */
function parseTimeString(timeStr) {
  if (typeof timeStr === 'number') return timeStr;
  if (typeof timeStr === 'string') {
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (!isNaN(hours) && !isNaN(minutes)) {
        return hours + (minutes / 60);
    }
  }
  logger.warn('Formato de hora inválido encontrado, usando padrão 9:', { timeStr });
  return 9; // padrão
}

/**
 * Normaliza os períodos de trabalho de uma configuração de dia (dayConfig).
 * Retorna uma lista de objetos { start: number, end: number } ou uma lista vazia.
 */
function normalizeWorkingPeriods(dayConfig) {
    if (!dayConfig?.available) {
        return []; // Dia explicitamente fechado
    }

    // Novo formato com 'periods'
    if (dayConfig.periods && Array.isArray(dayConfig.periods)) {
        const validPeriods = dayConfig.periods
        .map(period => ({
            start: parseTimeString(period.start),
            end: parseTimeString(period.end)
        }))
        .filter(period => period.start < period.end); // Remover inválidos

        if (validPeriods.length > 0) {
            return validPeriods;
        }
    }
    // Formato antigo (compatibilidade)
    else if (dayConfig.start && dayConfig.end) {
        const start = parseTimeString(dayConfig.start);
        const end = parseTimeString(dayConfig.end);
        if (start < end) {
            return [{ start, end }];
        }
    }

    logger.warn('Configuração de dia disponível mas sem períodos válidos.', { dayConfig });
    return []; // Disponível mas sem horários = fechado na prática
}

/**
 * Verifica se existe um evento no Google Calendar com uma keyword específica no título.
 */
async function checkCalendarEventKeyword(calendar, calendarId, dateToCheck, keyword) {
    if (!calendar || !calendarId) {
        logger.warn("checkCalendarEventKeyword chamado sem cliente Calendar ou ID.");
        return false;
    }
    try {
        const timeMin = new Date(dateToCheck); timeMin.setHours(0, 0, 0, 0);
        const timeMax = new Date(dateToCheck); timeMax.setHours(23, 59, 59, 999);

        const response = await calendar.events.list({
            calendarId: calendarId,
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
            q: keyword,
            singleEvents: true,
            maxResults: 5
        });

        if (response.data.items && response.data.items.length > 0) {
            const found = response.data.items.some(event =>
                event.summary && event.summary.trim().toUpperCase() === keyword.toUpperCase()
            );
            if (found) {
                 logger.info(`Evento "${keyword}" encontrado no Google Calendar para ${dateToCheck.toLocaleDateString('pt-BR')}`);
                 return true;
            }
        }
        return false;
    } catch (error) {
        if (error.code === 404) {
             logger.error(`Calendário não encontrado ao verificar evento "${keyword}"`, { calendarId });
        } else {
            logger.error(`Erro ao verificar evento "${keyword}" no Google Calendar para ${dateToCheck.toLocaleDateString('pt-BR')}`, { error: error.message, code: error.code });
        }
        return false;
    }
}

/**
 * Lista os próximos dias disponíveis, considerando work_schedule (com chave 'holiday') e overrides do Calendar.
 */
async function listAvailableDays(
    calendarId,
    googleCredentials,
    workSchedule = {},
    timezone = 'America/Sao_Paulo',
    daysToCheck = 14
) {
  try {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const availableDays = [];
    const startDate = new Date(); startDate.setHours(0, 0, 0, 0);
    const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const holidayDefaultConfig = workSchedule.holiday || { available: false, periods: [] };

    for (let i = 0; i < daysToCheck; i++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(startDate.getDate() + i);
      const dayOfWeek = daysOfWeek[currentDate.getDay()];
      const dayConfig = workSchedule[dayOfWeek];

      let isPotentiallyWorkingDay = false;
      let currentDayPeriods = [];
      let reason = "";

      const holiday = await isHoliday(currentDate);

      // Define o estado inicial baseado no schedule e se é feriado
      if (holiday) {
          isPotentiallyWorkingDay = holidayDefaultConfig.available;
          currentDayPeriods = normalizeWorkingPeriods(holidayDefaultConfig);
          reason = `Feriado (${currentDate.toLocaleDateString('pt-BR')}). Padrão: ${isPotentiallyWorkingDay ? 'Aberto' : 'Fechado'}.`;
      } else {
          isPotentiallyWorkingDay = dayConfig?.available || false;
          currentDayPeriods = normalizeWorkingPeriods(dayConfig);
          reason = `Dia normal (${dayOfWeek}). Schedule: ${isPotentiallyWorkingDay ? 'Aberto' : 'Fechado'}.`;
      }

      // Aplica Overrides do Google Calendar
      const openOverride = await checkCalendarEventKeyword(calendar, calendarId, currentDate, CALENDAR_OPEN_OVERRIDE_KEYWORD);
      const closeOverride = await checkCalendarEventKeyword(calendar, calendarId, currentDate, CALENDAR_CLOSE_OVERRIDE_KEYWORD);

      let finalIsWorkingDay;
      if (closeOverride) {
          finalIsWorkingDay = false;
          reason += ` Fechado por evento "${CALENDAR_CLOSE_OVERRIDE_KEYWORD}".`;
      } else if (openOverride) {
          finalIsWorkingDay = true;
          reason += ` Aberto por evento "${CALENDAR_OPEN_OVERRIDE_KEYWORD}".`;
          if (currentDayPeriods.length === 0) {
              logger.warn(`Dia ${currentDate.toLocaleDateString('pt-BR')} aberto via override mas sem períodos definidos no schedule. Usando ${DEFAULT_OVERRIDE_PERIODS[0].start}h-${DEFAULT_OVERRIDE_PERIODS[0].end}h.`);
              currentDayPeriods = DEFAULT_OVERRIDE_PERIODS; // Necessário para a próxima validação
          }
      } else {
          finalIsWorkingDay = isPotentiallyWorkingDay && currentDayPeriods.length > 0;
      }

      // Adiciona o dia se ele for considerado aberto E tiver períodos válidos (originais ou do override)
      if (finalIsWorkingDay && currentDayPeriods.length > 0) {
        const formattedDate = currentDate.toLocaleDateString('pt-BR', {
          weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
        });
        availableDays.push({
          date: currentDate.toISOString(),
          formatted: formattedDate.charAt(0).toUpperCase() + formattedDate.slice(1),
        });
        console.log(`✅ DIA DISPONÍVEL: ${formattedDate} (${dayOfWeek}) - ${reason}`);
      } else {
        // Log detalhado para o dia fechado
        if (!finalIsWorkingDay && !reason.includes('Fechado')) { // Evita duplicidade no log
             reason += isPotentiallyWorkingDay ? ' Mas sem períodos de trabalho definidos.' : '';
        } else if (finalIsWorkingDay && currentDayPeriods.length === 0) {
             // Caso raro: abriu por override mas o padrão DEFAULT_OVERRIDE_PERIODS falhou (não deveria acontecer)
             reason += ' Considerado aberto mas sem períodos válidos para agendar.';
        }
        console.log(`❌ DIA FECHADO: ${currentDate.toLocaleDateString('pt-BR')} (${dayOfWeek}) - ${reason}`);
      }
    } // Fim do loop for

    console.log(`📊 TOTAL DE DIAS DISPONÍVEIS: ${availableDays.length}`);
    return availableDays;
  } catch (error) {
    logger.error('Erro em listAvailableDays', { error: error.message });
    return [];
  }
}

/**
 * Lista horários disponíveis, considerando feriados, overrides e múltiplos períodos.
 */
async function listAvailableSlots(
  day,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo',
  workSchedule = {}, // Recebe workSchedule completo
  config = {} // Inclui minAdvanceMinutes, allowSameDay, slotInterval
) {
  try {
    if (!calendarId) throw new Error('MISSING_CALENDAR_ID');
    if (!durationInMinutes || durationInMinutes <= 0) throw new Error('INVALID_DURATION');

    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    // O slotInterval é a duração do serviço, passado por config pelo chatbot.js
    const slotInterval = config.slotInterval || durationInMinutes;

    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day.getDay()];
    const dayConfig = workSchedule[dayOfWeek];
    const holidayDefaultConfig = workSchedule.holiday || { available: false, periods: [] };

    let isPotentiallyWorkingDay = false;
    let currentDayPeriods = [];
    const holiday = await isHoliday(day);

    // --- Define estado inicial ---
    if (holiday) {
        isPotentiallyWorkingDay = holidayDefaultConfig.available;
        currentDayPeriods = normalizeWorkingPeriods(holidayDefaultConfig);
    } else {
        isPotentiallyWorkingDay = dayConfig?.available || false;
        currentDayPeriods = normalizeWorkingPeriods(dayConfig);
    }

    // --- Aplica Overrides ---
    const openOverride = await checkCalendarEventKeyword(calendar, calendarId, day, CALENDAR_OPEN_OVERRIDE_KEYWORD);
    const closeOverride = await checkCalendarEventKeyword(calendar, calendarId, day, CALENDAR_CLOSE_OVERRIDE_KEYWORD);
    let finalIsWorkingDay;

    if (closeOverride) {
        finalIsWorkingDay = false;
    } else if (openOverride) {
        finalIsWorkingDay = true;
        if (currentDayPeriods.length === 0) currentDayPeriods = DEFAULT_OVERRIDE_PERIODS;
    } else {
        finalIsWorkingDay = isPotentiallyWorkingDay && currentDayPeriods.length > 0;
    }

    if (!finalIsWorkingDay || currentDayPeriods.length === 0) {
        logger.warn(`listAvailableSlots: Dia ${day.toLocaleDateString('pt-BR')} considerado fechado.`);
        return [];
    }

    const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
    const now = new Date();
    const nowWithAdvance = new Date(now.getTime() + minAdvanceMinutes * 60000);
    const isSameDay = day.toDateString() === now.toDateString();
    const allowSameDay = config.allowSameDay ?? true;

    if (isSameDay && !allowSameDay) {
      logger.info('Cliente não permite agendamento no mesmo dia.');
      return [];
    }

    console.log(`🔄 PERÍODOS DE TRABALHO PARA ${day.toLocaleDateString('pt-BR')}:`, currentDayPeriods.map(p =>
      `${Math.floor(p.start)}:${String(Math.round((p.start % 1) * 60)).padStart(2, '0')} - ${Math.floor(p.end)}:${String(Math.round((p.end % 1) * 60)).padStart(2, '0')}`
    ).join(' | '));
    console.log(`   (Intervalo de slots: ${slotInterval} min, Duração Serviço: ${durationInMinutes} min)`);

    try {
      // Buscar slots ocupados para todo o dia
      const timeMin = new Date(day); timeMin.setHours(0, 0, 0, 0);
      const timeMax = new Date(day); timeMax.setHours(23, 59, 59, 999);

      const resp = await calendar.freebusy.query({
         requestBody: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), timeZone: timezone, items: [{ id: calendarId }] }
      });
      const busySlots = resp.data.calendars?.[calendarId]?.busy || [];
      const availableSlots = [];

      // Gerar slots para cada período de trabalho
      for (const period of currentDayPeriods) {
        let currentSlot = new Date(day);
        currentSlot.setHours(Math.floor(period.start), Math.round((period.start % 1) * 60), 0, 0);
        const periodEnd = new Date(day);
        periodEnd.setHours(Math.floor(period.end), Math.round((period.end % 1) * 60), 0, 0);

        while (currentSlot.getTime() + durationInMinutes * 60000 <= periodEnd.getTime()) {
          const slotEnd = new Date(currentSlot.getTime() + durationInMinutes * 60000);
          const isBusy = busySlots.some((busy) => {
            const busyStart = new Date(busy.start); const busyEnd = new Date(busy.end);
            return currentSlot < busyEnd && slotEnd > busyStart;
          });
          const isInFuture = currentSlot >= nowWithAdvance;

          if (!isBusy && isInFuture) {
            availableSlots.push(new Date(currentSlot));
          }

          currentSlot.setMinutes(currentSlot.getMinutes() + slotInterval);
          if (slotInterval <= 0) { logger.error("slotInterval inválido (<=0)"); break; }
          if (currentSlot.getTime() >= periodEnd.getTime()) break;
        } // Fim while
      } // Fim for periods

      availableSlots.sort((a, b) => a.getTime() - b.getTime());
      console.log(`✅ HORÁRIOS ENCONTRADOS: ${availableSlots.length} slots`);
      return availableSlots;

    } catch (error) {
        if (error.code === 404) {
             logger.error('Calendário não encontrado ao buscar free/busy slots.', { calendarId });
        } else if (error.message.includes('time range is empty')) {
             logger.warn('Range de tempo vazio no Google Calendar (free/busy).');
        } else {
             logger.error('Erro ao buscar free/busy slots', { error: error.message, code: error.code });
        }
       return []; // Retorna vazio em caso de erro ao buscar ocupados
    }

  } catch (error) {
     logger.error('Erro geral em listAvailableSlots', { error: error.message, date: day.toISOString() });
     return []; // Retorno padrão em caso de erro
  }
}


/**
 * Método alternativo para gerar slots manualmente, considerando feriados e overrides.
 */
async function generateSlotsManually(
  day,
  durationInMinutes,
  workSchedule = {}, // Recebe workSchedule completo
  config = {} // Inclui minAdvance, allowSameDay, slotInterval, googleCredentials, calendarId
) {
    const calendar = config.googleCredentials ? getAuthenticatedCalendarClient(config.googleCredentials) : null;
    const calendarId = config.calendarId;
    const slotInterval = config.slotInterval || durationInMinutes;

    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day.getDay()];
    const dayConfig = workSchedule[dayOfWeek];
    const holidayDefaultConfig = workSchedule.holiday || { available: false, periods: [] };

    let isPotentiallyWorkingDay = false;
    let currentDayPeriods = [];
    const holiday = await isHoliday(day);

    // --- LÓGICA DE DECISÃO ---
    if (holiday) {
        isPotentiallyWorkingDay = holidayDefaultConfig.available;
        currentDayPeriods = normalizeWorkingPeriods(holidayDefaultConfig);
    } else {
        isPotentiallyWorkingDay = dayConfig?.available || false;
        currentDayPeriods = normalizeWorkingPeriods(dayConfig);
    }

    let finalIsWorkingDay = isPotentiallyWorkingDay;
    let openOverride = false;
    let closeOverride = false;
    if (calendar && calendarId) {
        openOverride = await checkCalendarEventKeyword(calendar, calendarId, day, CALENDAR_OPEN_OVERRIDE_KEYWORD);
        closeOverride = await checkCalendarEventKeyword(calendar, calendarId, day, CALENDAR_CLOSE_OVERRIDE_KEYWORD);
    }

    if (closeOverride) finalIsWorkingDay = false;
    else if (openOverride) {
        finalIsWorkingDay = true;
        if (currentDayPeriods.length === 0) currentDayPeriods = DEFAULT_OVERRIDE_PERIODS;
    } else {
        finalIsWorkingDay = isPotentiallyWorkingDay && currentDayPeriods.length > 0;
    }
    // --- FIM DA LÓGICA DE DECISÃO ---

    if (!finalIsWorkingDay || currentDayPeriods.length === 0) {
        logger.warn(`generateSlotsManually: Dia ${day.toLocaleDateString('pt-BR')} considerado fechado.`);
        return [];
    }

    const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;
    const now = new Date();
    const nowWithAdvance = new Date(now.getTime() + minAdvanceMinutes * 60000);
    const availableSlots = [];

    console.log(`🔄 GERANDO SLOTS MANUALMENTE: ${currentDayPeriods.length} períodos (intervalo: ${slotInterval}min)`);

    for (const period of currentDayPeriods) {
       let currentSlotTime = new Date(day);
       currentSlotTime.setHours(Math.floor(period.start), Math.round((period.start % 1) * 60), 0, 0);
       const periodEndTime = new Date(day);
       periodEndTime.setHours(Math.floor(period.end), Math.round((period.end % 1) * 60), 0, 0);

       while (currentSlotTime.getTime() + durationInMinutes * 60000 <= periodEndTime.getTime()) {
         if (currentSlotTime >= nowWithAdvance) {
           availableSlots.push(new Date(currentSlotTime));
         }
         currentSlotTime.setMinutes(currentSlotTime.getMinutes() + slotInterval);
         if (slotInterval <= 0) { logger.error("slotInterval inválido (<= 0)"); break; }
         if (currentSlotTime.getTime() >= periodEndTime.getTime()) break;
       }
     } // Fim for periods

    availableSlots.sort((a, b) => a.getTime() - b.getTime());
    console.log(`✅ SLOTS MANUAIS GERADOS: ${availableSlots.length}`);
    return availableSlots;
}

/**
 * Verifica se um horário específico está livre no Google Calendar.
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
    // Retorna true se a lista de ocupados estiver vazia para o intervalo
    return busy.length === 0;
  } catch (error) {
    logger.error('Erro ao verificar disponibilidade do slot', { error: error.message });
    return false; // Assume indisponível em caso de erro
  }
}

/**
 * Cria o agendamento no Google Calendar após validações.
 */
async function createAppointment(
  dateTimeStart,
  service,
  customerName,
  durationInMinutes,
  calendarId,
  googleCredentials,
  timezone = 'America/Sao_Paulo',
  workSchedule = {}, // Recebe workSchedule completo
  config = {} // Inclui minAdvanceMinutes
) {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const start = new Date(dateTimeStart);
    const end = new Date(start.getTime() + durationInMinutes * 60000);
    const now = new Date();
    const minAdvanceMinutes = Number.isFinite(config.minAdvanceMinutes) ? config.minAdvanceMinutes : 120;

    // 1. Validação Antecedência Mínima
    if (start.getTime() - now.getTime() < minAdvanceMinutes * 60000) {
        throw new Error('MIN_ADVANCE_NOT_MET');
    }

    // 2. Validação Dia Fechado (Feriado/Schedule + Overrides)
    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][start.getDay()];
    const dayConfig = workSchedule[dayOfWeek];
    const holidayDefaultConfig = workSchedule.holiday || { available: false, periods: [] };
    let isPotentiallyWorkingDay = false;
    let currentDayPeriods = [];
    const holiday = await isHoliday(start);

    if (holiday) {
        isPotentiallyWorkingDay = holidayDefaultConfig.available;
        currentDayPeriods = normalizeWorkingPeriods(holidayDefaultConfig);
    } else {
        isPotentiallyWorkingDay = dayConfig?.available || false;
        currentDayPeriods = normalizeWorkingPeriods(dayConfig);
    }

    const openOverride = await checkCalendarEventKeyword(calendar, calendarId, start, CALENDAR_OPEN_OVERRIDE_KEYWORD);
    const closeOverride = await checkCalendarEventKeyword(calendar, calendarId, start, CALENDAR_CLOSE_OVERRIDE_KEYWORD);
    let finalIsWorkingDay;

    if (closeOverride) finalIsWorkingDay = false;
    else if (openOverride) {
         finalIsWorkingDay = true;
         if (currentDayPeriods.length === 0) currentDayPeriods = DEFAULT_OVERRIDE_PERIODS;
    }
    else finalIsWorkingDay = isPotentiallyWorkingDay && currentDayPeriods.length > 0;

    if (!finalIsWorkingDay) {
         logger.warn(`Tentativa de agendar em dia fechado ${start.toLocaleDateString('pt-BR')}`);
         throw new Error(holiday ? 'HOLIDAY_CLOSED' : 'DAY_CLOSED');
    }
    if (currentDayPeriods.length === 0) { // Segurança extra
         logger.error(`Dia ${start.toLocaleDateString('pt-BR')} considerado aberto mas sem períodos para validação!`);
         throw new Error('DAY_CLOSED_NO_PERIODS');
    }

    // 3. Validação: Horário está dentro de um período de trabalho?
    const startHourDecimal = start.getHours() + start.getMinutes() / 60;
    const endHourDecimal = end.getHours() + end.getMinutes() / 60;
    const endHourCheck = end.getMinutes() === 0 ? endHourDecimal : endHourDecimal; // Ajuste para fim exato (ex: 18:00)

    const isInWorkingPeriod = currentDayPeriods.some(period =>
        startHourDecimal >= period.start && endHourCheck <= period.end
    );
    if (!isInWorkingPeriod) {
         logger.warn(`Tentativa de agendar fora do horário ${start.toLocaleTimeString('pt-BR')}-${end.toLocaleTimeString('pt-BR')}`);
         throw new Error('OUTSIDE_WORKING_HOURS');
    }

    // 4. Validação final de disponibilidade (conflito)
    let available = false;
    try {
        available = await isSlotAvailable(start, durationInMinutes, calendarId, googleCredentials, timezone);
    } catch (e) {
        logger.error('Falha ao checar disponibilidade antes de criar evento', { error: e.message });
        throw new Error('GOOGLE_AVAILABILITY_CHECK_FAILED');
    }
    if (!available) {
        logger.warn('Tentativa de agendar horário já ocupado (conflito detectado)', { calendarId, service, customerName, start: start.toISOString() });
        throw new Error('CONFLICT');
    }

    // Criação do evento
    const event = {
        summary: `${service} - ${customerName}`,
        description: `Agendamento via Chatbot WhatsApp.`,
        start: { dateTime: start.toISOString(), timeZone: timezone },
        end: { dateTime: end.toISOString(), timeZone: timezone },
    };

    try {
        const response = await calendar.events.insert({ calendarId, resource: event });
        logger.info('✅ Agendamento criado com sucesso', { calendarId, service, customerName, start: start.toISOString() });
        return response.data;
    } catch (error) {
         logger.error('Erro ao inserir evento no Google Calendar', { error: error.message, code: error.code });
         // Tentar fornecer uma mensagem de erro mais específica
         if (error.code === 409) { // Conflict
             throw new Error('CONFLICT'); // Slot foi ocupado entre a verificação e a criação
         } else if (error.code === 404) { // Not Found
             throw new Error('CALENDAR_NOT_FOUND');
         } else if (error.code === 403) { // Forbidden
             throw new Error('GOOGLE_PERMISSION_ERROR');
         }
         throw new Error('GOOGLE_INSERT_FAILED'); // Erro genérico
    }
}


/**
 * Lista agendamentos futuros de um cliente.
 */
async function listCustomerAppointments(customerName, calendarId, googleCredentials, timezone = 'America/Sao_Paulo') {
  try {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    const resp = await calendar.events.list({
      calendarId,
      timeMin: new Date().toISOString(), // A partir de agora
      q: customerName, // Busca eventos que contenham o nome do cliente
      singleEvents: true, // Expande eventos recorrentes
      orderBy: 'startTime', // Ordena pelo início
      timeZone: timezone,
    });
    // Retorna a lista de itens (eventos) ou uma lista vazia se não houver
    return resp.data.items || [];
  } catch (error) {
    logger.error('Erro ao listar agendamentos do cliente', { customerName, calendarId, error: error.message, code: error.code });
    return []; // Retorna vazio em caso de erro
  }
}

/**
 * Cancela um agendamento específico pelo seu eventId.
 */
async function cancelAppointment(eventId, calendarId, googleCredentials) {
  try {
    const calendar = getAuthenticatedCalendarClient(googleCredentials);
    // Tenta deletar o evento
    await calendar.events.delete({ calendarId, eventId });
    logger.info('✅ Agendamento cancelado com sucesso no Google Calendar', { calendarId, eventId });
    return true; // Sucesso
  } catch (error) {
    logger.error('Erro ao cancelar agendamento no Google Calendar', { calendarId, eventId, error: error.message, code: error.code });
    // Tratar erro 410 (Gone) como sucesso, pois o evento já não existe
    if (error.code === 410) {
        logger.warn('Tentativa de cancelar agendamento que já não existe (410 Gone)', { eventId });
        return true; // Considera como sucesso, pois o resultado é o mesmo
    }
    // Relançar outros erros para serem tratados por quem chamou
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
  normalizeWorkingPeriods,
  checkCalendarEventKeyword
};