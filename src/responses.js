const logger = require('./logger'); // Pode ser útil para logar erros de formatação

/**
 * Gera a lista numerada de serviços para ser usada nas mensagens.
 * @param {Array<object>} services - A lista de serviços do cliente (ex: [{name: "Corte", duration: 60}, ...]).
 * @returns {string} A lista formatada como string (ex: "1 - Corte\n2 - Barba").
 */
function generateServiceList(services) {
    if (!services || !Array.isArray(services) || services.length === 0) {
        return '(Nenhum serviço configurado)';
    }
    return services.map((service, index) => `${index + 1} - ${service.name}`).join('\n');
}

/**
 * Obtém o objeto de respostas formatadas para um cliente específico.
 * Mescla as respostas padrão com as configurações específicas do cliente.
 * @param {object} clientConfig - O objeto de configuração carregado do banco de dados para este cliente.
 * Espera-se que contenha `businessName`, `services`, e opcionalmente `responses`.
 * @returns {object} Um objeto contendo as funções e strings de resposta prontas para uso.
 */
function getResponses(clientConfig = {}) {
    // Respostas Padrão - usadas como fallback se o cliente não tiver personalização
    const defaults = {
        welcome: (customerName, businessName) => `Olá, ${customerName}! Bem-vindo(a) a ${businessName}. O que você gostaria de fazer hoje?\n\n1 - Agendar um horário ✂️\n2 - Alterar um agendamento 🔄\n3 - Cancelar um agendamento ❌`,
        listAppointmentsToChange: (appointments) => {
            if (!appointments || appointments.length === 0) return defaults.appointmentNotFound; // Reutiliza a resposta padrão
            const formatted = appointments
                .map((app, i) => {
                    // Tenta obter data/hora, ou apenas data se for evento de dia inteiro
                    const eventDate = app.start?.dateTime || app.start?.date;
                    const dateStr = eventDate ? new Date(eventDate).toLocaleString('pt-BR') : 'Data Indefinida';
                    return `${i + 1} - ${app.summary || 'Agendamento'} (${dateStr})`;
                })
                .join('\n');
            return `Encontrei estes agendamentos futuros. Qual você gostaria de alterar?\n\n${formatted}\n\nDigite o número do agendamento.`;
        },
        appointmentChanged: "Ok, o agendamento anterior foi cancelado. Agora vamos remarcar.",
        askForService: (serviceList) => `Qual serviço você gostaria de agendar?\n\n${serviceList}`,
        askForDay: (service) => `Ótima escolha: *${service}*. \n\nPara qual dia você gostaria de agendar? (ex: hoje, amanhã, 25/12)`,
        showAvailableSlots: (slots) => {
            if (!slots || slots.length === 0) return "🗓️ Poxa, não tenho horários disponíveis para este dia. Por favor, escolha outra data.";
            const formattedSlots = slots.map((slot, index) => `${index + 1} - ${slot.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join('\n');
            return `✅ Estes são os horários disponíveis:\n${formattedSlots}\n\nPor favor, digite o número do horário que você deseja.`;
        },
        appointmentSummary: (service, date) => `*Resumo do Agendamento:*\n\n*Serviço:* ${service}\n*Data:* ${date.toLocaleString('pt-BR')}\n\nConfirmar agendamento?\n\n1 - Sim, confirmar\n2 - Não, voltar`,
        appointmentConfirmed: (service, date) => `✅ Pronto! Seu agendamento para *${service}* foi confirmado para ${date.toLocaleString('pt-BR')}. Te esperamos!`,
        appointmentNotFound: "🤔 Não encontrei nenhum agendamento futuro no seu nome.",
        confirmCancellation: (appointmentSummary, appointmentDate) => `Encontrei este agendamento:\n\n*${appointmentSummary}*\n*Data:* ${appointmentDate}\n\nDeseja mesmo cancelar?\n\n1 - Sim, cancelar\n2 - Não`,
        appointmentCancelled: "✅ Agendamento cancelado com sucesso!",
        // keywordResponses já foi movido para clientConfig
        default: "Não entendi sua mensagem. Por favor, escolha uma das opções do menu ou digite 'menu'."
    };

    // Respostas específicas do cliente (vindas do config_json)
    const clientResponses = clientConfig?.responses || {};
    const businessName = clientConfig?.businessName || "o estabelecimento"; // Nome fallback
    const services = clientConfig?.services || []; // Assume que 'services' está na config principal

    // Gera a lista de serviços uma vez
    const serviceListString = generateServiceList(services);

    // Constrói o objeto final de respostas, priorizando as do cliente
    // Para funções, executa a função padrão passando os parâmetros necessários
    // Para strings, substitui placeholders como {businessName} ou {serviceList}
    const finalResponses = {
        welcome: (customerName) => {
            const template = clientResponses.welcome || defaults.welcome;
            // Tenta executar como função ou substituir placeholders na string
            try {
                return typeof template === 'function'
                    ? template(customerName, businessName)
                    : String(template)
                        .replace('{customerName}', customerName || 'Cliente')
                        .replace('{businessName}', businessName);
            } catch (e) {
                logger.error('Erro ao formatar resposta "welcome"', { error: e.message, template });
                return defaults.welcome(customerName || 'Cliente', businessName); // Fallback seguro
            }
        },
        listAppointmentsToChange: (appointments) => {
             const template = clientResponses.listAppointmentsToChange || defaults.listAppointmentsToChange;
             try {
                return typeof template === 'function' ? template(appointments) : String(template);
             } catch (e) {
                 logger.error('Erro ao formatar resposta "listAppointmentsToChange"', { error: e.message, template });
                 return defaults.listAppointmentsToChange(appointments);
             }
        },
        appointmentChanged: clientResponses.appointmentChanged || defaults.appointmentChanged,
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
                 return typeof template === 'function' ? template(service, date) : String(template); // Assume que a string não precisa de replace aqui
             } catch (e) {
                 logger.error('Erro ao formatar resposta "appointmentSummary"', { error: e.message, template });
                 return defaults.appointmentSummary(service, date);
             }
        },
        appointmentConfirmed: (service, date) => {
            const template = clientResponses.appointmentConfirmed || defaults.appointmentConfirmed;
             try {
                 return typeof template === 'function' ? template(service, date) : String(template); // Assume que a string não precisa de replace aqui
             } catch (e) {
                 logger.error('Erro ao formatar resposta "appointmentConfirmed"', { error: e.message, template });
                 return defaults.appointmentConfirmed(service, date);
             }
        },
        appointmentNotFound: clientResponses.appointmentNotFound || defaults.appointmentNotFound,
        confirmCancellation: (summary, date) => {
            const template = clientResponses.confirmCancellation || defaults.confirmCancellation;
             try {
                 return typeof template === 'function' ? template(summary, date) : String(template); // Assume que a string não precisa de replace aqui
             } catch (e) {
                 logger.error('Erro ao formatar resposta "confirmCancellation"', { error: e.message, template });
                 return defaults.confirmCancellation(summary, date);
             }
        },
        appointmentCancelled: clientResponses.appointmentCancelled || defaults.appointmentCancelled,
        // As keywordResponses agora vêm diretamente do clientConfig e são usadas pelo messageProcessor
        default: clientResponses.default || defaults.default
    };

    return finalResponses;
}

// Exporta a função que gera as respostas
module.exports = { getResponses };