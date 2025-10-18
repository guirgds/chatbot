const { google } = require('googleapis');
const path = require('path');
const logger = require('./logger');

// 🔥 CALENDAR ID CORRETO - USE ESTE!
const CALENDAR_ID = "d4b4b88394979da8b0dad7e1541f45b03a78282ba693101dc5f65bce999b111e@group.calendar.google.com";
const TIMEZONE = 'America/Sao_Paulo';
const SLOT_DURATION = 60;
const WORKING_HOURS = { start: 9, end: 19 };

let calendar;
let isInitialized = false;
let initializationPromise;

// Inicializar autenticação CORRIGIDA - Método que funcionou no teste
function initializeCalendar() {
    try {
        const credentials = require(path.join(__dirname, '..', 'credentials.json'));
        
        // ✅ MÉTODO CORRETO que funcionou no teste
        const auth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: [
                'https://www.googleapis.com/auth/calendar',
                'https://www.googleapis.com/auth/calendar.events'
            ]
        });

        calendar = google.calendar({ version: 'v3', auth });
        isInitialized = true;
        
        logger.info('✅ Google Calendar inicializado com método correto', {
            client_email: credentials.client_email,
            calendar_id: CALENDAR_ID
        });
        return true;
    } catch (error) {
        logger.error('❌ FALHA: Erro ao inicializar Google Calendar', { 
            error: error.message
        });
        return false;
    }
}

