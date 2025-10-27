const logger = require('./logger'); // Pode ser útil para logar erros de formatação

/**
 * Gera a lista de serviços ou agendamentos numerada.
 * Esta função é a única responsável por formatar as listas para o WhatsApp.
 * @param {Array<object>} items - A lista de itens (serviços ou agendamentos).
 * @param {string} [type='service'] - O tipo de lista ('service' ou 'appointment' ou 'professional').
 * @returns {string} A lista formatada como string.
 */
function generateNumberedList(items, type = 'service') {
    if (!items || !Array.isArray(items) || items.length === 0) {
        return type === 'service' ? '(Nenhum serviço configurado)' : '(Nenhum agendamento encontrado)';
    }
    
    // Formatação específica para o item
    const formattedList = items.map((item, index) => {
        if (type === 'service' || type === 'professional') {
            // Inclui o preço e formata com vírgula para decimal (pt-BR)
            const priceStr = item.price ? `R$ ${item.price.toFixed(2).replace('.', ',')}` : '';
            return `${index + 1} - ${item.name} (${priceStr})`;
        } else if (type === 'appointment') {
            const eventDate = item.start?.dateTime || item.start?.date;
            const dateStr = eventDate ? new Date(eventDate).toLocaleString('pt-BR') : 'Data Indefinida';
            return `${index + 1} - ${item.summary || 'Agendamento'} (${dateStr})`;
        }
        return `${index + 1} - ${JSON.stringify(item)}`;
    }).join('\n');
    
    return formattedList;
}

/**
 * Obtém o objeto de respostas formatadas para um cliente específico.
 * Mescla as respostas padrão com as configurações específicas do cliente.
 * @param {object} clientConfig - O objeto de configuração carregado do banco de dados para este cliente.
 * Espera-se que contenha `businessName`, `services` (ou `categories`), e opcionalmente `responses`.
 * @returns {object} Um objeto contendo as funções e strings de resposta prontas para uso.
 */
