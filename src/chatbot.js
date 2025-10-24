const axios = require('axios'); // Para enviar mensagens
const { getResponses } = require('./responses'); // Função refatorada
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
// MODIFICADO: Recebe 'messagePayloadSimplified', 'state', 'clientInfo' e 'responses'
const stateHandlers = {
    // --- ESTADOS DE AGENDAMENTO ---
    async AWAITING_SERVICE_CHOICE(messagePayloadSimplified, state, clientInfo, responses) {
        let chosenService = null;
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const services = clientInfo.config?.services || []; // Pega serviços da config do cliente

        const choiceIndex = parseInt(messageBody.trim(), 10) - 1;

        if (choiceIndex >= 0 && choiceIndex < services.length) {
            chosenService = services[choiceIndex]; // Guarda o objeto { name: "...", duration: ... }
        }

        if (chosenService) {
            state.step = 'AWAITING_DAY';
            state.service = chosenService.name;
            state.duration = chosenService.duration || 60; // Guarda a duração (fallback 60 min)
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: responses.askForDay(state.service) }
            });
            return state;
        } else {
            // Reenvia a lista de serviços se a opção for inválida
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: "Opção inválida.\n" + responses.askForService() } // Usa a função de responses que já gera a lista
            });
            return state; // Mantém o estado
        }
    },

    async AWAITING_DAY(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo'; // Usar timezone da config
        const workingHours = clientInfo.config?.workingHours || { start: 9, end: 19 }; // Usar horários da config

        const day = parseDate(messageBody.trim(), new Date(), { forwardDate: true });
        if (day) {
            // Validar se as credenciais do Google existem para este cliente
            if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) {
                logger.error(`Cliente ${clientInfo.id} não tem Google Calendar configurado.`, { clientId: clientInfo.id });
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
                });
                return null; // Finaliza
            }
            try {
                // Chama a API do calendário passando as credenciais e ID do cliente
                const availableSlots = await calendarApi.listAvailableSlots(
                    day,
                    state.duration, // Usa a duração guardada no estado
                    clientInfo.google_calendar_id,
                    clientInfo.google_credentials, // Objeto de credenciais já parseado
                    timezone,
                    workingHours
                );

                // Usa a função de responses para gerar a mensagem (ela trata o caso de 0 slots)
                const responseMessage = responses.showAvailableSlots(availableSlots);

                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responseMessage }
                });

                if (availableSlots.length > 0) {
                    state.step = 'AWAITING_SLOT';
                    state.availableSlots = availableSlots.map(slot => slot.toISOString()); // Guardar ISO strings
                }
                // Se não houver slots, mantém o estado AWAITING_DAY

            } catch (calendarError) {
                logger.error('Erro ao buscar horários no Google Calendar', { clientId: clientInfo.id, error: calendarError.message });
                let userErrorMessage = "❌ Desculpe, tive um problema ao consultar a agenda. Tente novamente mais tarde.";
                if (calendarError.message === 'CALENDAR_NOT_FOUND' || calendarError.message === 'GOOGLE_PERMISSION_ERROR') {
                    userErrorMessage = "❌ Problema na configuração da agenda deste estabelecimento. Contacte o suporte.";
                }
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: userErrorMessage }
                });
                return null; // Finaliza a conversa
            }
        } else {
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                to: customerId, type: 'text', text: { body: "Não consegui entender essa data. Tente de novo (ex: 'hoje', 'sábado', '25/12')." }
            });
            // Mantém o estado atual
        }
        return state;
    },

    async AWAITING_SLOT(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        // Recriar Date objects a partir das ISO strings guardadas no estado
        const availableSlots = state.availableSlots?.map(iso => new Date(iso)) || [];
        const choice = parseInt(messageBody.trim(), 10) - 1;

        if (choice >= 0 && choice < availableSlots.length) {
            const chosenSlot = availableSlots[choice];
            state.step = 'AWAITING_FINAL_CONFIRMATION';
            state.chosenSlot = chosenSlot.toISOString(); // Guarda ISO string
            await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: responses.appointmentSummary(state.service, chosenSlot) }
            });
        } else {
            // Reenvia a lista se a opção for inválida
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "❌ Opção inválida.\n" + responses.showAvailableSlots(availableSlots) }
             });
            // Mantém o estado atual
        }
        return state;
    },

    async AWAITING_FINAL_CONFIRMATION(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        const customerName = messagePayloadSimplified.profile.name || "Cliente";
        const chosenSlot = new Date(state.chosenSlot); // Recriar Date object
        const timezone = clientInfo.config?.timezone || 'America/Sao_Paulo';

        if (messageBody.trim() === '1') {
            // Validar se as credenciais do Google existem
            if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) {
                 logger.error(`Cliente ${clientInfo.id} não tem Google Calendar configurado ao confirmar.`, { clientId: clientInfo.id });
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
                 });
                 return null; // Finaliza
            }
            try {
                // Chama a API do calendário passando credenciais e ID
                await calendarApi.createAppointment(
                    chosenSlot.toISOString(),
                    state.service,
                    customerName,
                    state.duration, // Usa a duração guardada
                    clientInfo.google_calendar_id,
                    clientInfo.google_credentials,
                    timezone
                );
                await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.appointmentConfirmed(state.service, chosenSlot) }
                });

                // Salvar visita no BD (já usando clientId)
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
                    errorMessage = "❌ Problema na configuração da agenda deste estabelecimento. Contacte o suporte."; // Mensagem mais específica
                }
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: errorMessage }
                 });
                 // Não finaliza a conversa aqui, pode ser um erro temporário, deixa o estado como está
                 return state; // Retorna o estado atual para que o utilizador possa tentar de novo ou cancelar
            }
        } else {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "Ok, agendamento cancelado. Digite 'menu' para recomeçar." }
             });
        }
        return null; // Finaliza a conversa (se confirmou ou cancelou explicitamente)
    },

     // --- ESTADOS DE CANCELAMENTO E ALTERAÇÃO ---
     async AWAITING_CANCELLATION_CONFIRMATION(messagePayloadSimplified, state, clientInfo, responses) {
        const customerId = messagePayloadSimplified.from;
        const messageBody = messagePayloadSimplified.text.body;
        // O appointmentToCancel deveria ter sido guardado como JSON serializável no estado
        const appointmentToCancel = state.appointmentToCancel;

        if (!appointmentToCancel || !appointmentToCancel.id) {
             logger.warn('Estado inválido em AWAITING_CANCELLATION_CONFIRMATION', { clientId: clientInfo.id, customerId });
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "Ocorreu um erro, por favor digite 'menu'." }
             });
             return null;
        }
         // Validar credenciais Google
         if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) {
              logger.error(`Cliente ${clientInfo.id} sem Google Calendar configurado para cancelamento.`, { clientId: clientInfo.id });
              await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                  to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
              });
              return null; // Finaliza
         }

         if (messageBody.trim() === '1') {
             try {
                 await calendarApi.cancelAppointment(
                     appointmentToCancel.id,
                     clientInfo.google_calendar_id,
                     clientInfo.google_credentials
                 );
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responses.appointmentCancelled }
                 });
             } catch (error) {
                 logger.error('Erro ao cancelar agendamento no Google Calendar', { clientId: clientInfo.id, customerId, eventId: appointmentToCancel.id, error: error.message });
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Ops! Ocorreu um erro e não consegui cancelar seu agendamento. Tente novamente mais tarde." }
                 });
                  // Não finaliza, permite tentar de novo ou cancelar
                  return state;
             }
         } else {
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "Ok, seu agendamento está mantido! 😉" }
             });
         }
         return null; // Finaliza
     },

     async AWAITING_CHANGE_CHOICE(messagePayloadSimplified, state, clientInfo, responses) {
         const customerId = messagePayloadSimplified.from;
         const messageBody = messagePayloadSimplified.text.body;
         // Os appointments deveriam ter sido guardados como JSON serializável no estado
         const appointments = state.appointments || [];
         const choice = parseInt(messageBody.trim(), 10) - 1;

          // Validar credenciais Google
         if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) {
              logger.error(`Cliente ${clientInfo.id} sem Google Calendar configurado para alteração.`, { clientId: clientInfo.id });
              await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                  to: customerId, type: 'text', text: { body: "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente." }
              });
              return null; // Finaliza
         }

         if (choice >= 0 && choice < appointments.length) {
             const appointmentToChange = appointments[choice];
             // Extrair serviço e talvez duração (se guardado) do summary
             const serviceName = appointmentToChange.summary?.split(' - ')[0] || 'Serviço';
             // Buscar duração do serviço a partir do nome nos configs do cliente
             const serviceConfig = clientInfo.config?.services?.find(s => s.name === serviceName);
             const duration = serviceConfig?.duration || 60; // Fallback para 60 min

             try {
                 // Cancela o antigo primeiro
                 await calendarApi.cancelAppointment(
                     appointmentToChange.id,
                     clientInfo.google_calendar_id,
                     clientInfo.google_credentials
                 );
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responses.appointmentChanged }
                 });

                 // Prepara o novo estado para recomeçar o fluxo de agendamento
                 const newState = {
                     step: 'AWAITING_DAY',
                     service: serviceName,
                     duration: duration
                 };
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                    to: customerId, type: 'text', text: { body: responses.askForDay(newState.service) }
                 });
                 return newState; // Retorna novo estado

             } catch (error) {
                 logger.error('Erro ao iniciar alteração de agendamento (cancelamento falhou)', { clientId: clientInfo.id, customerId, eventId: appointmentToChange.id, error: error.message });
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: "❌ Ops! Ocorreu um erro ao tentar alterar seu agendamento. Tente novamente mais tarde." }
                 });
                 return null; // Finaliza
             }
         } else {
              // Reenvia lista se inválido
             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                 to: customerId, type: 'text', text: { body: "❌ Opção inválida.\n" + responses.listAppointmentsToChange(appointments.map(a => ({...a, start: { dateTime: a.start?.dateTime || a.start?.date }}))) } // Remapeia para formato esperado por listAppointmentsToChange
             });
             return state; // Mantém estado
         }
     }
};