// Inicialização com retry
async function initializeWithRetry() {
    logger.info('🔧 Inicializando Google Calendar...');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
        logger.info(`Tentativa ${attempt} de 3...`);
        
        if (initializeCalendar()) {
            // Aguardar inicialização completa
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            try {
                const connectionOk = await testCalendarConnection();
                if (connectionOk) {
                    isInitialized = true;
                    logger.info('✅ Google Calendar inicializado com sucesso após tentativa ' + attempt);
                    return true;
                }
            } catch (error) {
                logger.warn(`Tentativa ${attempt} falhou na verificação de conexão`, { error: error.message });
            }
        }
        
        if (attempt < 3) {
            logger.warn(`Tentativa ${attempt} falhou, aguardando 3 segundos...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    logger.error('❌ Todas as 3 tentativas de inicialização falharam');
    return false;
}

// Função auxiliar para garantir inicialização
async function ensureInitialized() {
    if (isInitialized && calendar) {
        return true;
    }
    
    logger.info('Calendar não inicializado. Inicializando agora...');
    
    // Se já está inicializando, aguarde
    if (initializationPromise) {
        const result = await initializationPromise;
        return result;
    }
    
    // Se não, inicie agora
    initializationPromise = initializeWithRetry();
    const result = await initializationPromise;
    return result;
}

// Testar conexão
async function testCalendarConnection() {
    if (!await ensureInitialized()) {
        logger.error('Calendar não inicializado no teste');
        return false;
    }

    try {
        const response = await calendar.calendars.get({
            calendarId: CALENDAR_ID
        });
        
        logger.info('🎉 CONEXÃO COM GOOGLE CALENDAR - SUCESSO!', { 
            calendar: response.data.summary,
            id: CALENDAR_ID,
            timezone: response.data.timeZone
        });
        
        console.log('\n✅✅✅ CONEXÃO BEM-SUCEDIDA!');
        console.log('📅 Calendário:', response.data.summary);
        console.log('🆔 ID:', CALENDAR_ID);
        console.log('🌐 Timezone:', response.data.timeZone);
        
        return true;
    } catch (error) {
        logger.error('❌ FALHA: Conexão com Google Calendar', { 
            error: error.message,
            code: error.code,
            calendar_id: CALENDAR_ID
        });
        
        console.log('\n❌ Ainda com problemas? Verifique:');
        console.log('1. 📧 Compartilhe o calendário com:', require('../credentials.json').client_email);
        console.log('2. 🔐 Permissão: "Fazer alterações e gerenciar compartilhamento"');
        console.log('3. 🌐 Google Calendar API habilitada');
        
        throw error;
    }
}

async function listAvailableSlots(day) {
    if (!await ensureInitialized()) {
        logger.error('Calendar não inicializado em listAvailableSlots');
        throw new Error('CALENDAR_NOT_INITIALIZED');
    }

    try {
        const timeMin = new Date(day);
        timeMin.setHours(WORKING_HOURS.start, 0, 0, 0);

        const timeMax = new Date(day);
        timeMax.setHours(WORKING_HOURS.end, 0, 0, 0);

        // Garantir que estamos buscando slots no futuro
        if (timeMin < new Date()) {
            timeMin.setTime(new Date().getTime() + 30 * 60000);
        }

        logger.info('Buscando horários disponíveis', { 
            date: day.toDateString(),
            timeMin: timeMin.toLocaleString('pt-BR'),
            timeMax: timeMax.toLocaleString('pt-BR')
        });

        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: timeMin.toISOString(),
                timeMax: timeMax.toISOString(),
                timeZone: TIMEZONE,
                items: [{ id: CALENDAR_ID }]
            }
        });

        if (!response.data.calendars || !response.data.calendars[CALENDAR_ID]) {
            logger.error('Calendário não encontrado na resposta');
            return [];
        }

        const busySlots = response.data.calendars[CALENDAR_ID].busy || [];
        const allSlots = [];
        
        // Gerar todos os slots possíveis
        let currentSlot = new Date(timeMin);
        while (currentSlot < timeMax) {
            if (currentSlot > new Date()) {
                allSlots.push(new Date(currentSlot));
            }
            currentSlot.setMinutes(currentSlot.getMinutes() + SLOT_DURATION);
        }

        // Filtrar slots ocupados
        const availableSlots = allSlots.filter(slot => {
            const slotEnd = new Date(slot.getTime() + SLOT_DURATION * 60000);
            
            const isBusy = busySlots.some(busySlot => {
                const busyStart = new Date(busySlot.start);
                const busyEnd = new Date(busySlot.end);
                return (slot < busyEnd && slotEnd > busyStart);
            });
            
            return !isBusy;
        });

        logger.info('Horários disponíveis encontrados', { 
            total: availableSlots.length,
            slots: availableSlots.map(s => s.toLocaleTimeString('pt-BR', { 
                hour: '2-digit', 
                minute: '2-digit' 
            }))
        });

        return availableSlots;
    } catch (error) {
        logger.error('Erro ao listar horários disponíveis', { 
            error: error.message
        });
        throw error;
    }
}

async function isSlotAvailable(dateTimeStart) {
    if (!await ensureInitialized()) {
        logger.error('Calendar não inicializado em isSlotAvailable');
        return false;
    }

    try {
        const startTime = new Date(dateTimeStart);
        const endTime = new Date(startTime.getTime() + SLOT_DURATION * 60000);
        
        const response = await calendar.freebusy.query({
            requestBody: {
                timeMin: startTime.toISOString(),
                timeMax: endTime.toISOString(),
                timeZone: TIMEZONE,
                items: [{ id: CALENDAR_ID }]
            }
        });
        
        const busySlots = response.data.calendars[CALENDAR_ID]?.busy || [];
        return busySlots.length === 0;
    } catch (error) {
        logger.error('Erro ao verificar disponibilidade', { error: error.message });
        return false;
    }
}

async function createAppointment(dateTimeStart, service, customerName) {
    if (!await ensureInitialized()) {
        logger.error('Calendar não inicializado em createAppointment');
        throw new Error('CALENDAR_NOT_INITIALIZED');
    }

    const startTime = new Date(dateTimeStart);
    const available = await isSlotAvailable(startTime);
    
    if (!available) {
        logger.warn('Conflito de agendamento detectado', { 
            dateTimeStart: startTime.toLocaleString('pt-BR'), 
            customerName,
            service 
        });
        throw new Error('CONFLICT');
    }

    const endTime = new Date(startTime.getTime() + SLOT_DURATION * 60000);

    try {
        const event = {
            summary: `${service} - ${customerName}`,
            description: `Agendamento realizado via Chatbot WhatsApp.`,
            start: { 
                dateTime: startTime.toISOString(), 
                timeZone: TIMEZONE 
            },
            end: { 
                dateTime: endTime.toISOString(), 
                timeZone: TIMEZONE 
            },
        };

        logger.info('Criando evento no Google Calendar', {
            customerName,
            service,
            start: startTime.toLocaleString('pt-BR')
        });

        const response = await calendar.events.insert({
            calendarId: CALENDAR_ID,
            resource: event,
        });

        logger.info('✅ Agendamento criado com sucesso no Google Calendar', { 
            eventId: response.data.id, 
            customerName,
            service,
            date: startTime.toLocaleDateString('pt-BR'),
            time: startTime.toLocaleTimeString('pt-BR')
        });
        
        return response.data;
    } catch (error) {
        logger.error('❌ Erro ao criar agendamento no Google Calendar', { 
            error: error.message,
            customerName,
            service
        });
        
        if (error.code === 409) {
            throw new Error('CONFLICT');
        } else {
            throw new Error('API_ERROR');
        }
    }
}

async function listCustomerAppointments(customerName) {
    if (!await ensureInitialized()) {
        logger.error('Calendar não inicializado em listCustomerAppointments');
        return [];
    }

    try {
        const timeMin = new Date().toISOString();
        
        logger.info('Buscando agendamentos do cliente', { customerName });
        
        const response = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: timeMin,
            q: customerName,
            singleEvents: true,
            orderBy: 'startTime',
            timeZone: TIMEZONE,
            maxResults: 10
        });
        
        const appointments = response.data.items || [];
        
        logger.info('Agendamentos encontrados', { 
            customerName,
            count: appointments.length
        });
        
        return appointments;
    } catch (error) {
        logger.error('Erro ao listar agendamentos do cliente', { 
            customerName, 
            error: error.message 
        });
        return [];
    }
}

async function cancelAppointment(eventId) {
    if (!await ensureInitialized()) {
        logger.error('Calendar não inicializado em cancelAppointment');
        throw new Error('CALENDAR_NOT_INITIALIZED');
    }

    try {
        logger.info('Cancelando agendamento', { eventId });
        
        await calendar.events.delete({
            calendarId: CALENDAR_ID,
            eventId: eventId,
        });
        
        logger.info('✅ Agendamento cancelado com sucesso', { eventId });
        return true;
    } catch (error) {
        logger.error('❌ Erro ao cancelar agendamento', { 
            eventId, 
            error: error.message 
        });
        
        if (error.code === 404) {
            logger.warn('Agendamento não encontrado', { eventId });
            return true;
        }
        
        throw new Error('API_ERROR');
    }
}

// Inicialização automática quando o módulo for carregado
logger.info('🔧 Inicializando Google Calendar...');
initializationPromise = initializeWithRetry();

// Não bloquear a inicialização, mas fornecer status
initializationPromise.then(success => {
    if (success) {
        logger.info('🎉 Google Calendar pronto para uso');
    } else {
        logger.error('❌ Google Calendar não inicializado corretamente');
    }
}).catch(error => {
    logger.error('❌ Erro na inicialização do Google Calendar', { error: error.message });
});

module.exports = { 
    createAppointment, 
    listAvailableSlots, 
    isSlotAvailable, 
    listCustomerAppointments, 
    cancelAppointment,
    testCalendarConnection,
    initializeCalendar,
    ensureInitialized
};