function getResponses(clientConfig = {}) {
    // Carrega dados essenciais
    const clientResponses = clientConfig?.responses || {};
    const businessName = clientConfig?.businessName || "o estabelecimento";
    // Usa 'categories' para fluxo complexo ou 'services' para fluxo simples
    const servicesOrCategories = clientConfig?.categories || clientConfig?.services || [];
    
    // Gera a lista de serviços/categorias para o menu principal
    const serviceListString = generateNumberedList(servicesOrCategories, 'service');

    // Respostas Padrão - usadas como fallback se o cliente não tiver personalização
    const defaults = {
        // [MODIFICADO] NOVO MENU: Inclui serviços e opções A/C
        welcome: (customerName, businessName, serviceListString) => {
            let msg = `Olá, ${customerName}! Bem-vindo(a) à ${businessName}.\n\n`;
            msg += `Para agendar, envie o **NÚMERO do serviço** desejado:\n\n${serviceListString}`;
            msg += `\n\n*Outras Opções:*\n*A* - Alterar um agendamento 🔄\n*C* - Cancelar um agendamento ❌`;
            return msg;
        },
        
        listAppointmentsToChange: (appointments) => {
            const list = generateNumberedList(appointments, 'appointment');
            if (appointments.length === 0) return defaults.appointmentNotFound;
            return `Encontrei estes agendamentos futuros. Qual você gostaria de alterar? Envie o NÚMERO correspondente.\n\n${list}`;
        },
        appointmentChanged: "Ok, o agendamento anterior foi cancelado. Agora vamos remarcar.",
        
        askForService: (serviceList) => `Qual serviço você gostaria de agendar? Por favor, envie o NÚMERO correspondente.\n\n${serviceList}`,
        
        // [NOVO] Adiciona mensagem de escolha do profissional
        askForProfessional: (professionalList, categoryName) => {
             let msg = `Você escolheu *${categoryName}*. Agora, por favor, envie o **NÚMERO do profissional** que deseja agendar:\n\n`;
             msg += professionalList;
             return msg;
        },
        
        askForDay: (service) => `Ótima escolha: *${service}*. \n\nPara qual dia você gostaria de agendar? (ex: hoje, amanhã, 25/12)`,
        showAvailableSlots: (slots) => {
            if (!slots || slots.length === 0) return "🗓️ Poxa, não tenho horários disponíveis para este dia. Por favor, escolha outra data.";
            // A lista de slots é gerada aqui diretamente, pois os slots são objetos Date
            const formattedSlots = slots.map((slot, index) => `${index + 1} - ${slot.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join('\n');
            return `✅ Estes são os horários disponíveis:\n${formattedSlots}\n\nPor favor, digite o NÚMERO do horário que você deseja.`;
        },
        appointmentSummary: (service, date) => `*Resumo do Agendamento:*\n\n*Serviço:* ${service}\n*Data:* ${date.toLocaleString('pt-BR')}\n\nConfirmar agendamento?\n\n1 - Sim, confirmar\n2 - Não, voltar`,
        appointmentConfirmed: (service, date) => `✅ Pronto! Seu agendamento para *${service}* foi confirmado para ${date.toLocaleString('pt-BR')}. Te esperamos!`,
        appointmentNotFound: "🤔 Não encontrei nenhum agendamento futuro no seu nome.",
        confirmCancellation: (appointmentSummary, appointmentDate) => `Encontrei este agendamento:\n\n*${appointmentSummary}*\n*Data:* ${appointmentDate}\n\nDeseja mesmo cancelar?\n\n1 - Sim, cancelar\n2 - Não`,
        appointmentCancelled: "✅ Agendamento cancelado com sucesso!",
        default: "Não entendi sua mensagem. Por favor, digite 'menu' para ver as opções."
    };

    // Constrói o objeto final de respostas, priorizando as do cliente
    const finalResponses = {
        // [MODIFICADO] welcome usa o novo formato e passa o serviceListString
        welcome: (customerName) => {
            const template = clientResponses.welcome || defaults.welcome;
            try {
                // Tenta executar como função ou substituir placeholders na string
                return typeof template === 'function'
                    ? template(customerName, businessName, serviceListString) // Passa todos os argumentos
                    : String(template)
                        .replace('{customerName}', customerName || 'Cliente')
                        .replace('{businessName}', businessName)
                        .replace('{serviceList}', serviceListString);
            } catch (e) {
                logger.error('Erro ao formatar resposta "welcome"', { error: e.message, template });
                return defaults.welcome(customerName || 'Cliente', businessName, serviceListString); // Fallback seguro
            }
        },
        
        listAppointmentsToChange: (appointments) => {
             const template = clientResponses.listAppointmentsToChange || defaults.listAppointmentsToChange;
             try {
                // Aqui usamos generateNumberedList para formatar a lista de agendamentos
                const list = generateNumberedList(appointments, 'appointment');
                return typeof template === 'function' ? template(appointments) : String(template).replace('{appointmentList}', list);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "listAppointmentsToChange"', { error: e.message, template });
                 return defaults.listAppointmentsToChange(appointments);
             }
        },
        appointmentChanged: clientResponses.appointmentChanged || defaults.appointmentChanged,
        
        // askForProfessional é novo
        askForProfessional: (professionalList, categoryName) => {
            const template = clientResponses.askForProfessional || defaults.askForProfessional;
             try {
                 return typeof template === 'function'
                    ? template(professionalList, categoryName)
                    : String(template)
                        .replace('{professionalList}', professionalList)
                        .replace('{categoryName}', categoryName);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "askForProfessional"', { error: e.message, template });
                 return defaults.askForProfessional(professionalList, categoryName);
             }
        },
        
        askForService: () => {
             const template = clientResponses.askForService || defaults.askForService;
             try {
                 return typeof template === 'function'
                    ? template(serviceListString)
                    : String(template).replace('{serviceList}', serviceListString);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "askForService"', { error: e.message, template });
                 return defaults.askForService(serviceListString);
             }
        },
        
        askForDay: (service) => {
             const template = clientResponses.askForDay || defaults.askForDay;
             try {
                 return typeof template === 'function' ? template(service) : String(template).replace('{service}', service);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "askForDay"', { error: e.message, template });
                 return defaults.askForDay(service);
             }
        },
        showAvailableSlots: (slots) => {
            const template = clientResponses.showAvailableSlots || defaults.showAvailableSlots;
             try {
                 return typeof template === 'function' ? template(slots) : String(template);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "showAvailableSlots"', { error: e.message, template });
                 return defaults.showAvailableSlots(slots);
             }
        },
        appointmentSummary: (service, date) => {
            const template = clientResponses.appointmentSummary || defaults.appointmentSummary;
             try {
                 return typeof template === 'function' ? template(service, date) : String(template);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "appointmentSummary"', { error: e.message, template });
                 return defaults.appointmentSummary(service, date);
             }
        },
        appointmentConfirmed: (service, date) => {
            const template = clientResponses.appointmentConfirmed || defaults.appointmentConfirmed;
             try {
                 return typeof template === 'function' ? template(service, date) : String(template);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "appointmentConfirmed"', { error: e.message, template });
                 return defaults.appointmentConfirmed(service, date);
             }
        },
        appointmentNotFound: clientResponses.appointmentNotFound || defaults.appointmentNotFound,
        confirmCancellation: (summary, date) => {
            const template = clientResponses.confirmCancellation || defaults.confirmCancellation;
             try {
                 return typeof template === 'function' ? template(summary, date) : String(template);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "confirmCancellation"', { error: e.message, template });
                 return defaults.confirmCancellation(summary, date);
             }
        },
        appointmentCancelled: clientResponses.appointmentCancelled || defaults.appointmentCancelled,
        default: clientResponses.default || defaults.default
    };

    return finalResponses;
}

// Exporta as funções que serão usadas pelos outros módulos
module.exports = { getResponses, generateNumberedList };