/**
 * Função principal chamada pelo webhook para processar mensagens recebidas.
 * @param {object} messagePayload - O payload completo recebido da Meta.
 */
async function handleIncomingMessage(messagePayload) {
    let customerId = null; // Guardar fora do try para usar no catch
    let clientId = null;
    let clientInfo = null;
    let responses = null;

    try {
        // Extrair informações essenciais do payload da Meta
        const messageObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const contactObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
        const metadataObject = messagePayload?.entry?.[0]?.changes?.[0]?.value?.metadata;

        // Validar se é uma mensagem de texto de um utilizador e se temos os IDs
        if (messagePayload?.object !== 'whatsapp_business_account' ||
            !messageObject || messageObject.type !== 'text' ||
            !messageObject.from || !messageObject.text?.body ||
            !metadataObject?.phone_number_id)
        {
            // Ignora outros tipos de webhook (status de entrega, reações, etc.) ou payloads malformados
            logger.debug('Payload ignorado (não é mensagem de texto ou faltam dados essenciais)', { payload: messagePayload });
            return;
        }

        customerId = messageObject.from; // Número do cliente final (ex: 555199998888)
        const messageBody = messageObject.text.body.trim();
        const customerName = contactObject?.profile?.name || "Cliente"; // Nome do perfil do WhatsApp
        const businessPhoneId = metadataObject.phone_number_id; // ID do número do negócio que recebeu a msg

        // 1. Buscar informações do Cliente Negócios (barbearia) a partir do ID do telefone
        clientInfo = await db.getClientByPhoneId(businessPhoneId);
        if (!clientInfo || !clientInfo.whatsapp_token) { // Verifica também se o token existe
            logger.error(`Mensagem recebida para número de negócio não registrado ou sem token no BD: ${businessPhoneId}`);
            // Não podemos responder sem token, apenas logamos.
            return;
        }
        clientId = clientInfo.id; // Guarda o ID interno do cliente negócio

        // 2. Carregar as respostas personalizadas (ou padrão) para este cliente
        // Passa todo o clientInfo, pois getResponses pode usar mais dados no futuro
        responses = getResponses(clientInfo);

        logger.info(`Mensagem recebida de ${customerName} (${customerId}) para ${clientInfo.business_name} (ID: ${clientId}): "${messageBody}"`);

        // 3. Buscar o estado atual da conversa deste cliente final COM este negócio
        let currentState = await db.getConversationState(customerId, clientId);

        let nextState = null; // Para armazenar o estado retornado pelos handlers
        let responseText = null; // Para mensagens que não dependem de estado

        // --- Lógica de Roteamento da Conversa ---
        const payloadSimplified = { from: customerId, text: { body: messageBody }, profile: { name: customerName } };

        // A. Se existe um estado e um handler para ele, executa o handler
        if (currentState?.step && stateHandlers[currentState.step]) {
            nextState = await stateHandlers[currentState.step](payloadSimplified, currentState, clientInfo, responses);
        }
        // B. Se não há estado, verifica keywords ou menu inicial
        else {
             // B.1 Verifica keywords específicas do cliente
             responseText = processMessage(messageBody, clientInfo.config); // Passa config para buscar keywords/respostas
             if (responseText) {
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responseText }
                 });
                 nextState = null; // Keywords não alteram o estado geralmente

             // B.2 Verifica se é saudação/menu
             } else if (messageBody.match(/(oi|olá|menu|bom dia|boa tarde|boa noite)/i)) {
                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                     to: customerId, type: 'text', text: { body: responses.welcome(customerName) } // Usa a resposta carregada
                 });
                 nextState = null; // Reinicia o estado

             // B.3 Verifica opções do menu principal
             } else {
                 switch (messageBody) {
                     case '1': // Agendar
                         nextState = { step: 'AWAITING_SERVICE_CHOICE' };
                         await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                             to: customerId, type: 'text', text: { body: responses.askForService() } // Usa a resposta carregada
                         });
                         break;
                     case '2': // Alterar
                         try {
                             // Verifica credenciais ANTES de chamar a API
                             if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) throw new Error('GOOGLE_CONFIG_MISSING');

                             const appointments = await calendarApi.listCustomerAppointments(
                                 customerName, // Usar nome ou ID? 'q' no Google busca em vários campos.
                                 clientInfo.google_calendar_id,
                                 clientInfo.google_credentials
                             );
                             if (appointments && appointments.length > 0) {
                                 // Guardar appointments serializáveis no estado
                                 const serializableAppointments = appointments.map(a => ({ id: a.id, summary: a.summary, start: a.start, end: a.end }));
                                 nextState = { step: 'AWAITING_CHANGE_CHOICE', appointments: serializableAppointments };
                                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                     to: customerId, type: 'text', text: { body: responses.listAppointmentsToChange(appointments) }
                                 });
                             } else {
                                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                     to: customerId, type: 'text', text: { body: responses.appointmentNotFound }
                                 });
                                 nextState = null;
                             }
                         } catch (error) {
                             logger.error('Erro ao listar agendamentos para alterar', { clientId: clientInfo.id, customerId, error: error.message });
                             let userErrorMsg = "❌ Erro ao buscar seus agendamentos. Tente novamente mais tarde.";
                             if (error.message === 'GOOGLE_CONFIG_MISSING') userErrorMsg = "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente.";
                             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                 to: customerId, type: 'text', text: { body: userErrorMsg }
                             });
                             nextState = null;
                         }
                         break;
                     case '3': // Cancelar
                         try {
                             // Verifica credenciais ANTES de chamar a API
                             if (!clientInfo.google_calendar_id || !clientInfo.google_credentials) throw new Error('GOOGLE_CONFIG_MISSING');

                             const appointmentsToCancel = await calendarApi.listCustomerAppointments(
                                 customerName,
                                 clientInfo.google_calendar_id,
                                 clientInfo.google_credentials
                             );
                             if (appointmentsToCancel && appointmentsToCancel.length > 0) {
                                 const nextAppointment = appointmentsToCancel[0]; // Pega o mais próximo
                                 // Guardar appointment serializável no estado
                                 const serializableAppointment = { id: nextAppointment.id, summary: nextAppointment.summary, start: nextAppointment.start, end: nextAppointment.end };
                                 nextState = { step: 'AWAITING_CANCELLATION_CONFIRMATION', appointmentToCancel: serializableAppointment };
                                 const dateStr = new Date(nextAppointment.start?.dateTime || nextAppointment.start?.date || Date.now()).toLocaleString('pt-BR');
                                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                     to: customerId, type: 'text', text: { body: responses.confirmCancellation(nextAppointment.summary, dateStr) }
                                 });
                             } else {
                                 await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                     to: customerId, type: 'text', text: { body: responses.appointmentNotFound }
                                 });
                                 nextState = null;
                             }
                         } catch (error) {
                             logger.error('Erro ao buscar agendamentos para cancelar', { clientId: clientInfo.id, customerId, error: error.message });
                              let userErrorMsg = "❌ Erro ao buscar seus agendamentos. Tente novamente mais tarde.";
                             if (error.message === 'GOOGLE_CONFIG_MISSING') userErrorMsg = "❌ Desculpe, a agenda para este estabelecimento não está configurada corretamente.";
                             await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                                 to: customerId, type: 'text', text: { body: userErrorMsg }
                             });
                             nextState = null;
                         }
                        break;
                     default: // Resposta Padrão (se processMessage retornou null e não é opção de menu)
                         await sendWhatsAppMessage(clientInfo.whatsapp_phone_id, clientInfo.whatsapp_token, {
                             to: customerId, type: 'text', text: { body: responses.default } // Usa a resposta padrão carregada
                         });
                         nextState = null; // Não muda o estado
                         break;
                 }
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