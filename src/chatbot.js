const axios = require('axios'); // Para enviar mensagens
const { getResponses, generateNumberedList } = require('./responses'); // Funções refatoradas
const { processMessage } = require('./messageProcessor'); // Função refatorada
const calendarApi = require('./calendar'); // Módulo refatorado do calendário
const { parseDate } = require('chrono-node');
const db = require('./database'); // Módulo refatorado do banco de dados
const logger = require('./logger');

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || 'v20.0'; // Usar variável de ambiente ou default
const AXIOS_TIMEOUT = 10000; // 10 segundos de timeout para chamadas à API da Meta

/**
 * Envia uma mensagem usando a API Cloud do WhatsApp.
 * @param {string} businessPhoneId - O ID do número de telefone do negócio que está a enviar.
 * @param {string} accessToken - O Token de Acesso da Meta para este negócio.
 * @param {object} messageData - O objeto JSON completo da mensagem a ser enviada (inclui 'to', 'type', etc.).
 * @returns {Promise<object>} A resposta da API da Meta.
 * @throws {Error} Se a API da Meta retornar um erro.
 */
async function sendWhatsAppMessage(businessPhoneId, accessToken, messageData) {
    if (!accessToken) {
        logger.error('Tentativa de enviar mensagem sem Access Token', { businessPhoneId, to: messageData.to });
        throw new Error('MISSING_ACCESS_TOKEN');
    }
    if (!businessPhoneId) {
        logger.error('Tentativa de enviar mensagem sem businessPhoneId', { to: messageData.to });
        throw new Error('MISSING_BUSINESS_PHONE_ID');
    }

    // Garante que o 'messaging_product' está definido como 'whatsapp'
    messageData.messaging_product = "whatsapp";
    // Limpa o número do destinatário (remove não-dígitos) se necessário
    if (messageData.to) {
        messageData.to = String(messageData.to).replace(/\D/g, '');
    }


    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${businessPhoneId}/messages`;

    try {
        logger.info(`Enviando mensagem para ${messageData.to} [via ${businessPhoneId}]`, { type: messageData.type });
        // logger.debug('Payload de envio para Meta API:', { payload: messageData }); // Útil para depuração

        const response = await axios.post(url, messageData, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            timeout: AXIOS_TIMEOUT // Adiciona timeout
        });

        logger.info(`Mensagem enviada com sucesso para ${messageData.to}`, { responseData: response.data });
        return response.data; // Retorna a resposta da Meta (pode conter IDs de mensagem)

    } catch (error) {
        // Tenta extrair detalhes do erro da resposta da API
        const errorResponse = error.response;
        const errorData = errorResponse?.data?.error;
        const statusCode = errorResponse?.status;

        logger.error('Erro ao enviar mensagem pela API da Meta', {
            to: messageData.to,
            businessPhoneId: businessPhoneId,
            status: statusCode,
            code: errorData?.code, // Código de erro específico da Meta
            message: errorData?.message, // Mensagem de erro da Meta
            type: errorData?.type,
            fbtrace_id: errorData?.fbtrace_id, // ID para suporte da Meta
            axios_error_code: error.code // Código de erro do Axios (ex: ECONNREFUSED, ETIMEDOUT)
            // error_stack: error.stack // Opcional: incluir stack trace completo
        });

        // Relançar um erro mais descritivo para a lógica do chatbot tratar
        let errorMessage = `META_API_SEND_FAILED: ${errorData?.message || error.message}`;
        if (statusCode === 400 && errorData?.code === 131048) { // Exemplo: Número fora do período de 24h para msg normal
             errorMessage = 'META_API_SEND_FAILED: Fora da janela de 24h. Use um Template.';
        } else if (statusCode === 401 || statusCode === 403) { // Erros de autenticação/permissão
            errorMessage = `META_API_AUTH_ERROR: Token inválido ou permissões insuficientes. Status ${statusCode}`;
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
            errorMessage = `META_API_TIMEOUT: Timeout ao enviar mensagem.`;
        }
        // Adicionar mais tratamentos específicos conforme necessário

        throw new Error(errorMessage);
    }
}


// Objeto que define o que fazer em cada estado
const stateHandlers = {
    
    // NOVO ESTADO: Escolha do Profissional (para fluxo Clínica)
    async AWAITING_PROFESSIONAL_CHOICE(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const professionals = state.professionals || []; // Lista de profissionais disponíveis
        
        const choiceIndex = parseInt(messageBody.trim(), 10) - 1;
        
        // Validação da escolha
        if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= professionals.length) {
            
            // Reenvia a instrução clara e a lista de profissionais
            const errorMessage = `❌ Opção inválida. Por favor, envie o NÚMERO do profissional desejado.` + "\n\n";
            const professionalListString = generateNumberedList(professionals, 'professional');

            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, 
                type: 'text', 
                text: { body: errorMessage + responses.askForProfessional(professionalListString, state.categoryName) }
            });
            return state; // Mantém o estado
        }
        
        const chosenProfessional = professionals[choiceIndex];
        
        // Transiciona para AWAITING_DAY com os dados do profissional
        state.step = 'AWAITING_DAY';
        state.service = chosenProfessional.name; // Nome do profissional como "serviço" agendado
        state.duration = chosenProfessional.duration || 60;
        state.calendarId = chosenProfessional.calendarId; // CALENDAR ID DO PROFISSIONAL
        
        await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
            to: customerId, type: 'text', text: { body: responses.askForDay(state.service) }
        });
        return state;
    },
    
    // Este estado agora só é atingido via fluxo secundário ou se você usar o 'askForService'
    async AWAITING_SERVICE_CHOICE(messagePayloadSimplified, state, clientInfo, responses) {
        // Lógica para quando um serviço é escolhido dentro de um fluxo não-menu principal
        let chosenService = null;
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const services = clientInfo.config?.services || []; 

        const choiceIndex = parseInt(messageBody.trim(), 10) - 1;

        if (isNaN(choiceIndex) || choiceIndex < 0 || choiceIndex >= services.length) {
            const errorMessage = "❌ Opção inválida. Por favor, envie apenas o NÚMERO do serviço desejado." + "\n\n";

            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, 
                type: 'text', 
                text: { body: errorMessage + responses.askForService() } 
            });
            return state;
        }

        chosenService = services[choiceIndex]; 

        if (chosenService) {
            state.step = 'AWAITING_DAY';
            state.service = chosenService.name;
            state.duration = chosenService.duration || 60;
            // Usa o Calendar ID do cliente, pois este é o fluxo simples
            state.calendarId = clientInfo.google_calendar_id; 
            
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: responses.askForDay(state.service) }
            });
            return state;
        } else {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: "Opção inválida.\n" + responses.askForService() }
            });
            return state;
        }
    },

    async AWAITING_DAY(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';
        const businessHours = clientInfo.config?.business_hours || {}; 
        
        // Usa o Calendar ID do STATE (vindo do profissional ou do serviço) ou o ID padrão do cliente
        const calendarIdToUse = state.calendarId || clientInfo.google_calendar_id;

        const day = parseDate(messageBody.trim(), new Date(), { forwardDate: true });
        
        if (day) {
            const dayOfWeek = day.getDay();
            const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
            const dayKey = dayNames[dayOfWeek];
            
            const hoursConfig = businessHours[dayKey];
            
            if (!hoursConfig || !hoursConfig.open || !hoursConfig.close) {
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: `❌ Desculpe, estamos fechados no(a) ${dayKey}. Por favor, escolha outro dia.` }
                 });
                 return state;
            }
            
            const [startHour] = hoursConfig.open.split(':').map(Number);
            const [endHour] = hoursConfig.close.split(':').map(Number);
            
            const workingHours = { start: startHour, end: endHour };

            if (!calendarIdToUse || !clientInfo.google_credentials) {
                logger.error(`Cliente ${clientInfo.id} não tem Google Calendar ID ou credenciais.`, { clientId: clientInfo.id });
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
                });
                return null;
            }
            try {
                const availableSlots = await calendarApi.listAvailableSlots(
                    day,
                    state.duration,
                    calendarIdToUse, // Usa o ID do state/profissional
                    clientInfo.google_credentials,
                    timezone,
                    workingHours
                );

                const responseMessage = responses.showAvailableSlots(availableSlots);

                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responseMessage }
                });

                if (availableSlots.length > 0) {
                    state.step = 'AWAITING_SLOT';
                    state.availableSlots = availableSlots.map(slot => slot.toISOString());
                }

            } catch (calendarError) {
                logger.error('Erro ao buscar horários no Google Calendar', { clientId: clientInfo.id, error: calendarError.message });
                let userErrorMessage = "❌ Desculpe, tive um problema ao consultar a agenda. Tente novamente mais tarde.";
                if (calendarError.message === 'CALENDAR_NOT_FOUND' || calendarError.message === 'GOOGLE_PERMISSION_ERROR') {
                    userErrorMessage = "❌ Problema na configuração da agenda deste estabelecimento. Contacte o suporte.";
                }
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: userErrorMessage }
                });
                return null; 
            }
        } else {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: "Não consegui entender essa data. Tente de novo (ex: 'hoje', 'sábado', '25/12')." }
            });
        }
        return state;
    },

    async AWAITING_SLOT(messagePayloadSimplified, state, clientInfo, responses) {
        // Lógica idêntica ao original, mas usa state.calendarId
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const availableSlots = state.availableSlots?.map(iso => new Date(iso)) || [];
        const choice = parseInt(messageBody.trim(), 10) - 1;

        if (choice >= 0 && choice < availableSlots.length) {
            const chosenSlot = availableSlots[choice];
            state.step = 'AWAITING_FINAL_CONFIRMATION';
            state.chosenSlot = chosenSlot.toISOString();
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: responses.appointmentSummary(state.service, chosenSlot) }
            });
        } else {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "❌ Opção inválida.\n" + responses.showAvailableSlots(availableSlots) }
             });
            return state;
        }
        return state;
    },

    async AWAITING_FINAL_CONFIRMATION(messagePayloadSimplified, state, clientInfo, responses) {
        // Lógica idêntica ao original, mas usa state.calendarId
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const customerName = messagePayloadSimplified.profile.name || "Cliente";
        const chosenSlot = new Date(state.chosenSlot);
        const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';
        
        const calendarIdToUse = state.calendarId || clientInfo.google_calendar_id;

        if (messageBody.trim() === '1') {
            if (!calendarIdToUse || !clientInfo.google_credentials) {
                 logger.error(`Cliente ${clientInfo.id} não tem Google Calendar ID ou credenciais ao confirmar.`, { clientId: clientInfo.id });
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
                 });
                 return null;
            }
            try {
                await calendarApi.createAppointment(
                    chosenSlot.toISOString(),
                    state.service,
                    customerName,
                    state.duration,
                    calendarIdToUse, // Usa o ID do state/profissional
                    clientInfo.google_credentials,
                    timezone
                );
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.appointmentConfirmed(state.service, chosenSlot) }
                });

                try {
                    await db.saveCustomerVisit(clientInfo.id, customerId, customerName, chosenSlot.toISOString());
                } catch (dbError) {
                    logger.warn('Erro ao salvar no banco de dados, mas agendamento foi criado', { clientId: clientInfo.id, customerId, error: dbError.message });
                }

            } catch (error) {
                logger.error('Erro ao criar agendamento no Google Calendar', { clientId: clientInfo.id, customerId, error: error.message });
                let errorMessage = "❌ Desculpe, estou com um problema para me conectar à agenda. Tente novamente mais tarde.";
                if (error.message === 'CONFLICT') {
                    errorMessage = "❌ Ops! Alguém acabou de agendar neste horário. Por favor, digite 'menu' para recomeçar.";
                } else if (error.message === 'CALENDAR_NOT_FOUND' || error.message === 'GOOGLE_PERMISSION_ERROR') {
                    errorMessage = "❌ Problema na configuração da agenda deste estabelecimento. Contacte o suporte.";
                }
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: errorMessage }
                 });
                 return state;
            }
        } else {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "Ok, agendamento cancelado. Digite 'menu' para recomeçar." }
             });
        }
        return null;
    },

     // --- ESTADOS DE CANCELAMENTO E ALTERAÇÃO ---
     async AWAITING_CANCELLATION_CONFIRMATION(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const appointmentToCancel = state.appointmentToCancel;

        const calendarIdToUse = state.calendarId || clientInfo.google_calendar_id;

        if (!appointmentToCancel || !appointmentToCancel.id) {
             logger.warn('Estado inválido em AWAITING_CANCELLATION_CONFIRMATION', { clientId: clientInfo.id, customerId });
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "Ocorreu um erro, por favor digite 'menu'." }
             });
             return null;
        }
         if (!calendarIdToUse || !clientInfo.google_credentials) {
              logger.error(`Cliente ${clientInfo.id} sem Google Calendar ID ou credenciais para cancelamento.`, { clientId: clientInfo.id });
              await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                  to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
              });
              return null;
         }

         if (messageBody.trim() === '1') {
             try {
                 await calendarApi.cancelAppointment(appointmentToCancel.id, calendarIdToUse, clientInfo.google_credentials);
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responses.appointmentCancelled }
                 });
             } catch (error) {
                 logger.error('Erro ao cancelar agendamento no Google Calendar', { clientId: clientInfo.id, customerId, eventId: appointmentToCancel.id, error: error.message });
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Ops! Ocorreu um erro e não consegui cancelar seu agendamento. Tente novamente mais tarde." }
                 });
                  return state;
             }
         } else {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "Ok, seu agendamento está mantido! 😉" }
             });
         }
         return null;
     },

     async AWAITING_CHANGE_CHOICE(messagePayloadSimplified, state, clientInfo, responses) {
         const customerId = messagePayloadSimplified.from;
         const messageBody = messagePayloadSimplified.text.body;
         const appointments = state.appointments || [];
         const choice = parseInt(messageBody.trim(), 10) - 1;
         
         const calendarIdToUse = state.calendarId || clientInfo.google_calendar_id;

         if (!calendarIdToUse || !clientInfo.google_credentials) {
              logger.error(`Cliente ${clientInfo.id} sem Google Calendar ID ou credenciais para alteração.`, { clientId: clientInfo.id });
              await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                  to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
              });
              return null;
         }

         if (choice >= 0 && choice < appointments.length) {
             const appointmentToChange = appointments[choice];
             const serviceName = appointmentToChange.summary?.split(' - ')[0] || 'Serviço';
             // [MODIFICADO] Lógica para achar duração deve procurar em 'categories' ou 'services'
             let serviceConfig;
             const categoryOrServiceList = clientInfo.config?.categories || clientInfo.config?.services;
             if(categoryOrServiceList) {
                 // Simplificação: tenta encontrar o serviço pelo nome
                 serviceConfig = categoryOrServiceList.find(c => c.name === serviceName) || 
                                 categoryOrServiceList.flatMap(c => c.professionals || c.services || []).find(p => p.name === serviceName);
             }
             const duration = serviceConfig?.duration || 60; // Fallback para 60 min

             try {
                 await calendarApi.cancelAppointment(appointmentToChange.id, calendarIdToUse, clientInfo.google_credentials);
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responses.appointmentChanged }
                 });

                 const newState = {
                     step: 'AWAITING_DAY',
                     service: serviceName,
                     duration: duration,
                     calendarId: calendarIdToUse // Preserva o Calendar ID
                 };
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.askForDay(newState.service) }
                 });
                 return newState;

             } catch (error) {
                 logger.error('Erro ao iniciar alteração de agendamento (cancelamento falhou)', { clientId: clientInfo.id, customerId, eventId: appointmentToChange.id, error: error.message });
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Ops! Ocorreu um erro ao tentar alterar seu agendamento. Tente novamente mais tarde." }
                 });
                 return null;
             }
         } else {
              // Reenvia lista se inválido
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "❌ Opção inválida.\n" + responses.listAppointmentsToChange(appointments.map(a => ({...a, start: { dateTime: a.start?.dateTime || a.start?.date }}))) }
             });
             return state;
         }
     }
};

/**
 * Função principal chamada pelo webhook para processar mensagens recebidas.
 * @param {object} messagePayload - O payload completo recebido da Meta.
 */
async function handleIncomingMessage(messagePayload) {
    let customerId = null;
    let clientId = null;
    let clientInfo = null;
    let responses = null;
    let currentState = null;

    try {
        // Extração e validações (mantidas do original)
        const messageObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const contactObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
        const metadataObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.metadata;

        if (messagePayload?.object !== 'whatsapp_business_account' ||
            !messageObject || messageObject.type !== 'text' ||
            !messageObject.from || !messageObject.text?.body ||
            !metadataObject?.phone_number_id)
        {
            logger.debug('Payload ignorado (não é mensagem de texto ou faltam dados essenciais)', { payload: messagePayload });
            return;
        }

        customerId = messageObject.from;
        const messageBody = messageObject.text.body.trim();
        const customerName = contactObject?.profile?.name || "Cliente";
        const businessPhoneId = metadataObject.phone_number_id;

        clientInfo = await db.getClientByPhoneId(businessPhoneId);
        if (!clientInfo || !clientInfo.whatsapp_token) {
            logger.error(`Mensagem recebida para número de negócio não registrado ou sem token no BD: ${businessPhoneId}`);
            return;
        }
        clientId = clientInfo.id;
        responses = getResponses(clientInfo);

        logger.info(`Mensagem recebida de ${customerName} (${customerId}) para ${clientInfo.business_name} (ID: ${clientId}): "${messageBody}"`);

        currentState = await db.getConversationState(customerId, clientId);

        let nextState = null;
        let responseText = null;

        const payloadSimplified = { from: customerId, text: { body: messageBody }, profile: { name: customerName } };
        const messageBodyUpper = messageBody.toUpperCase();
        
        // --- NOVO ROTEAMENTO DE INÍCIO DE CONVERSA (Fluxo Unificado) ---
        
        // 1. Se existe um estado ativo, delega para o handler do estado
        if (currentState?.step && stateHandlers[currentState.step]) {
            nextState = await stateHandlers[currentState.step](payloadSimplified, currentState, clientInfo, responses);
        }
        // 2. Se NÃO há estado ativo, processa o menu principal e keywords
        else {
             // 2.A Verifica keywords específicas do cliente
             responseText = processMessage(messageBody, clientInfo.config);
             if (responseText) {
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responseText }
                 });
                 nextState = null;

             // 2.B Verifica Saudação, Opção de Serviço (Numérica), ou Opção A/C
             } else if (messageBody.match(/(oi|olá|menu|bom dia|boa tarde|boa noite)/i) ||
                        messageBodyUpper === 'A' || 
                        messageBodyUpper === 'C' ||
                        (parseInt(messageBody, 10) >= 1 && parseInt(messageBody, 10) <= (clientInfo.config?.categories || clientInfo.config?.services || []).length) 
                       ) {

                 const servicesOrCategories = clientInfo.config?.categories || clientInfo.config?.services || [];

                 // Processa SAUDAÇÃO (envia o NOVO menu)
                 if (messageBody.match(/(oi|olá|menu|bom dia|boa tarde|boa noite)/i)) {
                     await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                         to: customerId, type: 'text', text: { body: responses.welcome(customerName) } 
                     });
                     nextState = null; 

                 // Processa OPÇÕES A e C (Alterar/Cancelar)
                 } else if (messageBodyUpper === 'A' || messageBodyUpper === 'C') {
                      switch (messageBodyUpper) { 
                         case 'A': // Alterar agendamento
                             try {
                                 if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) throw new Error('GOOGLE_CONFIG_MISSING');
                                 const appointments = await calendarApi.listCustomerAppointments(customerName, clientInfo.google_calendar_id, clientInfo.google_credentials);
                                 if (appointments && appointments.length > 0) {
                                     const serializableAppointments = appointments.map(a => ({ id: a.id, summary: a.summary, start: a.start, end: a.end }));
                                     nextState = { step: 'AWAITING_CHANGE_CHOICE', appointments: serializableAppointments, calendarId: clientInfo.google_calendar_id };
                                     await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                         to: customerId, type: 'text', text: { body: responses.listAppointmentsToChange(appointments) }
                                     });
                                 } else {
                                     await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, { to: customerId, type: 'text', text: { body: responses.appointmentNotFound } });
                                     nextState = null;
                                 }
                             } catch (error) {
                                 logger.error('Erro ao listar agendamentos para alterar', { clientId: clientInfo.id, customerId, error: error.message });
                                 let userErrorMsg = (error.message === 'GOOGLE_CONFIG_MISSING') ? "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." : "❌ Erro ao buscar seus agendamentos. Tente novamente mais tarde.";
                                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, { to: customerId, type: 'text', text: { body: userErrorMsg } });
                                 nextState = null;
                             }
                             break;
                         case 'C': // Cancelar agendamento
                             try {
                                 if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) throw new Error('GOOGLE_CONFIG_MISSING');
                                 const appointmentsToCancel = await calendarApi.listCustomerAppointments(customerName, clientInfo.google_calendar_id, clientInfo.google_credentials);
                                 if (appointmentsToCancel && appointmentsToCancel.length > 0) {
                                     const nextAppointment = appointmentsToCancel[0];
                                     const serializableAppointment = { id: nextAppointment.id, summary: nextAppointment.summary, start: nextAppointment.start, end: nextAppointment.end };
                                     nextState = { step: 'AWAITING_CANCELLATION_CONFIRMATION', appointmentToCancel: serializableAppointment, calendarId: clientInfo.google_calendar_id };
                                     const dateStr = new Date(nextAppointment.start?.dateTime || nextAppointment.start?.date || Date.now()).toLocaleString('pt-BR');
                                     await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, { to: customerId, type: 'text', text: { body: responses.confirmCancellation(nextAppointment.summary, dateStr) } });
                                 } else {
                                     await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, { to: customerId, type: 'text', text: { body: responses.appointmentNotFound } });
                                     nextState = null;
                                 }
                             } catch (error) {
                                 logger.error('Erro ao buscar agendamentos para cancelar', { clientId: clientInfo.id, customerId, error: error.message });
                                 let userErrorMsg = (error.message === 'GOOGLE_CONFIG_MISSING') ? "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." : "❌ Erro ao buscar seus agendamentos. Tente novamente mais tarde.";
                                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, { to: customerId, type: 'text', text: { body: userErrorMsg } });
                                 nextState = null;
                             }
                             break;
                         default:
                             // Deve ser um número inválido ou entrada que não faz sentido
                             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                 to: customerId, type: 'text', text: { body: responses.default }
                             });
                             nextState = null;
                             break;
                     }

                 // Processa ESCOLHA DO SERVIÇO/CATEGORIA (Numérico)
                 } else if (servicesOrCategories.length > 0) {
                     const serviceIndex = parseInt(messageBody, 10) - 1;
                     const chosenItem = servicesOrCategories[serviceIndex];
                     
                     // Checagem: Se há profissionais aninhados (FLUXO CLÍNICA)
                     if (chosenItem.professionals && chosenItem.professionals.length > 0) {
                          // Transiciona para AWAITING_PROFESSIONAL_CHOICE
                          nextState = { 
                             step: 'AWAITING_PROFESSIONAL_CHOICE', 
                             categoryName: chosenItem.name,
                             professionals: chosenItem.professionals
                          };
                          // Assumimos que generateNumberedList está disponível
                          await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                              to: customerId, 
                              type: 'text', 
                              text: { body: responses.askForProfessional(generateNumberedList(chosenItem.professionals, 'professional'), chosenItem.name) } 
                          });
                     } else {
                         // FLUXO BARBEARIA (SIMPLES): Vai direto para o dia, usando o Calendar ID do cliente
                         nextState = { 
                            step: 'AWAITING_DAY', 
                            service: chosenItem.name, 
                            duration: chosenItem.duration || 60,
                            calendarId: clientInfo.google_calendar_id // Usa o ID padrão do cliente
                         };
                         await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                            to: customerId, type: 'text', text: { body: responses.askForDay(chosenItem.name) } 
                         });
                     }
                 }


             // 2.C Resposta Padrão (se não for saudação, keyword ou opção válida)
             } else {
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responses.default } 
                 });
                 nextState = null;
             }
        }

        // --- Fim da Lógica de Roteamento ---

        // 4. Salvar ou deletar o estado da conversa no BD
        if (nextState) {
            await db.saveConversationState(customerId, clientId, nextState);
        } else if (currentState) { // Só deleta se existia um estado anterior que foi finalizado (handler retornou null)
            await db.deleteConversationState(customerId, clientId);
        }

    } catch (error) {
        // Logar erro global com mais contexto se possível
        logger.error('Erro global não tratado no handleIncomingMessage', {
            error: error.message,
            stack: error.stack,
            clientId: clientInfo?.id, // Tenta logar o ID do cliente negócio se já foi obtido
            customerId: customerId // Tenta logar o ID do cliente final se já foi obtido
        });
        // Tenta enviar mensagem de erro genérica se tivermos as infos necessárias
        if (customerId && clientInfo?.whatsapp_phone_id && clientInfo?.whatsapp_token) {
            try {
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Ocorreu um erro inesperado no nosso sistema. Por favor, tente novamente mais tarde ou contacte o suporte." }
                 });
            } catch (sendError) {
                 logger.error('Falha ao enviar mensagem de erro global para o utilizador', { sendError: sendError.message, customerId });
            }
        }
    }
}

// Exportar apenas a função principal que o webhook chamará
module.exports = { handleIncomingMessage };
